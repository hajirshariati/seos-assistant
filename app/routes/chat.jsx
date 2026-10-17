// Chat endpoint. Two front doors, one engine:
//   - the storefront widget, through the Shopify app proxy (HMAC-signed query)
//   - the admin home page's test chat, with an App Bridge session token
// Both go through the same guards (rate limit, plan quota, daily cap) and the
// same engine (app/lib/lean). Admin test chats skip analytics and quota.

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopConfig } from "../models/ShopConfig.server";
import { getTodayMessageCount } from "../models/ChatUsage.server";
import { canSendMessage } from "../lib/billing.server";
import { leanChatResponse } from "../lib/lean/respond.server.js";
import { sanitizeHistory } from "../lib/lean/history.js";
import { sanitizeFitfinder } from "../lib/orthotic-finder.js";

const RATE_LIMIT_PER_IP_SHOP = parseInt(process.env.RATE_LIMIT_PER_IP_SHOP, 10) || 20;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000;
const RATE_LIMIT_MAX_KEYS = parseInt(process.env.RATE_LIMIT_MAX_KEYS, 10) || 10_000;
// Real questions are short; very long pastes would crowd out the context.
const MAX_MESSAGE_CHARS = 2000;

const ipShopBuckets = new Map();

function clientIp(request) {
  const xff = request.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0].trim();
  return first || request.headers.get("x-real-ip") || "unknown";
}

function checkIpShopRate(shop, ip) {
  const key = `${shop}|${ip}`;
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const bucket = (ipShopBuckets.get(key) || []).filter((t) => t > cutoff);
  if (bucket.length >= RATE_LIMIT_PER_IP_SHOP) {
    const retryAfter = Math.max(1, Math.ceil((bucket[0] + RATE_LIMIT_WINDOW_MS - now) / 1000));
    ipShopBuckets.set(key, bucket);
    return { ok: false, retryAfter };
  }
  bucket.push(now);
  ipShopBuckets.set(key, bucket);
  if (ipShopBuckets.size > RATE_LIMIT_MAX_KEYS) {
    let evict = ipShopBuckets.size - RATE_LIMIT_MAX_KEYS;
    for (const k of ipShopBuckets.keys()) {
      if (evict <= 0) break;
      if (k === key) continue;
      ipShopBuckets.delete(k);
      evict -= 1;
    }
  }
  return { ok: true };
}

if (!globalThis.__shopagentRateSweeper) {
  globalThis.__shopagentRateSweeper = setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    for (const [key, bucket] of ipShopBuckets) {
      const filtered = bucket.filter((t) => t > cutoff);
      if (filtered.length === 0) ipShopBuckets.delete(key);
      else ipShopBuckets.set(key, filtered);
    }
  }, RATE_LIMIT_WINDOW_MS);
  globalThis.__shopagentRateSweeper.unref?.();
}

export const loader = async () => {
  return Response.json({ error: "Method not allowed. Use POST." }, { status: 405 });
};

export const action = async ({ request }) => {
  try {
    const authHeader = request.headers.get("authorization") || "";
    let shop;
    let sessionAccessToken;
    let internal = false;
    if (authHeader.startsWith("Bearer ")) {
      const { session } = await authenticate.admin(request);
      shop = session.shop;
      sessionAccessToken = session.accessToken;
      internal = true;
    } else {
      const { session } = await authenticate.public.appProxy(request);
      if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
      shop = session.shop;
      sessionAccessToken = session.accessToken;
    }
    return await handleChatPost({ shop, sessionAccessToken, request, internal });
  } catch (e) {
    // authenticate.admin signals auth failures by throwing Responses.
    if (e instanceof Response) throw e;
    // Details stay in the server log; the storefront only sees a friendly message.
    console.error("[chat] error:", e);
    return Response.json(
      { error: "action_failed", message: "I'm having trouble right now. Please try again in a moment." },
      { status: 500 },
    );
  }
};

async function handleChatPost({ shop, sessionAccessToken, request, internal = false }) {
  const rate = checkIpShopRate(shop, clientIp(request));
  if (!rate.ok) {
    return Response.json(
      { error: "rate_limited", retryAfter: rate.retryAfter },
      { status: 429, headers: { "Retry-After": String(rate.retryAfter) } },
    );
  }

  const config = await getShopConfig(shop);
  if (!config.anthropicApiKey) {
    return Response.json(
      { error: "AI engine API key not configured. Set it in the app admin under Settings." },
      { status: 503 },
    );
  }

  const quota = internal ? { ok: true } : await canSendMessage(shop);
  if (!quota.ok) {
    return Response.json(
      {
        error: "plan_limit_reached",
        message: `This store reached its ${quota.limit.toLocaleString()} conversations for the month. Upgrade the plan in the SEoS Assistant admin to keep helping customers.`,
        plan: quota.plan.id,
        used: quota.used,
        limit: quota.limit,
      },
      { status: 402 },
    );
  }

  // Optional merchant spending guardrail (UTC day, counted from ChatUsage).
  if (!internal && config.dailyCapEnabled && config.dailyCapMessages > 0) {
    const todayCount = await getTodayMessageCount(shop);
    if (todayCount >= config.dailyCapMessages) {
      return Response.json(
        {
          error: "daily_cap_reached",
          message: "The shop's daily AI assistant limit has been reached. The assistant will be available again tomorrow.",
          limit: config.dailyCapMessages,
          used: todayCount,
        },
        { status: 429 },
      );
    }
  }

  const body = await request.json().catch(() => null);
  if (!body?.message || typeof body.message !== "string" || !body.message.trim()) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }
  const message = body.message.slice(0, MAX_MESSAGE_CHARS);
  const messages = [...sanitizeHistory(body.history), { role: "user", content: message }];

  // HMAC-verified on app proxy requests — never a customer id from the body.
  const loggedInCustomerId = new URL(request.url).searchParams.get("logged_in_customer_id") || null;
  let accessToken = sessionAccessToken;
  if (!accessToken && loggedInCustomerId) {
    const offline = await prisma.session.findFirst({ where: { shop, isOnline: false }, orderBy: { expires: "desc" } });
    accessToken = offline?.accessToken || null;
  }

  return leanChatResponse({
    shop,
    config,
    messages,
    latestUserMessage: message,
    internal,
    accessToken,
    loggedInCustomerId,
    supportUrl: typeof body.support_url === "string" ? body.support_url : "",
    supportLabel: typeof body.support_label === "string" ? body.support_label : "",
    fitfinder: sanitizeFitfinder(body.fitfinder),
  });
}

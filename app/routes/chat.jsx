// Chat endpoint. Two front doors, one engine:
//   - the storefront widget, through the Shopify app proxy (HMAC-signed query)
//   - the admin home page's test chat, with an App Bridge session token
// Both go through the same guards (rate limit, request size, daily cap) and
// the same engine (app/lib/lean). Admin test chats skip analytics and the cap.

import { authenticate } from "../shopify.server";
import { shouldRecord, cleanTester } from "../lib/chat-recording.js";
import { getShopConfig } from "../models/ShopConfig.server";
import { getTodayMessageCount } from "../models/ChatUsage.server";
import { leanChatResponse } from "../lib/lean/respond.server.js";
import { sanitizeHistory, withoutTrailingCopy } from "../lib/lean/history.js";
import { sanitizeFitfinder } from "../lib/orthotic-finder.js";
import { sanitizeSizeFinder } from "../lib/lean/size-finder.server.js";
import { checkIpShopRate, checkStoreChatRate, clientIp } from "../lib/rate-limit.server.js";
import { recordHealth } from "../models/ChatHealth.server";

// Real questions are short; very long pastes would crowd out the context.
const MAX_MESSAGE_CHARS = 2000;
// The whole request (message + history + FIT data) — far above a real chat.
const MAX_BODY_BYTES = 96 * 1024;

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
    recordHealth({ shop, ok: false, errorKind: "shopper_rate_limited", internal });
    return Response.json(
      { error: "rate_limited", retryAfter: rate.retryAfter },
      { status: 429, headers: { "Retry-After": String(rate.retryAfter) } },
    );
  }
  // Store-wide ceiling: however the requests are spread across addresses,
  // the store's chat spend per minute and per hour stays bounded.
  if (!internal) {
    const store = checkStoreChatRate(shop);
    if (!store.ok) {
      recordHealth({ shop, ok: false, errorKind: "store_rate_limited" });
      return Response.json(
        { error: "store_busy", retryAfter: store.retryAfter, message: "I'm getting a lot of questions right now — please try again in a minute." },
        { status: 429, headers: { "Retry-After": String(store.retryAfter) } },
      );
    }
  }

  const config = await getShopConfig(shop);
  if (!config.anthropicApiKey) {
    recordHealth({ shop, ok: false, errorKind: "no_api_key", internal });
    return Response.json(
      { error: "AI engine API key not configured. Set it in the app admin under Settings." },
      { status: 503 },
    );
  }

  // Optional merchant spending guardrail (UTC day, counted from ChatUsage).
  if (!internal && config.dailyCapEnabled && config.dailyCapMessages > 0) {
    const todayCount = await getTodayMessageCount(shop);
    if (todayCount >= config.dailyCapMessages) {
      recordHealth({ shop, ok: false, errorKind: "daily_cap" });
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

  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "request_too_large" }, { status: 413 });
  let body = null;
  try { body = JSON.parse(raw); } catch { /* handled below */ }
  if (!body?.message || typeof body.message !== "string" || !body.message.trim()) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }
  const message = body.message.slice(0, MAX_MESSAGE_CHARS);
  const messages = [...withoutTrailingCopy(sanitizeHistory(body.history), message), { role: "user", content: message }];

  // Storefront: signed by Shopify's app proxy, never taken from the body.
  // The admin test chat has no signed customer, so it never acts as one.
  const loggedInCustomerId = internal ? null : new URL(request.url).searchParams.get("logged_in_customer_id") || null;
  // The library keeps the shop's offline token current on app proxy requests.
  const accessToken = sessionAccessToken || null;

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
    sizeFinder: sanitizeSizeFinder(body.size_finder),
    // Test recordings: only while the store has it on, and (by default) only
    // for testers who opened the store with the tester link.
    record: shouldRecord(config, { tester: body.tester, internal })
      ? { sessionId: typeof body.session_id === "string" ? body.session_id : "", tester: internal ? "Test chat" : cleanTester(body.tester), page: typeof body.page === "string" ? body.page : "" }
      : null,
  });
}

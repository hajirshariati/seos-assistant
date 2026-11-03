// Chat endpoint. Two front doors, one engine:
//   - the storefront widget, through the Shopify app proxy (HMAC-signed query)
//   - the admin home page's test chat, with an App Bridge session token
// Both go through the same guards (rate limit, request size, daily cap) and
// the same engine (app/lib/lean). Admin test chats skip analytics and the cap.

import { authenticate } from "../shopify.server";
import { shouldRecord, cleanTester } from "../lib/chat-recording.js";
import { getShopConfigCached } from "../models/ShopConfig.server";
import { getTodayMessageCount } from "../models/ChatUsage.server";
import { leanChatResponse } from "../lib/lean/respond.server.js";
import { sanitizeHistory, withoutTrailingCopy } from "../lib/lean/history.js";
import { sanitizeFitfinder } from "../lib/orthotic-finder.js";
import { sanitizeSizeFinder } from "../lib/lean/size-finder.server.js";
import { checkIpShopRate, checkStoreChatRate, clientIp } from "../lib/rate-limit.server.js";
import { recordHealth } from "../models/ChatHealth.server";
import { storeChatLimits, dailyCapApplies, busyMessage } from "../lib/peak-mode.js";
import { avaChatStarted } from "../lib/app-events.server.js";
import { guardMessage } from "../lib/chat-guard.server.js";
import { saveRecording } from "../models/ChatRecording.server";
import { touchInteraction } from "../models/ChatInteraction.server";

// Real questions are short; very long pastes would crowd out the context.
const MAX_MESSAGE_CHARS = 2000;
// The whole request (message + history + FIT data) — far above a real chat.
const MAX_BODY_BYTES = 96 * 1024;

// A product handle from the shopper's page URL: lower-case letters, digits and
// dashes only, or nothing.
function cleanHandle(value) {
  const h = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9][a-z0-9-]{0,199}$/.test(h) ? h : "";
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
    recordHealth({ shop, ok: false, errorKind: "shopper_rate_limited", internal });
    return Response.json(
      { error: "rate_limited", retryAfter: rate.retryAfter },
      { status: 429, headers: { "Retry-After": String(rate.retryAfter) } },
    );
  }
  const config = await getShopConfigCached(shop);
  // Store-wide ceiling: however the requests are spread across addresses,
  // the store's chat spend per minute and per hour stays bounded. The limits
  // are the store's (Settings → Peak Mode), higher while Peak Mode is on.
  if (!internal) {
    const store = checkStoreChatRate(shop, storeChatLimits(config, { env: process.env }));
    if (!store.ok) {
      recordHealth({ shop, ok: false, errorKind: "store_rate_limited" });
      return Response.json(
        { error: "store_busy", retryAfter: store.retryAfter, message: busyMessage(store.retryAfter) },
        { status: 429, headers: { "Retry-After": String(store.retryAfter) } },
      );
    }
  }

  if (!config.anthropicApiKey) {
    recordHealth({ shop, ok: false, errorKind: "no_api_key", internal });
    return Response.json(
      { error: "AI engine API key not configured. Set it in the app admin under Settings." },
      { status: 503 },
    );
  }

  // Optional merchant spending guardrail (UTC day, counted from ChatUsage);
  // Peak Mode can lift it for the busiest days.
  if (!internal && dailyCapApplies(config)) {
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
  const sessionId = typeof body.session_id === "string" ? body.session_id.slice(0, 100) : "";
  const tester = internal ? "Test chat" : cleanTester(body.tester);
  // Typed by the shopper, or sent by a button (unknown from older widgets).
  const typed = typeof body.typed === "boolean" ? body.typed : null;
  const page = typeof body.page === "string" ? body.page : "";

  // The chat guard (chat-guard.js): a chat that keeps trying to work the
  // assistant rather than shop is ended — three strikes, each needing the
  // phrase list and the model to agree. An ended chat gets no model call.
  // Never the admin's Test chat or testers.
  let guard = null;
  if (!internal) {
    guard = await guardMessage({ shop, config, message, sessionId, ip: clientIp(request), typed, tester, signedIn: Boolean(loggedInCustomerId), supportLabel: config.supportLabel || "" })
      .catch((err) => { console.error("[guard] failed:", err?.message || err); return null; });
    if (guard?.ended) {
      // The message that ended it is kept for the team whatever the
      // recording settings; later messages to an ended chat aren't.
      if (guard.mark) {
        saveRecording({ shop, sessionId, tester, page, typed, message, reply: guard.message, guard: guard.mark })
          .catch((err) => console.error("[recordings] save failed:", err?.message || err));
      }
      return Response.json({ error: "chat_ended", message: guard.message, until: guard.until ? new Date(guard.until).toISOString() : null }, { status: 423 });
    }
  }
  // The library keeps the shop's offline token current on app proxy requests.
  const accessToken = sessionAccessToken || null;

  // Customer service log (ChatInteraction): every storefront message counts
  // towards its chat; the first one keeps the opening words the chat showed.
  if (!internal && sessionId) {
    touchInteraction(shop, {
      sessionId,
      visitor: typeof body.visitor === "string" ? body.visitor : "",
      signedIn: Boolean(loggedInCustomerId),
      humanOffered: body.human_offered === true,
      disclosure: typeof body.disclosure === "string" ? body.disclosure : "",
    }).catch((err) => console.error("[service-log] touch failed:", err?.message || err));
  }

  // Shopify Analytics: a shopper's first message is a chat started (the admin
  // test chat never counts). A note the chat showed first doesn't change that.
  if (!internal && !messages.slice(0, -1).some((m) => m.role === "user")) {
    avaChatStarted(shop, { sessionId, message, typed, signedIn: !!loggedInCustomerId });
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
    sizeFinder: sanitizeSizeFinder(body.size_finder),
    // The product page the shopper is on (its handle, from the page URL).
    viewingHandle: cleanHandle(body.viewing),
    // Sent by tapping the seasonal button: the reply shows its collection.
    seasonalTap: body.seasonal === true,
    // Sent by tapping "Find my shoe size" before a shoe is picked.
    sizeIntroTap: body.size_intro === true,
    // A style tile from that answer: they're choosing a shoe to get sized.
    sizePickTap: body.size_pick === true,
    // Recording: only while the store has it on, and (by default) only for
    // testers who opened the store with the tester link. A turn the guard
    // struck is kept whatever the settings.
    record: shouldRecord(config, { tester: body.tester, internal }) || guard?.mark ? { sessionId, tester, page, typed } : null,
    guard: guard && guard.mark ? { mark: guard.mark, warn: Boolean(guard.warn) } : null,
  });
}

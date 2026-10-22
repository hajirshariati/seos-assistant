// In-chat returns (storefront, through the app proxy). The signed-in
// shopper picks items, a reason and how to send it back; this checks the
// order is theirs and still returnable, creates the return in AfterShip
// Returns and, for an exchange, sends back the same shoe in the next size.
// If AfterShip can't take it, the shopper gets their prefilled returns page.
//
// Every return started here is noted (ChatReturn), so:
//  - a retry, a double tap or a lost connection never starts a second one
//    (the same answer comes back, label and exchange cards included);
//  - GET ?orderId= tells the chat the order's state right now, wherever the
//    shopper picks it up again.

import { authenticate } from "../shopify.server";
import { getShopConfig } from "../models/ShopConfig.server";
import { checkIpShopRate, clientIp } from "../lib/rate-limit.server.js";
import { getOwnedOrder, toOrderCard, chatReturnView } from "../lib/orders.server.js";
import { reasonByKey, exchangeCard, createAftershipReturn, aftershipReasonName, returnMethods, blockedMessage, priorReturn } from "../lib/returns.server.js";
import { findChatReturns, saveChatReturn } from "../models/ChatReturn.server";
import { recordHealth } from "../models/ChatHealth.server";

const MAX_BODY_BYTES = 8 * 1024;

function returnsPage(config, number, email) {
  const base = String(config.returnsPageUrl || "").replace(/\/+$/, "");
  if (!base) return "";
  return number && email ? `${base}?order-number=${encodeURIComponent(number)}&email=${encodeURIComponent(email)}` : base;
}

// The methods as the chat shows them (AfterShip's own type stays here).
const publicMethods = () => returnMethods().map(({ type, ...m }) => m);

// One return at a time per order, so two taps can't both reach AfterShip.
const inFlight = new Map();
async function withOrderLock(key, fn) {
  while (inFlight.has(key)) await inFlight.get(key).catch(() => {});
  const p = fn();
  inFlight.set(key, p);
  try { return await p; } finally { if (inFlight.get(key) === p) inFlight.delete(key); }
}

async function signedIn(request, scope, limit) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  // Signed by Shopify's app proxy — never taken from the body.
  const customerId = new URL(request.url).searchParams.get("logged_in_customer_id") || "";
  if (!customerId) return { error: Response.json({ error: "sign_in_required", message: "Please sign in again to continue your return." }, { status: 401 }) };
  if (!checkIpShopRate(session.shop, `${clientIp(request)}|${customerId}`, { scope, limit }).ok) {
    return { error: Response.json({ error: "rate_limited", message: "Please wait a moment and try again." }, { status: 429 }) };
  }
  return { session, shop: session.shop, customerId };
}

function startedPayload(record, fallbackUrl, extra = {}) {
  const v = chatReturnView(record);
  return {
    ok: true,
    rma: v.rma,
    labelUrl: v.labelUrl,
    returnsUrl: fallbackUrl,
    method: v.method,
    exchange: v.exchange,
    lineIds: v.lineIds,
    refundTo: "original_payment",
    exchangeCards: Array.isArray(record.exchangeCards) ? record.exchangeCards : [],
    ...extra,
  };
}

// The order as the chat should show it right now.
export const loader = async ({ request }) => {
  try {
    const auth = await signedIn(request, "returns-status", 40);
    if (auth.error) return auth.error;
    const { session, shop, customerId } = auth;
    const orderId = String(new URL(request.url).searchParams.get("orderId") || "").replace(/\D/g, "");
    if (!orderId) return Response.json({ error: "invalid_request" }, { status: 400 });
    const order = await getOwnedOrder({ shop, accessToken: session.accessToken, customerId, orderId });
    if (!order) return Response.json({ error: "order_not_found", message: "We couldn't find that order on your account." }, { status: 404 });
    const config = await getShopConfig(shop);
    const card = toOrderCard(order, { chatReturns: await findChatReturns(shop, [orderId]) });
    return Response.json({
      ok: true,
      order: card,
      methods: publicMethods(),
      message: card.canReturn ? "" : blockedMessage(card.returnBlocked),
      returnsUrl: returnsPage(config, card.number, order.email || ""),
    });
  } catch (e) {
    if (e instanceof Response) throw e;
    console.error("[returns] status error:", e?.message || e);
    return Response.json({ error: "status_failed", message: "Something went wrong — please try again in a moment." }, { status: 500 });
  }
};

export const action = async ({ request }) => {
  try {
    const auth = await signedIn(request, "returns", 8);
    if (auth.error) return auth.error;
    const { session, shop, customerId } = auth;
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "request_too_large" }, { status: 413 });
    let body = null;
    try { body = JSON.parse(raw); } catch { /* handled below */ }
    const reason = reasonByKey(body?.reason);
    const picks = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
    const orderId = String(body?.orderId || "").replace(/\D/g, "");
    if (!orderId || !reason || !picks.length) return Response.json({ error: "invalid_request" }, { status: 400 });

    return await withOrderLock(`${shop}|${orderId}`, async () => {
      const config = await getShopConfig(shop);
      const order = await getOwnedOrder({ shop, accessToken: session.accessToken, customerId, orderId });
      if (!order) return Response.json({ error: "order_not_found", message: "We couldn't find that order on your account." }, { status: 404 });
      const started = await findChatReturns(shop, [orderId]);
      const card = toOrderCard(order, { chatReturns: started });
      const fallbackUrl = returnsPage(config, card.number, order.email || "");

      // Already started (a retry after a lost connection, a second tap, the
      // same flow in another tab): the same answer, not a second return.
      const prior = priorReturn(started, picks.map((p) => String(p?.lineId || "")));
      if (prior) return Response.json(startedPayload(prior, fallbackUrl, { already: true }));

      if (!card.canReturn) return Response.json({ error: "not_returnable", message: blockedMessage(card.returnBlocked), order: card }, { status: 409 });

      // Only this order's items, never more than can still be returned.
      const items = [];
      for (const p of picks) {
        const item = card.items.find((i) => i.lineId === String(p?.lineId || ""));
        const qty = Math.min(Math.max(parseInt(p?.quantity, 10) || 1, 1), item?.returnable || 0);
        if (item && qty > 0) items.push({ ...item, quantity: qty });
      }
      if (!items.length) return Response.json({ error: "nothing_returnable", message: "Those items are already being returned.", order: card }, { status: 409 });

      const exchange = body.exchange === true && Boolean(reason.change);
      const comment = String(body.comment || "").replace(/[<>]/g, "").slice(0, 500);
      // Only a method the store offers; the first one when none was picked.
      const methods = returnMethods();
      const method = methods.find((m) => m.key === String(body.method || "")) || methods[0];

      let created = null;
      if (config.aftershipApiKey) {
        created = await createAftershipReturn({
          apiKey: config.aftershipApiKey,
          shop,
          order,
          items,
          reasonLabel: aftershipReasonName(reason.key),
          methodType: method.type,
          comment: exchange ? `${comment ? `${comment} — ` : ""}Exchanging for another size (ordered in chat)` : comment,
        });
        if (!created.ok) console.error(`[returns] AfterShip create failed shop=${shop} order=${card.number}: ${created.error}`);
      }
      if (!created?.ok) {
        recordHealth({ shop, route: "returns", ok: false, errorKind: config.aftershipApiKey ? "upstream" : "not_configured" });
        // Started somewhere else already (the returns page, customer service).
        const elsewhere = /already|duplicate|exist/i.test(created?.error || "");
        return Response.json({
          ok: false,
          error: elsewhere ? "already_returned" : "return_not_created",
          message: elsewhere
            ? "A return has already been started for this item — your label and drop-off steps are in your email, or on our returns page."
            : fallbackUrl
              ? "I couldn't start this return here — you can finish it in a minute on our returns page (your order is filled in)."
              : "I couldn't start this return here — our customer service team will be glad to help.",
          fallbackUrl,
        });
      }
      recordHealth({ shop, route: "returns", ok: true });

      let exchangeCards = [];
      if (exchange) {
        for (const it of items) {
          const ex = await exchangeCard({ shop, item: it, reasonKey: reason.key }).catch(() => null);
          if (ex?.card) exchangeCards.push({ ...ex.card, exchange_from: ex.from, exchange_to: ex.to });
        }
      }
      const record = {
        shop, orderId, lineIds: items.map((i) => i.lineId), reasonKey: reason.key,
        methodKey: method.key, methodLabel: method.label, findUrl: method.findUrl, exchange,
        rma: created.rma, returnId: created.returnId, labelUrl: created.labelUrl, exchangeCards, createdAt: new Date(),
      };
      const saved = await saveChatReturn(record);
      console.log(`[returns] created shop=${shop} order=${card.number} items=${items.length} reason=${reason.key} exchange=${exchange} method=${method.key} rma=${created.rma || "-"} saved=${saved ? "yes" : "no"}`);
      return Response.json(startedPayload(saved || record, fallbackUrl));
    });
  } catch (e) {
    if (e instanceof Response) throw e;
    console.error("[returns] error:", e?.message || e);
    return Response.json({ error: "action_failed", message: "Something went wrong — please try again in a moment." }, { status: 500 });
  }
};

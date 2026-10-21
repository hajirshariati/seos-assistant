// In-chat returns (storefront, through the app proxy). The signed-in
// shopper picks items and a reason in the chat; this checks the order is
// theirs and still returnable, creates the return in AfterShip Returns and,
// for an exchange, sends back the same shoe in the next size, ready to add.
// If AfterShip can't take it, the shopper gets their prefilled returns page.

import { authenticate } from "../shopify.server";
import { getShopConfig } from "../models/ShopConfig.server";
import { checkIpShopRate, clientIp } from "../lib/rate-limit.server.js";
import { getOwnedOrder, toOrderCard } from "../lib/orders.server.js";
import { reasonByKey, exchangeCard, createAftershipReturn } from "../lib/returns.server.js";
import { recordHealth } from "../models/ChatHealth.server";

const MAX_BODY_BYTES = 8 * 1024;

export const loader = async () => Response.json({ error: "Method not allowed. Use POST." }, { status: 405 });

function returnsPage(config, number, email) {
  const base = String(config.returnsPageUrl || "").replace(/\/+$/, "");
  if (!base) return "";
  return number && email ? `${base}?order-number=${encodeURIComponent(number)}&email=${encodeURIComponent(email)}` : base;
}

export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const shop = session.shop;
    // Signed by Shopify's app proxy — never taken from the body.
    const customerId = new URL(request.url).searchParams.get("logged_in_customer_id") || "";
    if (!customerId) return Response.json({ error: "sign_in_required" }, { status: 401 });
    if (!checkIpShopRate(shop, `${clientIp(request)}|${customerId}`, { scope: "returns", limit: 8 }).ok) {
      return Response.json({ error: "rate_limited", message: "Please wait a moment and try again." }, { status: 429 });
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "request_too_large" }, { status: 413 });
    let body = null;
    try { body = JSON.parse(raw); } catch { /* handled below */ }
    const reason = reasonByKey(body?.reason);
    const picks = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
    if (!body?.orderId || !reason || !picks.length) return Response.json({ error: "invalid_request" }, { status: 400 });

    const config = await getShopConfig(shop);
    const order = await getOwnedOrder({ shop, accessToken: session.accessToken, customerId, orderId: body.orderId });
    if (!order) return Response.json({ error: "order_not_found", message: "We couldn't find that order on your account." }, { status: 404 });
    const card = toOrderCard(order);
    if (!card.canReturn) return Response.json({ error: "not_returnable", message: "This order can't be returned yet — it hasn't shipped." }, { status: 409 });

    // Only this order's items, never more than can still be returned.
    const items = [];
    for (const p of picks) {
      const item = card.items.find((i) => i.lineId === String(p?.lineId || ""));
      const qty = Math.min(Math.max(parseInt(p?.quantity, 10) || 1, 1), item?.returnable || 0);
      if (item && qty > 0) items.push({ ...item, quantity: qty });
    }
    if (!items.length) return Response.json({ error: "nothing_returnable", message: "Those items have already been returned." }, { status: 409 });

    const fallbackUrl = returnsPage(config, card.number, order.email || "");
    const exchange = body.exchange === true && Boolean(reason.change);
    const comment = String(body.comment || "").replace(/[<>]/g, "").slice(0, 500);

    let created = null;
    if (config.aftershipApiKey) {
      created = await createAftershipReturn({
        apiKey: config.aftershipApiKey,
        order,
        items,
        reasonLabel: reason.label,
        comment: exchange ? `${comment ? `${comment} — ` : ""}Exchanging for another size (ordered in chat)` : comment,
        refundTo: body.refundTo,
      });
      if (!created.ok) console.error(`[returns] AfterShip create failed shop=${shop} order=${card.number}: ${created.error}`);
    }
    if (!created?.ok) {
      recordHealth({ shop, route: "returns", ok: false, errorKind: config.aftershipApiKey ? "upstream" : "not_configured" });
      return Response.json({
        ok: false,
        error: "return_not_created",
        message: fallbackUrl
          ? "I couldn't start this return here — you can finish it in a minute on our returns page (your order is filled in)."
          : "I couldn't start this return here — our customer service team will be glad to help.",
        fallbackUrl,
      });
    }
    recordHealth({ shop, route: "returns", ok: true });
    console.log(`[returns] created shop=${shop} order=${card.number} items=${items.length} reason=${reason.key} exchange=${exchange} rma=${created.rma || "-"}`);

    let exchangeCards = [];
    if (exchange) {
      for (const it of items) {
        const ex = await exchangeCard({ shop, item: it, reasonKey: reason.key }).catch(() => null);
        if (ex?.card) exchangeCards.push({ ...ex.card, exchange_from: ex.from, exchange_to: ex.to });
      }
    }
    return Response.json({
      ok: true,
      rma: created.rma,
      labelUrl: created.labelUrl,
      returnsUrl: fallbackUrl,
      items: items.map((i) => ({ title: i.title, image: i.image, options: i.options, quantity: i.quantity })),
      refundTo: body.refundTo === "store_credit" ? "store_credit" : "original_payment",
      exchangeCards,
    });
  } catch (e) {
    if (e instanceof Response) throw e;
    console.error("[returns] error:", e?.message || e);
    return Response.json({ error: "action_failed", message: "Something went wrong — please try again in a moment." }, { status: 500 });
  }
};

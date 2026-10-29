// What the shopper did with the chat's cards, for Shopify Analytics: added to
// the cart from the chat, or off to checkout (Buy now, or Checkout after
// adding). The widget tells us; the event itself is built from the store's
// own catalog (app/lib/app-events.server.js). Nothing here changes a cart,
// an order or any other metric.
import { authenticate } from "../shopify.server";
import { getShopConfigCached } from "../models/ShopConfig.server";
import { avaAddedToCart, avaCheckoutStarted } from "../lib/app-events.server.js";
import { checkIpShopRate, clientIp } from "../lib/rate-limit.server.js";

const MAX_BODY_BYTES = 2 * 1024;

const eventId = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : "");

export const loader = async () => {
  return Response.json({ error: "Method not allowed. Use POST." }, { status: 405 });
};

export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!checkIpShopRate(session.shop, clientIp(request), { scope: "activity", limit: 60 }).ok) {
      return Response.json({ error: "rate_limited" }, { status: 429 });
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "request_too_large" }, { status: 413 });
    let body = null;
    try { body = JSON.parse(raw); } catch { /* handled below */ }
    if (!body || typeof body !== "object") return Response.json({ error: "Invalid request" }, { status: 400 });

    const config = await getShopConfigCached(session.shop);
    if (config.appEventsEnabled === false) return Response.json({ ok: true, sent: false });

    const quantity = Number.isSafeInteger(body.quantity) ? body.quantity : 1;
    let sent = false;
    if (body.kind === "add_to_cart") {
      sent = await avaAddedToCart(session.shop, { variantId: body.variant, quantity, eventId: eventId(body.id) });
    } else if (body.kind === "checkout") {
      sent = await avaCheckoutStarted(session.shop, { source: body.source, variantId: body.variant || null, eventId: eventId(body.id) });
    } else {
      return Response.json({ error: "Invalid kind" }, { status: 400 });
    }
    return Response.json({ ok: true, sent });
  } catch (e) {
    // Shopify's signature check rejects by throwing a Response.
    if (e instanceof Response) throw e;
    console.error("[activity] error:", e?.message || e);
    return Response.json({ error: "Failed to record activity" }, { status: 500 });
  }
};

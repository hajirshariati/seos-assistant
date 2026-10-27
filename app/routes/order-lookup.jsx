// Order status without signing in: the chat's "Look up an order" form posts
// { order, email } here through the Shopify app proxy (signed). The order
// number (or confirmation code) and the email must belong to the same order;
// then only that order's status comes back (app/lib/guest-order.server.js).
// The details come straight from the shopper's browser — the AI never sees
// them — and nothing is stored.
import { authenticate } from "../shopify.server";
import { getShopConfigCached } from "../models/ShopConfig.server";
import { clientIp } from "../lib/rate-limit.server.js";
import { cleanLookup, lookupGuestOrder, guestLimiter } from "../lib/guest-order.server.js";

const NOT_FOUND = "We couldn't find an order with those details. Check them against your order confirmation email — orders from the last 60 days can be looked up here.";
const LIMITED = "Too many tries for now. Please wait a little and try again, or sign in to see your orders.";
const MAX_BODY = 2048;

const reply = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export const loader = () => reply({ error: "method_not_allowed" }, 405);

export const action = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return reply({ error: "unauthorized" }, 401);
  const shop = session.shop;
  const config = await getShopConfigCached(shop);
  if (config.guestOrderLookup === false) return reply({ error: "off", message: "Sign in to see your orders." }, 403);
  if (!session.accessToken) return reply({ error: "unavailable", message: "Order lookup isn't available right now." }, 503);
  // JSON only: a page elsewhere can't post this as a plain form.
  if (!String(request.headers.get("content-type") || "").includes("application/json")) return reply({ error: "bad_request" }, 415);

  const device = clientIp(request);
  const raw = await request.text().catch(() => "");
  let body = null;
  if (raw.length <= MAX_BODY) try { body = JSON.parse(raw); } catch { /* handled below */ }
  const input = cleanLookup(body || {});
  // Every try counts — a malformed one against this device only.
  const limit = guestLimiter(shop, input.errors ? { device } : { device, order: input.order.toLowerCase(), email: input.email });
  if (!limit.ok) return reply({ error: "too_many_tries", message: LIMITED, retryAfter: limit.retryAfter }, 429, { "Retry-After": String(limit.retryAfter) });
  if (input.errors) return reply({ error: "invalid", fields: input.errors }, 400);

  try {
    const result = await lookupGuestOrder({ shop, accessToken: session.accessToken, order: input.order, email: input.email, trackingBase: config.trackingPageUrl || "", returnsBase: config.returnsPageUrl || "" });
    if (result.notFound) return reply({ error: "not_found", message: NOT_FOUND }, 404);
    return reply({ ok: true, order: result.order });
  } catch (err) {
    console.error(`[order-lookup] shop=${shop} failed: ${String(err?.message || err).slice(0, 200)}`);
    return reply({ error: "unavailable", message: "We couldn't look that up right now. Please try again in a moment." }, 503);
  }
};

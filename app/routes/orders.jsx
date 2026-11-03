// Returns & exchanges: the signed-in shopper's recent orders for the instant
// returns card (GET /apps/hajirai/orders, through the app proxy). The
// customer is the one Shopify signed into the request — never taken from
// the query. The cards are the same ones the chat's order tool draws, minus
// the facts kept for the assistant; nothing is stored. Signed out: no
// orders, no error.
import { authenticate } from "../shopify.server";
import { getShopConfigCached } from "../models/ShopConfig.server";
import { checkIpShopRate, clientIp } from "../lib/rate-limit.server.js";
import { getOrderCards, returnPolicy } from "../lib/orders.server.js";
import { publicReturnMethods } from "../lib/returns.server.js";

const noStore = { headers: { "Cache-Control": "private, no-store" } };
const FIRST = 5;

// The card without the assistant-only facts (refund, return facts, codes).
export function publicOrderCard(o, { returnMode = "chat" } = {}) {
  const { refund, returnFacts, discountCodes, ...card } = o; // eslint-disable-line no-unused-vars
  return returnMode === "page" ? { ...card, returnMode: "page" } : card;
}

export const loader = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!checkIpShopRate(session.shop, clientIp(request), { scope: "orders", limit: 30 }).ok) {
      return Response.json({ error: "rate_limited" }, { status: 429 });
    }
    const customerId = new URL(request.url).searchParams.get("logged_in_customer_id") || "";
    if (!customerId) return Response.json({ signedIn: false }, noStore);
    if (!session.accessToken) return Response.json({ error: "unavailable" }, { status: 503 });
    const config = await getShopConfigCached(session.shop);
    const inChat = config.returnsInChat !== false;
    const { orders, numberOfOrders } = await getOrderCards({
      shop: session.shop, accessToken: session.accessToken, customerId, first: FIRST,
      trackingBase: config.trackingPageUrl || "", returnsBase: config.returnsPageUrl || "", policy: returnPolicy(config),
    });
    return Response.json({
      signedIn: true,
      orders: orders.map((o) => publicOrderCard(o, { returnMode: inChat ? "chat" : "page" })),
      numberOfOrders,
      returnMethods: inChat ? publicReturnMethods() : [],
      freeReasons: inChat ? returnPolicy(config).rules.freeReasons : [],
    }, noStore);
  } catch (e) {
    if (e instanceof Response) throw e;
    console.error("[orders] error:", e?.message || e);
    return Response.json({ error: "unavailable" }, { status: 500 });
  }
};

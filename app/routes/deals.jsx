// Deals: the running offers and the products on sale for the instant Deals
// card (GET /apps/hajirai/deals, through the app proxy). Nothing about the
// shopper is read or stored; the answer is the same for everyone and kept a
// few minutes per store (deals.server.js).
import { authenticate } from "../shopify.server";
import { getShopConfigCached } from "../models/ShopConfig.server";
import { checkIpShopRate, clientIp } from "../lib/rate-limit.server.js";
import { getDeals } from "../lib/deals.server.js";

export const loader = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!checkIpShopRate(session.shop, clientIp(request), { scope: "deals", limit: 30 }).ok) {
      return Response.json({ error: "rate_limited" }, { status: 429 });
    }
    const config = await getShopConfigCached(session.shop);
    const deals = await getDeals({ shop: session.shop, accessToken: session.accessToken, config });
    if (!deals) return Response.json({ error: "off" }, { status: 404 });
    return Response.json(deals, { headers: { "Cache-Control": "public, max-age=120" } });
  } catch (e) {
    if (e instanceof Response) throw e;
    console.error("[deals] error:", e?.message || e);
    return Response.json({ error: "unavailable" }, { status: 500 });
  }
};

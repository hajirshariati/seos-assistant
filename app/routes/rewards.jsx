// My rewards: a signed-in shopper's points balance for the instant rewards
// card (GET /apps/hajirai/rewards, through the app proxy). The customer is
// the one Shopify signed into the request — never taken from the query —
// and the balance comes from the store's Yotpo Loyalty account. Nothing is
// stored. Signed out, or no loyalty account: no balance, no error.
import { authenticate } from "../shopify.server";
import { getShopConfigCached } from "../models/ShopConfig.server";
import { checkIpShopRate, clientIp } from "../lib/rate-limit.server.js";
import { fetchCustomerContext } from "../lib/customer-context.server.js";
import { fetchYotpoLoyalty } from "../lib/yotpo-loyalty.server.js";
import { rewardsBalanceWords } from "../lib/rewards-card.js";

const noStore = { headers: { "Cache-Control": "private, no-store" } };

export const loader = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!checkIpShopRate(session.shop, clientIp(request), { scope: "rewards", limit: 30 }).ok) {
      return Response.json({ error: "rate_limited" }, { status: 429 });
    }
    const customerId = new URL(request.url).searchParams.get("logged_in_customer_id") || "";
    if (!customerId) return Response.json({ signedIn: false }, noStore);
    const config = await getShopConfigCached(session.shop);
    if (!config.yotpoLoyaltyApiKey) return Response.json({ signedIn: true, balance: "" }, noStore);
    const customer = await fetchCustomerContext({ shop: session.shop, accessToken: session.accessToken, customerId, orderLimit: 1 }).catch(() => null);
    if (!customer?._email) return Response.json({ signedIn: true, balance: "" }, noStore);
    const loyalty = await fetchYotpoLoyalty({ apiKey: config.yotpoLoyaltyApiKey, guid: config.yotpoLoyaltyGuid, email: customer._email }).catch(() => null);
    return Response.json({
      signedIn: true,
      member: Boolean(loyalty),
      balance: loyalty ? rewardsBalanceWords(loyalty.pointsBalance, config) : "",
      tier: loyalty?.tier || "",
    }, noStore);
  } catch (e) {
    if (e instanceof Response) throw e;
    console.error("[rewards] error:", e?.message || e);
    return Response.json({ error: "unavailable" }, { status: 500 });
  }
};

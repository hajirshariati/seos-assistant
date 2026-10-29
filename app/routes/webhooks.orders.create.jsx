import { authenticate } from "../shopify.server";
import { recordChatConversion } from "../models/ChatConversion.server";
import { chatOrderFlags, chatOrderTags } from "../lib/buy-now.js";
import { getShopConfigCached } from "../models/ShopConfig.server";
import { shopFacts } from "../lib/shopify-facts.server.js";
import { appBrand, appName } from "../lib/app-brand.js";

// orders/create webhook → if the order's note_attributes contain the
// `_seos_attributed=1` flag the widget set on a chat product-link
// click, append the app's brand as a tag ("AVA" on the Aetrex app,
// "SEoS" on the other — app/lib/app-brand.js). Lets merchants filter
// chat-driven sales in Shopify Orders via the standard tag filter.
// An order placed through the cards' Buy now also carries
// `_seos_buy_now=1` and gets "AVA Buy now" (or "SEoS Buy now") as well.
//
// Best-effort: any failure (auth, GraphQL, malformed payload) is
// logged and swallowed. Tagging is observability — a failure must
// not surface to Shopify (which would retry) or to customers.
export const action = async ({ request }) => {
  const { shop, payload, topic, admin } = await authenticate.webhook(request);

  try {
    const flags = chatOrderFlags(payload?.note_attributes);
    if (!flags.chat) {
      return new Response();
    }

    const orderGid = `gid://shopify/Order/${payload.id}`;
    if (!admin) {
      console.warn(`[webhook ${topic}] no admin client for ${shop} — skipping tag for ${orderGid}`);
      return new Response();
    }
    // The app's name in Shopify decides the brand of the tags.
    const facts = await shopFacts(shop, await getShopConfigCached(shop), { admin }).catch(() => null);
    const tags = chatOrderTags(flags, appBrand(appName(facts)));

    const result = await admin.graphql(
      `#graphql
      mutation tagSeos($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node { id }
          userErrors { field message }
        }
      }`,
      { variables: { id: orderGid, tags } },
    );
    const json = await result.json().catch(() => null);
    const errs = json?.data?.tagsAdd?.userErrors || [];
    if (errs.length > 0) {
      console.warn(`[webhook ${topic}] tagsAdd userErrors for ${orderGid}:`, errs);
    } else {
      console.log(`[webhook ${topic}] tagged ${orderGid} with ${tags.join(", ")}`);
    }

    // Mirror the conversion into our own DB so the analytics +
    // home-page metrics don't depend on a Shopify Admin API call on
    // every page load. Idempotent on (shop, orderId).
    await recordChatConversion({
      shop,
      orderId: payload.id,
      // payload.name already arrives formatted ("#1001"); only build a
      // "#" prefix from the bare order_number. (The old `a || b ? ...`
      // precedence produced "##1001" when name was present.)
      orderName: payload.order_number
        ? `#${payload.order_number}`
        : (payload.name || null),
      totalAmount: payload.total_price ? Number(payload.total_price) : null,
      currency: payload.currency || payload.presentment_currency || null,
      customerId: payload.customer?.id ? String(payload.customer.id) : null,
    });
  } catch (err) {
    console.error(`[webhook ${topic}] failed for ${shop}:`, err?.message || err);
  }

  return new Response();
};

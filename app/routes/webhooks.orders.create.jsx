import { authenticate } from "../shopify.server";
import { recordChatConversion } from "../models/ChatConversion.server";
import { recordRecentPurchases } from "../models/SocialProof.server";

const ATTR_NAME = "_seos_attributed";
const ORDER_TAG = "SEoS";

// orders/create webhook → if the order's note_attributes contain the
// `_seos_attributed=1` flag the widget set on a chat product-link
// click, append the "SEoS" tag to the order. Lets merchants filter
// chat-driven sales in Shopify Orders via the standard tag filter.
//
// Best-effort: any failure (auth, GraphQL, malformed payload) is
// logged and swallowed. Tagging is observability — a failure must
// not surface to Shopify (which would retry) or to customers.
export const action = async ({ request }) => {
  const { shop, payload, topic, admin } = await authenticate.webhook(request);

  // Record the purchase for the storefront social-proof popup. Stores only the
  // purchased product + timestamp — NO address/city or any customer PII. Runs
  // for ALL orders, independent of SEoS chat attribution, so it must happen
  // before the attribution early-return below. Best-effort.
  try {
    await recordRecentPurchases({
      shop,
      orderId: payload.id,
      lineItems: Array.isArray(payload.line_items) ? payload.line_items : [],
    });
  } catch (err) {
    console.error(`[webhook ${topic}] social-proof capture failed:`, err?.message || err);
  }

  try {
    const noteAttrs = Array.isArray(payload?.note_attributes) ? payload.note_attributes : [];
    const attributed = noteAttrs.some((a) =>
      String(a?.name || "").toLowerCase() === ATTR_NAME &&
      String(a?.value || "").toLowerCase() !== "0" &&
      String(a?.value || "").toLowerCase() !== "false" &&
      String(a?.value || "") !== "",
    );
    if (!attributed) {
      return new Response();
    }

    const orderGid = `gid://shopify/Order/${payload.id}`;
    if (!admin) {
      console.warn(`[webhook ${topic}] no admin client for ${shop} — skipping tag for ${orderGid}`);
      return new Response();
    }

    const result = await admin.graphql(
      `#graphql
      mutation tagSeos($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node { id }
          userErrors { field message }
        }
      }`,
      { variables: { id: orderGid, tags: [ORDER_TAG] } },
    );
    const json = await result.json().catch(() => null);
    const errs = json?.data?.tagsAdd?.userErrors || [];
    if (errs.length > 0) {
      console.warn(`[webhook ${topic}] tagsAdd userErrors for ${orderGid}:`, errs);
    } else {
      console.log(`[webhook ${topic}] tagged ${orderGid} with ${ORDER_TAG}`);
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

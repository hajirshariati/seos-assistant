import { authenticate } from "../shopify.server";
import db from "../db.server";

// GDPR: Shopify forwards customer data-access requests here. Chat
// interactions are anonymized via a SHA-256 hash of the source IP and
// are not linked to any Shopify customer identity. The ONE per-customer
// datum we hold is the Shopify customer id on chat-attributed order
// conversions (webhooks/orders/create → ChatConversion) — return those
// rows so the merchant can fulfill the access request.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const customerId = payload?.customer?.id != null ? String(payload.customer.id) : null;
  const conversions = customerId
    ? await db.chatConversion.findMany({
        where: { shop, customerId },
        select: { orderId: true, orderName: true, totalAmount: true, currency: true, createdAt: true },
      })
    : [];

  return Response.json({
    shop_domain: shop,
    customer_data: conversions.map((c) => ({
      type: "chat_attributed_order_conversion",
      order_id: c.orderId,
      order_name: c.orderName,
      total_amount: c.totalAmount,
      currency: c.currency,
      recorded_at: c.createdAt,
    })),
    notice:
      "Chat interactions are anonymized via a hash of the source IP address and cannot be linked to a Shopify customer identity. The only customer-linked records are chat-attributed order conversions, listed above.",
  });
};

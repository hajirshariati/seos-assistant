import { authenticate } from "../shopify.server";
import db from "../db.server";

// GDPR: Shopify forwards customer-deletion requests here. Chat
// interactions are anonymized (hash of source IP, no customer key),
// but order-conversion mirroring (webhooks/orders/create →
// ChatConversion) DOES persist the Shopify customer id of attributed
// orders — those rows must be scrubbed for the redacted customer.
// The shop/redact webhook handles full-shop removal.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const customerId = payload?.customer?.id != null ? String(payload.customer.id) : null;
  // The orders Shopify names too — matched by plain or gid id form.
  const orderIds = (Array.isArray(payload?.orders_to_redact) ? payload.orders_to_redact : [])
    .flatMap((id) => [String(id), `gid://shopify/Order/${id}`]);
  if (customerId || orderIds.length) {
    // Keep the conversion row for revenue accounting; remove the
    // customer linkage (the only per-customer datum we hold).
    const result = await db.chatConversion.updateMany({
      where: { shop, OR: [...(customerId ? [{ customerId }] : []), ...(orderIds.length ? [{ orderId: { in: orderIds } }] : [])] },
      data: { customerId: null },
    });
    console.log(
      `[webhook ${topic}] anonymized ${result.count} conversion row(s) for customer ${customerId} on ${shop}`,
    );
  }

  return new Response();
};

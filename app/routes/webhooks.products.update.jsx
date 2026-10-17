import { authenticate } from "../shopify.server";
import { enqueueProductChange } from "../lib/product-webhook-queue.server";

export const action = async ({ request }) => {
  const { shop, payload, topic, admin } = await authenticate.webhook(request);
  // High-volume; the drain and sync summaries are always logged.
  if (process.env.WEBHOOK_DEBUG === "true") console.log(`Received ${topic} webhook for ${shop}`);
  enqueueProductChange(shop, payload?.id || payload?.admin_graphql_api_id, admin);
  return new Response();
};

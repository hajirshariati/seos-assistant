// The picture of the store's app (Settings → Your app), shown in the chat's
// app message: /apps/hajirai/app-image?v=<fingerprint>. The link changes
// with the picture, so it's kept for a long time.
import { authenticate } from "../shopify.server";
import { getShopConfigCached } from "../models/ShopConfig.server";
import { appImageData } from "../lib/app-promo.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const config = await getShopConfigCached(session.shop);
  const img = config.appPromoOn === false ? null : appImageData(config.appPromoImage);
  if (!img) return new Response("Not found", { status: 404 });
  return new Response(Uint8Array.from(atob(img.base64), (c) => c.charCodeAt(0)), { headers: { "Content-Type": img.type, "Cache-Control": "public, max-age=604800", "X-Content-Type-Options": "nosniff" } });
};

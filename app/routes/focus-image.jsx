// A picture of the Focus home's line cards (Settings → Focus home):
// /apps/hajirai/focus-image?kind=footwear|orthotics&v=<fingerprint>. The
// link changes with the picture, so it's kept for a long time.
import { authenticate } from "../shopify.server";
import { getShopConfigCached } from "../models/ShopConfig.server";
import { focusImageData, focusImageKey } from "../lib/focus-home.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const key = focusImageKey(new URL(request.url).searchParams.get("kind"));
  const config = key ? await getShopConfigCached(session.shop) : null;
  const img = key ? focusImageData(config[key]) : null;
  if (!img) return new Response("Not found", { status: 404 });
  return new Response(Uint8Array.from(atob(img.base64), (c) => c.charCodeAt(0)), { headers: { "Content-Type": img.type, "Cache-Control": "public, max-age=604800", "X-Content-Type-Options": "nosniff" } });
};

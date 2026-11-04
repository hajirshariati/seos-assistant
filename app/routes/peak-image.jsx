// A picture of the peak-day home (Settings → Peak Mode): the assistant's
// peak picture (?b=avatar) or a block's (?b=<block id>, ?w=400|800 for a
// smaller copy of it), with the picture's fingerprint in ?v — the link
// changes with the picture, so it's kept long.
import { authenticate } from "../shopify.server";
import { getShopConfigCached } from "../models/ShopConfig.server";
import { peakImage } from "../lib/peak-home.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const url = new URL(request.url);
  const which = String(url.searchParams.get("b") || "").slice(0, 16);
  const config = which ? await getShopConfigCached(session.shop) : null;
  // ?w=400|800: a smaller copy of an uploaded picture, when it has one (else the picture itself).
  const img = config ? peakImage(config, which, Number(url.searchParams.get("w")) || 0) : null;
  if (!img) return new Response("Not found", { status: 404 });
  return new Response(Uint8Array.from(atob(img.base64), (c) => c.charCodeAt(0)), { headers: { "Content-Type": img.type, "Cache-Control": "public, max-age=604800", "X-Content-Type-Options": "nosniff" } });
};

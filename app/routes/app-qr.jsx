// The QR code for the store's app (Settings → Your app), shown in the chat's
// app mention on computers: /apps/hajirai/app-qr?p=ios|android. Made from
// the store's own App Store / Google Play link — never from anything the
// request sends — and kept, since it only changes with the link.
import QRCode from "qrcode";
import { authenticate } from "../shopify.server";
import { getShopConfigCached } from "../models/ShopConfig.server";
import { cleanAppLink } from "../lib/app-promo.js";

const made = new Map();

export async function appQrSvg(url) {
  if (!made.has(url)) {
    if (made.size > 200) made.clear();
    made.set(url, await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#111111", light: "#ffffff" } }));
  }
  return made.get(url);
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const platform = new URL(request.url).searchParams.get("p") === "android" ? "android" : "ios";
  const config = await getShopConfigCached(session.shop);
  const url = config.appPromoOn === false ? "" : cleanAppLink(platform, platform === "ios" ? config.appIosUrl : config.appAndroidUrl);
  if (!url) return new Response("Not found", { status: 404 });
  return new Response(await appQrSvg(url), { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" } });
};

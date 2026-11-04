// The store's mobile app, shown once per visit as its own message in the
// chat (Settings → Shopping tools → Your app). Only real App Store / Google Play links are
// used; with none set, the widget uses the links in the store's own footer.
// Pure.

const STORE = {
  ios: /^https:\/\/apps\.apple\.com\/[^\s"'<>]+$/i,
  android: /^https:\/\/play\.google\.com\/store\/apps\/details\?[^\s"'<>]+$/i,
};

export function cleanAppLink(platform, url) {
  const u = String(url || "").trim();
  return STORE[platform] && STORE[platform].test(u) && u.length <= 300 ? u : "";
}

// The message and its button, as set in Settings ("" → the widget's
// defaults: "Love {store}? You'll love our app" and "Get it").
export const APP_TEXT_MAX = 60;
export const APP_BUTTON_MAX = 16;
export function cleanAppText(v, max = APP_TEXT_MAX) {
  return String(v || "").replace(/\s+/g, " ").trim().slice(0, max).trim();
}
export function defaultAppText(storeName) {
  const name = cleanAppText(storeName, 30);
  return name ? `Love ${name}? You\u2019ll love our app` : "You\u2019ll love our app";
}

// The app's picture, uploaded in Settings: a PNG, WebP or JPEG data URL,
// resized there before it's saved. → { type, base64 } or null (the route
// turns it into bytes).
export const APP_IMAGE_MAX_BYTES = 400 * 1024;
const IMAGE_DATA_URL = /^data:(image\/(?:png|webp|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/;
export function appImageData(value) {
  const m = String(value || "").match(IMAGE_DATA_URL);
  if (!m) return null;
  const size = Math.floor((m[2].length * 3) / 4) - (m[2].match(/=*$/)[0].length);
  if (size <= 0 || size > APP_IMAGE_MAX_BYTES) return null;
  return { type: m[1], base64: m[2] };
}
// A file picked from the store's Shopify Files (Settings → Choose from
// files): a link on Shopify's CDN to a picture, or to a video. Kept as the
// link — nothing is copied — so it stays as sharp as it was uploaded.
const SHOPIFY_CDN = /^https:\/\/cdn\.shopify\.com\/[^\s"'<>]+$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|avif)(\?[^\s"'<>]*)?$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?[^\s"'<>]*)?$/i;
export function cdnImageUrl(value) {
  const v = String(value || "").trim();
  return SHOPIFY_CDN.test(v) && IMAGE_EXT.test(v) && v.length <= 600 ? v : "";
}
export function cdnVideoUrl(value) {
  const v = String(value || "").trim();
  return SHOPIFY_CDN.test(v) && VIDEO_EXT.test(v) && v.length <= 600 ? v : "";
}
// A picture as it may be stored: a data URL within the size limit, or a
// Shopify Files link; else "".
export function appImageValue(value) {
  const v = String(value || "");
  return appImageData(v) ? v : cdnImageUrl(v);
}
// For widget-config: a stored picture as a link the page can load — the
// app's own route (with the picture's fingerprint) for a data URL, the
// Shopify link as it is.
export function appImageLink(value, route) {
  const v = String(value || "");
  if (appImageData(v)) return route(shortHash(v));
  return cdnImageUrl(v);
}
// Settings: a picture that can't be used is refused, with why.
export function appImageError(value) {
  const v = String(value || "");
  if (!v || appImageValue(v)) return "";
  if (IMAGE_DATA_URL.test(v)) return "That picture is too large — try a smaller one.";
  if (/^https?:/i.test(v)) return "Pick the picture from your Shopify files, or upload one.";
  return "The app picture should be a PNG, WebP or JPEG image.";
}
// A short fingerprint of the picture, so a new one gets a new link (cached for good).
export function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
export const APP_IMAGE_PATH = "/apps/hajirai/app-image";

// For widget-config: off, or on with whichever links are set.
export function appPromoConfig(config = {}) {
  if (config.appPromoOn === false) return { on: false };
  const image = appImageLink(config.appPromoImage, (v) => `${APP_IMAGE_PATH}?v=${v}`);
  return {
    on: true,
    ios: cleanAppLink("ios", config.appIosUrl),
    android: cleanAppLink("android", config.appAndroidUrl),
    text: cleanAppText(config.appPromoText),
    button: cleanAppText(config.appPromoButton, APP_BUTTON_MAX),
    ...(image ? { image } : {}),
  };
}

// Settings: a link that isn't the store's own page is refused, with why.
export function appLinkError(platform, url) {
  const u = String(url || "").trim();
  if (!u || cleanAppLink(platform, u)) return "";
  return platform === "ios"
    ? "The App Store link should start with https://apps.apple.com/"
    : "The Google Play link should start with https://play.google.com/store/apps/details?id=";
}

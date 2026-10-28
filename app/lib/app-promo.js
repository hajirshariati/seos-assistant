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
// Settings: a picture that can't be used is refused, with why.
export function appImageError(value) {
  const v = String(value || "");
  if (!v || appImageData(v)) return "";
  return IMAGE_DATA_URL.test(v) ? "That picture is too large — try a smaller one." : "The app picture should be a PNG, WebP or JPEG image.";
}
// A short fingerprint of the picture, so a new one gets a new link (cached for good).
function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
export const APP_IMAGE_PATH = "/apps/hajirai/app-image";

// For widget-config: off, or on with whichever links are set.
export function appPromoConfig(config = {}) {
  if (config.appPromoOn === false) return { on: false };
  const image = appImageData(config.appPromoImage) ? `${APP_IMAGE_PATH}?v=${shortHash(String(config.appPromoImage))}` : "";
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

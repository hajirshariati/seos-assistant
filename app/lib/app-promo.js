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

// For widget-config: off, or on with whichever links are set.
export function appPromoConfig(config = {}) {
  if (config.appPromoOn === false) return { on: false };
  return {
    on: true,
    ios: cleanAppLink("ios", config.appIosUrl),
    android: cleanAppLink("android", config.appAndroidUrl),
    text: cleanAppText(config.appPromoText),
    button: cleanAppText(config.appPromoButton, APP_BUTTON_MAX),
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

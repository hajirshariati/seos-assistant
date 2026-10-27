// The store's mobile app, mentioned once per visit in the chat (Settings →
// Shopping tools → Your app). Only real App Store / Google Play links are
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

// For widget-config: off, or on with whichever links are set.
export function appPromoConfig(config = {}) {
  if (config.appPromoOn === false) return { on: false };
  return { on: true, ios: cleanAppLink("ios", config.appIosUrl), android: cleanAppLink("android", config.appAndroidUrl) };
}

// Settings: a link that isn't the store's own page is refused, with why.
export function appLinkError(platform, url) {
  const u = String(url || "").trim();
  if (!u || cleanAppLink(platform, u)) return "";
  return platform === "ios"
    ? "The App Store link should start with https://apps.apple.com/"
    : "The Google Play link should start with https://play.google.com/store/apps/details?id=";
}

// The app's name and brand. Both apps run this same code: the Aetrex app is
// named "AVA Aetrex Virtual Assistant" (shopify.app.aetrex.toml), the other
// keeps "SEoS Assistant". The admin shows the name Shopify has for the app;
// the brand — "AVA" for a name that starts with AVA, "SEoS" for any other —
// names the chat's order tags ("AVA", "AVA Buy now"). Pure.

export const DEFAULT_APP_NAME = "SEoS Assistant";

export function appName(facts) {
  const t = String(facts?.title || "").trim();
  return t || DEFAULT_APP_NAME;
}

export function appBrand(name) {
  return /^AVA\b/.test(String(name || "").trim()) ? "AVA" : "SEoS";
}

// What a page calls it: just "AVA" on the Aetrex app; the full name on any
// other ("SEoS Assistant").
export function appShortName(name) {
  return appBrand(name) === "AVA" ? "AVA" : String(name || "").trim() || DEFAULT_APP_NAME;
}

// Everything a page needs, from the app's name.
export function appNames(name) {
  const full = String(name || "").trim() || DEFAULT_APP_NAME;
  return { name: full, short: appShortName(full), brand: appBrand(full) };
}

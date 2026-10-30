// What sits in the chat bar (Settings → AVA mark): AVA's light (the animated
// orb) or the assistant's photo from the theme editor. With the photo, the
// minimized bar is a small text button ("Ask Ava!") instead of the round
// light. Shared by Settings, widget-config and the evals; the widget keeps
// the same rules in its own script. Pure.

export const LAUNCHER_MARKS = ["orb", "avatar"];
export const LAUNCHER_TEXT_MAX = 24;

export function launcherMark(v) {
  return v === "avatar" ? "avatar" : "orb";
}

export function cleanLauncherText(v) {
  return String(v ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, LAUNCHER_TEXT_MAX).trim();
}

// The minimized button's words when the store hasn't set its own: "Ask Ava!"
// on the Aetrex app (brand "AVA"), "Ask AI" on any other.
export function defaultLauncherText(brand) {
  return brand === "AVA" ? "Ask Ava!" : "Ask AI";
}

// For widget-config: the mark and the minimized button's words ("" = the
// widget's own default).
export function launcherMarkConfig(config) {
  return { mark: launcherMark(config?.launcherMark), text: cleanLauncherText(config?.launcherText) };
}

// The avatar URL the storefront reports (Liquid's image_url, usually
// protocol-relative: //store.com/cdn/shop/files/ava.png?v=1&width=200).
// "" = no photo set; null = not a URL to keep.
export function cleanAvatarUrl(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return "";
  if (s.length > 500 || !/^(https:)?\/\/[a-z0-9.-]+\.[a-z]{2,}\/[^\s"'<>\\]*$/i.test(s)) return null;
  return s;
}

// The photo to show in Settings, only from the store's own domains or
// Shopify's CDN (anyone can call the storefront route that reports it).
export function avatarPreviewUrl(stored, hosts) {
  const s = cleanAvatarUrl(stored);
  if (!s) return "";
  let u;
  try { u = new URL(s.startsWith("//") ? `https:${s}` : s); } catch { return ""; }
  const host = u.hostname.toLowerCase();
  const ok = new Set(["cdn.shopify.com", ...(hosts || []).filter(Boolean).map((h) => String(h).toLowerCase())]);
  if (!ok.has(host)) return "";
  if (!/^\/(cdn\/shop\/|s\/files\/)/.test(u.pathname)) return "";
  return u.toString();
}

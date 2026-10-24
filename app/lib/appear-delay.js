// Settings → Showing the chat: how long the chat waits before it appears on
// the page (whole seconds, 1 to 60; off means right away), which look it
// starts in, and whether shoppers outside the store's home countries see it.

export const APPEAR_DELAY_MIN = 1;
export const APPEAR_DELAY_MAX = 60;

export function clampDelay(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(n)) return 3;
  return Math.min(APPEAR_DELAY_MAX, Math.max(APPEAR_DELAY_MIN, n));
}

// Which look the chat starts in: "dark" (the default) or "light".
export function startTheme(value) {
  return value === "light" ? "light" : "dark";
}

// What the widget gets.
export function appearDelayConfig(config = {}) {
  return { on: config.appearDelayOn === true, sec: clampDelay(config.appearDelaySec) };
}

// Home countries: two-letter codes ("US", "US, PR"). Anything else is dropped;
// an empty list falls back to US.
export function parseCountries(value) {
  const list = [...new Set(String(value || "").toUpperCase().split(/[^A-Z]+/).filter((c) => /^[A-Z]{2}$/.test(c)))];
  return list.length ? list.slice(0, 30) : ["US"];
}

// What the widget gets: hide for shoppers whose country isn't a home country.
export function internationalConfig(config = {}) {
  return { hide: config.hideInternational !== false, home: parseCountries(config.homeCountries) };
}

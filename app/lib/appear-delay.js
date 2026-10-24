// Settings → Showing the chat: how long the chat waits before it appears on
// the page (whole seconds, 1 to 60; off means right away), and which look it
// starts in.

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

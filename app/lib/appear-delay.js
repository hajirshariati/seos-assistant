// How long the chat waits before it appears on the page (Settings → Showing
// the chat). Whole seconds, 1 to 60; off means it shows right away.

export const APPEAR_DELAY_MIN = 1;
export const APPEAR_DELAY_MAX = 60;

export function clampDelay(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(n)) return 3;
  return Math.min(APPEAR_DELAY_MAX, Math.max(APPEAR_DELAY_MIN, n));
}

// What the widget gets.
export function appearDelayConfig(config = {}) {
  return { on: config.appearDelayOn === true, sec: clampDelay(config.appearDelaySec) };
}

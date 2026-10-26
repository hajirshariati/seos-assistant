// Peak Mode — the store's settings for its busiest days (big sales,
// launches, holidays). While it's on, the store-wide chat limits switch to
// the higher peak values, the daily message cap can step aside, and the
// nightly full catalog refresh can sit out. Pure + testable.
//
// Store-wide limits are counted per server instance (rate-limit.server.js):
// one instance serves the app. 0 means no limit.

export const NORMAL_LIMITS = { perMin: 120, perHour: 3000 };
export const PEAK_LIMITS = { perMin: 300, perHour: 8000 };
export const LIMIT_MAX = { perMin: 5000, perHour: 100000 };
export const PEAK_MODES = ["off", "on", "scheduled"];

const toDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// A whole number from 0 (no limit) to max; anything else → fallback.
export function cleanLimit(value, max, fallback) {
  const s = String(value ?? "").trim();
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number.parseInt(s, 10);
  return Math.min(n, max);
}

// Is Peak Mode on right now? "scheduled" runs from startsAt up to (not
// including) endsAt; a schedule without an end runs until turned off.
export function peakState(config = {}, now = new Date()) {
  const mode = PEAK_MODES.includes(config.peakMode) ? config.peakMode : "off";
  const startsAt = toDate(config.peakStartsAt);
  const endsAt = toDate(config.peakEndsAt);
  const t = toDate(now)?.getTime() ?? Date.now();
  let active = false;
  let upcoming = false;
  let ended = false;
  if (mode === "on") active = true;
  if (mode === "scheduled" && startsAt) {
    if (t < startsAt.getTime()) upcoming = true;
    else if (endsAt && t >= endsAt.getTime()) ended = true;
    else active = true;
  }
  return { mode, active, upcoming, ended, startsAt, endsAt };
}

const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : fallback);

// The store-wide chat limits in force right now. A server setting
// (CHAT_STORE_PER_MIN / CHAT_STORE_PER_HOUR) overrides the admin values —
// an emergency lever for whoever runs the server.
export function storeChatLimits(config = {}, { now = new Date(), env = {} } = {}) {
  const peak = peakState(config, now).active;
  const perMin = peak ? num(config.peakLimitPerMin, PEAK_LIMITS.perMin) : num(config.chatLimitPerMin, NORMAL_LIMITS.perMin);
  const perHour = peak ? num(config.peakLimitPerHour, PEAK_LIMITS.perHour) : num(config.chatLimitPerHour, NORMAL_LIMITS.perHour);
  const envMin = /^\d+$/.test(String(env.CHAT_STORE_PER_MIN ?? "").trim()) ? Number(env.CHAT_STORE_PER_MIN) : null;
  const envHour = /^\d+$/.test(String(env.CHAT_STORE_PER_HOUR ?? "").trim()) ? Number(env.CHAT_STORE_PER_HOUR) : null;
  return {
    peak,
    perMin: envMin ?? perMin,
    perHour: envHour ?? perHour,
    overridden: envMin !== null || envHour !== null,
  };
}

// The daily message cap applies unless it's off, or Peak Mode is on and set
// to lift it (so the assistant never goes quiet on the busiest day).
export function dailyCapApplies(config = {}, now = new Date()) {
  if (config.dailyCapEnabled !== true || !(Number(config.dailyCapMessages) > 0)) return false;
  if (config.peakLiftDailyCap !== false && peakState(config, now).active) return false;
  return true;
}

// The nightly full catalog refresh sits out while Peak Mode is on (product
// changes still arrive live through webhooks).
export function nightlySyncPaused(config = {}, now = new Date()) {
  return config.peakPauseSync !== false && peakState(config, now).active;
}

// What the shopper reads when the store-wide limit is reached. Under a
// sliding window a slot frees up as the oldest message ages out.
export function busyMessage(retryAfterSec) {
  const s = Number(retryAfterSec) || 0;
  const wait = s <= 90 ? "in a minute" : s <= 600 ? "in a few minutes" : "a little later";
  return `Lots of shoppers are chatting right now — please try again ${wait}.`;
}

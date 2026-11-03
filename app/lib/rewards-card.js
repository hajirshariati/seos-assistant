// My rewards — the instant rewards card (no AI): what the chat shows when a
// shopper taps "My rewards" on the home. Pure: the card's words as JSON on
// ShopConfig.rewardsCard, parsed with these defaults (the AVA defaults are
// the Aetrex Access program), and the form that edits them.

export const REWARDS_MAX = { title: 40, sub: 90, brand: 24, label: 28, value: 28, note: 110, cta: 28, url: 300, logo: 200000 };
export const REWARDS_ROWS = 4;
export const REWARDS_NOTES = 4;

const AVA_REWARDS = {
  on: true,
  brand: "Aetrex Access",
  title: "Your rewards, at a glance",
  sub: "Free to join. Earn on every order, spend at checkout.",
  earn: [
    { label: "Every $1", value: "10 points" },
    { label: "Welcome bonus", value: "4,000 points" },
    { label: "Refer a friend", value: "4,000 points" },
    { label: "Write a review", value: "100 points" },
  ],
  use: [
    { label: "1,000 points", value: "$5 off" },
    { label: "4,000 points", value: "$20 off" },
    { label: "25,000 points", value: "$125 off (max)" },
    { label: "Works with", value: "most promo codes" },
  ],
  notes: [
    "Points from an order land 30 days after you buy.",
    "Return something? The points come back on their own.",
    "Points stay active for 12 months after your last order or share.",
    "Log in, add to cart, pick a reward in the cart and tap Apply.",
  ],
  ctaLabel: "Open my rewards",
  ctaUrl: "https://www.aetrex.com/pages/rewards",
  // The Aetrex Access lockup (the store's own file): "aetrex" on light
  // slate, "ACCESS" on dark — a wide strip, shown 28px tall.
  logo: "https://www.aetrex.com/cdn/shop/files/aetrex_access.jpg",
};

const EMPTY = { on: false, brand: "", title: "My rewards", sub: "", earn: [], use: [], notes: [], ctaLabel: "See my rewards", ctaUrl: "", logo: "" };

export function rewardsDefaults(brand = "SEoS") {
  return brand === "AVA" ? structuredClone(AVA_REWARDS) : structuredClone(EMPTY);
}

const str = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const url = (v) => { const u = str(v, REWARDS_MAX.url); return /^https?:\/\/[^\s"'<>]+$/i.test(u) || /^\/[^\s"'<>]*$/.test(u) ? u : ""; };
const rows = (list) => (Array.isArray(list) ? list : [])
  .map((r) => ({ label: str(r?.label, REWARDS_MAX.label), value: str(r?.value, REWARDS_MAX.value) }))
  .filter((r) => r.label && r.value)
  .slice(0, REWARDS_ROWS);
const notes = (list) => (Array.isArray(list) ? list : []).map((n) => str(n, REWARDS_MAX.note)).filter(Boolean).slice(0, REWARDS_NOTES);
// A picture uploaded in Settings (data URL) or a link to one.
const logo = (v) => { const s = String(v || "").trim(); if (/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length <= REWARDS_MAX.logo) return s; return /^https:\/\/[^\s"'<>]+\.(png|jpe?g|webp|svg)(\?[^\s"'<>]*)?$/i.test(s) ? s.slice(0, REWARDS_MAX.url) : ""; };

// The stored JSON (or an object), made safe. An empty store means the
// brand's defaults; a saved card is taken as it is, blanks included.
export function parseRewardsCard(raw, { brand = "SEoS" } = {}) {
  let obj = raw;
  if (typeof raw === "string") { try { obj = raw.trim() ? JSON.parse(raw) : null; } catch { obj = null; } }
  if (!obj || typeof obj !== "object" || !Object.keys(obj).length) return rewardsDefaults(brand);
  return {
    on: obj.on === true,
    brand: str(obj.brand, REWARDS_MAX.brand),
    title: str(obj.title, REWARDS_MAX.title) || "My rewards",
    sub: str(obj.sub, REWARDS_MAX.sub),
    earn: rows(obj.earn),
    use: rows(obj.use),
    notes: notes(obj.notes),
    ctaLabel: str(obj.ctaLabel, REWARDS_MAX.cta) || "See my rewards",
    ctaUrl: url(obj.ctaUrl),
    logo: logo(obj.logo),
  };
}

// What the widget gets: nothing when the card is off or has nothing to
// show; otherwise the card without the admin-only bits.
export function rewardsCardConfig(config, { brand = "SEoS" } = {}) {
  const c = parseRewardsCard(config?.rewardsCard, { brand });
  if (!c.on || (!c.earn.length && !c.use.length && !c.notes.length)) return null;
  return c;
}

// The shopper's balance line: points, with dollars when the store shows
// them (Settings → Integrations → Yotpo Loyalty).
export function rewardsBalanceWords(points, config = {}) {
  const n = Number(points);
  if (!Number.isFinite(n) || n < 0) return "";
  const pts = `${Math.round(n).toLocaleString("en-US")} point${Math.round(n) === 1 ? "" : "s"}`;
  if (config.loyaltyDisplay !== "dollars") return pts;
  const ratio = Math.max(1, parseInt(config.loyaltyPointsPerDollar, 10) || 100);
  const v = n / ratio;
  const dollars = config.loyaltyRounding === "up" ? Math.ceil(v) : config.loyaltyRounding === "down" ? Math.floor(v) : Math.round(v * 100) / 100;
  return `${pts} · $${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
}

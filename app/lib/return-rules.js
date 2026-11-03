// Return rules, the same ones the store keeps in AfterShip Returns (its
// API offers no way to read them, so they're mirrored here from Settings →
// Customer care → Return rules): which items can't be returned — gift
// cards, final-sale tags, discounted items — and which reasons waive the
// return fee. The chat shows an item as not returnable before anyone picks
// it, instead of letting a gift card reach "Exchange for a bigger size".
// AfterShip still has the last word when the return is created.
//
// Pure rules; no database.

export const RULES_MAX = { list: 30, word: 60 };

// Reasons the chat offers. `change` says how an exchange moves the size.
export const RETURN_REASONS = [
  { key: "too_small", label: "Too small", change: { option: "size", step: 1 } },
  { key: "too_large", label: "Too large", change: { option: "size", step: -1 } },
  { key: "too_narrow", label: "Too narrow", change: { option: "width", step: 1 } },
  { key: "too_wide", label: "Too wide", change: { option: "width", step: -1 } },
  { key: "changed_mind", label: "Changed my mind" },
  { key: "damaged", label: "Damaged or defective" },
  { key: "not_as_described", label: "Not as described" },
  { key: "other", label: "Other" },
];
export const REASON_KEYS = RETURN_REASONS.map((r) => r.key);

const DEFAULTS = {
  types: ["Gift Card"],
  tags: ["final-sale", "final sale", "non-returnable", "no-returns"],
  words: ["gift card", "e-gift", "egift"],
  discounted: false,
  freeReasons: ["damaged", "not_as_described"],
};

const parseJson = (v) => { if (v && typeof v === "object") return v; try { return JSON.parse(v); } catch { return null; } };
const words = (v) => {
  const list = Array.isArray(v) ? v : String(v || "").split(/[,\n]/);
  const out = [];
  for (const w of list) {
    const s = String(w ?? "").replace(/\s+/g, " ").trim().slice(0, RULES_MAX.word);
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= RULES_MAX.list) break;
  }
  return out;
};

// The saved rules (JSON) → clean rules; nothing saved → the defaults.
export function parseReturnRules(raw, { reasonKeys = REASON_KEYS } = {}) {
  const o = parseJson(raw);
  if (!o || typeof o !== "object" || !Object.keys(o).length) return { ...DEFAULTS, types: [...DEFAULTS.types], tags: [...DEFAULTS.tags], words: [...DEFAULTS.words], freeReasons: [...DEFAULTS.freeReasons] };
  const free = words(o.freeReasons).map((k) => k.toLowerCase().replace(/[^a-z_]/g, ""));
  return {
    types: words(o.types),
    tags: words(o.tags),
    words: words(o.words),
    discounted: o.discounted === true,
    freeReasons: reasonKeys ? free.filter((k) => reasonKeys.includes(k)) : free,
  };
}

export const returnRulesDefaults = () => parseReturnRules("");

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

// Why an order item can't be returned ("" when it can): a gift card, a
// final-sale tag or type, or (when the store says so) bought at a discount.
export function itemBlock(item, rules = DEFAULTS) {
  const type = norm(item?.productType);
  const tags = (Array.isArray(item?.tags) ? item.tags : []).map(norm);
  const title = norm(item?.title);
  if (rules.words.some((w) => w && (title.includes(norm(w)) || type.includes(norm(w))))) return /gift/i.test(`${title} ${type}`) ? "gift_card" : "final_sale";
  if (rules.types.some((t) => t && type === norm(t))) return /gift/i.test(type) ? "gift_card" : "final_sale";
  if (rules.tags.some((t) => t && tags.includes(norm(t)))) return "final_sale";
  if (rules.discounted && item?.discounted) return "discounted";
  return "";
}

export const BLOCK_WORDS = {
  gift_card: "Gift cards can't be returned",
  final_sale: "Final sale — can't be returned",
  discounted: "Bought at a discount — not returnable",
};
export const blockWords = (why) => BLOCK_WORDS[why] || "";

// Whether the return fee is waived for this reason (damaged, not as described…).
export function feeWaived(reasonKey, rules = DEFAULTS) {
  return rules.freeReasons.includes(String(reasonKey || ""));
}

// AfterShip said no to the return on policy grounds (not an outage, not a
// duplicate): the words it uses for blocklists, eligibility and windows.
export const AFTERSHIP_REFUSED = /eligib|not\s*returnable|non[-\s]?returnable|return\s*polic|blocklist|not\s*allowed|outside.*(window|period)|final\s*sale|exceed/i;
export function aftershipRefused(text) {
  return AFTERSHIP_REFUSED.test(String(text || ""));
}

// "Buy now" on the chat's product cards (Settings → Shopping tools → Buy now),
// off unless the store turns it on. A card offers it only once the shopper's
// size, width and everything else are known; it goes straight to checkout
// with the item, the store's code if one is set, and the chat's credit on the
// order: the same `_seos_attributed` flag Add to cart sets, plus
// `_seos_buy_now`, so the order is tagged with the app's brand and "… Buy
// now" ("AVA", "AVA Buy now" on the Aetrex app; "SEoS", "SEoS Buy now" on
// the other — app/lib/app-brand.js) and counts as a sale from the chat
// exactly as before. Pure.

export const BUY_NOW_CODE_MAX = 64;
// Letters, numbers, - _ and . — a code that goes into a link as it is.
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function cleanBuyNowCode(value) {
  const s = String(value ?? "").trim();
  return s.length <= BUY_NOW_CODE_MAX && CODE.test(s) ? s : "";
}

// Settings: a code that can't be used is refused, with why ("" = fine or none).
export function buyNowCodeError(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  if (s.length > BUY_NOW_CODE_MAX) return `The Buy now discount code is too long (up to ${BUY_NOW_CODE_MAX} characters).`;
  if (!CODE.test(s)) return "The Buy now discount code can only use letters, numbers, - _ and . — type it as it is in Shopify → Discounts.";
  return "";
}

// What the widget gets: { on, code }.
export function buyNowConfig(config) {
  const on = config?.buyNowEnabled === true;
  return { on, code: on ? cleanBuyNowCode(config?.buyNowCode) : "" };
}

// An order's note attributes → whether the chat sold it, and whether through
// Buy now. "0", "false" or empty don't count (as the order webhook always read them).
export const CHAT_ATTR = "_seos_attributed";
export const BUY_NOW_ATTR = "_seos_buy_now";
// The chat's order tags for the app's brand ("SEoS" unless told).
export function orderTags(brand = "SEoS") {
  const b = brand === "AVA" ? "AVA" : "SEoS";
  return { order: b, buyNow: `${b} Buy now` };
}

function flagged(list, name) {
  return list.some((a) => {
    if (String(a?.name || "").toLowerCase() !== name) return false;
    const v = String(a?.value || "").toLowerCase();
    return v !== "" && v !== "0" && v !== "false";
  });
}

export function chatOrderFlags(noteAttributes) {
  const list = Array.isArray(noteAttributes) ? noteAttributes : [];
  const chat = flagged(list, CHAT_ATTR);
  return { chat, buyNow: chat && flagged(list, BUY_NOW_ATTR) };
}

export function chatOrderTags(flags, brand = "SEoS") {
  if (!flags?.chat) return [];
  const t = orderTags(brand);
  return flags.buyNow ? [t.order, t.buyNow] : [t.order];
}

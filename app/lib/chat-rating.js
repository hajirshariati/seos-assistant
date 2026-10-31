// Shoppers' feedback: thumbs under an answer ("answer"), and the "How's
// the chat going?" check-in for the whole conversation ("chat") — asked
// after an add to cart, back from Buy now, or after a few replies — with a
// one-tap reason after a thumbs-down and an optional comment. Pure.

export const CHAT_RATING_AFTER = { min: 2, max: 8, fallback: 3 };
export const COMMENT_MAX = 500;

// What the widget needs: whether to ask, and after how many replies.
export function chatRatingConfig(config = {}) {
  const n = Math.round(Number(config.chatRatingAfter));
  const after = Number.isFinite(n) ? Math.min(CHAT_RATING_AFTER.max, Math.max(CHAT_RATING_AFTER.min, n)) : CHAT_RATING_AFTER.fallback;
  return { on: config.chatRatingOn !== false, after };
}

// The shopper's comment as stored: one paragraph, no control characters.
export function cleanComment(text) {
  return [...String(text ?? "")]
    .map((ch) => { const c = ch.charCodeAt(0); return c < 32 || c === 127 ? " " : ch; })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, COMMENT_MAX);
}

// Why, after a thumbs-down — the widget's one-tap reasons, as the admin
// names them.
export const FEEDBACK_REASONS = {
  wrong_product: "Wrong product",
  not_answered: "Didn't answer the question",
  wrong_info: "Info was wrong",
  too_slow: "Too slow",
  other: "Something else",
};
export function cleanReason(v) {
  return Object.prototype.hasOwnProperty.call(FEEDBACK_REASONS, v) ? v : null;
}

// When it was asked: an answer about an order, or (for the whole chat)
// after an add to cart, back from Buy now, or after a few replies.
export const FEEDBACK_MOMENTS = {
  order: "Order answer",
  cart: "After add to cart",
  buy_now: "After Buy now",
  replies: "After a few replies",
};
export function cleanMoment(v, kind = "answer") {
  if (kind === "chat") return ["cart", "buy_now", "replies"].includes(v) ? v : null;
  return v === "order" ? v : null;
}

// What a rated chat was about, from the shopper's own words — a few broad
// subjects, so repeat trouble shows up as a count on the analytics page.
// The first rule that matches wins, so the order below matters (an order
// question that mentions shipping is about the order).
export const FEEDBACK_SUBJECTS = {
  orders: "Orders & tracking",
  returns: "Returns & exchanges",
  account: "Account & emails",
  sizing: "Sizing & fit",
  price: "Price & discounts",
  shipping: "Shipping",
  stores: "Stores & stock",
  products: "Finding products",
  other: "Something else",
};
const SUBJECT_RULES = [
  ["orders", /\b(order|orders|tracking|track my|where is my|shipped yet|confirmation number|delivery status|my package)\b/i],
  ["returns", /\b(return|returns|returning|exchange|exchanges|refund|refunds|send (it |them )?back|warranty)\b/i],
  ["account", /\b(unsubscribe|unsubscribing|subscribe|subscription|email|emails|account|password|log ?in|sign ?in|newsletter|text messages|sms|stop (texting|messaging))\b/i],
  ["sizing", /\b(size|sizes|sizing|fit|fits|fitting|wide|narrow|width|too (big|small|tight|loose)|half size|true fit|run (big|small|large))\b/i],
  ["price", /\b(price|prices|cost|discount|discounts|coupon|promo|promo code|code|sale|cheaper|deal|deals)\b/i],
  ["shipping", /\b(shipping|ship to|ship internationally|deliver|delivery|how long|arrive|arrives)\b/i],
  ["stores", /\b(store|stores|in stock|stock|restock|back in stock|available|availability|near me|location|locations|retailer)\b/i],
  ["products", /\b(sneaker|sneakers|sandal|sandals|shoe|shoes|boot|boots|slipper|slippers|clog|clogs|loafer|loafers|orthotic|orthotics|insole|insoles|arch|heel|plantar|bunion|bunions|recommend|recommendation|looking for|show me|color|colour|style|styles|collection)\b/i],
];
export function feedbackSubject(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  for (const [key, re] of SUBJECT_RULES) if (re.test(t)) return key;
  return "other";
}

// The widget's id for one vote (its reason, picked after, updates the
// same row).
export function cleanVoteKey(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}

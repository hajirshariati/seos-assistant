// Lean engine — back-in-stock alerts (Klaviyo). When a size the customer
// wants is sold out, or they ask when something comes back, the assistant
// checks that exact size and, if it's out, puts a Notify-me card under its
// reply: the customer's email goes from their browser to the store's Klaviyo
// back-in-stock subscription for that variant, and the store's own flow
// emails them when it's back. Nothing here talks to Klaviyo; this decides
// what the tool says and when a reply must use it. Pure.
import { resolvePreselect, preselectAvailable, availableAlternatives } from "./variant-choice.js";

export const RESTOCK_TOOL = "back_in_stock_alert";

// The customer is asking about a restock, or to be told when it's back.
export const RESTOCK_ASK = /\b(back[- ]in[- ]stock|restock\w*|re-stock\w*|coming back|come back in|get (?:it|them|more|any more) (?:back )?in|get \w[\w' ]{0,30}? back in|(?:be|is|get|come) (?:back |available )?(?:in stock|available|in my size)|notify me|let me know when|email me when|when (?:will|do|does|is|are|can) \w[\w' ]* (?:be )?(?:back|available|in stock|restocked|return))\b/i;

// What the tool definition says, for tools.js.
export const RESTOCK_TOOL_DEF = {
  name: RESTOCK_TOOL,
  description:
    "Check whether a product is in stock in one exact size (and width) right now and, when it's sold out, put a Notify-me card under your reply: the customer types their email and gets one email from the store the moment that size is back. " +
    "Use whenever a size, width or color they want is sold out, or they ask when something will be back, whether it'll be restocked, or to be notified — before anything else. " +
    "Needs the product's handle (from a search, a shown card or the page they're on) and the size they want; if you don't know their size, ask first — the card is for one exact size. " +
    "The store doesn't publish restock dates: never guess one, and never send a restock question to customer service.",
  input_schema: {
    type: "object",
    properties: {
      handle: { type: "string", description: "Product handle from a search result, a shown card or the page the customer is on." },
      options: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "The size (and width, etc.) they want, e.g. {\"size\": \"10.5\", \"width\": \"wide\"}. Required unless the product has no options.",
      },
    },
    required: ["handle"],
  },
};

const lower = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
const listed = (vals, max = 24) => vals.slice(0, max);

// The variants of a product whose option values match every chosen value.
function matching(product, pre) {
  const want = lower(pre);
  return (product.variants || []).filter((v) => {
    const has = lower(v.options);
    return Object.entries(want).every(([k, val]) => has[k] === val);
  });
}

// The tool's answer for one product and the options the customer named.
// live: this product's in-stock option bags from the store right now (the
// lean engine's liveStock), or null → the synced catalog's stock.
export function restockCheck(product, options, live = null) {
  if (!product) return { error: "No product with that handle. Search first." };
  const title = product.title;
  const optionNames = Object.keys(product.options || {});
  const stock = Array.isArray(live) ? live : product.stock;
  const wanted = options && typeof options === "object" ? options : null;
  const pre = wanted ? resolvePreselect(product, wanted) : null;

  if (optionNames.length && !pre) {
    const named = wanted ? Object.values(wanted).map((v) => String(v).trim()).filter(Boolean) : [];
    if (named.length) {
      return {
        carried: false,
        title,
        comes_in: Object.fromEntries(optionNames.map((n) => [n, listed(product.options[n])])),
        note: `${title} doesn't come in ${named.join(" / ")} — that isn't a size the store carries for it, so it won't be restocked in it (no alert). Say so plainly and offer the closest size it does come in (\`comes_in\`), or another style in their size.`,
      };
    }
    return {
      needs_options: true,
      title,
      comes_in: Object.fromEntries(optionNames.map((n) => [n, listed(product.options[n])])),
      in_stock_now: product.inStock,
      note: "Ask which size (and width) they want the alert for, with tap choices — the card is for one exact size. Don't guess it.",
    };
  }

  let variant = null;
  if (optionNames.length) {
    const found = matching(product, pre);
    if (found.length > 1) {
      // Size given, width not (or the other way round): ask for the rest.
      const missing = optionNames.filter((n) => !(n in pre));
      return {
        needs_options: true,
        title,
        chosen: pre,
        still_needed: Object.fromEntries(missing.map((n) => [n, listed([...new Set(found.map((v) => String(v.options?.[n] ?? "")).filter(Boolean))])])),
        note: `Ask which ${missing.join(" and ")} they want for ${title} in ${Object.values(pre).join(" / ")}, with tap choices — the card is for one exact variant.`,
      };
    }
    variant = found[0] || null;
  } else {
    variant = (product.variants || [])[0] || null;
  }

  const choice = pre ? Object.values(pre).join(" / ") : "";
  if (preselectAvailable(stock, pre)) {
    return {
      in_stock: true,
      title,
      ...(pre ? { options: pre } : {}),
      note: `${title}${choice ? ` in ${choice}` : ""} is in stock right now — no alert needed. Show it with show_products${pre ? " with their size in `options`" : ""} so Add to cart is ready.`,
    };
  }
  const alternatives = pre ? availableAlternatives(stock, pre) : [];
  const base = {
    in_stock: false,
    title,
    ...(pre ? { options: pre } : {}),
    ...(alternatives.length ? { in_stock_sizes: alternatives } : {}),
  };
  if (!variant?.id) {
    return {
      ...base,
      alert: "unavailable",
      note: `${title}${choice ? ` in ${choice}` : ""} is sold out right now, and an alert can't be set for it here. Say it's sold out, name what's in stock (\`in_stock_sizes\`) or another style, and don't promise a restock date.`,
    };
  }
  return {
    ...base,
    alert: "offered",
    note: `${title}${choice ? ` in ${choice}` : ""} is sold out right now. A Notify-me card is under your reply: they type their email there and the store emails them the moment it's back. Say it's sold out, name what's in stock (\`in_stock_sizes\`${alternatives.length ? "" : " — none in this one; offer another style"}), and point to the card in one short sentence (e.g. "pop your email in below and we'll email you the moment it's back"). Don't ask for their email in the chat, don't promise a date, and don't send them to customer service for this.`,
    _events: [{
      type: "restock_cta",
      handle: product.handle,
      title,
      image: product.image || "",
      variant: String(variant.id),
      choice,
    }],
  };
}

const WANTS_PERSON = /\b(human|real person|a person|an agent|representative|someone|somebody|talk to|speak (?:to|with)|call (?:you|someone)|phone number|manager)\b/i;

// Fact-check issues for a reply, when the store has alerts (the tool is
// available) and this reply didn't use it:
//  - the customer asked about a restock, and the reply hands them to
//    customer service or just closes the door (no question back to them);
//  - a size the reply picked for a card is sold out (show_products).
export function restockIssues({ latestUserMessage = "", text = "", supportOffered = false, called = [], available = [], soldOut = [] } = {}) {
  if (!available.includes(RESTOCK_TOOL) || called.includes(RESTOCK_TOOL)) return [];
  const msg = String(latestUserMessage || "");
  const issues = [];
  if (RESTOCK_ASK.test(msg) && !WANTS_PERSON.test(msg) && (supportOffered || !/\?/.test(String(text || "")))) {
    issues.push({
      code: "restock_not_checked",
      detail: `They're asking about a restock${supportOffered ? ", and you're sending them to customer service instead of checking" : ""}. Check it now with ${RESTOCK_TOOL} (the product's handle and the size they want): it says whether that size is in stock right now, and if not, puts a Notify-me card under your reply that emails them the moment it's back. Then say it's sold out (or in stock), name the sizes in stock, and point to the card — never a guessed date, and not customer service. If you don't know which product or size they mean, ask, with tap choices.`,
    });
  }
  if (soldOut.length) {
    issues.push({
      code: "restock_not_offered",
      detail: `${soldOut.map((s) => `${s.title} is sold out in ${Object.values(s.wanted || {}).join(" / ")}`).join("; ")} and the store has back-in-stock alerts: call ${RESTOCK_TOOL} for it (handle and those options) so a Notify-me card goes under your reply, then tell them they can get an email the moment it's back — besides the sizes in stock.`,
    });
  }
  return issues;
}

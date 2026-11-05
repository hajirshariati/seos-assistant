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

// The values the customer named that this product doesn't come in: a
// width this color has no variant of, a width on a style sold in one width,
// a size outside its run. resolvePreselect drops those on the quiet (a card
// can still be shown in the size alone); an alert can't — the customer
// asked for that exact variant, and there is none.
function missedValues(product, wanted, pre) {
  if (!wanted || typeof wanted !== "object") return [];
  const names = Object.keys(product?.options || {});
  return Object.entries(wanted).filter(([k, v]) => {
    const key = String(k).toLowerCase().trim();
    const val = String(v ?? "").trim();
    if (!val) return false;
    const name = names.find((n) => n.toLowerCase() === key);
    if (name) return !(pre && name in pre);
    return key === "width" || key === "size";
  }).map(([, v]) => String(v).trim());
}

// The chosen values, only when every size and width named is one the
// product comes in.
function resolveAll(product, wanted) {
  const pre = resolvePreselect(product, wanted);
  return pre && !missedValues(product, wanted, pre).length ? pre : null;
}

// The style's other colorways that come in the options asked for, and
// whether each has them in stock (the synced catalog's stock).
function colorwaysWith(siblings, wanted) {
  const out = [];
  for (const s of siblings || []) {
    const pre = s && resolveAll(s, wanted);
    if (!pre) continue;
    out.push({ handle: s.handle, title: s.title, in_stock: preselectAvailable(s.stock, pre) });
  }
  return out;
}

// The tool's answer for one product and the options the customer named.
// live: this product's in-stock option bags from the store right now (the
// lean engine's liveStock), or null → the synced catalog's stock.
// siblings: the same style's other colorways (a size one color doesn't
// come in may be carried, or sold out, in another).
export function restockCheck(product, options, live = null, siblings = []) {
  if (!product) return { error: "No product with that handle. Search first." };
  const title = product.title;
  const optionNames = Object.keys(product.options || {});
  const stock = Array.isArray(live) ? live : product.stock;
  const wanted = options && typeof options === "object" ? options : null;
  const pre = wanted ? resolvePreselect(product, wanted) : null;
  const missed = optionNames.length ? missedValues(product, wanted, pre) : [];

  if (optionNames.length && (!pre || missed.length)) {
    const named = pre ? missed : wanted ? Object.values(wanted).map((v) => String(v).trim()).filter(Boolean) : [];
    if (named.length) {
      const size = named.join(" / ");
      const others = colorwaysWith(siblings, wanted);
      const inStock = others.filter((o) => o.in_stock);
      const soldOut = others.filter((o) => !o.in_stock);
      const names = (list) => list.map((o) => o.title).join(", ");
      return {
        carried: false,
        title,
        comes_in: Object.fromEntries(optionNames.map((n) => [n, listed(product.options[n])])),
        ...(others.length ? { other_colors: others } : {}),
        note: `${title} doesn't come in ${size} — that isn't a size or width the store carries for this color, so it won't be restocked in it (no alert for it; never point to a card or an email box). ` +
          (others.length
            ? `The same style does come in ${size} in other colors (\`other_colors\`)${inStock.length ? ` — in stock now: ${names(inStock)}` : ""}${soldOut.length ? `${inStock.length ? ";" : " —"} sold out right now: ${names(soldOut)}` : ""}. Say so, ${inStock.length ? "show the in-stock ones with show_products with their size" : ""}${inStock.length && soldOut.length ? ", and " : ""}${soldOut.length ? `offer an email for a sold-out one by calling ${RESTOCK_TOOL} with that color's handle` : ""}. Never say the style doesn't come in ${size} — this color doesn't.`
            : `Say so plainly and offer the closest size it does come in (\`comes_in\`), or another style in their size.`),
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

// A reply pointing the customer to a Notify-me card, an email box or a
// sign-up form under it ("pop your email in below", "the notify-me card
// below", "enter your email in the box").
export const CARD_PROMISED = /\b(?:notify[- ]me (?:card|box|form|field|alert)|back[- ]in[- ]stock (?:card|box|form|field)|(?:card|box|form|field) (?:below|beneath|under(?:neath)?|here)|pop(?:ping)? your (?:e-?mail|address) (?:in|into)|(?:enter|type|drop|leave|put|add|submit) your (?:e-?mail(?: address)?|address) (?:in|into|below|here)|(?:e-?mail|sign[- ]up) (?:box|form|field)|(?:below|under(?:neath)?) (?:to|and) (?:get|be) (?:notified|emailed|alerted))\b/i;

// What the tool answered this turn, in a word, for the rewrite's note.
const CARD_WHY = {
  "not carried": "it said the size or width they want isn't one this product comes in, so there's no alert for it",
  unavailable: "it said an alert can't be set for that size here",
  "in stock": "it said that size is in stock right now",
  "needs options": "it asked which size they want first",
  error: "it didn't find the product",
};

// Fact-check issues for a reply, when the store has alerts (the tool is
// available):
//  - the reply points to a Notify-me card (an email box, a form) that isn't
//    there: the check wasn't run, or it answered that the size isn't carried
//    or can't be alerted — no card goes under the reply then;
// and, when this reply didn't use the tool:
//  - the customer asked about a restock, and the reply hands them to
//    customer service or just closes the door (no question back to them);
//  - a size the reply picked for a card is sold out (show_products).
export function restockIssues({ latestUserMessage = "", text = "", supportOffered = false, called = [], available = [], soldOut = [], cardShown = false, answers = [] } = {}) {
  if (!available.includes(RESTOCK_TOOL)) return [];
  const issues = [];
  if (!cardShown && CARD_PROMISED.test(String(text || ""))) {
    const ran = called.includes(RESTOCK_TOOL);
    const why = ran ? (answers.map((a) => CARD_WHY[a]).filter(Boolean).join("; ") || "it didn't offer one") : `you didn't run ${RESTOCK_TOOL} for that product and size`;
    issues.push({
      code: "restock_card_promised",
      detail: `You're pointing the customer to a Notify-me card (an email box) under your reply, but there is no card there — ${why}. A card is under your reply only when ${RESTOCK_TOOL} answers alert "offered". ${ran
        ? "Rewrite without any card, box or form: say plainly what the check found — a size or width it doesn't come in isn't going to be restocked in it, so say so and offer the closest size or width it does come in (`comes_in`), another color that has it (`other_colors`), or another style — and never ask for their email in the chat."
        : `Run ${RESTOCK_TOOL} first (the handle and their size): if it answers alert "offered", point to the card; if it says the size isn't carried or can't be alerted, say so plainly with no card and offer what it does come in.`}`,
    });
  }
  if (called.includes(RESTOCK_TOOL)) return issues;
  const msg = String(latestUserMessage || "");
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

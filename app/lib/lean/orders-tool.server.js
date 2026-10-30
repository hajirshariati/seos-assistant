// "Where's my order?" / "I want to return…" in the chat. Signed-in shoppers
// get their orders as clean cards (status, progress, items, tracking) with a
// "Return an item" button that runs the return in the chat. Signed-out
// shoppers get a card with two ways in: sign in (Shopify's own sign-in, in a
// small window; the chat continues once they're signed in), or look one
// order up with its number and email — that form goes straight to the store
// (routes/order-lookup.jsx), never through the AI, and shows status only.

import { getOrderCards, returnPolicy } from "../orders.server.js";
import { publicReturnMethods } from "../returns.server.js";

const IN_CHAT_RETURNS =
    "For returns and exchanges, tell them to tap \"Return an item\" on the order — the chat walks them through it (items, reason, how to send it back, refund or a different size). " +
    "If a return was already started (return_started_in_chat), say so and point to the card, which shows the return number, label and drop-off steps; never start a second one. Never promise a refund amount or timing.";
// The store has returns in the chat turned off: the card's button opens the
// store's returns page with the order filled in.
const PAGE_RETURNS =
    "Returns and exchanges aren't started in this chat: tell them to tap \"Start a return\" on the order, which opens the store's returns page with their order filled in (exchanges are chosen there too). " +
    "If there's no such button (has_returns_page false), point them to customer service. Never promise a refund amount or timing.";

// The store's tracking / returns page, when it's a real https link.
function httpsUrl(u) {
  const s = String(u || "").trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : "";
}

export const ORDERS_TOOL = {
  name: "get_my_orders",
  description:
    "The customer's own orders: status, delivery progress, tracking, and the button to start a return or exchange. Use for where is my order, tracking, delivery, an order number, past purchases, or wanting to return or exchange something they bought. " +
    "The orders appear as cards under your reply — keep your reply to one short sentence and don't repeat what the cards show (numbers, dates, tracking). " +
    "If the customer isn't signed in, a card appears instead where they can sign in, look up the order with its order number (or confirmation code) and the email they used, or open the store's tracking page or returns center: point them to it in one sentence. Never ask them to type their email or order details into the chat. " +
    "Tracking an order and starting a return are handled by these cards and the store's own pages — don't send them to customer service for that unless they've tried and are still stuck, or ask for a person. " +
    "For a question about a return they've made or what happened after it — where a return stands, their return credit or refund, how much, when, were points or a discount given back — use intent \"refunds\": it looks further back and lists each order with a return or refund, with each return's days (requested, approved, closed), its status and shipment tracking, the refund's status, amount and date, and the discount codes used (facts for you; the cards don't show them). Answer from those with the store's refund timing (search_store_info) before any hand-off. " +
    IN_CHAT_RETURNS,

  input_schema: {
    type: "object",
    properties: {
      orderNumber: { type: "string", description: "A specific order number the customer mentioned, e.g. '1171674' or '#1171674'." },
      intent: { type: "string", enum: ["track", "return", "refunds"], description: "track (default); return, when they want to return or exchange something; refunds, when they ask what happened after a return (refund, amount, date, points or discounts given back)." },
    },
  },
};

export function ordersTool({ shop, accessToken, loggedInCustomerId, trackingPageUrl = "", returnsPageUrl = "", returnsInChat = true, guestLookup = true, policy = returnPolicy() }) {
  // Which orders get the return button, in words, for the model.
  const rule = [policy.deliveredOnly ? "delivered" : "shipped", policy.windowDays > 0 ? `within ${policy.windowDays} days of ordering` : ""].filter(Boolean).join(", ");
  return {
    definition: returnsInChat ? ORDERS_TOOL : { ...ORDERS_TOOL, description: ORDERS_TOOL.description.replace(IN_CHAT_RETURNS, PAGE_RETURNS) },
    run: async (input = {}) => {
      const refundsAsked = input.intent === "refunds";
      // The sign-in card and the cards themselves know track and return.
      const intent = input.intent === "return" ? "return" : "track";
      if (!loggedInCustomerId) {
        // The order number they mentioned fills in the lookup form (never an email).
        const hint = String(input.orderNumber || "").replace(/\s+/g, "").replace(/^#+/, "");
        // The store's own pages, always offered beside the chat's way.
        const pages = { ...(httpsUrl(trackingPageUrl) ? { track: httpsUrl(trackingPageUrl) } : {}), ...(httpsUrl(returnsPageUrl) ? { returns: httpsUrl(returnsPageUrl) } : {}) };
        const offPage = [pages.track ? "the store's tracking page" : "", pages.returns ? "the returns center" : ""].filter(Boolean).join(" and ");
        return {
          signed_in: false,
          note: (guestLookup
            ? (intent === "return"
              ? "A card under your reply lets them sign in to start a return here (returns in the chat need sign-in), or look up the order's status with its number and email."
              : "A card under your reply lets them sign in, or look up the order with its order number (or confirmation code) and the email they used.")
            : "A sign-in button is shown under your reply; once they sign in, the chat continues with their orders.") +
            (offPage ? ` It also links to ${offPage}, if they'd rather use those.` : "") +
            " Point them to it in one sentence. Don't ask for their email or order details in the chat, and don't send them to customer service for this.",
          _events: [{ type: "login_prompt", intent, ...(guestLookup ? { lookup: true, ...(/^[a-z0-9-]{3,24}$/i.test(hint) ? { order: hint } : {}) } : {}), ...(Object.keys(pages).length ? { pages } : {}) }],
        };
      }
      if (!accessToken) return { error: "Orders aren't available right now." };
      let { orders, numberOfOrders = 0 } = await getOrderCards({ shop, accessToken, customerId: loggedInCustomerId, first: refundsAsked ? 25 : 5, orderNumber: input.orderNumber || "", trackingBase: trackingPageUrl, returnsBase: returnsPageUrl, policy });
      // Returns and refunds: only the orders that had one (unless they named one).
      const recent = orders.length;
      if (refundsAsked && !input.orderNumber) orders = orders.filter((o) => o.refund || o.returnStatus || o.returns?.length || o.returnFacts);
      // Returns in the chat turned off: the card's button opens the returns page.
      if (!returnsInChat) for (const o of orders) o.returnMode = "page";
      if (!orders.length) {
        if (refundsAsked && recent) return { signed_in: true, orders: [], note: `None of their last ${recent} orders has a return or refund on record. Say so plainly; if they returned something recently, it may not be processed yet — the store's info says how long refunds take (search_store_info).` };
        // The account counts orders the chat can't list: the store's app
        // access stops at orders from the last 60 days.
        if (!recent && numberOfOrders > 0) {
          return {
            signed_in: true,
            orders: [],
            orders_on_account: numberOfOrders,
            note: `Their account has ${numberOfOrders} order${numberOfOrders === 1 ? "" : "s"} on record, but none from the last 60 days — older orders aren't visible to this chat. Say that plainly (their older orders aren't visible here — never that they have no orders), point them to their account's order history on the store's site for those, and offer customer service for anything about them${refundsAsked ? "; for how long refunds take after a return, use the store's info (search_store_info)" : ""}.`,
          };
        }
        return { signed_in: true, orders: [], note: input.orderNumber ? "No order with that number on this account. Ask them to check the number, or point to customer service." : "No orders on this account yet." };
      }
      // What the model sees: the gist only. The cards carry the details.
      const summary = orders.map((o) => ({
        number: o.number, date: o.date, status: o.stageLabel, eta: o.eta || undefined, delivered: o.deliveredAt || undefined,
        return_status: o.returnStatus || undefined, can_return: o.canReturn,
        return_started_in_chat: o.returns?.length ? o.returns.map((r) => ({ rma: r.rma || undefined, on: r.date, how: r.method?.label || undefined, exchange: r.exchange || undefined })) : undefined,
        why_no_return: o.canReturn ? undefined : { not_delivered: "not delivered yet — returns open once it arrives", not_shipped: "not shipped yet — returns open once it ships", window_closed: `past the ${policy.windowDays}-day return window`, cancelled: "cancelled", nothing_left: "everything in it is already being returned" }[o.returnBlocked],
        has_returns_page: returnsInChat ? undefined : Boolean(o.returnsUrl),
        // Each return the store's records hold: requested/approved/closed
        // days, where it stands, the return shipment's tracking.
        returns_on_record: o.returnFacts || undefined,
        refund: o.refund || undefined,
        discount_codes: o.discountCodes?.length ? o.discountCodes : undefined,
        items: o.items.map((i) => i.title).slice(0, 4),
      }));
      // The cards carry no payment facts.
      const cards = orders.map((o) => { const card = { ...o }; delete card.refund; delete card.returnFacts; delete card.discountCodes; return card; });
      const hasReturn = orders.some((o) => o.returnFacts);
      return {
        signed_in: true,
        orders: summary,
        note: refundsAsked
          ? "The orders with a return or refund are shown as cards under your reply. Answer from these facts: each return on record (returns_on_record — the day it was requested and approved, whether it's still open or closed, the return shipment's tracking link), the refund (refund — status, amount, date) and any discount codes used. " +
            "For a return that's still open, say where it stands from those days, give the tracking link so they can see where the package is, and say how long the store says a refund takes once the return arrives (search_store_info) — counted from these dates, never a guess. For a closed one, name the refund's date and amount. " +
            "Say plainly what the records don't show (the chat can't see a carrier's drop-off scan — only the tracking link) — never guess an amount, a date or what happened to points, and don't hand this to customer service while these facts answer it."
          : hasReturn
          ? "The order cards are shown under your reply. One or more orders have a return on record (returns_on_record: requested/approved/closed days, status, the return shipment's tracking); if they ask about a return or refund, answer from those facts and the refund field, with the store's refund timing from search_store_info."
          : intent === "return" && !returnsInChat
          ? `The order cards are shown with a "Start a return" button on returnable orders (${rule}) that opens the returns page with the order filled in. Tell them to tap it; if none can be returned, say why in one sentence (why_no_return).`
          : intent === "return"
          ? `The order cards are shown with a "Return an item" button on returnable orders (${rule}). Tell them to tap it on the order they want to return; if none can be returned, say why in one sentence (why_no_return).`
          : "The order cards are shown under your reply.",
        _events: [{ type: "order_cards", intent, orders: cards, returnMethods: returnsInChat ? publicReturnMethods() : [] }],
      };
    },
  };
}

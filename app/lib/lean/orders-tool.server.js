// "Where's my order?" / "I want to return…" in the chat. Signed-in shoppers
// get their orders as clean cards (status, progress, items, tracking) with a
// "Return an item" button that runs the return in the chat. Signed-out
// shoppers get a sign-in card (Shopify's own sign-in, in a small window);
// the chat continues once they're signed in. Order details never go to
// anyone Shopify hasn't signed in as that customer.

import { getOrderCards } from "../orders.server.js";

export const ORDERS_TOOL = {
  name: "get_my_orders",
  description:
    "The customer's own orders: status, delivery progress, tracking, and the button to start a return or exchange. Use for where is my order, tracking, delivery, an order number, past purchases, or wanting to return or exchange something they bought. " +
    "The orders appear as cards under your reply — keep your reply to one short sentence and don't repeat what the cards show (numbers, dates, tracking). " +
    "If the customer isn't signed in, a sign-in button appears instead: say in one sentence that they need to sign in to see their orders. " +
    "For returns and exchanges, tell them to tap \"Return an item\" on the order — the chat walks them through it (items, reason, refund or a different size). Never promise a refund amount or timing.",
  input_schema: {
    type: "object",
    properties: {
      orderNumber: { type: "string", description: "A specific order number the customer mentioned, e.g. '1171674' or '#1171674'." },
      intent: { type: "string", enum: ["track", "return"], description: "track (default) or return, when they want to return or exchange something." },
    },
  },
};

export function ordersTool({ shop, accessToken, loggedInCustomerId, trackingPageUrl = "" }) {
  return {
    definition: ORDERS_TOOL,
    run: async (input = {}) => {
      const intent = input.intent === "return" ? "return" : "track";
      if (!loggedInCustomerId) {
        return {
          signed_in: false,
          note: "A sign-in button is shown under your reply. Once they sign in, the chat continues with their orders.",
          _events: [{ type: "login_prompt", intent }],
        };
      }
      if (!accessToken) return { error: "Orders aren't available right now." };
      const { orders } = await getOrderCards({ shop, accessToken, customerId: loggedInCustomerId, first: 5, orderNumber: input.orderNumber || "", trackingBase: trackingPageUrl });
      if (!orders.length) {
        return { signed_in: true, orders: [], note: input.orderNumber ? "No order with that number on this account. Ask them to check the number, or point to customer service." : "No orders on this account yet." };
      }
      // What the model sees: the gist only. The cards carry the details.
      const summary = orders.map((o) => ({
        number: o.number, date: o.date, status: o.stageLabel, eta: o.eta || undefined, delivered: o.deliveredAt || undefined,
        return_status: o.returnStatus || undefined, can_return: o.canReturn, items: o.items.map((i) => i.title).slice(0, 4),
      }));
      return {
        signed_in: true,
        orders: summary,
        note: intent === "return"
          ? "The order cards are shown with a \"Return an item\" button on returnable orders. Tell them to tap it on the order they want to return."
          : "The order cards are shown under your reply.",
        _events: [{ type: "order_cards", intent, orders }],
      };
    },
  };
}

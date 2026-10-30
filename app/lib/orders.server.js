// A signed-in shopper's orders, shaped for the chat's order cards and the
// in-chat return flow. Live from the Shopify Admin API; the only thing kept
// is a note of returns started in the chat (order and line ids, ChatReturn).
//
// Only ever called for the customer Shopify signed into the request (the app
// proxy's logged_in_customer_id, HMAC-verified), and every order is checked
// to belong to that customer before anything is shown or returned.

import { ADMIN_API_VERSION } from "./admin-api-version.js";
import { findChatReturns } from "../models/ChatReturn.server.js";

export const ORDER_FIELDS = `
  id
  name
  createdAt
  cancelledAt
  displayFulfillmentStatus
  displayFinancialStatus
  returnStatus
  discountCodes
  totalRefundedSet { shopMoney { amount currencyCode } }
  refunds(first: 5) { createdAt totalRefundedSet { shopMoney { amount currencyCode } } }
  customer { id }
  lineItems(first: 20) {
    nodes {
      id
      title
      quantity
      refundableQuantity
      image { url(transform: { maxWidth: 160 }) }
      variant { selectedOptions { name value } product { handle } }
    }
  }
  fulfillments(first: 5) {
    createdAt
    deliveredAt
    estimatedDeliveryAt
    displayStatus
    trackingInfo { company number url }
  }
`;

const CUSTOMER_ORDERS_QUERY = `
  query ChatOrders($id: ID!, $first: Int!) {
    customer(id: $id) {
      email
      orders(first: $first, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } }
    }
  }
`;

const ORDER_QUERY = `
  query ChatOrder($id: ID!) {
    order(id: $id) { ${ORDER_FIELDS} email }
  }
`;

export async function adminGraphql({ shop, accessToken, query, variables, timeoutMs = 7000 }) {
  const res = await fetch(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Admin API ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`Admin API: ${json.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
  return json.data;
}

const numericId = (gid) => String(gid || "").match(/(\d+)$/)?.[1] || "";
const day = (iso) => (iso ? String(iso).slice(0, 10) : "");

// Where the order is, in the four steps the card shows.
const STAGES = ["ordered", "shipped", "out_for_delivery", "delivered"];
export function orderStage(o) {
  if (o.cancelledAt) return "cancelled";
  const f = o.fulfillments || [];
  const statuses = f.map((x) => String(x.displayStatus || "").toUpperCase());
  if (f.some((x) => x.deliveredAt) || statuses.includes("DELIVERED")) return "delivered";
  if (statuses.includes("OUT_FOR_DELIVERY")) return "out_for_delivery";
  if (statuses.includes("ATTEMPTED_DELIVERY")) return "out_for_delivery";
  if (f.length || /^(FULFILLED|PARTIALLY_FULFILLED)$/i.test(o.displayFulfillmentStatus || "")) return "shipped"; // not UNFULFILLED
  return "ordered";
}
const STAGE_LABEL = {
  ordered: "Processing",
  shipped: "On its way",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};
const RETURN_LABEL = {
  RETURN_REQUESTED: "Return requested",
  IN_PROGRESS: "Return in progress",
  INSPECTION_COMPLETE: "Return received",
  RETURNED: "Returned",
  RETURN_FAILED: "Return issue",
};

// The store's return rules for the chat (Settings → Returns): how many days
// after the order is placed a return can start (0 = no limit), and whether
// it has to be delivered first (otherwise shipped is enough).
export function returnPolicy(config = {}) {
  const set = Number.parseInt(config?.returnWindowDays, 10);
  const env = Number.parseInt(process.env.RETURN_WINDOW_DAYS, 10);
  const days = Number.isFinite(set) ? set : Number.isFinite(env) ? env : 30;
  return { windowDays: Math.min(Math.max(days, 0), 365), deliveredOnly: config?.returnsDeliveredOnly !== false };
}

// Why the chat won't start a return ("" when it will).
export function returnBlock(o, stage, items, now = Date.now(), policy = returnPolicy()) {
  if (o.cancelledAt) return "cancelled";
  if (!items.some((i) => i.returnable > 0)) return "nothing_left";
  if (policy.deliveredOnly && stage !== "delivered") return "not_delivered";
  if (stage === "ordered") return "not_shipped";
  const placed = Date.parse(o.createdAt || "");
  if (policy.windowDays > 0 && Number.isFinite(placed) && now - placed > policy.windowDays * 864e5) return "window_closed";
  return "";
}

// What was refunded on an order (for the assistant, not the card): the
// payment status in words, the total, and each refund's day and amount.
const REFUND_LABEL = { REFUNDED: "Refunded", PARTIALLY_REFUNDED: "Partly refunded", VOIDED: "Voided" };
function money(set) {
  const a = Number.parseFloat(set?.shopMoney?.amount);
  if (!Number.isFinite(a) || a <= 0) return "";
  const cur = set.shopMoney.currencyCode || "USD";
  return cur === "USD" ? `$${a.toFixed(2)}` : `${a.toFixed(2)} ${cur}`;
}
export function refundFacts(o) {
  const refunds = (o?.refunds || []).map((r) => ({ on: day(r.createdAt), amount: money(r.totalRefundedSet) })).filter((r) => r.on && r.amount);
  const total = money(o?.totalRefundedSet);
  const status = REFUND_LABEL[o?.displayFinancialStatus] || "";
  if (!refunds.length && !total && !status) return null;
  return { status: status || "Refunded", total: total || undefined, refunds: refunds.length ? refunds : undefined };
}

// The card for one order: no addresses, no payment details, no email.
// A return the chat already started for this order, as the card shows it.
export function chatReturnView(r) {
  return {
    rma: r.rma || "",
    labelUrl: r.labelUrl || "",
    method: { key: r.methodKey || "", label: r.methodLabel || "", findUrl: r.findUrl || "" },
    exchange: Boolean(r.exchange),
    date: day(r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt),
    lineIds: (r.lineIds || []).map(String),
    // The new-size cards of an exchange, so they can be shown again if the
    // shopper lost them (connection dropped, chat cleared).
    exchangeCards: Array.isArray(r.exchangeCards) ? r.exchangeCards : [],
  };
}

// The store's returns page, prefilled with the order (as AfterShip expects).
export function returnsPageLink(base, number, email) {
  const b = String(base || "").replace(/\/+$/, "");
  if (!b) return "";
  return number && email ? `${b}?order-number=${encodeURIComponent(number)}&email=${encodeURIComponent(email)}` : b;
}

export function toOrderCard(o, { trackingBase = "", returnsBase = "", email = "", now = Date.now(), chatReturns = [], policy = returnPolicy() } = {}) {
  const stage = orderStage(o);
  const fulfillments = o.fulfillments || [];
  const latest = [...fulfillments].reverse().find((f) => (f.trackingInfo || []).length) || fulfillments[fulfillments.length - 1] || null;
  const tracking = (latest?.trackingInfo || [])[0] || null;
  const number = String(o.name || "").replace(/^#/, "");
  let trackUrl = tracking?.url || "";
  const base = String(trackingBase || "").replace(/\/+$/, "");
  if (base && number && email) trackUrl = `${base}?order-number=${encodeURIComponent(number)}&email=${encodeURIComponent(email)}`;
  else if (base && tracking?.number) trackUrl = `${base}/tracking/${encodeURIComponent(tracking.number)}`;
  // Units already in a return started in the chat (Shopify only lowers
  // refundableQuantity once the refund is issued).
  const inChatReturn = {};
  for (const r of chatReturns) for (const id of r.lineIds || []) inChatReturn[id] = (inChatReturn[id] || 0) + 1;
  const items = (o.lineItems?.nodes || []).map((li) => {
    const opts = {};
    for (const so of li.variant?.selectedOptions || []) if (so?.name && so.value && so.value !== "Default Title") opts[so.name] = so.value;
    return {
      lineId: numericId(li.id),
      title: String(li.title || "").slice(0, 120),
      options: opts,
      image: li.image?.url || "",
      quantity: li.quantity || 1,
      returnable: Math.max(0, (li.refundableQuantity ?? 0) - (inChatReturn[numericId(li.id)] || 0)),
      handle: li.variant?.product?.handle || "",
    };
  });
  const returnStatus = RETURN_LABEL[o.returnStatus] || "";
  const blocked = returnBlock(o, stage, items, now, policy);
  return {
    id: numericId(o.id),
    number,
    date: day(o.createdAt),
    stage,
    stageLabel: STAGE_LABEL[stage],
    step: Math.max(0, STAGES.indexOf(stage)),
    shippedAt: day(fulfillments[0]?.createdAt),
    deliveredAt: day(fulfillments.find((f) => f.deliveredAt)?.deliveredAt),
    eta: stage === "delivered" ? "" : day(latest?.estimatedDeliveryAt),
    carrier: tracking?.company || "",
    trackUrl,
    returnStatus,
    returnsUrl: returnsPageLink(returnsBase, number, email || o.email || ""),
    returns: chatReturns.map(chatReturnView),
    // AfterShip still applies the store's own policy (final sale…) on top.
    canReturn: !blocked,
    returnBlocked: blocked,
    items,
    // For the assistant only (the order tool takes these off the card).
    refund: refundFacts(o),
    discountCodes: (o.discountCodes || []).map(String).slice(0, 5),
  };
}

// The signed-in customer's recent orders as cards (and their email, kept
// server-side for prefilled tracking/return links). `first` up to 25 (an
// order number, or returns and refunds, look further back).
export async function getOrderCards({ shop, accessToken, customerId, first = 5, orderNumber = "", trackingBase = "", returnsBase = "", policy = returnPolicy(), lookupReturns = findChatReturns }) {
  const data = await adminGraphql({
    shop, accessToken, query: CUSTOMER_ORDERS_QUERY,
    variables: { id: `gid://shopify/Customer/${customerId}`, first: orderNumber ? 25 : Math.min(Math.max(first, 1), 25) },
  });
  const customer = data?.customer;
  if (!customer) return { orders: [] };
  console.log(`[pii-access] shop=${shop} customer=${customerId} fields=orders purpose=customer_service source=admin_api`);
  let nodes = customer.orders?.nodes || [];
  const want = String(orderNumber || "").replace(/[^0-9a-z]/gi, "").toLowerCase();
  if (want) nodes = nodes.filter((o) => String(o.name || "").replace(/[^0-9a-z]/gi, "").toLowerCase().endsWith(want));
  const started = await lookupReturns(shop, nodes.map((o) => numericId(o.id)));
  const forOrder = (o) => started.filter((r) => r.orderId === numericId(o.id));
  return { orders: nodes.map((o) => toOrderCard(o, { trackingBase, returnsBase, email: customer.email || "", chatReturns: forOrder(o), policy })) };
}

// The signed-in customer's email (for their rewards account), never shown.
export async function getCustomerEmail({ shop, accessToken, customerId }) {
  if (!customerId || !accessToken) return "";
  const data = await adminGraphql({ shop, accessToken, query: `query ChatCustomerEmail($id: ID!) { customer(id: $id) { email } }`, variables: { id: `gid://shopify/Customer/${customerId}` } });
  const email = String(data?.customer?.email || "").trim();
  if (email) console.log(`[pii-access] shop=${shop} customer=${customerId} fields=email purpose=rewards_lookup source=admin_api`);
  return email;
}

// One order, only if it belongs to this customer (for starting a return).
export async function getOwnedOrder({ shop, accessToken, customerId, orderId }) {
  const id = String(orderId || "").replace(/\D/g, "");
  if (!id) return null;
  const data = await adminGraphql({ shop, accessToken, query: ORDER_QUERY, variables: { id: `gid://shopify/Order/${id}` } });
  const o = data?.order;
  if (!o || numericId(o.customer?.id) !== String(customerId)) return null;
  return o;
}

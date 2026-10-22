// Orders & returns in the chat: order cards (status, progress, privacy),
// ownership of the order, the next size for an exchange, the AfterShip
// request, and the chat tool for signed-out and signed-in shoppers.
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://x@localhost:1/none";
const { toOrderCard, orderStage, getOwnedOrder } = await import("../app/lib/orders.server.js");
const { nextOption, createAftershipReturn, reasonByKey, aftershipReasonName, returnMethods } = await import("../app/lib/returns.server.js");
const { ordersTool } = await import("../app/lib/lean/orders-tool.server.js");

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); }
};
const order = (over = {}) => ({
  id: "gid://shopify/Order/5001", name: "#1171674", createdAt: "2026-10-14T10:00:00Z", cancelledAt: null,
  displayFulfillmentStatus: "FULFILLED", returnStatus: "NO_RETURN", customer: { id: "gid://shopify/Customer/77" },
  lineItems: { nodes: [{ id: "gid://shopify/LineItem/9001", title: "Savannah Sandal - Red", quantity: 1, refundableQuantity: 1, image: { url: "https://cdn/x.jpg" }, variant: { selectedOptions: [{ name: "Size", value: "8 US" }, { name: "Width", value: "Medium" }], product: { handle: "savannah-red" } } }] },
  fulfillments: [{ createdAt: "2026-10-15T10:00:00Z", deliveredAt: null, estimatedDeliveryAt: "2026-10-18T10:00:00Z", displayStatus: "IN_TRANSIT", trackingInfo: [{ company: "UPS", number: "1Z9", url: "https://ups/1Z9" }] }],
  ...over,
});

await test("status: processing, on its way, out for delivery, delivered, cancelled", () => {
  assert.equal(orderStage(order({ fulfillments: [], displayFulfillmentStatus: "UNFULFILLED" })), "ordered");
  assert.equal(orderStage(order()), "shipped");
  assert.equal(orderStage(order({ fulfillments: [{ ...order().fulfillments[0], displayStatus: "OUT_FOR_DELIVERY" }] })), "out_for_delivery");
  assert.equal(orderStage(order({ fulfillments: [{ ...order().fulfillments[0], deliveredAt: "2026-10-17T10:00:00Z" }] })), "delivered");
  assert.equal(orderStage(order({ cancelledAt: "2026-10-14T11:00:00Z" })), "cancelled");
});
await test("card: number, date, step, eta, carrier, items with size; no email or address", () => {
  const c = toOrderCard(order());
  assert.equal(c.number, "1171674"); assert.equal(c.id, "5001"); assert.equal(c.step, 1); assert.equal(c.eta, "2026-10-18"); assert.equal(c.carrier, "UPS");
  assert.deepEqual(c.items[0].options, { Size: "8 US", Width: "Medium" }); assert.equal(c.items[0].lineId, "9001"); assert.equal(c.items[0].handle, "savannah-red");
  assert.ok(!JSON.stringify(c).includes("@"));
  assert.equal(c.trackUrl, "https://ups/1Z9");
});
await test("card: the store's tracking page, prefilled, when set", () => {
  const c = toOrderCard(order(), { trackingBase: "https://aetrex.aftership.com/", email: "jo@x.com" });
  assert.equal(c.trackUrl, "https://aetrex.aftership.com?order-number=1171674&email=jo%40x.com");
});
const delivered = (over = {}) => order({ fulfillments: [{ ...order().fulfillments[0], deliveredAt: "2026-10-17T10:00:00Z" }], ...over });
const NOW = Date.parse("2026-10-22T12:00:00Z");
await test("returns: only delivered orders, within 30 days of ordering, with items left", () => {
  assert.equal(toOrderCard(delivered(), { now: NOW }).canReturn, true);
  assert.equal(toOrderCard(order(), { now: NOW }).canReturn, false, "on its way");
  assert.equal(toOrderCard(order(), { now: NOW }).returnBlocked, "not_delivered");
  assert.equal(toOrderCard(order({ fulfillments: [], displayFulfillmentStatus: "UNFULFILLED" }), { now: NOW }).canReturn, false);
  assert.equal(toOrderCard(delivered({ cancelledAt: "2026-10-14T11:00:00Z" }), { now: NOW }).canReturn, false);
  assert.equal(toOrderCard(delivered({ lineItems: { nodes: [{ ...order().lineItems.nodes[0], refundableQuantity: 0 }] } }), { now: NOW }).canReturn, false);
  // Placed Oct 14: day 30 still open, day 31 closed.
  assert.equal(toOrderCard(delivered(), { now: Date.parse("2026-11-13T09:00:00Z") }).canReturn, true);
  const late = toOrderCard(delivered(), { now: Date.parse("2026-11-14T11:00:00Z") });
  assert.equal(late.canReturn, false); assert.equal(late.returnBlocked, "window_closed");
});
await test("return window: RETURN_WINDOW_DAYS changes it", () => {
  process.env.RETURN_WINDOW_DAYS = "7";
  try { assert.equal(toOrderCard(delivered(), { now: Date.parse("2026-10-20T12:00:00Z") }).canReturn, true); assert.equal(toOrderCard(delivered(), { now: NOW }).canReturn, false, "8 days > 7"); }
  finally { delete process.env.RETURN_WINDOW_DAYS; }
});
await test("return methods: the store's list, cleaned; one default without it", () => {
  const env = JSON.stringify([
    { key: "happy_returns", type: "happy_returns", label: "Drop off at any Happy Returns location", detail: "No box or label needed.", fee: "$5.95", findUrl: "https://locations.happyreturns.com/" },
    { key: "usps", type: "retailer_label", label: "USPS drop-off", fee: "$5.95", findUrl: "javascript:alert(1)" },
    { key: "usps", type: "x", label: "dupe" }, { key: "bad" },
  ]);
  const m = returnMethods(env);
  assert.deepEqual(m.map((x) => x.key), ["happy_returns", "usps"]);
  assert.equal(m[0].findUrl, "https://locations.happyreturns.com/"); assert.equal(m[1].findUrl, "", "only https links");
  assert.equal(returnMethods("nope").length, 1); assert.equal(returnMethods(undefined)[0].type, "retailer_label");
});
await test("AfterShip: the chosen method's type is sent", async () => {
  let b = null;
  await createAftershipReturn({ apiKey: "k", shop: "a.myshopify.com", order: { id: "1" }, items: [{ lineId: "2", quantity: 1 }], reasonLabel: "Other", methodType: "happy_returns", fetchImpl: async (u, i) => { b = JSON.parse(i.body); return new Response("{}", { status: 201 }); } });
  assert.deepEqual(b.return_method, { type: "happy_returns" });
});
await test("a return only works on the shopper's own order", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { order: { ...order(), email: "jo@x.com" } } }), { status: 200 });
  try {
    assert.ok(await getOwnedOrder({ shop: "s.myshopify.com", accessToken: "t", customerId: "77", orderId: "5001" }));
    assert.equal(await getOwnedOrder({ shop: "s.myshopify.com", accessToken: "t", customerId: "78", orderId: "5001" }), null, "someone else's order");
    assert.equal(await getOwnedOrder({ shop: "s.myshopify.com", accessToken: "t", customerId: "77", orderId: "abc" }), null);
  } finally { globalThis.fetch = realFetch; }
});
await test("exchange: the next size up or down, the next width, in store order", () => {
  const sizes = ["8.5 US", "8 US", "10 US", "9 US", "9.5 US"];
  assert.equal(nextOption(sizes, "8 US", "size", 1), "8.5 US");
  assert.equal(nextOption(sizes, "9 US", "size", -1), "8.5 US");
  assert.equal(nextOption(sizes, "10 US", "size", 1), null, "no bigger size");
  assert.equal(nextOption(["8 - 8.5 US", "9 - 9.5 US", "10 - 10.5 US"], "9 - 9.5 US", "size", 1), "10 - 10.5 US");
  assert.equal(nextOption(["Wide", "Medium"], "Medium", "width", 1), "Wide");
  assert.equal(nextOption(["D", "EE", "B", "E"], "D", "width", 1), "E");
  assert.equal(nextOption(["D", "EE", "B", "E"], "D", "width", -1), "B");
});
await test("AfterShip: a refund return for the order's items, keyed by the store's ids", async () => {
  let sent = null;
  const fetchImpl = async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ data: { id: "r1", rma_number: "RMA77" } }), { status: 201 }); };
  const r = await createAftershipReturn({ apiKey: "k", shop: "aetrex.myshopify.com", order: { id: "gid://shopify/Order/5001" }, items: [{ lineId: "9001", quantity: 1 }], reasonLabel: "Too small", comment: "", fetchImpl });
  const b = JSON.parse(sent.init.body);
  assert.match(sent.url, /^https:\/\/api\.aftership\.com\/returns\/[\d-]+\/returns$/);
  assert.equal(sent.init.headers["as-api-key"], "k");
  assert.equal(b.order.external_id, "5001");
  // AfterShip's 422 named these: order.store, top-level return_method and refund_destination.
  assert.deepEqual(b.order.store, { platform: "shopify", external_id: "aetrex" });
  assert.deepEqual(b.return_method, { type: "retailer_label" });
  assert.equal(b.refund_destination, "original_payment");
  assert.deepEqual(b.return_items[0], { external_order_item_id: "9001", intended_return_quantity: 1, return_reason: "Too small", resolution: "refund" });
  assert.ok(r.ok && r.rma === "RMA77");
});
await test("AfterShip 422 (e.g. unknown reason): not retried; AfterShip's message kept", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ meta: { code: 42200, message: "return reason is not found in the matched return reason group" } }), { status: 422 }); };
  const r = await createAftershipReturn({ apiKey: "k", shop: "aetrex.myshopify.com", order: { id: "5001" }, items: [{ lineId: "9001", quantity: 1 }], reasonLabel: "Other", fetchImpl });
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].order.store, { platform: "shopify", external_id: "aetrex" });
  assert.equal(r.status, 422); assert.match(r.error, /return reason is not found/);
});
await test("AfterShip refuses comments for this reason → sent again without the comment", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => { const b = JSON.parse(init.body); bodies.push(b); return b.return_items[0].return_reason_comment
    ? new Response(JSON.stringify({ meta: { code: 42200, message: "comments are not allowed in the return reason" } }), { status: 422 })
    : new Response(JSON.stringify({ data: { return: { id: "r5", rma_number: "RMA5" } } }), { status: 201 }); };
  const r = await createAftershipReturn({ apiKey: "k", shop: "aetrex.myshopify.com", order: { id: "5001" }, items: [{ lineId: "9001", quantity: 1 }], reasonLabel: "Too Small", comment: "Exchanging for another size", fetchImpl });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].return_items[0].return_reason_comment, undefined);
  assert.ok(r.ok && r.rma === "RMA5");
});
await test("reason names: the store's own AfterShip names when mapped, our label otherwise", () => {
  const env = JSON.stringify({ too_small: "Too Small - Need a bigger size", other: "  " });
  assert.equal(aftershipReasonName("too_small", env), "Too Small - Need a bigger size");
  assert.equal(aftershipReasonName("other", env), "Other", "blank entry falls back");
  assert.equal(aftershipReasonName("damaged", env), "Damaged or defective");
  assert.equal(aftershipReasonName("too_small", "not json"), "Too small");
  assert.equal(aftershipReasonName("too_small", undefined), "Too small");
});
await test("AfterShip 404 'Order not found': retried with the full store domain", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return bodies.length === 1
    ? new Response(JSON.stringify({ meta: { code: 40400, message: "Order not found" } }), { status: 404 })
    : new Response(JSON.stringify({ data: { return: { id: "r9", rma_number: "RMA9" } } }), { status: 201 }); };
  const r = await createAftershipReturn({ apiKey: "k", shop: "aetrex.myshopify.com", order: { id: "5001" }, items: [{ lineId: "9001", quantity: 1 }], reasonLabel: "Other", fetchImpl });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].order.store.external_id, "aetrex.myshopify.com");
  assert.ok(r.ok && r.rma === "RMA9");
});
await test("AfterShip: never asks for store credit", async () => {
  let b = null;
  await createAftershipReturn({ apiKey: "k", order: { id: "1" }, items: [{ lineId: "2", quantity: 1 }], reasonLabel: "Other", refundTo: "store_credit", fetchImpl: async (u, i) => { b = JSON.parse(i.body); return new Response("{}", { status: 201 }); } });
  assert.equal(b.refund_destination, "original_payment");
});
await test("AfterShip refusal is reported, not thrown (the chat offers the returns page)", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ meta: { code: 42200, message: "Return window has expired" } }), { status: 422 });
  const r = await createAftershipReturn({ apiKey: "k", order: { id: "5001" }, items: [{ lineId: "9001", quantity: 1 }], reasonLabel: "Other", fetchImpl });
  assert.equal(r.ok, false); assert.match(r.error, /Return window has expired/);
  const r2 = await createAftershipReturn({ apiKey: "k", order: { id: "5001" }, items: [], reasonLabel: "Other", fetchImpl: async () => { throw new Error("down"); } });
  assert.equal(r2.ok, false);
});
await test("reasons: size and width reasons offer an exchange, others don't", () => {
  assert.ok(reasonByKey("too_small").change && reasonByKey("too_wide").change);
  assert.equal(reasonByKey("damaged").change, undefined);
  assert.equal(reasonByKey("nope"), null);
});
await test("chat tool: signed out → a sign-in button, no order data", async () => {
  const t = ordersTool({ shop: "s", accessToken: "t", loggedInCustomerId: null });
  const r = await t.run({});
  assert.equal(r.signed_in, false);
  assert.deepEqual(r._events, [{ type: "login_prompt", intent: "track" }]);
  assert.ok(!("orders" in r));
});
await test("chat tool: signed in → order cards for the widget, a short summary for the model", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { customer: { email: "jo@x.com", orders: { nodes: [order({ createdAt: new Date(Date.now() - 5 * 864e5).toISOString(), fulfillments: [{ ...order().fulfillments[0], deliveredAt: new Date().toISOString() }] })] } } } }), { status: 200 });
  try {
    const r = await ordersTool({ shop: "s", accessToken: "t", loggedInCustomerId: "77" }).run({ intent: "return" });
    assert.equal(r.signed_in, true);
    assert.equal(r._events[0].type, "order_cards");
    assert.equal(r._events[0].orders[0].number, "1171674");
    assert.equal(r.orders[0].can_return, true);
    assert.ok(!JSON.stringify(r.orders).includes("@"), "no email to the model");
    assert.match(r.note, /Return an item/);
    assert.ok(Array.isArray(r._events[0].returnMethods) && r._events[0].returnMethods.length >= 1);
    assert.ok(!("type" in r._events[0].returnMethods[0]), "AfterShip method types stay server-side");
  } finally { globalThis.fetch = realFetch; }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

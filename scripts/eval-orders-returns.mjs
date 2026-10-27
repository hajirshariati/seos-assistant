// Orders & returns in the chat: order cards (status, progress, privacy),
// ownership of the order, the next size for an exchange, the AfterShip
// request, and the chat tool for signed-out and signed-in shoppers.
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://x@localhost:1/none";
const { toOrderCard, orderStage, getOwnedOrder, getOrderCards, returnPolicy } = await import("../app/lib/orders.server.js");
const { nextOption, createAftershipReturn, reasonByKey, aftershipReasonName, returnMethods, priorReturn, blockedMessage } = await import("../app/lib/returns.server.js");
const { ordersTool } = await import("../app/lib/lean/orders-tool.server.js");
const { cleanLookup, guestSearch, matchGuestOrder, guestOrderCard, lookupGuestOrder, createLookupLimiter, GUEST_LIMITS } = await import("../app/lib/guest-order.server.js");

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
await test("store settings: return window days and delivered-only", () => {
  assert.deepEqual(returnPolicy({}), { windowDays: 30, deliveredOnly: true }, "defaults");
  assert.deepEqual(returnPolicy({ returnWindowDays: 45, returnsDeliveredOnly: false }), { windowDays: 45, deliveredOnly: false });
  assert.equal(returnPolicy({ returnWindowDays: 900 }).windowDays, 365, "capped");
  const late = Date.parse("2026-12-30T12:00:00Z");
  assert.equal(toOrderCard(delivered(), { now: late, policy: returnPolicy({ returnWindowDays: 30 }) }).returnBlocked, "window_closed");
  assert.equal(toOrderCard(delivered(), { now: late, policy: returnPolicy({ returnWindowDays: 90 }) }).canReturn, true);
  assert.equal(toOrderCard(delivered(), { now: late, policy: returnPolicy({ returnWindowDays: 0 }) }).canReturn, true, "0 = no limit");
  // Delivered-only off: shipped is enough, still not before it ships.
  const shippedOnly = returnPolicy({ returnsDeliveredOnly: false });
  assert.equal(toOrderCard(order(), { now: NOW }).returnBlocked, "not_delivered");
  assert.equal(toOrderCard(order(), { now: NOW, policy: shippedOnly }).canReturn, true);
  const unshipped = toOrderCard(order({ fulfillments: [], displayFulfillmentStatus: "UNFULFILLED" }), { now: NOW, policy: shippedOnly });
  assert.equal(unshipped.returnBlocked, "not_shipped");
  assert.match(blockedMessage("not_shipped"), /once the order has shipped/);
  assert.match(blockedMessage("window_closed", returnPolicy({ returnWindowDays: 45 })), /within 45 days/);
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
await test("a return started in the chat: shown on the card, its items no longer returnable", () => {
  const started = [{ orderId: "5001", lineIds: ["9001"], rma: "RMA1", labelUrl: "https://l/1", methodKey: "usps", methodLabel: "USPS drop-off", findUrl: "", exchange: true, exchangeCards: [{ handle: "x" }], createdAt: new Date("2026-10-20T10:00:00Z") }];
  const c = toOrderCard(delivered(), { now: NOW, chatReturns: started });
  assert.equal(c.items[0].returnable, 0);
  assert.equal(c.canReturn, false); assert.equal(c.returnBlocked, "nothing_left");
  assert.deepEqual(c.returns[0], { rma: "RMA1", labelUrl: "https://l/1", method: { key: "usps", label: "USPS drop-off", findUrl: "" }, exchange: true, date: "2026-10-20", lineIds: ["9001"], exchangeCards: [{ handle: "x" }] });
  // Two of a line: one unit still free.
  const two = delivered({ lineItems: { nodes: [{ ...order().lineItems.nodes[0], quantity: 2, refundableQuantity: 2 }] } });
  const c2 = toOrderCard(two, { now: NOW, chatReturns: started });
  assert.equal(c2.items[0].returnable, 1); assert.equal(c2.canReturn, true);
});
await test("retry / double tap / another tab: the earlier return is found, never a second one", () => {
  const started = [{ lineIds: ["1"], rma: "A" }, { lineIds: ["1", "2"], rma: "B" }];
  assert.equal(priorReturn(started, ["1"]).rma, "B", "newest covering return");
  assert.equal(priorReturn(started, ["2"]).rma, "B");
  assert.equal(priorReturn(started, ["3"]), null, "a different item is a new return");
  assert.equal(priorReturn(started, ["1", "3"]), null);
  assert.equal(priorReturn([], ["1"]), null); assert.equal(priorReturn(started, []), null);
});
await test("why a return can't start, in plain words", () => {
  assert.match(blockedMessage("window_closed"), /within 30 days/);
  assert.match(blockedMessage("not_delivered"), /once the order has been delivered/);
  assert.match(blockedMessage("nothing_left"), /already being returned/);
});
await test("order list: returns started in the chat are attached to their orders", async () => {
  const realFetch = globalThis.fetch;
  const other = { ...delivered(), id: "gid://shopify/Order/5002", name: "#1171675" };
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { customer: { email: "jo@x.com", orders: { nodes: [delivered(), other] } } } }), { status: 200 });
  try {
    let asked = null;
    const { orders } = await getOrderCards({ shop: "s", accessToken: "t", customerId: "77", lookupReturns: async (shop, ids) => { asked = ids; return [{ orderId: "5002", lineIds: ["9001"], rma: "R2", createdAt: new Date() }]; } });
    assert.deepEqual(asked, ["5001", "5002"]);
    assert.equal(orders[0].returns.length, 0);
    assert.equal(orders[1].returns[0].rma, "R2");
  } finally { globalThis.fetch = realFetch; }
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
await test("chat tool: signed out → sign in or look the order up; no order data; never asks for an email in the chat", async () => {
  const t = ordersTool({ shop: "s", accessToken: "t", loggedInCustomerId: null });
  const r = await t.run({});
  assert.equal(r.signed_in, false);
  assert.deepEqual(r._events, [{ type: "login_prompt", intent: "track", lookup: true }]);
  assert.ok(!("orders" in r));
  assert.match(r.note, /look up the order with its order number \(or confirmation code\) and the email/);
  assert.match(r.note, /Don't ask for their email or order details in the chat/);
  assert.match(t.definition.description, /Never ask them to type their email or order details into the chat/);
  // The number they mentioned fills in the form — junk doesn't.
  assert.deepEqual((await t.run({ orderNumber: "#1174861" }))._events[0], { type: "login_prompt", intent: "track", lookup: true, order: "1174861" });
  assert.equal((await t.run({ orderNumber: "<b>x" }))._events[0].order, undefined);
  // Returns still need sign-in; the card says so.
  const ret = await t.run({ intent: "return" });
  assert.match(ret.note, /sign in to start a return here \(returns in the chat need sign-in\)/);
  assert.match(ret.note, /don't send them to customer service for this/);
  assert.match(t.definition.description, /don't send them to customer service for that unless they've tried and are still stuck/);
  // The store turned the lookup off: sign-in only, as before.
  const off = await ordersTool({ shop: "s", accessToken: "t", loggedInCustomerId: null, guestLookup: false }).run({ orderNumber: "1174861" });
  assert.deepEqual(off._events, [{ type: "login_prompt", intent: "track" }]);
});

await test("chat tool: signed out, the store's tracking page and returns center are always offered too", async () => {
  const t = ordersTool({ shop: "s", accessToken: "t", loggedInCustomerId: null, trackingPageUrl: "https://orders.aetrex.com/", returnsPageUrl: "https://www.aetrex.com/apps/aftership-returns-center" });
  const r = await t.run({ intent: "return" });
  assert.deepEqual(r._events[0].pages, { track: "https://orders.aetrex.com/", returns: "https://www.aetrex.com/apps/aftership-returns-center" });
  assert.match(r.note, /It also links to the store's tracking page and the returns center/);
  // Sign-in only stores get the pages too; a page that isn't https isn't offered.
  const off = await ordersTool({ shop: "s", accessToken: "t", loggedInCustomerId: null, guestLookup: false, returnsPageUrl: "javascript:alert(1)", trackingPageUrl: "https://orders.aetrex.com/" }).run({});
  assert.deepEqual(off._events[0], { type: "login_prompt", intent: "track", pages: { track: "https://orders.aetrex.com/" } });
  // No pages set: nothing extra.
  assert.equal((await ordersTool({ shop: "s", accessToken: "t", loggedInCustomerId: null }).run({}))._events[0].pages, undefined);
});
// ── Order status without signing in (routes/order-lookup.jsx) ──
await test("guest lookup: what's typed is cleaned up; anything else is refused per field", () => {
  assert.deepEqual(cleanLookup({ order: " #1174861 ", email: " Pat@Example.COM " }), { order: "1174861", email: "pat@example.com" });
  assert.deepEqual(cleanLookup({ order: "pqype1gh8", email: "a@b.co" }), { order: "pqype1gh8", email: "a@b.co" });
  assert.deepEqual(cleanLookup({ order: "AE-1001", email: "a@b.co" }).order, "AE-1001");
  assert.deepEqual(Object.keys(cleanLookup({ order: "1", email: "a@b.co" }).errors), ["order"]);
  assert.deepEqual(Object.keys(cleanLookup({ order: '1001" OR email:*', email: "a@b.co" }).errors), ["order"], "search syntax can't get in");
  assert.deepEqual(Object.keys(cleanLookup({ order: "1001", email: "nope" }).errors), ["email"]);
  assert.deepEqual(Object.keys(cleanLookup({}).errors), ["order", "email"]);
  assert.deepEqual(Object.keys(cleanLookup({ order: "1001", email: `${"a".repeat(250)}@b.co` }).errors), ["email"]);
});
await test("guest lookup: searched by order number or confirmation code only", () => {
  assert.equal(guestSearch("1174861"), 'name:"#1174861" OR name:"1174861" OR confirmation_number:"1174861"');
});
const guest = (over = {}) => order({ email: "Pat@Example.com", confirmationNumber: "PQYPE1GH8", ...over });
await test("guest lookup: the number (or code) AND the email must be the same order's — exactly", () => {
  const o = guest();
  assert.equal(matchGuestOrder([o], { order: "1171674", email: "pat@example.com" }), o);
  assert.equal(matchGuestOrder([o], { order: "pqype1gh8", email: "pat@example.com" }), o, "confirmation code, any case");
  assert.equal(matchGuestOrder([o], { order: "1171674", email: "someone@else.com" }), null, "wrong email");
  assert.equal(matchGuestOrder([o], { order: "117167", email: "pat@example.com" }), null, "part of the number isn't enough");
  assert.equal(matchGuestOrder([o], { order: "71674", email: "pat@example.com" }), null);
  assert.equal(matchGuestOrder([guest({ email: null })], { order: "1171674", email: "" }), null, "an order with no email never matches");
  // Confirmation codes aren't unique: the email picks the right one.
  const other = guest({ id: "gid://shopify/Order/6000", name: "#1180000", email: "sam@example.com" });
  assert.equal(matchGuestOrder([other, o], { order: "PQYPE1GH8", email: "pat@example.com" }), o);
});
await test("guest lookup: the card shows status and items only — no ids, email, address, payment, prices or return actions", () => {
  const c = guestOrderCard(guest(), { trackingBase: "https://track.example", now: Date.parse("2026-10-20T00:00:00Z") });
  assert.deepEqual(Object.keys(c).sort(), ["carrier", "date", "deliveredAt", "eta", "guest", "id", "items", "number", "returnStatus", "shippedAt", "stage", "stageLabel", "step", "trackUrl"].sort());
  assert.equal(c.id, "guest-1171674");
  assert.equal(c.number, "1171674");
  assert.equal(c.stageLabel, "On its way");
  assert.equal(c.trackUrl, "https://track.example/tracking/1Z9", "tracking link carries the tracking number, never the email");
  assert.deepEqual(c.items, [{ title: "Savannah Sandal - Red", options: { Size: "8 US", Width: "Medium" }, image: "https://cdn/x.jpg", quantity: 1 }]);
  const text = JSON.stringify(c);
  assert.ok(!/@|example\.com|PQYPE1GH8|gid:|Customer/.test(text), text);
  assert.ok(!("canReturn" in c) && !("returnsUrl" in c));
  // The store's returns center, as it is — never with the email filled in; not for a cancelled order.
  const withPage = guestOrderCard(guest(), { returnsBase: "https://www.aetrex.com/apps/aftership-returns-center" });
  assert.equal(withPage.returnsPage, "https://www.aetrex.com/apps/aftership-returns-center");
  assert.equal(guestOrderCard(guest({ cancelledAt: "2026-10-15T00:00:00Z" }), { returnsBase: "https://r.example" }).returnsPage, undefined);
  assert.equal(guestOrderCard(guest(), { returnsBase: "http://r.example" }).returnsPage, undefined);
});
await test("guest lookup: found → the card; any miss → the same not-found (no hint which detail was wrong)", async () => {
  const seen = [];
  const graphql = async ({ variables }) => { seen.push(variables.q); return { orders: { nodes: [guest()] } }; };
  const log = console.log; const logged = []; console.log = (m) => logged.push(String(m));
  try {
    const ok = await lookupGuestOrder({ shop: "s", accessToken: "t", order: "1171674", email: "pat@example.com", graphql });
    assert.equal(ok.order.number, "1171674");
    const wrongEmail = await lookupGuestOrder({ shop: "s", accessToken: "t", order: "1171674", email: "x@example.com", graphql });
    const wrongNumber = await lookupGuestOrder({ shop: "s", accessToken: "t", order: "1171675", email: "pat@example.com", graphql: async () => ({ orders: { nodes: [] } }) });
    assert.deepEqual(wrongEmail, { notFound: true });
    assert.deepEqual(wrongNumber, wrongEmail);
  } finally { console.log = log; }
  assert.equal(seen[0], guestSearch("1171674"));
  assert.ok(logged.every((l) => !/pat@|1171674|x@example/.test(l)), "the log never names who looked or what for");
  assert.ok(logged.some((l) => /\[pii-access\].*guest_order_lookup result=found/.test(l)));
});
await test("guest lookup: tries are limited per device, per order, per email and per store", () => {
  let t = 0;
  const lim = createLookupLimiter({ now: () => t });
  const tries = (n, parts, shop = "s") => Array.from({ length: n }, () => lim(shop, parts).ok);
  assert.equal(GUEST_LIMITS.device.limit, 6);
  // One device: 6 in ten minutes, then wait.
  assert.deepEqual(tries(7, { device: "1.1.1.1" }), [true, true, true, true, true, true, false]);
  t += 10 * 60_000 + 1;
  assert.equal(lim("s", { device: "1.1.1.1" }).ok, true, "free again after the window");
  // One order from many devices: 6 an hour, so switching devices doesn't help guess its email.
  const byOrder = Array.from({ length: 7 }, (_, i) => lim("s", { device: `9.9.9.${i}`, order: "1171674", email: `guess${i}@x.com` }).ok);
  assert.deepEqual(byOrder, [true, true, true, true, true, true, false]);
  const r = lim("s", { device: "8.8.8.8", order: "1171674", email: "pat@example.com" });
  assert.equal(r.ok, false);
  assert.ok(r.retryAfter > 0 && r.retryAfter <= 3600);
  // One email from many devices: 10 an hour, so no one can walk order numbers for it.
  const byEmail = Array.from({ length: 11 }, (_, i) => lim("s", { device: `7.7.7.${i}`, order: `20000${i}`, email: "victim@x.com" }).ok);
  assert.deepEqual(byEmail.slice(-2), [true, false]);
  // Another store has its own limits.
  assert.equal(lim("other", { device: "8.8.8.8", order: "1171674", email: "pat@example.com" }).ok, true);
});
await test("guest lookup: the whole store's lookups are capped; a full limiter turns lookups away (it never forgets tries)", () => {
  let t = 0;
  const lim = createLookupLimiter({ limits: { ...GUEST_LIMITS, store: { limit: 3, windowMs: 60_000 } }, now: () => t });
  assert.deepEqual([0, 1, 2, 3].map((i) => lim("s", { device: `d${i}` }).ok), [true, true, true, false]);
  const tiny = createLookupLimiter({ maxKeys: 4, now: () => t });
  assert.equal(tiny("s", { device: "a", order: "1001", email: "a@b.co" }).ok, true);
  assert.equal(tiny("s", { device: "b", order: "1002", email: "b@b.co" }).ok, false, "full: turned away, not forgotten");
  t += 60 * 60_000 + 1;
  assert.equal(tiny("s", { device: "b", order: "1002", email: "b@b.co" }).ok, true, "old tries age out, then there's room");
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

await test("returns in chat off: cards send shoppers to the prefilled returns page, the model is told so", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { customer: { email: "jo@x.com", orders: { nodes: [order({ createdAt: new Date(Date.now() - 5 * 864e5).toISOString(), fulfillments: [{ ...order().fulfillments[0], deliveredAt: new Date().toISOString() }] })] } } } }), { status: 200 });
  try {
    const t = ordersTool({ shop: "s", accessToken: "t", loggedInCustomerId: "77", returnsPageUrl: "https://returns.example/", returnsInChat: false });
    assert.match(t.definition.description, /Start a return/); assert.doesNotMatch(t.definition.description, /walks them through/);
    const r = await t.run({ intent: "return" });
    const card = r._events[0].orders[0];
    assert.equal(card.returnMode, "page");
    assert.equal(card.returnsUrl, "https://returns.example?order-number=1171674&email=jo%40x.com");
    assert.deepEqual(r._events[0].returnMethods, []);
    assert.equal(r.orders[0].has_returns_page, true);
    assert.match(r.note, /Start a return/);
    const on = ordersTool({ shop: "s", accessToken: "t", loggedInCustomerId: "77", returnsPageUrl: "https://returns.example/" });
    assert.match(on.definition.description, /walks them through/);
    assert.equal((await on.run({})).orders[0].has_returns_page, undefined);
  } finally { globalThis.fetch = realFetch; }
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

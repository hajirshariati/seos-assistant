// "Where's my order?" without signing in. The shopper types the order number
// (or the confirmation code from their order email) and the email the order
// was placed with; both must belong to the same order. Then they see that
// one order's status — progress, items, carrier and tracking — and nothing
// personal: no name, address, payment or prices, and returns still need
// sign-in. Nothing is stored, and the details go from the shopper's browser
// straight to Shopify — never to the AI.
//
// Guessing is what this has to stop: every miss gets the same answer (no
// hint which detail was wrong), and tries are limited per device, per order,
// per email and per store, in a limiter of its own that turns lookups away
// when it's full rather than forgetting anyone's tries.

import crypto from "node:crypto";
import { adminGraphql, toOrderCard, ORDER_FIELDS } from "./orders.server.js";

const EMAIL = /^[^\s@<>()",;:]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
// Order names are letters, digits and dashes ("1171674", "AE-1001");
// confirmation codes are letters and digits ("XPPJ2ZJTZ").
const ORDER = /^[a-z0-9-]{3,24}$/i;

// What the shopper typed → { order, email }, or { errors } per field.
export function cleanLookup({ order, email } = {}) {
  const o = String(order ?? "").replace(/\s+/g, "").replace(/^#+/, "");
  const e = String(email ?? "").trim().toLowerCase();
  const errors = {};
  if (!ORDER.test(o)) errors.order = "Enter your order number or confirmation number.";
  if (e.length > 254 || !EMAIL.test(e)) errors.email = "Enter the email you used for the order.";
  return Object.keys(errors).length ? { errors } : { order: o, email: e };
}

// The order by its name or confirmation code (the value is letters, digits
// and dashes only, so it can't change the search).
export function guestSearch(order) {
  return `name:"#${order}" OR name:"${order}" OR confirmation_number:"${order}"`;
}

const GUEST_ORDER_QUERY = `
  query GuestOrder($q: String!) {
    orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} email confirmationNumber } }
  }
`;

const norm = (s) => String(s || "").replace(/[^0-9a-z]/gi, "").toLowerCase();

// The order whose number or confirmation code is exactly what was typed AND
// whose email is exactly the one typed. Search results are only candidates.
export function matchGuestOrder(nodes = [], { order, email }) {
  const want = norm(order);
  if (!want || !email) return null;
  return nodes.find((o) => {
    const mail = String(o?.email || "").trim().toLowerCase();
    return mail !== "" && mail === email && (norm(o.name) === want || norm(o.confirmationNumber) === want);
  }) || null;
}

// What a guest sees: the order's status and items. No ids, email, address,
// payment or prices; tracking links never carry the email.
export function guestOrderCard(o, { trackingBase = "", now = Date.now() } = {}) {
  const c = toOrderCard(o, { trackingBase, returnsBase: "", email: "", now });
  return {
    id: `guest-${c.number}`,
    number: c.number,
    date: c.date,
    stage: c.stage,
    stageLabel: c.stageLabel,
    step: c.step,
    shippedAt: c.shippedAt,
    deliveredAt: c.deliveredAt,
    eta: c.eta,
    carrier: c.carrier,
    trackUrl: c.trackUrl,
    returnStatus: c.returnStatus,
    items: c.items.map((i) => ({ title: i.title, options: i.options, image: i.image, quantity: i.quantity })),
    guest: true,
  };
}

export async function lookupGuestOrder({ shop, accessToken, order, email, trackingBase = "", graphql = adminGraphql }) {
  const data = await graphql({ shop, accessToken, query: GUEST_ORDER_QUERY, variables: { q: guestSearch(order) } });
  const found = matchGuestOrder(data?.orders?.nodes || [], { order, email });
  // Who looked is never logged — only that a lookup happened, and how it went.
  console.log(`[pii-access] shop=${shop} guest_order_lookup result=${found ? "found" : "no_match"} purpose=customer_service source=admin_api`);
  return found ? { order: guestOrderCard(found, { trackingBase }) } : { notFound: true };
}

// Tries allowed, by what's being tried: one device (its IP) a few in ten
// minutes; one order number, one email and the whole store a few an hour —
// so changing devices doesn't help.
export const GUEST_LIMITS = {
  device: { limit: 6, windowMs: 10 * 60_000 },
  order: { limit: 6, windowMs: 60 * 60_000 },
  email: { limit: 10, windowMs: 60 * 60_000 },
  store: { limit: 300, windowMs: 60 * 60_000 },
};

// Every try counts, found or not. Keys are keyed hashes with a secret made
// at start-up and never stored, so no email or order number is kept — even
// in memory — and none can be worked back out. Full: tries are turned away
// until old ones age out — never forgotten early.
export function createLookupLimiter({ limits = GUEST_LIMITS, maxKeys = 50_000, now = () => Date.now() } = {}) {
  const buckets = new Map();
  const secret = crypto.randomBytes(32);
  const hash = (s) => crypto.createHmac("sha256", secret).update(s).digest("hex").slice(0, 32);
  const live = (key, kind, t) => (buckets.get(key) || []).filter((x) => x > t - limits[kind].windowMs);
  const prune = (t) => {
    for (const [key, stamps] of buckets) {
      const kept = stamps.filter((x) => x > t - limits[key.slice(0, key.indexOf("|"))].windowMs);
      if (kept.length) buckets.set(key, kept);
      else buckets.delete(key);
    }
  };
  // parts: { device, order, email } — the ones given are checked, plus the store.
  return function check(shop, parts = {}) {
    const t = now();
    const keys = Object.entries({ store: "*", ...parts })
      .filter(([kind, v]) => limits[kind] && v != null && v !== "")
      .map(([kind, v]) => ({ kind, key: `${kind}|${hash(`${shop}|${v}`)}` }));
    let retryAfter = 0;
    for (const { kind, key } of keys) {
      const stamps = live(key, kind, t);
      if (stamps.length >= limits[kind].limit) retryAfter = Math.max(retryAfter, Math.ceil((stamps[0] + limits[kind].windowMs - t) / 1000));
    }
    if (retryAfter) return { ok: false, retryAfter };
    if (buckets.size + keys.length > maxKeys) {
      prune(t);
      if (buckets.size + keys.length > maxKeys) return { ok: false, retryAfter: 60 };
    }
    for (const { kind, key } of keys) buckets.set(key, [...live(key, kind, t), t]);
    return { ok: true };
  };
}

export const guestLimiter = createLookupLimiter();

// AVA's activity in Shopify Analytics (the App Events API): chats started,
// products shown, adds to cart and checkouts started, beside the store's own
// sales in Shopify's reports. They're the app's own custom events
// (<app handle>.ava_…, declared in extensions-aetrex/ava-app-events), so no
// Shopify metric and no other app's numbers move. Settings → Integrations
// turns them off.
//
// Never in a chat's way: events wait in a small queue and go out a few at a
// time; one that can't be sent is dropped (and the reason logged now and
// then). Nothing that could identify a shopper is sent — product IDs and
// handles, a quantity, a value, how the chat started.
import crypto from "node:crypto";
import prisma from "../db.server.js";
import { getShopConfigCached } from "../models/ShopConfig.server.js";
import { shopFacts } from "./shopify-facts.server.js";

const API_VERSION = "2026-10";
const TOKEN_URL = process.env.APP_EVENTS_TOKEN_URL || "https://api.shopify.com/auth/access_token";
const EVENTS_URL = process.env.APP_EVENTS_URL || `https://api.shopify.com/app/${API_VERSION}/events`;
const USER_AGENT = "AVA app events";
const SEND_TIMEOUT_MS = 5000;
const MAX_QUEUE = 2000;
const IN_FLIGHT = 4;
// After Shopify couldn't give a token, wait this long before trying again.
const RETRY_LATER_MS = 10 * 60 * 1000;

// The part after the app's handle; must match the declaration.
export const AVA_EVENT = {
  chatStarted: "ava_chat_started",
  productShown: "ava_product_shown",
  addedToCart: "ava_added_to_cart",
  checkoutStarted: "ava_checkout_started",
};

// The event's name as Shopify knows it: the app's handle, a dot, ours.
export function eventHandle(appHandle, local) {
  return /^[a-z0-9][a-z0-9-]{0,99}$/.test(String(appHandle || "")) ? `${appHandle}.${local}` : null;
}

// A key Shopify uses to drop a repeat (up to 64 characters).
export function eventKey(...parts) {
  return `ava_${crypto.createHash("sha256").update(parts.map(String).join("|")).digest("base64url").slice(0, 40)}`;
}

// The number in a Shopify ID ("gid://shopify/Product/123" or "123"), or null.
export function shopifyNumber(id) {
  const m = /(?:^|\/)(\d{1,20})$/.exec(String(id || ""));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Only what the declaration has, each the type it says; anything else is left
// out rather than sent wrong.
const ATTRIBUTE_TYPES = {
  started_by: "string",
  signed_in: "boolean",
  product_id: "int",
  product_handle: "string",
  position: "int",
  variant_id: "int",
  quantity: "int",
  added_value: "int",
  source: "string",
};
export function cleanAttributes(attrs) {
  const out = {};
  for (const [k, v] of Object.entries(attrs || {})) {
    const type = ATTRIBUTE_TYPES[k];
    if (!type || v === null || v === undefined) continue;
    if (type === "string" && typeof v === "string" && v) out[k] = v.slice(0, 128);
    else if (type === "boolean" && typeof v === "boolean") out[k] = v;
    else if (type === "int" && Number.isSafeInteger(v) && v >= 0) out[k] = v;
  }
  return out;
}

// ── the app's token (an hour; renewed five minutes before) ──
let token = null; // { value, until }
let tokenFailedAt = 0;
let tokenLoading = null;
async function appToken({ fresh = false } = {}) {
  if (!fresh && token && Date.now() < token.until) return token.value;
  if (Date.now() - tokenFailedAt < RETRY_LATER_MS) return null;
  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;
  if (!clientId || !clientSecret) return null;
  if (!tokenLoading) {
    tokenLoading = fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok || typeof json?.access_token !== "string") throw new Error(`token ${res.status}`);
        token = { value: json.access_token, until: Date.now() + 55 * 60 * 1000 };
        return token.value;
      })
      .catch((err) => {
        token = null;
        tokenFailedAt = Date.now();
        note("token", `no token from Shopify: ${err?.message || err}`);
        return null;
      })
      .finally(() => { tokenLoading = null; });
  }
  return tokenLoading;
}

// ── sending: a few at a time, never more than MAX_QUEUE waiting ──
const queue = [];
let inFlight = 0;
let dropped = 0;
function pump() {
  while (inFlight < IN_FLIGHT && queue.length) {
    const job = queue.shift();
    inFlight++;
    job().catch(() => {}).finally(() => { inFlight--; pump(); });
  }
}
function enqueue(job) {
  if (queue.length >= MAX_QUEUE) {
    if (++dropped % 100 === 1) note("queue", `queue full; ${dropped} event(s) dropped`);
    return;
  }
  queue.push(job);
  pump();
}

// One line per kind of trouble a minute at most — never a log flood.
const noted = new Map();
function note(kind, msg) {
  const last = noted.get(kind) || 0;
  if (Date.now() - last < 60_000) return;
  noted.set(kind, Date.now());
  console.warn(`[app-events] ${msg}`);
}

async function post(body, retried = false) {
  const value = await appToken({ fresh: retried });
  if (!value) return;
  const res = await fetch(EVENTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${value}`, "User-Agent": USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (res.ok) return;
  // An expired token: once more with a new one. Still being processed: once
  // more in a moment. Anything else: dropped.
  if (!retried && res.status === 401) return post(body, true);
  if (!retried && res.status === 409) {
    await new Promise((r) => setTimeout(r, 1000));
    return post(body, true);
  }
  note(`http${res.status}`, `${body.event_handle} not accepted (${res.status})`);
}

// Queue one event for the store, if it has them on. Never throws.
export function sendAvaEvent(shop, local, attributes, key) {
  enqueue(async () => {
    const config = await getShopConfigCached(shop);
    if (!config || config.appEventsEnabled === false) return;
    const facts = await shopFacts(shop, config);
    const name = eventHandle(facts?.handle, local);
    if (!facts || !name) return;
    const attrs = typeof attributes === "function" ? await attributes(facts) : attributes;
    await post({
      shop_id: facts.id,
      event_handle: name,
      timestamp: new Date().toISOString(),
      idempotency_key: key || eventKey(shop, local, crypto.randomUUID()),
      attributes: cleanAttributes(attrs),
    });
  });
}

// ── the four events ──

// A shopper's first message in a chat.
export function avaChatStarted(shop, { sessionId = "", message = "", typed = null, signedIn = false } = {}) {
  const minute = Math.floor(Date.now() / 60_000);
  sendAvaEvent(
    shop,
    AVA_EVENT.chatStarted,
    { started_by: typed === true ? "typed" : typed === false ? "button" : null, signed_in: signedIn === true },
    sessionId ? eventKey(shop, AVA_EVENT.chatStarted, sessionId, message, minute) : undefined,
  );
}

// The product cards in one reply, one event each.
export function avaProductsShown(shop, cards) {
  const list = (Array.isArray(cards) ? cards : []).filter((c) => c && typeof c.handle === "string" && c.handle);
  if (!list.length) return;
  const turn = crypto.randomUUID();
  const handles = [...new Set(list.map((c) => c.handle))];
  // The products' Shopify IDs, read once for the reply.
  const ids = prisma.product
    .findMany({ where: { shop, handle: { in: handles } }, select: { handle: true, shopifyId: true } })
    .then((rows) => new Map(rows.map((r) => [r.handle, shopifyNumber(r.shopifyId)])))
    .catch(() => new Map());
  list.forEach((card, i) => {
    sendAvaEvent(
      shop,
      AVA_EVENT.productShown,
      async () => ({ product_id: (await ids).get(card.handle) ?? null, product_handle: card.handle, position: i + 1 }),
      eventKey(shop, AVA_EVENT.productShown, turn, i),
    );
  });
}

// The variant and its product, from the store's own catalog (never the
// shopper's word for the price).
async function variantFacts(shop, variantId) {
  const n = shopifyNumber(variantId);
  if (!n) return null;
  const v = await prisma.productVariant.findFirst({
    where: { shopifyId: { in: [`gid://shopify/ProductVariant/${n}`, String(n)] }, product: { shop } },
    select: { price: true, product: { select: { shopifyId: true, handle: true } } },
  });
  return v ? { variantId: n, price: Number.parseFloat(v.price), productId: shopifyNumber(v.product.shopifyId), handle: v.product.handle } : null;
}

// Added to the cart from the chat. The value (at its list price) is sent
// only for a store that sells in US dollars, the currency the event declares.
export async function avaAddedToCart(shop, { variantId, quantity = 1, eventId = "" } = {}) {
  const v = await variantFacts(shop, variantId);
  if (!v) return false;
  const qty = Number.isSafeInteger(quantity) && quantity > 0 && quantity <= 99 ? quantity : 1;
  sendAvaEvent(
    shop,
    AVA_EVENT.addedToCart,
    (facts) => ({
      product_id: v.productId,
      product_handle: v.handle,
      variant_id: v.variantId,
      quantity: qty,
      added_value: facts.currency === "USD" && Number.isFinite(v.price) && v.price >= 0 ? Math.round(v.price * 100) * qty : null,
    }),
    eventId ? eventKey(shop, AVA_EVENT.addedToCart, eventId) : undefined,
  );
  return true;
}

// Off to checkout from the chat: Buy now on a card, or Checkout after adding.
export async function avaCheckoutStarted(shop, { source, variantId = null, eventId = "" } = {}) {
  if (source !== "buy_now" && source !== "checkout") return false;
  const v = variantId ? await variantFacts(shop, variantId) : null;
  sendAvaEvent(
    shop,
    AVA_EVENT.checkoutStarted,
    { source, product_id: v?.productId ?? null, product_handle: v?.handle ?? null, variant_id: v?.variantId ?? null },
    eventId ? eventKey(shop, AVA_EVENT.checkoutStarted, eventId) : undefined,
  );
  return true;
}

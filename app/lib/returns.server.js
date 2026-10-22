// In-chat returns. The shopper picks items and a reason in the chat; the
// return is created in AfterShip Returns (so the store's return rules,
// labels and emails stay exactly as they are). AfterShip's API creates
// refund returns only, so "exchange" is: the return (refund) plus the same
// shoe in the next size, ready to add to cart.

import { toCard } from "./lean/engine.js";
import { loadLeanCatalog } from "./lean/catalog.server.js";
import { returnWindowDays } from "./orders.server.js";

// Reasons the chat offers. `change` says how an exchange moves the size.
export const RETURN_REASONS = [
  { key: "too_small", label: "Too small", change: { option: "size", step: 1 } },
  { key: "too_large", label: "Too large", change: { option: "size", step: -1 } },
  { key: "too_narrow", label: "Too narrow", change: { option: "width", step: 1 } },
  { key: "too_wide", label: "Too wide", change: { option: "width", step: -1 } },
  { key: "changed_mind", label: "Changed my mind" },
  { key: "damaged", label: "Damaged or defective" },
  { key: "not_as_described", label: "Not as described" },
  { key: "other", label: "Other" },
];
export const reasonByKey = (k) => RETURN_REASONS.find((r) => r.key === k) || null;

// AfterShip only accepts a reason whose name matches one in the store's
// return reason group, word for word. AFTERSHIP_RETURN_REASONS maps our keys
// to the store's names, e.g. {"too_small":"Too Small","other":"Other"}.
export function aftershipReasonName(key, env = process.env.AFTERSHIP_RETURN_REASONS) {
  let map = {};
  try { map = env ? JSON.parse(env) : {}; } catch { map = {}; }
  const name = typeof map?.[key] === "string" ? map[key].trim() : "";
  return name || reasonByKey(key)?.label || "";
}

// Narrow → wide, both naming styles (Medium/Wide and AA/B/D/EE…).
const WIDTH_WORDS = { narrow: 0, slim: 0, medium: 1, regular: 1, standard: 1, wide: 2, "extra wide": 3, xw: 3, xxw: 4 };
const WIDTH_LETTERS = ["AAAA", "AAA", "AA", "A", "B", "C", "D", "E", "EE", "EEE", "EEEE"];
function widthRank(v) {
  const s = String(v || "").trim();
  const word = WIDTH_WORDS[s.toLowerCase()];
  if (word !== undefined) return word;
  const i = WIDTH_LETTERS.indexOf(s.toUpperCase());
  return i >= 0 ? i : 99;
}
const sizeNum = (v) => parseFloat(String(v || "").match(/\d+(?:\.\d+)?/)?.[0] || "NaN");

// The value next to `current` in `values`, in the size or width order.
export function nextOption(values = [], current = "", kind = "size", step = 1) {
  const list = [...new Set(values.map(String))];
  const key = kind === "width" ? widthRank : sizeNum;
  list.sort((a, b) => key(a) - key(b));
  const i = list.findIndex((v) => v.toLowerCase() === String(current).toLowerCase());
  if (i < 0) return null;
  return list[i + step] || null;
}

// The product card for an exchange: same style, size/width moved one step,
// everything else as ordered. Null if the store doesn't sell a next step.
export async function exchangeCard({ shop, item, reasonKey }) {
  const reason = reasonByKey(reasonKey);
  if (!reason?.change || !item?.handle) return null;
  const catalog = await loadLeanCatalog(shop);
  const p = catalog.products.find((x) => x.handle === item.handle);
  if (!p) return null;
  const names = Object.keys(p.options || {});
  const optName = names.find((n) => n.toLowerCase().includes(reason.change.option));
  const ordered = item.options || {};
  const current = optName ? Object.entries(ordered).find(([n]) => n.toLowerCase() === optName.toLowerCase())?.[1] : "";
  const next = optName && current ? nextOption(p.options[optName], current, reason.change.option, reason.change.step) : null;
  const preselect = {};
  for (const n of names) {
    const v = Object.entries(ordered).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1];
    if (v) preselect[n] = v;
  }
  if (next) preselect[optName] = next;
  else if (optName) delete preselect[optName]; // let them pick
  return { card: toCard(p, Object.keys(preselect).length ? preselect : null), from: current || "", to: next || "" };
}

// AfterShip Returns: create a refund return for these order items.
// AfterShip's 422 response names the required fields: order.store,
// a top-level return_method and a top-level refund_destination. Refunds go
// to the original payment (no store credit). The store's external_id format
// isn't documented; the short store key is what matched live, so the full
// myshopify domain is only tried after a 404 ("Order not found"). Every attempt's error is returned so the log
// shows what AfterShip said to each.
const AS_VERSION = process.env.AFTERSHIP_RETURNS_API_VERSION || "2026-01";
const AS_METHOD = process.env.AFTERSHIP_RETURN_METHOD || "retailer_label";

// How the shopper sends it back, as the chat offers it. AFTERSHIP_RETURN_METHODS
// lists the store's options in order, e.g.
// [{"key":"happy_returns","type":"<AfterShip return_method type>","label":"Drop off at a Happy Returns location",
//   "detail":"No box or label needed.","fee":"$5.95","findUrl":"https://…"}]
// Without it there is one option, AFTERSHIP_RETURN_METHOD, and no picker.
const httpsUrl = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || "")) ? String(u) : "");
export function returnMethods(env = process.env.AFTERSHIP_RETURN_METHODS) {
  let list = [];
  try { list = env ? JSON.parse(env) : []; } catch { list = []; }
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const key = String(m?.key || "").trim().slice(0, 40);
    const type = String(m?.type || "").trim().slice(0, 60);
    const label = String(m?.label || "").trim().slice(0, 80);
    if (!key || !type || !label || out.some((x) => x.key === key)) continue;
    out.push({
      key, type, label,
      detail: String(m.detail || "").trim().slice(0, 160),
      fee: String(m.fee || "").trim().slice(0, 20),
      findUrl: httpsUrl(m.findUrl),
    });
  }
  return out.length ? out.slice(0, 4) : [{ key: "default", type: AS_METHOD, label: "Mail it back", detail: "", fee: "", findUrl: "" }];
}

// The methods as the chat shows them (AfterShip's own type stays server-side).
export const publicReturnMethods = () =>
  returnMethods().map((m) => ({ key: m.key, label: m.label, detail: m.detail, fee: m.fee, findUrl: m.findUrl }));

export function aftershipReturnBodies({ shop = "", order, items, reasonLabel, comment = "", methodType = AS_METHOD }) {
  const returnItems = items.map((it) => ({
    external_order_item_id: String(it.lineId),
    intended_return_quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
    return_reason: reasonLabel,
    ...(comment ? { return_reason_comment: comment.slice(0, 500) } : {}),
    resolution: "refund",
  }));
  const orderId = String(order.id).replace(/\D/g, "");
  const domain = String(shop).trim().toLowerCase();
  const key = domain.replace(/\.myshopify\.com$/i, "");
  const storeIds = [...new Set([key, domain].filter(Boolean))];
  const body = (store) => ({
    order: { external_id: orderId, ...(store ? { store: { platform: "shopify", external_id: store } } : {}) },
    return_items: returnItems,
    return_method: { type: methodType || AS_METHOD },
    refund_destination: "original_payment",
  });
  return storeIds.length ? storeIds.map(body) : [body(null)];
}

export async function createAftershipReturn({ apiKey, shop = "", order, items, reasonLabel, comment = "", methodType = AS_METHOD, fetchImpl = fetch }) {
  const r = await postAftershipReturn({ apiKey, shop, order, items, reasonLabel, comment, methodType, fetchImpl });
  // Reasons without "comments" switched on in AfterShip refuse any comment;
  // the return still goes through without it.
  if (!r.ok && comment && /comments are not allowed/i.test(r.error || "")) {
    return postAftershipReturn({ apiKey, shop, order, items, reasonLabel, comment: "", methodType, fetchImpl });
  }
  return r;
}

async function postAftershipReturn({ apiKey, shop, order, items, reasonLabel, comment, methodType, fetchImpl }) {
  const bodies = aftershipReturnBodies({ shop, order, items, reasonLabel, comment, methodType });
  const errors = [];
  let last = null;
  for (const body of bodies) {
    let res, json = null, text = "";
    try {
      res = await fetchImpl(`https://api.aftership.com/returns/${AS_VERSION}/returns`, {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json", "as-api-key": apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      });
      text = await res.text().catch(() => "");
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    } catch (err) {
      return { ok: false, error: `AfterShip unreachable: ${err?.message || err}` };
    }
    if (res.ok) {
      const r = json?.data?.return || json?.data || {};
      return {
        ok: true,
        rma: r.rma_number || r.rma || "",
        returnId: r.id || "",
        labelUrl: r.return_method?.label_url || r.shipping_label?.url || r.label?.url || r.shipments?.[0]?.label?.url || "",
      };
    }
    // The whole error body (order/line ids and field names only, no PII).
    const msg = json?.meta?.message || json?.message || `HTTP ${res.status}`;
    errors.push(`[store=${body.order?.store?.external_id || "-"}] ${msg} ${String(text).slice(0, 800)}`.trim());
    last = { ok: false, status: res.status, error: errors.join(" | ") };
    // Only "Order not found" means the store id may be wrong; any other
    // refusal (a 422 about the reason, the window…) is the real answer.
    if (res.status !== 404) break;
  }
  return last;
}

// What the shopper is told when an order can't be returned in the chat.
export function blockedMessage(blocked) {
  if (blocked === "window_closed") return `Returns can be started within ${returnWindowDays()} days of placing the order, and this one is past that window.`;
  if (blocked === "not_delivered") return "You can start a return once the order has been delivered.";
  if (blocked === "nothing_left") return "Everything in this order is already being returned.";
  if (blocked === "cancelled") return "This order was cancelled, so there's nothing to return.";
  return "This order can't be returned.";
}

// The newest return already started for all of these lines, if any.
export function priorReturn(started, lineIds) {
  const wanted = (lineIds || []).filter(Boolean);
  if (!wanted.length) return null;
  return [...(started || [])].reverse().find((r) => wanted.every((id) => (r.lineIds || []).includes(id))) || null;
}

// In-chat returns. The shopper picks items and a reason in the chat; the
// return is created in AfterShip Returns (so the store's return rules,
// labels and emails stay exactly as they are). AfterShip's API creates
// refund returns only, so "exchange" is: the return (refund) plus the same
// shoe in the next size, ready to add to cart.

import { toCard } from "./lean/engine.js";
import { loadLeanCatalog } from "./lean/catalog.server.js";

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
const AS_VERSION = process.env.AFTERSHIP_RETURNS_API_VERSION || "2026-01";
const AS_METHOD = process.env.AFTERSHIP_RETURN_METHOD || "retailer_label";
export async function createAftershipReturn({ apiKey, order, items, reasonLabel, comment = "", refundTo = "original_payment", fetchImpl = fetch }) {
  const body = {
    order: { external_id: String(order.id).replace(/\D/g, "") },
    return_items: items.map((it) => ({
      external_order_item_id: String(it.lineId),
      quantity: it.quantity,
      return_reason: reasonLabel,
      ...(comment ? { return_reason_comment: comment.slice(0, 500) } : {}),
      resolution: "refund",
    })),
    return_method: { type: AS_METHOD },
    refund_destination: refundTo === "store_credit" ? "store_credit" : "original_payment",
  };
  let res, json = null;
  try {
    res = await fetchImpl(`https://api.aftership.com/returns/${AS_VERSION}/returns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json", "as-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    json = await res.json().catch(() => null);
  } catch (err) {
    return { ok: false, error: `AfterShip unreachable: ${err?.message || err}` };
  }
  if (!res.ok) {
    const msg = json?.meta?.message || json?.message || `HTTP ${res.status}`;
    const details = JSON.stringify(json?.meta?.details || json?.errors || "").slice(0, 400);
    return { ok: false, status: res.status, error: `${msg} ${details}`.trim() };
  }
  const r = json?.data?.return || json?.data || {};
  return {
    ok: true,
    rma: r.rma_number || r.rma || "",
    returnId: r.id || "",
    labelUrl: r.return_method?.label_url || r.shipping_label?.url || r.label?.url || r.shipments?.[0]?.label?.url || "",
  };
}

// Previewing the peak-day home without turning Peak Mode on: Settings
// opens the store with ?ava_preview=<token>, a signature of the store and
// the day; the chat sends it back with its settings read, and the server
// hands over the peak home for that browser only. Good today and
// yesterday (UTC), so a preview opened late at night keeps working.
import { createHmac, timingSafeEqual } from "node:crypto";

const secret = () => process.env.SHOPIFY_API_SECRET || process.env.ENCRYPTION_KEY || "";
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
const sign = (shop, day) => createHmac("sha256", secret()).update(`peak-preview:${shop}:${day}`).digest("hex").slice(0, 32);

export function previewToken(shop, now = new Date()) {
  return sign(shop, dayOf(now));
}

export function validPreview(shop, token, now = new Date()) {
  const t = String(token || "");
  if (!/^[0-9a-f]{32}$/.test(t) || !secret()) return false;
  const days = [dayOf(now), dayOf(new Date(new Date(now).getTime() - 86400000))];
  return days.some((d) => { const s = sign(shop, d); return s.length === t.length && timingSafeEqual(Buffer.from(s), Buffer.from(t)); });
}

export function previewUrl(storeUrl, shop, now = new Date()) {
  const base = String(storeUrl || `https://${shop}`).replace(/\/+$/, "");
  return `${base}/?ava_preview=${previewToken(shop, now)}`;
}

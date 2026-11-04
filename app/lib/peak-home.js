// Peak Mode's home (Settings → Peak Mode → The home on peak days): while
// Peak Mode is on, the chat's home shows the day's promotion blocks where
// the banner was — each with a small line on top, a name, a line under it,
// a button that opens a link or asks AVA a question, and a picture — and a
// peak picture of the assistant. Every block says who sees it: everyone,
// shoppers signed out, shoppers signed in, or signed-in customers carrying a
// Shopify tag. The widget does the choosing with what the page knows about
// the shopper; the server only hands the blocks over while Peak Mode is on.
//
// Stored as one JSON (pictures as resized data URLs, like the app's
// picture); the route turns a picture into bytes. Pure.
import { appImageData, shortHash } from "./app-promo.js";
import { peakState } from "./peak-mode.js";

export const PEAK_IMAGE_PATH = "/apps/hajirai/peak-image";
export const PEAK_BLOCKS_MAX = 6;
export const PEAK_MAX = { eyebrow: 24, title: 60, text: 120, cta: 24, tag: 40, url: 500, message: 200 };
export const PEAK_AUDIENCES = ["all", "guest", "signed", "tag"];
export const PEAK_AUDIENCE_WORDS = { all: "Everyone", guest: "Signed out", signed: "Signed in", tag: "Customers with a tag" };

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const cleanUrl = (v) => { const s = String(v ?? "").trim().slice(0, PEAK_MAX.url); return /^https?:\/\/[^\s"'<>]+$|^\/[^\s"'<>]*$/i.test(s) ? s : ""; };
const cleanId = (v, i) => { const s = String(v ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12); return s || `b${i + 1}`; };
const parseJson = (v) => { if (v && typeof v === "object") return v; try { return JSON.parse(v); } catch { return null; } };

// A picture as stored: a data URL within the size limit, else "".
const picture = (v) => (appImageData(v) ? String(v) : "");

// The saved JSON → clean { avatar, blocks }. Blocks without a name are dropped.
export function parsePeakHome(raw) {
  const o = parseJson(raw);
  const out = { avatar: "", blocks: [] };
  if (!o || typeof o !== "object") return out;
  out.avatar = picture(o.avatar);
  const seen = new Set();
  for (const [i, b] of (Array.isArray(o.blocks) ? o.blocks : []).entries()) {
    if (!b || typeof b !== "object") continue;
    const title = clean(b.title, PEAK_MAX.title);
    if (!title) continue;
    let id = cleanId(b.id, i);
    while (seen.has(id)) id = `${id}x`;
    seen.add(id);
    const kind = b.kind === "ask" ? "ask" : "link";
    const audience = PEAK_AUDIENCES.includes(b.audience) ? b.audience : "all";
    out.blocks.push({
      id,
      eyebrow: clean(b.eyebrow, PEAK_MAX.eyebrow),
      title,
      text: clean(b.text, PEAK_MAX.text),
      cta: clean(b.cta, PEAK_MAX.cta),
      kind,
      url: kind === "link" ? cleanUrl(b.url) : "",
      message: kind === "ask" ? clean(b.message, PEAK_MAX.message) : "",
      image: picture(b.image),
      audience,
      tag: audience === "tag" ? clean(b.tag, PEAK_MAX.tag) : "",
    });
    if (out.blocks.length >= PEAK_BLOCKS_MAX) break;
  }
  return out;
}

// What's wrong with what Settings sent ("" when nothing): a picture too
// large, a tag audience without a tag, a button without its link or question.
export function peakHomeError(raw) {
  const o = parseJson(raw);
  if (!o || typeof o !== "object") return "";
  if (o.avatar && !appImageData(o.avatar)) return "The peak picture of the assistant is too large — pick a smaller one.";
  for (const [i, b] of (Array.isArray(o.blocks) ? o.blocks : []).entries()) {
    if (!b || typeof b !== "object" || !clean(b.title, PEAK_MAX.title)) continue;
    const n = `Block ${i + 1}`;
    if (b.image && !appImageData(b.image)) return `${n}: the picture is too large — pick a smaller one.`;
    if (b.audience === "tag" && !clean(b.tag, PEAK_MAX.tag)) return `${n}: name the customer tag that sees it.`;
    if (clean(b.cta, PEAK_MAX.cta)) {
      if (b.kind === "ask" && !clean(b.message, PEAK_MAX.message)) return `${n}: the button asks AVA — write its question.`;
      if (b.kind !== "ask" && !cleanUrl(b.url)) return `${n}: the button opens a link — give it one (https://… or /…).`;
    }
  }
  return "";
}

// For widget-config: the home's peak look while Peak Mode is on, else null.
// Pictures become links that carry their fingerprint (cached for good).
export function peakHomeConfig(config = {}, now = new Date(), { force = false } = {}) {
  if (!force && !peakState(config, now).active) return null;
  const home = parsePeakHome(config.peakHome);
  const link = (which, data) => `${PEAK_IMAGE_PATH}?b=${encodeURIComponent(which)}&v=${shortHash(data)}`;
  const blocks = home.blocks.map((b) => ({
    id: b.id, eyebrow: b.eyebrow, title: b.title, text: b.text, cta: b.cta,
    ...(b.kind === "ask" ? { message: b.message } : { url: b.url }),
    image: b.image ? link(b.id, b.image) : "",
    audience: b.audience, tag: b.tag,
  }));
  if (!blocks.length && !home.avatar) return null;
  return { avatar: home.avatar ? link("avatar", home.avatar) : "", blocks };
}

// The route: the picture behind ?b=avatar or ?b=<block id>.
export function peakImage(config = {}, which) {
  const home = parsePeakHome(config?.peakHome);
  const data = which === "avatar" ? home.avatar : (home.blocks.find((b) => b.id === which) || {}).image;
  return data ? appImageData(data) : null;
}

// Which blocks a shopper sees — the same rule the widget applies, kept here
// so the eval can pin it down: signed out → "all" and "guest"; signed in →
// "all", "signed", and "tag" when they carry the tag (case doesn't matter).
export function blocksFor(blocks, { signedIn = false, tags = [] } = {}) {
  const mine = new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  return (blocks || []).filter((b) => b.audience === "all" || (b.audience === "guest" ? !signedIn : signedIn && (b.audience === "signed" || (b.audience === "tag" && b.tag && mine.has(b.tag.trim().toLowerCase())))));
}

// Peak Mode's home (Settings → Peak Mode → The home on peak days): while
// Peak Mode is on, the chat's home shows the day's pictures where the
// banner was — each a picture and nothing else, opening a link or asking
// AVA a question when tapped — laid out as a rail that scrolls sideways,
// a mosaic (one big, the rest around it) or a grid; a peak picture of the
// assistant; and the assistant's colours for the days (the glow around
// her face, the ring and the line), a few sets or the store's own. Every
// picture says who sees it: everyone, shoppers signed out, shoppers signed
// in, or signed-in customers carrying a Shopify tag. The widget does the
// choosing with what the page knows about the shopper; the server only
// hands the home over while Peak Mode is on.
//
// Stored as one JSON (pictures as resized data URLs, like the app's
// picture, or as Shopify Files links; videos always as Shopify Files
// links); the route turns a data URL into bytes. Pure.
import { appImageData, appImageValue, appImageLink, cdnVideoUrl } from "./app-promo.js";
import { peakState } from "./peak-mode.js";

export const PEAK_IMAGE_PATH = "/apps/hajirai/peak-image";
// The smaller copies an uploaded picture may carry (widths), and the sizes
// asked of Shopify's CDN for a Files picture.
export const PEAK_PICTURE_SIZES = [400, 800];
const CDN_SIZES = [400, 800, 1200, 1600, 2000];
// For the widget: the picture's candidates by width (an <img> srcset) — the
// CDN's sizes for a Files picture; an upload's smaller copies and itself.
export function peakSrcset(image, link, { imageW = 0, sizes = [] } = {}) {
  if (!image) return "";
  if (/^https:\/\/cdn\.shopify\.com\//i.test(image)) return CDN_SIZES.map((w) => `${image}${image.includes("?") ? "&" : "?"}width=${w} ${w}w`).join(", ");
  if (!link || !sizes.length) return "";
  const parts = sizes.map((w) => `${link}&w=${w} ${w}w`);
  if (imageW) parts.push(`${link} ${imageW}w`);
  return parts.join(", ");
}
export const PEAK_BLOCKS_MAX = 6;
export const PEAK_MAX = { eyebrow: 24, title: 60, text: 120, cta: 24, tag: 40, url: 500, message: 200 };
export const PEAK_AUDIENCES = ["all", "guest", "signed", "tag"];
export const PEAK_AUDIENCE_WORDS = { all: "Everyone", guest: "Signed out", signed: "Signed in", tag: "Customers with a tag" };
// How the pictures sit: a rail that scrolls sideways (two and a half in
// view on a computer, one and a quarter on a phone), a mosaic (the first
// picture big, the rest around it), or a grid (two across).
export const PEAK_LAYOUTS = ["rail", "mosaic", "grid"];
export const PEAK_LAYOUT_WORDS = { rail: "Rail — scrolls sideways", mosaic: "Mosaic — one big, the rest around it", grid: "Grid — two across" };
// The pictures' shape (every tile in a layout shares it).
export const PEAK_SHAPES = { wide: "16 / 9", standard: "4 / 3", square: "1 / 1" };
export const PEAK_SHAPE_WORDS = { wide: "Wide (16 : 9)", standard: "Standard (4 : 3)", square: "Square" };
// The assistant's colours on peak days — the glow around her face, the
// ring and the line: a few sets to pick from, or up to four of the store's
// own. Empty: her usual colours.
export const PEAK_COLOR_SETS = [
  { id: "usual", label: "Her usual colours", colors: [] },
  { id: "festive", label: "Festive — red, green and gold", colors: ["#d42b3a", "#1f7a4d", "#e9b949", "#8f1d2b"] },
  { id: "winter", label: "Winter — ice blue and silver", colors: ["#8fd3ff", "#5b8def", "#e6f4ff", "#a7b8ff"] },
  { id: "autumn", label: "Autumn — orange, rust and gold", colors: ["#ff8a3d", "#d9452b", "#f2c14e", "#a0522d"] },
  { id: "love", label: "Valentine — pinks and reds", colors: ["#ff4f8b", "#ffa3bd", "#c2185b", "#ff7aa8"] },
  { id: "spring", label: "Spring — mint, lemon and sky", colors: ["#7bd389", "#ffd166", "#ff9fb2", "#9ad0ff"] },
];
export const PEAK_COLORS_MAX = 4;
// Where a picture is anchored when it's cropped to the tile's shape (the
// CSS object-position words): the centre as usual, or an edge or corner.
export const PEAK_FOCUS = ["center", "left", "right", "top", "bottom", "top left", "top right", "bottom left", "bottom right"];
// Her look on peak days, beyond the colours: the ring around her face
// (fine as usual, or thicker); a curved line of the set's gold under the
// header at the right, with a soft glow, in place of the header's grey
// line on the home; and a faint tint of the first colour behind the header.
export const PEAK_RINGS = ["fine", "regular", "bold"];
export const PEAK_RING_WORDS = { fine: "Fine — as usual", regular: "Regular", bold: "Bold" };
export const PEAK_DECORS = ["off", "line"];
export const PEAK_DECOR_WORDS = { off: "Nothing", line: "A curved line of gold, glowing" };
const HEX = /^#[0-9a-f]{6}$/i;
// Up to four colours, each a 6-digit hex (lowercase), in order; none → [].
export function cleanPeakColors(list) {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) { const c = String(v || "").trim().toLowerCase(); if (HEX.test(c)) out.push(c); if (out.length >= PEAK_COLORS_MAX) break; }
  return out;
}

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const cleanUrl = (v) => { const s = String(v ?? "").trim().slice(0, PEAK_MAX.url); return /^https?:\/\/[^\s"'<>]+$|^\/[^\s"'<>]*$/i.test(s) ? s : ""; };
const cleanId = (v, i) => { const s = String(v ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12); return s || `b${i + 1}`; };
const parseJson = (v) => { if (v && typeof v === "object") return v; try { return JSON.parse(v); } catch { return null; } };

// A picture as stored: a data URL within the size limit, or a Shopify
// Files link; else "". A video is always a Shopify Files link.
const picture = (v) => appImageValue(v);

// The saved JSON → clean { avatar, layout, shape, colors, blocks }. Blocks
// without a picture are dropped; the name is only for screen readers.
export function parsePeakHome(raw) {
  const o = parseJson(raw);
  const out = { avatar: "", layout: "rail", shape: "wide", colors: [], ring: "fine", decor: "off", tint: false, blocks: [] };
  if (!o || typeof o !== "object") return out;
  out.avatar = picture(o.avatar);
  out.layout = PEAK_LAYOUTS.includes(o.layout) ? o.layout : "rail";
  out.shape = Object.prototype.hasOwnProperty.call(PEAK_SHAPES, o.shape) ? o.shape : "wide";
  out.colors = cleanPeakColors(o.colors);
  out.ring = PEAK_RINGS.includes(o.ring) ? o.ring : "fine";
  // The ornaments of an earlier day ("header", "both") are read as the line, so a store that had them keeps a line of gold.
  out.decor = PEAK_DECORS.includes(o.decor) ? o.decor : /^(header|both)$/.test(String(o.decor || "")) ? "line" : "off";
  out.tint = o.tint === true;
  const seen = new Set();
  for (const [i, b] of (Array.isArray(o.blocks) ? o.blocks : []).entries()) {
    if (!b || typeof b !== "object") continue;
    const image = picture(b.image);
    const video = cdnVideoUrl(b.video);
    if (!image && !video) continue;
    // An uploaded picture may come with smaller copies of itself (made in
    // Settings), so a screen gets one near the size it draws; a Shopify
    // Files picture has the CDN's sizes instead.
    const own = !!appImageData(image);
    const imageW = own ? Math.min(4000, Math.max(0, Math.round(Number(b.imageW) || 0))) : 0;
    const smaller = {};
    if (own) for (const w of PEAK_PICTURE_SIZES) { const v = b[`image${w}`]; if (appImageData(v) && (!imageW || w < imageW)) smaller[`image${w}`] = String(v); }
    let id = cleanId(b.id, i);
    while (seen.has(id)) id = `${id}x`;
    seen.add(id);
    const kind = b.kind === "ask" ? "ask" : b.kind === "none" ? "none" : "link";
    const audience = PEAK_AUDIENCES.includes(b.audience) ? b.audience : "all";
    out.blocks.push({
      id,
      title: clean(b.title, PEAK_MAX.title),
      kind,
      url: kind === "link" ? cleanUrl(b.url) : "",
      message: kind === "ask" ? clean(b.message, PEAK_MAX.message) : "",
      image,
      ...(imageW ? { imageW } : {}),
      ...smaller,
      video,
      focus: PEAK_FOCUS.includes(b.focus) ? b.focus : "center",
      audience,
      tag: audience === "tag" ? clean(b.tag, PEAK_MAX.tag) : "",
    });
    if (out.blocks.length >= PEAK_BLOCKS_MAX) break;
  }
  return out;
}

// What's wrong with what Settings sent ("" when nothing): a picture too
// large or missing, a tag audience without a tag, a tap without its link
// or question. A block with nothing in it at all is simply left out.
export function peakHomeError(raw) {
  const o = parseJson(raw);
  if (!o || typeof o !== "object") return "";
  if (o.avatar && !appImageData(o.avatar)) return "The peak picture of the assistant is too large — pick a smaller one.";
  for (const [i, b] of (Array.isArray(o.blocks) ? o.blocks : []).entries()) {
    if (!b || typeof b !== "object") continue;
    const n = `Picture ${i + 1}`;
    const filled = clean(b.title, PEAK_MAX.title) || cleanUrl(b.url) || clean(b.message, PEAK_MAX.message) || clean(b.tag, PEAK_MAX.tag);
    if (b.image && !appImageValue(b.image)) return appImageData(b.image) === null && /^data:/.test(String(b.image)) ? `${n}: the picture is too large — pick a smaller one.` : `${n}: pick the picture from your Shopify files, or upload one.`;
    if (b.video && !cdnVideoUrl(b.video)) return `${n}: pick the video from your Shopify files (an MP4 or WebM).`;
    if (!b.image && !b.video) { if (filled) return `${n}: add the picture or video (or remove the block).`; continue; }
    if (b.audience === "tag" && !clean(b.tag, PEAK_MAX.tag)) return `${n}: name the customer tag that sees it.`;
    if (b.kind === "ask" && !clean(b.message, PEAK_MAX.message)) return `${n}: a tap asks AVA — write the question.`;
    if (b.kind !== "ask" && b.kind !== "none" && !cleanUrl(b.url)) return `${n}: a tap opens a link — give it one (https://… or /…).`;
  }
  return "";
}

// For widget-config: the home's peak look while Peak Mode is on, else null.
// Pictures become links that carry their fingerprint (cached for good).
export function peakHomeConfig(config = {}, now = new Date(), { force = false } = {}) {
  if (!force && !peakState(config, now).active) return null;
  const home = parsePeakHome(config.peakHome);
  const link = (which, data) => appImageLink(data, (v) => `${PEAK_IMAGE_PATH}?b=${encodeURIComponent(which)}&v=${v}`);
  const srcsetOf = (b) => peakSrcset(b.image, appImageData(b.image) ? link(b.id, b.image) : "", { imageW: b.imageW || 0, sizes: PEAK_PICTURE_SIZES.filter((w) => b[`image${w}`]) });
  const blocks = home.blocks.map((b) => ({
    id: b.id, title: b.title,
    ...(b.kind === "ask" ? { message: b.message } : b.kind === "link" ? { url: b.url } : {}),
    image: link(b.id, b.image),
    ...(srcsetOf(b) ? { srcset: srcsetOf(b) } : {}),
    ...(b.video ? { video: b.video } : {}),
    ...(b.focus !== "center" ? { focus: b.focus } : {}),
    audience: b.audience, tag: b.tag,
  }));
  const look = home.ring !== "fine" || home.decor !== "off" || home.tint;
  if (!blocks.length && !home.avatar && !home.colors.length && !look) return null;
  return { avatar: link("avatar", home.avatar), layout: home.layout, shape: home.shape, colors: home.colors, ring: home.ring, decor: home.decor, tint: home.tint, blocks };
}

// The route: the picture behind ?b=avatar or ?b=<block id>.
export function peakImage(config = {}, which, width = 0) {
  const home = parsePeakHome(config?.peakHome);
  const block = which === "avatar" ? null : home.blocks.find((b) => b.id === which) || {};
  const w = PEAK_PICTURE_SIZES.includes(Number(width)) ? Number(width) : 0;
  const data = which === "avatar" ? home.avatar : (w && block[`image${w}`]) || block.image;
  return data ? appImageData(data) : null;
}

// Which blocks a shopper sees — the same rule the widget applies, kept here
// so the eval can pin it down: signed out → "all" and "guest"; signed in →
// "all", "signed", and "tag" when they carry the tag (case doesn't matter).
export function blocksFor(blocks, { signedIn = false, tags = [] } = {}) {
  const mine = new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  return (blocks || []).filter((b) => b.audience === "all" || (b.audience === "guest" ? !signedIn : signedIn && (b.audience === "signed" || (b.audience === "tag" && b.tag && mine.has(b.tag.trim().toLowerCase())))));
}

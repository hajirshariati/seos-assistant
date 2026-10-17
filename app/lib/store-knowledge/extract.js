// Store knowledge — turn storefront HTML into clean, sectioned text. Pure.
//
// Policies, page bodies and blog articles come from the Admin API as HTML;
// theme-built pages (sections, not a body) are read from the theme's page
// template, or from the live storefront. Either way we keep headings as
// "## …" lines so the chunker splits on real sections, keep links to outside
// sources (a published study, a PDF) so the assistant can point to them, and
// drop everything that isn't content (scripts, menus, footers, forms, and the
// duplicate mobile/desktop blocks themes render).

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", trade: "™", reg: "®", copy: "©", deg: "°",
};

export function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

const DROP_BLOCKS = ["script", "style", "noscript", "svg", "template", "iframe", "head", "header", "footer", "nav", "form", "button", "select", "dialog"];

const SHARE_LINK = /\/(?:sharer|share|intent)\b|\/pin\/create|[?&]share=/i;
const bareHost = (h) => String(h || "").toLowerCase().replace(/^www\./, "");

// "Read the study" → "Read the study (https://doi.org/…)" for links that leave
// the store; links back into the store (menus, old URLs) are just text.
function keepOutsideLinks(s, ownHosts) {
  const own = (ownHosts || []).map(bareHost).filter(Boolean);
  return s.replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    const label = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    let url;
    try { url = new URL(decodeEntities(href)); } catch { return inner; }
    if (!/^https?:$/.test(url.protocol) || SHARE_LINK.test(url.href)) return inner;
    const host = bareHost(url.hostname);
    if (own.some((o) => host === o || host.endsWith(`.${o}`))) return inner;
    if (!label) return " ";
    return label.includes(url.href) ? inner : `${inner} (${url.href})`;
  });
}

export function htmlToText(html, { ownHosts = [] } = {}) {
  let s = String(html || "");
  if (!s.trim()) return "";
  // Prefer the page's main content when the theme marks it.
  const main = s.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) s = main[1];
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of DROP_BLOCKS) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  // Common non-content regions themes leave inside <main>.
  s = s.replace(/<([a-z0-9]+)\b[^>]*(?:aria-hidden="true"|class="[^"]*\b(?:visually-hidden|cookie|announcement|breadcrumb|newsletter|drawer|modal|popup)\b[^"]*")[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = keepOutsideLinks(s, ownHosts);
  s = s
    .replace(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi, (_, t) => `\n\n## ${t.replace(/<[^>]+>/g, " ").trim()}\n\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:td|th)>/gi, " | ")
    .replace(/<(?:br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/?(?:p|div|section|article|tr|table|ul|ol|blockquote|h5|h6|dl|dt|dd)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);

  const lines = [];
  const seen = new Set();
  for (const raw of s.split(/\n/)) {
    const line = raw.replace(/[ \t\u00a0]+/g, " ").replace(/\s+\|\s*$/, "").trim();
    if (!line) { if (lines.length && lines[lines.length - 1] !== "") lines.push(""); continue; }
    if (/^##\s*$/.test(line) || /^-\s*$/.test(line)) continue;
    // Themes render the same block twice (mobile + desktop); keep the first.
    const key = line.toLowerCase();
    if (line.length > 25 && seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Theme page templates (templates/page.<suffix>.json) ──────────
// Theme-built pages keep their words in section settings. Walk the sections
// in display order (skipping hidden ones) and keep the text settings, plus
// each button/link with its label, so a "Read the study" button becomes
// "Read the study: https://…". Styling settings (sizes, colors, alignment…)
// are never text.
const TEXT_KEY = /(?:^|_)(?:heading|subheading|title|subtitle|text|description|content|caption|richtext|html|question|answer|quote|body|message|footnote|disclaimer|note|liquid)(?:_\d+)?$/;
const NOT_TEXT_KEY = /size|tag|font|color|colour|alignment|position|style|scribble|highlight|spacing|capitalize|width|height|gradient|padding|opacity|parallax|layout|ratio|icon/;
const LINK_KEY = /(?:^|_)(?:link|url)(?:_\d+)?$/;

export function parseThemeJson(raw) {
  const s = String(raw || "").replace(/^\s*\/\*[\s\S]*?\*\//, "");
  try { return JSON.parse(s); } catch { return null; }
}

function themeLink(value, domain) {
  const v = String(value || "").trim();
  const m = v.match(/^shopify:\/\/(pages|collections|products|blogs)\/(.+)$/);
  if (m) return `${domain}/${m[1]}/${m[2]}`;
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("/") && !v.startsWith("//")) return `${domain}${v}`;
  return "";
}

function settingsText(settings = {}, domain) {
  const out = [];
  for (const [key, value] of Object.entries(settings || {})) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (LINK_KEY.test(key) && !/video/.test(key)) {
      const url = themeLink(value, domain);
      if (!url) continue;
      const label = String(settings[key.replace(LINK_KEY, (x) => x.replace(/link|url/, "label"))] || settings.label || "").trim();
      out.push(label ? `${label}: ${url}` : url);
      continue;
    }
    if (!TEXT_KEY.test(key) || NOT_TEXT_KEY.test(key)) continue;
    // Liquid placeholders render store data we read elsewhere; drop them.
    const cleaned = value.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g, " ");
    // Single lower-case tokens ("none", "circle", "primary") are option
    // values; a one-word heading ("Shipping") is still text.
    if (!/\s|</.test(cleaned.trim()) && !(/heading|title/.test(key) && /[A-Z]/.test(cleaned))) continue;
    let text = /</.test(cleaned) ? htmlToText(`<div>${cleaned}</div>`) : cleaned.trim();
    // A one-line heading/title setting starts a section, like an <h2> would.
    if (/heading|title/.test(key) && !text.includes("\n") && text.length < 120 && !text.startsWith("## ")) text = `## ${text}`;
    if (text) out.push(text);
  }
  return out;
}

export function themeTemplateText(template, { domain = "" } = {}) {
  const t = typeof template === "string" ? parseThemeJson(template) : template;
  if (!t || typeof t.sections !== "object") return "";
  const parts = [];
  const order = Array.isArray(t.order) ? t.order : Object.keys(t.sections);
  for (const id of order) {
    const sec = t.sections[id];
    if (!sec || sec.disabled) continue;
    parts.push(...settingsText(sec.settings, domain));
    const blocks = sec.blocks || {};
    const blockOrder = Array.isArray(sec.block_order) ? sec.block_order : Object.keys(blocks);
    for (const bid of blockOrder) {
      const b = blocks[bid];
      if (!b || b.disabled) continue;
      parts.push(...settingsText(b.settings, domain));
    }
  }
  const lines = [];
  const seen = new Set();
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(p);
  }
  return lines.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseSitemap(xml) {
  const locs = [...String(xml || "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]));
  const isIndex = /<sitemapindex\b/i.test(String(xml || ""));
  return isIndex ? { sitemaps: locs, urls: [] } : { sitemaps: [], urls: locs };
}

// Store policy → slug used on the storefront (/policies/<slug>).
export const POLICY_SLUGS = {
  REFUND_POLICY: "refund-policy",
  SHIPPING_POLICY: "shipping-policy",
  TERMS_OF_SERVICE: "terms-of-service",
  PRIVACY_POLICY: "privacy-policy",
  CONTACT_INFORMATION: "contact-information",
  LEGAL_NOTICE: "legal-notice",
  TERMS_OF_SALE: "terms-of-sale",
  SUBSCRIPTION_POLICY: "subscription-policy",
};

// Split a document on its "## " headings so every chunk knows which section
// it came from ("Returns", "International shipping"…). Tiny sections are
// folded into the one before so a lone heading doesn't become its own chunk.
export function splitSections(content, { minChars = 200 } = {}) {
  const out = [];
  let cur = { heading: null, text: "" };
  for (const line of String(content || "").split("\n")) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      if (cur.text.trim()) out.push(cur);
      cur = { heading: h[1].trim(), text: "" };
    } else {
      cur.text += `${line}\n`;
    }
  }
  if (cur.text.trim()) out.push(cur);
  const merged = [];
  for (const s of out) {
    const text = s.text.trim();
    const prev = merged[merged.length - 1];
    if (prev && text.length < minChars) {
      prev.text += `\n\n${s.heading ? `${s.heading}\n` : ""}${text}`;
    } else {
      merged.push({ heading: s.heading, text });
    }
  }
  return merged;
}

const MAX_DOC_CHARS = 40000;

// A document ready for chunking: title line, source line, then the text.
export function toKnowledgeDoc({ kind, handle, title, url, text }) {
  const body = String(text || "").trim().slice(0, MAX_DOC_CHARS);
  return {
    kind,
    handle,
    title: String(title || handle || "").trim(),
    url: url || "",
    content: `${String(title || handle).trim()}\n\nSource: ${url || ""}\n\n${body}`,
    chars: body.length,
  };
}

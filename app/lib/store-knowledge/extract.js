// Store knowledge — turn storefront HTML into clean, sectioned text. Pure.
//
// Policies and page bodies come from the Admin API as HTML; theme-built pages
// (sections, not a body) are fetched from the live storefront. Either way we
// keep headings as "## …" lines so the chunker splits on real sections, and
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

export function htmlToText(html) {
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

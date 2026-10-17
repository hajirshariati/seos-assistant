import prisma from "../db.server";

// What the chat assistant reads on every turn.
// `now` parameter exists so callers can pass a stable timestamp during
// a single request (avoids a campaign starting/ending mid-stream).
export async function getActiveCampaigns(shop, now = new Date()) {
  if (!shop) return [];
  return prisma.campaign.findMany({
    where: {
      shop,
      startsAt: { lte: now },
      endsAt: { gte: now },
    },
    orderBy: { startsAt: "asc" },
    select: { id: true, name: true, content: true, startsAt: true, endsAt: true },
  });
}

export async function listCampaigns(shop) {
  if (!shop) return [];
  return prisma.campaign.findMany({
    where: { shop },
    orderBy: [{ startsAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, name: true, content: true, startsAt: true, endsAt: true, createdAt: true, updatedAt: true },
  });
}

export async function saveCampaign(shop, { id, name, content, startsAt, endsAt }) {
  if (!shop) throw new Error("shop required");
  const data = {
    name: String(name || "").trim().slice(0, 200),
    content: String(content || "").trim().slice(0, 20000),
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
  };
  if (!data.name || !data.content) throw new Error("name and content required");
  if (!(data.startsAt instanceof Date) || isNaN(+data.startsAt)) throw new Error("invalid startsAt");
  if (!(data.endsAt instanceof Date) || isNaN(+data.endsAt)) throw new Error("invalid endsAt");
  if (+data.endsAt <= +data.startsAt) throw new Error("endsAt must be after startsAt");

  if (id) {
    // Only this shop's campaign — an id from another shop changes nothing.
    const { count } = await prisma.campaign.updateMany({ where: { id, shop }, data });
    if (count !== 1) throw new Error("campaign not found");
    return prisma.campaign.findFirst({ where: { id, shop } });
  }
  return prisma.campaign.create({ data: { ...data, shop } });
}

export async function deleteCampaign(shop, id) {
  if (!shop || !id) return;
  await prisma.campaign.deleteMany({ where: { id, shop } });
}

// Mirror of the runtime SKU pattern in app/routes/chat.jsx. Kept
// duplicated so this file has no cross-imports of route code; the
// pattern shape hasn't changed, divergence risk is low.
const SKU_PATTERN = /\b[A-Z]{1,2}\d{3,5}[A-Z]?\b/g;

// Save-time validation. Extracts every SKU-shaped token from the
// campaign content and cross-references against the merchant's
// synced catalog. Returns the list of tokens that did NOT resolve to
// a real ProductVariant.sku, Product handle token, or Product title
// token. The caller surfaces these as a soft warning — typos like
// "L5OO" (letter O instead of zero) get caught before customers see
// fabricated promo info.
//
// Tolerant in two ways:
//   • Strips trailing single uppercase letter (gender suffix) before
//     comparing — "L500M" passes if "L500" exists in the catalog.
//   • Accepts a SKU mention if it appears as a token in any product
//     title or handle (some catalogs encode SKU in handle, not in
//     ProductVariant.sku).
//
// Returns [] for empty content. Never throws — DB errors are
// swallowed and treated as "no validation possible" so a broken
// catalog sync can't block campaign saves.
export async function findUnknownSkus(shop, content) {
  if (!shop || !content) return [];
  const matches = String(content).match(SKU_PATTERN) || [];
  if (matches.length === 0) return [];

  const seen = new Set();
  const tokens = [];
  for (const raw of matches) {
    const sku = raw.toUpperCase();
    if (seen.has(sku)) continue;
    seen.add(sku);
    tokens.push(sku);
  }

  let products;
  try {
    products = await prisma.product.findMany({
      where: { shop },
      select: { handle: true, title: true, variants: { select: { sku: true } } },
    });
  } catch (err) {
    console.error("[Campaign.findUnknownSkus] catalog read failed:", err?.message);
    return [];
  }

  const knownSkus = new Set();
  const titleTokens = new Set();
  for (const p of products || []) {
    if (p.handle) {
      for (const t of String(p.handle).toLowerCase().split(/[-_/]/).filter((x) => x.length >= 3)) {
        titleTokens.add(t);
      }
    }
    for (const t of String(p.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((x) => x.length >= 3)) {
      titleTokens.add(t);
    }
    for (const v of p.variants || []) {
      if (v.sku) knownSkus.add(String(v.sku).toUpperCase().trim());
    }
  }

  return tokens.filter((t) => {
    const base = t.replace(/[A-Z]$/, "");
    if (knownSkus.has(t) || knownSkus.has(base)) return false;
    if (titleTokens.has(t.toLowerCase()) || titleTokens.has(base.toLowerCase())) return false;
    return true;
  });
}

// Plain-text template the merchant copy/pastes into the content
// field. Name and dates are NOT included — those live in their own
// structured fields and the system prompt formats them automatically
// from the database, so duplicating them here would invite drift.
export const CAMPAIGN_TEMPLATE = `## What's on sale
- [Eligible products or categories — e.g. all women's boots, all orthotics, sitewide except gift cards]
- [Any explicit exclusions — e.g. excludes already-discounted items, sale items, gift cards]

## How the discount works
- [Mechanic — e.g. 20% off automatically at checkout / Buy 2 Get 1 Free / Free shipping over $75]
- [Code, if any — e.g. SUMMER20]
- [Stacking rules — e.g. cannot be combined with other codes]
- [Limit — e.g. one use per customer]

## Returns and exchanges
- [Same as standard policy / sale items final sale / etc.]

## Anything else customers ask about
- [Free gift threshold, BOGO mechanic details, gift wrap, expedited shipping cutoffs, etc.]
`;

// Server-rendered, deterministic dump of every currently-active
// campaign. Used by the CS-team cheat-code path in chat.jsx — bypasses
// the AI so CS agents see the exact same text every time.
export function formatCampaignsForCS(activeCampaigns, now = new Date()) {
  const list = Array.isArray(activeCampaigns) ? activeCampaigns : [];
  if (list.length === 0) {
    return "No active campaigns right now.";
  }
  const fmtDate = (d) => {
    try { return new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
    catch { return String(d); }
  };
  const blocks = list.map((c) => {
    return `**${c.name}**\nActive: ${fmtDate(c.startsAt)} – ${fmtDate(c.endsAt)}\n\n${c.content}`;
  });
  const header = `Active campaigns (${list.length}) — as of ${fmtDate(now)}`;
  return `${header}\n\n${blocks.join("\n\n———\n\n")}`;
}

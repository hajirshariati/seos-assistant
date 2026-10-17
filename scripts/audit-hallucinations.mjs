// Read-only batch audit of historical chat responses against the
// merchant's actual catalog. Scans ChatFeedback (👍/👎) records,
// extracts every product/SKU/brand-line claim the AI made, and flags
// claims that don't resolve to a real product or variant.
//
// This complements the lean engine's runtime fact check
// (verifyLeanAnswer), which runs per response. THIS script gives you a post-hoc, batch view of how often the
// hallucination patterns are firing, what the model is making up, and
// whether the runtime guards are catching it — useful before a demo.
//
// READ-ONLY. Touches no production code paths. Cannot affect chat.
//
// USAGE
//   node scripts/audit-hallucinations.mjs
//   node scripts/audit-hallucinations.mjs --shop=foo.myshopify.com
//   node scripts/audit-hallucinations.mjs --days=14 --limit=500
//   node scripts/audit-hallucinations.mjs --vote=all      # incl. 👍
//   node scripts/audit-hallucinations.mjs --json          # machine-readable
//
// OUTPUT
//   Console summary + a JSON report at scripts/audit-hallucinations.json
//   listing every flagged response with the suspicious phrase and why.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "audit-hallucinations.json");

const args = process.argv.slice(2);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const hasFlag = (name) => args.includes(`--${name}`);
const shopArg = arg("shop");
const limitArg = Number(arg("limit")) || 500;
const sinceDays = Number(arg("days")) || 30;
const voteFilter = arg("vote") || "all";
const jsonOnly = hasFlag("json");

// Mirror of the runtime SKU pattern in app/routes/chat.jsx so this
// audit catches the same shapes the chat strips at request time.
const SKU_PATTERN = /\b[A-Z]{1,2}\d{3,5}[A-Z]?\b/g;

// Definitional-hallucination shape ("X is our premium line…").
const DEFINITIONAL_RE = /\b(?:[A-Z][\w-]{2,}\s+(?:is|are)\s+(?:our|an?|the)\s+(?:premium|signature|exclusive|new|advanced|patented|proprietary|flagship|line|technology|orthotic|insole|footbed|brand|collection|series))\b/g;

const { default: prisma } = await import("../app/db.server.js");

const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
const where = { createdAt: { gte: since } };
if (voteFilter !== "all") where.vote = voteFilter;
if (shopArg) where.shop = shopArg;

const feedback = await prisma.chatFeedback.findMany({
  where,
  orderBy: { createdAt: "desc" },
  take: limitArg,
  select: {
    id: true,
    shop: true,
    vote: true,
    botResponse: true,
    conversation: true,
    createdAt: true,
  },
});

if (feedback.length === 0) {
  console.log(`No ChatFeedback records in the last ${sinceDays} days${shopArg ? ` for ${shopArg}` : ""}.`);
  await prisma.$disconnect();
  process.exit(0);
}

// Group feedback by shop so we hit the catalog once per shop.
const byShop = new Map();
for (const f of feedback) {
  if (!byShop.has(f.shop)) byShop.set(f.shop, []);
  byShop.get(f.shop).push(f);
}

// Build catalog index per shop: SKUs (variant.sku) + tokens (words from
// product titles + handles). Token set is used for "did the model
// reference a real product family?" — case-insensitive, word-boundary.
async function buildCatalogIndex(shop) {
  const products = await prisma.product.findMany({
    where: { shop },
    select: { handle: true, title: true, vendor: true, variants: { select: { sku: true } } },
  });
  const skuSet = new Set();
  const titleTokenSet = new Set();
  const titleSet = new Set();
  for (const p of products) {
    titleSet.add(String(p.title || "").toLowerCase().trim());
    const tokens = String(p.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3);
    for (const t of tokens) titleTokenSet.add(t);
    if (p.handle) {
      for (const t of String(p.handle).toLowerCase().split(/[-_/]/).filter((x) => x.length >= 3)) {
        titleTokenSet.add(t);
      }
    }
    if (p.vendor) titleTokenSet.add(String(p.vendor).toLowerCase().trim());
    for (const v of p.variants || []) {
      if (v.sku) skuSet.add(String(v.sku).toUpperCase().trim());
    }
  }
  return { skuSet, titleTokenSet, titleSet, productCount: products.length };
}

function lastAssistantText(record) {
  // Prefer the explicit assistant turn from the captured conversation;
  // fall back to botResponse if conversation is missing.
  if (record.conversation) {
    try {
      const conv = JSON.parse(record.conversation);
      if (Array.isArray(conv)) {
        for (let i = conv.length - 1; i >= 0; i--) {
          if (conv[i]?.role === "assistant" && typeof conv[i].content === "string") {
            return conv[i].content;
          }
        }
      }
    } catch { /* fall through */ }
  }
  return String(record.botResponse || "");
}

const flags = [];
let scanned = 0;

for (const [shop, records] of byShop) {
  const idx = await buildCatalogIndex(shop);
  if (idx.productCount === 0) {
    console.warn(`[warn] ${shop}: no catalog products synced — skipping ${records.length} record(s).`);
    continue;
  }

  for (const r of records) {
    scanned++;
    const text = lastAssistantText(r);
    if (!text) continue;

    const violations = [];

    // 1. Orphan SKUs — every SKU-shaped token in the text must match
    //    a real ProductVariant.sku for this shop.
    const seenSku = new Set();
    for (const raw of text.match(SKU_PATTERN) || []) {
      const sku = raw.toUpperCase();
      if (seenSku.has(sku)) continue;
      seenSku.add(sku);
      // Tolerant match: "L500M" or "L500W" → "L500" (gender suffix)
      const base = sku.replace(/[A-Z]$/, "");
      if (!idx.skuSet.has(sku) && !idx.skuSet.has(base)) {
        // Some catalogs store SKU on the product not the variant — also
        // accept SKU-as-substring of any title token (rare but valid).
        if (!idx.titleTokenSet.has(sku.toLowerCase()) && !idx.titleTokenSet.has(base.toLowerCase())) {
          violations.push({ kind: "orphan-sku", value: sku });
        }
      }
    }

    // 2. Definitional hallucinations — "Lynco is our premium orthotic
    //    line" type sentences. Verify the named brand/line resolves to
    //    a known token (vendor or title token) in the catalog.
    DEFINITIONAL_RE.lastIndex = 0;
    let m;
    while ((m = DEFINITIONAL_RE.exec(text)) !== null) {
      const phrase = m[0];
      const firstWord = phrase.split(/\s+/)[0].toLowerCase();
      if (firstWord && !idx.titleTokenSet.has(firstWord)) {
        violations.push({ kind: "definitional-claim", value: phrase, term: firstWord });
      }
    }

    if (violations.length > 0) {
      flags.push({
        feedbackId: r.id,
        shop,
        vote: r.vote,
        createdAt: r.createdAt.toISOString(),
        textExcerpt: text.length > 400 ? text.slice(0, 400) + "…" : text,
        violations,
      });
    }
  }
}

const summary = {
  scannedRecords: scanned,
  flaggedRecords: flags.length,
  rate: scanned > 0 ? Number((flags.length / scanned).toFixed(4)) : 0,
  byKind: flags.reduce((acc, f) => {
    for (const v of f.violations) acc[v.kind] = (acc[v.kind] || 0) + 1;
    return acc;
  }, {}),
  byShop: flags.reduce((acc, f) => {
    acc[f.shop] = (acc[f.shop] || 0) + 1;
    return acc;
  }, {}),
};

const report = { generatedAt: new Date().toISOString(), params: { sinceDays, voteFilter, limit: limitArg, shop: shopArg || null }, summary, flags };
fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + "\n");

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("");
  console.log(`Hallucination audit — last ${sinceDays} day(s), vote=${voteFilter}${shopArg ? `, shop=${shopArg}` : ""}`);
  console.log("─".repeat(72));
  console.log(`  Scanned responses:   ${summary.scannedRecords}`);
  console.log(`  Flagged responses:   ${summary.flaggedRecords}  (${(summary.rate * 100).toFixed(1)}%)`);
  if (Object.keys(summary.byKind).length > 0) {
    console.log(`  Violations by kind:`);
    for (const [k, n] of Object.entries(summary.byKind)) console.log(`    • ${k}: ${n}`);
  }
  if (Object.keys(summary.byShop).length > 1) {
    console.log(`  Per shop:`);
    for (const [s, n] of Object.entries(summary.byShop)) console.log(`    • ${s}: ${n}`);
  }
  console.log("");
  if (flags.length > 0) {
    console.log("Top 10 flagged responses:");
    for (const f of flags.slice(0, 10)) {
      const kinds = f.violations.map((v) => `${v.kind}=${v.value}`).join(", ");
      console.log(`  [${f.vote}] ${f.shop} ${f.createdAt}`);
      console.log(`    ${kinds}`);
      console.log(`    "${f.textExcerpt.replace(/\n/g, " ").slice(0, 160)}…"`);
    }
    console.log("");
  }
  console.log(`Full report: ${path.relative(process.cwd(), OUT_PATH)}`);
  console.log("");
}

await prisma.$disconnect();

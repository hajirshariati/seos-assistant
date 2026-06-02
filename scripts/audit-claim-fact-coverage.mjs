// Coverage audit for canonical ProductClaimFacts.
//
// For each shop's product catalog, this script funnels every active
// Product row through buildProductClaimFacts and reports the
// percentage of products that produce a non-null/non-empty value
// for each major claim class. Read-only — touches no production
// code paths. Helps spot regressions where a card-emit path is
// losing provenance (e.g. "arch support proof dropped from 100% →
// 23% after sync change X").
//
// USAGE
//   node scripts/audit-claim-fact-coverage.mjs
//   node scripts/audit-claim-fact-coverage.mjs --shop=aetrex.myshopify.com
//   node scripts/audit-claim-fact-coverage.mjs --json
//   node scripts/audit-claim-fact-coverage.mjs --category=wedges-heels
//
// OUTPUT
//   Console table per shop showing the share of products with proof
//   for each claim class, broken out by fact source so it's clear
//   when (e.g.) the brand rule is doing the heavy lifting vs the
//   description scan.
//
//   With --json, also writes scripts/audit-claim-fact-coverage.json
//   for programmatic comparison across runs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "audit-claim-fact-coverage.json");

const args = process.argv.slice(2);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const hasFlag = (name) => args.includes(`--${name}`);
const shopArg = arg("shop");
const categoryArg = arg("category");
const jsonOut = hasFlag("json");

const { default: prisma } = await import("../app/db.server.js");
const { buildProductClaimFacts } = await import("../app/lib/product-claim-facts.server.js");

const shops = shopArg
  ? [shopArg]
  : (await prisma.product.findMany({
      where: { status: "active" },
      distinct: ["shop"],
      select: { shop: true },
    })).map((r) => r.shop);

if (shops.length === 0) {
  console.log("No active products found in DB. Run the catalog sync first.");
  await prisma.$disconnect();
  process.exit(0);
}

const CLAIM_CLASSES = [
  "conditionTags",
  "useCaseTags",
  "archSupport",
  "waterFriendly",
  "onSale",
  "removableInsole",
  "footbed",
  "badge",
  "productLine",
];

function hasProof(claim, fact) {
  if (!fact) return false;
  if (claim === "conditionTags" || claim === "useCaseTags") {
    return Array.isArray(fact.value) && fact.value.length > 0;
  }
  if (claim === "removableInsole") {
    return fact.value === true || fact.value === false;
  }
  if (claim === "footbed" || claim === "badge" || claim === "productLine") {
    return typeof fact.value === "string" && fact.value.length > 0;
  }
  // booleans (archSupport, waterFriendly, onSale): truth = positive proof.
  return fact.value === true;
}

const report = {};

for (const shop of shops) {
  const products = await prisma.product.findMany({
    where: { shop, status: "active" },
    select: {
      handle: true,
      title: true,
      productType: true,
      description: true,
      tags: true,
      attributesJson: true,
    },
  });
  if (products.length === 0) continue;

  const totals = { total: products.length };
  const sources = {};
  for (const claim of CLAIM_CLASSES) {
    totals[claim] = 0;
    sources[claim] = new Map();
  }

  let filteredCount = 0;

  for (const p of products) {
    const attrs = (() => {
      const j = p.attributesJson;
      if (!j) return {};
      if (typeof j === "string") {
        try { return JSON.parse(j); } catch { return {}; }
      }
      return j;
    })();
    const canonical = {
      title: p.title,
      handle: p.handle,
      productType: p.productType,
      description: p.description || "",
      descriptionSnippet: "",
      tags: Array.isArray(p.tags) ? p.tags : [],
      attributes: attrs,
    };
    const facts = buildProductClaimFacts(canonical, { shop });
    const category = facts.category?.value || null;

    if (categoryArg && category !== categoryArg) continue;
    filteredCount += 1;

    for (const claim of CLAIM_CLASSES) {
      const fact = facts[claim];
      const source = fact?.source || "none";
      const count = sources[claim].get(source) || 0;
      sources[claim].set(source, count + 1);
      if (hasProof(claim, fact)) totals[claim] += 1;
    }
  }

  if (categoryArg) totals.total = filteredCount;

  report[shop] = {
    total: totals.total,
    coverage: Object.fromEntries(
      CLAIM_CLASSES.map((c) => [
        c,
        {
          withProof: totals[c],
          pct: totals.total > 0 ? +((100 * totals[c]) / totals.total).toFixed(1) : 0,
          sources: Object.fromEntries(sources[c]),
        },
      ]),
    ),
  };
}

// ─── render ────────────────────────────────────────────────────

for (const [shop, data] of Object.entries(report)) {
  const filterNote = categoryArg ? ` [category=${categoryArg}]` : "";
  console.log(`\n=== ${shop}${filterNote} — ${data.total} active product(s) ===`);
  const rows = CLAIM_CLASSES.map((c) => {
    const row = data.coverage[c];
    const sourceBreakdown = Object.entries(row.sources)
      .filter(([, n]) => n > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([src, n]) => `${src}=${n}`)
      .join(" ");
    return {
      claim: c,
      proof: `${row.withProof}/${data.total}`,
      pct: `${row.pct}%`,
      sources: sourceBreakdown,
    };
  });
  const claimW = Math.max(...rows.map((r) => r.claim.length), 5);
  const proofW = Math.max(...rows.map((r) => r.proof.length), 5);
  const pctW = 6;
  console.log(
    "  " +
      "claim".padEnd(claimW) + "  " +
      "proof".padEnd(proofW) + "  " +
      "pct".padEnd(pctW) + "  " +
      "sources",
  );
  for (const r of rows) {
    console.log(
      "  " +
        r.claim.padEnd(claimW) + "  " +
        r.proof.padEnd(proofW) + "  " +
        r.pct.padEnd(pctW) + "  " +
        r.sources,
    );
  }
}

if (jsonOut) {
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${OUT_PATH}`);
}

await prisma.$disconnect();

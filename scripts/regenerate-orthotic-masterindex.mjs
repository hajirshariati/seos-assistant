// Regenerate the Aetrex orthotic recommender's masterIndex from the
// LIVE Shopify catalog. Talks to Shopify Admin API directly using the
// stored offline session token — does not rely on the local Postgres
// product mirror, which can drift.
//
// USAGE
//   node scripts/regenerate-orthotic-masterindex.mjs --shop=<myshopify-domain>
//   node scripts/regenerate-orthotic-masterindex.mjs --shop=foo.myshopify.com --discover
//   node scripts/regenerate-orthotic-masterindex.mjs --shop=foo.myshopify.com
//
// FLOW
//   First run with --discover:
//     1. Connects to Shopify, pulls every ACTIVE product with productType=Orthotics
//     2. Lists distinct values found in the activity + helps_with metafields
//     3. Writes scripts/orthotic-mapping.json with sensible-guess mappings
//     4. Stops. You review the mapping file and tweak any wrong guesses.
//
//   Second run (without --discover):
//     1. Re-pulls the live catalog
//     2. Applies your reviewed mapping
//     3. Writes scripts/regenerated-masterindex.json — drop into the seed
//
//   Re-run any time the catalog changes. The mapping file persists
//   between runs; you only edit it when a brand-new metafield value
//   appears (the script will warn you).
//
// READ-ONLY toward Shopify. Writes only to scripts/*.json files. Does
// not touch chat code, the seed, or production config.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPPING_PATH = path.join(__dirname, "orthotic-mapping.json");
const OUT_PATH = path.join(__dirname, "regenerated-masterindex.json");
import { ADMIN_API_VERSION } from "../app/lib/admin-api-version.js";

const args = process.argv.slice(2);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const hasFlag = (name) => args.includes(`--${name}`);
const shopArg = arg("shop");
const discoverMode = hasFlag("discover");

if (!shopArg) {
  console.error("Usage: node scripts/regenerate-orthotic-masterindex.mjs --shop=<domain.myshopify.com> [--discover]");
  process.exit(1);
}

const { default: prisma } = await import("../app/db.server.js");

// ── Find a usable offline access token for the shop ───────────────────
const session = await prisma.session.findFirst({
  where: { shop: shopArg, isOnline: false, accessToken: { not: "" } },
  orderBy: { expires: "desc" },
});
if (!session?.accessToken) {
  console.error(`No offline Session row found for shop=${shopArg}. Open the app once in Shopify admin to create one.`);
  await prisma.$disconnect();
  process.exit(2);
}

// ── GraphQL helper ────────────────────────────────────────────────────
async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${shopArg}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Shopify Admin API ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// ── Fetch every ACTIVE Orthotic product with the metafields we need ──
// Includes a generous metafield grab — we'll filter to the keys we
// actually use after, which keeps the query stable even if you add
// more metafields later.
const PRODUCT_QUERY = `
  query OrthoticProducts($cursor: String) {
    products(first: 50, after: $cursor, query: "product_type:Orthotics status:active") {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          status
          productType
          tags
          metafields(first: 50) {
            edges {
              node {
                namespace
                key
                type
                value
                reference {
                  __typename
                  ... on Metaobject {
                    handle
                    fields { key value }
                  }
                }
                references(first: 20) {
                  edges {
                    node {
                      __typename
                      ... on Metaobject {
                        handle
                        fields { key value }
                      }
                    }
                  }
                }
              }
            }
          }
          variants(first: 100) {
            edges {
              node {
                sku
                inventoryQuantity
              }
            }
          }
        }
      }
    }
  }
`;

console.log(`Fetching ACTIVE orthotic products from ${shopArg}...`);
const allProducts = [];
let cursor = null;
do {
  const data = await shopifyGraphQL(PRODUCT_QUERY, { cursor });
  const edges = data?.products?.edges || [];
  for (const e of edges) allProducts.push(e.node);
  cursor = data?.products?.pageInfo?.hasNextPage ? data.products.pageInfo.endCursor : null;
} while (cursor);

console.log(`Pulled ${allProducts.length} active orthotic product(s).\n`);

// ── Extract metafields by key ─────────────────────────────────────────
function metaValue(product, key) {
  const node = product.metafields?.edges?.find((e) => e.node.key === key)?.node;
  if (!node) return null;
  // Metaobject reference list — pull display fields out of each linked metaobject.
  if (node.references?.edges?.length > 0) {
    const items = node.references.edges
      .map((e) => {
        const fields = e.node?.fields || [];
        const label = fields.find((f) => f.key === "label" || f.key === "name" || f.key === "title")?.value
          || fields.find((f) => f.key === "text")?.value
          || e.node?.handle;
        return label ? String(label).trim() : null;
      })
      .filter(Boolean);
    return items;
  }
  if (node.reference?.__typename === "Metaobject") {
    const fields = node.reference.fields || [];
    const label = fields.find((f) => f.key === "label" || f.key === "name" || f.key === "title")?.value
      || fields.find((f) => f.key === "text")?.value
      || node.reference.handle;
    return label ? [String(label).trim()] : [];
  }
  // JSON list (most common shape for list.single_line_text_field).
  if (typeof node.value === "string") {
    const v = node.value.trim();
    if (v.startsWith("[")) {
      try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed.map((x) => String(x).trim()).filter(Boolean) : [String(parsed).trim()];
      } catch {
        return [v];
      }
    }
    return [v];
  }
  return [];
}

function firstMetaValue(product, key) {
  const list = metaValue(product, key);
  return list && list.length > 0 ? list[0] : null;
}

// ── Derive the SKU prefix that becomes masterSku ──────────────────────
// Aetrex variants follow the pattern <letter-prefix><number><letter-suffix>[size]
// e.g. L1300U07 → L1300U, PFKM07 → PFKM, A100M07 → A100M, L4500U-M → L4500U.
// Use the first variant's SKU and pattern-match the master portion.
// LCP across variants is too aggressive when variants have varying
// suffix lengths ("L1300U07" + "L1300U-XS" → LCP "L1300U" works, but
// "L1300U" + "L1305U" → LCP "L130" → wrong).
const ORTHOTIC_SKU_RE = /^([A-Z]+\d+[A-Z]+)/i;
function deriveMasterSku(product) {
  const skus = (product.variants?.edges || [])
    .map((e) => String(e.node?.sku || "").trim())
    .filter(Boolean);
  if (skus.length === 0) return null;

  // Pattern match against the first variant — Aetrex's master prefix is
  // always a letter-block + digit-block + letter-block, e.g. L1300U.
  for (const sku of skus) {
    const m = sku.match(ORTHOTIC_SKU_RE);
    if (m && m[1]) return m[1];
  }

  // Fallback: longest common prefix, then keep only chars up to the
  // first run of trailing digits. Used for non-standard SKUs (kits,
  // bundles) that don't fit the L/A/PFK pattern.
  let prefix = skus[0];
  for (let i = 1; i < skus.length; i++) {
    let j = 0;
    while (j < prefix.length && j < skus[i].length && prefix[j] === skus[i][j]) j++;
    prefix = prefix.slice(0, j);
  }
  // Strip ONLY a complete trailing size code (2-3 digits), not partial digits.
  return prefix.replace(/\d{2,3}$/, "") || prefix;
}

// ── Discovery pass: find distinct metafield values ────────────────────
const distinctActivity = new Set();
const distinctHelpsWith = new Set();
const distinctGender = new Set();
for (const p of allProducts) {
  for (const v of metaValue(p, "attr_activity_shoe_type") || []) distinctActivity.add(v);
  for (const v of metaValue(p, "details_icons") || []) distinctHelpsWith.add(v);
  for (const v of metaValue(p, "attr_gender") || []) distinctGender.add(v);
  for (const v of metaValue(p, "gender_text") || []) distinctGender.add(v);
}

// ── Mapping guesses ───────────────────────────────────────────────────
// Heuristics from Aetrex's vocabulary; merchant overrides via the JSON
// file. Keys are normalized lowercase.
function guessUseCaseFor(value) {
  const v = String(value || "").toLowerCase().trim();
  if (!v) return null;
  if (/run/.test(v)) return "athletic_running";
  if (/gym|train|workout|lift|crossfit/.test(v)) return "athletic_training_gym";
  if (/compete|active|sport|tennis|basketball|court|pickle/.test(v)) return "athletic_training_sports";
  if (/cleat|soccer|football|baseball|lacrosse|rugby/.test(v)) return "athletic_training_sports";
  if (/skate/.test(v)) return "skates";
  if (/winter|shearling/.test(v) || /\bsnow.*boot/.test(v)) return "winter_boots";
  if (/work|construction|warehouse|nursing|stand.*all.*day/.test(v)) return "boots_construction";
  if (/non.?removable|fixed.?insole|\bedge\b/.test(v)) return "non_removable";
  if (/dress|fashion|heel|pump|flats?\b/.test(v)) return "dress_no_removable";
  if (/memory.?foam.*every|cush.*every|extreme.*comfort/.test(v)) return "comfort_memory_foam_everyday";
  if (/memory.?foam|premium.*memory|extra.?cushion|plush/.test(v)) return "comfort_memory_foam";
  if (/plantar.?fasc.*kit|pf.?kit|bundle/.test(v)) return "comfort_bundle";
  if (/diabet|neuropath|conform/.test(v)) return "diabetic";
  if (/casual|everyday|walking|comfort|kid|child|youth/.test(v)) return "comfort_walking_everyday";
  return "comfort_walking_everyday"; // safe default
}

function guessConditionFor(value) {
  const v = String(value || "").toLowerCase().trim();
  if (!v) return null;
  if (/heel\s*spur/.test(v)) return "heel_spurs";
  if (/morton/.test(v)) return "mortons_neuroma";
  if (/metatars|ball.{0,3}of.{0,3}foot/.test(v)) return "metatarsalgia";
  if (/diabet|conform/.test(v)) return "diabetic";
  if (/plantar.*fasc/.test(v)) return "plantar_fasciitis";
  if (/flat.{0,3}feet|overpronation/.test(v)) return "overpronation_flat_feet";
  return null; // not all helps_with values map to a clinical condition
}

function guessFlagsFor(value) {
  const v = String(value || "").toLowerCase().trim();
  return {
    metSupport: /metatars|ball.{0,3}of.{0,3}foot|morton/.test(v),
    posted: /flat.{0,3}feet|overpronation/.test(v),
  };
}

function normalizeGender(value) {
  const v = String(value || "").toLowerCase().trim();
  if (/^(men|man|male|guy)/.test(v)) return "Men";
  if (/^(women|woman|female|lady)/.test(v)) return "Women";
  if (/^(kid|child|boy|girl|youth)/.test(v)) return "Kids";
  if (/unisex/.test(v)) return "Unisex";
  return null;
}

// ── DISCOVER MODE: write the mapping skeleton and stop ────────────────
if (discoverMode || !fs.existsSync(MAPPING_PATH)) {
  if (!discoverMode) {
    console.log(`No existing mapping at ${MAPPING_PATH} — running discovery first.\n`);
  }
  const activityMap = {};
  for (const v of distinctActivity) activityMap[v] = guessUseCaseFor(v);
  const helpsWithMap = {};
  for (const v of distinctHelpsWith) {
    helpsWithMap[v] = {
      condition: guessConditionFor(v),
      ...guessFlagsFor(v),
    };
  }
  const genderMap = {};
  for (const v of distinctGender) genderMap[v] = normalizeGender(v);

  const mapping = {
    _help: "Edit any guess that's wrong. Set a value to null to ignore it. Re-run without --discover to generate the masterIndex.",
    _activityHelp: "Map merchant's activity values to resolver useCase enum: dress_no_removable, non_removable, comfort_walking_everyday, comfort_memory_foam, comfort_memory_foam_everyday, comfort_bundle, diabetic, athletic_running, athletic_training_gym, athletic_training_sports, skates, winter_boots, boots_construction.",
    _helpsWithHelp: "For each helps_with value, set condition (heel_spurs|mortons_neuroma|metatarsalgia|diabetic|plantar_fasciitis|overpronation_flat_feet|null) and the metSupport/posted flags it implies.",
    _specialtyHelp: "Title-based overrides for products that need explicit handling. Each entry: { titleContains: 'kit', condition: 'plantar_fasciitis' }",
    activity: activityMap,
    helps_with: helpsWithMap,
    gender: genderMap,
    specialtyOverrides: [
      { titleContains: "Plantar Fasciitis Kit", condition: "plantar_fasciitis", useCase: "comfort" },
      { titleContains: "Heel Spurs", condition: "heel_spurs", useCase: "comfort" },
      { titleContains: "Conform", condition: "diabetic" },
      { titleContains: "Diabet", condition: "diabetic" },
      // Granular Fashion-line mapping — activity metafield is often
      // mislabeled "Everyday Comfort" on these. Title disambiguates:
      //   Thinsoles / Without Removable → dress_no_removable
      //   Insole for Heels → dress_premium (heel-shaped)
      //   Fashion Posted / Insole for Dress Shoes → dress
      //   In-Style / Heritage → dress_premium
      //   Low Profile → dress
      { titleContains: "Thinsoles", useCase: "dress_no_removable" },
      { titleContains: "Without Removable", useCase: "dress_no_removable" },
      { titleContains: "Insole for Heels", useCase: "dress_premium" },
      { titleContains: "Fashion Posted", useCase: "dress" },
      { titleContains: "Insole for Dress Shoes", useCase: "dress" },
      { titleContains: "In-Style", useCase: "dress_premium" },
      { titleContains: "Instyle", useCase: "dress_premium" },
      { titleContains: "Heritage", useCase: "dress_premium" },
      { titleContains: "Low Profile", useCase: "dress" },
    ],
  };
  fs.writeFileSync(MAPPING_PATH, JSON.stringify(mapping, null, 2));
  console.log("=== Discovery complete ===\n");
  console.log(`Distinct activity values (${distinctActivity.size}):`);
  for (const v of distinctActivity) console.log(`  "${v}" → ${guessUseCaseFor(v) || "(no guess — set manually)"}`);
  console.log(`\nDistinct helps_with values (${distinctHelpsWith.size}):`);
  for (const v of distinctHelpsWith) {
    const cond = guessConditionFor(v);
    const flags = guessFlagsFor(v);
    const flagsStr = [flags.metSupport && "metSupport", flags.posted && "posted"].filter(Boolean).join("+");
    console.log(`  "${v}" → ${cond || "(no condition)"}${flagsStr ? ` [${flagsStr}]` : ""}`);
  }
  console.log(`\nDistinct gender values (${distinctGender.size}):`);
  for (const v of distinctGender) console.log(`  "${v}" → ${normalizeGender(v) || "(unmapped)"}`);
  console.log(`\nMapping written to ${path.relative(process.cwd(), MAPPING_PATH)}`);
  console.log(`Review it, then re-run WITHOUT --discover to generate the masterIndex.\n`);
  await prisma.$disconnect();
  process.exit(0);
}

// ── REGEN MODE: apply mapping, generate masterIndex ──────────────────
const mapping = JSON.parse(fs.readFileSync(MAPPING_PATH, "utf8"));
const unmappedActivity = new Set();
const unmappedHelpsWith = new Set();

const masterIndex = [];
const skipped = [];

for (const product of allProducts) {
  const masterSku = deriveMasterSku(product);
  if (!masterSku) {
    skipped.push({ title: product.title, reason: "no SKU on any variant" });
    continue;
  }

  // Gender — metafield first, fallback to gender_text, then to title prefix.
  let gender = null;
  const genderRaw = firstMetaValue(product, "attr_gender") || firstMetaValue(product, "gender_text");
  if (genderRaw) {
    gender = mapping.gender?.[genderRaw] || normalizeGender(genderRaw);
  }
  if (!gender) {
    const t = String(product.title || "");
    if (/\b(men'?s|aetrex men)\b/i.test(t)) gender = "Men";
    else if (/\b(women'?s|aetrex women)\b/i.test(t)) gender = "Women";
    else if (/\bkid'?s?\b/i.test(t)) gender = "Kids";
    else if (/\bunisex\b/i.test(t)) gender = "Unisex";
  }

  // useCase — from activity metafield via mapping.
  let useCase = null;
  const activityList = metaValue(product, "attr_activity_shoe_type") || [];
  for (const v of activityList) {
    const mapped = mapping.activity?.[v];
    if (mapped) { useCase = mapped; break; }
    if (mapped === undefined) unmappedActivity.add(v);
  }

  // condition + flags — derived from helps_with.
  let condition = null;
  let metSupport = false;
  let posted = false;
  const helpsList = metaValue(product, "details_icons") || [];
  for (const v of helpsList) {
    const m = mapping.helps_with?.[v];
    if (m === undefined) {
      unmappedHelpsWith.add(v);
      continue;
    }
    if (m.condition && !condition) condition = m.condition;
    if (m.metSupport) metSupport = true;
    if (m.posted) posted = true;
  }

  // Specialty title overrides — applied LAST so they win when present.
  const specialtyOverrides = Array.isArray(mapping.specialtyOverrides) ? mapping.specialtyOverrides : [];
  const titleLower = String(product.title || "").toLowerCase();
  for (const ov of specialtyOverrides) {
    if (!ov?.titleContains) continue;
    if (!titleLower.includes(String(ov.titleContains).toLowerCase())) continue;
    if (ov.useCase) useCase = ov.useCase;
    if (ov.condition) condition = ov.condition;
    if (ov.metSupport === true) metSupport = true;
    if (ov.posted === true) posted = true;
  }

  // Title-based metSupport / posted hints for any product whose
  // title encodes the variant role (Aetrex's naming is consistent).
  if (!metSupport && /\b(metatarsal\s+support|w\/\s*metatarsal|w\/\s*met)\b/i.test(product.title)) {
    metSupport = true;
  }
  if (!posted && /\bposted\b/i.test(product.title)) {
    posted = true;
  }

  // arch — derived: Flat/Low if posted, else Medium/High (resolver default).
  const arch = posted ? "Flat / Low Arch" : "Medium / High Arch";

  // Skip if we couldn't determine gender or useCase — those are
  // load-bearing for the resolver. Log it for the merchant to fix.
  if (!gender) {
    skipped.push({ masterSku, title: product.title, reason: "could not determine gender from metafield or title" });
    continue;
  }
  if (!useCase) {
    skipped.push({ masterSku, title: product.title, reason: "could not determine useCase — set activity metafield or add specialtyOverride" });
    continue;
  }

  const entry = {
    masterSku,
    title: product.title,
    gender,
    useCase,
    arch,
    posted,
    metSupport,
  };
  if (condition) entry.condition = condition;
  masterIndex.push(entry);
}

// ── Pick a healthy fallback ───────────────────────────────────────────
// Prefer a Unisex comfort SKU, then a Men's comfort SKU. This is the
// SKU the resolver returns when no candidates pass the hard filter.
function findFallbackCandidate(idx) {
  return (
    idx.find((m) => m.gender === "Unisex" && m.useCase === "comfort" && !m.posted && !m.metSupport) ||
    idx.find((m) => m.gender === "Men" && m.useCase === "comfort" && !m.posted && !m.metSupport) ||
    idx.find((m) => m.useCase === "comfort") ||
    idx[0] ||
    null
  );
}
const fallbackCandidate = findFallbackCandidate(masterIndex);
const fallback = fallbackCandidate
  ? {
      masterSku: fallbackCandidate.masterSku,
      title: fallbackCandidate.title,
      reason: "no exact match — universal default",
    }
  : null;

const output = {
  _generatedAt: new Date().toISOString(),
  _shop: shopArg,
  _activeProductCount: allProducts.length,
  _masterIndexCount: masterIndex.length,
  _skippedCount: skipped.length,
  fallback,
  masterIndex,
  skipped,
};
fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));

console.log("=== Regeneration complete ===");
console.log(`Active products pulled: ${allProducts.length}`);
console.log(`masterIndex entries:    ${masterIndex.length}`);
console.log(`Skipped products:       ${skipped.length}`);
if (skipped.length > 0) {
  console.log("\nSkipped (need attention):");
  for (const s of skipped) {
    console.log(`  ${(s.masterSku || "?").padEnd(10)} ${s.title} — ${s.reason}`);
  }
}
if (unmappedActivity.size > 0) {
  console.log("\n⚠ Unmapped activity values found (add to scripts/orthotic-mapping.json):");
  for (const v of unmappedActivity) console.log(`  "${v}"`);
}
if (unmappedHelpsWith.size > 0) {
  console.log("\n⚠ Unmapped helps_with values found (add to scripts/orthotic-mapping.json):");
  for (const v of unmappedHelpsWith) console.log(`  "${v}"`);
}
if (fallback) {
  console.log(`\nFallback chosen: ${fallback.masterSku} — ${fallback.title}`);
}
console.log(`\nOutput: ${path.relative(process.cwd(), OUT_PATH)}`);
console.log("\nNext steps:");
console.log("  1. Review the output JSON");
console.log("  2. Open scripts/seeds/aetrex-orthotic-tree.json");
console.log("  3. Replace the existing fallback + masterIndex with these (everything else stays the same)");
console.log("  4. Open admin → Smart Recommenders → Edit Aetrex tree → paste full JSON → Save");
console.log("  5. (Optional) Click 'Seed Aetrex Orthotic Finder' if you prefer to load from the seed file");
console.log("  6. Re-run npm run audit:recommender — coverage should be ~100%\n");

await prisma.$disconnect();

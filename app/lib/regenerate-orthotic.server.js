// Regenerate the orthotic recommender's masterIndex from the live
// Shopify catalog. Same logic the CLI script uses
// (scripts/regenerate-orthotic-masterindex.mjs), packaged so the
// admin UI can call it from a route action with one click.
//
// Two phases:
//   discoverFromShopify({shop, accessToken}) →
//       { products, distinctActivity, distinctHelpsWith, distinctGender }
//   regenerateMasterIndex({products, mapping}) →
//       { masterIndex, fallback, skipped, unmappedActivity, unmappedHelpsWith }
//
// The split lets the admin UI run discovery first (to surface new
// metafield values for the merchant to map), then regenerate using
// the merchant's saved mapping. The CLI script uses the same two
// functions, so behavior stays identical between terminal and admin.

import { ADMIN_API_VERSION } from "./admin-api-version.js";

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

async function shopifyGraphQL({ shop, accessToken, query, variables = {} }) {
  const url = `https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify Admin API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

export async function fetchActiveOrthoticProducts({ shop, accessToken }) {
  const all = [];
  let cursor = null;
  do {
    const data = await shopifyGraphQL({ shop, accessToken, query: PRODUCT_QUERY, variables: { cursor } });
    const edges = data?.products?.edges || [];
    for (const e of edges) all.push(e.node);
    cursor = data?.products?.pageInfo?.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}

// Read a metafield value off a product, returning a list of strings
// regardless of underlying shape (single line text, JSON list,
// metaobject reference, metaobject list).
export function metaValue(product, key) {
  const node = product.metafields?.edges?.find((e) => e.node.key === key)?.node;
  if (!node) return null;
  if (node.references?.edges?.length > 0) {
    return node.references.edges
      .map((e) => {
        const fields = e.node?.fields || [];
        const label = fields.find((f) => f.key === "label" || f.key === "name" || f.key === "title")?.value
          || fields.find((f) => f.key === "text")?.value
          || e.node?.handle;
        return label ? String(label).trim() : null;
      })
      .filter(Boolean);
  }
  if (node.reference?.__typename === "Metaobject") {
    const fields = node.reference.fields || [];
    const label = fields.find((f) => f.key === "label" || f.key === "name" || f.key === "title")?.value
      || fields.find((f) => f.key === "text")?.value
      || node.reference.handle;
    return label ? [String(label).trim()] : [];
  }
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

// Aetrex SKUs: <letter-prefix><number><letter-suffix>[size code].
// Pattern-match the master prefix off the first variant.
const ORTHOTIC_SKU_RE = /^([A-Z]+\d+[A-Z]+)/i;
export function deriveMasterSku(product) {
  const skus = (product.variants?.edges || [])
    .map((e) => String(e.node?.sku || "").trim())
    .filter(Boolean);
  if (skus.length === 0) return null;
  for (const sku of skus) {
    const m = sku.match(ORTHOTIC_SKU_RE);
    if (m && m[1]) return m[1];
  }
  let prefix = skus[0];
  for (let i = 1; i < skus.length; i++) {
    let j = 0;
    while (j < prefix.length && j < skus[i].length && prefix[j] === skus[i][j]) j++;
    prefix = prefix.slice(0, j);
  }
  return prefix.replace(/\d{2,3}$/, "") || prefix;
}

// Sensible-guess mapping from merchant vocabulary → resolver enum.
export function guessUseCaseFor(value) {
  const v = String(value || "").toLowerCase().trim();
  if (!v) return null;
  if (/run/.test(v)) return "athletic_running";
  if (/train|workout|gym/.test(v)) return "athletic_training";
  if (/compete|active|sport/.test(v) && !/cleat/.test(v)) return "athletic_general";
  if (/cleat|soccer|football|baseball|lacrosse/.test(v)) return "cleats";
  if (/skate/.test(v)) return "skates";
  if (/winter|boot/.test(v)) return "winter_boots";
  if (/dress.*premium|heritage/.test(v)) return "dress_premium";
  if (/dress.*no.?removable|fashion|heel|pump|flat/.test(v)) return "dress_no_removable";
  if (/dress/.test(v)) return "dress";
  if (/work/.test(v)) return "work";
  if (/casual|everyday|walking|comfort|stand/.test(v)) return "comfort";
  if (/kid|child|youth/.test(v)) return "kids";
  return "comfort";
}

export function guessConditionFor(value) {
  const v = String(value || "").toLowerCase().trim();
  if (!v) return null;
  if (/heel\s*spur/.test(v)) return "heel_spurs";
  if (/morton/.test(v)) return "mortons_neuroma";
  if (/metatars|ball.{0,3}of.{0,3}foot/.test(v)) return "metatarsalgia";
  if (/diabet|conform/.test(v)) return "diabetic";
  if (/plantar.*fasc/.test(v)) return "plantar_fasciitis";
  if (/flat.{0,3}feet|overpronation/.test(v)) return "overpronation_flat_feet";
  return null;
}

export function guessFlagsFor(value) {
  const v = String(value || "").toLowerCase().trim();
  return {
    metSupport: /metatars|ball.{0,3}of.{0,3}foot|morton/.test(v),
    posted: /flat.{0,3}feet|overpronation/.test(v),
  };
}

export function normalizeGender(value) {
  const v = String(value || "").toLowerCase().trim();
  if (/^(men|man|male|guy)/.test(v)) return "Men";
  if (/^(women|woman|female|lady)/.test(v)) return "Women";
  if (/^(kid|child|boy|girl|youth)/.test(v)) return "Kids";
  if (/unisex/.test(v)) return "Unisex";
  return null;
}

// Given a list of products, return distinct values for each metafield
// + auto-generated guess-mappings. The admin UI uses this to render
// the discovery step: the merchant sees the list and overrides any
// wrong guess before regenerating.
export function discoverDistinctValues(products) {
  const distinctActivity = new Set();
  const distinctHelpsWith = new Set();
  const distinctGender = new Set();
  for (const p of products) {
    for (const v of metaValue(p, "attr_activity_shoe_type") || []) distinctActivity.add(v);
    for (const v of metaValue(p, "details_icons") || []) distinctHelpsWith.add(v);
    for (const v of metaValue(p, "attr_gender") || []) distinctGender.add(v);
    for (const v of metaValue(p, "gender_text") || []) distinctGender.add(v);
  }
  return {
    distinctActivity: [...distinctActivity],
    distinctHelpsWith: [...distinctHelpsWith],
    distinctGender: [...distinctGender],
  };
}

// Build the suggested mapping JSON that the merchant edits. Used for
// the FIRST run (no saved mapping yet) so the merchant has a starting
// point instead of authoring everything from scratch.
export function buildSuggestedMapping(distinct) {
  const activity = {};
  for (const v of distinct.distinctActivity) activity[v] = guessUseCaseFor(v);
  const helps_with = {};
  for (const v of distinct.distinctHelpsWith) {
    helps_with[v] = {
      condition: guessConditionFor(v),
      ...guessFlagsFor(v),
    };
  }
  const gender = {};
  for (const v of distinct.distinctGender) gender[v] = normalizeGender(v);
  return {
    activity,
    helps_with,
    gender,
    specialtyOverrides: [
      { titleContains: "Plantar Fasciitis Kit", condition: "plantar_fasciitis", useCase: "comfort" },
      { titleContains: "Heel Spurs", condition: "heel_spurs", useCase: "comfort" },
      { titleContains: "Conform", condition: "diabetic" },
      { titleContains: "Diabet", condition: "diabetic" },
      // Fashion / dress-shoe lines: Aetrex's activity metafield on
      // these is sometimes mislabeled "Everyday Comfort" instead of
      // "Dress" or "Fashion". Trust the title — these are low-
      // profile orthotics for slim dress/fashion shoes, NOT for
      // athletic sneakers. Without these overrides an 85yo asking
      // for sneaker comfort gets the L105 Fashion (wrong shoe shape).
      { titleContains: "Fashion", useCase: "dress_no_removable" },
      { titleContains: "In-Style", useCase: "dress_no_removable" },
      { titleContains: "Instyle", useCase: "dress_no_removable" },
      { titleContains: "Low Profile", useCase: "dress_no_removable" },
      { titleContains: "Heritage", useCase: "dress_premium" },
    ],
  };
}

// Apply the merchant's reviewed mapping to the live catalog and
// produce a fresh masterIndex. Returns the array plus diagnostics
// (skipped products, unmapped values found this run).
export function regenerateMasterIndex({ products, mapping }) {
  const masterIndex = [];
  const skipped = [];
  const unmappedActivity = new Set();
  const unmappedHelpsWith = new Set();

  for (const product of products) {
    const masterSku = deriveMasterSku(product);
    if (!masterSku) {
      skipped.push({ title: product.title, reason: "no SKU on any variant" });
      continue;
    }

    let gender = null;
    const genderRaw = firstMetaValue(product, "attr_gender") || firstMetaValue(product, "gender_text");
    if (genderRaw) {
      gender = mapping?.gender?.[genderRaw] || normalizeGender(genderRaw);
    }
    if (!gender) {
      const t = String(product.title || "");
      if (/\b(men'?s|aetrex men)\b/i.test(t)) gender = "Men";
      else if (/\b(women'?s|aetrex women)\b/i.test(t)) gender = "Women";
      else if (/\bkid'?s?\b/i.test(t)) gender = "Kids";
      else if (/\bunisex\b/i.test(t)) gender = "Unisex";
    }

    let useCase = null;
    const activityList = metaValue(product, "attr_activity_shoe_type") || [];
    for (const v of activityList) {
      const m = mapping?.activity?.[v];
      if (m) { useCase = m; break; }
      if (m === undefined) unmappedActivity.add(v);
    }

    let condition = null;
    let metSupport = false;
    let posted = false;
    const helpsList = metaValue(product, "details_icons") || [];
    for (const v of helpsList) {
      const m = mapping?.helps_with?.[v];
      if (m === undefined) {
        unmappedHelpsWith.add(v);
        continue;
      }
      if (m.condition && !condition) condition = m.condition;
      if (m.metSupport) metSupport = true;
      if (m.posted) posted = true;
    }

    // Always-on title overrides for product lines whose Shopify
    // metafield is commonly mislabeled. These run on every regen
    // even if the merchant's persisted vocabularyMapping is stale —
    // so the fix lands without re-discovery. Merchant entries in
    // mapping.specialtyOverrides run AFTER and can override these.
    //
    // ORDER MATTERS — first match wins per useCase update, then
    // gets re-overridden by later matches. So we list the most
    // specific patterns FIRST, then broader ones. The Thinsoles
    // line is the actual "no removable insole" line; the Fashion
    // line is heel/dress-shoe specific.
    const builtInOverrides = [
      // True no-removable insole line — Thinsoles for shoes that
      // don't accept full-length inserts (some sandals, slim
      // dress shoes, no-insole flats).
      { titleContains: "Thinsoles", useCase: "dress_no_removable" },
      { titleContains: "Without Removable", useCase: "dress_no_removable" },
      // Heel-specific Fashion line — slim insole shaped for high
      // heels and pumps. Don't bucket with no-removable.
      { titleContains: "Insole for Heels", useCase: "dress_premium" },
      { titleContains: "Fashion Posted", useCase: "dress" },
      { titleContains: "Insole for Dress Shoes", useCase: "dress" },
      // In-Style / Heritage — premium dress lines.
      { titleContains: "In-Style", useCase: "dress_premium" },
      { titleContains: "Instyle", useCase: "dress_premium" },
      { titleContains: "Heritage", useCase: "dress_premium" },
      // Low Profile — slim profile, dress-shoe friendly.
      { titleContains: "Low Profile", useCase: "dress" },
    ];
    const merchantOverrides = Array.isArray(mapping?.specialtyOverrides) ? mapping.specialtyOverrides : [];
    const specialtyOverrides = [...builtInOverrides, ...merchantOverrides];
    const titleLower = String(product.title || "").toLowerCase();
    for (const ov of specialtyOverrides) {
      if (!ov?.titleContains) continue;
      if (!titleLower.includes(String(ov.titleContains).toLowerCase())) continue;
      if (ov.useCase) useCase = ov.useCase;
      if (ov.condition) condition = ov.condition;
      if (ov.metSupport === true) metSupport = true;
      if (ov.posted === true) posted = true;
    }

    if (!metSupport && /\b(metatarsal\s+support|w\/\s*metatarsal|w\/\s*met)\b/i.test(product.title)) metSupport = true;
    if (!posted && /\bposted\b/i.test(product.title)) posted = true;

    const arch = posted ? "Flat / Low Arch" : "Medium / High Arch";

    if (!gender) {
      skipped.push({ masterSku, title: product.title, reason: "could not determine gender from metafield or title" });
      continue;
    }
    if (!useCase) {
      skipped.push({ masterSku, title: product.title, reason: "could not determine useCase — set activity metafield or add specialtyOverride" });
      continue;
    }

    const entry = { masterSku, title: product.title, gender, useCase, arch, posted, metSupport };
    if (condition) entry.condition = condition;
    masterIndex.push(entry);
  }

  const fallbackCandidate =
    masterIndex.find((m) => m.gender === "Unisex" && m.useCase === "comfort" && !m.posted && !m.metSupport) ||
    masterIndex.find((m) => m.gender === "Men" && m.useCase === "comfort" && !m.posted && !m.metSupport) ||
    masterIndex.find((m) => m.useCase === "comfort") ||
    masterIndex[0] || null;
  const fallback = fallbackCandidate
    ? { masterSku: fallbackCandidate.masterSku, title: fallbackCandidate.title, reason: "no exact match — universal default" }
    : null;

  return {
    masterIndex,
    fallback,
    skipped,
    unmappedActivity: [...unmappedActivity],
    unmappedHelpsWith: [...unmappedHelpsWith],
  };
}

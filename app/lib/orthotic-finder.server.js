// Orthotic finder — fetch the live orthotic catalog, store it on the shop's
// "orthotic" recommender, and run it as Claude's recommend_orthotic tool.
// The logic lives in orthotic-finder.js (pure, tested against a snapshot of
// the real catalog in scripts/fixtures/aetrex-orthotics.json).

import prisma from "../db.server.js";
import { ADMIN_API_VERSION } from "./admin-api-version.js";
import { buildOrthoticCatalog, describeLine, pickOrthotic, productFromNode } from "./orthotic-finder.js";
import { getDecisionTreeByIntent, incrementCompletedCount, saveDecisionTree } from "../models/DecisionTree.server.js";

export const FINDER_KIND = "catalog_finder";

// Five plain metafields per product — cheap enough for 50 products a page.
export const ORTHOTIC_PRODUCTS_QUERY = `
  query OrthoticFinderProducts($cursor: String) {
    products(first: 50, after: $cursor, query: "product_type:Orthotics status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        title
        handle
        variants(first: 1) { nodes { sku price } }
        gender: metafield(namespace: "custom", key: "gender_text") { value }
        activity: metafield(namespace: "custom", key: "attr_activity_shoe_type_for_filter") { value }
        details: metafield(namespace: "custom", key: "comfort_details") { value }
        helps: metafield(namespace: "product", key: "reccomended_for") { value }
        summary: metafield(namespace: "custom", key: "short_description") { value }
      }
    }
  }
`;

// graphql(query, variables) → data, from the app's admin client…
export function adminGraphql(admin) {
  return async (query, variables) => {
    const resp = await admin.graphql(query, { variables });
    const json = await resp.json();
    if (json?.errors?.length) throw new Error(json.errors.map((e) => e?.message).join("; "));
    return json.data;
  };
}

// …or from a stored offline token.
export function tokenGraphql({ shop, accessToken }) {
  return async (query, variables) => {
    const res = await fetch(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Shopify ${res.status}`);
    const json = await res.json();
    if (json?.errors?.length) throw new Error(json.errors.map((e) => e?.message).join("; "));
    return json.data;
  };
}

export async function fetchOrthoticProducts(graphql) {
  const out = [];
  let cursor = null;
  do {
    const data = await graphql(ORTHOTIC_PRODUCTS_QUERY, { cursor });
    const page = data?.products;
    for (const n of page?.nodes || []) out.push(productFromNode(n));
    cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

// Rebuild the finder from the live catalog and save it as the shop's
// "orthotic" recommender (created on first sync, switched on).
export async function syncOrthoticFinder({ shop, graphql }) {
  const products = await fetchOrthoticProducts(graphql);
  const catalog = buildOrthoticCatalog(products);
  if (catalog.items.length === 0) {
    return { ok: false, error: "No active products with product type \"Orthotics\" were found in Shopify." };
  }
  const existing = await getDecisionTreeByIntent(shop, "orthotic");
  await saveDecisionTree(shop, {
    id: existing?.id,
    name: existing?.name || "Aetrex Orthotic Finder",
    intent: "orthotic",
    triggerPhrases: existing?.triggerPhrases || JSON.stringify(["orthotic", "orthotics", "insole", "insoles", "arch support"]),
    triggerCategoryGroup: existing?.triggerCategoryGroup || "Orthotics",
    definition: { kind: FINDER_KIND, syncedAt: new Date().toISOString(), finder: catalog },
    // Switched on when first built; after that the merchant's on/off stays.
    enabled: existing?.definition?.kind === FINDER_KIND ? existing.enabled : true,
  });
  return {
    ok: true,
    productCount: products.length,
    lineCount: catalog.lines.length,
    lines: catalog.lines.map((l) => ({ id: l.id, name: l.name, genders: l.genders, count: l.count, bestFor: l.bestFor })),
    skipped: catalog.skipped,
  };
}

// After a catalog sync: keep an existing finder current. Never creates one.
export function refreshOrthoticFinderAsync({ admin, shop }) {
  (async () => {
    const existing = await getDecisionTreeByIntent(shop, "orthotic");
    if (existing?.definition?.kind !== FINDER_KIND) return;
    const r = await syncOrthoticFinder({ shop, graphql: adminGraphql(admin) });
    console.log(`[orthotic-finder] ${shop}: ${r.ok ? `refreshed — ${r.productCount} products, ${r.lineCount} lines` : r.error}`);
  })().catch((err) => console.error(`[orthotic-finder] ${shop}: refresh failed — ${err?.message || err}`));
}

export function isFinderTree(tree) {
  return tree?.definition?.kind === FINDER_KIND && Array.isArray(tree.definition?.finder?.lines);
}

export function finderToolDef(tree) {
  const lines = tree.definition.finder.lines;
  return {
    name: `recommend_${tree.intent}`,
    description:
      "Find the right orthotic (insole) for the customer. Use it whenever they want help choosing one.\n\n" +
      "You need four things. Ask only for what you don't know yet — one short question per message, with tap choices:\n" +
      "1. Who it's for: men, women or kids.\n" +
      "2. The shoes or activity it's for (running, gym, dress shoes, heels, work boots, cleats, everyday sneakers…).\n" +
      "3. Arch type: flat/low (also: flat feet, overpronation, feet roll inward), medium/high, or not sure.\n" +
      "4. Ball-of-foot pain (metatarsalgia, Morton's neuroma): yes or no.\n" +
      "Never fill in an answer they haven't given — ask. If they don't know their arch type, use not_sure.\n" +
      "Then choose the line whose 'Best for' fits their shoes and needs — e.g. diabetes → the line made for diabetes; shoes " +
      "without a removable insole, heels or slim dress shoes → the dress, fashion or thin lines; extra cushioning → memory foam — " +
      "and call this tool. It picks the exact version for their arch and ball-of-foot pain and checks it's for sale; show what it returns. " +
      "Plantar fasciitis or heel pain doesn't change the line — answer the four questions as usual. " +
      "Open sandals can only hold an insert if the footbed comes out and there's room — say so honestly and offer supportive sandals instead.\n\n" +
      "Lines in this store:\n" + lines.map((l) => `- ${describeLine(l)}`).join("\n"),
    input_schema: {
      type: "object",
      properties: {
        line: { type: "string", enum: lines.map((l) => l.id), description: "The line that fits their shoes and needs." },
        gender: { type: "string", enum: ["men", "women", "kids"] },
        arch: { type: "string", enum: ["flat_low", "medium_high", "not_sure"] },
        ball_of_foot_pain: { type: "string", enum: ["yes", "no"] },
      },
      required: ["line", "gender", "arch", "ball_of_foot_pain"],
    },
  };
}

// Only products the assistant can actually show (synced and active).
async function availableHandles(shop, handles) {
  const rows = await prisma.product.findMany({
    where: { shop, handle: { in: handles } },
    select: { handle: true, status: true },
  });
  return new Set(rows.filter((r) => !/^(draft|archived)$/i.test(r.status || "")).map((r) => r.handle));
}

export async function runFinderTool({ tree, shop, input }) {
  const catalog = tree.definition.finder;
  const forSale = await availableHandles(shop, catalog.items.map((i) => i.handle));
  const result = pickOrthotic(catalog, input || {}, { available: (h) => forSale.has(h) });
  if (result.pick) await incrementCompletedCount(shop, tree.id);
  return result;
}

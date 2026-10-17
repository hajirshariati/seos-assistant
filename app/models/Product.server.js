import prisma from "../db.server";
import {
  getAttributeMappings,
  buildMetafieldFragment,
  buildAutoMetafieldFragment,
  resolveAutoAttributes,
  resolveProductAttributes,
  resolveVariantAttributes,
} from "./AttributeMapping.server";
import { syncStoreKnowledgeAsync } from "../lib/store-knowledge/sync.server.js";
import { refreshOrthoticFinderAsync } from "../lib/orthotic-finder.server.js";
import { fetchMetafieldDefinitions } from "../lib/metafield-definitions.server.js";

// Metafield types per shop ("target:namespace.key" → type), so queries only
// expand linked records for fields that are links. Refreshed every 10 min.
const typeCache = new Map();
async function metafieldTypes(admin, shop) {
  const hit = typeCache.get(shop);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.types;
  const { definitions } = await fetchMetafieldDefinitions(admin);
  const types = new Map(definitions.map((d) => [`${d.target}:${d.namespace}.${d.key}`, d.type?.name || ""]));
  if (types.size > 0) typeCache.set(shop, { at: Date.now(), types });
  return types.size > 0 ? types : null;
}

const PRODUCTS_PAGE = 50;

function productsQuery(productMfFragment = "", variantMfFragment = "", pageSize = PRODUCTS_PAGE) {
  return `#graphql
  query SyncProducts($cursor: String) {
    products(first: ${pageSize}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        vendor
        productType
        tags
        descriptionHtml
        status
        featuredImage { url }
        ${productMfFragment}
        variants(first: 100) {
          nodes {
            id
            sku
            title
            price
            compareAtPrice
            inventoryQuantity
            selectedOptions { name value }
            ${variantMfFragment}
          }
        }
      }
    }
  }
`;
}

function productByIdQuery(productMfFragment = "", variantMfFragment = "") {
  return `#graphql
  query GetProduct($id: ID!) {
    product(id: $id) {
      id
      handle
      title
      vendor
      productType
      tags
      descriptionHtml
      status
      featuredImage { url }
      ${productMfFragment}
      variants(first: 100) {
        nodes {
          id
          sku
          title
          price
          compareAtPrice
          inventoryQuantity
          selectedOptions { name value }
          ${variantMfFragment}
        }
      }
    }
  }
`;
}

function stripHtml(html) {
  if (!html) return "";
  return String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function mapProductFields(node, mappings) {
  const fields = {
    shopifyId: node.id,
    handle: node.handle,
    title: node.title,
    vendor: node.vendor || null,
    productType: node.productType || null,
    tags: node.tags || [],
    description: stripHtml(node.descriptionHtml),
    status: node.status || null,
    featuredImageUrl: node.featuredImage?.url || null,
  };
  // Mapped attributes win; zero-config auto-discovered metafields fill any
  // attribute the merchant hasn't mapped (color/gender/category out of the box).
  const mapped = mappings && mappings.length > 0 ? resolveProductAttributes(node, mappings) : null;
  const auto = resolveAutoAttributes(node, mappings || []);
  if (mapped || auto) fields.attributesJson = { ...(auto || {}), ...(mapped || {}) };
  return fields;
}

function productMetafieldFragment(mappings, types = null) {
  return [buildMetafieldFragment(mappings, "product", types), buildAutoMetafieldFragment(mappings)]
    .filter(Boolean)
    .join("\n        ");
}

function mapVariantFields(v, mappings) {
  const fields = {
    shopifyId: v.id,
    sku: v.sku || null,
    title: v.title || null,
    price: v.price || null,
    compareAtPrice: v.compareAtPrice || null,
    inventoryQty: typeof v.inventoryQuantity === "number" ? v.inventoryQuantity : null,
    optionsJson: v.selectedOptions ? JSON.stringify(v.selectedOptions) : null,
  };
  if (mappings && mappings.length > 0) {
    fields.attributesJson = resolveVariantAttributes(v, mappings) || undefined;
  }
  return fields;
}

// True when every incoming field already holds the same value — the row is
// left alone, so a nightly sync of an unchanged catalog writes (almost)
// nothing. Errs toward writing: any doubt counts as a change.
function sameFields(existing, fields) {
  if (!existing) return false;
  // Key order ignored: Postgres stores JSON with its keys reordered.
  const stable = (v) => (Array.isArray(v) ? v.map(stable)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v);
  const norm = (v) => (v instanceof Date ? v.toISOString() : v && typeof v === "object" ? JSON.stringify(stable(v)) : v ?? null);
  return Object.entries(fields).every(([k, v]) => norm(existing[k]) === norm(v));
}

async function upsertProduct(shop, node, mappings = null) {
  const fields = mapProductFields(node, mappings);
  const current = await prisma.product.findUnique({ where: { shop_shopifyId: { shop, shopifyId: fields.shopifyId } } });
  const product = sameFields(current, fields)
    ? current
    : await prisma.product.upsert({
        where: { shop_shopifyId: { shop, shopifyId: fields.shopifyId } },
        update: { ...fields, updatedAt: new Date() },
        create: { shop, ...fields },
      });

  const variants = (node.variants?.nodes || []).map((v) => mapVariantFields(v, mappings));
  const incomingIds = new Set(variants.map((v) => v.shopifyId));

  await prisma.productVariant.deleteMany({
    where: { productId: product.id, NOT: { shopifyId: { in: Array.from(incomingIds) } } },
  });

  const existing = new Map(
    (await prisma.productVariant.findMany({ where: { productId: product.id } })).map((v) => [v.shopifyId, v]),
  );
  for (const v of variants) {
    if (sameFields(existing.get(v.shopifyId), v)) continue;
    await prisma.productVariant.upsert({
      where: { productId_shopifyId: { productId: product.id, shopifyId: v.shopifyId } },
      update: { ...v, updatedAt: new Date() },
      create: { productId: product.id, ...v },
    });
  }

  return product;
}

export async function upsertProductFromWebhook(shop, webhookPayload, admin) {
  const numericId = webhookPayload.id || webhookPayload.admin_graphql_api_id;
  if (!numericId || !admin) return null;

  const gid =
    typeof numericId === "string" && numericId.startsWith("gid://")
      ? numericId
      : `gid://shopify/Product/${numericId}`;

  return fetchAndUpsertProduct(admin, shop, gid);
}

export async function fetchAndUpsertProduct(admin, shop, shopifyGid) {
  const mappings = await getAttributeMappings(shop);
  const types = await metafieldTypes(admin, shop).catch(() => null);
  const productMf = productMetafieldFragment(mappings, types);
  const variantMf = buildMetafieldFragment(mappings, "variant", types);
  const query = productByIdQuery(productMf, variantMf);
  const resp = await admin.graphql(query, { variables: { id: shopifyGid } });
  const json = await resp.json();
  const node = json?.data?.product;
  if (!node) return null;
  return upsertProduct(shop, node, mappings);
}

// Fetch up to `max` distinct product image URLs (multiple angles) for a
// product by its Shopify GID — used by "Visualize My Look" so the image
// model gets several reference views (top, front, side) instead of only
// the single featured photo. With one angle the model has to INVENT the
// unseen sides of the product when rendering it worn, which is the main
// source of "doesn't look like the real thing". Best-effort: returns []
// on any error so the caller can fall back to the stored featured image.
export async function getProductImageUrls(admin, shopifyGid, max = 4) {
  if (!admin || !shopifyGid) return [];
  const query = `#graphql
    query ProductMedia($id: ID!) {
      product(id: $id) {
        featuredImage { url }
        media(first: 12) {
          nodes { ... on MediaImage { image { url } } }
        }
      }
    }`;
  try {
    const resp = await admin.graphql(query, { variables: { id: shopifyGid } });
    const json = await resp.json();
    const p = json?.data?.product;
    if (!p) return [];
    const urls = [];
    const push = (u) => {
      const v = String(u || "").trim();
      if (v && !urls.includes(v)) urls.push(v);
    };
    // Featured image first so it's the primary reference; gallery angles follow.
    push(p.featuredImage?.url);
    for (const n of p.media?.nodes || []) push(n?.image?.url);
    return urls.slice(0, Math.max(1, max));
  } catch (err) {
    console.error(`[product-images] media fetch failed for ${shopifyGid}:`, err?.message || err);
    return [];
  }
}

export async function deleteProductByShopifyId(shop, shopifyId) {
  const gid = typeof shopifyId === "string" && shopifyId.startsWith("gid://")
    ? shopifyId
    : `gid://shopify/Product/${shopifyId}`;
  await prisma.product.deleteMany({ where: { shop, shopifyId: gid } });
}

export async function getCatalogSyncState(shop) {
  let state = await prisma.catalogSyncState.findUnique({ where: { shop } });
  if (!state) {
    state = await prisma.catalogSyncState.create({ data: { shop } });
  }
  return state;
}

async function setSyncState(shop, patch) {
  return prisma.catalogSyncState.upsert({
    where: { shop },
    update: { ...patch, updatedAt: new Date() },
    create: { shop, ...patch },
  });
}

// One sync per shop at a time. The state row is claimed in a single
// conditional update, so a second caller (manual refresh, nightly run,
// webhook burst) sees it taken and steps aside. A sync that stopped
// updating its row for a while (its process died) can be taken over.
const STALE_SYNC_MS = 15 * 60 * 1000;

async function claimSync(shop) {
  await prisma.catalogSyncState.upsert({ where: { shop }, update: {}, create: { shop } });
  const { count } = await prisma.catalogSyncState.updateMany({
    where: {
      shop,
      OR: [
        { status: { notIn: ["running", "stopping"] } },
        { updatedAt: { lt: new Date(Date.now() - STALE_SYNC_MS) } },
      ],
    },
    data: { status: "running", lastError: null, syncedSoFar: 0, updatedAt: new Date() },
  });
  return count === 1;
}

export async function syncCatalog(admin, shop) {
  if (!(await claimSync(shop))) {
    console.log(`[syncCatalog] ${shop}: a sync is already running — skipped`);
    return { ok: true, alreadyRunning: true };
  }
  try {
    const mappings = await getAttributeMappings(shop);
    const types = await metafieldTypes(admin, shop).catch(() => null);
    const productMf = productMetafieldFragment(mappings, types);
    const variantMf = buildMetafieldFragment(mappings, "variant", types);
    // Each chosen field makes a page of products costlier for Shopify; when a
    // page is over Shopify's per-query limit, fetch smaller pages instead.
    let pageSize = PRODUCTS_PAGE;
    let query = productsQuery(productMf, variantMf, pageSize);
    if (mappings.length > 0) {
      const prodCount = mappings.filter((m) => (m.target || "product") === "product").length;
      const varCount = mappings.filter((m) => m.target === "variant").length;
      console.log(
        `[syncCatalog] ${shop}: syncing with ${mappings.length} mappings (${prodCount} product, ${varCount} variant)`,
      );
    }

    let cursor = null;
    let totalSeen = 0;
    let throttleRetries = 0;
    const seenIds = new Set();
    for (;;) {
      const current = await prisma.catalogSyncState.findUnique({ where: { shop } });
      if (current?.status === "stopping") {
        console.log(`[syncCatalog] ${shop}: stopped by user at ${totalSeen} products`);
        await setSyncState(shop, { status: "idle", syncedSoFar: totalSeen });
        return { ok: true, count: totalSeen, stopped: true };
      }

      let json;
      try {
        const resp = await admin.graphql(query, { variables: { cursor } });
        json = await resp.json();
      } catch (err) {
        // The client may throw GraphQL errors instead of returning them.
        const errs = err?.body?.errors?.graphQLErrors || err?.body?.errors;
        if (Array.isArray(errs) && errs.length) json = { errors: errs };
        else if (/cost|throttl/i.test(err?.message || "")) json = { errors: [{ message: err.message }] };
        else throw err;
      }

      // Surface real GraphQL errors instead of dying with a generic
      // "no products data". Shopify cost-throttling mid-pagination is
      // the common one — back off and retry the same page.
      if (Array.isArray(json?.errors) && json.errors.length > 0) {
        const tooCostly = json.errors.some(
          (e) => e?.extensions?.code === "MAX_COST_EXCEEDED" || /max(imum)?.{0,10}cost|cost.{0,20}exceed/i.test(e?.message || ""),
        );
        if (tooCostly && pageSize > 1) {
          // "Query cost is 1829, which exceeds … (1000)" → size the page to fit.
          const msg = json.errors.map((e) => e?.message || "").join(" ");
          const cost = Number(msg.match(/cost is (\d+)/i)?.[1]);
          const limit = Number(msg.match(/limit \((\d+)\)/i)?.[1]) || 1000;
          pageSize = cost > 0
            ? Math.max(1, Math.min(pageSize - 1, Math.floor((pageSize * limit * 0.9) / cost)))
            : Math.max(1, Math.floor(pageSize / 2));
          query = productsQuery(productMf, variantMf, pageSize);
          console.log(`[syncCatalog] ${shop}: page too costly for Shopify, retrying with ${pageSize} products per page`);
          continue;
        }
        const throttled = json.errors.some(
          (e) => e?.extensions?.code === "THROTTLED" || /throttl/i.test(e?.message || ""),
        );
        if (throttled && throttleRetries < 5) {
          throttleRetries += 1;
          const waitMs = 2000 * throttleRetries;
          console.log(`[syncCatalog] ${shop}: throttled, retry ${throttleRetries}/5 in ${waitMs}ms`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw new Error("GraphQL: " + json.errors.map((e) => e?.message || "unknown").join("; "));
      }
      throttleRetries = 0;

      const page = json?.data?.products;
      if (!page) throw new Error("No products data in GraphQL response");
      console.log(`[syncCatalog] ${shop}: page of ${page.nodes?.length || 0}, total ${totalSeen}`);

      for (const node of page.nodes) {
        await upsertProduct(shop, node, mappings);
        seenIds.add(node.id);
        totalSeen += 1;
      }

      await setSyncState(shop, { syncedSoFar: totalSeen });

      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }

    // A complete pass saw every product in Shopify; anything else here was
    // deleted there (a missed delete webhook), so the chat stops linking it.
    // (Postgres takes up to ~32k values in one list; past that, skip.)
    if (seenIds.size > 0 && seenIds.size < 30000) {
      const removed = await prisma.product.deleteMany({ where: { shop, shopifyId: { notIn: [...seenIds] } } });
      if (removed.count) console.log(`[syncCatalog] ${shop}: removed ${removed.count} product(s) no longer in Shopify`);
    }

    await setSyncState(shop, {
      status: "idle",
      lastSyncedAt: new Date(),
      productsCount: totalSeen,
      syncedSoFar: totalSeen,
    });
    // Re-learn the store's policies and pages alongside the catalog, so
    // shipping/returns/FAQ answers never depend on a manual upload.
    syncStoreKnowledgeAsync({ admin, shop });
    // …and the orthotic finder, so a new or retired orthotic is picked up.
    refreshOrthoticFinderAsync({ admin, shop });
    return { ok: true, count: totalSeen };
  } catch (err) {
    const message = err?.message || String(err);
    console.error(`[syncCatalog] ${shop}:`, message);
    await setSyncState(shop, { status: "error", lastError: message });
    return { ok: false, error: message };
  }
}

export async function stopCatalogSync(shop) {
  return setSyncState(shop, { status: "stopping" });
}

export function syncCatalogAsync(admin, shop) {
  syncCatalog(admin, shop).catch((err) => {
    console.error(`[syncCatalogAsync] ${shop} unhandled:`, err);
  });
}

export async function getProductCount(shop) {
  return prisma.product.count({ where: { shop } });
}

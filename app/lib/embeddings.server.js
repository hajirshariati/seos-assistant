// Provider-agnostic embedding service. Used by:
// - product sync (one embedding per product)
// - chat search (one embedding per customer query)
//
// Both Voyage and OpenAI are supported. Voyage is recommended (cheapest,
// owned by Anthropic, 1024 dim natively). OpenAI is offered for merchants
// who already have an OpenAI account.
//
// All providers are normalized to 1024-dimensional vectors so the same
// pgvector column works regardless of provider choice.

export const EMBEDDING_DIMENSIONS = 1024;

const PROVIDERS = {
  voyage: {
    label: "Voyage AI",
    model: "voyage-3",
    endpoint: "https://api.voyageai.com/v1/embeddings",
  },
  openai: {
    label: "OpenAI",
    model: "text-embedding-3-small",
    endpoint: "https://api.openai.com/v1/embeddings",
  },
};

export function isProviderSupported(provider) {
  return provider === "voyage" || provider === "openai";
}

// Embed an array of texts in one API call. Returns array of vectors
// (each is a number[] of length EMBEDDING_DIMENSIONS), aligned with the
// input order. Throws on auth/network/rate-limit errors so callers can
// retry or surface a useful message to the merchant.
//
// `onUsage` (optional): invoked after a successful call with
// { totalTokens, provider, model } — both providers report
// usage.total_tokens in their responses. Best-effort accounting hook
// (per-chat cost tracking); callback errors never fail the embedding.
export async function embedTexts(provider, apiKey, texts, { inputType = "document", onUsage } = {}) {
  if (!isProviderSupported(provider)) {
    throw new Error(`Unsupported embedding provider: ${provider}`);
  }
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error(`Missing API key for ${provider}`);
  }
  const inputs = Array.isArray(texts) ? texts : [texts];
  if (inputs.length === 0) return [];

  const cfg = PROVIDERS[provider];
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  let body;
  if (provider === "voyage") {
    // Voyage takes input_type to optimize embeddings for query vs document.
    body = {
      model: cfg.model,
      input: inputs,
      input_type: inputType === "query" ? "query" : "document",
    };
  } else {
    // OpenAI: request 1024 dimensions explicitly so it matches Voyage's
    // native size — same DB column works for both providers.
    body = {
      model: cfg.model,
      input: inputs,
      dimensions: EMBEDDING_DIMENSIONS,
    };
  }

  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const truncated = errText.length > 300 ? errText.slice(0, 300) + "…" : errText;
    throw new Error(`${cfg.label} embedding error ${res.status}: ${truncated}`);
  }

  const data = await res.json();
  // Both providers return { data: [{ embedding: [...] }, ...] }
  if (!data || !Array.isArray(data.data) || data.data.length !== inputs.length) {
    throw new Error(`${cfg.label} returned malformed response`);
  }
  if (typeof onUsage === "function") {
    try {
      onUsage({
        totalTokens: Number(data?.usage?.total_tokens) || 0,
        provider,
        model: cfg.model,
      });
    } catch {
      // Usage accounting is best-effort — never fail the embedding.
    }
  }
  return data.data.map((d) => d.embedding);
}

// Convenience: embed a single text. Returns one vector.
export async function embedText(provider, apiKey, text, opts = {}) {
  const [vec] = await embedTexts(provider, apiKey, [text], opts);
  return vec;
}

// Build the text that gets embedded for a product. Combines title +
// vendor + product type + tags + truncated description + flattened
// attributes. Same shape on initial sync and on update so embeddings
// stay consistent.
export function productEmbeddingText(p) {
  const parts = [];
  if (p.title) parts.push(p.title);
  if (p.vendor) parts.push(p.vendor);
  if (p.productType) parts.push(p.productType);
  if (Array.isArray(p.tags) && p.tags.length > 0) parts.push(p.tags.join(" "));
  if (p.description) parts.push(String(p.description).slice(0, 1500));
  if (p.attributesJson && typeof p.attributesJson === "object") {
    const attrText = Object.entries(p.attributesJson)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => {
        const value = Array.isArray(v) ? v.join(" ") : String(v);
        return `${k}:${value}`;
      })
      .join(" ");
    if (attrText) parts.push(attrText);
  }
  return parts.join("\n").trim();
}

// Format a JS number[] as a pgvector literal: "[0.1,0.2,...]". Used when
// writing embeddings via $executeRaw.
export function vectorLiteral(vec) {
  return `[${vec.join(",")}]`;
}

// Resolve the (provider, apiKey) for a shop, or return null if semantic
// search isn't configured. Caller decides what to do (skip, log, etc).
export function resolveShopEmbedding(config) {
  const provider = config?.embeddingProvider || "";
  if (!isProviderSupported(provider)) return null;
  const apiKey = provider === "voyage" ? config.voyageApiKey : config.openaiApiKey;
  if (!apiKey) return null;
  return { provider, apiKey };
}

// Embed a batch of product rows and write the resulting vectors back to
// the Product table. Idempotent — call any time. Caller passes already-
// loaded product rows. Returns { processed, failed }.
export async function embedAndStoreProducts(prisma, provider, apiKey, products) {
  if (!Array.isArray(products) || products.length === 0) {
    return { processed: 0, failed: 0 };
  }
  const texts = products.map(productEmbeddingText);
  let vectors;
  try {
    vectors = await embedTexts(provider, apiKey, texts, { inputType: "document" });
  } catch (err) {
    console.error(`[embeddings] batch failed:`, err?.message || err);
    return { processed: 0, failed: products.length };
  }

  let processed = 0;
  let failed = 0;
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const v = vectors[i];
    if (!Array.isArray(v) || v.length !== EMBEDDING_DIMENSIONS) {
      failed++;
      continue;
    }
    try {
      const lit = vectorLiteral(v);
      await prisma.$executeRawUnsafe(
        `UPDATE "Product" SET embedding = $1::vector, "embeddingUpdatedAt" = NOW() WHERE id = $2`,
        lit,
        p.id,
      );
      processed++;
    } catch (err) {
      console.error(`[embeddings] write failed for ${p.id}:`, err?.message || err);
      failed++;
    }
  }
  return { processed, failed };
}

// Backfill all products in a shop that don't yet have an embedding.
// Runs in batches of 50 (safe for both Voyage and OpenAI). Stops at
// `maxBatches` to bound runtime — caller can re-invoke until done.
export async function backfillShopEmbeddings(prisma, shop, config, { batchSize = 50, maxBatches = 30 } = {}) {
  const resolved = resolveShopEmbedding(config);
  if (!resolved) return { skipped: true, reason: "no provider or api key" };

  let totalProcessed = 0;
  let totalFailed = 0;

  for (let batch = 0; batch < maxBatches; batch++) {
    // Fetch the next batch of products that still need embedding.
    // Filter directly on `embedding IS NULL` via raw SQL so each iteration
    // gets a fresh set — Prisma doesn't expose the vector column, so we
    // pull IDs first and then load the row data via the typed API.
    const missingRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM "Product"
       WHERE shop = $1 AND embedding IS NULL
       ORDER BY "updatedAt" DESC
       LIMIT $2`,
      shop,
      batchSize,
    );
    if (!Array.isArray(missingRows) || missingRows.length === 0) break;

    const ids = missingRows.map((r) => r.id);
    const rows = await prisma.product.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        title: true,
        vendor: true,
        productType: true,
        tags: true,
        description: true,
        attributesJson: true,
      },
    });
    if (rows.length === 0) break;

    const { processed, failed } = await embedAndStoreProducts(
      prisma,
      resolved.provider,
      resolved.apiKey,
      rows,
    );
    totalProcessed += processed;
    totalFailed += failed;
    if (processed === 0 && failed > 0) break; // bail out if API is broken
  }

  // Count remaining null-embedding products for status reporting.
  const remainingCountRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "Product" WHERE shop = $1 AND embedding IS NULL`,
    shop,
  );
  const totalRemaining = remainingCountRows?.[0]?.n || 0;

  return { processed: totalProcessed, failed: totalFailed, remaining: totalRemaining };
}

// Convenience for the product webhook: re-embed a single product after
// it's been upserted. Fire-and-forget — caller doesn't await. Failures
// log but don't block the webhook response.
export function embedSingleProductInBackground(prisma, shop, productId, config) {
  const resolved = resolveShopEmbedding(config);
  if (!resolved) return;
  Promise.resolve().then(async () => {
    try {
      const row = await prisma.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          title: true,
          vendor: true,
          productType: true,
          tags: true,
          description: true,
          attributesJson: true,
        },
      });
      if (!row) return;
      await embedAndStoreProducts(prisma, resolved.provider, resolved.apiKey, [row]);
    } catch (err) {
      console.error(`[embeddings] background embed for ${productId} failed:`, err?.message || err);
    }
  });
}

// RAG over merchant knowledge files. Three responsibilities:
//
// 1. CHUNK a knowledge file's full text into coherent sections.
//    Default strategy: split on `═══` divider lines (the merchant
//    convention this app's templates use), with a paragraph-window
//    fallback for files without dividers. Each chunk gets the
//    section title (the line above the second divider) for context.
//
// 2. EMBED + STORE chunks via the merchant's existing Voyage / OpenAI
//    setup. Same provider + key resolution as Product embedding —
//    no new admin config required. Idempotent on (sourceFileId):
//    saving a knowledge file deletes its old chunks and writes new
//    ones, so embeddings can never go stale.
//
// 3. RETRIEVE top-K chunks for a query string via cosine similarity
//    in pgvector. Returns chunks above SIMILARITY_THRESHOLD,
//    sorted by relevance. Caller (chat-prompt.server.js) injects
//    these into the system prompt instead of dumping the whole
//    knowledge corpus.

import { embedText, embedTexts, vectorLiteral, resolveShopEmbedding, EMBEDDING_DIMENSIONS } from "./embeddings.server.js";

// Tuneable defaults. Kept as constants here (not env vars) since
// changing them is a code-review discussion, not an ops setting.
const DEFAULT_RETRIEVAL_LIMIT = 5;
const DEFAULT_SIMILARITY_THRESHOLD = 0.35;
const PARAGRAPH_FALLBACK_TARGET_CHARS = 800;
const PARAGRAPH_FALLBACK_MAX_CHARS = 1400;

// Split a knowledge-file string into ordered chunks. Each chunk is
// `{ sectionTitle, content }`. Strategy:
//   1. If the text has `═══` divider lines (Aetrex template style),
//      split on those — each section becomes one chunk and the
//      first non-divider line below is treated as the title.
//   2. Otherwise paragraph-pack: combine `\n\n`-separated paragraphs
//      into chunks of ~800 chars (max ~1400) so a chunk is always
//      a coherent block of meaning.
export function chunkKnowledgeFile(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return [];

  if (text.includes("═══")) return chunkByDividers(text);
  return chunkByParagraphs(text);
}

function chunkByDividers(text) {
  // Split on a run of three or more `═` characters (with optional
  // surrounding whitespace), which is how the templates draw the
  // section headers. Filter empties.
  const segments = text
    .split(/\n[═]{3,}\n/g)
    .map((s) => s.trim())
    .filter(Boolean);

  // Each section in the template alternates: TITLE / DIVIDER / BODY /
  // DIVIDER / TITLE / DIVIDER / BODY / ... so after splitting on
  // dividers we get [pre-section preamble?, TITLE, BODY, TITLE, BODY,
  // ...]. Walk pairwise: title comes from the segment that's just a
  // header line, body from the next.
  const out = [];
  let pendingTitle = null;
  for (const seg of segments) {
    const isShortHeader = seg.length < 120 && !seg.includes("\n");
    if (isShortHeader) {
      pendingTitle = seg;
      continue;
    }
    out.push({
      sectionTitle: pendingTitle || null,
      content: seg,
    });
    pendingTitle = null;
  }
  return out
    .map((c, i) => ({ ...c, chunkIndex: i }))
    .filter((c) => c.content && c.content.length > 0);
}

function chunkByParagraphs(text) {
  const paragraphs = text.split(/\n\n+/g).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let buf = "";
  let title = null;
  for (const para of paragraphs) {
    // First short line of a chunk doubles as the section title.
    if (!buf && para.length < 120 && !para.includes("\n") && !title) {
      title = para;
    }
    if (buf.length + para.length + 2 > PARAGRAPH_FALLBACK_MAX_CHARS) {
      if (buf) out.push({ sectionTitle: title, content: buf.trim() });
      buf = para;
      title = null;
    } else if (buf.length + para.length > PARAGRAPH_FALLBACK_TARGET_CHARS) {
      buf = buf ? `${buf}\n\n${para}` : para;
      out.push({ sectionTitle: title, content: buf.trim() });
      buf = "";
      title = null;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  if (buf) out.push({ sectionTitle: title, content: buf.trim() });
  return out.map((c, i) => ({ ...c, chunkIndex: i }));
}

// Replace all chunks for a (shop, sourceFileId) pair with the supplied
// list. Used both on initial backfill and on knowledge-file edit:
// idempotent rebuild ensures embeddings can never go stale.
//
// `chunks` should be the output of chunkKnowledgeFile(...). `provider`
// + `apiKey` come from resolveShopEmbedding(config). If the shop
// doesn't have a provider configured, this is a no-op.
export async function rebuildChunksForFile(prisma, { shop, sourceFileId, fileType, content, provider, apiKey }) {
  if (!shop || !fileType) return { skipped: true, reason: "missing shop or fileType" };
  if (!provider || !apiKey) return { skipped: true, reason: "no embedding provider" };

  const chunks = chunkKnowledgeFile(content);
  if (chunks.length === 0) {
    await prisma.knowledgeChunk.deleteMany({ where: { shop, sourceFileId: sourceFileId || undefined } });
    return { processed: 0, removed: 0 };
  }

  // Embed everything first; if it fails, leave the existing chunks
  // intact rather than wiping them on a bad provider day.
  let vectors;
  try {
    vectors = await embedTexts(provider, apiKey, chunks.map((c) => c.content), { inputType: "document" });
  } catch (err) {
    console.error(`[knowledge-chunks] embed batch failed for shop=${shop} file=${sourceFileId || fileType}:`, err?.message || err);
    return { failed: chunks.length, error: err?.message || String(err) };
  }
  if (!Array.isArray(vectors) || vectors.length !== chunks.length) {
    return { failed: chunks.length, error: "vector count mismatch" };
  }

  // Wipe + replace. Done as a transaction so a failed mid-write
  // can't leave the table half-empty.
  const removed = await prisma.knowledgeChunk.deleteMany({
    where: sourceFileId
      ? { shop, sourceFileId }
      : { shop, fileType, sourceFileId: null },
  });

  let processed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const v = vectors[i];
    if (!Array.isArray(v) || v.length !== EMBEDDING_DIMENSIONS) continue;
    const created = await prisma.knowledgeChunk.create({
      data: {
        shop,
        sourceFileId: sourceFileId || null,
        fileType,
        sectionTitle: c.sectionTitle || null,
        chunkIndex: c.chunkIndex,
        content: c.content,
        embeddingProvider: provider,
        embeddingUpdatedAt: new Date(),
      },
    });
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "KnowledgeChunk" SET embedding = $1::vector WHERE id = $2`,
        vectorLiteral(v),
        created.id,
      );
      processed++;
    } catch (err) {
      console.error(`[knowledge-chunks] embedding write failed for chunk ${created.id}:`, err?.message || err);
    }
  }

  return { processed, removed: removed.count };
}

// Retrieve the top-K most semantically similar chunks for a query
// string. Returns `[{ id, fileType, sectionTitle, content, similarity }]`.
// Caller decides what to do with them (typically: inject into system
// prompt under the "=== Relevant knowledge ===" header).
//
// Returns [] when the shop has no embedding provider, no chunks
// embedded yet, or the query is empty — the caller's prompt-builder
// should fall back to the legacy full-dump path in that case.
//
// Return contract: `null` means retrieval COULD NOT run (no provider,
// embed failure, db error, no chunks embedded) — caller falls back to
// the full knowledge dump. An ARRAY (possibly empty) means retrieval
// ran against real embeddings; an empty array is an authoritative
// "nothing in the knowledge corpus is relevant to this message" and
// the caller should inject NOTHING, not the 10-30K full dump.
export async function retrieveRelevantChunks(prisma, { shop, query, config, limit = DEFAULT_RETRIEVAL_LIMIT, threshold = DEFAULT_SIMILARITY_THRESHOLD, onEmbeddingUsage }) {
  if (!shop || !query || !String(query).trim()) return null;
  const resolved = resolveShopEmbedding(config);
  if (!resolved) return null;

  let queryVec;
  try {
    queryVec = await embedText(resolved.provider, resolved.apiKey, String(query), { inputType: "query", onUsage: onEmbeddingUsage });
  } catch (err) {
    console.error(`[knowledge-chunks] query embed failed for shop=${shop}:`, err?.message || err);
    return null;
  }
  if (!Array.isArray(queryVec) || queryVec.length !== EMBEDDING_DIMENSIONS) return null;

  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT id, "fileType", "sectionTitle", content, 1 - (embedding <=> $1::vector) AS similarity
       FROM "KnowledgeChunk"
       WHERE shop = $2 AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      vectorLiteral(queryVec),
      shop,
      limit * 3, // over-fetch then filter by threshold
    );
  } catch (err) {
    console.error(`[knowledge-chunks] retrieval query failed for shop=${shop}:`, err?.message || err);
    return null;
  }

  // No embedded chunks at all for this shop → retrieval is not really
  // operational (RAG enabled before the backfill ran). Treat as
  // unavailable so the caller still injects the full knowledge dump.
  if (!Array.isArray(rows) || rows.length === 0) return null;

  return (rows || [])
    .map((r) => ({
      id: r.id,
      fileType: r.fileType,
      sectionTitle: r.sectionTitle,
      content: r.content,
      similarity: Number(r.similarity),
    }))
    .filter((r) => Number.isFinite(r.similarity) && r.similarity >= threshold)
    .slice(0, limit);
}

// LEXICAL retrieval fallback (no DB, no embeddings). When semantic RAG returns
// nothing for a knowledge/policy turn, scan the uploaded knowledge files by
// KEYWORD overlap and return the best-matching sections — so the bot answers
// from knowledge it actually has instead of punting to support (ownership audit
// 2026-07). Pure + synchronous. `knowledge` is the getKnowledgeFilesWithContent
// shape ([{ fileType, content }]). Returns the same shape retrieveRelevantChunks
// does — `[{ fileType, sectionTitle, content, similarity }]` — so the injection
// path and the policy engine consume it identically. `similarity` is a synthetic
// score from keyword overlap (kept above the policy engine's 0.35 floor).
const LEXICAL_STOPWORDS = new Set([
  "what", "when", "where", "which", "does", "do", "did", "you", "your", "the", "and", "for",
  "are", "is", "can", "how", "with", "that", "this", "have", "has", "about", "need", "want",
  "provide", "information", "info", "please", "would", "should", "could", "there", "their",
  "give", "get", "from", "into", "will", "any", "all", "some",
]);
function lexicalContentWords(text) {
  return [...new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !LEXICAL_STOPWORDS.has(w)),
  )];
}
export function lexicalRetrieveChunks(knowledge = [], query = "", { limit = 3, minOverlap = 0.34 } = {}) {
  const files = Array.isArray(knowledge) ? knowledge : [];
  const qWords = lexicalContentWords(query);
  if (qWords.length === 0) return [];
  const scored = [];
  for (const f of files) {
    const fileType = String(f?.fileType || f?.type || "knowledge");
    const chunks = chunkKnowledgeFile(String(f?.content || ""));
    for (const c of chunks) {
      const hay = `${String(c.sectionTitle || "")} ${String(c.content || "")}`.toLowerCase();
      const hits = qWords.filter((w) => hay.includes(w)).length;
      const overlap = hits / qWords.length;
      if (overlap >= minOverlap) {
        scored.push({
          fileType,
          sectionTitle: c.sectionTitle || null,
          content: c.content,
          similarity: Math.min(0.5 + overlap * 0.35, 0.95),
          _lexical: true,
        });
      }
    }
  }
  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

// Convenience: count how many chunks a shop has embedded. Used by
// the backfill script and the admin UI to display progress.
export async function countShopChunks(prisma, shop) {
  if (!shop) return 0;
  return prisma.knowledgeChunk.count({ where: { shop } });
}

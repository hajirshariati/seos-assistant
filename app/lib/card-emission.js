// Card emission truth: the cards the widget renders must be the cards the turn
// finalized — after commerce-truth repairs, retries, and handoff wipes.
//
// Live trace 2026-10-16: the evidence plan pinned two orthotics on a "red shoes"
// request; enforceCommerceTruth correctly dropped them ("cards=0") — but the
// `products` SSE event had already been written into the attempt buffer, so the
// customer still saw both orthotic cards. The storefront widget also APPENDS
// every products event, so a later corrective event cannot remove earlier
// cards. At flush we therefore collapse all buffered products events into ONE
// event carrying the authoritative final cards, and drop a Visualize CTA whose
// product is no longer shown.

const decoder = new TextDecoder();

function parseEvent(chunk) {
  try {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk);
    const m = text.match(/^data: (.*)\n\n$/s);
    if (!m) return null;
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function cardKey(card) {
  return String(card?.handle || card?.title || "").toLowerCase();
}

// chunks: buffered SSE chunks (Uint8Array or string). finalCards: the turn's
// authoritative cards (null/undefined → leave the buffer untouched).
// encode(obj) → chunk in the buffer's format.
export function reconcileBufferedCardEvents(chunks = [], finalCards, encode) {
  if (!Array.isArray(finalCards) || typeof encode !== "function") {
    return { chunks, changed: false, emitted: null, final: null };
  }
  const finalKeys = new Set(finalCards.map(cardKey).filter(Boolean));
  const out = [];
  let emitted = [];
  let productsSeen = 0;
  let insertedAt = -1;
  let droppedViz = false;
  for (const chunk of chunks) {
    const ev = parseEvent(chunk);
    if (ev?.type === "products") {
      productsSeen++;
      emitted = emitted.concat(Array.isArray(ev.products) ? ev.products : []);
      if (insertedAt === -1) {
        insertedAt = out.length;
        out.push(null); // placeholder for the single authoritative event
      }
      continue;
    }
    if (ev?.type === "visualize_cta" && !finalKeys.has(String(ev.productHandle || "").toLowerCase())) {
      droppedViz = true;
      continue;
    }
    out.push(chunk);
  }
  const finalEvent = encode({ type: "products", products: finalCards });
  if (insertedAt === -1) out.unshift(finalEvent);
  else out[insertedAt] = finalEvent;

  const emittedKeys = emitted.map(cardKey);
  const same =
    productsSeen <= 1 &&
    !droppedViz &&
    emittedKeys.length === finalCards.length &&
    emittedKeys.every((k, i) => k === cardKey(finalCards[i]));
  return { chunks: out, changed: !same, emitted: emitted.length, final: finalCards.length, droppedViz };
}

// "Show me something similar" — which product fields make sense to match on.
//
// A field is a useful "similar" quality when its values are short and shared
// by many products (activity, material, helps with). Long text (descriptions,
// care instructions), one-of-a-kind values and numbers (rating, review count)
// never match another product meaningfully, so they aren't offered.
//
// rows: [{ key, n, distinct_n, avg_len, numeric_share }] from the catalog.
export function similarityOptions(rows = [], chosen = [], always = new Set()) {
  const picked = new Set(chosen.map((c) => String(c).toLowerCase()));
  return rows.filter((r) => {
    const key = String(r.key || "").toLowerCase();
    if (!key || always.has(key)) return false;
    if (picked.has(key)) return true; // keep anything already ticked, so it can be unticked
    const n = Number(r.n) || 0;
    const distinct = Number(r.distinct_n) || 0;
    return (
      n >= 2 &&
      distinct >= 2 &&
      distinct <= Math.max(12, n * 0.5) &&
      (Number(r.avg_len) || 0) <= 60 &&
      (Number(r.numeric_share) || 0) < 0.5
    );
  });
}

// "Arch Pain, Plantar Fasciitis" → ["arch pain", "plantar fasciitis"]
export function valueParts(v) {
  return String(v || "").toLowerCase().split(/\s*[,;|]\s*/).map((s) => s.trim()).filter(Boolean);
}

// How much two values share: 1 for the same value, a fraction when lists
// overlap ("Arch Pain, Heel Pain" vs "Arch Pain"), 0 when nothing is shared.
export function valueOverlap(a, b) {
  const pa = new Set(valueParts(a));
  const pb = new Set(valueParts(b));
  if (!pa.size || !pb.size) return 0;
  let shared = 0;
  for (const x of pa) if (pb.has(x)) shared += 1;
  return shared / new Set([...pa, ...pb]).size;
}

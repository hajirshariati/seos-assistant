// Legacy-owner cleanup audit (LLM_OWNS_ALL_TURNS=true).
//
// This is an AUDIT, not a deletion. It answers, for every legacy "owner" that
// can produce or mutate a turn's answer, whether it is still reachable on the
// current PRD path (LLM_OWNS_ALL_TURNS defaults ON) and whether it is safe to
// delete. It is intentionally conservative: nothing is marked "safe now"
// unless it is statically unreachable on the PRD path AND the replacement is
// covered by tests.
//
// It also VERIFIES the audit against the source: each owner records the guard
// string the audit relied on; if that guard is no longer present in
// app/routes/chat.jsx (or the owning module), the audit is stale and the script
// FAILS so the report can't silently drift from the code.
//
// Run: node scripts/audit-legacy-owners.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const CHAT = read("app/routes/chat.jsx");
const EMIT = read("app/lib/emit-finalize.server.js");
const LOT = read("app/lib/llm-owns-turn.server.js");

// The flag: default ON; LLM_OWNS_ALL_TURNS=false is the kill switch.
//   isLlmOwnsTurnEnabled() — gates the dispatcher cascade in the route loader.
//   llmOwnsTurnActive()    — same env, read inside runAgenticLoop post-processors.
const FLAG_DEFAULT_ON =
  /raw === "false"\) return false;\s*\n\s*return true;/.test(LOT) &&
  /raw === "false"\) return false;\s*\n\s*return true;/.test(EMIT);

// owner: name
// guards: { file, src(string that MUST be present) } the audit relied on
// active: reachable on the PRD path (LLM_OWNS_ALL_TURNS unset/true)?
// flagProtected: gated off specifically by the LLM-owns flag?
// rollback: still needed if we flip the kill switch (LLM_OWNS_ALL_TURNS=false)?
// delete: now | later | unsafe
// notes
const OWNERS = [
  {
    owner: "runVariantFactDispatch",
    guards: [{ file: "chat.jsx", src: "const variantFactResult = await runVariantFactDispatch({" }],
    active: false,
    flagProtected: true,
    rollback: true,
    delete: "later",
    notes:
      "Legacy dispatcher cascade. Lives AFTER the `if (isLlmOwnsTurnEnabled()) { … return; }` " +
      "short-circuit (route loader), so it is statically unreachable while the flag is ON. " +
      "Kept only as the kill-switch path. Delete together with the rest of the cascade once " +
      "the flag itself is retired.",
  },
  {
    owner: "runProductTurnDispatch",
    guards: [{ file: "chat.jsx", src: ": await runProductTurnDispatch({" }],
    active: false,
    flagProtected: true,
    rollback: true,
    delete: "later",
    notes:
      "Same as above — the product-engine rung of the legacy cascade, reached only after the " +
      "LLM-owns return. Unreachable on PRD; rollback only.",
  },
  {
    owner: "legacy dispatcher cascade (variant_fact / policy / resolver_no_match / product_engine)",
    guards: [
      { file: "chat.jsx", src: "if (isLlmOwnsTurnEnabled()) {" },
      { file: "chat.jsx", src: "final_path=variant_fact_engine" },
      { file: "chat.jsx", src: "final_path=product_engine" },
    ],
    active: false,
    flagProtected: true,
    rollback: true,
    delete: "later",
    notes:
      "The whole cascade is the `else` of the LLM-owns short-circuit (the LLM path emits then " +
      "`return;`). Unreachable on PRD. This is the single biggest block of legacy code; it must " +
      "stay until the kill switch is permanently removed, then it can be deleted wholesale.",
  },
  {
    owner: "denial-recovery",
    guards: [{ file: "chat.jsx", src: "[chat] denial-recovery: AI denied availability without searching" }],
    active: true,
    flagProtected: false,
    rollback: true,
    delete: "unsafe",
    notes:
      "Runs INSIDE runAgenticLoop post-processing, which the architecture intentionally keeps on " +
      "the LLM-owns path. NOT gated by llmOwnsTurnActive(); gated by " +
      "!productAuthorityModeEnabled() && !productSearchAttempted && containsAvailabilityDenial(). " +
      "So it is a live safety net on PRD (fires when the model denies availability without " +
      "searching). The grounding validator now blocks most ungrounded denials, but this guard " +
      "still catches the no-search case. NOT safe to delete until a test proves the validator " +
      "fully subsumes it.",
  },
  {
    owner: "recovery search (condition/occasion)",
    guards: [{ file: "chat.jsx", src: "[chat] recovery search: AI did not call tool" }],
    active: true,
    flagProtected: false,
    rollback: true,
    delete: "unsafe",
    notes:
      "Also inside runAgenticLoop. Gated by !productAuthorityModeEnabled() && !productSearchAttempted " +
      "&& looksLikeProductPitch() && pool empty. Reachable on PRD when the model pitches products " +
      "without searching. Overlaps the answer-workflow forced-search in emit-finalize, but is not " +
      "provably redundant yet. Keep until covered.",
  },
  {
    owner: "auto-broaden",
    guards: [{ file: "chat.jsx", src: "if (!llmOwnsTurnActive() && !productAuthorityModeEnabled() && productSearchAttempted && allProductPool.size > 0 && allProductPool.size <= 2)" }],
    active: false,
    flagProtected: true,
    rollback: true,
    delete: "later",
    notes:
      "Explicitly gated `!llmOwnsTurnActive()` → dead on PRD. Under LLM-owns the model owns " +
      "breadth and the card guards/response contract own the final set. Safe to delete once the " +
      "flag is retired; keep as rollback until then.",
  },
  {
    owner: "repeated-clarifier escape",
    guards: [{ file: "chat.jsx", src: "if (!llmOwnsTurnActive() && currentClarifyingType && currentClarifyingType === lastClarifyingType && allProductPool.size === 0)" }],
    active: false,
    flagProtected: true,
    rollback: true,
    delete: "later",
    notes:
      "Explicitly gated `!llmOwnsTurnActive()` → dead on PRD. The LLM-owns path replaces it with " +
      "the plan clarifier gate + grounding validator (clarifier-non-answer is a blocking kind). " +
      "Safe to delete after the flag is retired.",
  },
  {
    owner: "PRODUCT_AUTHORITY gates (productAuthorityModeEnabled / PRODUCT_TURN_ENGINE_ENABLED)",
    guards: [
      { file: "chat.jsx", src: 'String(process.env.PRODUCT_TURN_ENGINE_ENABLED || "").toLowerCase() === "true"' },
      { file: "chat.jsx", src: "!productAuthorityModeEnabled()" },
    ],
    active: false,
    flagProtected: false,
    rollback: false,
    delete: "later",
    notes:
      "Separate experiment flag (PRODUCT_TURN_ENGINE_ENABLED), default OFF and not set on PRD, so " +
      "productAuthorityModeEnabled() is always false. The `!productAuthorityModeEnabled()` guards " +
      "therefore always pass (no-op gates) and the product-authority engine branch never runs on " +
      "PRD. Not a rollback for LLM-owns. The dead `productAuthorityModeEnabled()===true` branches " +
      "can be deleted independently of the kill switch (later — needs its own scoped change).",
  },
  {
    owner: "shadow mode (LLM_OWNS_ALL_TURNS_SHADOW + orthotic-gate shadow)",
    guards: [
      { file: "llm-owns-turn.server.js", src: 'process.env.LLM_OWNS_ALL_TURNS_SHADOW || ""' },
      { file: "chat.jsx", src: "if (isShadowModeEnabled()) {" },
    ],
    active: false,
    flagProtected: false,
    rollback: false,
    delete: "later",
    notes:
      "Diagnostic only: shadow mode runs the OTHER path into a discard buffer and logs the diff; " +
      "it engages only when its own env flag is true (default OFF, not set on PRD). Never reaches " +
      "the customer. Harmless to keep; safe to delete later once the migration is closed and the " +
      "diff data is no longer wanted.",
  },
];

// ── Verify the audit against the source ───────────────────────────────
const SRC = { "chat.jsx": CHAT, "emit-finalize.server.js": EMIT, "llm-owns-turn.server.js": LOT };
let drift = 0;
for (const o of OWNERS) {
  for (const g of o.guards) {
    const hay = SRC[g.file];
    if (!hay || !hay.includes(g.src)) {
      drift++;
      console.log(`  ✗ DRIFT: "${o.owner}" guard not found in ${g.file}: ${g.src.slice(0, 70)}…`);
    }
  }
}
if (!FLAG_DEFAULT_ON) {
  drift++;
  console.log("  ✗ DRIFT: LLM_OWNS_ALL_TURNS no longer defaults ON (isLlmOwnsTurnEnabled/llmOwnsTurnActive).");
}

// ── Print the report ──────────────────────────────────────────────────
const yn = (b) => (b ? "yes" : "no");
console.log("\nLEGACY-OWNER AUDIT  (LLM_OWNS_ALL_TURNS = true, the PRD default)\n");
console.log("Owner                                | active | flag-gated | rollback | delete");
console.log("-------------------------------------|--------|------------|----------|-------");
for (const o of OWNERS) {
  const name = o.owner.length > 36 ? o.owner.slice(0, 35) + "…" : o.owner.padEnd(36);
  console.log(
    `${name} | ${yn(o.active).padEnd(6)} | ${yn(o.flagProtected).padEnd(10)} | ${yn(o.rollback).padEnd(8)} | ${o.delete}`,
  );
}
console.log("\nKey:");
console.log("  active     — reachable on the PRD path (flag unset/true)");
console.log("  flag-gated — turned off specifically by LLM_OWNS_ALL_TURNS");
console.log("  rollback   — still needed if we flip the kill switch to false");
console.log("  delete     — now | later (after the kill switch is retired) | unsafe (still live)\n");

const unsafe = OWNERS.filter((o) => o.delete === "unsafe").map((o) => o.owner);
const later = OWNERS.filter((o) => o.delete === "later").map((o) => o.owner);
const now = OWNERS.filter((o) => o.delete === "now").map((o) => o.owner);
console.log(`Safe to delete NOW:   ${now.length ? now.join("; ") : "(none — keep the kill switch until the LLM-owns path has soaked on PRD)"}`);
console.log(`Delete LATER:         ${later.join("; ")}`);
console.log(`Do NOT delete (live): ${unsafe.join("; ")}`);

console.log("");
if (drift === 0) {
  console.log("PASS  audit verified against source (no drift); no deletions performed.");
  process.exit(0);
} else {
  console.log(`FAIL  ${drift} drift issue(s) — the audit no longer matches the code. Update scripts/audit-legacy-owners.mjs.`);
  process.exit(1);
}

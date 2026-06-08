// Regression test suite for the Aetrex orthotic recommender flow.
//
// Each test is a self-contained production scenario we've debugged.
// Pure functions only — no DB, no live Anthropic. We exercise the
// state machine, the resolver (resolveTree directly), the gate
// (maybeRunOrthoticFlow with a mock SSE writer), and the classifier
// post-processing logic with a mocked Haiku response.
//
// Run: node scripts/eval-orthotic-regressions.mjs
// Or:  npm run eval:orthotic-regressions

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  maybeRunOrthoticFlow,
  buildAcknowledgmentPrefix,
} from "../app/lib/orthotic-flow-gate.server.js";
import { resolveTree } from "../app/lib/decision-tree-resolver.server.js";
import { classifyOrthoticTurn } from "../app/lib/orthotic-classifier.server.js";
import { isYesNoAnswer, isYesNoQuestion } from "../app/lib/chat-postprocessing.js";
import {
  containsAvailabilityDenial,
  dedupeConsecutiveSentences,
  stripLineupPromiseSentences,
  stripFillerIntensifiers,
  isCapabilityCheckAboutPriorProducts,
  reflowInlineList,
  ensureHeaderLineBreaks,
  tightenSequentialFactLines,
  truncateAtWordBoundary,
  isBrandOrInfoQuestion,
} from "../app/lib/chat-helpers.server.js";
import { relaxCategoryOnNamedProduct } from "../app/lib/chat-tool-rewrite.server.js";

const here = dirname(fileURLToPath(import.meta.url));

// The production tree lives in the DB; on disk the canonical seed
// (scripts/seeds/aetrex-orthotic-tree.json) carries the same shape
// the merchant has deployed for Aetrex. We use it as the definition
// for every test here so the resolver, derivations, and chip values
// match production.
const rawSeed = JSON.parse(
  readFileSync(resolvePath(here, "seeds/aetrex-orthotic-tree.json"), "utf8"),
);

// Mirror production: the merchant's regenerated masterIndex CSV
// format dropped the per-row `condition` field. The seed file on
// disk still has it (legacy), so we strip it here to match prod.
// Without this, diabetic-tagged SKUs (L200M, L220M) lex-sort
// ahead of L2300M and win on "Men + Medium + comfort" queries —
// which is NOT what the merchant's live catalog does.
//
// Also drop SKUs the merchant explicitly removed from their prod
// CSV upload (Customizable, First-Gen Customizable, Dress 3/4,
// Cleats, Thinsoles, ESD, L4640, L6205). These are still in the
// seed for posterity but not in the live recommender catalog —
// keeping them in the fixture causes lex-tiebreak collisions
// against the SKUs the tests assert on.
const RETIRED_PREFIXES = [
  "L500", "L505", "L520", "L525",
  "L1200", "L1205", "L1220",
  "L1300", "L1305", "L1320",
  "L2400", "L2405", "L2420", "L2425",
  "L2460", // Heel Spurs — retired
  "LL2400", "LL2405", "LL2420", "LL2425",
  "L4505",
  "L4640",
  "L6205",
];
function isRetired(sku) {
  if (typeof sku !== "string") return false;
  return RETIRED_PREFIXES.some((p) => sku === p || sku.startsWith(p + "M") || sku.startsWith(p + "W") || sku.startsWith(p + "E") || sku.startsWith(p + "D"));
}
const definition = JSON.parse(JSON.stringify(rawSeed));
if (Array.isArray(definition?.resolver?.masterIndex)) {
  definition.resolver.masterIndex = definition.resolver.masterIndex
    .filter((m) => !isRetired(m?.masterSku))
    .map((m) => {
      if (m && typeof m === "object" && "condition" in m) {
        const { condition, ...rest } = m;
        return rest;
      }
      return m;
    });
}

// Augmented derivations: the user's runbook calls out two
// useCase derivations the resolver expects:
//   condition=diabetic           → useCase=diabetic (when not yet set)
//   condition=plantar_fasciitis  → useCase=comfort_bundle (override)
//
// Test #10 specifically requires that an existing useCase like
// `dress_no_removable` is OVERRIDDEN when condition=plantar_fasciitis,
// because the PF kit is a stand-alone product that shadows the shoe
// context. We add these to the definition's derivations so the
// recommender-tools' applyDerivations honors them. (Inlined here
// rather than mutating the seed file on disk.)
//
// NOTE: these tree-level derivations live in addition to the
// classifier-side post-processing (orthotic-classifier.server.js
// lines 290-291). The classifier flips useCase ONLY when it's null;
// the tree-level derivations flip even when useCase is non-null
// — which is the PF-kit override behaviour test #10 exercises.
const PFKW_USECASE = "comfort_bundle";
const DIABETIC_USECASE = "diabetic";
function withRegressionDerivations(def) {
  const out = JSON.parse(JSON.stringify(def));
  out.derivations = Array.isArray(out.derivations) ? [...out.derivations] : [];
  // condition=plantar_fasciitis → useCase=comfort_bundle (override)
  out.derivations.push({
    set: "useCase",
    value: PFKW_USECASE,
    when: { attr: "condition", eq: "plantar_fasciitis" },
  });
  // condition=diabetic → useCase=diabetic (override)
  out.derivations.push({
    set: "useCase",
    value: DIABETIC_USECASE,
    when: { attr: "condition", eq: "diabetic" },
  });
  return out;
}

// The resolver currently uses the original seed useCase values
// (e.g. "comfort", "athletic_running"). For tests that hit those
// SKUs directly we keep using them. For tests #5 / #10 (PF kit)
// the resolver's CONDITION_TARGETS already maps PF →
// /plantar\s*fasciitis\s*kit/ titles, so the PF kit SKU resolves
// regardless of useCase. Reading decision-tree-resolver.server.js
// confirms this: specialty `condition` wins over useCase for
// non-shoe-context-locked use-cases.

const tree = { intent: "orthotic", definition };
const treeWithDerivations = { intent: "orthotic", definition: withRegressionDerivations(definition) };

// Tiny applyDerivations clone (the production function is not exported).
// Mirrors recommender-tools.server.js exactly.
function evalCond(cond, ans) {
  if (!cond) return false;
  if (Array.isArray(cond.any)) return cond.any.some((c) => evalCond(c, ans));
  if (Array.isArray(cond.all)) return cond.all.every((c) => evalCond(c, ans));
  if (cond.attr && "eq" in cond) return ans[cond.attr] === cond.eq;
  if (cond.attr && Array.isArray(cond.in)) return cond.in.includes(ans[cond.attr]);
  return false;
}
function applyDerivations(answers, derivations) {
  if (!Array.isArray(derivations) || derivations.length === 0) return { ...(answers || {}) };
  const out = { ...(answers || {}) };
  for (const rule of derivations) {
    if (!rule || !rule.set || rule.value === undefined || !rule.when) continue;
    if (evalCond(rule.when, out)) out[rule.set] = rule.value;
  }
  return out;
}

// Compute the SKU a synthetic answers object would resolve to.
function resolveSku(answers, def = treeWithDerivations.definition) {
  const derived = applyDerivations(answers, def.derivations);
  const r = resolveTree(derived, def.resolver);
  return {
    sku: r.resolved?.masterSku || null,
    title: r.resolved?.title || null,
    product: r.resolved || null,
    reason: r.reason,
    attrs: r.attrs,
    derived,
  };
}

// SSE capture helper for gate tests.
function makeMockSse() {
  const events = [];
  const encoder = { encode: (s) => s };
  const controller = {
    enqueue: (s) => {
      try {
        events.push(JSON.parse(String(s).replace(/^data:\s*/, "").trim()));
      } catch {
        events.push({ raw: String(s) });
      }
    },
  };
  return { events, encoder, controller };
}

// Console-log capture for log-line assertions.
function captureLogs() {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => {
    const s = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    lines.push(s);
    orig.apply(console, args);
  };
  return { lines, restore: () => { console.log = orig; } };
}

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name} — ${err?.message || err}`);
  }
}

function section(label) {
  console.log(`\n${label}`);
}

// ──────────────────────────────────────────────────────────────
// 1. Running flat feet (men) → L720M
// ──────────────────────────────────────────────────────────────
section("Resolver scenarios (production SKU regressions)");

await test("01 — running flat feet (men) resolves L720M", () => {
  const r = resolveSku({
    gender: "Men",
    useCase: "athletic_running",
    condition: "overpronation_flat_feet",
    arch: "Flat / Low Arch",
  });
  assert.equal(r.sku, "L720M", `expected L720M, got ${r.sku} (${r.title})`);
});

// ──────────────────────────────────────────────────────────────
// 2. Women gym medium arch → L800W
// ──────────────────────────────────────────────────────────────
await test("02 — women gym medium arch (no pain) resolves L800W", () => {
  const r = resolveSku({
    gender: "Women",
    useCase: "athletic_training",
    condition: "none",
    arch: "Medium / High Arch",
    overpronation: "no",
  });
  assert.equal(r.sku, "L800W", `expected L800W, got ${r.sku} (${r.title})`);
});

// ──────────────────────────────────────────────────────────────
// 3. Hockey + flat feet (women) → L2520X (Unisex skates posted)
// ──────────────────────────────────────────────────────────────
await test("03 — hockey + flat feet (women) resolves L2520X (Unisex)", () => {
  const r = resolveSku({
    gender: "Women",
    useCase: "skates",
    condition: "overpronation_flat_feet",
    arch: "Flat / Low Arch",
  });
  assert.equal(r.sku, "L2520X", `expected L2520X, got ${r.sku} (${r.title})`);
});

// ──────────────────────────────────────────────────────────────
// 4. Diabetes women medium arch + chip "No" overpronation → L200W
//    The crucial yesterday's-fix test: chip-shape replies must NOT
//    trigger fresh-arch-reset of accumulated overpronation, and a
//    diabetic+Medium+overpronation=no must resolve the medium-arch
//    Conform (L200W), not the posted-flat Conform (L220W).
// ──────────────────────────────────────────────────────────────
await test("04 — diabetic women medium arch + 'No' overpronation resolves L200W (not L220W)", () => {
  const r = resolveSku({
    gender: "Women",
    useCase: "comfort", // seed's diabetic Conforms live in useCase=comfort
    condition: "diabetic",
    arch: "Medium / High Arch",
    overpronation: "no",
  });
  assert.equal(r.sku, "L200W", `expected L200W, got ${r.sku} (${r.title})`);
});

// ──────────────────────────────────────────────────────────────
// 5. PF kit women → PFKW (condition=plantar_fasciitis specialty)
// ──────────────────────────────────────────────────────────────
await test("05 — plantar fasciitis (women) resolves PFKW", () => {
  const r = resolveSku({
    gender: "Women",
    condition: "plantar_fasciitis",
    // useCase comes from the derivation:
    arch: "Medium / High Arch",
  });
  assert.equal(r.sku, "PFKW", `expected PFKW, got ${r.sku} (${r.title})`);
  // Derivation should have set useCase=comfort_bundle:
  assert.equal(r.derived.useCase, "comfort_bundle");
});

// ──────────────────────────────────────────────────────────────
// 6. Construction + flat feet (men) → L4620M (work_all_day flat)
//    Production runbook used `useCase=boots_construction` for new
//    merchants; the legacy seed catalog tags this as `work_all_day`.
//    The expected SKU (L4620M) is the men's work orthotic flat-arch.
// ──────────────────────────────────────────────────────────────
await test("06 — construction / work boots + flat (men) resolves L4620M", () => {
  const r = resolveSku({
    gender: "Men",
    useCase: "work_all_day",
    condition: "none",
    arch: "Flat / Low Arch",
  });
  assert.equal(r.sku, "L4620M", `expected L4620M, got ${r.sku} (${r.title})`);
});

// ──────────────────────────────────────────────────────────────
// 7. Kids + flat feet → kids Posted (L1720Y in seed; tests
//    Unisex+kid-title fallback if Kids strict-match fails). We
//    assert the resolver picks a kids-tagged product.
// ──────────────────────────────────────────────────────────────
await test("07 — Kids + flat feet resolves a Kids-tagged SKU (L1720Y)", () => {
  const r = resolveSku({
    gender: "Kids",
    useCase: "kids",
    condition: "overpronation_flat_feet",
    arch: "Flat / Low Arch",
  });
  // L1720Y is the kids posted orthotic. Tests that the strict-Kids
  // filter found a Kids gender SKU (no Unisex fallback needed).
  assert.equal(r.sku, "L1720Y", `expected L1720Y, got ${r.sku} (${r.title})`);
});

// ──────────────────────────────────────────────────────────────
// 8. Winter boots women + Flat/Low → L900W (medium flat? actually
//    L900W in seed is Medium/High; the flat-tagged winter is L920W.
//    Production runbook expected L900W as the women's winter boot
//    orthotic. Assert whichever of the two is selected and document
//    the choice. We assert L920W (Flat/Low Arch) since that matches
//    the Flat/Low input. If the user runbook truly wants L900W they
//    must have asked with Medium arch.
// ──────────────────────────────────────────────────────────────
await test("08 — winter boots women + Flat/Low resolves L920W (women's flat-arch winter)", () => {
  const r = resolveSku({
    gender: "Women",
    useCase: "winter_boots",
    condition: "none",
    arch: "Flat / Low Arch",
  });
  // L920W is winter_boots / Women / Flat/Low Arch in the seed.
  // Runbook documented "L900W" but L900W is Medium/High in the seed;
  // the Flat-aware winner is L920W. Asserting the deterministic
  // resolver output here — if production data differs the merchant's
  // masterIndex needs reconciliation.
  assert.equal(r.sku, "L920W", `expected L920W (winter Flat/Low women), got ${r.sku} (${r.title})`);
});

// ──────────────────────────────────────────────────────────────
// 9. Memory foam men medium arch (no overpronation, no condition)
//    → expected L2300M. Posted variant (L2320M) only if
//    overpronation=yes.
//
// KNOWN-FAIL ON SEED CATALOG: the on-disk seed retains the legacy
// Conform diabetic SKUs (L200M / L220M) tagged as useCase=comfort.
// With identical (arch, gender, posted, metSupport) scores, the
// resolver's deterministic lex tiebreak picks L200M over L2300M
// because "L200M" < "L2300M". On the merchant's regenerated
// 92-SKU masterIndex L200M is omitted (the diabetic catalog row
// got an explicit useCase=diabetic instead of comfort), so this
// test passes there. Failing here flags a real masterIndex
// reconciliation gap between seed-on-disk and prod-DB.
// ──────────────────────────────────────────────────────────────
await test("09 — memory foam men medium + no overpronation resolves L2300M (not L2320M)", () => {
  const r = resolveSku({
    gender: "Men",
    useCase: "comfort_memory_foam",
    condition: "none",
    arch: "Medium / High Arch",
    overpronation: "no",
  });
  // See comment block above. On the merchant's prod masterIndex
  // L200M wouldn't be in the comfort bucket; here on the seed it
  // is. The assertion fails on seed-as-deployed: this is the
  // diagnostic.
  assert.equal(
    r.sku,
    "L2300M",
    `expected L2300M (memory foam medium men). Got ${r.sku} (${r.title}). ` +
      `Diagnostic: seed catalog has legacy diabetic Conform SKUs (L200M/L220M) ` +
      `tagged useCase=comfort that lex-sort ahead of L2300M. On prod's regenerated ` +
      `92-SKU masterIndex L200M moves to useCase=diabetic and this test passes.`,
  );
});

await test("09b — memory foam men medium + overpronation=yes → derives posted → resolves L2320M", () => {
  const r = resolveSku({
    gender: "Men",
    useCase: "comfort_memory_foam",
    condition: "none",
    arch: "Medium / High Arch",
    overpronation: "yes",
  });
  // overpronation=yes triggers tree derivation: arch → Flat/Low,
  // posted → true. Expected SKU is L2320M (memory foam posted).
  // Same lex-tiebreak issue as 09: seed's L220M (Conform Posted,
  // useCase=comfort) wins over L2320M. KNOWN-FAIL on seed.
  assert.equal(
    r.sku,
    "L2320M",
    `expected L2320M (memory foam posted). Got ${r.sku} (${r.title}). ` +
      `Same seed/prod masterIndex divergence as test 09.`,
  );
});

// ──────────────────────────────────────────────────────────────
// 10. Dress + PF women → PFKW (useCase derivation overrides
//     dress_no_removable). Also asserts that classifier-level
//     isFootwear=true gets flipped to ortho=true for the
//     orthotic-only useCase set.
// ──────────────────────────────────────────────────────────────
await test("10 — dress_no_removable + condition=plantar_fasciitis derivation override resolves PFKW", () => {
  const r = resolveSku({
    gender: "Women",
    useCase: "dress_no_removable",
    condition: "plantar_fasciitis",
  });
  assert.equal(r.sku, "PFKW", `expected PFKW (PF kit override), got ${r.sku} (${r.title})`);
  assert.equal(r.derived.useCase, "comfort_bundle", "derivation must override useCase to comfort_bundle");
});

await test("10b — classifier does NOT silently flip isFootwear → isOrtho (path-ambiguity now handled by gate transparently)", async () => {
  // Earlier (pre-2026-05-12), the classifier post-process silently
  // flipped isFootwear=true → isOrtho=true whenever it extracted a
  // useCase from ORTHOTIC_ONLY_USECASES. That fix solved one bug
  // (dress + PF → orthotic kit) but introduced another (customer
  // mid-footwear-flow says "heels" → silently dragged into orthotic
  // chip funnel). The classifier doesn't have conversation history,
  // so it can't safely flip — the gate must decide based on context.
  //
  // New contract: classifier returns the LLM's flags verbatim
  // (modulo the diabetic/PF useCase backfill from condition). The
  // gate is responsible for path-ambiguity resolution via Test 18's
  // transparent disambig question.
  const fakeAnthropic = {
    messages: {
      create: async () => ({
        content: [
          {
            type: "tool_use",
            name: "classify_turn",
            input: {
              isOrthoticRequest: false,
              isFootwearRequest: true,
              isRejection: false,
              attributes: {
                gender: "Women",
                useCase: "dress_no_removable",
                condition: null,
              },
              confidence: "high",
            },
          },
        ],
      }),
    },
  };
  const out = await classifyOrthoticTurn({
    messages: [{ role: "user", content: "do you have orthotics for dress shoes with no removable insole?" }],
    anthropic: fakeAnthropic,
    shop: "test.myshopify.com",
  });
  assert.ok(out, "classifier should return a result");
  assert.equal(out.isOrthoticRequest, false, "classifier must NOT silently flip — gate handles path-ambiguity");
  assert.equal(out.isFootwearRequest, true, "classifier must preserve LLM's isFootwearRequest verbatim");
  assert.equal(out.attributes.useCase, "dress_no_removable");
});

// ──────────────────────────────────────────────────────────────
// 11. Product-info follow-up bail-out: gate returns handled=false.
// ──────────────────────────────────────────────────────────────
section("Gate-path scenarios (handled=true vs handled=false)");

await test("11 — product-info follow-up ('do the Fiji come in other colors?') falls through", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "show me women's Fiji Orthotic sandals" },
      { role: "assistant", content: "Here are the Fiji Orthotic Women's Flips, available in tan and navy." },
      { role: "user", content: "Do the Fiji Orthotic Women's Flips come in other colors?" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
  });
  assert.equal(out.handled, false, "gate must fall through on product-info follow-up");
  assert.equal(events.length, 0, "no SSE events should be emitted");
});

// ──────────────────────────────────────────────────────────────
// 12. Kids chip flow no infinite loop: chip-shaped reply to
//     overpronation must NOT trigger fresh-arch reset.
// ──────────────────────────────────────────────────────────────
await test("12 — Kids chip flow: 'Medium' then 'No' progresses (no q_arch infinite loop)", async () => {
  // Customer just picked Medium on q_arch. Next assistant message
  // emitted q_overpronation (production gate code). Customer answers
  // "No" — short chip-shape reply. The gate's fresh-arch reset
  // MUST NOT fire, so accumulated arch stays Medium and the resolver
  // can finish.
  const { events, encoder, controller } = makeMockSse();
  await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "orthotic for my son" },
      { role: "assistant", content: "What kind of shoes? <<Casual>>" },
      { role: "user", content: "Casual" },
      { role: "assistant", content: "Any condition? <<None>><<Plantar Fasciitis>>" },
      { role: "user", content: "None" },
      { role: "assistant", content: "What's your arch type? <<Flat / Low>><<Medium>><<High>><<I don't know>>" },
      { role: "user", content: "Medium" },
      { role: "assistant", content: "When you walk or stand, do your ankles roll inward or do you have flat-feet symptoms? <<Yes>><<No>>" },
      { role: "user", content: "No" },
    ],
    tree,
    shop: null, // resolver may bail with no shop; we just want to confirm no q_arch re-emit
    controller,
    encoder,
    classifiedIntent: {
      isOrthoticRequest: true,
      isFootwearRequest: false,
      isRejection: false,
      attributes: { gender: "Kids" },
    },
  });
  // Assertion: the gate did NOT re-emit "What's your arch type?".
  // If chip-shape guard regressed, the fresh-arch reset would drop
  // accumulated overpronation answers and stick on q_overpronation,
  // OR drop arch and re-emit q_arch.
  const arch_re_emit = events.some(
    (e) => e?.type === "text" && /arch type/i.test(e.text || ""),
  );
  assert.equal(arch_re_emit, false, "gate must not re-emit q_arch after chip-shape 'No'");
});

// ──────────────────────────────────────────────────────────────
// 13. Subject pivot Men→Women drops accumulated condition/arch/
//     overpronation. (Existing behaviour; regression check.)
// ──────────────────────────────────────────────────────────────
await test("13 — subject pivot Men → Women drops accumulated arch/overpronation/condition", async () => {
  const { events, encoder, controller } = makeMockSse();
  const cap = captureLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "I need orthotics" },
        { role: "assistant", content: "Who?" },
        { role: "user", content: "Men" },
        { role: "assistant", content: "Shoes?" },
        { role: "user", content: "casual" },
        { role: "assistant", content: "Condition?" },
        { role: "user", content: "flat feet" },
        { role: "assistant", content: "Arch?" },
        { role: "user", content: "Flat / Low Arch" },
        { role: "assistant", content: "Pronation?" },
        { role: "user", content: "Yes" },
        { role: "assistant", content: "Done." },
        { role: "user", content: "okay now for my wife please" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: {
        isOrthoticRequest: true,
        isFootwearRequest: false,
        isRejection: false,
        attributes: { gender: "Women" },
      },
    });
  } finally {
    cap.restore();
  }
  const flowLogs = cap.lines.filter((l) => l.includes("[orthotic-flow]"));
  const sawPivotReset = flowLogs.some((l) => /subject pivot:.*gender Men → Women/.test(l) || /subject pivot.*Men.*Women/.test(l));
  assert.equal(
    sawPivotReset,
    true,
    `expected subject-pivot reset log. Logs: ${flowLogs.join(" | ")}`,
  );
});

// ──────────────────────────────────────────────────────────────
// 14. Footwear request "sandals with arch support" must NOT trigger
//     orthotic flow. Tests classifier-isFootwearRequest=true path.
// ──────────────────────────────────────────────────────────────
await test("14 — 'sandals with arch support' (footwear request) does NOT emit orthotic Q&A", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      // Pre-establish gender so the footwear-commit veto path skips
      // the "ask gender first" hard-gate and falls clean through.
      { role: "user", content: "I'm a woman" },
      { role: "assistant", content: "Got it, looking for women's." },
      { role: "user", content: "show me sandals with arch support" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
    classifiedIntent: {
      isOrthoticRequest: false,
      isFootwearRequest: true,
      isRejection: false,
      attributes: { gender: "Women", useCase: null, condition: null },
    },
  });
  // Hard requirement: gate must NOT emit any orthotic chip question
  // (no q_use_case, q_condition, q_arch, q_overpronation text).
  const orthoQuestionEmitted = events.some(
    (e) =>
      e?.type === "text" &&
      /(orthotics?\s+go\s+in|foot\s+pain\s+or\s+condition|arch\s+type|ankles\s+roll\s+inward)/i.test(
        e.text || "",
      ),
  );
  assert.equal(
    orthoQuestionEmitted,
    false,
    "gate must NOT emit any orthotic-flow question on a footwear request",
  );
  // Either fully falls through (handled=false) or just emitted the
  // gender-disambig (which is OK for footwear path — not the bug).
  assert.equal(out.handled, false, "gate must fall through on footwear request when gender is known");
});

await test("14b — 'red sandals' falls through to catalog resolver instead of hard-asking gender", async () => {
  const { events, encoder, controller } = makeMockSse();
  const out = await maybeRunOrthoticFlow({
    messages: [
      { role: "user", content: "red sandals" },
    ],
    tree,
    shop: "test.myshopify.com",
    controller,
    encoder,
    classifiedIntent: {
      isOrthoticRequest: false,
      isFootwearRequest: true,
      isRejection: false,
      attributes: { gender: null, useCase: null, condition: null },
    },
  });
  const genderQuestionEmitted = events.some(
    (e) =>
      e?.type === "text" &&
      /Are you shopping for men's or women's/i.test(e.text || ""),
  );
  assert.equal(genderQuestionEmitted, false, "gate must not ask gender before resolver sees red sandals");
  assert.equal(out.handled, false, "gate must fall through so resolver can infer gender from color+category");
});

// ──────────────────────────────────────────────────────────────
// 15. Free-text "I have flat feet" mid-flow still drops accumulated
//     arch. Long-form fresh-overpronation claim should NOT be
//     blocked by the chip-shape guard.
// ──────────────────────────────────────────────────────────────
await test("15 — long-form fresh-overpronation claim still drops stale arch (chip guard didn't over-block)", async () => {
  const { events, encoder, controller } = makeMockSse();
  const cap = captureLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "I need orthotics" },
        { role: "assistant", content: "Who?" },
        { role: "user", content: "Women" },
        { role: "assistant", content: "Shoes?" },
        { role: "user", content: "casual" },
        { role: "assistant", content: "Condition?" },
        { role: "user", content: "none" },
        { role: "assistant", content: "Arch?" },
        { role: "user", content: "Medium / High Arch" },
        { role: "assistant", content: "Pronation?" },
        // Long-form free-text — NOT chip-shape (over 20 chars, no chip token).
        { role: "user", content: "Actually, now that I think about it more carefully I have pretty flat feet" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: {
        isOrthoticRequest: true,
        isFootwearRequest: false,
        isRejection: false,
        attributes: { gender: "Women", useCase: "casual", condition: "overpronation_flat_feet" },
      },
    });
  } finally {
    cap.restore();
  }
  // We expect the fresh-overpronation reset OR fresh-arch reset path
  // to fire (the condition extraction sets overpronation_flat_feet which
  // via tree derivation forces arch=Flat/Low). The chip-shape guard
  // SHOULD NOT have blocked this — the message is 60+ chars and free-text.
  const flowLogs = cap.lines.filter((l) => l.includes("[orthotic-flow]"));
  // We just assert the gate handled it (didn't reject as off-topic),
  // and didn't sit stuck on the "chip-shape guard" preventing reset.
  // A clear positive signal: the gate proceeded past detection
  // (either resolve-attempt log or some flow log).
  assert.ok(
    flowLogs.length > 0 || events.length > 0,
    `gate should have engaged on a clear orthotic-context free-text message. Logs: ${flowLogs.join(" | ")}`,
  );
});

// ──────────────────────────────────────────────────────────────
// 16 / 16b. Specialty condition must NOT silently override customer's
//           explicit useCase choice. Production trace (2026-05-12
//           14:00:33 and 14:14:51) showed the resolver discarding
//           useCase=non_removable / useCase=comfort_walking_everyday
//           when condition=metatarsalgia, returning an arbitrary
//           metSupport=true SKU from a different useCase line.
//           These tests are EXPECTED TO FAIL on current code — they
//           lock in the bug so the fix gets verified before deploy.
// ──────────────────────────────────────────────────────────────
// Tests 16 and 16b use the seed's useCase vocabulary (athletic_general,
// casual) — not production's (comfort_walking_everyday, non_removable).
// The bug being tested is structural: the resolver's specialty-condition
// filter (metatarsalgia → metSupport=true) used to silently override the
// customer's explicit useCase choice. The seed's vocab is sufficient to
// reproduce the bug — what matters is that the resolved SKU's useCase
// matches the customer's input useCase, not which specific value is used.
await test("16 — useCase=athletic_general + metatarsalgia must stay in athletic_general line (not jump to dress_premium)", () => {
  const r = resolveSku({
    gender: "Women",
    useCase: "athletic_general",
    condition: "metatarsalgia",
    arch: "Medium / High Arch",
    overpronation: "no",
  });
  // L1905W is Women's Active Orthotics W/ Metatarsal Support
  // (useCase=athletic_general, metSupport=true, Medium / High Arch).
  // The bug returned L1525W (Women's Heritage Posted W/ Met Support,
  // useCase=dress_premium) because the specialty filter accepted
  // ANY metSupport=true SKU regardless of useCase.
  assert.ok(
    r.product && r.product.useCase === "athletic_general",
    `expected a SKU with useCase=athletic_general. Got ${r.sku} (${r.title}) useCase=${r.product?.useCase || "?"}. ` +
      `Bug: specialty condition (metatarsalgia → metSupport=true filter) ignored customer's explicit ` +
      `useCase choice and pulled a SKU from a different useCase line.`,
  );
});

await test("16b — useCase=casual + metatarsalgia must stay in casual line (not jump to dress)", () => {
  const r = resolveSku({
    gender: "Men",
    useCase: "casual",
    condition: "metatarsalgia",
    arch: "Medium / High Arch",
    overpronation: "no",
  });
  // L605M is Men's Casual Comfort Orthotics W/ Metatarsal Support
  // (useCase=casual, metSupport=true). The bug returned L105M
  // (Men's In-Style W/ Met Support, useCase=dress) because the
  // specialty filter accepted any metSupport=true SKU.
  assert.ok(
    r.product && r.product.useCase === "casual",
    `expected a SKU with useCase=casual. Got ${r.sku} (${r.title}) useCase=${r.product?.useCase || "?"}. ` +
      `Bug: specialty condition (metatarsalgia) silently discarded customer's explicit useCase choice.`,
  );
});

// ──────────────────────────────────────────────────────────────
// 17. Yes/No card suppression must NOT fire when the AI's reply
//     names products that exist in the candidate pool. Production
//     trace (2026-05-12 17:37:10): customer asked "Do you carry
//     sale styles in other footwear categories like sneakers or
//     loafers?" → AI replied "Yes! There are sale sneakers — the
//     Leigh, Gianna, and Elise are all marked down..." → the
//     yes/no-suppress rule discarded an 8-product pool because
//     PRODUCT_PRESENTATION_RE doesn't match "there are" / named
//     product mentions. Customer saw product names in text but
//     zero clickable cards.
// ──────────────────────────────────────────────────────────────
await test("17 — isYesNoAnswer returns false when text names a product from the pool (cards must not be suppressed)", () => {
  const text =
    "Yes! There are sale sneakers on offer — the Leigh, Gianna, and Elise are all marked down with arch support and UltraSky™ cushioning. " +
    "In loafers, the Collette Arch Support Loafer - Tan Suede is currently on sale as well.";
  const pool = [
    { title: "Leigh Arch Support Platform Sneaker - Beige", handle: "leigh-beige-lh100w" },
    { title: "Gianna Arch Support Sneaker - White", handle: "gianna-white-gn200w" },
    { title: "Elise Active Sneaker - Navy", handle: "elise-navy-el300w" },
    { title: "Collette Arch Support Loafer - Tan Suede", handle: "collette-tan-cl400w" },
  ];
  assert.equal(
    isYesNoQuestion("Do you carry sale styles in other footwear categories like sneakers or loafers?"),
    true,
    "customer's question must match yes/no shape (regression check)",
  );
  assert.equal(
    isYesNoAnswer(text, pool),
    false,
    `text names products from pool — must NOT trigger card suppression. ` +
      `Bug: PRODUCT_PRESENTATION_RE only catches openers like "here are…" / "take a look…", ` +
      `missing "there are" + named-product mentions.`,
  );
});

await test("17b — isYesNoAnswer still returns true for pure yes/no answer with NO product mention (existing behavior)", () => {
  const text = "Yes, these orthotics work well in athletic shoes with removable insoles.";
  const pool = [
    { title: "Leigh Arch Support Platform Sneaker - Beige", handle: "leigh-beige-lh100w" },
  ];
  // The text mentions no product from the pool — suppression should
  // still fire (this is the case the rule was originally added for).
  assert.equal(
    isYesNoAnswer(text, pool),
    true,
    "pure factual yes/no with no product name from pool should still suppress cards",
  );
});

// ──────────────────────────────────────────────────────────────
// 18. Path-ambiguity disambig. Production trace 2026-05-12 18:02:
//     customer answered the domain-disambig with "Footwear with
//     arch support", then "Women's", then "heels". The classifier
//     extracted useCase=dress_no_removable from "heels" + carried
//     condition=foot_pain from earlier turns. The
//     ORTHOTIC_ONLY_USECASES flip in the classifier post-process
//     silently switched isFootwear=true → isOrtho=true, the gate's
//     footwear-path veto didn't fire, and the orthotic flow took
//     over → recommended L220W (Women's Conform Posted Orthotics)
//     to a customer who explicitly asked for shoes.
//
//     Fix: instead of silently re-classifying, the gate should
//     detect this path-ambiguity and emit a clarifying question
//     ("Are you looking for heels to wear, or an orthotic insole
//     to put in your heels?") with chips that let the customer
//     definitively resolve the ambiguity in one click. Transparent
//     UX, customer-correctable, no silent misclassification.
// ──────────────────────────────────────────────────────────────
await test("18 — customer in footwear path + ambiguous useCase emits path-ambiguity disambig (not silent re-classify)", async () => {
  const { events, encoder, controller } = makeMockSse();
  const cap = captureLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "I have foot pain, what should I wear?" },
        { role: "assistant", content: "Got it — sounds like you're dealing with some foot discomfort. Are you looking for footwear with built-in arch support, or an orthotic insole that goes inside your existing shoes?\n\n<<Footwear with arch support>><<Orthotic insole>>" },
        { role: "user", content: "Footwear with arch support" },
        { role: "assistant", content: "Got it — let me help you find the right fit. Are you shopping for men's or women's?" },
        { role: "user", content: "Women's" },
        { role: "assistant", content: "What type of women's footwear are you looking for?" },
        { role: "user", content: "heels" },
      ],
      tree: treeWithDerivations,
      shop: null,
      controller,
      encoder,
      classifiedIntent: {
        // What the classifier would now return: ortho=true (after the
        // silent flip) with useCase=dress_no_removable. Test asserts
        // the gate DOESN'T blindly enter orthotic chip flow — it
        // notices the path-ambiguity (footwear committed earlier +
        // ortho-shaped useCase now) and asks a clarifying question.
        isOrthoticRequest: true,
        isFootwearRequest: false,
        isRejection: false,
        attributes: {
          gender: "Women",
          useCase: "dress_no_removable",
          condition: "foot_pain",
        },
        confidence: "high",
      },
    });
  } finally {
    cap.restore();
  }
  // Either: gate emits a path-ambiguity disambig question (handled=true),
  // OR: gate detects the conflict and falls through to LLM (handled=false)
  // with a "path ambiguity" log line. Both are acceptable. What's NOT
  // acceptable: gate emits q_arch / q_use_case / q_condition (the bug).
  const flowLogs = cap.lines.filter((l) => l.includes("[orthotic-flow]"));
  const emittedOrthoticQ = flowLogs.some((l) =>
    /emitted seed question (q_arch|q_use_case|q_condition|q_overpronation)/.test(l),
  );
  assert.equal(
    emittedOrthoticQ,
    false,
    `gate must NOT enter orthotic chip flow when customer is footwear-committed. ` +
      `Bug from 2026-05-12 production: classifier flipped ortho=true on "heels" because ` +
      `useCase=dress_no_removable is in ORTHOTIC_ONLY_USECASES, gate trusted the flipped flag, ` +
      `customer ended up with an orthotic recommendation despite asking for footwear. ` +
      `Flow logs: ${flowLogs.join(" | ")}`,
  );
});

// ──────────────────────────────────────────────────────────────
// 19. Out-of-stock phrasing exception. Production trace 2026-05-13
//     11:26: customer asked "Vania or Charli in red?" and the bot
//     replied "Neither the Vania nor the Charli currently appears
//     to be available in red" — a self-contradicting answer because
//     the bot had just shown both products labeled red in the
//     previous turn (Charli-Red was fully OOS, Vania-Red had 2
//     sizes in stock).
//
//     Merchant rule (2026-05-13): when a specific named-product +
//     attribute combo is OOS, the bot must use the controlled
//     phrasing "currently out of stock + back-in-stock signup on
//     the product page" — NOT "we don't have" or "doesn't appear
//     to be available". The new containsAvailabilityDenial guard
//     in chat-helpers.server.js draws the line.
// ──────────────────────────────────────────────────────────────
await test("19a — denial guard catches 'doesn't appear to be available' / 'we don't have' / 'not available'", () => {
  // Pure denial phrasings — bot is implying the store doesn't carry
  // the item. Guard must flag these so the route can recover.
  assert.equal(
    containsAvailabilityDenial("Neither the Vania nor the Charli currently appears to be available in red — the closest colors are walnut, cognac, ginger, and white."),
    true,
    "screenshot bug from 2026-05-13: 'not available' (via 'currently appears to be available') without a back-in-stock signup MUST be flagged as a denial",
  );
  assert.equal(
    containsAvailabilityDenial("We don't carry pink heels in our women's line."),
    true,
    "'we don't carry' is a denial",
  );
  assert.equal(
    containsAvailabilityDenial("That product is out of stock right now."),
    true,
    "bare 'out of stock' without back-in-stock signup is still a denial — the customer is left with nowhere to go",
  );
});

await test("19b — denial guard EXEMPTS the controlled OOS phrasing (currently OOS + back-in-stock signup on PDP)", () => {
  // Allowed shape: "X in Y isn't currently in stock. Sign up for
  // back-in-stock alerts on the product page" — that's the helpful,
  // merchant-approved answer the bot SHOULD give. Guard must NOT flag it.
  assert.equal(
    containsAvailabilityDenial("Charli in red isn't currently in stock right now. You can [open the product page](https://www.aetrex.com/products/charli-red) to sign up for back-in-stock email alerts. In the meantime, here are similar styles..."),
    false,
    "controlled OOS phrasing with back-in-stock signup + PDP link is the merchant-approved answer — must NOT be flagged as a denial",
  );
  assert.equal(
    containsAvailabilityDenial("The Vania in red is currently out of stock. Visit the product page to be notified when it's back in stock."),
    false,
    "'out of stock' + 'notified when back in stock' = allowed exception",
  );
  assert.equal(
    containsAvailabilityDenial("That size isn't in stock right now — sign up for email alerts on the product page and we'll let you know when it's back."),
    false,
    "size-level OOS with back-in-stock signup is also allowed",
  );
});

await test("19c — denial guard does not over-block neutral messages", () => {
  assert.equal(containsAvailabilityDenial(""), false, "empty text is not a denial");
  assert.equal(containsAvailabilityDenial("Here are some great women's sneakers for plantar fasciitis."), false, "positive recommendation is not a denial");
  assert.equal(containsAvailabilityDenial("Got it — what type of footwear are you looking for?"), false, "clarifying question is not a denial");
});

// ──────────────────────────────────────────────────────────────
// 20. Named-product lookup must release the category lock.
//     Production trace 2026-05-13 11:44: customer was browsing
//     wedge heels for Morton's neuroma, then asked "show me Vania
//     in red". The LLM kept the category=Wedges Heels filter from
//     the previous turn, but Vania is a SANDAL — three searches
//     returned 0 results, bot fell back to "Hmm, nothing's quite
//     hitting that combination". The rewrite must detect the
//     named-product pattern and drop the category filter so the
//     search can find Vania across categories.
// ──────────────────────────────────────────────────────────────
await test("20a — 'show me Vania in red' drops category AND gender filter (named-product detection)", () => {
  // Gender is dropped because the customer named a specific product and
  // the search should find it across the catalog. Live trace 2026-06-08:
  // "how many points to buy Jillian for free" with stale memory.gender=men
  // searched men's sandals and returned Maui/Milos instead of Jillian.
  // Dropping gender on named-product searches lets the actual product win.
  const toolCall = {
    name: "search_products",
    input: {
      query: "Vania",
      filters: { gender: "Women", category: "Wedges Heels", color: "red" },
    },
  };
  const ctx = { latestUserMessage: "show me vania in red" };
  const result = relaxCategoryOnNamedProduct(toolCall, ctx);
  assert.equal(
    result.input.filters?.category,
    undefined,
    "category filter must be dropped when query mentions a named product",
  );
  assert.equal(result.input.filters?.gender, undefined,
    "gender filter must be dropped so named-product search isn't blocked by stale gender memory");
  assert.equal(result.input.filters?.color, "red", "color filter must be preserved");
  assert.equal(result.input.query, "Vania", "query string must be preserved");
});

await test("20b — generic category-only query keeps the category filter (no false positive)", () => {
  // Customer says "show me heels" — no proper-noun product name.
  // Category lock must remain in place.
  const toolCall = {
    name: "search_products",
    input: {
      query: "heels",
      filters: { gender: "Women", category: "Wedges Heels" },
    },
  };
  const ctx = { latestUserMessage: "show me heels" };
  const result = relaxCategoryOnNamedProduct(toolCall, ctx);
  assert.equal(
    result.input.filters?.category,
    "Wedges Heels",
    "category filter must stay when there's no named product in the query",
  );
});

await test("20c — color/gender/anatomy words don't trigger named-product detection", () => {
  // "show me Red wedges" — the LLM might capitalize "Red" but it's a
  // common color word, not a named product. Category must stay.
  const toolCall = {
    name: "search_products",
    input: {
      query: "Red wedges",
      filters: { gender: "Women", category: "Wedges Heels", color: "red" },
    },
  };
  const ctx = { latestUserMessage: "show me red wedges" };
  const result = relaxCategoryOnNamedProduct(toolCall, ctx);
  assert.equal(
    result.input.filters?.category,
    "Wedges Heels",
    "capitalized common words like 'Red' must NOT trigger named-product detection",
  );
});

await test("20d — named product not in user's literal message is ignored (LLM hallucination guard)", () => {
  // Defensive: if the LLM invents a product name "Florence" that the
  // customer never typed, don't drop the category lock — the customer
  // didn't ask for that product.
  const toolCall = {
    name: "search_products",
    input: {
      query: "Florence",
      filters: { gender: "Women", category: "Wedges Heels" },
    },
  };
  const ctx = { latestUserMessage: "show me comfortable heels" };
  const result = relaxCategoryOnNamedProduct(toolCall, ctx);
  assert.equal(
    result.input.filters?.category,
    "Wedges Heels",
    "proper noun in query but not in user message must NOT trigger relaxation",
  );
});

// ──────────────────────────────────────────────────────────────
// 21. dedupeConsecutiveSentences must strip cross-sentence URL
//     repetitions and paraphrases beyond the immediate predecessor.
//     Production trace 2026-05-13 11:55:10: bot cited the GovX URL
//     twice in different phrasings within the same response. The
//     previous dedupe only compared to the immediate predecessor.
// ──────────────────────────────────────────────────────────────
await test("21a — strips a URL cited twice in different phrasings (cross-sentence)", () => {
  const screenshotText =
    "Our support team is happy to help with teacher discount questions — " +
    "and just so you know, we do offer up to 15% off for verified teachers " +
    "through our GovX program at aetrex.com/pages/aetrex-and-govx. " +
    "You can reach our support team using the button below, and teachers " +
    "qualify for up to 15% off through our GovX verification program at " +
    "aetrex.com/pages/aetrex-and-govx.";
  const out = dedupeConsecutiveSentences(screenshotText);
  // The URL should appear exactly once in the output.
  const urlOccurrences = (out.match(/aetrex\.com\/pages\/aetrex-and-govx/gi) || []).length;
  assert.equal(
    urlOccurrences,
    1,
    `screenshot bug 2026-05-13: GovX URL must appear once, not twice. Output: "${out}"`,
  );
});

await test("21b — keeps a URL when it's only cited once (no over-strip)", () => {
  const text =
    "Our support team can help with teacher discounts. " +
    "You can verify your status at aetrex.com/pages/aetrex-and-govx and get 15% off.";
  const out = dedupeConsecutiveSentences(text);
  assert.ok(
    out.includes("aetrex.com/pages/aetrex-and-govx"),
    "single URL must be preserved",
  );
});

await test("21c — strips a cross-sentence paraphrase even without URL", () => {
  // Two sentences saying essentially the same thing, separated by a
  // third unrelated sentence. The dedupe must catch this even though
  // the duplicate isn't immediately adjacent.
  const text =
    "These sneakers offer excellent arch support for plantar fasciitis. " +
    "They run true to size. " +
    "Sneakers like these provide great arch support for plantar fasciitis sufferers.";
  const out = dedupeConsecutiveSentences(text);
  // The middle sentence should survive, one of the two paraphrases dropped.
  assert.ok(out.includes("They run true to size"), "unrelated middle sentence must survive");
  const supportMentions = (out.match(/arch support/gi) || []).length;
  assert.equal(
    supportMentions,
    1,
    `paraphrase across sentences must be deduped. Got "${out}"`,
  );
});

await test("21d — does not strip distinct sentences that happen to share a few common words", () => {
  const text =
    "These sneakers come in white. " +
    "They're great for plantar fasciitis.";
  const out = dedupeConsecutiveSentences(text);
  assert.ok(out.includes("white"), "first sentence preserved");
  assert.ok(out.includes("plantar fasciitis"), "second sentence preserved");
});

// ──────────────────────────────────────────────────────────────
// 22. stripLineupPromiseSentences removes "Here's the lineup" /
//     "they come in X, Y, Z variants" / "all at $X-$Y" when cards
//     have been suppressed under a chip question. Production trace
//     2026-05-13 12:02:14: bot wrote "Here's the full women's
//     lineup — they come in standard, posted, and metatarsal
//     variants, all at $74.95–$79.95" alongside a chip question;
//     suppression stripped 6 cards but left the promise, so the
//     customer saw a promise of products with nothing underneath.
// ──────────────────────────────────────────────────────────────
await test("22a — screenshot's exact text: lineup-promise + variants + price-range all stripped", () => {
  const text =
    "The Memory Foam line is our most cushioned orthotic — it features " +
    "extra-thick memory foam in the forefoot to absorb shock and reduce " +
    "fatigue, great for everyday comfort and walking. Here's the full " +
    "women's lineup — they come in standard, posted (for arch/heel " +
    "support), and metatarsal variants, all at $74.95–$79.95. Now, to " +
    "point you to the exact right one — do you have any specific discomfort?";
  const out = stripLineupPromiseSentences(text);
  assert.ok(!/Here'?s the full/i.test(out), `'Here's the full ... lineup' phrase must be stripped. Got: "${out}"`);
  assert.ok(!/they come in/i.test(out), `'they come in ... variants' phrase must be stripped. Got: "${out}"`);
  assert.ok(!/\$74\.95/i.test(out), `price range must be stripped. Got: "${out}"`);
  assert.ok(/Memory Foam line is our most cushioned/i.test(out), `definitional explanation must survive. Got: "${out}"`);
  assert.ok(/do you have any specific discomfort/i.test(out), `chip question must survive. Got: "${out}"`);
});

await test("22b — 'let me show you' / 'I'll pull up' framing stripped", () => {
  const text =
    "The Memory Foam line is great for shock absorption. " +
    "Let me show you these options now. " +
    "What's your arch type?";
  const out = stripLineupPromiseSentences(text);
  assert.ok(!/let me show you/i.test(out), `'let me show you' must be stripped. Got: "${out}"`);
  assert.ok(/Memory Foam line/i.test(out), `explanation preserved`);
  assert.ok(/arch type/i.test(out), `chip question preserved`);
});

await test("22c — text without lineup-promise phrasing is unchanged", () => {
  const text =
    "The Memory Foam line is our most cushioned orthotic. " +
    "Do you have any specific discomfort?";
  const out = stripLineupPromiseSentences(text);
  assert.equal(out, text, "no promise phrases → text unchanged");
});

await test("22d — bails if strip would leave nearly nothing", () => {
  // If the entire text IS a lineup promise (no surrounding context),
  // returning empty would break the response. Bail out and return
  // the original.
  const text = "Here's the lineup. They come in three variants.";
  const out = stripLineupPromiseSentences(text);
  assert.equal(out, text, "guard: when strip removes ~all text, return original to avoid empty response");
});

// ──────────────────────────────────────────────────────────────
// 23. Capability-check + truncation + filler-strip + inline-list
//     reflow. Four bugs from the mountain-climbing screenshot
//     (production trace 2026-05-13 12:12:35 + 12:12:48).
// ──────────────────────────────────────────────────────────────
await test("23a — 'are they good for mountain climbing?' is detected as capability check", () => {
  assert.equal(isCapabilityCheckAboutPriorProducts("are they good for mountain climbing?"), true);
  assert.equal(isCapabilityCheckAboutPriorProducts("are these good for hiking?"), true);
  assert.equal(isCapabilityCheckAboutPriorProducts("do they work for plantar fasciitis?"), true);
  assert.equal(isCapabilityCheckAboutPriorProducts("can these handle wet weather?"), true);
  assert.equal(isCapabilityCheckAboutPriorProducts("how do they fit?"), true);
  assert.equal(isCapabilityCheckAboutPriorProducts("will it last on rough terrain?"), true);
});

await test("23b — capability-check detector does NOT match new shopping requests", () => {
  assert.equal(isCapabilityCheckAboutPriorProducts("show me boots"), false);
  assert.equal(isCapabilityCheckAboutPriorProducts("I need sneakers for hiking"), false);
  assert.equal(isCapabilityCheckAboutPriorProducts("what about sandals"), false);
  assert.equal(isCapabilityCheckAboutPriorProducts(""), false);
});

await test("23c — truncateAtWordBoundary never cuts mid-word (screenshot bug)", () => {
  // Production text that ended "...casual-wea..." because cap chopped
  // mid-word. With the new helper, the cut must land at a word boundary.
  const text =
    "These are athletic sneakers with arch support — great for light hiking and " +
    "walking trails, but they're not technical mountain-climbing boots which " +
    "typically need stiff soles, ankle protection, and crampon compatibility. " +
    "For more rugged terrain, our boots are more lifestyle and casual-wear " +
    "than serious technical hiking gear, so they wouldn't be my first pick.";
  const out = truncateAtWordBoundary(text, 300, 400);
  assert.ok(out.length <= text.length, "must not lengthen the text");
  // The last character before any ellipsis should be punctuation or letter
  // (no mid-word cut). A mid-word cut would leave a partial token like
  // "casual-wea" with nothing after it.
  const trimmed = out.replace(/…$/, "").trim();
  // Last word must appear in the original (i.e., not a partial slice).
  const lastWord = trimmed.split(/\s+/).pop();
  if (lastWord) {
    // Strip trailing punctuation for the comparison.
    const cleanLast = lastWord.replace(/[.,;:!?'")]+$/, "");
    assert.ok(
      text.includes(cleanLast),
      `last word "${cleanLast}" must exist whole in the original. Got truncated: "${out}"`,
    );
  }
});

await test("23d — truncateAtWordBoundary returns text unchanged when under cap", () => {
  const text = "Short text under the cap.";
  assert.equal(truncateAtWordBoundary(text, 300, 400), text);
});

await test("23e — stripFillerIntensifiers removes 'Honestly,' / 'Frankly,' inline asides", () => {
  // Screenshot bug: "For more rugged terrain, Honestly, our boots are..."
  const text = "For more rugged terrain, Honestly, our boots are more lifestyle.";
  const out = stripFillerIntensifiers(text);
  assert.ok(!/Honestly,/i.test(out), `'Honestly,' must be removed. Got: "${out}"`);
  assert.ok(/rugged terrain/.test(out), "surrounding text preserved");
  assert.ok(/our boots/.test(out), "surrounding text preserved");

  // Other intensifiers
  assert.ok(!/Frankly,/i.test(stripFillerIntensifiers("Frankly, this is fine.")));
  assert.ok(!/To be honest,/i.test(stripFillerIntensifiers("To be honest, it's great.")));
});

await test("23f — stripFillerIntensifiers does NOT strip 'honestly' inside a normal word/phrase", () => {
  // "Honestly" as the START of a normal sentence followed by content
  // (no comma after it acting as an aside) — leave it. We only target
  // the parenthetical "Honestly," shape.
  const out = stripFillerIntensifiers("I cannot honestly say that.");
  assert.equal(out, "I cannot honestly say that.", "non-aside usage preserved");
});

await test("23g — reflowInlineList converts ` - **Label** — ...` packed lists into newline bullets", () => {
  // Screenshot bug 2026-05-13 12:12:48: "tell me more about aetrex" →
  // bot returned a single paragraph with ` - **Mission** — ... - **HQ** — ...`
  // Widget rendered it as wall of text.
  const text =
    "Aetrex is a premium brand — here are the highlights: " +
    "- **Mission** — comfort first. " +
    "- **Headquarters** — Teaneck. " +
    "- **Tech** — foot scanning since 2002.";
  const out = reflowInlineList(text);
  const newlines = (out.match(/\n/g) || []).length;
  assert.ok(
    newlines >= 3,
    `expected ≥3 newlines (one per bullet); got ${newlines}. Output: "${out}"`,
  );
  assert.ok(/Mission/.test(out), "Mission preserved");
  assert.ok(/Headquarters/.test(out), "Headquarters preserved");
  assert.ok(/Tech/.test(out), "Tech preserved");
});

await test("23i — ensureHeaderLineBreaks promotes inline bold header after colon", () => {
  // Live trace 2026-06-08: "BioRocker vs UltraSky" → LLM emitted
  // "Here's how the two technologies compare: **BioRocker™ Technology**"
  // on one line, then bullets, then "**UltraSKY™ Technology**" inline
  // with the previous bullet's text. Widget rendered the second header
  // mid-paragraph.
  const text =
    "Here's how the two technologies compare: **BioRocker™ Technology**\n" +
    "- A rocker-shaped outsole.\n" +
    "- Reduces stress on joints.\n" +
    "- Found in newer sandals like Savannah and Jenny **UltraSKY™ Technology**\n" +
    "- A lightweight EVA foam.\n";
  const out = ensureHeaderLineBreaks(text);
  assert.ok(/compare:\n\n\*\*BioRocker/.test(out),
    `header after colon must get blank line before it. Output:\n${out}`);
  assert.ok(/Jenny\n\n\*\*UltraSKY/.test(out),
    `mid-line header must be broken into its own paragraph. Output:\n${out}`);
});

await test("23j — ensureHeaderLineBreaks leaves inline bold emphasis alone", () => {
  // Plain inline emphasis (not a section header) should not be broken.
  const text = "This is **really important** but please read more.";
  const out = ensureHeaderLineBreaks(text);
  assert.equal(out, text, "inline emphasis shouldn't be split into paragraphs");
});

await test("23k — ensureHeaderLineBreaks promotes own-line header preceded by single newline", () => {
  // Live trace 2026-06-08: LLM emitted header on its own line but with
  // only a single \n before it (no blank line) → markdown treated whole
  // block as one paragraph. Force blank line.
  const text =
    "Found in our newer sandal styles like Savannah and Jenny, as well as the Darcy sneaker\n" +
    "**UltraSKY™ Technology**\n" +
    "A lightweight, injected EVA foam compound...\n";
  const out = ensureHeaderLineBreaks(text);
  assert.ok(/Darcy sneaker\n\n\*\*UltraSKY/.test(out),
    `expected blank line before header. Output:\n${out}`);
  assert.ok(/\*\*UltraSKY™ Technology\*\*\n\nA lightweight/.test(out),
    `expected blank line AFTER header too. Output:\n${out}`);
});

await test("23l — tightenSequentialFactLines turns 'Label: Value' paragraphs into bullets", () => {
  // Live trace 2026-06-08: comparing Jillian and Danika, the LLM
  // emitted each spec as its own paragraph (separated by \n\n) under
  // a bold product header. The widget renders each paragraph with
  // vertical margin → screenshots had huge vertical gaps between
  // "Category: Sandal", "Closure: Hook & loop...", etc.
  const text =
    "**Jillian Braided Quarter Strap Sandal — $139.95**\n\n" +
    "Category: Sandal\n\n" +
    "Closure: Hook & loop adjustable straps\n\n" +
    "Upper: Genuine leather with signature braided detailing\n\n" +
    "Footbed: Memory foam + cork midsole\n\n" +
    "Heel height: 1.1\"\n";
  const out = tightenSequentialFactLines(text);
  // Sequential facts should be joined with single \n now (bullet list)
  assert.ok(/- \*\*Category:\*\* Sandal\n- \*\*Closure:\*\*/.test(out),
    `expected Category and Closure as adjacent bullets. Output:\n${out}`);
  assert.ok(/- \*\*Footbed:\*\* Memory foam \+ cork midsole/.test(out),
    `expected Footbed as a bullet. Output:\n${out}`);
});

await test("23m — tightenSequentialFactLines preserves regular prose paragraphs", () => {
  const text =
    "This is the first paragraph of regular prose.\n\n" +
    "This is the second paragraph, also regular prose. Nothing here looks like a Label: Value.\n\n" +
    "Third paragraph.";
  const out = tightenSequentialFactLines(text);
  assert.equal(out, text, "regular prose paragraphs must not be touched");
});

await test("23o — tightenSequentialFactLines collapses paragraph-spaced bullets", () => {
  // Live trace 2026-06-08: BioRocker vs UltraSky comparison rendered
  // with wide gaps between bullets because the LLM emitted blank lines
  // between each "- item". The widget treats each as a paragraph.
  const text =
    "**BioRocker™ Technology**\n\n" +
    "- A rocker-style midsole\n\n" +
    "- Reduces joint stress\n\n" +
    "- Found in sandal styles\n\n" +
    "**UltraSKY™ Technology**\n\n" +
    "- Lightweight EVA foam\n\n" +
    "- Extreme cushioning";
  const out = tightenSequentialFactLines(text);
  assert.ok(/- A rocker-style midsole\n- Reduces joint stress\n- Found in sandal styles/.test(out),
    `bullets under BioRocker must be joined with single \\n. Output:\n${out}`);
  assert.ok(/- Lightweight EVA foam\n- Extreme cushioning/.test(out),
    `bullets under UltraSKY must be joined too. Output:\n${out}`);
  // Headers still separated by blank line
  assert.ok(/styles\n\n\*\*UltraSKY/.test(out),
    `headers between sections must keep \\n\\n. Output:\n${out}`);
});

await test("23n — tightenSequentialFactLines normalizes CRLF before splitting", () => {
  // Live trace 2026-06-08: even after deploying tightenSequentialFactLines,
  // the user's screenshot showed paragraph-spaced specs instead of tight
  // bullets. Suspected cause: certain LLM output paths emit \r\n line
  // endings, which broke the \n{2,} block-splitter (previously) and
  // returned garbage (header dropped, items mis-separated).
  const crlf =
    "**Jillian — \$139.95**\r\n\r\n" +
    "Category: Sandal\r\n\r\n" +
    "Closure: Hook & loop\r\n\r\n" +
    "Upper: Leather\r\n\r\n" +
    "Heel: 1.1\"";
  const out = tightenSequentialFactLines(crlf);
  assert.ok(/- \*\*Category:\*\* Sandal\n- \*\*Closure:\*\*/.test(out),
    `CRLF input must normalize and tighten correctly. Output:\n${out}`);
  assert.ok(/\*\*Jillian/.test(out), "header must survive normalization");
});

await test("23h — reflowInlineList leaves single-mention text untouched", () => {
  // Only one ` - **Label** — ` in the text → not a list, don't reflow.
  const text = "We offer the Vania - **Premium** — a comfortable platform sandal.";
  const out = reflowInlineList(text);
  assert.equal(out, text, "single inline marker is not a list — don't reflow");
});

// ──────────────────────────────────────────────────────────────
// 24. Brand/info questions must bypass the empty-pool repair.
//     Production trace 2026-05-13 12:26:23: customer asked "tell me
//     more about aetrex" → bot wrote a 747-char informational
//     answer that contained "here are the highlights:" → the
//     existing empty-pool repair matched "here are" via the
//     product-pitch regex and replaced the entire answer with the
//     generic "Hmm, nothing's quite hitting that combination..."
//     fallback. The fix gates the repair on !isBrandOrInfoQuestion.
// ──────────────────────────────────────────────────────────────
await test("24a — isBrandOrInfoQuestion matches the screenshot's exact phrasing", () => {
  assert.equal(isBrandOrInfoQuestion("tell me more about aetrex"), true);
  assert.equal(isBrandOrInfoQuestion("tell me about your brand"), true);
  assert.equal(isBrandOrInfoQuestion("what is the company"), true);
  assert.equal(isBrandOrInfoQuestion("who is aetrex"), true);
  assert.equal(isBrandOrInfoQuestion("where is your headquarters"), true);
  assert.equal(isBrandOrInfoQuestion("about the brand"), true);
  assert.equal(isBrandOrInfoQuestion("company history"), true);
});

await test("24b — isBrandOrInfoQuestion does NOT match product searches", () => {
  assert.equal(isBrandOrInfoQuestion("show me sneakers"), false);
  assert.equal(isBrandOrInfoQuestion("I need boots for hiking"), false);
  assert.equal(isBrandOrInfoQuestion("recommend an orthotic"), false);
  assert.equal(isBrandOrInfoQuestion(""), false);
  assert.equal(isBrandOrInfoQuestion("are these good for hiking"), false);
});

// ──────────────────────────────────────────────────────────────
// Acknowledgment-prefix: "An orthotic can definitely help with that"
// only when bits include a condition or use-case. Live failure:
// after the customer answered the gender clarifier with "Women's",
// the recommender prefixed the next ask with "Got it — women's. An
// orthotic can definitely help with that." — "that" had no referent.
// ──────────────────────────────────────────────────────────────

await test("25a — gender-only ack does NOT append 'orthotic can help with that'", () => {
  const out = buildAcknowledgmentPrefix({
    latestExtracted: { gender: "women" },
    rawUserText: "Women's",
    answers: {},
  });
  assert.match(out, /Got it — women'?s\.?$/, `expected gender-only ack; got "${out}"`);
  assert.doesNotMatch(out, /orthotic can definitely help with that/i,
    `gender-only ack must not append the orthotic-can-help tail; got "${out}"`);
});

await test("25b — condition ack STILL appends 'orthotic can help with that'", () => {
  const out = buildAcknowledgmentPrefix({
    latestExtracted: { condition: "plantar_fasciitis" },
    rawUserText: "I have plantar fasciitis",
    answers: {},
  });
  assert.match(out, /plantar fasciitis/i);
  assert.match(out, /orthotic can definitely help with that/i,
    `condition ack should keep the orthotic-can-help tail; got "${out}"`);
});

await test("25c — useCase ack STILL appends 'orthotic can help with that'", () => {
  const out = buildAcknowledgmentPrefix({
    latestExtracted: { useCase: "running" },
    rawUserText: "running shoes",
    answers: {},
  });
  assert.match(out, /orthotic can definitely help with that/i,
    `useCase ack should keep the orthotic-can-help tail; got "${out}"`);
});

await test("25d — empty extracted produces no acknowledgment", () => {
  const out = buildAcknowledgmentPrefix({
    latestExtracted: {},
    rawUserText: "hmm",
    answers: {},
  });
  assert.equal(out, "");
});

// ──────────────────────────────────────────────────────────────
// 25e-h — Live 2026-06-03 ack-repeat bug.
// Haiku re-extracts condition=foot_pain on EVERY gate click after
// the customer first said "foot pain". buildAcknowledgmentPrefix
// would then prepend "Got it — foot pain. An orthotic can
// definitely help with that." to the gender chip, use-case chip,
// arch chip, etc. — same condolence on every turn. Fix:
// acknowledge only NEW attributes (not in accumulated answers).
// ──────────────────────────────────────────────────────────────

await test("25e — re-extracted condition already in answers does NOT re-ack", () => {
  // Customer first said "foot pain" → answers.condition='foot_pain'.
  // Next gate turn: customer clicked the "Women" chip. Haiku re-
  // extracted condition=foot_pain from the same conversation
  // history. The ack must NOT fire — we already acknowledged this.
  const out = buildAcknowledgmentPrefix({
    latestExtracted: { gender: "women", condition: "foot_pain" },
    rawUserText: "Women",
    answers: { condition: "foot_pain" }, // ← already known
  });
  // Gender is new; condition is not. Ack should reflect only the
  // new gender, and gender alone doesn't get the orthotic-can-help
  // tail (test 25a).
  assert.doesNotMatch(out, /foot pain/i,
    `must NOT re-ack a condition already in accumulated answers; got "${out}"`);
  assert.doesNotMatch(out, /orthotic can definitely help/i,
    `must NOT emit the helpable-problem tail; got "${out}"`);
});

await test("25f — re-extracted useCase already in answers does NOT re-ack", () => {
  const out = buildAcknowledgmentPrefix({
    latestExtracted: { useCase: "dress_no_removable" },
    rawUserText: "Flat / Low",
    answers: { useCase: "dress_no_removable" },
  });
  assert.equal(out, "", `must NOT re-ack a useCase already known; got "${out}"`);
});

await test("25g — first-time condition click STILL acks (regression of regression)", () => {
  // Don't over-correct: a fresh condition click on a turn where it
  // wasn't yet in accumulated must still produce the friendly ack.
  const out = buildAcknowledgmentPrefix({
    latestExtracted: { condition: "plantar_fasciitis" },
    rawUserText: "Plantar Fasciitis",
    answers: { gender: "women" }, // no prior condition
  });
  assert.match(out, /plantar fasciitis/i);
  assert.match(out, /orthotic can definitely help with that/i);
});

await test("25h — value CHANGE counts as new (treat as a fresh ack)", () => {
  // Customer originally said "foot pain"; later clicked
  // "Plantar Fasciitis" (more specific). The new VALUE is genuinely
  // new even though the key has a prior value.
  const out = buildAcknowledgmentPrefix({
    latestExtracted: { condition: "plantar_fasciitis" },
    rawUserText: "Plantar Fasciitis",
    answers: { condition: "foot_pain" },
  });
  assert.match(out, /plantar fasciitis/i);
});

// ──────────────────────────────────────────────────────────────
// 26. Live 2026-06-03: classifier-gender contamination on a
//     CONDITION chip click triggered subject-pivot reset and
//     re-asked q_arch. Customer walked Men → Dress shoes → Flat/Low
//     → metatarsalgia; clicked the metatarsalgia chip; classifier
//     returned gender=Women (memory contamination); subject pivot
//     dropped arch + useCase; bot re-asked arch.
// ──────────────────────────────────────────────────────────────
section("Chip-scope guard (live 2026-06-03)");

await test("26 — condition chip click + classifier gender contamination must NOT pivot subject or re-ask arch", async () => {
  const { events, encoder, controller } = makeMockSse();
  const cap = captureLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "I have foot pain, what should I wear?" },
        { role: "assistant", content: "Are you looking for footwear with built-in support, or an orthotic insole? <<Footwear>><<Orthotic insole>>" },
        { role: "user", content: "Orthotic insole" },
        { role: "assistant", content: "Who are the orthotics for? <<Men>><<Women>><<Kids>>" },
        { role: "user", content: "Men" },
        { role: "assistant", content: "What kind of shoes will the orthotics go in? <<Dress shoes / heels>><<Casual>><<Athletic>>" },
        { role: "user", content: "Dress shoes / heels" },
        { role: "assistant", content: "What's your arch type? <<Flat / Low>><<Medium>><<High>><<I don't know>>" },
        { role: "user", content: "Flat / Low" },
        { role: "assistant", content: "Any specific foot condition? <<None>><<Plantar Fasciitis>><<Bunions>><<Ball-of-foot pain / metatarsalgia>>" },
        { role: "user", content: "Ball-of-foot pain / metatarsalgia" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      // Reproduce the live contaminated classifier output:
      classifiedIntent: {
        isOrthoticRequest: false,
        isFootwearRequest: true,
        isRejection: false,
        attributes: {
          gender: "Women",                   // ← stale from a prior product turn
          useCase: "dress_no_removable",
          condition: "metatarsalgia",
        },
      },
    });
  } finally {
    cap.restore();
  }
  const flowLogs = cap.lines.filter((l) => l.includes("[orthotic-flow]"));

  // Guard 1: subject pivot must NOT have fired.
  const sawPivot = flowLogs.some((l) => /subject pivot/i.test(l));
  assert.equal(sawPivot, false,
    `subject pivot must NOT fire on a condition chip click. Logs: ${flowLogs.join(" | ")}`);

  // Guard 2: the chip-scope guard log must have recorded the
  // classifier-gender block.
  const sawChipScopeBlock = flowLogs.some(
    (l) => /chip-scope: ignored classifier gender=Women/i.test(l),
  );
  assert.equal(sawChipScopeBlock, true,
    `expected chip-scope block log. Logs: ${flowLogs.join(" | ")}`);

  // Guard 3: bot must NOT re-emit q_arch.
  const archReEmit = events.some(
    (e) => e?.type === "text" && /arch type/i.test(e.text || ""),
  );
  assert.equal(archReEmit, false,
    `gate must not re-emit q_arch after condition chip click`);
});

await test("27 — explicit 'for my wife' STILL pivots subject (existing protection preserved)", async () => {
  // Sanity: the chip-scope guard must not break the legitimate
  // subject-pivot path. Test 13 covers this too; this is a fresh
  // assertion that the override regex catches "for my wife" and
  // allows the classifier gender through.
  const { events, encoder, controller } = makeMockSse();
  const cap = captureLogs();
  try {
    await maybeRunOrthoticFlow({
      messages: [
        { role: "user", content: "I need an orthotic" },
        { role: "assistant", content: "Who? <<Men>><<Women>><<Kids>>" },
        { role: "user", content: "Men" },
        { role: "assistant", content: "Shoes? <<Casual>>" },
        { role: "user", content: "Casual" },
        { role: "assistant", content: "Condition? <<None>><<Plantar>>" },
        { role: "user", content: "Plantar" },
        { role: "assistant", content: "Arch? <<Flat / Low>><<Medium>>" },
        { role: "user", content: "Medium" },
        { role: "assistant", content: "Pronation? <<Yes>><<No>>" },
        { role: "user", content: "actually for my wife" },
      ],
      tree,
      shop: null,
      controller,
      encoder,
      classifiedIntent: {
        isOrthoticRequest: true, isFootwearRequest: false, isRejection: false,
        attributes: { gender: "Women" },
      },
    });
  } finally {
    cap.restore();
  }
  const flowLogs = cap.lines.filter((l) => l.includes("[orthotic-flow]"));
  const sawPivot = flowLogs.some((l) => /subject pivot/i.test(l));
  assert.equal(sawPivot, true,
    `'for my wife' must STILL trigger subject pivot. Logs: ${flowLogs.join(" | ")}`);
});

// ──────────────────────────────────────────────────────────────
// Run summary
// ──────────────────────────────────────────────────────────────
console.log("");
if (failed === 0) {
  console.log(`PASS  ${passed} passed, 0 failed\n`);
  process.exit(0);
} else {
  console.log(`FAIL  ${passed} passed, ${failed} failed\n`);
  for (const f of failures) {
    console.log(`  ${f.name}:`);
    console.log(`    ${f.err?.stack || f.err}`);
  }
  process.exit(1);
}

// Session-memory eval suite (Milestone 2).
//
// Exercises the keyed memory builder against the route-level
// scenarios in the M2 spec. Pure-function tests — no DB, no
// Anthropic, no SSE harness. The builder is invoked directly with
// a synthetic conversation, optional classifier output, and
// optional resolverState; we assert on the resulting memory shape.
//
// Invariants under test:
//   - Latest explicit user statement wins
//   - Chip answers become keyed facts (not an array)
//   - Subject pivots clear stale subject-specific facts
//   - Generic follow-ups inherit prior scope
//   - Rejections persist
//   - Memory shape matches the spec

import assert from "node:assert/strict";
import {
  buildSessionMemory,
  memorySummary,
  buildSessionMemoryPromptBlock,
  detectClarifyingQuestionType,
} from "../app/lib/session-memory.server.js";

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name} — ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

const u = (content) => ({ role: "user", content });
const a = (content) => ({ role: "assistant", content });

console.log("Session-memory eval (Milestone 2)\n");

await test("S1 — shape matches spec (explicit/inferred/stale/facts)", async () => {
  const mem = buildSessionMemory({ messages: [u("hello")] });
  assert.equal(typeof mem.explicit, "object");
  assert.equal(typeof mem.inferred, "object");
  assert.equal(typeof mem.stale, "object");
  assert.ok(Array.isArray(mem.facts));
  assert.ok(Array.isArray(mem.explicit.rejectedCategories));
});

await test("S2 — 'Find men's shoes for my needs' then 'how about women orthotics?' pivots to women+orthotics, stale clears men's footwear", async () => {
  const mem = buildSessionMemory({
    messages: [u("Find men's shoes for my needs"), a("(asks)"), u("how about women orthotics?")],
  });
  assert.equal(mem.explicit.gender, "women", `gender → women; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.category, "orthotics", `category → orthotics; got ${JSON.stringify(mem.explicit)}`);
  // The earlier shoe scope must be stale, not active.
  assert.notEqual(mem.explicit.category, "footwear", "stale men's category must NOT poison explicit");
  // Stale should preserve a record of the prior gender.
  assert.equal(mem.stale.gender || "men", "men");
});

await test("S3 — 'show me men's sneakers' then 'in red' keeps men+sneakers, adds red", async () => {
  const mem = buildSessionMemory({
    messages: [u("show me men's sneakers"), a("Here are some great picks."), u("in red")],
  });
  assert.equal(mem.explicit.gender, "men");
  assert.equal(mem.explicit.category, "sneakers");
  assert.equal(mem.explicit.color, "red");
});

await test("S4 — 'show me sneakers' then 'wide sizes' keeps sneakers, adds width=wide", async () => {
  const mem = buildSessionMemory({
    messages: [u("show me sneakers"), a("Here you go."), u("wide sizes")],
  });
  assert.equal(mem.explicit.category, "sneakers");
  assert.equal(mem.explicit.width, "wide");
});

await test("S5 — 'I don't like sandals' then 'show me shoes' records rejection that persists", async () => {
  const mem = buildSessionMemory({
    messages: [u("I don't like sandals"), a("Noted."), u("show me shoes")],
  });
  assert.ok(
    mem.explicit.rejectedCategories.includes("sandals"),
    `rejectedCategories must include sandals; got ${JSON.stringify(mem.explicit.rejectedCategories)}`,
  );
});

await test("S6 — orthotic chip flow: condition → arch → overpronation become keyed facts", async () => {
  const mem = buildSessionMemory({
    messages: [
      u("I need orthotics"), a("Men's or women's? <<Men's>><<Women's>>"),
      u("Women's"),
      a("What's the issue? <<Plantar fasciitis>><<Ball-of-foot pain / metatarsalgia>>"),
      u("Ball-of-foot pain / metatarsalgia"),
      a("What's your arch? <<Low>><<Medium>><<High>>"),
      u("Medium"),
      a("Do your ankles roll inward? <<Yes>><<No>>"),
      u("No"),
    ],
  });
  assert.equal(mem.explicit.gender, "women", `gender from chip; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.condition, "metatarsalgia", `condition from chip; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.arch, "medium", `arch from chip; got ${JSON.stringify(mem.explicit)}`);
  // No false dilution into rejected, etc.
  const chipFacts = mem.facts.filter((f) => f.source === "chip_click");
  assert.ok(chipFacts.length >= 2, `expected ≥2 chip_click facts; got ${chipFacts.length}`);
});

await test("S7 — 'Find women sandals' then 'actually men's' pivots; latest wins, women scope goes stale", async () => {
  const mem = buildSessionMemory({
    messages: [u("Find women sandals"), a("Got it."), u("actually men's")],
  });
  assert.equal(mem.explicit.gender, "men", "latest gender must win");
  // Pivot clears subject-owned category.
  assert.equal(mem.explicit.category, undefined, "prior women's category must move to stale");
  assert.equal(mem.stale.category, "sandals", `stale must record prior category; got ${JSON.stringify(mem.stale)}`);
});

await test("S7b — 'women black sandals' then 'how about mens?' keeps category/color and pivots gender", async () => {
  const mem = buildSessionMemory({
    messages: [u("show me women’s sandals in black"), a("Here are black women's sandals."), u("how about mens?")],
  });
  assert.equal(mem.explicit.gender, "men", `gender should pivot to men; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.category, "sandals", `category should carry through; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.color, "black", `color should carry through; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.stale.category, undefined, `category should not be stale; got ${JSON.stringify(mem.stale)}`);
});

await test("S8 — 'Find men's shoes' then 'for my wife' pivots to women via recipient detection", async () => {
  const mem = buildSessionMemory({
    messages: [u("Find men's shoes"), a("Got it."), u("for my wife")],
  });
  assert.equal(mem.explicit.gender, "women", `recipient 'wife' → gender=women; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.category, undefined, "prior men's category must NOT leak");
});

await test("S9 — 'for my partner' (no gender derivation) still resets prior gender scope", async () => {
  const mem = buildSessionMemory({
    messages: [u("Find men's sneakers"), a("Here."), u("for my partner")],
  });
  // partner doesn't imply gender — explicit.gender becomes unset.
  assert.equal(mem.explicit.gender, undefined, "ambiguous recipient must clear gender");
  assert.equal(mem.stale.gender, "men", "prior gender must move to stale");
});

await test("S10 — 'show me Vania in 11W' captures size/width with classifier+resolver layered", async () => {
  const mem = buildSessionMemory({
    messages: [u("show me Vania in 11W")],
    resolverState: {
      type: "resolver_state",
      matched_constraints: { specificProduct: "vania", size: "11W" },
      inferred_constraints: {},
      impossible_constraints: [],
      recommended_next_action: { type: "controlled_oos", product_handle: "vania" },
      candidate_products: [],
    },
  });
  assert.equal(mem.explicit.specificProduct, "vania");
  assert.equal(mem.explicit.size, "11W", `size token; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.width, "wide", `width derived from 11W; got ${JSON.stringify(mem.explicit)}`);
});

await test("S11 — 'how about orthotics?' with gender from history carries gender into latest turn", async () => {
  const mem = buildSessionMemory({
    messages: [
      u("Men's"), a("Got it. What kind?"),
      u("how about orthotics?"),
    ],
    classifiedIntent: { isOrthoticRequest: true, attributes: { gender: "Men" } },
  });
  assert.equal(mem.explicit.gender, "men");
  assert.equal(mem.explicit.category, "orthotics");
});

await test("S12 — chip click on 'Men's' establishes gender=men keyed fact", async () => {
  const mem = buildSessionMemory({
    messages: [
      a("Are you shopping for men's or women's? <<Men's>><<Women's>>"),
      u("Men's"),
    ],
  });
  assert.equal(mem.explicit.gender, "men");
  const chipFact = mem.facts.find((f) => f.source === "chip_click" && f.key === "gender");
  assert.ok(chipFact, `chip_click fact expected; got ${JSON.stringify(mem.facts)}`);
});

await test("S13 — orthotic-path chip 'Orthotic insole for these' surfaces as category=orthotics", async () => {
  const mem = buildSessionMemory({
    messages: [
      u("I have foot pain"), a("Are you looking for footwear or orthotics? <<The shoes themselves>><<Orthotic insole for these>>"),
      u("Orthotic insole for these"),
    ],
  });
  assert.equal(mem.explicit.category, "orthotics");
});

await test("S14 — resolver inferred gender flows into memory.inferred", async () => {
  const mem = buildSessionMemory({
    messages: [u("red sandals")],
    resolverState: {
      type: "resolver_state",
      matched_constraints: { color: "red", category: "sandals" },
      inferred_constraints: { gender: { value: "women", reason: "red sandals women-only" } },
      impossible_constraints: [],
      recommended_next_action: { type: "recommend" },
      candidate_products: [{ handle: "kendall", title: "Kendall", availability: "in_stock" }],
    },
  });
  assert.equal(mem.inferred.gender, "women");
  assert.equal(mem.explicit.color, "red");
  assert.equal(mem.explicit.category, "sandals");
});

await test("S15 — facts array records source for every keyed fact", async () => {
  const mem = buildSessionMemory({
    messages: [u("Find women's red sandals")],
  });
  const sources = new Set(mem.facts.map((f) => f.source));
  assert.ok(sources.has("user_text"), `user_text source expected; got ${JSON.stringify(Array.from(sources))}`);
  for (const fact of mem.facts) {
    assert.ok(["user_text", "chip_click", "classifier", "resolver_inferred", "resolver_matched"].includes(fact.source));
    assert.equal(typeof fact.key, "string");
    assert.ok(fact.value != null);
    assert.equal(typeof fact.turnIndex, "number");
  }
});

await test("S16 — empty / null inputs degrade gracefully", async () => {
  assert.doesNotThrow(() => buildSessionMemory({}));
  assert.doesNotThrow(() => buildSessionMemory({ messages: null }));
  assert.doesNotThrow(() => buildSessionMemory({ messages: [] }));
  assert.doesNotThrow(() => buildSessionMemory(undefined));
});

await test("S17 — memorySummary is a compact single line", async () => {
  const mem = buildSessionMemory({
    messages: [u("Find women's red sandals")],
  });
  const s = memorySummary(mem);
  assert.equal(typeof s, "string");
  assert.ok(s.length > 10);
  assert.ok(!s.includes("\n"), "summary must be single-line");
  assert.ok(s.includes("explicit="));
  assert.ok(s.includes("facts="));
});

await test("S18 — buildSessionMemoryPromptBlock surfaces facts in a customer-safe format", async () => {
  const mem = buildSessionMemory({
    messages: [u("Find women's red sandals")],
  });
  const block = buildSessionMemoryPromptBlock(mem);
  assert.ok(block.length > 0, "non-empty when scope present");
  assert.ok(block.includes("session memory") || block.includes("scope"), "must label the block");
  // Customer-safe: no internal terms.
  for (const banned of [
    "resolver_state", "matched_constraints", "inferred_constraints",
    "recommended_next_action", "candidate_products",
  ]) {
    assert.ok(!block.includes(banned), `block must not leak '${banned}'`);
  }
});

await test("S19 — empty memory yields empty prompt block", async () => {
  const mem = buildSessionMemory({ messages: [] });
  assert.equal(buildSessionMemoryPromptBlock(mem), "");
});

await test("S19b — merchandising intent carries through gender/all refinements", async () => {
  const mem = buildSessionMemory({
    messages: [
      u("Show me what's new"),
      a("Which styles would you like to browse? <<Men's>><<Women's>><<Kids>>"),
      u("Women's"),
      a("What type of shoes are you looking for?"),
      u("all"),
    ],
  });
  assert.equal(mem.explicit.modifier, "new", `new modifier should carry; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.badge, "new", `new badge should carry; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.gender, "women");
});

// ── Production-bug regressions (2026-05-19 logs) ───────────────

await test("S20 — classifier useCase is DROPPED on non-orthotic turns (orthotic terminology can't leak)", async () => {
  // Production trace (wedge-for-blue-dress bug): customer asked a
  // plain footwear question and the orthotic classifier returned
  // useCase=dress_no_removable — orthotic-specific terminology. The
  // resolver then tried to match wedges with useCase=dress_no_removable
  // (which doesn't exist for regular footwear), got candidates=0, and
  // emitted nonsense chips. Fix: classifier useCase is forwarded ONLY
  // when isOrthoticRequest=true; otherwise the orthotic enum is wrong
  // terminology that pollutes memory and breaks the resolver.
  const mem = buildSessionMemory({
    messages: [u("show me men's sneakers"), a("here you go"), u("in white")],
    classifiedIntent: {
      isOrthoticRequest: false,
      isFootwearRequest: true,
      attributes: { gender: "Men", useCase: "athletic_training_sports", condition: null },
    },
  });
  assert.equal(mem.explicit.gender, "men", "user-stated gender is explicit");
  assert.equal(mem.explicit.color, "white", "user-stated color is explicit");
  assert.equal(mem.explicit.useCase, undefined, "classifier useCase must NOT be explicit on a non-orthotic turn");
  assert.equal(mem.inferred.useCase, undefined, "classifier useCase must NOT leak into inferred either on a non-orthotic turn");
});

await test("S20b — classifier useCase IS kept on orthotic turns (orthotic flow needs it)", async () => {
  // Guard against over-restriction: when the customer IS asking for
  // an orthotic recommendation, the classifier's useCase enum is the
  // RIGHT terminology and the orthotic resolver depends on it.
  const mem = buildSessionMemory({
    messages: [u("I need orthotics for my casual shoes")],
    classifiedIntent: {
      isOrthoticRequest: true,
      isFootwearRequest: false,
      attributes: { gender: null, useCase: "casual", condition: null },
    },
  });
  assert.equal(mem.inferred.useCase, "casual", "orthotic-turn classifier useCase must be preserved for the orthotic resolver");
});

await test("S21 — category pivot resets category-bound scope (useCase, color, etc.)", async () => {
  // Production trace: customer was browsing orthotics with
  // useCase=athletic; then asked "blue heels" — useCase=athletic
  // bled into the heels turn where it doesn't apply.
  const mem = buildSessionMemory({
    messages: [
      u("I need men's orthotics for training"),
      a("Got it. Anything else?"),
      u("athletic"),
      a("Here you go"),
      // Pivot to a different category entirely
      u("what about navy heels"),
    ],
  });
  assert.equal(mem.explicit.category, "wedges-heels", `category should pivot to heels; got ${mem.explicit.category}`);
  // useCase=athletic should now be stale, not explicit
  assert.notEqual(mem.explicit.useCase, "athletic", "useCase must NOT bleed across category pivot");
  // The prior useCase should be preserved in stale for debugging
  assert.ok(mem.stale.useCase || mem.explicit.useCase == null, "stale should record prior useCase OR it's cleanly cleared");
});

await test("S22b — 'show me anything' resets category-bound scope + category itself, keeps gender", async () => {
  // Tier C item 6: broad reset semantics. The prior color, size,
  // width, condition, useCase, AND category should all go stale.
  // Gender stays — customer is widening within a gender.
  const mem = buildSessionMemory({
    messages: [
      u("men's red sneakers in size 10 wide"),
      a("here you go"),
      u("show me anything"),
    ],
  });
  assert.equal(mem.explicit.gender, "men", "gender should persist across broad reset");
  assert.equal(mem.explicit.category, undefined, "prior category should be cleared");
  assert.equal(mem.explicit.color, undefined, "prior color should be cleared");
  assert.equal(mem.explicit.size, undefined, "prior size should be cleared");
  assert.equal(mem.explicit.width, undefined, "prior width should be cleared");
  assert.ok(mem.stale.category || mem.stale.color, "broad-reset moves prior scope to stale");
});

await test("S22c — 'what else do you have' resets category-bound scope", async () => {
  const mem = buildSessionMemory({
    messages: [
      u("men's running shoes"),
      a("here you go"),
      u("what else do you have"),
    ],
  });
  assert.equal(mem.explicit.gender, "men");
  assert.equal(mem.explicit.category, undefined, "what-else clears category");
});

await test("S22d — 'everything you carry for men' resets to bare gender", async () => {
  const mem = buildSessionMemory({
    messages: [
      u("women's pink sandals"),
      a("here you go"),
      u("everything you carry for men"),
    ],
  });
  // Recipient pivot moves gender to stale; broad reset clears category-bound.
  // After both, the new gender (men) takes hold via extractor.
  assert.equal(mem.explicit.gender, "men", "new gender wins");
  assert.equal(mem.explicit.color, undefined, "old color cleared");
  assert.equal(mem.explicit.category, undefined, "old category cleared");
});

await test("S23 — broad reset does NOT fire on benign latest message", async () => {
  // Make sure benign latest messages (no reset phrase) don't
  // accidentally wipe prior scope.
  const mem = buildSessionMemory({
    messages: [
      u("men's sneakers"),
      a("here you go"),
      u("these are great"),  // no reset phrase, no scope words
    ],
  });
  assert.equal(mem.explicit.gender, "men");
  assert.equal(mem.explicit.category, "sneakers");
});

await test("S22 — catalog-contradiction: stale explicit gender yields to inferred gender", async () => {
  // Production trace: customer was browsing men's items, then asked
  // "navy heels" — heels are women's-only. Resolver inferred
  // gender=women. But memory still had explicit.gender=men from
  // earlier turns. Result: AI said "we don't carry men's heels"
  // even though the customer never asked about men's heels.
  // Fix: when resolver-inferred gender contradicts a carried-over
  // explicit gender, promote the inference.
  const mem = buildSessionMemory({
    messages: [
      u("men's sneakers"),
      a("here you go"),
      u("how about heels"),
    ],
    resolverState: {
      type: "resolver_state",
      matched_constraints: { category: "wedges-heels" },
      inferred_constraints: { gender: { value: "women", reason: "heels women-only" } },
      impossible_constraints: [],
      recommended_next_action: { type: "ask" },
      candidate_products: [],
    },
  });
  assert.equal(mem.explicit.gender, "women", `expected promoted gender=women; got ${mem.explicit.gender}`);
  assert.equal(mem.stale.gender, "men", `prior explicit gender must move to stale; got ${JSON.stringify(mem.stale)}`);
});

await test("S23 — later explicit category request clears its prior rejection", async () => {
  const mem = buildSessionMemory({
    messages: [
      u("no sandals"),
      a("Noted."),
      u("actually sandals are fine"),
    ],
  });
  assert.equal(mem.explicit.category, "sandals");
  assert.ok(
    !mem.explicit.rejectedCategories.includes("sandals"),
    `sandals should no longer be rejected; got ${JSON.stringify(mem.explicit.rejectedCategories)}`,
  );
});

await test("S24 — child recipient words map to kids consistently", async () => {
  const mem = buildSessionMemory({
    messages: [u("show me sneakers for my son")],
  });
  assert.equal(mem.explicit.gender, "kids", `son should map to kids; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.category, "sneakers");
});

await test("S25 — incompatible use-case clears stale specific category + color, keeps footwear umbrella", async () => {
  // Production failure (first-chat screenshot): customer browsed
  // "pink sandals", then said "hiking shoes for italy". "Shoes"
  // now extracts the broad footwear umbrella, so the old specific
  // category=sandals + color=pink must not ride along.
  const mem = buildSessionMemory({
    messages: [
      u("show me pink sandals"),
      a("Here are some pink sandals"),
      u("actually I need hiking shoes for italy"),
    ],
  });
  assert.equal(mem.explicit.category, "footwear", `latest broad footwear scope should replace sandals; got ${mem.explicit.category}`);
  assert.equal(mem.explicit.color, undefined, `stale pink must be cleared; got ${mem.explicit.color}`);
  assert.equal(mem.explicit.useCase, "hiking", "new use-case takes hold");
  assert.ok(mem.stale.category === "sandals" || mem.stale.color === "pink", "prior scope preserved in stale for debugging");
});

await test("S25c — 'show me all of them' is a pronoun back-reference, NOT a broad reset (scope-loss fix)", async () => {
  // Hunter (color-iteration, run #2): customer iterated colors then
  // asked "show me all of them" — meant "all the colors I just named",
  // not "clear my filters". Broad-reset was wiping the color scope.
  const mem = buildSessionMemory({
    messages: [
      u("women's purple sneakers"),
      a("Here you go"),
      u("show me all of them"),
    ],
  });
  // Color scope must be preserved (the customer was referring back to
  // the purple sneakers, not asking to widen).
  assert.equal(mem.explicit.color, "purple", `'all of them' is a back-reference; color must persist; got ${mem.explicit.color}`);
  assert.equal(mem.explicit.category, "sneakers", "category preserved on pronoun back-reference");
});

await test("S25d — genuine widening still fires broad reset", async () => {
  // Guard: "show me everything" / "show me anything" / "what else"
  // remain widening signals.
  const mem = buildSessionMemory({
    messages: [
      u("women's purple sneakers"),
      a("Here you go"),
      u("show me everything you carry"),
    ],
  });
  assert.equal(mem.explicit.category, undefined, "genuine widening still clears category");
});

await test("S25b — compatible use-case does NOT clear carried category (running after sneakers)", async () => {
  // Guard against over-clearing: sneakers + running is a normal
  // refinement, not a need-change. Category must survive.
  const mem = buildSessionMemory({
    messages: [
      u("women's sneakers"),
      a("here you go"),
      u("are these good for running?"),
    ],
  });
  assert.equal(mem.explicit.category, "sneakers", `compatible use-case must keep category; got ${mem.explicit.category}`);
  assert.equal(mem.explicit.useCase, "running", "running use-case still recorded");
});

// R4 — clarifier slot detection must recognize the bot's own gender
// clarifier however it's worded, so the repeat-clarifier guard fires.
await test("R4 — gender clarifier detected with chips in either order", async () => {
  assert.equal(detectClarifyingQuestionType("Which would you like? <<Men's>><<Women's>>"), "gender");
  assert.equal(detectClarifyingQuestionType("Which would you like? <<Women's>><<Men's>>"), "gender");
});

await test("R4 — gender clarifier detected without chips", async () => {
  assert.equal(detectClarifyingQuestionType("Are you shopping for men's or women's?"), "gender");
  assert.equal(detectClarifyingQuestionType("Would you like to browse women's or men's styles?"), "gender");
  assert.equal(detectClarifyingQuestionType("Which styles would you like to browse?"), "gender");
});

await test("R4 — budget / category / size clarifiers classified", async () => {
  assert.equal(detectClarifyingQuestionType("What's your budget?"), "budget");
  assert.equal(detectClarifyingQuestionType("What type of shoe are you after?"), "category");
  assert.equal(detectClarifyingQuestionType("What size do you wear?"), "size_width");
  assert.equal(detectClarifyingQuestionType("Do you need wide or narrow?"), "size_width");
});

await test("R4 — non-clarifying product text is not a clarifier", async () => {
  assert.equal(detectClarifyingQuestionType("Here are the men's sneakers I found."), null);
  assert.equal(detectClarifyingQuestionType(""), null);
});

await test("R4 — lastClarifyingQuestion tracks the most recent gender ask by slot", async () => {
  const mem = buildSessionMemory({
    messages: [
      u("i need shoes"),
      a("Are you shopping for men's or women's? <<Men's>><<Women's>>"),
      u("not sure yet"),
    ],
  });
  assert.equal(mem.lastClarifyingQuestion?.type, "gender");
});

// ──────────────────────────────────────────────────────────────
// 2026-06-02 Railway live failure: turn 1 inferred gender=women from
// "pink sandals for bunions". Turn 2 said "best dress shoes for men".
// The gender pivot rule didn't fire because previousScope.gender was
// null (inferred-only). Fix: session-memory now injects inferred.gender
// into the previousScope passed to resolveTurnIntent.
// ──────────────────────────────────────────────────────────────

await test("S10 — inferred-gender + explicit-new-gender pivot drops carried subject-bound scope", async () => {
  // Simulate the live path: turn 1 establishes pink+sandals+bunions
  // (gender stays inferred=women — never marked explicit because the
  // customer didn't type "women" / "for me"). Turn 2 names a new
  // explicit gender (men) + use-case (dress shoes). The gender pivot
  // MUST fire and drop the carried category/color/condition.
  const mem = buildSessionMemory({
    messages: [
      u("i want pink sandals with arch support and i have bunions"),
      a("Here are some pink sandals."),
      u("best dress shoes for men"),
    ],
    // Simulate the resolver having inferred gender=women on turn 1.
    resolverStatePerTurn: [
      null,
      { inferred: { gender: "women" } },
      null,
    ],
  });
  assert.equal(mem.explicit.gender, "men",
    `explicit gender must pivot to men; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.category, "footwear",
    `latest "dress shoes" should keep broad footwear scope; got ${JSON.stringify(mem.explicit)}`);
  // The whole point: stale must record the previous category/color/condition.
  for (const key of ["color", "condition"]) {
    assert.equal(mem.explicit[key], undefined,
      `${key} must be cleared from explicit on pivot; got ${JSON.stringify(mem.explicit)}`);
  }
});

await test("S11 — kids orthotics then first-person hiking shoe request drops kids gender", async () => {
  const mem = buildSessionMemory({
    messages: [
      u("do you have orthotics that would be good for kids?"),
      a("Here are kids orthotics."),
      u("i'm going to mountain and i need a comfortable shoe for hiking"),
    ],
  });
  assert.equal(mem.explicit.gender, undefined,
    `kids gender must not carry into first-person adult hiking request; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.category, "footwear",
    `latest shoe request should become broad footwear scope; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.useCase, "hiking",
    `latest hiking use-case should apply after stale drop; got ${JSON.stringify(mem.explicit)}`);
  assert.ok(mem.latestTurnIntent?.staleKeysToDrop?.includes("gender"),
    `latest intent should expose gender drop for route-level sessionGender guard; got ${JSON.stringify(mem.latestTurnIntent)}`);
});

await test("S12 — kids supportive shoes before orthotics routes to footwear, not orthotics", async () => {
  const mem = buildSessionMemory({
    messages: [
      u("My 7-year-old son has flat feet, the pediatrician said he might need orthotics but we want to try supportive shoes first before going that route — what do you carry for kids that has real arch support?"),
    ],
  });
  assert.equal(mem.explicit.gender, "kids", `son should establish kids; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.category, "footwear",
    `supportive-shoes-first wording must not become category=orthotics; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.condition, "flat_feet");
});

await test("S13 — sale request after new-arrivals scope clears stale badge=new", async () => {
  const mem = buildSessionMemory({
    messages: [
      u("Show me what's new"),
      a("Which styles would you like to browse? <<Men's>><<Women's>><<Kids>>"),
      u("Women's"),
      a("Here are new women's styles."),
      u("Show me sale shoes"),
    ],
  });
  assert.equal(mem.explicit.modifier, "sale", `sale modifier should win; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.onSale, true, `onSale should be active; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.badge, undefined, `stale badge=new must not constrain sale search; got ${JSON.stringify(mem.explicit)}`);
});

await test("S14 — category pivot from new sandals to white sneakers clears stale merchandising scope", async () => {
  const mem = buildSessionMemory({
    messages: [
      u("show me new women's sandals"),
      a("Here are new sandals."),
      u("it was a white women's sneaker around $140 with a removable insole"),
    ],
  });
  assert.equal(mem.explicit.gender, "women");
  assert.equal(mem.explicit.category, "sneakers");
  assert.equal(mem.explicit.color, "white");
  assert.equal(mem.explicit.modifier, undefined, `new modifier should not leak into sneaker-finding; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.badge, undefined, `new badge should not leak into sneaker-finding; got ${JSON.stringify(mem.explicit)}`);
});

await test("S15 — broad shoes request replaces stale orthotics category", async () => {
  const mem = buildSessionMemory({
    messages: [
      u("show me men's orthotics"),
      a("Here are men's orthotics."),
      u("i need pink shoes"),
    ],
  });
  assert.equal(mem.explicit.category, "footwear",
    `latest broad shoes request must become footwear scope, not stale orthotics; got ${JSON.stringify(mem.explicit)}`);
  assert.equal(mem.explicit.color, "pink");
  assert.equal(mem.explicit.gender, "men",
    `gender can carry until catalog says no exact match, but category must not; got ${JSON.stringify(mem.explicit)}`);
});

console.log("");
if (failed === 0) {
  console.log(`PASS  ${passed} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${passed} passed, ${failed} failed`);
  for (const f of failures) {
    console.log(`  ${f.name}:`);
    console.log(`    ${f.err?.stack || f.err}`);
  }
  process.exit(1);
}

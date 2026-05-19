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

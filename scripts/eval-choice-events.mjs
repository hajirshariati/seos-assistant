import assert from "node:assert/strict";
import { extractChoiceEvents, mapChoiceToMemoryFact } from "../app/lib/choice-events.server.js";
import { extractAnsweredChoices } from "../app/lib/conversation-memory.server.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name} — ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

console.log("Choice events eval\n");

test("C1 — chip answer becomes a structured event with keyed fact", () => {
  const events = extractChoiceEvents([
    { role: "assistant", content: "Who are these for? <<Men's>> <<Women's>>" },
    { role: "user", content: "Women's" },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].answer, "Women's");
  assert.deepEqual(events[0].fact, { key: "gender", value: "women" });
});

test("C2 — contextual yes/no maps overpronation instead of generic yes", () => {
  assert.deepEqual(
    mapChoiceToMemoryFact("No", "Do your feet roll inward or overpronate?"),
    { key: "overpronation", value: "no" },
  );
});

test("C3 — conversation-memory keeps legacy answered choice shape", () => {
  const answered = extractAnsweredChoices([
    { role: "assistant", content: "What arch? <<Flat / Low>> <<Medium / High Arch>>" },
    { role: "user", content: "Medium / High Arch" },
  ]);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].answer, "Medium / High Arch");
  assert.deepEqual(answered[0].options, ["Flat / Low", "Medium / High Arch"]);
});

test("C4 — negated chip option is not accepted as the answer", () => {
  const events = extractChoiceEvents([
    { role: "assistant", content: "Who are these for? <<Men's>> <<Women's>>" },
    { role: "user", content: "not women's, men's" },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].answer, "Men's");
  assert.deepEqual(events[0].fact, { key: "gender", value: "men" });
});

test("C5 — rightmost correction wins across chip options", () => {
  const events = extractChoiceEvents([
    { role: "assistant", content: "Which color? <<Black>> <<Blue>>" },
    { role: "user", content: "black actually blue" },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].answer, "Blue");
});

test("C6 — later affirmative mention can override earlier negation of same option", () => {
  const events = extractChoiceEvents([
    { role: "assistant", content: "Who are these for? <<Men's>> <<Women's>>" },
    { role: "user", content: "not women's, actually women's" },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].answer, "Women's");
});

test("C7 — context-carrying gender chip still maps the gender fact", () => {
  // Decorated navigation/flow chips ("Women's shoes", "Men's
  // orthotics", "Kids' orthotics") must keep producing the keyed
  // gender fact — the leading gender token decides.
  const events = extractChoiceEvents([
    { role: "assistant", content: "Are you shopping for men's or women's? <<Men's shoes>> <<Women's shoes>>" },
    { role: "user", content: "Women's shoes" },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].answer, "Women's shoes");
  assert.deepEqual(events[0].fact, { key: "gender", value: "women" });
  assert.deepEqual(mapChoiceToMemoryFact("Men's orthotics"), { key: "gender", value: "men" });
  assert.deepEqual(mapChoiceToMemoryFact("Kids' orthotics"), { key: "gender", value: "kids" });
});

test("C8 — condition/useCase facts use the TREE's enum vocabulary, never phantom values", () => {
  // The mapper previously emitted enums that exist nowhere in
  // aetrex-orthotic-tree.json (heel_spur, flat_feet,
  // comfort_walking_everyday, …) — values no downstream consumer
  // could ever match. Every emitted value must be a real tree enum.
  assert.deepEqual(mapChoiceToMemoryFact("Heel spurs"), { key: "condition", value: "heel_spurs" });
  assert.deepEqual(mapChoiceToMemoryFact("Overpronation / flat feet"), { key: "condition", value: "overpronation_flat_feet" });
  assert.deepEqual(mapChoiceToMemoryFact("Diabetic feet"), { key: "condition", value: "diabetic" });
  assert.deepEqual(mapChoiceToMemoryFact("None — just want comfort"), { key: "condition", value: "none" });
  assert.deepEqual(mapChoiceToMemoryFact("Athletic — running"), { key: "useCase", value: "athletic_running" });
  assert.deepEqual(mapChoiceToMemoryFact("Athletic — gym / training"), { key: "useCase", value: "athletic_training" });
  assert.deepEqual(mapChoiceToMemoryFact("Work / on my feet all day"), { key: "useCase", value: "work_all_day" });
  assert.deepEqual(mapChoiceToMemoryFact("Everyday / casual shoes"), { key: "useCase", value: "casual" });
  assert.deepEqual(mapChoiceToMemoryFact("Just want comfort / relief"), { key: "useCase", value: "comfort" });
});

if (failed > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`- ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}

console.log(`\nChoice events eval: ${passed}/${passed + failed} passed`);

// Peak Mode's home (app/lib/peak-home.js): the saved blocks come back clean,
// bad input is named, the widget gets them only while Peak Mode is on, and
// each shopper sees the blocks meant for them.
//
// Run: node scripts/eval-peak-home.mjs
import assert from "node:assert/strict";
import { parsePeakHome, peakHomeError, peakHomeConfig, peakImage, blocksFor, PEAK_BLOCKS_MAX } from "../app/lib/peak-home.js";

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); } };
const PNG = "data:image/png;base64," + Buffer.from("png-bytes-here").toString("base64");
const HUGE = "data:image/png;base64," + Buffer.alloc(500 * 1024, 65).toString("base64");

console.log("\nthe saved home");
test("blocks come back clean: names required, words trimmed and capped, a link or a question by the button's kind, the audience and its tag, pictures kept; at most six", () => {
  const h = parsePeakHome({ avatar: PNG, blocks: [
    { id: "a1", eyebrow: "  Black   Friday ", title: "30% off everything", text: "Today only", cta: "Shop", kind: "link", url: "/collections/sale", image: PNG, audience: "all", tag: "x" },
    { title: "", cta: "Hidden" },
    { id: "bad id!", title: "Members", cta: "See my offer", kind: "ask", message: "What's my offer?", url: "https://ignored", audience: "signed" },
    { title: "VIP early access", kind: "ask", message: "vip", audience: "tag", tag: " VIP " },
    { title: "Join", kind: "link", url: "javascript:alert(1)", audience: "guest" },
    { title: "5" }, { title: "6" }, { title: "7" }, { title: "8" },
  ] });
  assert.equal(h.avatar, PNG);
  assert.equal(h.blocks.length, PEAK_BLOCKS_MAX);
  assert.deepEqual(h.blocks[0], { id: "a1", eyebrow: "Black Friday", title: "30% off everything", text: "Today only", cta: "Shop", kind: "link", url: "/collections/sale", message: "", image: PNG, audience: "all", tag: "" });
  assert.equal(h.blocks[1].id, "badid"); assert.equal(h.blocks[1].url, ""); assert.equal(h.blocks[1].message, "What's my offer?");
  assert.equal(h.blocks[2].tag, "VIP");
  assert.equal(h.blocks[3].url, "", "an unsafe link is dropped");
  assert.deepEqual(parsePeakHome("{broken"), { avatar: "", blocks: [] });
  assert.deepEqual(parsePeakHome(""), { avatar: "", blocks: [] });
});
test("what's wrong is named: a picture too large, a tag audience without a tag, a button without its link or question", () => {
  assert.match(peakHomeError({ avatar: HUGE }), /too large/);
  assert.match(peakHomeError({ blocks: [{ title: "x", image: HUGE }] }), /Block 1: the picture is too large/);
  assert.match(peakHomeError({ blocks: [{ title: "x", audience: "tag" }] }), /name the customer tag/);
  assert.match(peakHomeError({ blocks: [{ title: "x", cta: "Go", kind: "ask" }] }), /write its question/);
  assert.match(peakHomeError({ blocks: [{ title: "x", cta: "Go", kind: "link", url: "nope" }] }), /give it one/);
  assert.equal(peakHomeError({ blocks: [{ title: "x", cta: "Go", kind: "link", url: "/sale" }, { title: "" , cta: "Go" }] }), "");
});

console.log("\nfor the widget");
test("the home is handed over only while Peak Mode is on, pictures as fingerprinted links, each block with its link or its question", () => {
  const saved = JSON.stringify({ avatar: PNG, blocks: [{ id: "b1", title: "Sale", cta: "Shop", kind: "link", url: "/sale", image: PNG, audience: "all" }, { id: "b2", title: "Ask", cta: "Ask", kind: "ask", message: "deals?", audience: "tag", tag: "VIP" }] });
  assert.equal(peakHomeConfig({ peakMode: "off", peakHome: saved }), null);
  const on = peakHomeConfig({ peakMode: "on", peakHome: saved });
  assert.match(on.avatar, /^\/apps\/hajirai\/peak-image\?b=avatar&v=[0-9a-z]+$/);
  assert.equal(on.blocks.length, 2);
  assert.match(on.blocks[0].image, /^\/apps\/hajirai\/peak-image\?b=b1&v=/);
  assert.equal(on.blocks[0].url, "/sale"); assert.equal(on.blocks[0].message, undefined);
  assert.equal(on.blocks[1].message, "deals?"); assert.equal(on.blocks[1].url, undefined); assert.equal(on.blocks[1].image, "");
  assert.equal(on.blocks[1].tag, "VIP");
  const sched = { peakMode: "scheduled", peakStartsAt: "2026-11-27T05:00:00.000Z", peakEndsAt: "2026-11-30T05:00:00.000Z", peakHome: saved };
  assert.equal(peakHomeConfig(sched, new Date("2026-11-26T12:00:00Z")), null, "not yet");
  assert.ok(peakHomeConfig(sched, new Date("2026-11-28T12:00:00Z")), "the day itself");
  assert.equal(peakHomeConfig({ peakMode: "on", peakHome: "{}" }), null, "nothing set: the usual home");
  assert.equal(peakImage({ peakHome: saved }, "b1").type, "image/png");
  assert.equal(peakImage({ peakHome: saved }, "avatar").type, "image/png");
  assert.equal(peakImage({ peakHome: saved }, "nope"), null);
});
test("who sees what: signed out → everyone's and signed-out blocks; signed in → everyone's and signed-in blocks, plus a tag's when they carry it (any case)", () => {
  const blocks = [{ id: "a", audience: "all" }, { id: "g", audience: "guest" }, { id: "s", audience: "signed" }, { id: "t", audience: "tag", tag: "VIP" }];
  assert.deepEqual(blocksFor(blocks, { signedIn: false }).map((b) => b.id), ["a", "g"]);
  assert.deepEqual(blocksFor(blocks, { signedIn: true, tags: ["wholesale"] }).map((b) => b.id), ["a", "s"]);
  assert.deepEqual(blocksFor(blocks, { signedIn: true, tags: ["wholesale", " vip "] }).map((b) => b.id), ["a", "s", "t"]);
  assert.deepEqual(blocksFor(blocks, { signedIn: false, tags: ["VIP"] }).map((b) => b.id), ["a", "g"], "a tag counts only signed in");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

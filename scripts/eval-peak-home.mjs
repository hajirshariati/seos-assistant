// Peak Mode's home (app/lib/peak-home.js): the saved blocks come back clean,
// bad input is named, the widget gets them only while Peak Mode is on, and
// each shopper sees the blocks meant for them.
//
// Run: node scripts/eval-peak-home.mjs
import assert from "node:assert/strict";
import { parsePeakHome, peakHomeError, peakHomeConfig, peakImage, blocksFor, cleanPeakColors, PEAK_BLOCKS_MAX, PEAK_COLOR_SETS, PEAK_COLORS_MAX, PEAK_LAYOUTS, PEAK_SHAPES } from "../app/lib/peak-home.js";

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); } };
const PNG = "data:image/png;base64," + Buffer.from("png-bytes-here").toString("base64");
const HUGE = "data:image/png;base64," + Buffer.alloc(500 * 1024, 65).toString("base64");

console.log("\nthe saved home");
test("blocks come back clean: a picture required, the name trimmed and capped, a link or a question by what a tap does, the audience and its tag; at most six", () => {
  const h = parsePeakHome({ avatar: PNG, layout: "mosaic", shape: "square", colors: ["#D42B3A", " #1f7a4d ", "red", "#e9b949", "#8f1d2b", "#000000"], blocks: [
    { id: "a1", eyebrow: "  Black   Friday ", title: "  30% off   everything ", text: "Today only", cta: "Shop", kind: "link", url: "/collections/sale", image: PNG, audience: "all", tag: "x" },
    { title: "No picture", cta: "Hidden", url: "/x" },
    { id: "bad id!", title: "Members", kind: "ask", message: "What's my offer?", url: "https://ignored", image: PNG, audience: "signed" },
    { title: "VIP early access", kind: "ask", message: "vip", image: PNG, audience: "tag", tag: " VIP " },
    { title: "Join", kind: "link", url: "javascript:alert(1)", image: PNG, audience: "guest" },
    { kind: "none", url: "/ignored", image: PNG },
    { image: PNG }, { image: PNG }, { image: PNG },
  ] });
  assert.equal(h.avatar, PNG);
  assert.equal(h.layout, "mosaic"); assert.equal(h.shape, "square");
  assert.deepEqual(h.colors, ["#d42b3a", "#1f7a4d", "#e9b949", "#8f1d2b"], "four good colours, lowercased, the rest dropped");
  assert.equal(h.blocks.length, PEAK_BLOCKS_MAX);
  assert.deepEqual(h.blocks[0], { id: "a1", title: "30% off everything", kind: "link", url: "/collections/sale", message: "", image: PNG, video: "", audience: "all", tag: "" }, "no eyebrow, text or button any more");
  assert.equal(h.blocks[1].id, "badid"); assert.equal(h.blocks[1].url, ""); assert.equal(h.blocks[1].message, "What's my offer?");
  assert.equal(h.blocks[2].tag, "VIP");
  assert.equal(h.blocks[3].url, "", "an unsafe link is dropped");
  assert.deepEqual([h.blocks[4].kind, h.blocks[4].url, h.blocks[4].title], ["none", "", ""], "a picture that does nothing when tapped");
  assert.deepEqual(parsePeakHome("{broken"), { avatar: "", layout: "rail", shape: "wide", colors: [], blocks: [] });
  assert.deepEqual(parsePeakHome({ layout: "spiral", shape: "round", colors: "red" }), { avatar: "", layout: "rail", shape: "wide", colors: [], blocks: [] }, "unknown choices fall back");
});
test("what's wrong is named: a picture too large or missing, a tag audience without a tag, a tap without its link or question; an empty block is left out quietly", () => {
  assert.match(peakHomeError({ avatar: HUGE }), /too large/);
  assert.match(peakHomeError({ blocks: [{ image: HUGE }] }), /Picture 1: the picture is too large/);
  assert.match(peakHomeError({ blocks: [{ image: PNG, kind: "none" }, { title: "Sale", url: "/sale" }] }), /Picture 2: add the picture/);
  assert.match(peakHomeError({ blocks: [{ image: PNG }] }), /Picture 1: a tap opens a link/, "a new block is a link until told otherwise");
  assert.match(peakHomeError({ blocks: [{ image: PNG, audience: "tag" }] }), /name the customer tag/);
  assert.match(peakHomeError({ blocks: [{ image: PNG, kind: "ask" }] }), /write the question/);
  assert.match(peakHomeError({ blocks: [{ image: PNG, kind: "link", url: "nope" }] }), /give it one/);
  assert.equal(peakHomeError({ blocks: [{ image: PNG, kind: "link", url: "/sale" }, { image: PNG, kind: "none" }, {}, { id: "x", kind: "link" }] }), "");
});
const CDN = "https://cdn.shopify.com/s/files/1/0001/0002/files/sale-banner.jpg?v=1730000000";
const MP4 = "https://cdn.shopify.com/videos/c/o/v/abc123.mp4";
test("Shopify Files: a picture or a video picked from the store's files is kept as its link; a video alone is enough; other links are refused", () => {
  const h = parsePeakHome({ blocks: [
    { id: "f1", title: "Sale", kind: "link", url: "/sale", image: CDN, audience: "all" },
    { id: "f2", title: "Clip", kind: "none", video: MP4, audience: "all" },
    { id: "f3", title: "Both", kind: "none", image: PNG, video: MP4 },
    { id: "f4", title: "Elsewhere", kind: "none", image: "https://example.com/pic.jpg" },
    { id: "f5", title: "Not a video", kind: "none", video: "https://cdn.shopify.com/s/files/1/0001/doc.pdf" },
  ] });
  assert.deepEqual(h.blocks.map((b) => [b.id, b.image, b.video]), [["f1", CDN, ""], ["f2", "", MP4], ["f3", PNG, MP4]]);
  assert.match(peakHomeError({ blocks: [{ title: "x", image: "https://example.com/pic.jpg" }] }), /Picture 1: pick the picture from your Shopify files/);
  assert.match(peakHomeError({ blocks: [{ title: "x", image: PNG, video: "https://example.com/clip.mp4" }] }), /Picture 1: pick the video from your Shopify files/);
  assert.equal(peakHomeError({ blocks: [{ title: "x", kind: "none", video: MP4 }] }), "");
  const on = peakHomeConfig({ peakMode: "on", peakHome: JSON.stringify({ avatar: CDN, blocks: [{ id: "f1", kind: "none", image: CDN, video: MP4 }, { id: "f2", kind: "none", image: PNG }] }) });
  assert.equal(on.avatar, CDN, "a Shopify link is handed over as it is");
  assert.deepEqual([on.blocks[0].image, on.blocks[0].video], [CDN, MP4]);
  assert.match(on.blocks[1].image, /^\/apps\/hajirai\/peak-image\?b=f2&v=/);
  assert.ok(!("video" in on.blocks[1]));
});
test("the colour sets: her usual colours are an empty set; every other set is four good colours; the cleaner caps at four", () => {
  assert.deepEqual(PEAK_COLOR_SETS[0].colors, []);
  for (const set of PEAK_COLOR_SETS.slice(1)) assert.deepEqual(cleanPeakColors(set.colors), set.colors, set.id);
  assert.equal(cleanPeakColors(["#111111", "#222222", "#333333", "#444444", "#555555"]).length, PEAK_COLORS_MAX);
  assert.deepEqual(cleanPeakColors(null), []);
  assert.deepEqual(PEAK_LAYOUTS, ["rail", "mosaic", "grid"]);
  assert.deepEqual(Object.keys(PEAK_SHAPES), ["wide", "standard", "square"]);
});

console.log("\nfor the widget");
test("the home is handed over only while Peak Mode is on, pictures as fingerprinted links, each block with its link or its question, the layout, the shape and the colours", () => {
  const saved = JSON.stringify({ avatar: PNG, layout: "grid", shape: "standard", colors: ["#d42b3a", "#1f7a4d"], blocks: [{ id: "b1", title: "Sale", kind: "link", url: "/sale", image: PNG, audience: "all" }, { id: "b2", title: "Ask", kind: "ask", message: "deals?", image: PNG, audience: "tag", tag: "VIP" }, { id: "b3", kind: "none", image: PNG }] });
  assert.equal(peakHomeConfig({ peakMode: "off", peakHome: saved }), null);
  const on = peakHomeConfig({ peakMode: "on", peakHome: saved });
  assert.match(on.avatar, /^\/apps\/hajirai\/peak-image\?b=avatar&v=[0-9a-z]+$/);
  assert.equal(on.layout, "grid"); assert.equal(on.shape, "standard"); assert.deepEqual(on.colors, ["#d42b3a", "#1f7a4d"]);
  assert.equal(on.blocks.length, 3);
  assert.match(on.blocks[0].image, /^\/apps\/hajirai\/peak-image\?b=b1&v=/);
  assert.equal(on.blocks[0].url, "/sale"); assert.equal(on.blocks[0].message, undefined);
  assert.equal(on.blocks[1].message, "deals?"); assert.equal(on.blocks[1].url, undefined);
  assert.equal(on.blocks[1].tag, "VIP");
  assert.deepEqual([on.blocks[2].url, on.blocks[2].message], [undefined, undefined], "a picture that does nothing carries neither");
  assert.ok(!("eyebrow" in on.blocks[0]) && !("cta" in on.blocks[0]) && !("text" in on.blocks[0]));
  const sched = { peakMode: "scheduled", peakStartsAt: "2026-11-27T05:00:00.000Z", peakEndsAt: "2026-11-30T05:00:00.000Z", peakHome: saved };
  assert.equal(peakHomeConfig(sched, new Date("2026-11-26T12:00:00Z")), null, "not yet");
  assert.ok(peakHomeConfig(sched, new Date("2026-11-28T12:00:00Z")), "the day itself");
  assert.equal(peakHomeConfig({ peakMode: "on", peakHome: "{}" }), null, "nothing set: the usual home");
  assert.deepEqual(peakHomeConfig({ peakMode: "on", peakHome: JSON.stringify({ colors: ["#d42b3a"] }) }), { avatar: "", layout: "rail", shape: "wide", colors: ["#d42b3a"], blocks: [] }, "colours alone are worth handing over");
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

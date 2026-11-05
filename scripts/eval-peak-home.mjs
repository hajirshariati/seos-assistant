// Peak Mode's home (app/lib/peak-home.js): the saved blocks come back clean,
// bad input is named, the widget gets them only while Peak Mode is on, and
// each shopper sees the blocks meant for them.
//
// Run: node scripts/eval-peak-home.mjs
import assert from "node:assert/strict";
import { parsePeakHome, peakHomeError, peakHomeConfig, peakImage, peakSrcset, blocksFor, cleanPeakColors, parseHomeLook, homeLookConfig, HOME_LOOK_DEFAULT, HOME_CARDS, PEAK_BLOCKS_MAX, PEAK_COLOR_SETS, PEAK_COLORS_MAX, PEAK_LAYOUTS, PEAK_SHAPES } from "../app/lib/peak-home.js";

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); } };
const PNG = "data:image/png;base64," + Buffer.from("png-bytes-here").toString("base64");
const HUGE = "data:image/png;base64," + Buffer.alloc(900 * 1024, 65).toString("base64");

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
  assert.deepEqual(h.blocks[0], { id: "a1", title: "30% off everything", kind: "link", url: "/collections/sale", message: "", image: PNG, video: "", focus: "center", audience: "all", tag: "" }, "no eyebrow, text or button any more");
  assert.equal(parsePeakHome({ blocks: [{ image: PNG, focus: "top right" }] }).blocks[0].focus, "top right");
  assert.equal(parsePeakHome({ blocks: [{ image: PNG, focus: "middle" }] }).blocks[0].focus, "center", "an unknown anchor is the centre");
  const anchored = peakHomeConfig({ peakMode: "on", peakHome: JSON.stringify({ blocks: [{ id: "r", kind: "none", image: PNG, focus: "right" }, { id: "c", kind: "none", image: PNG }] }) });
  assert.equal(anchored.blocks[0].focus, "right"); assert.ok(!("focus" in anchored.blocks[1]), "the centre goes without saying");
  assert.equal(h.blocks[1].id, "badid"); assert.equal(h.blocks[1].url, ""); assert.equal(h.blocks[1].message, "What's my offer?");
  assert.equal(h.blocks[2].tag, "VIP");
  assert.equal(h.blocks[3].url, "", "an unsafe link is dropped");
  assert.deepEqual([h.blocks[4].kind, h.blocks[4].url, h.blocks[4].title], ["none", "", ""], "a picture that does nothing when tapped");
  const plain = { avatar: "", layout: "rail", shape: "wide", colors: [], ring: "fine", decor: "off", tint: false, cards: "full", blocks: [] };
  assert.deepEqual(parsePeakHome("{broken"), plain);
  assert.deepEqual(parsePeakHome({ layout: "spiral", shape: "round", colors: "red", ring: "huge", decor: "bow", tint: "yes" }), plain, "unknown choices fall back");
  const look = parsePeakHome({ ring: "bold", decor: "lights", tint: true });
  assert.deepEqual([look.ring, look.decor, look.tint, look.cards], ["bold", "lights", true, "full"]);
  assert.equal(parsePeakHome({ cards: "simple" }).cards, "simple", "the simple cards on peak days");
  assert.equal(parsePeakHome({ cards: "tiny" }).cards, "full");
  assert.equal(parsePeakHome({ decor: "both" }).decor, "lights", "earlier days' choices read as the lights");
  assert.equal(parsePeakHome({ decor: "header" }).decor, "lights");
  assert.equal(parsePeakHome({ decor: "line" }).decor, "lights");
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
  assert.deepEqual(peakHomeConfig({ peakMode: "on", peakHome: JSON.stringify({ colors: ["#d42b3a"] }) }), { avatar: "", layout: "rail", shape: "wide", colors: ["#d42b3a"], ring: "fine", decor: "off", tint: false, cards: "full", blocks: [] }, "colours alone are worth handing over");
  assert.deepEqual([on.ring, on.decor, on.tint, on.cards], ["fine", "off", false, "full"]);
  assert.equal(peakHomeConfig({ peakMode: "on", peakHome: JSON.stringify({ decor: "lights" }) }).decor, "lights", "a look alone is worth handing over too");
  assert.equal(peakHomeConfig({ peakMode: "on", peakHome: JSON.stringify({ cards: "simple" }) }).cards, "simple", "the cards' style alone is worth handing over too");
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


console.log("\nsizes to choose from");
test("an upload keeps its smaller copies and its width; a Files picture has none of its own (the CDN's instead); a copy not smaller than the picture is dropped", () => {
  const png = "data:image/png;base64," + Buffer.alloc(1200, 65).toString("base64");
  const webp = "data:image/webp;base64," + Buffer.alloc(600, 66).toString("base64");
  const saved = parsePeakHome({ blocks: [
    { id: "u", image: png, imageW: 1600, image800: webp, image400: webp, url: "/a" },
    { id: "c", image: "https://cdn.shopify.com/s/files/1/0/files/gift.png?v=1", imageW: 1600, image800: webp, url: "/b" },
    { id: "s", image: png, imageW: 700, image800: webp, image400: webp, url: "/c" },
  ] });
  assert.deepEqual([saved.blocks[0].imageW, !!saved.blocks[0].image800, !!saved.blocks[0].image400], [1600, true, true]);
  assert.deepEqual([saved.blocks[1].imageW, saved.blocks[1].image800], [undefined, undefined], "a Files picture carries no copies");
  assert.deepEqual([saved.blocks[2].imageW, !!saved.blocks[2].image800, !!saved.blocks[2].image400], [700, false, true], "only copies smaller than the picture");
  const config = { peakMode: "on", peakHome: JSON.stringify(saved) };
  assert.equal(peakImage(config, "u", 800).type, "image/webp", "the 800 copy when asked");
  assert.equal(peakImage(config, "u", 640).type, "image/png", "an unknown width: the picture");
  assert.equal(peakImage(config, "s", 800).type, "image/png", "no such copy: the picture");
  const on = peakHomeConfig(config);
  assert.match(on.blocks[0].srcset, /^\/apps\/hajirai\/peak-image\?b=u&v=\w+&w=400 400w, \/apps\/hajirai\/peak-image\?b=u&v=\w+&w=800 800w, \/apps\/hajirai\/peak-image\?b=u&v=\w+ 1600w$/);
  assert.equal(on.blocks[1].srcset, "https://cdn.shopify.com/s/files/1/0/files/gift.png?v=1&width=400 400w, https://cdn.shopify.com/s/files/1/0/files/gift.png?v=1&width=800 800w, https://cdn.shopify.com/s/files/1/0/files/gift.png?v=1&width=1200 1200w, https://cdn.shopify.com/s/files/1/0/files/gift.png?v=1&width=1600 1600w, https://cdn.shopify.com/s/files/1/0/files/gift.png?v=1&width=2000 2000w");
  assert.match(on.blocks[2].srcset, /w=400 400w, .* 700w$/);
  assert.equal(peakSrcset(png, "", {}), "", "an upload without copies: none");
  assert.equal(peakSrcset("", "x", { sizes: [400] }), "");
});

console.log("\nher look on every other day (Settings → Focus home → Her look)");
test("the saved look comes back clean: up to four colours, the ring, the lights, the tint, the cards' style; unknown choices fall back; nothing saved → the defaults", () => {
  assert.deepEqual(HOME_CARDS, ["full", "simple"]);
  assert.deepEqual(parseHomeLook(""), HOME_LOOK_DEFAULT);
  assert.deepEqual(parseHomeLook("{}"), { colors: [], ring: "fine", decor: "off", tint: false, cards: "full" });
  assert.deepEqual(parseHomeLook("not json"), HOME_LOOK_DEFAULT);
  assert.deepEqual(parseHomeLook({ colors: ["#8FD3FF", "bad", "#5b8def"], ring: "regular", decor: "lights", tint: true, cards: "simple" }), { colors: ["#8fd3ff", "#5b8def"], ring: "regular", decor: "lights", tint: true, cards: "simple" });
  assert.deepEqual(parseHomeLook({ ring: "huge", decor: "bow", tint: "yes", cards: "mini" }), HOME_LOOK_DEFAULT, "unknown choices fall back");
  assert.deepEqual(parseHomeLook(JSON.stringify({ decor: "both" })).decor, "off", "the peak home's older names aren't read here");
});
test("for the widget: null while nothing is set (the built-in look), the look once anything is — each part alone counts", () => {
  assert.equal(homeLookConfig({}), null);
  assert.equal(homeLookConfig({ homeLook: "{}" }), null);
  assert.equal(homeLookConfig({ homeLook: JSON.stringify({ colors: [], ring: "fine", decor: "off", tint: false, cards: "full" }) }), null);
  assert.deepEqual(homeLookConfig({ homeLook: JSON.stringify({ cards: "simple" }) }), { colors: [], ring: "fine", decor: "off", tint: false, cards: "simple" });
  assert.deepEqual(homeLookConfig({ homeLook: JSON.stringify({ tint: true }) }), { colors: [], ring: "fine", decor: "off", tint: true, cards: "full" });
  assert.deepEqual(homeLookConfig({ homeLook: JSON.stringify({ colors: ["#d42b3a"] }) }).colors, ["#d42b3a"]);
  assert.equal(homeLookConfig({ homeLook: JSON.stringify({ ring: "bold" }) }).ring, "bold");
  // Peak Mode doesn't change what the look says: the widget picks the peak look over it while Peak Mode is on.
  assert.deepEqual(homeLookConfig({ peakMode: "on", homeLook: JSON.stringify({ ring: "bold" }) }).ring, "bold");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
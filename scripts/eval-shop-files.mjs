// Settings → Choose from files (app/lib/shop-files.js): what Shopify is
// asked, and what its answer becomes — ready pictures and videos only,
// each with a link to show, a preview and a name; the MP4 a video plays.
//
// Run: node scripts/eval-shop-files.mjs
import assert from "node:assert/strict";
import { filesQueryString, fileItems, FILES_QUERY, SHOP_FILES_PAGE } from "../app/lib/shop-files.js";

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); } };

console.log("\nthe search");
test("the kinds wanted, and the words typed as a file-name search, cleaned", () => {
  assert.equal(filesQueryString("image"), "media_type:IMAGE");
  assert.equal(filesQueryString("video"), "media_type:VIDEO");
  assert.equal(filesQueryString("all"), "(media_type:IMAGE OR media_type:VIDEO)");
  assert.equal(filesQueryString("nope"), "(media_type:IMAGE OR media_type:VIDEO)");
  assert.equal(filesQueryString("image", "  black  friday "), "media_type:IMAGE AND filename:*black friday*");
  assert.equal(filesQueryString("image", 'x" OR id:*'), "media_type:IMAGE AND filename:*x OR id*");
  assert.equal(filesQueryString("image", "x".repeat(100)).length, "media_type:IMAGE AND filename:**".length + 60);
  assert.ok(FILES_QUERY.includes("files(first: $first") && FILES_QUERY.includes("... on Video") && SHOP_FILES_PAGE > 0);
});

console.log("\nthe answer");
test("pictures and videos that are ready become items; a video plays its sharpest MP4 at most 1280 wide; the rest is left out", () => {
  const items = fileItems([
    { id: "gid://shopify/MediaImage/1", alt: "Sale", fileStatus: "READY", image: { url: "https://cdn.shopify.com/s/files/1/0/files/sale_1a2b3c4d5e.png?v=1", width: 1600, height: 900 }, preview: { image: { url: "https://cdn.shopify.com/s/files/1/0/files/sale_1a2b3c4d5e_small.png" } } },
    { id: "gid://shopify/MediaImage/2", fileStatus: "PROCESSING", image: { url: "https://cdn.shopify.com/x.png" } },
    { id: "gid://shopify/Video/3", alt: "", fileStatus: "READY", duration: 12400, preview: { image: { url: "https://cdn.shopify.com/videos/poster.jpg" } }, sources: [
      { url: "https://cdn.shopify.com/videos/c/o/v/a.HD-1080p-7.2Mbps.mp4", mimeType: "video/mp4", format: "mp4", width: 1920, height: 1080 },
      { url: "https://cdn.shopify.com/videos/c/o/v/a.HD-720p-4.5Mbps.mp4", mimeType: "video/mp4", format: "mp4", width: 1280, height: 720 },
      { url: "https://cdn.shopify.com/videos/c/o/v/a.SD-480p-1.5Mbps.mp4", mimeType: "video/mp4", format: "mp4", width: 854, height: 480 },
      { url: "https://cdn.shopify.com/videos/c/o/v/a.m3u8", mimeType: "application/x-mpegURL", format: "m3u8" },
    ] },
    { id: "gid://shopify/Video/4", fileStatus: "READY", sources: [], originalSource: { url: "https://cdn.shopify.com/videos/c/o/v/orig.mov", mimeType: "video/quicktime", format: "mov", width: 640, height: 360 } },
    { id: "gid://shopify/GenericFile/5", fileStatus: "READY", url: "https://cdn.shopify.com/doc.pdf" },
    null,
  ]);
  assert.deepEqual(items.map((i) => [i.id, i.kind]), [["gid://shopify/MediaImage/1", "image"], ["gid://shopify/Video/3", "video"], ["gid://shopify/Video/4", "video"]]);
  assert.deepEqual(items[0], { id: "gid://shopify/MediaImage/1", kind: "image", url: "https://cdn.shopify.com/s/files/1/0/files/sale_1a2b3c4d5e.png?v=1", poster: "https://cdn.shopify.com/s/files/1/0/files/sale_1a2b3c4d5e_small.png", width: 1600, height: 900, alt: "Sale", name: "sale.png" });
  assert.equal(items[1].url, "https://cdn.shopify.com/videos/c/o/v/a.HD-720p-4.5Mbps.mp4", "the 720p one: sharpest at most 1280 wide");
  assert.equal(items[1].poster, "https://cdn.shopify.com/videos/poster.jpg");
  assert.equal(items[1].duration, 12);
  assert.equal(items[2].url, "https://cdn.shopify.com/videos/c/o/v/orig.mov", "no MP4 yet: the original");
  assert.deepEqual(fileItems(null), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Who sees what in the admin (app/lib/staff-access.server.js) and the Peak
// Mode preview token (app/lib/peak-preview.server.js).
//
// Run: node scripts/eval-staff-access.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
const HOOK = `export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" && (spec.startsWith(".") || spec.startsWith("/")) && !/\\.[cm]?jsx?$/.test(spec)) return next(spec + ".js", ctx);
    throw e;
  }
}`;
register("data:text/javascript," + encodeURIComponent(HOOK));
const noop = new Proxy(async () => [], { get: (t, k) => (k === "then" ? undefined : noop), apply: async () => [] });
global.prismaGlobal = new Proxy({}, { get: () => noop });
process.env.DATABASE_URL ||= "postgresql://x@localhost:1/none";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.ENCRYPTION_KEY ||= "0".repeat(64);
process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_APP_URL ||= "https://example.com";
process.env.SCOPES ||= "read_products";

const { parseSupportStaff, staffAccess, supportRedirect } = await import("../app/lib/staff-access.server.js");
const { previewToken, validPreview, previewUrl } = await import("../app/lib/peak-preview.server.js");
const { peakHomeConfig } = await import("../app/lib/peak-home.js");

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); } };
const sess = (user) => ({ onlineAccessInfo: { associated_user: user } });

console.log("\nthe customer service team");
test("the list comes back clean: lowercased, real addresses only, no repeats, from JSON or lines", () => {
  assert.deepEqual(parseSupportStaff('["Support@Store.com", "nope", "support@store.com", "jamie@store.com"]'), ["support@store.com", "jamie@store.com"]);
  assert.deepEqual(parseSupportStaff("A@b.co\nbad\n c@d.io , e@f.org"), ["a@b.co", "c@d.io", "e@f.org"]);
  assert.deepEqual(parseSupportStaff(""), []); assert.deepEqual(parseSupportStaff(null), []);
});
test("access: listed staff see Recordings only; everyone else, and the owner even when listed, see everything", () => {
  const config = { supportStaff: '["jamie@store.com"]' };
  assert.equal(staffAccess(sess({ email: "Jamie@Store.com", account_owner: false }), config), "support");
  assert.equal(staffAccess(sess({ email: "jamie@store.com", account_owner: true }), config), "full");
  assert.equal(staffAccess(sess({ email: "sam@store.com", account_owner: false }), config), "full");
  assert.equal(staffAccess({}, config), "full", "no staff member known: not limited");
  assert.equal(staffAccess(sess({ email: "jamie@store.com" }), {}), "full", "nobody listed");
});

// Live store, 2026-11-04: the customer service team's first visit landed on
// "Your session expired" — the redirect to Recordings had dropped Shopify's
// embedded parameters, so the next request carried no session.
test("the redirect to Recordings keeps the embedded parameters: the admin context's redirect when there is one, else the query string", () => {
  const request = new Request("https://app.example.com/app?shop=s.myshopify.com&host=aG9zdA&embedded=1&id_token=abc");
  const plain = supportRedirect({}, request);
  assert.equal(plain.status, 302);
  assert.equal(plain.headers.get("Location"), "/app/recordings?shop=s.myshopify.com&host=aG9zdA&embedded=1&id_token=abc");
  let asked = "";
  const viaLibrary = supportRedirect({ redirect: (url) => { asked = url; return new Response(null, { status: 302, headers: { Location: `${url}?shop=s.myshopify.com&host=aG9zdA` } }); } }, request);
  assert.equal(asked, "/app/recordings");
  assert.match(viaLibrary.headers.get("Location"), /^\/app\/recordings\?shop=/);
  // A library redirect that throws (its embedded render) is left to throw.
  assert.throws(() => supportRedirect({ redirect: () => { throw new Response("app bridge", { status: 200 }); } }, request));
});

console.log("\nthe peak preview");
test("the token is the store's and the day's: good today and yesterday, not the day before, not another store's, not a forgery", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  const t = previewToken("s.myshopify.com", now);
  assert.match(t, /^[0-9a-f]{32}$/);
  assert.ok(validPreview("s.myshopify.com", t, now));
  assert.ok(validPreview("s.myshopify.com", t, new Date("2026-11-28T03:00:00Z")), "yesterday's still opens");
  assert.ok(!validPreview("s.myshopify.com", t, new Date("2026-11-29T12:00:00Z")));
  assert.ok(!validPreview("other.myshopify.com", t, now));
  assert.ok(!validPreview("s.myshopify.com", "0".repeat(32), now));
  assert.ok(!validPreview("s.myshopify.com", "", now));
  assert.equal(previewUrl("https://www.store.com/", "s.myshopify.com", now), `https://www.store.com/?ava_preview=${t}`);
  assert.equal(previewUrl("", "s.myshopify.com", now), `https://s.myshopify.com/?ava_preview=${t}`);
});
test("a valid preview hands the peak home over with Peak Mode off; without blocks there is nothing to show", () => {
  const saved = JSON.stringify({ blocks: [{ id: "b1", title: "Sale", image: "data:image/png;base64," + Buffer.from("png").toString("base64"), audience: "all" }] });
  assert.equal(peakHomeConfig({ peakMode: "off", peakHome: saved }), null);
  assert.equal(peakHomeConfig({ peakMode: "off", peakHome: saved }, new Date(), { force: true }).blocks.length, 1);
  assert.equal(peakHomeConfig({ peakMode: "off", peakHome: "{}" }, new Date(), { force: true }), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

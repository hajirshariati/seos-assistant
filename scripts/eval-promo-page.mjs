// The store's promotions page (Settings → Promotions page): only the part
// above the store's line is used, dates are given so ended offers aren't
// sold as running, and the page is read live but not on every chat.
//
// Run: node scripts/eval-promo-page.mjs

import assert from "node:assert/strict";
import { pageHandleFromUrl, cutPromoSection, promoPageBlock, nowForPromos } from "../app/lib/promo-page.js";
import { getPagePromos, clearPromoPageCache } from "../app/lib/promo-page.server.js";

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

// Aetrex's terms page as it read on Oct 24, 2026 (shortened legal part).
const STOP = "STANDARD TERMS AND CONDITIONS OF SALE";
const PAGE_HTML = `<h1>Terms and Conditions</h1>
<p>Zoey Boot Flash Sale ends on October 23rd, 2026 at 11:59 PM PT. Not combinable with other offers except loyalty program.</p>
<p>Free Gel Insert With Any Aetrex Orthotics Purchase: Valid until October 24th, 2026 11:59 PM EST. Receive one free gel insert (50780) with qualifying purchases of an Aetrex orthotic. Limit one per order, while supplies last.</p>
<p>Aetrex Referral Program: Give your friends $20 off their first order of $49.95+ and earn $20 in points for each successful referral.</p>
<p><strong>STANDARD TERMS AND CONDITIONS OF SALE</strong></p>
<p>Agreement. All sales of Goods by Aetrex to Customer are governed by and subject to these Terms.</p>
<p>Payment Terms. Full payment for all Goods is due in accordance with the terms.</p>`;
const PAGE_TEXT = "Terms and Conditions\nZoey Boot Flash Sale ends on October 23rd, 2026.\nFree Gel Insert With Any Aetrex Orthotics Purchase: Valid until October 24th, 2026.\nSTANDARD TERMS AND CONDITIONS OF SALE\nAgreement. All sales of Goods…";

console.log("\nthe page and the part that counts");
await test("the page's handle comes from its link", () => {
  assert.equal(pageHandleFromUrl("https://www.aetrex.com/pages/terms-conditions"), "terms-conditions");
  assert.equal(pageHandleFromUrl("https://www.aetrex.com/pages/terms-conditions?x=1#top"), "terms-conditions");
  assert.equal(pageHandleFromUrl("terms-conditions"), "terms-conditions");
  assert.equal(pageHandleFromUrl("https://www.aetrex.com/collections/sale"), "");
  assert.equal(pageHandleFromUrl(""), "");
});
await test("only the offers above the line are used, never the legal terms below", () => {
  const cut = cutPromoSection(PAGE_TEXT, STOP);
  assert.match(cut, /Zoey Boot Flash Sale/);
  assert.match(cut, /Free Gel Insert/);
  assert.doesNotMatch(cut, /Agreement|STANDARD TERMS/);
});
await test("the line is matched ignoring case and spacing, also mid-line", () => {
  assert.match(cutPromoSection(PAGE_TEXT, "standard  terms and conditions of sale"), /Free Gel Insert/);
  const split = PAGE_TEXT.replace("STANDARD TERMS AND", "STANDARD TERMS\nAND");
  assert.match(cutPromoSection(split, STOP), /Free Gel Insert/);
  assert.doesNotMatch(cutPromoSection(split, STOP), /Agreement/);
  const oneLine = PAGE_TEXT.replace(/\n/g, " ");
  const cut = cutPromoSection(oneLine, STOP);
  assert.match(cut, /Free Gel Insert/);
  assert.doesNotMatch(cut, /Agreement/);
});
await test("no line set, or the line isn't on the page: nothing is used (never the whole legal page)", () => {
  assert.equal(cutPromoSection(PAGE_TEXT, ""), "");
  assert.equal(cutPromoSection(PAGE_TEXT, "SOME OTHER HEADING"), "");
  assert.equal(cutPromoSection("", STOP), "");
});

console.log("\nwhat the assistant is told");
await test("the block gives today's date and time (Eastern and Pacific) and the ended-offer rule", () => {
  const now = new Date("2026-10-24T15:00:00Z");
  const block = promoPageBlock({ text: cutPromoSection(PAGE_TEXT, STOP), url: "https://www.aetrex.com/pages/terms-conditions", now });
  assert.match(block, /PROMOTIONS FROM THE STORE'S PROMOTIONS PAGE \(https:\/\/www\.aetrex\.com\/pages\/terms-conditions\)/);
  assert.match(block, /Right now it's Sat, Oct 24, 2026, 11:00 AM Eastern \(Sat, Oct 24, 2026, 8:00 AM Pacific\)/);
  assert.match(block, /running unless its own text says it has ended or its end date and time have passed/);
  assert.match(block, /If two lines disagree/);
  assert.match(block, /Zoey Boot Flash Sale/);
  assert.equal(promoPageBlock({ text: "" }), "");
  assert.match(nowForPromos(now), /Eastern .* Pacific/);
});

console.log("\nreading the page live");
const fakeFetch = (handlers) => {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push(String(url));
    for (const [match, respond] of handlers) if (String(url).includes(match)) return respond(opts);
    return { ok: false, status: 404 };
  };
  f.calls = calls;
  return f;
};
const adminOk = () => ({ ok: true, json: async () => ({ data: { pages: { nodes: [{ handle: "terms-conditions", body: PAGE_HTML }] } } }) });
await test("read through Shopify's Admin API, cut at the line", async () => {
  clearPromoPageCache();
  const f = fakeFetch([["/admin/api/", adminOk]]);
  const text = await getPagePromos({ shop: "s.myshopify.com", accessToken: "t", url: "https://www.aetrex.com/pages/terms-conditions", stopLine: STOP, fetchImpl: f, now: 1000 });
  assert.match(text, /Free Gel Insert/);
  assert.doesNotMatch(text, /Agreement/);
  assert.equal(f.calls.length, 1);
});
await test("kept for 15 minutes, then read again", async () => {
  clearPromoPageCache();
  const f = fakeFetch([["/admin/api/", adminOk]]);
  const args = { shop: "s.myshopify.com", accessToken: "t", url: "https://www.aetrex.com/pages/terms-conditions", stopLine: STOP, fetchImpl: f };
  await getPagePromos({ ...args, now: 0 });
  await getPagePromos({ ...args, now: 14 * 60 * 1000 });
  assert.equal(f.calls.length, 1, "no second read within 15 minutes");
  await getPagePromos({ ...args, now: 16 * 60 * 1000 });
  assert.equal(f.calls.length, 2);
});
await test("Admin API unavailable → the public page is read instead", async () => {
  clearPromoPageCache();
  const f = fakeFetch([["/admin/api/", () => ({ ok: false, status: 403 })], ["aetrex.com/pages/", () => ({ ok: true, text: async () => `<html><body><main>${PAGE_HTML}</main></body></html>` })]]);
  const text = await getPagePromos({ shop: "s.myshopify.com", accessToken: "t", url: "https://www.aetrex.com/pages/terms-conditions", stopLine: STOP, fetchImpl: f, now: 0 });
  assert.match(text, /Free Gel Insert/);
});
await test("a failed read keeps the last good copy; nothing set → nothing read", async () => {
  clearPromoPageCache();
  let up = true;
  const f = fakeFetch([["/admin/api/", () => (up ? adminOk() : { ok: false, status: 500 })], ["aetrex.com/pages/", () => ({ ok: false, status: 500 })]]);
  const args = { shop: "s.myshopify.com", accessToken: "t", url: "https://www.aetrex.com/pages/terms-conditions", stopLine: STOP, fetchImpl: f };
  await getPagePromos({ ...args, now: 0 });
  up = false;
  assert.match(await getPagePromos({ ...args, now: 20 * 60 * 1000 }), /Free Gel Insert/);
  const none = fakeFetch([]);
  assert.equal(await getPagePromos({ shop: "s", accessToken: "t", url: "", stopLine: STOP, fetchImpl: none }), "");
  assert.equal(await getPagePromos({ shop: "s", accessToken: "t", url: "https://x.com/pages/a", stopLine: "", fetchImpl: none }), "");
  assert.equal(none.calls.length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

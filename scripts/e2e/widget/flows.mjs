// Widget browser flows: cards, Add to cart (inline size picker, sold out,
// errors), checkout links, showcase/horizontal styles, FITFinder bridge,
// mobile layouts. Run: node scripts/e2e/widget/flows.mjs
import os from "node:os";
import { chromium } from "playwright";
const { start, cartLog, chatBodies, fitSaves } = await import("./mock-store.mjs");
const { srv, PRODUCTS } = await start(4789);
const out = (n) => `${process.env.E2E_SHOTS || os.tmpdir()}/widget-${n}.png`;
const browser = await chromium.launch();
const results = [];
const check = (name, ok, extra = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); };
const vidFor = (h, s, w) => PRODUCTS[h].variants.find((v) => v.option1 === s && v.option2 === w).id;

async function session(path, viewport, label, nCards = 3) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:4789${path}`);
  await page.click(".ai-chat-launcher");
  await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", `show me ${nCards}`);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ai-chat-product-card [data-atc]", { timeout: 8000 });
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}

// 1) Desktop showcase, 3 cards
{
  const { ctx, page, errors } = await session("/showcase", { width: 1280, height: 860 }, "desk");
  await page.screenshot({ path: out("1-desktop-cards") });
  const btns = await page.$$eval(".ai-chat-product-card", (cs) => cs.map((c) => ({ atc: !!c.querySelector("button[data-atc]"), view: c.querySelector(".ai-chat-view-link")?.textContent, variant: c.querySelector(".ai-chat-product-variant")?.textContent || "" })));
  check("every card has Add to cart + View product link", btns.every((b) => b.atc && b.view === "View product"));
  const clipped = await page.$$eval(".ai-chat-product-card", (cs) => cs.filter((c) => { const cr = c.getBoundingClientRect(); return [...c.querySelectorAll("[data-atc], .ai-chat-view-link")].some((b) => { const r = b.getBoundingClientRect(); return r.right > cr.right + 0.5 || r.left < cr.left - 0.5; }); }).length);
  check("buttons and links fit inside every card", clipped === 0, `${clipped} card(s) clipped`);
  check("card with known size shows it", btns[0].variant === "8 US · Medium", btns[0].variant);
  // Preselected card → one tap adds exact variant
  const before = cartLog.length;
  await page.click('.ai-chat-product-card[data-handle="savannah-red"] [data-atc]');
  await page.waitForSelector(".ai-chat-atc-done", { timeout: 5000 });
  check("one-tap add uses the exact preselected variant", cartLog.length === before + 1 && cartLog.at(-1) === vidFor("savannah-red", "8 US", "Medium"), String(cartLog.at(-1)));
  await page.waitForTimeout(300);
  const ck = await page.$eval(".ai-chat-atc-primary", (a) => { const cs = getComputedStyle(a); return cs.color + "|" + cs.backgroundColor + "|" + cs.textDecorationLine; });
  check("Checkout is white text on the button color, no underline", ck === "rgb(255, 255, 255)|rgb(13, 13, 18)|none", ck);
  const vl = await page.$eval(".ai-chat-view-link", (a) => getComputedStyle(a).textDecorationLine);
  check("View product is underlined", vl === "underline", vl);
  const tl = await page.$eval("a.ai-chat-product-title", (a) => getComputedStyle(a).textDecorationLine);
  check("title link is not underlined", tl === "none", tl);
  await page.screenshot({ path: out("2-desktop-added") });
  // Card without size → picker
  await page.click('.ai-chat-product-card[data-handle="jillian-black"] [data-atc]');
  await page.waitForSelector(".ai-chat-atc-val");
  check("only one picker open at a time", (await page.$$(".ai-chat-atc-panel")).length === 1);
  const addDisabled = await page.$eval("[data-atc-add]", (b) => b.disabled && b.textContent);
  check("Add is disabled until size and width are chosen", !!addDisabled, addDisabled);
  await page.waitForTimeout(300);
  await page.screenshot({ path: out("3-desktop-picker") });
  await page.click('.ai-chat-atc-val[data-opt="Size"][data-val="9 US"]');
  await page.click('.ai-chat-atc-val[data-opt="Width"][data-val="Wide"]');
  const label = await page.$eval("[data-atc-add]", (b) => b.textContent);
  check("Add button shows the price once complete", label.includes("$119.95"), label);
  await page.click("[data-atc-add]");
  await page.waitForSelector(".ai-chat-atc-done");
  check("picker adds the chosen variant", cartLog.at(-1) === vidFor("jillian-black", "9 US", "Wide"));
  check("Checkout and View cart links", (await page.$$eval(".ai-chat-atc-actions a", (as) => as.map((a) => a.getAttribute("href")))).join(",") === "/checkout,/cart");
  // Single-variant product → direct add
  await page.click('.ai-chat-product-card[data-handle="orthotic-one"] [data-atc]');
  await page.waitForFunction(() => /Orthotics/.test(document.querySelector(".ai-chat-atc-panel .ai-chat-atc-title")?.textContent || "") && document.querySelector(".ai-chat-atc-panel .ai-chat-atc-done"));
  check("product with no options adds in one tap", cartLog.at(-1) === 5555);
  check("cart count in the theme header updated", (await page.textContent(".cart-count")) === String(cartLog.length));
  check("no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// 2) Sold-out handling: Savannah 8 Wide / 9 Medium / 9 Wide sold out
{
  const { ctx, page, errors } = await session("/showcase", { width: 1280, height: 860 }, "soldout");
  await page.evaluate(() => { const c = document.querySelector('.ai-chat-product-card[data-handle="savannah-red"]'); c.setAttribute("data-preselect", JSON.stringify({ Size: "8 US", Width: "Wide" })); });
  const before = cartLog.length;
  await page.click('.ai-chat-product-card[data-handle="savannah-red"] [data-atc]');
  await page.waitForSelector(".ai-chat-atc-val");
  const note = await page.textContent(".ai-chat-atc-note");
  check("known size sold out → never added, picker explains", cartLog.length === before && /sold out/i.test(note), note);
  const size9 = await page.$eval('.ai-chat-atc-val[data-opt="Size"][data-val="9 US"]', (b) => b.classList.contains("is-out") && b.getAttribute("aria-disabled"));
  check("a size sold out in every width is disabled", size9 === "true");
  await page.click('.ai-chat-atc-val[data-opt="Size"][data-val="8 US"]');
  const outs = await page.$$eval('.ai-chat-atc-val[data-opt="Width"].is-out', (b) => b.map((x) => x.dataset.val));
  check("widths sold out in the chosen size are disabled", outs.join(",") === "Wide", outs.join(","));
  await page.waitForTimeout(300);
  await page.screenshot({ path: out("4-soldout") });
  await page.$eval('.ai-chat-atc-val[data-opt="Width"][data-val="Wide"]', (b) => b.click());
  check("tapping a sold-out value does nothing", (await page.$$('.ai-chat-atc-val.is-on[data-opt="Width"]')).length === 0);
  await page.click('.ai-chat-atc-val[data-opt="Width"][data-val="Medium"]');
  await page.click("[data-atc-add]");
  await page.waitForSelector(".ai-chat-atc-done");
  check("then adds the available combination", cartLog.at(-1) === vidFor("savannah-red", "8 US", "Medium"));
  check("no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// 3) Mobile, single card and multi-card; horizontal layout
for (const [path, vp, n, name] of [["/showcase", { width: 390, height: 844 }, 1, "5-mobile-single"], ["/showcase", { width: 390, height: 844 }, 3, "6-mobile-multi"], ["/horizontal", { width: 1280, height: 860 }, 2, "7-horizontal"]]) {
  const { ctx, page, errors } = await session(path, vp, name, n);
  await page.screenshot({ path: out(name) });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  const visible = await page.$$eval("[data-atc]", (bs) => bs.every((b) => { const r = b.getBoundingClientRect(); return r.width > 40 && r.height >= 34; }));
  check(`${name}: Add to cart visible & tappable`, visible);
  const clip2 = await page.$$eval(".ai-chat-product-card", (cs) => cs.filter((c) => { const cr = c.getBoundingClientRect(); return [...c.querySelectorAll("[data-atc], .ai-chat-view-link")].some((b) => { const r = b.getBoundingClientRect(); return r.right > cr.right + 0.5 || r.left < cr.left - 0.5; }); }).length);
  check(`${name}: nothing clipped in cards`, clip2 === 0, String(clip2));
  check(`${name}: no horizontal page overflow`, !overflow);
  if (n === 1) {
    const fits = await page.$eval(".ai-chat-product-card", (c) => { const w = c.closest(".ai-chat-products-wrap").getBoundingClientRect(), r = c.getBoundingClientRect(); return r.left >= w.left - 0.5 && r.right <= w.right + 0.5; });
    check(`${name}: single card fits inside the message`, fits);
  }
  if (name === "6-mobile-multi") {
    await page.click('.ai-chat-product-card[data-handle="jillian-black"] [data-atc]');
    await page.waitForSelector(".ai-chat-atc-val");
    await page.waitForTimeout(300);
    await page.screenshot({ path: out("8-mobile-picker") });
    const pw = await page.$eval(".ai-chat-atc-panel", (p) => p.getBoundingClientRect().width);
    check("mobile picker fits the chat width", pw <= vp.width && pw > 250, String(pw));
  }
  check(`${name}: no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// 4) FITFinder: the store's FITs go with each message; a FIT found in chat is saved back
{
  const { ctx, page, errors } = await session("/showcase", { width: 1280, height: 860 }, "ff", 1);
  const last = chatBodies.at(-1);
  check("FITFinder FITs are sent with the message", last?.fitfinder?.fits?.length === 4 && last.fitfinder.questions?.[0]?.text === "Do you have flat feet?", JSON.stringify(last?.fitfinder || null).slice(0, 120));
  check("See It Styled is a real button under Add to cart, same width", await page.$eval(".ai-chat-viz-btn", (b) => { const a = b.closest(".ai-chat-viz-actions").querySelector("[data-atc]"); return b.tagName === "BUTTON" && b.getBoundingClientRect().top > a.getBoundingClientRect().top && Math.abs(b.offsetWidth - a.offsetWidth) < 2; }));
  await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "what fit am i? flat feet and ball of foot pain");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /FIT D/.test(document.body.innerText));
  await page.waitForTimeout(300);
  const stored = await page.evaluate(() => sessionStorage.getItem("fitfinder_fit"));
  check("a FIT found in chat is saved where FITFinder reads it", JSON.parse(stored || "{}").key === "D" && JSON.parse(stored).code === "25", stored);
  check("…and to the logged-in shopper's profile", fitSaves.at(-1)?.fitKey === "D");
  await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "show me 1");
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll(".ai-chat-product-card").length >= n, 2);
  check("the next message carries the saved FIT", chatBodies.at(-1)?.fitfinder?.saved?.key === "D");
  check("ff: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// True Fit: the shopper asks about size, taps the button, True Fit opens
// with the chat out of the way, and its size comes back into the chat.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const ask = async (text) => {
    await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", text);
    await page.keyboard.press("Enter");
  };
  await page.goto("http://localhost:4789/products/jillian-black");
  await page.waitForTimeout(400);
  await page.click(".ai-chat-launcher");
  await ask("what size should I get?");
  await page.waitForSelector("[data-truefit]");
  check("tf: the message tells the server True Fit is on this shoe's page", chatBodies.at(-1)?.size_finder?.provider === "truefit" && chatBodies.at(-1)?.size_finder?.page_handle === "jillian-black", JSON.stringify(chatBodies.at(-1)?.size_finder));
  check("tf: a Find my size with True Fit button is shown", /Find my size with True Fit/.test(await page.textContent("[data-truefit]")));
  const sent = chatBodies.length;
  await page.click("[data-truefit]");
  await page.waitForFunction(() => window.__tfOpens === 1, null, { timeout: 5000 });
  await page.waitForFunction(() => document.body.classList.contains("tfc-show-modal"), null, { timeout: 5000 });
  check("tf: True Fit opens with the chat out of the way", (await page.evaluate(() => window.__tfChatOpenDuringFinder)) === 0);
  await page.waitForFunction((n) => window.__chatSent > n || document.querySelectorAll(".ai-chat-msg--user").length >= 2, sent, { timeout: 8000 }).catch(() => {});
  await page.waitForSelector(".ai-chat-panel.open", { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll(".ai-chat-product-card").length >= 1, null, { timeout: 8000 });
  check("tf: after True Fit closes, the chat comes back with the shopper's size", /^True Fit recommends size 9 - 9\.5 US for me in the Jillian Sandal\.$/.test(chatBodies.at(-1)?.message || ""), chatBodies.at(-1)?.message);
  check("tf: the shoe comes back ready in that size", /9 US/.test(await page.textContent(".ai-chat-product-card")));

  // From another page: the button opens the shoe's page and True Fit starts there.
  await page.goto("http://localhost:4789/full");
  await page.waitForTimeout(400);
  await page.click(".ai-chat-launcher");
  await ask("what size in the Jillian?");
  await page.waitForSelector(".ai-chat-msg--assistant:last-child [data-truefit]");
  check("tf: on other pages the site is remembered as having True Fit", chatBodies.at(-1)?.size_finder?.page_handle === "", JSON.stringify(chatBodies.at(-1)?.size_finder));
  await Promise.all([page.waitForURL(/\/products\/jillian-black$/), page.click(".ai-chat-msg--assistant:last-child [data-truefit]")]);
  await page.waitForFunction(() => window.__tfOpens === 1, null, { timeout: 8000 });
  await page.waitForSelector(".ai-chat-panel.open", { timeout: 10000 });
  await page.waitForFunction(() => /^True Fit recommends/.test([...document.querySelectorAll(".ai-chat-msg--user")].at(-1)?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
  check("tf: …and the size comes back into the same conversation", /^True Fit recommends size 9 - 9\.5 US/.test(chatBodies.at(-1)?.message || "") && chatBodies.at(-1)?.history?.some((h) => /what size in the Jillian/.test(h.content)), chatBodies.at(-1)?.message);

  // No True Fit data for a style: the theme's size chart opens, the chat stays out of the way.
  await page.goto("http://localhost:4789/products/jillian-black?tf=none");
  await page.waitForTimeout(400);
  await page.click(".ai-chat-launcher");
  await ask("what size should I get?");
  await page.waitForSelector(".ai-chat-msg--assistant:last-child [data-truefit]");
  const before = chatBodies.length;
  await page.click(".ai-chat-msg--assistant:last-child [data-truefit]");
  await page.waitForTimeout(1500);
  check("tf: no True Fit data → the size chart shows, no message is sent", (await page.isVisible("#size-chart")) && chatBodies.length === before && !(await page.isVisible(".ai-chat-panel.open")));

  // A page without True Fit (and the store setting off) never offers it.
  await page.evaluate(() => { try { localStorage.removeItem("hajirai_tf_site"); } catch { /* */ } });
  await page.goto("http://localhost:4789/products/orthotic-one");
  await page.waitForTimeout(400);
  await page.click(".ai-chat-launcher");
  await ask("show me 1");
  await page.waitForFunction(() => document.querySelectorAll(".ai-chat-product-card").length >= 1, null, { timeout: 5000 });
  check("tf: without True Fit nothing is sent about it", !chatBodies.at(-1)?.size_finder);
  check("tf: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// The two fit tools: featured on the welcome screen, and each only on the
// products it belongs to — True Fit on shoes, FITFinder on orthotics.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/products/jillian-black");
  await page.waitForTimeout(300);
  await page.click(".ai-chat-launcher");
  await page.waitForSelector('[data-helper="fitfinder"]', { timeout: 5000 });
  const tools = await page.$$eval(".ai-chat-welcome__helpers [data-helper]", (b) => b.map((x) => `${x.dataset.helper}:${x.querySelector(".ai-chat-helper__title").textContent}`));
  check("tools: welcome features True Fit and FITFinder", tools.join("|") === "truefit:Size for this shoe|fitfinder:Find my orthotic FIT", tools.join("|"));
  await page.fill(".ai-chat-input-area textarea", "show me 3");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".ai-chat-product-card").length >= 3);
  const perCard = await page.$$eval(".ai-chat-product-card", (cs) => cs.map((c) => {
    const h = c.querySelector(".ai-chat-card-fit");
    return `${c.dataset.handle}:${h ? (h.dataset.truefit ? "truefit" : h.dataset.helper) : "-"}`;
  }));
  check("tools: shoes offer True Fit only, orthotics FITFinder only", perCard.join("|") === "savannah-red:truefit|jillian-black:truefit|orthotic-one:fitfinder", perCard.join("|"));
  await page.click('.ai-chat-product-card[data-handle="orthotic-one"] [data-helper="fitfinder"]');
  await page.waitForFunction(() => document.querySelector(".ai-chat-fit-result"), null, { timeout: 5000 }).catch(() => {});
  check("tools: Find my FIT starts the FIT questions", /orthotic FIT/i.test(chatBodies.at(-1)?.message || ""), chatBodies.at(-1)?.message);
  check("tools: the FIT found is shown as a FIT card", /FIT D/.test(await page.textContent(".ai-chat-fit-result").catch(() => "")));
  check("tools: once a FIT is saved, cards stop offering to find one", (await page.$$('[data-helper="fitfinder"].ai-chat-card-fit')).length === 0);
  check("tools: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
await browser.close();
srv.close();
console.log(results.join("\n"));
const failedCount = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failedCount} passed, ${failedCount} failed`);
if (failedCount) process.exit(1);

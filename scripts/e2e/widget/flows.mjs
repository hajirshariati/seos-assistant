// Widget browser flows: cards, Add to cart (inline size picker, sold out,
// errors), checkout links, showcase/horizontal styles, FITFinder bridge,
// mobile layouts. Run: node scripts/e2e/widget/flows.mjs
import os from "node:os";
import { chromium } from "playwright";
const { start, cartLog, chatBodies, fitSaves, returnBodies, startedReturns, mockCtl, compareLog, feedbackBodies, viewAllLog } = await import("./mock-store.mjs");
const { srv, PRODUCTS } = await start(4789);
const out = (n) => `${process.env.E2E_SHOTS || os.tmpdir()}/widget-${n}.png`;
const browser = await chromium.launch();
const results = [];
const check = (name, ok, extra = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); };
const vidFor = (h, s, w) => PRODUCTS[h].variants.find((v) => v.option1 === s && v.option2 === w).id;
const waitUntil = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return fn(); };

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
  const ck = await page.$eval(".ai-chat-atc-primary", (a) => { const cs = getComputedStyle(a); return a.closest(".ai-chat-panel").getAttribute("data-theme") + "|" + cs.color + "|" + cs.backgroundColor + "|" + cs.textDecorationLine; });
  // Light: white on ink. Dark (the default): charcoal on the light ink.
  check("Checkout is clear text on the button color, no underline", ck === "light|rgb(255, 255, 255)|rgb(13, 13, 18)|none" || ck === "dark|rgb(13, 13, 18)|rgb(245, 245, 247)|none", ck);
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
  check("tools: welcome features True Fit and FITFinder", tools.join("|") === "truefit:Find my size|fitfinder:Find my orthotic FIT", tools.join("|"));
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
// When the fit tools already know the shopper: the cards say so, and tapping
// them uses what's known instead of asking again.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const helperTitles = () => page.$$eval(".ai-chat-welcome__helpers .ai-chat-helper", (b) => b.map((x) => `${x.querySelector(".ai-chat-helper__title").textContent} / ${x.querySelector(".ai-chat-helper__sub").textContent}`));
  await page.goto("http://localhost:4789/products/jillian-black?tf=known");
  await page.click(".ai-chat-launcher");
  await page.waitForFunction(() => /Size 9/.test(document.querySelector(".ai-chat-helper--truefit")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  const known = await helperTitles();
  check("known: True Fit's size shows on the welcome card", known[0] === "Size 9 - 9.5 US / Your True Fit size", known.join(" | "));
  check("known: with a small Update action", (await page.textContent('.ai-chat-helper__alt[data-helper="truefit-update"]').catch(() => "")) === "Update");
  await page.click(".ai-chat-helper--truefit");
  await page.waitForFunction(() => document.querySelectorAll(".ai-chat-product-card").length >= 1, null, { timeout: 5000 }).catch(() => {});
  check("known: tapping it shops that size — no second quiz", /^True Fit recommends size 9 - 9\.5 US for me in the /.test(chatBodies.at(-1)?.message || "") && !(await page.evaluate(() => window.__tfOpens)), chatBodies.at(-1)?.message);

  // A saved FIT: the card shops it, Retake asks the questions again.
  await page.evaluate(() => { sessionStorage.setItem("fitfinder_fit", JSON.stringify({ key: "B", label: "FIT B", code: "00" })); localStorage.removeItem("hajirai_chat_history"); });
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher");
  await page.waitForSelector(".ai-chat-helper--fitfinder.is-known", { timeout: 5000 }).catch(() => {});
  const fitCards = await helperTitles();
  check("known: the saved FIT shows on its card", fitCards.includes("Cushioned Support / Your FIT B"), fitCards.join(" | "));
  check("known: True Fit off a shoe page remembers the shopper", fitCards.includes("Find my shoe size / True Fit knows your fit"), fitCards.join(" | "));
  await page.click('.ai-chat-helper__alt[data-helper="fitfinder-retake"]');
  await page.waitForTimeout(600);
  check("known: Retake asks the FIT questions again", /retake my orthotic FIT/.test(chatBodies.at(-1)?.message || "") && chatBodies.at(-1)?.fitfinder?.saved?.key === "", JSON.stringify(chatBodies.at(-1)?.fitfinder?.saved));

  // Menu, signed out: new chat + log in (back to this page).
  await page.click(".ai-chat-menu-btn");
  const outItems = await page.$$eval(".ai-chat-menu .ai-chat-menu-item", (b) => b.map((x) => x.textContent));
  check("menu (guest): new chat, retake FIT, log in", outItems.join("|") === "Start a new chat|Retake my orthotic FIT|Log in", outItems.join("|"));
  check("header: Log in returns to this page", /\/account\/login\?return_url=%2Ffull/.test(await page.getAttribute(".ai-chat-header__login-pill", "href")) && (await page.textContent(".ai-chat-header__login-pill")) === "Log in");
  await page.keyboard.press("Escape");

  // Signed in: the menu says who, and Log out takes their chat with it.
  await page.goto("http://localhost:4789/full?login=Dana");
  await page.click(".ai-chat-launcher");
  await page.fill(".ai-chat-input-area textarea", "show me 1");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".ai-chat-product-card").length >= 1, null, { timeout: 5000 });
  await page.click(".ai-chat-menu-btn");
  const inMenu = await page.textContent(".ai-chat-menu");
  check("menu (signed in): says who and offers Log out", /Signed in as Dana/.test(inMenu) && /Log out/.test(inMenu) && !/Log in/.test(inMenu), inMenu);
  await Promise.all([page.waitForURL(/\/account\/logout$/), page.click('.ai-chat-menu-item[data-action="logout"]')]);
  const left = await page.evaluate(() => ({ h: localStorage.getItem("hajirai_chat_history"), o: localStorage.getItem("hajirai_chat_owner") }));
  check("logout: the customer's chat is cleared from this device", !left.h && left.o === "guest", JSON.stringify(left));

  // Signed out elsewhere (session expired, another tab): the next visit starts fresh too.
  await page.goto("http://localhost:4789/full?login=Dana");
  await page.click(".ai-chat-launcher");
  await page.fill(".ai-chat-input-area textarea", "show me 1");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".ai-chat-product-card").length >= 1, null, { timeout: 5000 });
  await page.goto("http://localhost:4789/full");
  check("signed out elsewhere: their chat doesn't show to the next person", (await page.evaluate(() => localStorage.getItem("hajirai_chat_history"))) === null);
  // A guest who signs in keeps the chat they were having.
  await page.click(".ai-chat-launcher");
  await page.fill(".ai-chat-input-area textarea", "show me 1");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".ai-chat-product-card").length >= 1, null, { timeout: 5000 });
  await page.goto("http://localhost:4789/full?login=Dana");
  check("guest → signed in: the chat carries on", !!(await page.evaluate(() => localStorage.getItem("hajirai_chat_history"))));
  check("known/menu: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// Phones: Safari's bar above the keyboard is see-through and shows the page's
// own background. While the chat is open the page takes the chat's color
// (and Safari's theme color), following a theme switch; on close it's all
// exactly as it was.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto("http://localhost:4789/full");
  await page.evaluate(() => { document.body.style.backgroundColor = "rgb(250, 250, 250)"; const m = document.createElement("meta"); m.name = "theme-color"; m.content = "#ffffff"; document.head.appendChild(m); });
  const look = () => page.evaluate(() => { const p = document.querySelector(".ai-chat-panel"); return { panel: getComputedStyle(p).backgroundColor, html: getComputedStyle(document.documentElement).backgroundColor, body: getComputedStyle(document.body).backgroundColor, meta: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content).join("|"), bodyInline: document.body.style.backgroundColor, htmlInline: document.documentElement.style.backgroundColor }; });
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(700);
  const open = await look();
  check("phone keyboard bar: the page behind takes the chat's color while open", open.html === open.panel && open.body === open.panel && open.meta === open.panel, JSON.stringify(open));
  await page.click(".ai-chat-theme-btn");
  await page.waitForTimeout(700);
  const flipped = await look();
  check("phone keyboard bar: it follows a switch to the other theme", flipped.panel !== open.panel && flipped.html === flipped.panel && flipped.meta === flipped.panel, JSON.stringify(flipped));
  await page.click(".ai-chat-theme-btn");
  await page.click(".ai-chat-close-btn");
  await page.waitForTimeout(600);
  const closed = await look();
  check("phone keyboard bar: closing puts the page's own colors back", closed.bodyInline === "rgb(250, 250, 250)" && closed.htmlInline === "" && closed.meta === "#ffffff", JSON.stringify(closed));
  await ctx.close();
}
// The page behind the open chat can't be reached (on iPhone the keyboard
// bar's arrows would jump to the site's search box), and a store can pick
// each Start-here icon.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher");
  await page.waitForSelector(".ai-chat-panel.open");
  check("open chat: the page behind is unreachable", await page.evaluate(() => !!document.getElementById("site-search").closest("[inert]")));
  check("open chat: the chat itself stays usable", await page.evaluate(() => !document.querySelector(".ai-chat-input").closest("[inert]")));
  check("avatar: on the home screen it's beside the greeting, not in the header", await page.evaluate(() => !!document.querySelector(".ai-chat-welcome__avatar") && !document.querySelector(".ai-chat-header img, .ai-chat-header__avatar")));
  check("icons: a store-picked icon replaces the automatic one", await page.evaluate(() => /M12 20s/.test(document.querySelector(".ai-chat-welcome__cta-icon").innerHTML)));
  await page.fill(".ai-chat-input-area textarea", "show me 1");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);
  check("avatar: once the chat starts the header shows the name only, no avatar", await page.evaluate(() => !document.querySelector(".ai-chat-header img, .ai-chat-header__avatar") && document.querySelector(".ai-chat-header__name").getBoundingClientRect().width > 30));
  await page.click(".ai-chat-close-btn");
  await page.waitForTimeout(300);
  check("closed chat: the page is reachable again", await page.evaluate(() => !document.getElementById("site-search").closest("[inert]")));
  check("inert: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// Aetrex-style theme cart: after an add in the chat, the header and dock
// counts and the (closed) cart drawer show the item without a page refresh,
// the drawer stays closed and the chat keeps focus.
{
  const { ctx, page, errors } = await session("/aetrex", { width: 1280, height: 860 }, "aetrex", 1);
  await page.focus(".ai-chat-input");
  await page.click('.ai-chat-product-card[data-handle="savannah-red"] [data-atc]');
  await page.waitForSelector(".ai-chat-atc-done", { timeout: 5000 });
  await page.waitForFunction(() => window.__published.length > 0 || document.getElementById("hdr-count").textContent !== "0", null, { timeout: 4000 }).catch(() => {});
  const st = await page.evaluate(() => ({
    hdr: document.getElementById("hdr-count").textContent, hdrHidden: document.getElementById("hdr-count").hidden,
    dock: document.getElementById("dock-count").textContent, drawer: document.getElementById("MiniCart-cart-drawer").textContent,
    drawerHidden: document.getElementById("CartDrawer").hidden, pub: window.__published.map((p) => p.source + ":" + Object.keys(p.cart.sections || {}).join(",")),
    errs: window.__cartErrors, inChat: !!document.activeElement.closest(".ai-chat-panel"),
  }));
  const n = String(cartLog.length);
  check("theme cart: header and dock counts update without a refresh", st.hdr === n && st.dock === n && !st.hdrHidden, JSON.stringify(st));
  check("theme cart: the closed drawer already holds the new item", st.drawer.includes(`${n} item(s)`), st.drawer);
  check("theme cart: published like the theme's own add, with the drawer's HTML", st.pub.join("|") === "chat-widget:cart-drawer", st.pub.join("|"));
  check("theme cart: the drawer stays closed and the chat keeps focus", st.drawerHidden && st.inChat);
  check("theme cart: no theme errors, no JS errors", st.errs.length === 0 && errors.length === 0, [...st.errs, ...errors].join(" | "));
  await ctx.close();
}
// Orders & returns. Signed out: a sign-in card; Shopify's sign-in opens in a
// small window and the chat carries on with the orders. Then a return with
// an exchange: items → reason → "Exchange for a bigger size" → the return is
// started and the same shoe comes back in the next size, ready to add.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(500);
  await page.fill(".ai-chat-input-area textarea", "where is my order?");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ai-ord--signin", { timeout: 6000 });
  check("orders signed out: a sign-in card, no order details", (await page.$$(".ai-ord[data-ord]")).length === 0);
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.click("[data-ord-login]")]);
  await popup.waitForEvent("close", { timeout: 8000 }).catch(() => {});
  check("orders: Shopify's sign-in opens in a small window that closes itself", popup.isClosed());
  await page.waitForSelector(".ai-ord[data-ord]", { timeout: 8000 });
  const cardsInfo = await page.evaluate(() => [...document.querySelectorAll(".ai-ord[data-ord]")].map((c) => ({
    num: c.querySelector(".ai-ord__num").textContent, pill: c.querySelector(".ai-ord__pill").textContent,
    done: c.querySelectorAll(".ai-ord__steps li.is-done").length, when: c.querySelector(".ai-ord__when")?.textContent || "",
    track: c.querySelector("a.ai-ord__btn")?.getAttribute("href") || "", ret: !!c.querySelector("[data-ord-return]"),
  })));
  check("orders: after sign-in the chat picks up with the order cards", cardsInfo.length === 2 && page.url().endsWith("/full"), JSON.stringify(cardsInfo));
  check("orders: status, progress, delivery line and tracking on each card", cardsInfo[0].pill === "Delivered" && cardsInfo[0].done === 4 && /Delivered/.test(cardsInfo[0].when) && cardsInfo[0].track === "https://track.example/1Z999" && cardsInfo[1].pill === "On its way" && cardsInfo[1].done === 2 && /Arrives by/.test(cardsInfo[1].when), JSON.stringify(cardsInfo));
  check("orders: only a shipped order offers a return", cardsInfo[0].ret && !cardsInfo[1].ret);
  await page.screenshot({ path: out("orders-cards") });
  // Return → exchange
  await page.click('.ai-ord[data-ord="5001"] [data-ord-return]');
  const next = '.ai-ord[data-ord="5001"] [data-ret-next="reason"]';
  await page.waitForSelector(next, { timeout: 6000 });
  check("return: Next waits until an item is picked", await page.$eval(next, (b) => b.disabled));
  // Tapping inside the return must not jump the chat to the bottom.
  const before = await page.evaluate(() => { const m = document.querySelector(".ai-chat-messages"); const c = document.querySelector('.ai-ord[data-ord="5001"]'); m.scrollTo({ top: m.scrollTop + c.getBoundingClientRect().top - m.getBoundingClientRect().top, behavior: "instant" }); return { top: m.scrollTop, room: m.scrollHeight - m.clientHeight - m.scrollTop }; });
  await page.click('[data-ret-item="9001"]');
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => document.querySelector(".ai-chat-messages").scrollTop);
  check("return: tapping an item keeps the chat where it is (no jump to the bottom)", before.room > 60 && after < before.top + before.room - 40, JSON.stringify({ before, after }));
  await page.click(next);
  await page.click('[data-ret-reason="too_small"]');
  await page.waitForSelector('.ai-ord[data-ord="5001"] .ai-ret__method');
  const methods = await page.$$eval('.ai-ord[data-ord="5001"] .ai-ret__method', (bs) => bs.map((b) => b.querySelector(".ai-ret__mlabel").textContent + "|" + b.getAttribute("aria-checked")));
  check("return: asks how to send it back, first option picked", methods.length === 2 && methods[0] === "Drop off at any Happy Returns location|true", methods.join(" / "));
  check("return: Happy Returns links to the drop-off finder", (await page.getAttribute('.ai-ord[data-ord="5001"] .ai-ret__find', "href")) === "https://locations.example/");
  await page.screenshot({ path: out("orders-return-method") });
  await page.click('.ai-ord[data-ord="5001"] [data-ret-next="confirm"]');
  const choices = await page.$$eval('.ai-ord[data-ord="5001"] [data-ret-submit]', (bs) => bs.map((b) => b.textContent));
  check("return: too small offers Exchange for a bigger size or Return for a refund", choices.join("|") === "Exchange for a bigger size|Return for a refund", choices.join("|"));
  check("return: no store credit option (refunds go to the original payment)", !/store credit/i.test(await page.textContent('.ai-ord[data-ord="5001"] .ai-ret')));
  await page.screenshot({ path: out("orders-return-choice") });
  await page.click('[data-ret-submit="exchange"]');
  await page.waitForSelector(".ai-ret__done", { timeout: 6000 });
  const sent = returnBodies.at(-1);
  check("return: the return is sent for that item, reason and exchange", sent?.orderId === "5001" && sent.items?.length === 1 && sent.items[0].lineId === "9001" && sent.reason === "too_small" && sent.exchange === true && sent.refundTo === undefined, JSON.stringify(sent));
  check("return: confirmation shows the return number", /Return started · #R1001/.test(await page.textContent(".ai-ret__done")));
  await page.waitForFunction(() => [...document.querySelectorAll(".ai-chat-product-card")].some((c) => /8\.5 US/.test(c.getAttribute("data-preselect") || "")), null, { timeout: 4000 }).catch(() => {});
  const ex = await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-chat-product-card")].at(-1); return { handle: c?.getAttribute("data-handle"), pre: c?.getAttribute("data-preselect") || "", msg: c?.closest(".ai-chat-msg")?.querySelector("p")?.textContent || "" }; });
  check("exchange: the same shoe comes back in the next size, ready to add", ex.handle === "savannah-red" && /8\.5 US/.test(ex.pre) && /new size in 8\.5 US/.test(ex.msg), JSON.stringify(ex));
  check("return: the card shows the return, and offers only what's left", /Return another item/.test(await page.textContent('.ai-ord[data-ord="5001"] [data-ord-return]')) && /Return started · #R1001/.test(await page.textContent('.ai-ord[data-ord="5001"] .ai-ret--started')));
  await page.screenshot({ path: out("orders-exchange") });
  // A return AfterShip can't take: the prefilled returns page instead.
  await page.fill(".ai-chat-input-area textarea", "I want to return something");
  await page.keyboard.press("Enter");
  const fresh = '.ai-chat-msg:last-child .ai-ord[data-ord="5001"]';
  await page.waitForSelector(`${fresh} [data-ord-return]`, { timeout: 6000 });
  await page.click(`${fresh} [data-ord-return]`);
  await page.waitForSelector(`${fresh} [data-ret-item]`);
  const left = await page.$$eval(`${fresh} [data-ret-item]`, (bs) => bs.map((b) => b.getAttribute("data-ret-item") + ":" + b.getAttribute("aria-checked")));
  check("return: the item already being returned isn't offered again; the one left is picked", left.join(",") === "9002:true", left.join(","));
  await page.click(`${fresh} [data-ret-next="reason"]`);
  await page.click(`${fresh} [data-ret-reason="other"]`);
  await page.click(`${fresh} [data-ret-next="confirm"]`);
  const single = await page.$$eval(`${fresh} [data-ret-submit]`, (bs) => bs.map((b) => b.textContent));
  check("return: other reasons get one Submit return button", single.join("|") === "Submit return", single.join("|"));
  await page.click(`${fresh} [data-ret-submit="return"]`);
  await page.waitForSelector(`${fresh} .ai-ret__err`, { timeout: 6000 });
  check("return: if it can't be started here, the prefilled returns page is one tap away", (await page.$eval(`${fresh} .ai-ret:not(.ai-ret--started) a.ai-ord__btn`, (a) => a.getAttribute("href"))) === "https://returns.example/?order-number=1171674");
  check("orders & returns: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// End of the page: the bar folds into the bubble; scrolling back up opens it
// out again. Smoothly (a measured stand-in morphs between the two, at 60fps)
// and without leftovers; opening the chat from the bubble works as usual.
for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 800 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full");
  // Measure the scroll morphs only: wait until the launcher has arrived.
  await page.waitForFunction(() => { const l = document.querySelector(".ai-chat-launcher"); return l && !l.classList.contains("is-waiting") && !l.classList.contains("is-arriving"); });
  await page.waitForTimeout(700);
  const state = () => page.evaluate(() => { const l = document.querySelector(".ai-chat-launcher"); const r = l.getBoundingClientRect(); return { tucked: l.classList.contains("is-tucked"), bubble: l.classList.contains("is-bubble"), w: Math.round(r.width), ghosts: document.querySelectorAll(".ai-chat-morph").length, op: getComputedStyle(l).opacity }; });
  // Each frame: the real launcher's and the stand-in's opacity. A frame where
  // both are part-way (a cross-fade) lets the page show through — a flash.
  // The stand-in's orb must already be lit when it first appears (a fresh
  // canvas is blank until the next glow frame — a dark blink).
  await page.evaluate(() => { window.__blankOrb = 0; window.__orbSeen = 0; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains("ai-chat-morph")) { const c = n.querySelector("canvas"); if (!c) continue; window.__orbSeen++; const d = c.getContext("2d").getImageData(c.width / 2, c.height / 2, 1, 1).data; if (!d[3]) window.__blankOrb++; } }).observe(document.body, { childList: true }); });
  await page.evaluate(() => { window.__frames = []; window.__seams = 0; let last = performance.now(); const f = (t) => { window.__frames.push(t - last); last = t; const g = document.querySelector(".ai-chat-morph"); if (g) { const lo = +getComputedStyle(document.querySelector(".ai-chat-launcher")).opacity, go = +getComputedStyle(g).opacity; if (lo > 0.02 && lo < 0.98 && go < 0.98) window.__seams++; const dark = Math.max(0, ...[...getComputedStyle(g).boxShadow.matchAll(/rgba\(0, 0, 0, ([\d.]+)\)/g)].map((x) => +x[1])); window.__minShadow = Math.min(window.__minShadow ?? 1, dark); } requestAnimationFrame(f); }; requestAnimationFrame(f); });
  await page.evaluate(() => window.scrollTo({ top: 300, behavior: "instant" }));
  await page.waitForTimeout(150);
  check(`end of page (${label}): the bar stays while scrolling the middle of the page`, !(await state()).tucked);
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  await page.waitForTimeout(120);
  const mid = await state();
  check(`end of page (${label}): mid-morph, one stand-in and the real launcher hidden (no double)`, mid.ghosts === 1 && mid.op === "0", JSON.stringify(mid));
  await page.waitForTimeout(900);
  const down = await state();
  check(`end of page (${label}): folds into the bubble, nothing left behind`, down.tucked && down.bubble && down.w === 48 && down.ghosts === 0 && down.op === "1", JSON.stringify(down));
  await page.evaluate(() => window.scrollBy(0, -80));
  await page.waitForTimeout(900);
  const up = await state();
  check(`end of page (${label}): scrolling back up opens the bar again`, !up.tucked && !up.bubble && up.w > 300 && up.ghosts === 0, JSON.stringify(up));
  const slow = await page.evaluate(() => window.__frames.slice(5).filter((f) => f > 34).length);
  check(`end of page (${label}): smooth — no dropped frames during the morphs`, slow === 0, `slow frames: ${slow}`);
  const seams = await page.evaluate(() => window.__seams);
  check(`end of page (${label}): no flash at the hand-over (never both half-faded)`, seams === 0, `frames: ${seams}`);
  const minShadow = await page.evaluate(() => window.__minShadow);
  check(`end of page (${label}): the shadow stays steady through the morph (no blink)`, minShadow >= 0.45, `darkest shadow alpha low point: ${minShadow}`);
  const orb = await page.evaluate(() => ({ seen: window.__orbSeen, blank: window.__blankOrb }));
  check(`end of page (${label}): the moving orb is lit from its first frame`, orb.seen >= 2 && orb.blank === 0, JSON.stringify(orb));
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  await page.waitForTimeout(900);
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(500);
  check(`end of page (${label}): tapping the bubble opens the chat`, await page.evaluate(() => document.querySelector(".ai-chat-panel").classList.contains("open") && !document.querySelector(".ai-chat-launcher").classList.contains("is-tucked")));
  check(`end of page (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// The × on the bar folds it into the bubble with the same morph.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto("http://localhost:4789/full");
  await page.waitForTimeout(700);
  await page.click(".ai-chat-launcher__close");
  await page.waitForTimeout(100);
  const mid = await page.evaluate(() => document.querySelectorAll(".ai-chat-morph").length);
  await page.waitForTimeout(900);
  const end = await page.evaluate(() => { const l = document.querySelector(".ai-chat-launcher"); return { bubble: l.classList.contains("is-bubble"), tucked: l.classList.contains("is-tucked"), ghosts: document.querySelectorAll(".ai-chat-morph").length }; });
  check("× morphs the bar into the bubble (and it stays folded, not scroll-tucked)", mid === 1 && end.bubble && !end.tucked && end.ghosts === 0, JSON.stringify({ mid, end }));
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollBy(0, -200));
  await page.waitForTimeout(900);
  check("a bubble the shopper chose isn't opened out by scrolling", await page.evaluate(() => document.querySelector(".ai-chat-launcher").classList.contains("is-bubble")));
  await ctx.close();
}
// Compare: under 2+ cards, one tap (2-3 cards) or pick 2-3 (more), and the
// table — the store's own data, differences first, Add to cart per column —
// also when the assistant compares on request. Kept with the chat.
for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 900 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
  const phone = label === "phone";
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(600);
  await page.fill(".ai-chat-input", "show 2");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  check(`compare (${label}): two cards get "Compare these two"`, /Compare these two/.test(await page.textContent(".ai-chat-msg:last-child .ai-cmp-cta__btn")));
  const before = compareLog.length;
  await page.click(".ai-chat-msg:last-child [data-cmp-start]");
  await page.waitForTimeout(900);
  const t = await page.evaluate(() => {
    const c = [...document.querySelectorAll(".ai-cmp")].pop();
    const cols = [...c.querySelectorAll(".ai-cmp__head")];
    const row = (lbl) => [...c.querySelectorAll(".ai-cmp__row")].find((r) => r.querySelector(".ai-cmp__label").textContent === lbl);
    // What's on screen: for lists, the part the current view shows.
    const cells = (lbl) => [...row(lbl).querySelectorAll(".ai-cmp__cell")].map((x) => ((x.querySelector(".ai-cmp__u") || x).textContent).replace(/^[^:]+: /, "").trim());
    const vis = (lbl) => getComputedStyle(row(lbl)).display !== "none";
    const msgs = [...document.querySelectorAll(".ai-chat-msg")].slice(-2).map((m) => m.textContent.trim().slice(0, 60));
    return {
      n: cols.length, names: cols.map((x) => x.querySelector(".ai-cmp__name").textContent), prices: cols.map((x) => x.querySelector(".ai-cmp__price").textContent),
      tags: cols.map((x) => x.querySelector(".ai-cmp__tags")?.textContent || ""), heel: cells("Heel Height"), helps: cells("Helps with"),
      both: row("Helps with").querySelector(".ai-cmp__both")?.textContent, seg: c.querySelector("[data-cmp-mode=diffs]")?.textContent, sameMaterialsHidden: !vis("Materials"), msgs,
      overflow: c.scrollWidth - c.clientWidth, top: Math.round(c.closest(".ai-chat-msg").getBoundingClientRect().top - document.querySelector(".ai-chat-messages").getBoundingClientRect().top),
    };
  });
  check(`compare (${label}): asks the server once, for exactly those two`, compareLog.length === before + 1 && compareLog.at(-1) === "savannah-red,jillian-black", compareLog.at(-1));
  check(`compare (${label}): your ask and the table appear in the chat`, /^Compare the Savannah/.test(t.msgs[0]) && /^Here's the Savannah/.test(t.msgs[1]), JSON.stringify(t.msgs));
  check(`compare (${label}): columns carry the store's names, prices, ratings`, t.n === 2 && t.names[0] === "Savannah Adjustable Quarter Strap Sandal" && t.prices.join("|") === "$129.95|$119.95", JSON.stringify(t));
  check(`compare (${label}): lower price and higher rating are marked on the right product`, t.tags[0] === "Higher rated" && t.tags[1] === "Lower price", JSON.stringify(t.tags));
  check(`compare (${label}): values exactly as listed, shared ones once`, t.heel.join("|") === '1.25"|1.5"' && t.helps[0] === "Bunions" && t.helps[1] === "\u2014Only what they share" && /Both\s*Plantar Fasciitis · Flat Feet/.test(t.both), JSON.stringify(t));
  check(`compare (${label}): differences first, identical rows tucked away`, /^Differences\s*\d+$/.test(t.seg) && t.sameMaterialsHidden, t.seg);
  check(`compare (${label}): fits the width (no sideways scroll)`, t.overflow <= 1, String(t.overflow));
  check(`compare (${label}): opens at its top, not scrolled past`, t.top > -40 && t.top < 200, String(t.top));
  await page.click(".ai-cmp:last-of-type [data-cmp-mode=all]");
  check(`compare (${label}): "All details" shows every row`, await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-cmp")].pop(); return [...c.querySelectorAll(".ai-cmp__row")].every((r) => getComputedStyle(r).display !== "none") && c.querySelector("[data-cmp-mode=all]").getAttribute("aria-checked") === "true"; }));
  // The buy row stays pinned to the bottom of the chat mid-table, and says
  // what it'll do; gaps are a quiet dash (read out as "Not listed").
  const pin = await page.evaluate(() => {
    const c = [...document.querySelectorAll(".ai-cmp")].pop(), m = document.querySelector(".ai-chat-messages");
    m.scrollTop = c.offsetTop + 240;
    const f = c.querySelector(".ai-cmp__foot").getBoundingClientRect(), mr = m.getBoundingClientRect();
    return { gap: Math.round(mr.bottom - f.bottom), labels: [...c.querySelectorAll(".ai-cmp__atc")].map((x) => x.textContent), names: [...c.querySelectorAll(".ai-cmp__mininame")].map((x) => x.firstChild.textContent), dash: [...c.querySelectorAll(".ai-cmp__dash")].every((d) => /^\u2014(Not listed|Only what they share)$/.test(d.textContent)) && [...c.querySelectorAll(".ai-cmp__dash")].some((d) => d.textContent === "\u2014Not listed") };
  });
  check(`compare (${label}): the buy row stays in reach while the table scrolls, reaching the very bottom (no see-through gap)`, pin.gap <= 0 && pin.gap >= -8, JSON.stringify(pin));
  check(`compare (${label}): pinned, the buy row is square and inside the table's outline`, await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-cmp")].pop(), f = c.querySelector(".ai-cmp__foot"), cr = c.getBoundingClientRect(), fr = f.getBoundingClientRect(), cs = getComputedStyle(f); return cs.borderBottomLeftRadius === "0px" && Math.round(fr.left - cr.left) === 1 && Math.round(cr.right - fr.right) === 1 && getComputedStyle(c).overflow === "clip"; }));
  check(`compare (${label}): what both share sits at the top of its row, under the title`, await page.evaluate(() => { const r = [...[...document.querySelectorAll(".ai-cmp")].pop().querySelectorAll(".ai-cmp__row")].find((x) => x.querySelector(".ai-cmp__both")); return !!r && r.querySelector(".ai-cmp__label").nextElementSibling.classList.contains("ai-cmp__both"); }));
  check(`compare (${label}): "Select size" when there's a size to pick, each named`, pin.labels.join("|") === "Select size|Select size" && pin.names[1] === "Jillian Braided Quarter Strap Sandal", JSON.stringify(pin));
  check(`compare (${label}): gaps show a dash, read out as "Not listed" (or "Only what they share")`, pin.dash, "");
  // Add to cart from a column: the size picker opens under the table.
  await page.click(".ai-cmp .ai-cmp__buy[data-handle=jillian-black] [data-atc]");
  await page.waitForTimeout(800);
  check(`compare (${label}): Add to cart works from the table (picker under it)`, await page.evaluate(() => { const p = document.querySelector(".ai-chat-atc-panel"); return !!p && p.previousElementSibling?.classList.contains("ai-cmp") && /Jillian/.test(p.textContent); }));
  check(`compare (${label}): the buy row names products without prices; the picker shows the full name (wrapping, not cut)`, await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-cmp")].pop(), t = document.querySelector(".ai-chat-atc-panel .ai-chat-atc-title"); return !c.querySelector(".ai-cmp__foot").textContent.includes("$") && /^Jillian Braided Quarter Strap Sandal/.test(t.textContent) && t.scrollWidth <= t.clientWidth + 1 && getComputedStyle(t).whiteSpace !== "nowrap"; }));
  // More than three cards: pick 2 or 3.
  await page.fill(".ai-chat-input", "many");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  await page.click(".ai-chat-msg:last-child [data-cmp-start]");
  const cards4 = await page.$$(".ai-chat-msg:last-child .ai-chat-product-card");
  const go = ".ai-chat-msg:last-child [data-cmp-go]";
  await cards4[0].click();
  check(`compare (${label}): 4 cards → pick; one pick isn't enough`, (await page.$eval(go, (b) => b.disabled)) && /Pick 1 more/.test(await page.textContent(".ai-chat-msg:last-child .ai-cmp-bar__msg")));
  await page.waitForTimeout(400);
  // The circle sits on a white photo: it has to show there, empty or picked,
  // in either theme.
  const pickLook = await page.evaluate(() => {
    const panel = document.querySelector(".ai-chat-panel"), was = panel.getAttribute("data-theme");
    const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
    const alpha = (c) => { const m = c.match(/[\d.]+/g).map(Number); return m.length > 3 ? m[3] : 1; };
    const out = {};
    for (const theme of ["light", "dark"]) {
      panel.setAttribute("data-theme", theme);
      document.querySelectorAll(".ai-cmp-pick").forEach((b) => { b.style.transition = "none"; });
      const [on, off] = ["true", "false"].map((v) => [...document.querySelectorAll(".ai-chat-msg:last-child .ai-cmp-pick")].find((b) => b.getAttribute("aria-pressed") === v));
      const so = getComputedStyle(off), sp = getComputedStyle(on);
      out[theme] = { ring: alpha(so.borderTopColor), picked: +lum(sp.backgroundColor).toFixed(2), check: +lum(sp.color).toFixed(2) };
    }
    if (was) panel.setAttribute("data-theme", was); else panel.removeAttribute("data-theme");
    document.querySelectorAll(".ai-cmp-pick").forEach((b) => { b.style.transition = ""; });
    return out;
  });
  check(`compare (${label}): pick circles show on white photos, empty and picked, in both themes`, ["light", "dark"].every((t) => pickLook[t].ring >= 0.4 && pickLook[t].picked < 0.1 && pickLook[t].check > 0.9), JSON.stringify(pickLook));
  for (const i of [1, 3, 2]) await cards4[i].click();
  const picked = await page.$$eval(".ai-chat-msg:last-child .ai-chat-product-card.is-cmp-picked", (c) => c.map((x) => x.dataset.handle));
  if (phone) {
    check(`compare (${label}): two at most on a phone`, picked.join() === "savannah-red,jillian-black" && (await page.textContent(go)) === "Compare 2" && /2 at most/.test(await page.textContent(".ai-chat-msg:last-child .ai-cmp-bar__msg")), JSON.stringify(picked));
  } else {
    check(`compare (${label}): three at most`, picked.length === 3 && !picked.includes("orthotic-one") && (await page.textContent(go)) === "Compare 3", JSON.stringify(picked));
  }
  await page.click(go);
  await page.waitForTimeout(900);
  const nCols = phone ? 2 : 3;
  check(`compare (${label}): ${nCols} side by side`, compareLog.at(-1) === (phone ? "savannah-red,jillian-black" : "savannah-red,jillian-black,carly-white") && (await page.$$eval(".ai-cmp:last-of-type .ai-cmp__head", (c) => c.length)) === nCols && (await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-cmp")].pop(); return c.scrollWidth - c.clientWidth; })) <= 1, compareLog.at(-1));
  check(`compare (${label}): picking ends after comparing`, !(await page.$(".is-cmp-picking")));
  // Cancel, and a failure, leave the chat as it was.
  await page.fill(".ai-chat-input", "many");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  await page.click(".ai-chat-msg:last-child [data-cmp-start]");
  await page.click(".ai-chat-msg:last-child [data-cmp-cancel]");
  check(`compare (${label}): Cancel puts the row back`, await page.evaluate(() => { const m = [...document.querySelectorAll(".ai-chat-msg")].pop(); return !m.querySelector(".is-cmp-picking") && !m.querySelector(".ai-cmp-cta__btn").hidden && !m.querySelector(".is-cmp-picked"); }));
  mockCtl.compareFail = true;
  const nMsgs = await page.$$eval(".ai-chat-msg", (m) => m.length);
  await page.click(".ai-chat-msg:last-child [data-cmp-start]");
  for (const i of [0, 1]) await (await page.$$(".ai-chat-msg:last-child .ai-chat-product-card"))[i].click();
  await page.click(".ai-chat-msg:last-child [data-cmp-go]");
  await page.waitForTimeout(700);
  mockCtl.compareFail = false;
  check(`compare (${label}): a failure says so and adds nothing`, (await page.$$eval(".ai-chat-msg", (m) => m.length)) === nMsgs && /couldn't load/i.test(await page.textContent(".ai-chat-msg:last-child .ai-cmp-cta__err")), "");
  // Asking the assistant: the table comes with its reply, not as cards.
  await page.fill(".ai-chat-input", "compare savannah and jillian");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  check(`compare (${label}): asking for it shows the table under the reply`, await page.evaluate(() => { const m = [...document.querySelectorAll(".ai-chat-msg")].pop(); return /cushioning/.test(m.textContent) && m.querySelectorAll(".ai-cmp__head").length === 2 && !m.querySelector(".ai-chat-product-card"); }));
  // After several tables (and a size picker), the chat's header is still
  // where it belongs: only the message list scrolls, never the panel.
  await page.waitForTimeout(400);
  const hdr = await page.evaluate(() => { const p = document.querySelector(".ai-chat-panel"), h = p.querySelector(".ai-chat-header"); return { scroll: p.scrollTop, off: Math.round(h.getBoundingClientRect().top - p.getBoundingClientRect().top) }; });
  check(`compare (${label}): the chat's header stays in view after several tables`, hdr.scroll === 0 && hdr.off >= 0 && hdr.off < 4, JSON.stringify(hdr));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("hajirai_chat_history") || "null"));
  const lastA = Array.isArray(saved) ? [...saved].reverse().find((m) => m.role === "assistant") : null;
  check(`compare (${label}): the chat remembers what was compared`, !!lastA?.comparison && lastA.compared?.[0]?.title === "Savannah Adjustable Quarter Strap Sandal - Red", JSON.stringify(lastA?.compared));
  // Three named: all three side by side on a computer; on a phone the first
  // against one other at a time, with a switch for the second column.
  await page.fill(".ai-chat-input", "compare savannah, jillian and carly");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  const sentBack = chatBodies.at(-1)?.history?.filter((m) => m.compared).at(-1)?.compared;
  check(`compare (${label}): what was compared goes back with the chat (for follow-ups)`, sentBack?.[0]?.title === "Savannah Adjustable Quarter Strap Sandal - Red" && sentBack.length === 2, JSON.stringify(sentBack));
  const heads = () => page.evaluate(() => { const m = [...document.querySelectorAll(".ai-chat-msg")].pop(); return [...m.querySelectorAll(".ai-cmp__head .ai-cmp__name")].map((x) => x.textContent.split(" ")[0]); });
  if (phone) {
    // Three named on a phone: the table scrolls sideways, buy row in step.
    const w0 = await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-chat-msg")].pop().querySelector(".ai-cmp"), sc = c.querySelector(".ai-cmp__scroll"), f = c.querySelector(".ai-cmp__foot"); const cue = c.querySelector(".ai-cmp__swipe"); return { wide: c.classList.contains("is-wide"), canScroll: sc.scrollWidth - sc.clientWidth, footScroll: f.scrollWidth - f.clientWidth, cue: cue && getComputedStyle(cue).display !== "none" ? cue.textContent : "", fade: getComputedStyle(c.querySelector(".ai-cmp__fade:not(.is-l)")).opacity, page: document.documentElement.scrollWidth - innerWidth, peek: (() => { const h = c.querySelectorAll(".ai-cmp__heads > .ai-cmp__col")[2].getBoundingClientRect(), r = sc.getBoundingClientRect(); return Math.round(r.right - h.left); })() }; });
    check(`compare (${label}): three named → scrolls sideways, the third peeking in, with a swipe cue`, w0.wide && w0.canScroll > 40 && Math.abs(w0.canScroll - w0.footScroll) <= 1 && w0.cue === "Swipe to see all 3" && w0.fade === "1" && w0.page === 0 && w0.peek > 20, JSON.stringify(w0));
    const sc = await page.$(".ai-chat-msg:last-child .ai-cmp__scroll");
    const bb = await sc.boundingBox();
    await page.mouse.move(bb.x + bb.width * 0.8, bb.y + 200);
    await page.mouse.wheel(400, 0);
    await page.waitForTimeout(500);
    const w1 = await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-chat-msg")].pop().querySelector(".ai-cmp"), sc = c.querySelector(".ai-cmp__scroll"), f = c.querySelector(".ai-cmp__foot"); const lbl = c.querySelector(".ai-cmp__label").getBoundingClientRect().left - sc.getBoundingClientRect().left; return { x: sc.scrollLeft, fx: f.scrollLeft, end: c.classList.contains("is-end"), dots: [...c.querySelectorAll(".ai-cmp__dots i")].map((d) => d.classList.contains("is-on") ? 1 : 0).join(""), lbl: Math.round(lbl), carlyBuy: (() => { const b = c.querySelector(".ai-cmp__buy[data-handle=carly-white]").getBoundingClientRect(), r = f.getBoundingClientRect(); return b.right <= r.right + 1; })() }; });
    check(`compare (${label}): swiping moves the table and its buy row together; titles stay put`, w1.x > 40 && Math.abs(w1.x - w1.fx) <= 1 && w1.end && w1.dots === "011" && w1.lbl === 0 && w1.carlyBuy, JSON.stringify(w1));
  } else {
    check(`compare (${label}): three named → three columns side by side, no sideways scroll`, (await heads()).length === 3 && (await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-chat-msg")].pop().querySelector(".ai-cmp"), sc = c.querySelector(".ai-cmp__scroll"); return sc.scrollWidth - sc.clientWidth <= 1 && getComputedStyle(c.querySelector(".ai-cmp__swipe")).display === "none"; })), JSON.stringify(await heads()));
  }
  await page.reload();
  await page.waitForTimeout(700);
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(700);
  check(`compare (${label}): tables come back after a reload`, (await page.$$eval(".ai-cmp", (c) => c.length)) === 4 && (await page.$$(".ai-cmp.is-wide")).length === (phone ? 1 : 2));
  check(`compare (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// Feedback in the chat: Start here button 4 opens the store's Typeform survey
// inside the chat (Typeform's SDK stubbed here), the site's own Feedback and
// live chat buttons are hidden, and once sent the button gives its place back.
const TF_STUB = `window.tf={createWidget:function(id,o){window.__tf={id:id,o:o};var w=document.createElement("div");w.className="tf-v1-widget";var f=document.createElement("iframe");f.srcdoc="<p>survey</p>";w.appendChild(f);o.container.appendChild(w);setTimeout(function(){o.onReady&&o.onReady()},60);return {unmount:function(){}}}};`;
for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 800 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let sdkLoads = 0;
  await page.route("https://embed.typeform.com/**", (r) => { if (r.request().url().endsWith(".js")) sdkLoads++; return r.fulfill({ status: 200, contentType: r.request().url().endsWith(".css") ? "text/css" : "application/javascript", body: r.request().url().endsWith(".js") ? TF_STUB : "" }); });
  await page.goto("http://localhost:4789/full?fb=2");
  await page.evaluate(() => { document.body.insertAdjacentHTML("beforeend", '<div class="aetrex-tf-cta" style="position:fixed;right:90px;bottom:20px;width:120px;height:40px;background:#0b6a80"></div><iframe id="launcher" style="position:fixed;right:20px;bottom:20px;width:60px;height:40px"></iframe>'); });
  const hidden = await page.evaluate(() => ["div.aetrex-tf-cta", "iframe#launcher"].map((q) => getComputedStyle(document.querySelector(q)).display));
  check(`feedback (${label}): the site's own Feedback and live chat buttons are hidden`, hidden.every((d) => d === "none"), hidden.join(","));
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(700);
  const tiles = await page.$$eval(".ai-chat-welcome__cta-btn", (bs) => bs.map((b) => b.textContent.trim() + (b.classList.contains("is-feedback") ? "*" : "")));
  check(`feedback (${label}): it takes the place of button 4`, tiles.length === 4 && tiles[3] === "Share feedback*" && !tiles.includes("About Aetrex"), tiles.join(" | "));
  const tint = await page.$eval(".ai-chat-welcome__cta-btn.is-feedback", (b) => getComputedStyle(b).backgroundColor);
  const plain = await page.$eval(".ai-chat-welcome__cta-btn:not(.is-feedback)", (b) => getComputedStyle(b).backgroundColor);
  check(`feedback (${label}): a subtly different look from the other buttons`, tint !== plain, `${tint} vs ${plain}`);
  await page.click("[data-feedback]");
  await page.waitForTimeout(700);
  const open = await page.evaluate(() => { const s = document.querySelector(".ai-chat-fbsheet"), p = document.querySelector(".ai-chat-panel"); const r = s.getBoundingClientRect(), pr = p.getBoundingClientRect(); return { open: s.classList.contains("is-open") && s.classList.contains("is-ready"), inside: Math.abs(r.top - pr.top) < 2 && Math.abs(r.height - pr.height) < 2, form: window.__tf && window.__tf.id, inline: window.__tf && window.__tf.o.inlineOnMobile, iframe: !!s.querySelector(".ai-chat-fbsheet__form iframe"), focus: document.activeElement && document.activeElement.className, behindInert: document.querySelector(".ai-chat-messages").inert }; });
  check(`feedback (${label}): the survey opens inside the chat window`, open.open && open.inside && open.form === "jdXBrXMa" && open.inline === true && open.iframe && open.behindInert, JSON.stringify(open));
  check(`feedback (${label}): focus moves to the sheet's back button`, /ai-chat-fbsheet__back/.test(open.focus || ""), open.focus);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  const esc = await page.evaluate(() => ({ sheet: !document.querySelector(".ai-chat-fbsheet").hidden, chatOpen: document.querySelector(".ai-chat-panel").classList.contains("open"), inert: document.querySelector(".ai-chat-messages").inert }));
  check(`feedback (${label}): Escape steps back to the chat (the chat stays open)`, !esc.sheet && esc.chatOpen && !esc.inert, JSON.stringify(esc));
  await page.click("[data-feedback]");
  await page.waitForTimeout(600);
  check(`feedback (${label}): reopening keeps the same survey (no reload)`, sdkLoads === 1 && (await page.$$eval(".ai-chat-fbsheet__form iframe", (f) => f.length)) === 1, `sdk loads ${sdkLoads}`);
  await page.evaluate(() => window.__tf.o.onSubmit({ responseId: "r1" }));
  await page.click(".ai-chat-fbsheet__back");
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => ({ tiles: [...document.querySelectorAll(".ai-chat-welcome__cta-btn")].map((b) => b.textContent.trim()), mine: +localStorage.getItem("hajirai_fb_done_jdXBrXMa") > Date.now() + 300 * 864e5, site: +localStorage.getItem("tf_cta_hidden_until_jdXBrXMa") > Date.now() + 300 * 864e5 }));
  check(`feedback (${label}): once sent, button 4 comes back (and the site's button stays away)`, after.tiles[3] === "About Aetrex" && !after.tiles.includes("Share feedback") && after.mine && after.site, JSON.stringify(after));
  await page.reload();
  await page.waitForTimeout(600);
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(600);
  check(`feedback (${label}): stays sent after a reload`, !(await page.$("[data-feedback]")), "");
  // Switched off in Settings: the next page drops the button and gives the
  // site's own buttons back, even though the last settings were remembered.
  if (label === "desktop") {
    await page.route("**/apps/hajirai/widget-config**", async (r) => { const res = await r.fetch(); const j = await res.json(); r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...j, feedbackSurvey: { on: false, form: "", label: "Share feedback" }, hideLiveChatButton: false }) }); });
    await page.evaluate(() => localStorage.removeItem("hajirai_fb_done_jdXBrXMa"));
    await page.reload();
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<div class="aetrex-tf-cta" style="width:10px;height:10px"></div><iframe id="launcher" style="width:10px;height:10px"></iframe>'));
    await page.waitForTimeout(600);
    await page.click(".ai-chat-launcher__text");
    await page.waitForTimeout(600);
    const off = await page.evaluate(() => ({ tile: !!document.querySelector("[data-feedback]"), four: document.querySelectorAll(".ai-chat-welcome__cta-btn")[3]?.textContent.trim(), tf: getComputedStyle(document.querySelector("div.aetrex-tf-cta")).display, zd: getComputedStyle(document.querySelector("iframe#launcher")).display }));
    check("feedback: turned off in Settings, everything goes back as it was", !off.tile && off.four === "About Aetrex" && off.tf !== "none" && off.zd !== "none", JSON.stringify(off));
  }
  check(`feedback (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// The store's other Typeforms in the same sheet: a Popular button whose
// message is a Typeform link (with its icon), and the assistant's quiz
// button under a reply. One form at a time; the feedback survey keeps its
// own state; sending the quiz never retires the feedback button.
for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 800 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://embed.typeform.com/**", (r) => r.fulfill({ status: 200, contentType: r.request().url().endsWith(".css") ? "text/css" : "application/javascript", body: r.request().url().endsWith(".js") ? TF_STUB : "" }));
  await page.goto("http://localhost:4789/full?fb=2&qp=1");
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(700);
  const chips = await page.$$eval(".ai-chat-welcome__qp-btn", (bs) => bs.map((b) => ({ t: b.textContent.trim(), form: b.getAttribute("data-form"), msg: b.getAttribute("data-message"), icon: !!b.querySelector(".ai-chat-welcome__qp-icon svg"), w: b.querySelector("svg")?.getAttribute("width") })));
  check(`quiz (${label}): a Popular button with a Typeform link opens the form, with an icon`, chips[0].t === "Identify my orthotic" && chips[0].form === "ojyWbTvZ" && !chips[0].msg && chips[0].icon && chips[0].w === "15", JSON.stringify(chips[0]));
  check(`quiz (${label}): other Popular buttons still send their message, without an icon`, chips[1].msg === "heel pain" && !chips[1].icon && chips[2].msg === "wide shoes" && !chips[2].icon, JSON.stringify(chips.slice(1)));
  const insole = await page.$eval(".ai-chat-welcome__qp-btn[data-form] svg", (s) => s.querySelectorAll("path").length >= 3 && !!s.querySelector("g[transform]"));
  check(`quiz (${label}): the orthotic quiz gets the insoles icon`, insole);
  const oneRow = await page.$eval(".ai-chat-welcome__qp-btn", (b) => b.getBoundingClientRect().height);
  check(`quiz (${label}): the icon keeps the button its usual height`, oneRow <= 34, String(oneRow));
  await page.click(".ai-chat-welcome__qp-btn[data-form]");
  await page.waitForTimeout(700);
  const q = await page.evaluate(() => ({ id: window.__tf && window.__tf.id, title: document.querySelector(".ai-chat-fbsheet__title").textContent, aria: document.querySelector(".ai-chat-fbsheet").getAttribute("aria-label"), ready: document.querySelector(".ai-chat-fbsheet").classList.contains("is-ready"), frames: document.querySelectorAll(".ai-chat-fbsheet__form iframe").length, sent: (document.querySelector(".ai-chat-messages").textContent || "").includes("ojyWbTvZ") }));
  check(`quiz (${label}): it opens in the chat's sheet, titled with the button's text`, q.id === "ojyWbTvZ" && q.title === "Identify my orthotic" && q.aria === "Identify my orthotic" && q.ready && q.frames === 1 && !q.sent, JSON.stringify(q));
  await page.evaluate(() => window.__tf.o.onSubmit({ responseId: "q1" }));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  const kept = await page.evaluate(() => ({ tile: !!document.querySelector("[data-feedback]"), done: localStorage.getItem("hajirai_fb_done_jdXBrXMa"), site: localStorage.getItem("tf_cta_hidden_until_jdXBrXMa"), closed: document.querySelector(".ai-chat-fbsheet").hidden }));
  check(`quiz (${label}): sending the quiz leaves the feedback button in place`, kept.tile && !kept.done && !kept.site && kept.closed, JSON.stringify(kept));
  await page.click("[data-feedback]");
  await page.waitForTimeout(700);
  const f = await page.evaluate(() => ({ id: window.__tf.id, title: document.querySelector(".ai-chat-fbsheet__title").textContent, frames: document.querySelectorAll(".ai-chat-fbsheet__form iframe").length, done: localStorage.getItem("hajirai_fb_done_jdXBrXMa") }));
  check(`quiz (${label}): the feedback survey then opens in its place`, f.id === "jdXBrXMa" && f.title === "Share feedback" && f.frames === 1 && !f.done, JSON.stringify(f));
  await page.click(".ai-chat-fbsheet__back");
  await page.waitForTimeout(600);
  // The assistant's own quiz button, under its reply.
  await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "quizme");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ai-chat-form-cta", { timeout: 5000 });
  const btn = await page.$eval(".ai-chat-form-cta", (b) => ({ t: b.textContent.trim(), form: b.getAttribute("data-form"), inBubble: !!b.closest(".ai-chat-msg-bubble") }));
  check(`quiz (${label}): the assistant's reply carries the quiz button`, btn.t === "Identify my orthotic" && btn.form === "ojyWbTvZ" && btn.inBubble, JSON.stringify(btn));
  await page.click(".ai-chat-form-cta");
  await page.waitForTimeout(700);
  const r = await page.evaluate(() => ({ id: window.__tf.id, open: document.querySelector(".ai-chat-fbsheet").classList.contains("is-open"), title: document.querySelector(".ai-chat-fbsheet__title").textContent }));
  check(`quiz (${label}): the reply's button opens the quiz in the chat`, r.id === "ojyWbTvZ" && r.open && r.title === "Identify my orthotic", JSON.stringify(r));
  await page.click(".ai-chat-fbsheet__back");
  await page.reload();
  await page.waitForTimeout(600);
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(700);
  check(`quiz (${label}): the button is still under the reply after a reload`, (await page.$$eval(".ai-chat-form-cta[data-form=ojyWbTvZ]", (b) => b.length)) === 1);
  check(`quiz (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// The feedback button's look and lifetime from Settings: a green tint and
// the insoles icon, and kept after sending (a quiz people come back to);
// reopening after sending starts the form afresh.
for (const theme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let builds = 0;
  await page.route("https://embed.typeform.com/**", (r) => r.fulfill({ status: 200, contentType: r.request().url().endsWith(".css") ? "text/css" : "application/javascript", body: r.request().url().endsWith(".js") ? TF_STUB.replace("window.__tf={id:id,o:o};", "window.__tf={id:id,o:o};window.__builds=(window.__builds||0)+1;") : "" }));
  await page.addInitScript((t) => { try { localStorage.setItem("hajirai_theme_pick", t); } catch (e) { /* private mode */ } }, theme);
  await page.goto("http://localhost:4789/full?fb=2&fblook=1");
  await page.waitForTimeout(500);
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(700);
  const t = await page.$eval("[data-feedback]", (b) => { const cs = getComputedStyle(b), ic = getComputedStyle(b.querySelector(".ai-chat-welcome__cta-icon")); const plain = document.querySelector(".ai-chat-welcome__cta-btn:not(.is-feedback)"); return { text: b.textContent.trim(), cls: b.className, bg: cs.backgroundColor, icon: ic.color, insole: !!b.querySelector(".ai-chat-welcome__cta-icon g[transform]"), plainBg: getComputedStyle(plain).backgroundColor, theme: document.querySelector(".ai-chat-panel").getAttribute("data-theme") }; });
  const green = theme === "light" ? /rgba\(30, 130, 76/.test(t.bg) && t.icon === "rgb(30, 130, 76)" : /rgba\(90, 200, 130/.test(t.bg) && t.icon === "rgb(127, 211, 160)";
  check(`feedback look (${theme}): the button takes the color and icon from Settings`, t.text === "Identify My Orthotic" && /fb-green/.test(t.cls) && t.insole && green && t.bg !== t.plainBg, JSON.stringify(t));
  await page.click("[data-feedback]");
  await page.waitForTimeout(700);
  await page.evaluate(() => window.__tf.o.onSubmit({ responseId: "x" }));
  await page.click(".ai-chat-fbsheet__back");
  await page.waitForTimeout(600);
  const kept = await page.evaluate(() => ({ tile: !!document.querySelector("[data-feedback]"), done: localStorage.getItem("hajirai_fb_done_ojyWbTvZ") }));
  check(`feedback look (${theme}): kept after sending when Settings say so`, kept.tile && !kept.done, JSON.stringify(kept));
  await page.click("[data-feedback]");
  await page.waitForTimeout(700);
  builds = await page.evaluate(() => window.__builds);
  check(`feedback look (${theme}): reopening after sending starts the form afresh`, builds === 2 && (await page.$$eval(".ai-chat-fbsheet__form iframe", (f) => f.length)) === 1, `builds ${builds}`);
  await page.click(".ai-chat-fbsheet__back");
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForTimeout(600);
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(600);
  check(`feedback look (${theme}): still there after a reload`, !!(await page.$("[data-feedback].fb-green")));
  check(`feedback look (${theme}): no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// The store locator (Storepoint, stubbed) in the same sheet: opened from
// the assistant's button, kept once built (switching to the feedback
// survey and back never reloads it), back after a reload; if it can't load,
// a link to the locator page that can be tapped; on the locator page
// itself, the button takes the shopper to the page's own map.
const SP_STUB = `(function(){var c=document.getElementById("storepoint-container");window.__spLoads=(window.__spLoads||0)+1;setTimeout(function(){c.innerHTML='<div class="sp-stub" style="height:900px">Stores near you, map '+c.getAttribute("data-map-id")+'</div>'},150)})();`;
for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 800 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://cdn.storepoint.co/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: SP_STUB }));
  await page.route("https://embed.typeform.com/**", (r) => r.fulfill({ status: 200, contentType: r.request().url().endsWith(".css") ? "text/css" : "application/javascript", body: r.request().url().endsWith(".js") ? TF_STUB : "" }));
  await page.goto("http://localhost:4789/full?fb=2");
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(600);
  await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "storesnear");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-map]", { timeout: 5000 });
  check(`store map (${label}): the reply carries the store map button`, (await page.$eval("[data-map]", (b) => b.textContent.trim() + "|" + b.getAttribute("data-map"))) === "Find a store near you|15ecd30bd8acd4");
  await page.click("[data-map]");
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".ai-chat-fbsheet__map")).opacity === "1", null, { timeout: 4000 }).catch(() => {});
  const m = await page.evaluate(() => { const sh = document.querySelector(".ai-chat-fbsheet"), p = document.querySelector(".ai-chat-panel"), map = document.querySelector(".ai-chat-fbsheet__map"); const r = sh.getBoundingClientRect(), pr = p.getBoundingClientRect(); return { kind: sh.getAttribute("data-kind"), open: sh.classList.contains("is-open"), ready: sh.classList.contains("is-ready"), title: document.querySelector(".ai-chat-fbsheet__title").textContent, inside: Math.abs(r.top - pr.top) < 2 && Math.abs(r.height - pr.height) < 2, stub: !!map.querySelector(".sp-stub"), shown: getComputedStyle(map).opacity === "1", loads: window.__spLoads, scrolls: map.querySelector(".ai-chat-locator").scrollHeight > map.querySelector(".ai-chat-locator").clientHeight }; });
  check(`store map (${label}): it opens inside the chat, titled with the button's text`, m.kind === "map" && m.open && m.ready && m.inside && m.stub && m.shown && m.loads === 1 && m.title === "Find a store near you", JSON.stringify(m));
  check(`store map (${label}): a tall map scrolls inside the sheet`, m.scrolls);
  await page.click(".ai-chat-fbsheet__back");
  await page.waitForTimeout(500);
  await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "quizme");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ai-chat-form-cta[data-form]", { timeout: 5000 });
  await page.click(".ai-chat-form-cta[data-form]");
  await page.waitForTimeout(700);
  const f = await page.evaluate(() => ({ kind: document.querySelector(".ai-chat-fbsheet").getAttribute("data-kind"), id: window.__tf && window.__tf.id, mapHidden: getComputedStyle(document.querySelector(".ai-chat-fbsheet__map")).visibility === "hidden", formShown: getComputedStyle(document.querySelector(".ai-chat-fbsheet__form")).opacity === "1" }));
  check(`store map (${label}): a quiz then shows in its place`, f.kind === "form" && f.id === "ojyWbTvZ" && f.mapHidden && f.formShown, JSON.stringify(f));
  await page.click(".ai-chat-fbsheet__back");
  await page.waitForTimeout(500);
  await page.click("[data-map]");
  await page.waitForTimeout(400);
  const again = await page.evaluate(() => ({ ready: document.querySelector(".ai-chat-fbsheet").classList.contains("is-ready"), loads: window.__spLoads, stub: !!document.querySelector(".ai-chat-fbsheet__map .sp-stub"), formHidden: getComputedStyle(document.querySelector(".ai-chat-fbsheet__form")).visibility === "hidden" }));
  check(`store map (${label}): back to the map, it's still there (not reloaded)`, again.ready && again.loads === 1 && again.stub && again.formHidden, JSON.stringify(again));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForTimeout(600);
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(600);
  check(`store map (${label}): the button is still under the reply after a reload`, (await page.$$eval("[data-map=\"15ecd30bd8acd4\"]", (b) => b.length)) === 1);
  check(`store map (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// "View all": more matches than the cards show → a row under the cards opens
// every match in the sheet, as a scrolling list; Add to cart works there (its
// picker opens inside the card), back returns to the button, and the button
// comes back after a reload.
for (const [label, path, opts] of [["desktop", "/showcase", { viewport: { width: 1280, height: 800 } }], ["phone", "/showcase", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }], ["row cards", "/horizontal", { viewport: { width: 1280, height: 800 } }]]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789" + path);
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(500);
  await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "saleboots");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-viewall]", { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: out(`va-${label}-row`) });
  const row = await page.evaluate(() => {
    const b = document.querySelector("[data-viewall]"), bub = b.closest(".ai-chat-msg-bubble"), cards = bub.querySelector(".ai-chat-products-wrap, .ai-chat-products"), cmp = bub.querySelector(".ai-cmp-cta");
    const r = b.getBoundingClientRect(), br = bub.getBoundingClientRect();
    const cmpBtn = cmp && cmp.querySelector(".ai-cmp-cta__btn");
    return { label: b.querySelector(".ai-cmp-cta__label").textContent, hint: b.querySelector(".ai-cmp-cta__hint").textContent, thumbs: b.querySelectorAll(".ai-cmp-cta__thumb").length, afterCards: !!(cards.compareDocumentPosition(b) & 4), beforeCompare: !cmp || !!(b.compareDocumentPosition(cmp) & 4), fits: r.left >= br.left - 0.5 && r.right <= br.right + 0.5, height: Math.round(r.height), popup: b.getAttribute("aria-haspopup"),
      bg: getComputedStyle(b).backgroundColor, cmpBg: cmpBtn ? getComputedStyle(cmpBtn).backgroundColor : "", fg: getComputedStyle(b).color };
  });
  check(`view all (${label}): a row under the cards names the full count`, row.label === "View all 10 women's sale boots" && row.hint === "8 more to browse" && row.thumbs === 3, JSON.stringify(row));
  check(`view all (${label}): right under the cards, above Compare, inside the bubble, easy to tap`, row.afterCards && row.beforeCompare && row.fits && row.height >= 44 && row.popup === "dialog", JSON.stringify(row));
  check(`view all (${label}): filled, so it stands apart from Compare`, row.bg !== row.cmpBg && row.bg !== "rgba(0, 0, 0, 0)" && row.fg !== row.bg, JSON.stringify(row));
  await page.click("[data-viewall]");
  await page.waitForTimeout(700);
  await page.screenshot({ path: out(`va-${label}-sheet`) });
  const sh = await page.evaluate(() => {
    const sh = document.querySelector(".ai-chat-fbsheet"), p = document.querySelector(".ai-chat-panel"), list = document.querySelector(".ai-chat-fbsheet__list");
    const r = sh.getBoundingClientRect(), pr = p.getBoundingClientRect();
    const cards = [...list.querySelectorAll(".ai-chat-product-card")];
    const grid = list.querySelector(".ai-chat-products--grid");
    const chatRow = document.querySelector(".ai-chat-messages .ai-chat-products");
    const firstTop = cards[0].offsetTop, perRow = cards.filter((c) => c.offsetTop === firstTop).length;
    const widths = cards.map((c) => Math.round(c.getBoundingClientRect().width));
    const showcase = grid.classList.contains("ai-chat-products--showcase");
    const chatCard = document.querySelector('.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"]'), listCard = list.querySelector('.ai-chat-product-card[data-handle="savannah-red"]');
    return { perRow, widths: [...new Set(widths)], showcase, sameStyle: showcase === chatRow.classList.contains("ai-chat-products--showcase"),
      noSideways: list.scrollWidth <= list.clientWidth + 1 && grid.scrollWidth <= grid.clientWidth + 1,
      imgOnTop: showcase ? cards[0].querySelector(".ai-chat-product-img").getBoundingClientRect().bottom <= cards[0].querySelector(".ai-chat-product-title").getBoundingClientRect().top + 1 : true,
      sameButtons: !!chatCard.querySelector(".ai-chat-card-fit") === !!listCard.querySelector(".ai-chat-card-fit") && !!listCard.querySelector("[data-atc]") && !!listCard.querySelector(".ai-chat-view-link"), kind: sh.getAttribute("data-kind"), open: sh.classList.contains("is-open"), title: document.querySelector(".ai-chat-fbsheet__title").textContent, inside: Math.abs(r.top - pr.top) < 2 && Math.abs(r.height - pr.height) < 2,
      count: list.querySelector(".ai-chat-viewall__count").textContent, cards: cards.length, handles: cards.map((c) => c.getAttribute("data-handle")).slice(0, 4).join(","),
      sale: !!list.querySelector(".compare-at"),
      scrolls: list.scrollHeight > list.clientHeight, focus: document.activeElement && document.activeElement.classList.contains("ai-chat-fbsheet__back"),
      listShown: getComputedStyle(list).visibility === "visible", formHidden: getComputedStyle(document.querySelector(".ai-chat-fbsheet__form")).visibility === "hidden",
      behindInert: document.querySelector(".ai-chat-messages").closest("[inert]") !== null || document.querySelector(".ai-chat-messages").inert === true };
  });
  check(`view all (${label}): the list opens in the chat, titled, with every match`, sh.kind === "list" && sh.open && sh.inside && sh.title === "Women's Sale Boots" && sh.count === "10 results" && sh.cards === 10 && sh.handles === "savannah-red,jillian-black,orthotic-one,carly-white", JSON.stringify(sh));
  check(`view all (${label}): the chat's own card style and buttons, in a grid — no sideways scrolling`, sh.sameStyle && sh.sameButtons && sh.noSideways && sh.imgOnTop && sh.widths.length === 1 && (sh.showcase ? sh.perRow >= 2 && sh.perRow <= 3 : sh.perRow >= 1), JSON.stringify(sh));
  check(`view all (${label}): sale prices, it scrolls down`, sh.sale && sh.scrolls && sh.listShown && sh.formHidden, JSON.stringify(sh));
  check(`view all (${label}): focus moves into the sheet; the chat behind is out of reach`, sh.focus && sh.behindInert, JSON.stringify(sh));
  // Add to cart from the list: the picker opens full width under that card's row.
  const before = cartLog.length;
  await page.click('.ai-chat-fbsheet__list .ai-chat-product-card[data-handle="jillian-black"] [data-atc]');
  await page.waitForSelector(".ai-chat-fbsheet__list .ai-chat-products--grid > .ai-chat-atc-panel", { timeout: 5000 });
  const pick = await page.evaluate(() => { const g = document.querySelector(".ai-chat-fbsheet__list .ai-chat-products--grid"), pn = g.querySelector(":scope > .ai-chat-atc-panel"), c = g.querySelector('.ai-chat-product-card[data-handle="jillian-black"]'); const pr = pn.getBoundingClientRect(), gr = g.getBoundingClientRect(); const rowBottom = Math.max(...[...g.querySelectorAll(".ai-chat-product-card")].filter((x) => x.offsetTop === c.offsetTop).map((x) => x.getBoundingClientRect().bottom)); return { below: pr.top >= rowBottom - 1, full: Math.abs(pr.width - gr.width) < 2, names: (pn.querySelector(".ai-chat-atc-title") || {}).textContent || "" }; });
  check(`view all (${label}): the size picker opens full width under the tapped card's row, naming it`, pick.below && pick.full && /Jillian/.test(pick.names), JSON.stringify(pick));
  for (const opt of ["Size", "Width"]) {
    const sel = `.ai-chat-fbsheet__list .ai-chat-atc-panel [data-opt="${opt}"]:not(.is-out):not([aria-disabled="true"])`;
    if (await page.$(sel)) await page.click(sel);
  }
  await page.click(".ai-chat-fbsheet__list .ai-chat-atc-panel [data-atc-add]");
  await page.waitForSelector(".ai-chat-fbsheet__list .ai-chat-atc-done", { timeout: 5000 });
  // The widget scrolls the confirmation into view on the next frame.
  await page.waitForFunction(() => { const d = document.querySelector(".ai-chat-fbsheet__list .ai-chat-atc-done"), l = document.querySelector(".ai-chat-fbsheet__list"); if (!d || !l) return false; const r = d.getBoundingClientRect(), lr = l.getBoundingClientRect(); return r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1; }, null, { timeout: 2000 }).catch(() => {});
  const added = await page.evaluate(() => { const d = document.querySelector(".ai-chat-fbsheet__list .ai-chat-atc-done"), l = document.querySelector(".ai-chat-fbsheet__list"); const r = d.getBoundingClientRect(), lr = l.getBoundingClientRect(); return { inView: r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1 }; });
  check(`view all (${label}): Add to cart works in the list, the confirmation kept in view`, cartLog.length === before + 1 && PRODUCTS["jillian-black"].variants.some((v) => v.id === cartLog.at(-1)) && added.inView, JSON.stringify({ added, n: cartLog.length - before, last: cartLog.at(-1) }));
  await page.screenshot({ path: out(`va-${label}-added`) });
  await page.click(".ai-chat-fbsheet__back");
  await page.waitForTimeout(600);
  const back = await page.evaluate(() => ({ closed: document.querySelector(".ai-chat-fbsheet").hidden, focus: document.activeElement && document.activeElement.hasAttribute("data-viewall") }));
  check(`view all (${label}): back closes the list and returns focus to the button`, back.closed && back.focus, JSON.stringify(back));
  await page.click("[data-viewall]");
  await page.waitForTimeout(500);
  const kept = await page.evaluate(() => !!document.querySelector(".ai-chat-fbsheet__list .ai-chat-atc-done"));
  check(`view all (${label}): reopening shows the same list (not rebuilt)`, kept);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  check(`view all (${label}): Escape closes it`, await page.evaluate(() => document.querySelector(".ai-chat-fbsheet").hidden));
  await page.reload();
  await page.waitForTimeout(600);
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(600);
  check(`view all (${label}): the button is still under the reply after a reload`, (await page.$$eval("[data-viewall]", (b) => b.length)) === 1);
  await page.click("[data-viewall]");
  await page.waitForTimeout(600);
  check(`view all (${label}): and still opens the full list`, (await page.$$eval(".ai-chat-fbsheet__list .ai-chat-product-card", (c) => c.length)) === 10);
  check(`view all (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// "View all" in pages: 60 matches, 24 to a page. A frosted pill floats at the
// bottom of the list (reachable wherever the shopper has scrolled); the next
// page is fetched ahead, pages already seen come back instantly, a page that
// fails says so with Try again, and paging still works after a reload.
for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 800 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/showcase");
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(500);
  await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "manyboots");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-viewall]", { timeout: 5000 });
  const logStart = viewAllLog.length;
  await page.click("[data-viewall]");
  await page.waitForTimeout(700);
  const state = () => page.evaluate(() => {
    const list = document.querySelector(".ai-chat-fbsheet__list"), pager = list.querySelector(".ai-va-pager");
    const cards = [...list.querySelectorAll(".ai-chat-products--grid > .ai-chat-product-card")];
    const prev = pager && pager.querySelector('[data-va-step="-1"]'), next = pager && pager.querySelector('[data-va-step="1"]');
    const pr = pager ? pager.getBoundingClientRect() : null, lr = list.getBoundingClientRect();
    return { count: list.querySelector(".ai-chat-viewall__count").textContent, live: list.querySelector(".ai-chat-viewall__count").getAttribute("aria-live"), label: pager ? pager.querySelector(".ai-va-pager__label").textContent : "", cards: cards.length,
      first: cards[0] && cards[0].getAttribute("data-handle"), last: cards.length && cards[cards.length - 1].getAttribute("data-handle"),
      prevOff: prev ? prev.disabled : null, nextOff: next ? next.disabled : null, nextLabel: next ? next.getAttribute("aria-label") : "",
      pagerInView: pr ? pr.bottom <= lr.bottom + 1 && pr.top >= lr.top : false, pagerFits: pr ? pr.left >= lr.left && pr.right <= lr.right : false, pagerTall: pr ? Math.round(pr.height) : 0,
      scrollTop: Math.round(list.scrollTop), noSideways: list.scrollWidth <= list.clientWidth + 1, focusOnNext: document.activeElement === next };
  });
  let st = await state();
  await page.screenshot({ path: out(`va-pages-${label}-1`) });
  check(`view all pages (${label}): the first page, its range, and the page pill`, st.count === "1\u201324 of 60" && st.live === "polite" && st.label === "Page 1 of 3" && st.cards === 24 && st.first === "boot-1" && st.last === "boot-24" && st.prevOff === true && st.nextOff === false && st.nextLabel === "Next page, 2 of 3", JSON.stringify(st));
  check(`view all pages (${label}): the pill sits in view at the bottom, fits, easy to tap, no sideways scroll`, st.pagerInView && st.pagerFits && st.pagerTall >= 40 && st.noSideways, JSON.stringify(st));
  // Page 2 was fetched ahead of time with the same search.
  await page.waitForTimeout(400);
  const ahead = viewAllLog.slice(logStart);
  check(`view all pages (${label}): page 2 is loaded ahead, with the reply's search`, ahead.length === 1 && ahead[0].page === 2 && ahead[0].search.on_sale === true && ahead[0].search.gender === "women", JSON.stringify(ahead));
  // Scroll halfway: the pill is still right there.
  await page.evaluate(() => { const l = document.querySelector(".ai-chat-fbsheet__list"); l.scrollTop = l.scrollHeight / 2; });
  await page.waitForTimeout(150);
  st = await state();
  check(`view all pages (${label}): mid-list, the pill is still in view`, st.pagerInView, JSON.stringify(st));
  await page.click('.ai-va-pager [data-va-step="1"]');
  await page.waitForTimeout(250);
  st = await state();
  await page.screenshot({ path: out(`va-pages-${label}-2`) });
  check(`view all pages (${label}): Next shows page 2 at once (it was loaded ahead), from the top`, st.count === "25\u201348 of 60" && st.label === "Page 2 of 3" && st.first === "boot-25" && st.cards === 24 && st.scrollTop === 0 && st.prevOff === false && st.focusOnNext, JSON.stringify(st));
  await page.waitForTimeout(400);
  await page.click('.ai-va-pager [data-va-step="1"]');
  await page.waitForTimeout(250);
  st = await state();
  check(`view all pages (${label}): the last page — 12 boots, Next off`, st.count === "49\u201360 of 60" && st.label === "Page 3 of 3" && st.cards === 12 && st.last === "boot-60" && st.nextOff === true && st.prevOff === false, JSON.stringify(st));
  const beforeBack = viewAllLog.length;
  await page.click('.ai-va-pager [data-va-step="-1"]');
  await page.waitForTimeout(100);
  st = await state();
  check(`view all pages (${label}): Previous is instant — pages already seen aren't fetched again`, st.label === "Page 2 of 3" && st.first === "boot-25" && viewAllLog.length === beforeBack, JSON.stringify({ st, fetched: viewAllLog.length - beforeBack }));
  // Add to cart still works on a later page.
  const beforeCart = cartLog.length;
  await page.click('.ai-chat-fbsheet__list .ai-chat-product-card[data-handle="boot-25"] [data-atc]');
  await page.waitForTimeout(400);
  check(`view all pages (${label}): cards on later pages keep Add to cart`, (await page.$(".ai-chat-fbsheet__list .ai-chat-atc-panel")) !== null || cartLog.length > beforeCart);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  // A page that fails: the pill stays, a note says so, Try again loads it.
  await page.reload();
  await page.waitForTimeout(600);
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(600);
  mockCtl.viewAllFail = 2;
  await page.click("[data-viewall]");
  await page.waitForTimeout(700);
  st = await state();
  check(`view all pages (${label}): after a reload the list still opens on page 1 of 3`, st.label === "Page 1 of 3" && st.cards === 24, JSON.stringify(st));
  await page.click('.ai-va-pager [data-va-step="1"]');
  await page.waitForSelector(".ai-va-error:not([hidden])", { timeout: 5000 });
  const fail = await page.evaluate(() => { const e = document.querySelector(".ai-va-error"), r = e.getBoundingClientRect(), l = document.querySelector(".ai-chat-fbsheet__list").getBoundingClientRect(); return { text: e.textContent, role: e.getAttribute("role"), inView: r.top >= l.top && r.bottom <= l.bottom, page: document.querySelector(".ai-va-pager__label").textContent, dim: document.querySelector(".ai-chat-fbsheet__list").classList.contains("is-loading") }; });
  await page.screenshot({ path: out(`va-pages-${label}-failed`) });
  check(`view all pages (${label}): a failed page says so, in view, and keeps the current page`, /Page 2 couldn.t load/.test(fail.text) && /Try again/.test(fail.text) && fail.role === "alert" && fail.inView && fail.page === "Page 1 of 3" && !fail.dim, JSON.stringify(fail));
  // Try again, on a slow connection: while the page loads the list dims and
  // Next spins (and taps can't stack up); then it shows.
  mockCtl.viewAllDelayMs = 1200;
  await page.click("[data-va-retry]");
  await page.waitForTimeout(250);
  const busy = await page.evaluate(() => ({ dim: document.querySelector(".ai-chat-fbsheet__list").classList.contains("is-loading"), busy: document.querySelector('.ai-va-pager [data-va-step="1"]').classList.contains("is-busy"), aria: document.querySelector(".ai-chat-fbsheet__list").getAttribute("aria-busy"), errGone: document.querySelector(".ai-va-error").hidden }));
  await page.screenshot({ path: out(`va-pages-${label}-loading`) });
  const asked = viewAllLog.length;
  await page.click('.ai-va-pager [data-va-step="1"]');
  await page.waitForTimeout(1500);
  mockCtl.viewAllDelayMs = 150;
  st = await state();
  check(`view all pages (${label}): while a page loads the list dims and Next spins`, busy.dim && busy.busy && busy.aria === "true" && busy.errGone, JSON.stringify(busy));
  check(`view all pages (${label}): Try again loads it — an extra tap while loading doesn't skip a page`, st.label === "Page 2 of 3" && st.first === "boot-25" && viewAllLog.length === asked + 1 && (await page.evaluate(() => document.querySelector(".ai-va-error").hidden && !document.querySelector(".ai-chat-fbsheet__list").classList.contains("is-loading"))), JSON.stringify({ st, extraFetches: viewAllLog.length - asked }));
  check(`view all pages (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// "How's the chat going?": after the store's number of replies, one quiet
// line under the conversation (not a bubble); thumbs, then an optional
// comment, then a short thanks that folds away. Asked once per
// conversation; answered or closed → not again for two weeks; never while
// the shopper is typing; a new message makes an unanswered one step aside.
{
  const rateCtx = async (opts) => { const ctx = await browser.newContext(opts); const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message)); return { ctx, page, errors }; };
  const say = async (page, q) => {
    const before = await page.$$eval(".ai-chat-msg--assistant", (m) => m.length);
    await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", q);
    await page.keyboard.press("Enter");
    await page.waitForFunction((n) => document.querySelectorAll(".ai-chat-msg--assistant").length > n, before, { timeout: 6000 });
    await page.waitForTimeout(250);
  };
  for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 800 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
    const { ctx, page, errors } = await rateCtx(opts);
    const fb0 = feedbackBodies.length;
    await page.goto("http://localhost:4789/showcase?rate=3");
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(500);
    await say(page, "hello 1");
    await say(page, "hello 1");
    await page.waitForTimeout(2200);
    check(`chat rating (${label}): not before the store's number of replies`, (await page.$$(".ai-chat-rate")).length === 0);
    await say(page, "hello 1");
    await page.waitForSelector(".ai-chat-rate.is-in", { timeout: 4000 });
    await page.waitForTimeout(450);
    await page.screenshot({ path: out(`rate-${label}-ask`) });
    const a = await page.evaluate(() => {
      const r = document.querySelector(".ai-chat-rate"), m = document.querySelector(".ai-chat-messages"), card = r.querySelector(".ai-chat-rate__card");
      const rr = card.getBoundingClientRect(), mr = m.getBoundingClientRect(), last = [...m.children].filter((x) => x.classList.contains("ai-chat-msg")).pop();
      return { text: r.querySelector(".ai-chat-rate__q").textContent, votes: [...r.querySelectorAll("[data-rate]")].map((b) => b.getAttribute("aria-label")).join("|"), x: !!r.querySelector("[data-rate-x]"),
        afterLast: !!(last.compareDocumentPosition(r) & 4), notBubble: !r.closest(".ai-chat-msg") && !r.querySelector(".ai-chat-msg-bubble"), height: Math.round(rr.height),
        centered: Math.abs((rr.left - mr.left) - (mr.right - rr.right)) < 3, inside: rr.left >= mr.left && rr.right <= mr.right, font: parseFloat(getComputedStyle(r.querySelector(".ai-chat-rate__q")).fontSize),
        bubbleFont: parseFloat(getComputedStyle(document.querySelector(".ai-chat-msg-bubble p")).fontSize), tap: Math.min(...[...r.querySelectorAll("button")].map((b) => b.getBoundingClientRect().height)) };
    });
    check(`chat rating (${label}): after the 3rd reply, one quiet line asks "How's the chat going?" with thumbs`, a.text === "How’s the chat going?" && a.votes === "Going well|Not great" && a.x && a.afterLast && a.notBubble, JSON.stringify(a));
    check(`chat rating (${label}): compact, centered, smaller than the chat text, still easy to tap`, a.height <= 48 && a.centered && a.inside && a.font < a.bubbleFont && a.tap >= 28, JSON.stringify(a));
    check(`chat rating (${label}): nothing is sent until they answer`, feedbackBodies.length === fb0);
    await page.click('.ai-chat-rate [data-rate="up"]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: out(`rate-${label}-voted`) });
    const v = await page.evaluate(() => { const r = document.querySelector(".ai-chat-rate"); const i = r.querySelector(".ai-chat-rate__input"); return { state: r.getAttribute("data-state"), q: r.querySelector(".ai-chat-rate__q").textContent, input: !!i, placeholder: i && i.placeholder, sendOff: r.querySelector(".ai-chat-rate__send").disabled, focused: document.activeElement === i, height: Math.round(r.getBoundingClientRect().height) }; });
    const vote = feedbackBodies[fb0];
    check(`chat rating (${label}): a thumb records the rating for the whole chat right away`, vote && vote.kind === "chat" && vote.vote === "up" && !vote.comment && Array.isArray(vote.conversation) && vote.conversation.length >= 3 && /^sess_/.test(vote.session), JSON.stringify(vote));
    check(`chat rating (${label}): then an optional one-line comment (keyboard not forced open on a phone)`, v.state === "voted" && v.q === "Thanks! Anything to add?" && v.input && v.placeholder === "Add a comment (optional)" && v.sendOff && v.focused === (label === "desktop") && v.height <= 100, JSON.stringify(v));
    await page.fill(".ai-chat-rate__input", "Loved the boot picks");
    check(`chat rating (${label}): send turns on once there's a comment`, !(await page.$eval(".ai-chat-rate__send", (b) => b.disabled)));
    await page.press(".ai-chat-rate__input", "Enter");
    await page.waitForTimeout(300);
    const c = feedbackBodies[fb0 + 1];
    check(`chat rating (${label}): the comment is sent with the same rating`, c && c.kind === "chat" && c.vote === "up" && c.comment === "Loved the boot picks" && c.session === vote.session, JSON.stringify(c));
    check(`chat rating (${label}): a short thanks`, (await page.$eval(".ai-chat-rate", (r) => r.getAttribute("data-state") + "|" + r.textContent.trim())) === "done|Thanks for the feedback");
    await page.waitForTimeout(3900);
    check(`chat rating (${label}): the thanks folds away`, (await page.$$(".ai-chat-rate")).length === 0);
    await say(page, "hello 1");
    await page.waitForTimeout(2200);
    check(`chat rating (${label}): not asked again in this conversation`, (await page.$$(".ai-chat-rate")).length === 0);
    // A new conversation within two weeks of answering: not asked.
    const quiet = await page.evaluate(() => Date.now() - Number(localStorage.getItem("hajirai_rate_done") || 0) < 60000);
    check(`chat rating (${label}): answering starts a two-week quiet period`, quiet);
    check(`chat rating (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // Closed with ×: gone, nothing sent, quiet for two weeks.
  {
    const { ctx, page, errors } = await rateCtx({ viewport: { width: 1280, height: 800 } });
    const fb0 = feedbackBodies.length;
    await page.goto("http://localhost:4789/showcase?rate=2");
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(500);
    await say(page, "hello 1");
    await say(page, "hello 1");
    await page.waitForSelector(".ai-chat-rate.is-in", { timeout: 4000 });
    await page.click(".ai-chat-rate [data-rate-x]");
    await page.waitForTimeout(600);
    const x = await page.evaluate(() => ({ gone: !document.querySelector(".ai-chat-rate"), quiet: !!localStorage.getItem("hajirai_rate_done") }));
    check("chat rating: × closes it, sends nothing, and it stays quiet for two weeks", x.gone && x.quiet && feedbackBodies.length === fb0, JSON.stringify(x));
    // Comment skipped: × after a thumb → the thanks, only the vote sent.
    await page.evaluate(() => { localStorage.removeItem("hajirai_rate_done"); Object.keys(localStorage).filter((k) => k.startsWith("hajirai_rate_")).forEach((k) => localStorage.removeItem(k)); });
    await say(page, "hello 1");
    await page.waitForSelector(".ai-chat-rate.is-in", { timeout: 4000 });
    await page.click('.ai-chat-rate [data-rate="down"]');
    await page.waitForTimeout(300);
    const dq = await page.$eval(".ai-chat-rate__q", (q) => q.textContent);
    await page.click(".ai-chat-rate [data-rate-x]");
    await page.waitForTimeout(300);
    check("chat rating: a thumbs-down asks what could be better; skipping the comment keeps just the vote", dq === "Sorry about that. What could we do better?" && (await page.$eval(".ai-chat-rate", (r) => r.getAttribute("data-state"))) === "done" && feedbackBodies.length === fb0 + 1 && feedbackBodies.at(-1).vote === "down" && !feedbackBodies.at(-1).comment, JSON.stringify(feedbackBodies.slice(fb0)));
    check("chat rating: no JS errors (closing)", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // Typing: it waits. A new message: an unanswered one steps aside.
  {
    const { ctx, page, errors } = await rateCtx({ viewport: { width: 1280, height: 800 } });
    await page.goto("http://localhost:4789/showcase?rate=2");
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(500);
    await say(page, "hello 1");
    await say(page, "hello 1");
    await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "and in wide");
    await page.waitForTimeout(2300);
    check("chat rating: never pops up while the shopper is typing", (await page.$$(".ai-chat-rate")).length === 0);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".ai-chat-msg--assistant").length >= 3, null, { timeout: 6000 });
    await page.waitForSelector(".ai-chat-rate.is-in", { timeout: 4000 });
    check("chat rating: it comes after the next reply instead", true);
    await say(page, "hello 1");
    await page.waitForTimeout(600);
    check("chat rating: a new message while it's unanswered — it steps aside", (await page.$$(".ai-chat-rate")).length === 0);
    check("chat rating: no JS errors (typing)", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
}
{
  // Storepoint can't load: a tappable link to the locator page.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.route("https://cdn.storepoint.co/**", (r) => r.abort());
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(600);
  await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "storesnear");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-map]", { timeout: 5000 });
  await page.click("[data-map]");
  await page.waitForTimeout(1500);
  const fail = await page.evaluate(() => { const a = document.querySelector(".ai-chat-fbsheet__alt"); if (!a) return null; const r = a.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { href: a.getAttribute("href"), text: a.textContent, tappable: top === a || a.contains(top), msg: document.querySelector(".ai-chat-fbsheet__msg").textContent }; });
  check("store map: if it can't load, a tappable link to the store locator page", fail && fail.href === "/pages/store-locator" && fail.tappable && /couldn’t open/.test(fail.msg), JSON.stringify(fail));
  // On the store locator page itself: to that page's own map, chat closed.
  await page.goto("http://localhost:4789/full");
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<div style="height:1500px"></div><div id="storepoint-container" data-map-id="15ecd30bd8acd4" style="height:400px">page map</div><div style="height:1500px"></div>'));
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(600);
  await page.click("[data-map]");
  await page.waitForTimeout(1200);
  const onPage = await page.evaluate(() => ({ chatOpen: document.querySelector(".ai-chat-panel").classList.contains("open"), sheet: !!document.querySelector(".ai-chat-fbsheet:not([hidden]).is-open"), mapTop: Math.round(document.getElementById("storepoint-container").getBoundingClientRect().top) }));
  check("store map: on the locator page, the button goes to that page's map", !onPage.chatOpen && !onPage.sheet && Math.abs(onPage.mapTop) < 40, JSON.stringify(onPage));
  await ctx.close();
}
// Typeform can't load: the sheet says so and offers the survey in a new tab.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.route("https://embed.typeform.com/**", (r) => r.abort());
  await page.goto("http://localhost:4789/full?fb=1");
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<iframe id="launcher" style="position:fixed;right:20px;bottom:20px;width:60px;height:40px"></iframe>'));
  check("feedback: the live chat button stays when that switch is off", await page.evaluate(() => getComputedStyle(document.querySelector("iframe#launcher")).display !== "none"));
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(600);
  await page.click("[data-feedback]");
  await page.waitForTimeout(11000);
  const alt = await page.evaluate(() => { const a = document.querySelector(".ai-chat-fbsheet__alt"); return a && { href: a.getAttribute("href"), target: a.target }; });
  check("feedback: if Typeform can't load, it offers the survey in a new tab", alt && /^https:\/\/form\.typeform\.com\/to\/jdXBrXMa/.test(alt.href) && alt.target === "_blank", JSON.stringify(alt));
  await ctx.close();
}
// Returns hold up whatever the shopper does: reload half-way, lose the
// connection at the worst moment, double-tap, get signed out, come back later.
{
  for (const k of Object.keys(startedReturns)) delete startedReturns[k];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: "signedin", value: "1", url: "http://localhost:4789" }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const open = async () => { await page.click(".ai-chat-launcher__text"); await page.waitForTimeout(500); };
  const ask = async (q) => { await page.fill(".ai-chat-input-area textarea", q); await page.keyboard.press("Enter"); };
  await page.goto("http://localhost:4789/full?login=Ann");
  await open();
  await ask("I want to return something");
  const last = '.ai-chat-msg:last-child .ai-ord[data-ord="5001"]';
  await page.waitForSelector(`${last} [data-ord-return]`, { timeout: 6000 });
  await page.click(`${last} [data-ord-return]`);
  await page.click(`${last} [data-ret-item="9001"]`);
  await page.click(`${last} [data-ret-next="reason"]`);
  await page.click(`${last} [data-ret-reason="too_large"]`);
  await page.click(`${last} [data-ret-method="usps"]`);
  await page.click(`${last} [data-ret-next="confirm"]`);
  // 1. Reload half-way: the cards come back and so does the return, at the same step.
  await page.reload();
  await open();
  await page.waitForSelector('.ai-ord[data-ord="5001"] [data-ret-submit]', { timeout: 6000 });
  const kept = await page.textContent('.ai-ord[data-ord="5001"] .ai-ret__summary');
  check("reload: the order cards come back with the chat", (await page.$$(".ai-ord[data-ord]")).length === 2);
  check("reload: the return picks up at the same step with the same choices", /Savannah/.test(kept) && /Reason: Too large/.test(kept) && /Send back: USPS drop-off/.test(kept), kept);
  // 2. The connection drops right after the store started the return.
  mockCtl.dropNextPost = true;
  const posts = returnBodies.length;
  await page.click('.ai-ord[data-ord="5001"] [data-ret-submit="return"]');
  await page.waitForSelector('.ai-ord[data-ord="5001"] .ai-ret--started', { timeout: 8000 });
  // (The browser itself may resend the request on a reset connection — the
  // store must still end up with exactly one return.)
  check("lost connection: the chat checks, finds the return went through and shows it — one return, not two", /Return started · #R\d+/.test(await page.textContent('.ai-ord[data-ord="5001"] .ai-ret--started')) && startedReturns["5001"].length === 1 && returnBodies.length >= posts + 1, JSON.stringify({ n: startedReturns["5001"]?.length, posts: returnBodies.length - posts, txt: await page.textContent('.ai-ord[data-ord="5001"] .ai-ret--started') }));
  check("lost connection: the label for the chosen method is right there", /^https:\/\/label\.example\//.test(await page.getAttribute('.ai-ord[data-ord="5001"] .ai-ret--started a.ai-ord__btn', "href") || ""));
  // 3. Come back later: the card still shows the return, nothing to redo.
  await page.reload();
  await open();
  await page.waitForSelector('.ai-ord[data-ord="5001"] .ai-ret--started', { timeout: 6000 });
  check("later: the return is still shown on the card after a reload", /USPS drop-off/.test(await page.textContent('.ai-ord[data-ord="5001"] .ai-ret--started')));
  await page.screenshot({ path: out("returns-started-after-reload") });
  // 4. Double tap on the second item: one return, not two.
  mockCtl.slowPostMs = 600;
  await page.click('.ai-ord[data-ord="5001"] [data-ord-return]');
  await page.waitForSelector('.ai-ord[data-ord="5001"] [data-ret-item="9002"][aria-checked="true"]');
  await page.click('.ai-ord[data-ord="5001"] [data-ret-next="reason"]');
  await page.click('.ai-ord[data-ord="5001"] [data-ret-reason="damaged"]');
  await page.click('.ai-ord[data-ord="5001"] [data-ret-next="confirm"]');
  await page.dblclick('.ai-ord[data-ord="5001"] [data-ret-submit="return"]');
  await page.waitForFunction(() => document.querySelectorAll('.ai-ord[data-ord="5001"] .ai-ret--started').length === 2, null, { timeout: 6000 });
  mockCtl.slowPostMs = 0;
  check("double tap: one return for the item", startedReturns["5001"].length === 2 && !(await page.$('.ai-ord[data-ord="5001"] [data-ord-return]')));
  // 5. Asking again shows the same state everywhere.
  await ask("where is my order?");
  await page.waitForFunction(() => document.querySelectorAll('.ai-chat-msg:last-child .ai-ord[data-ord="5001"] .ai-ret--started').length === 2, null, { timeout: 6000 });
  check("asking again: both returns shown, no Return button", !(await page.$(`${last} [data-ord-return]`)));
  const order = await page.$eval('.ai-chat-msg:last-child .ai-ord[data-ord="5001"]', (c) => [...c.children].map((n) => n.className.split(" ")[0]).join(">"));
  check("card layout: items, then Track package, then the returns started", /ai-ord__items>ai-ord__actions>ai-ret>ai-ret$/.test(order), order);
  check("returns hold up: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// Returns in the chat turned off: the card opens the store's returns page.
{
  for (const k of Object.keys(startedReturns)) delete startedReturns[k];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: "signedin", value: "1", url: "http://localhost:4789" }]);
  const page = await ctx.newPage();
  await page.goto("http://localhost:4789/full?login=Ann");
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(500);
  await page.fill(".ai-chat-input-area textarea", "I want to return something on the returns page");
  await page.keyboard.press("Enter");
  await page.waitForSelector('.ai-ord[data-ord="5001"]', { timeout: 6000 });
  const btn = await page.$eval('.ai-ord[data-ord="5001"] .ai-ord__actions', (a) => [...a.children].map((c) => c.tagName + ":" + c.textContent + ":" + (c.getAttribute("href") || "")));
  check("returns off: the card offers Start a return, opening the prefilled returns page", btn.includes("A:Start a return:https://returns.example/?order-number=1171674") && !btn.some((b) => /Return an item/.test(b)), btn.join(" | "));
  check("returns off: no in-chat return button on any card", !(await page.$("[data-ord-return]")));
  check("returns off: an order that isn't delivered gets no return button", !(await page.$('.ai-ord[data-ord="5002"] .ai-ord__actions a[href*="returns.example"]')));
  await ctx.close();
}
// Signed out half-way: sign in again and finish where they left off.
{
  for (const k of Object.keys(startedReturns)) delete startedReturns[k];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: "signedin", value: "1", url: "http://localhost:4789" }]);
  const page = await ctx.newPage();
  await page.goto("http://localhost:4789/full?login=Ann");
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(500);
  await page.fill(".ai-chat-input-area textarea", "I want to return something");
  await page.keyboard.press("Enter");
  const card = '.ai-ord[data-ord="5001"]';
  await page.waitForSelector(`${card} [data-ord-return]`, { timeout: 6000 });
  await page.click(`${card} [data-ord-return]`);
  await page.click(`${card} [data-ret-item="9002"]`);
  await page.click(`${card} [data-ret-next="reason"]`);
  await page.click(`${card} [data-ret-reason="damaged"]`);
  await page.click(`${card} [data-ret-next="confirm"]`);
  await ctx.clearCookies();
  await page.click(`${card} [data-ret-submit="return"]`);
  await page.waitForSelector(`${card} .ai-ret [data-ord-login]`, { timeout: 6000 });
  check("signed out: asked to sign in again, choices kept", /sign in again/i.test(await page.textContent(`${card} .ai-ret`)));
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.click(`${card} .ai-ret [data-ord-login]`)]);
  await popup.waitForEvent("close", { timeout: 8000 }).catch(() => {});
  await page.waitForSelector('.ai-chat-msg:last-child .ai-ord[data-ord="5001"] [data-ret-submit]', { timeout: 10000 });
  const resumed = await page.textContent('.ai-chat-msg:last-child .ai-ord[data-ord="5001"] .ai-ret__summary');
  check("signed in again: the return is waiting at the last step", /Orthotics/.test(resumed) && /Damaged/.test(resumed), resumed);
  await page.click('.ai-chat-msg:last-child .ai-ord[data-ord="5001"] [data-ret-submit="return"]');
  await page.waitForSelector('.ai-chat-msg:last-child .ai-ord[data-ord="5001"] .ai-ret--started', { timeout: 6000 });
  check("signed in again: the return goes through", (startedReturns["5001"] || []).length === 1);
  await ctx.close();
}
// Shopify's sign-in cuts the pop-up's link back to the chat (COOP).
for (const coop of ["1", "2"]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:4789/full?coop=${coop}`);
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(500);
  await page.fill(".ai-chat-input-area textarea", "where is my order?");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-ord-login]", { timeout: 6000 });
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.click("[data-ord-login]")]);
  if (coop === "2") {
    await popup.waitForURL(/\/account$/, { timeout: 6000 }).catch(() => {});
    await popup.close();
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  }
  const ok = await page.waitForSelector(".ai-ord[data-ord]", { timeout: 8000 }).then(() => true).catch(() => false);
  check(coop === "1"
    ? "sign-in: the chat continues even when Shopify cuts the pop-up's link back (no refresh)"
    : "sign-in: the chat continues when the shopper closes the sign-in window and comes back (no refresh)", ok && page.url().includes("/full"), page.url());
  await ctx.close();
}
// Pop-ups blocked: sign-in runs in the same tab and the chat resumes on return.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => { window.open = () => null; });
  const page = await ctx.newPage();
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(500);
  await page.fill(".ai-chat-input-area textarea", "track my order");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-ord-login]", { timeout: 6000 });
  await page.click("[data-ord-login]");
  await page.waitForSelector(".ai-ord[data-ord]", { timeout: 10000 });
  check("sign-in without pop-ups: back on the same page, chat open with the orders", page.url().endsWith("/full") && await page.evaluate(() => document.querySelector(".ai-chat-panel").classList.contains("open")), page.url());
  await page.screenshot({ path: out("orders-phone") });
  await ctx.close();
}
// Seasonal button (Settings → Seasonal button): the first Start here button
// features a collection, with the season's icon in color and a soft tint; a
// tap asks for that collection. Off (or switched off later) → the usual first.
{
  const tilesOf = (page) => page.$$eval(".ai-chat-welcome__cta-btn", (bs) => bs.map((b) => b.textContent.trim()));
  const withSeasonal = (page, seasonalCta, startTheme) => page.route("**/apps/hajirai/widget-config**", async (r) => {
    const res = await r.fetch(); const j = await res.json();
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...j, ...(startTheme ? { startTheme } : {}), seasonalCta }) });
  });
  const plainCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const plainPage = await plainCtx.newPage();
  await plainPage.goto("http://localhost:4789/full");
  await plainPage.click(".ai-chat-launcher");
  await plainPage.waitForSelector(".ai-chat-welcome__cta-btn");
  const usual = await tilesOf(plainPage);
  check("seasonal: off by default — the usual buttons", usual.length >= 2 && !(await plainPage.$(".is-season")), usual.join(" | "));
  await plainCtx.close();

  for (const [theme, season, label, stroke] of [["light", "fall", "Fall Collection Footwear", "rgb(201, 83, 26)"], ["dark", "winter", "Winter Boots & More", "rgb(140, 198, 255)"]]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await withSeasonal(page, { on: true, icon: season, color: season, label }, theme);
    await page.goto("http://localhost:4789/full");
    await page.click(".ai-chat-launcher");
    await page.waitForSelector(".ai-chat-welcome__cta-btn.is-season", { timeout: 8000 });
    await page.waitForFunction((t) => document.querySelector(".ai-chat-panel").getAttribute("data-theme") === t, theme);
    await page.waitForTimeout(400);
    const tiles = await tilesOf(page);
    check(`seasonal (${theme}): takes the place of the first button, the others stay`, tiles[0] === label && tiles.length === usual.length && tiles.slice(1).join("|") === usual.slice(1).join("|"), tiles.join(" | "));
    const look = await page.$eval(".ai-chat-welcome__cta-btn.is-season", (b) => {
      const plain = document.querySelectorAll(".ai-chat-welcome__cta-btn")[1];
      const svg = b.querySelector(".ai-chat-welcome__cta-icon svg");
      return { cls: b.className, icon: svg.getAttribute("class"), w: svg.getBoundingClientRect().width, stroke: getComputedStyle(svg.querySelector(".sx-o")).stroke,
        bg: getComputedStyle(b).backgroundImage, plainBg: getComputedStyle(plain).backgroundImage + getComputedStyle(plain).backgroundColor, msg: b.getAttribute("data-message") };
    });
    check(`seasonal (${theme}): the ${season} icon in its own color, on a soft ${season} tint`,
      look.cls.includes(`sea-${season}`) && look.icon.includes(`ai-sea-ic--${season}`) && look.stroke === stroke && /linear-gradient/.test(look.bg) && !/linear-gradient/.test(look.plainBg) && look.w === 20, JSON.stringify(look));
    await page.screenshot({ path: out(`seasonal-${season}-${theme}`) });
    const before = chatBodies.length;
    await page.click(".ai-chat-welcome__cta-btn.is-season");
    await waitUntil(() => chatBodies.length > before);
    await page.waitForTimeout(300);
    const sent = chatBodies.slice(before);
    check(`seasonal (${theme}): a tap sends its words, marked as the seasonal button`, sent.length === 1 && sent[0].message === label && sent[0].seasonal === true, JSON.stringify(sent.map((b) => ({ m: b.message, s: b.seasonal }))));
    if (theme === "light") {
      await page.waitForSelector(".ai-chat-input-area textarea:not([disabled])", { timeout: 8000 });
      const n = chatBodies.length;
      await page.fill(".ai-chat-input-area textarea", label);
      await page.keyboard.press("Enter");
      await waitUntil(() => chatBodies.length > n);
      check("seasonal: the same words typed aren't marked as a tap", chatBodies.length === n + 1 && chatBodies.at(-1).seasonal === undefined, JSON.stringify(chatBodies.at(-1)?.seasonal));
    }
    check(`seasonal (${theme}): no JS errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // Switched off in Settings: the next visit has the usual first button,
  // even though the last settings (on) were remembered.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(() => localStorage.setItem("hajirai_seasonal_cta", JSON.stringify({ on: true, icon: "fall", color: "fall", label: "Fall Collection Footwear" })));
  const page = await ctx.newPage();
  await withSeasonal(page, { on: false, icon: "fall", color: "fall", label: "Fall Collection" });
  await page.goto("http://localhost:4789/full");
  await page.waitForTimeout(600);
  await page.click(".ai-chat-launcher");
  await page.waitForSelector(".ai-chat-welcome__cta-btn");
  await page.waitForTimeout(300);
  const offTiles = await tilesOf(page);
  check("seasonal: switched off, the usual first button comes back", !(await page.$(".is-season")) && offTiles.join("|") === usual.join("|"), offTiles.join(" | "));
  await ctx.close();
}
await browser.close();
srv.close();
console.log(results.join("\n"));
const failedCount = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failedCount} passed, ${failedCount} failed`);
if (failedCount) process.exit(1);

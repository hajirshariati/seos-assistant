// Widget browser flows: cards, Add to cart (inline size picker, sold out,
// errors), checkout links, showcase/horizontal styles, FITFinder bridge,
// mobile layouts. Run: node scripts/e2e/widget/flows.mjs
import os from "node:os";
import { chromium } from "playwright";
const { start, cartLog, chatBodies, fitSaves, returnBodies, startedReturns, mockCtl, compareLog } = await import("./mock-store.mjs");
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
  check("avatar: on the home screen it's beside the greeting, not in the header", await page.evaluate(() => !!document.querySelector(".ai-chat-welcome__avatar") && document.querySelector(".ai-chat-header__avatar").getBoundingClientRect().width < 2));
  check("icons: a store-picked icon replaces the automatic one", await page.evaluate(() => /M12 20s/.test(document.querySelector(".ai-chat-welcome__cta-icon").innerHTML)));
  await page.fill(".ai-chat-input-area textarea", "show me 1");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);
  check("avatar: once the chat starts it's in the header (and the flying copy is gone)", await page.evaluate(() => { const a = document.querySelector(".ai-chat-header__avatar"); return a.getBoundingClientRect().width > 30 && getComputedStyle(a).opacity === "1" && !document.querySelector(".ai-chat-avatar-ghost"); }));
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
  check(`compare (${label}): values exactly as listed, shared ones once`, t.heel.join("|") === '1.25"|1.5"' && t.helps[0] === "Bunions" && t.helps[1] === "Shared only" && /Both\s*Plantar Fasciitis · Flat Feet/.test(t.both), JSON.stringify(t));
  check(`compare (${label}): differences first, identical rows tucked away`, /^Differences\s*\d+$/.test(t.seg) && t.sameMaterialsHidden, t.seg);
  check(`compare (${label}): fits the width (no sideways scroll)`, t.overflow <= 1, String(t.overflow));
  check(`compare (${label}): opens at its top, not scrolled past`, t.top > -40 && t.top < 200, String(t.top));
  await page.click(".ai-cmp:last-of-type [data-cmp-mode=all]");
  check(`compare (${label}): "All details" shows every row`, await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-cmp")].pop(); return [...c.querySelectorAll(".ai-cmp__row")].every((r) => getComputedStyle(r).display !== "none") && c.querySelector("[data-cmp-mode=all]").getAttribute("aria-checked") === "true"; }));
  // Add to cart from a column: the size picker opens under the table.
  await page.click(".ai-cmp .ai-cmp__buy[data-handle=jillian-black] [data-atc]");
  await page.waitForTimeout(800);
  check(`compare (${label}): Add to cart works from the table (picker under it)`, await page.evaluate(() => { const p = document.querySelector(".ai-chat-atc-panel"); return !!p && p.previousElementSibling?.classList.contains("ai-cmp") && /Jillian/.test(p.textContent); }));
  // More than three cards: pick 2 or 3.
  await page.fill(".ai-chat-input", "many");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  await page.click(".ai-chat-msg:last-child [data-cmp-start]");
  const cards4 = await page.$$(".ai-chat-msg:last-child .ai-chat-product-card");
  const go = ".ai-chat-msg:last-child [data-cmp-go]";
  await cards4[0].click();
  check(`compare (${label}): 4 cards → pick; one pick isn't enough`, (await page.$eval(go, (b) => b.disabled)) && /Pick 1 more/.test(await page.textContent(".ai-chat-msg:last-child .ai-cmp-bar__msg")));
  for (const i of [1, 3, 2]) await cards4[i].click();
  const picked = await page.$$eval(".ai-chat-msg:last-child .ai-chat-product-card.is-cmp-picked", (c) => c.map((x) => x.dataset.handle));
  check(`compare (${label}): three at most`, picked.length === 3 && !picked.includes("orthotic-one") && (await page.textContent(go)) === "Compare 3", JSON.stringify(picked));
  await page.click(go);
  await page.waitForTimeout(900);
  check(`compare (${label}): three side by side`, compareLog.at(-1) === "savannah-red,jillian-black,carly-white" && (await page.$$eval(".ai-cmp:last-of-type .ai-cmp__head", (c) => c.length)) === 3 && (await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-cmp")].pop(); return c.scrollWidth - c.clientWidth; })) <= 1, compareLog.at(-1));
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
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("hajirai_chat_history") || "null"));
  const lastA = Array.isArray(saved) ? [...saved].reverse().find((m) => m.role === "assistant") : null;
  check(`compare (${label}): the chat remembers what was compared`, !!lastA?.comparison && lastA.compared?.[0]?.title === "Savannah Adjustable Quarter Strap Sandal - Red", JSON.stringify(lastA?.compared));
  await page.reload();
  await page.waitForTimeout(700);
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(700);
  check(`compare (${label}): tables come back after a reload`, (await page.$$eval(".ai-cmp", (c) => c.length)) === 3);
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
await browser.close();
srv.close();
console.log(results.join("\n"));
const failedCount = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failedCount} passed, ${failedCount} failed`);
if (failedCount) process.exit(1);

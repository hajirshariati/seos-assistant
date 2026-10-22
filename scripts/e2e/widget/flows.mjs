// Widget browser flows: cards, Add to cart (inline size picker, sold out,
// errors), checkout links, showcase/horizontal styles, FITFinder bridge,
// mobile layouts. Run: node scripts/e2e/widget/flows.mjs
import os from "node:os";
import { chromium } from "playwright";
const { start, cartLog, chatBodies, fitSaves, returnBodies, startedReturns, mockCtl } = await import("./mock-store.mjs");
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
  check("return: other reasons get one Start return button", single.join("|") === "Start return", single.join("|"));
  await page.click(`${fresh} [data-ret-submit="return"]`);
  await page.waitForSelector(`${fresh} .ai-ret__err`, { timeout: 6000 });
  check("return: if it can't be started here, the prefilled returns page is one tap away", (await page.$eval(`${fresh} .ai-ret:not(.ai-ret--started) a.ai-ord__btn`, (a) => a.getAttribute("href"))) === "https://returns.example/?order-number=1171674");
  check("orders & returns: no JS errors", errors.length === 0, errors.join(" | "));
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
  check("returns hold up: no JS errors", errors.length === 0, errors.join(" | "));
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

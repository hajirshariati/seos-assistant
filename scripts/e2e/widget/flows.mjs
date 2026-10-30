// Widget browser flows: cards, Add to cart (inline size picker, sold out,
// errors), checkout links, showcase/horizontal styles, FITFinder bridge,
// mobile layouts. Run: node scripts/e2e/widget/flows.mjs
import os from "node:os";
import { chromium } from "playwright";
const { start, cartLog, buyNowLog, cartUpdates, chatBodies, fitSaves, returnBodies, startedReturns, mockCtl, compareLog, feedbackBodies, viewAllLog, viewAllIndexLog, viewAllCardsLog, BOOT_PRODUCTS, lookupBodies, appQrLog, APP_LINKS, activityLog } = await import("./mock-store.mjs");
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
// 3b) Each message says whether the shopper typed it or a button sent it
// (Test recordings' issues card reads only what shoppers type).
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher__text");
  await page.waitForSelector(".ai-chat-welcome__cta-btn[data-message]");
  let n = chatBodies.length;
  await page.click('.ai-chat-welcome__cta-btn[data-message="which orthotic is right for me?"]');
  await waitUntil(() => chatBodies.length > n);
  check("typed mark: a welcome button's message is marked as not typed", chatBodies.at(-1)?.message === "which orthotic is right for me?" && chatBodies.at(-1)?.typed === false, JSON.stringify({ m: chatBodies.at(-1)?.message, typed: chatBodies.at(-1)?.typed }));
  await page.waitForFunction(() => !document.querySelector(".ai-chat-input-area textarea, .ai-chat-input-area input")?.disabled);
  await page.waitForTimeout(400);
  n = chatBodies.length;
  await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "do you have wide sandals");
  await page.keyboard.press("Enter");
  await waitUntil(() => chatBodies.length > n);
  check("typed mark: what the shopper types is marked as typed", chatBodies.at(-1)?.message === "do you have wide sandals" && chatBodies.at(-1)?.typed === true, JSON.stringify({ m: chatBodies.at(-1)?.message, typed: chatBodies.at(-1)?.typed }));
  check("typed mark: no JS errors", errors.length === 0, errors.join(" | "));
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
// with the chat out of the way. Once it has a size the shopper stays on the
// page (where True Fit marked it): the chat never opens or sends anything by
// itself — the size is only added to the conversation, quietly.
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
  // The finder closes and the size appears; give the chat every chance to (wrongly) react.
  await page.waitForFunction(() => window.AetrexTrueFitTile.state.recommendation, null, { timeout: 8000 });
  await page.waitForTimeout(1500);
  const lastAssistant = () => page.evaluate(() => [...document.querySelectorAll(".ai-chat-msg--assistant")].at(-1)?.textContent || "");
  check("tf: once True Fit has a size, the chat stays closed and sends nothing", !(await page.isVisible(".ai-chat-panel.open")) && chatBodies.length === sent, `open=${await page.isVisible(".ai-chat-panel.open")} sent=${chatBodies.length - sent}`);
  check("tf: the size is added to the conversation, quietly", /True Fit recommends size 9 - 9\.5 US in the Jillian Sandal\. It’s marked in the size list on this page\./.test(await lastAssistant()), await lastAssistant());
  await page.click(".ai-chat-launcher");
  await ask("does it run small?");
  await waitUntil(() => chatBodies.length > sent);
  check("tf: the next question carries the size to the assistant", chatBodies.at(-1)?.history?.some((h) => h.role === "assistant" && /True Fit recommends size 9 - 9\.5 US/.test(h.content)), JSON.stringify(chatBodies.at(-1)?.history?.map((h) => h.content).slice(-3)));

  // From another page: the button opens the shoe's page and True Fit starts there.
  await page.goto("http://localhost:4789/full");
  await page.waitForTimeout(400);
  await page.click(".ai-chat-launcher");
  await ask("what size in the Jillian?");
  await page.waitForSelector(".ai-chat-msg--assistant:last-child [data-truefit]");
  check("tf: on other pages the site is remembered as having True Fit", chatBodies.at(-1)?.size_finder?.page_handle === "", JSON.stringify(chatBodies.at(-1)?.size_finder));
  const away = chatBodies.length;
  await Promise.all([page.waitForURL(/\/products\/jillian-black$/), page.click(".ai-chat-msg--assistant:last-child [data-truefit]")]);
  await page.waitForFunction(() => window.__tfOpens === 1, null, { timeout: 8000 });
  await page.waitForFunction(() => window.AetrexTrueFitTile.state.recommendation, null, { timeout: 8000 });
  await page.waitForTimeout(1500);
  check("tf: on the shoe's page too, the chat stays closed and sends nothing", !(await page.isVisible(".ai-chat-panel.open")) && chatBodies.length === away, `open=${await page.isVisible(".ai-chat-panel.open")} sent=${chatBodies.length - away}`);
  check("tf: …and the size joins the same conversation", /True Fit recommends size 9 - 9\.5 US in the Jillian Sandal/.test(await lastAssistant()), await lastAssistant());

  // The page's own "Find my size" tile is the theme's: using it never involves the chat.
  await page.goto("http://localhost:4789/products/jillian-black");
  await page.waitForTimeout(400);
  const quiet = chatBodies.length;
  const convo = await page.evaluate(() => localStorage.getItem("hajirai_chat_history"));
  await page.click("[data-tf-size-tile]");
  await page.waitForFunction(() => window.AetrexTrueFitTile.state.recommendation, null, { timeout: 8000 });
  await page.waitForTimeout(1500);
  const convoAfter = await page.evaluate(() => localStorage.getItem("hajirai_chat_history"));
  check("tf: the page's own tile — the chat doesn't open, send or note anything", !(await page.isVisible(".ai-chat-panel.open")) && chatBodies.length === quiet && convo === convoAfter, `open=${await page.isVisible(".ai-chat-panel.open")} sent=${chatBodies.length - quiet} changed=${convo !== convoAfter}`);

  // A finder the chat started, then the shopper taps the page's tile themselves
  // while it's still loading: that run is over — nothing reaches the chat.
  await page.goto("http://localhost:4789/products/jillian-black");
  await page.waitForTimeout(400);
  await page.click(".ai-chat-launcher");
  await ask("what size should I get?");
  await page.waitForSelector(".ai-chat-msg--assistant:last-child [data-truefit]");
  const mid = chatBodies.length;
  const notesBefore = await page.$$eval(".ai-chat-msg--assistant", (m) => m.length);
  await page.click(".ai-chat-msg--assistant:last-child [data-truefit]");
  await page.click("[data-tf-size-tile]");
  await page.waitForFunction(() => window.AetrexTrueFitTile.state.recommendation, null, { timeout: 8000 });
  await page.waitForTimeout(1500);
  check("tf: the shopper took over with the page's tile — the chat's run ends, nothing is added", chatBodies.length === mid && (await page.$$eval(".ai-chat-msg--assistant", (m) => m.length)) === notesBefore && !(await page.isVisible(".ai-chat-panel.open")), `sent=${chatBodies.length - mid}`);

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
// "Find my shoe size" with no shoe picked: the server's answer as a card —
// how True Fit works (one shoe at a time) and the store's kinds of shoes per
// line; a tile asks for those shoes, and their cards carry True Fit.
for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 900 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
  const phone = label === "phone";
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem("hajirai_tf_site", "1"); } catch { /* */ } });
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher__text");
  await page.waitForSelector('[data-helper="truefit"]', { timeout: 5000 });
  await page.click('[data-helper="truefit"]');
  await page.waitForSelector(".ai-tfi", { timeout: 5000 });
  await page.waitForTimeout(500);
  const sent = chatBodies.at(-1);
  check(`tf intro (${label}): the tap says it's the helper, with no shoe picked`, sent.message === "Help me find my shoe size with True Fit." && sent.size_intro === true && sent.size_finder?.provider === "truefit" && !sent.size_finder.page_handle, JSON.stringify(sent));
  const card = await page.evaluate(() => {
    const m = [...document.querySelectorAll(".ai-chat-msg")].pop(), c = m.querySelector(".ai-tfi"), list = document.querySelector(".ai-chat-messages");
    const grid = c.querySelector(".ai-tfi__grid:not([hidden])");
    return {
      text: m.querySelector(".ai-chat-msg-bubble > p").textContent,
      title: c.querySelector(".ai-tfi__title").textContent,
      steps: [...c.querySelectorAll(".ai-tfi__step")].map((s) => s.querySelector("b").textContent),
      now: [...c.querySelectorAll(".ai-tfi__step")].map((s) => s.classList.contains("is-now")),
      marks: [...c.querySelectorAll(".ai-tfi__n")].map((n) => (n.querySelector(".ai-tfi__fit") ? "fit" : n.querySelector(".ai-tfi__dot") ? "dot" : "?") + (/\d/.test(n.textContent) ? "#" : "")),
      fitLook: (() => { const f = c.querySelector(".ai-tfi__fit"), fs = getComputedStyle(f), r = f.getBoundingClientRect();
        return { size: `${Math.round(r.width)}x${Math.round(r.height)}`, round: fs.borderRadius, border: fs.borderTopWidth, notAButton: f.tagName === "SPAN" && !f.closest("button") }; })(),
      seg: [...c.querySelectorAll("[data-tfi-show]")].map((b) => `${b.textContent}:${b.getAttribute("aria-checked")}`),
      tiles: [...grid.querySelectorAll(".ai-tfi__tile")].map((t) => `${t.querySelector(".ai-tfi__name").textContent} ${t.querySelector(".ai-tfi__count").textContent}`),
      asks: [...grid.querySelectorAll("[data-tfi-ask]")].map((t) => t.getAttribute("data-tfi-ask")),
      imgs: [...grid.querySelectorAll(".ai-tfi__img img")].length,
      hidden: c.querySelectorAll(".ai-tfi__grid[hidden]").length,
      cols: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
      overflow: c.scrollWidth - c.clientWidth,
      top: Math.round(m.getBoundingClientRect().top - list.getBoundingClientRect().top),
      note: c.querySelector(".ai-tfi__note").textContent,
    };
  });
  check(`tf intro (${label}): the answer says why — one shoe at a time, the shoe first`, /True Fit sizes one shoe at a time, so pick the shoe first/.test(card.text) && card.title === "How True Fit works", card.text);
  check(`tf intro (${label}): three steps, the first one is where they are`, card.steps.join("|") === "Pick a shoe|Tap this button on the shoe|Get your size for that shoe" && card.now.join() === "true,false,false", JSON.stringify(card));
  check(`tf intro (${label}): no numbers — a dot, the True Fit button as the cards show it, a dot`, card.marks.join() === "dot,fit,dot" && card.fitLook.size === "38x38" && card.fitLook.border === "1px" && card.fitLook.notAButton, JSON.stringify({ marks: card.marks, fit: card.fitLook }));
  check(`tf intro (${label}): the store's kinds of shoes, women's first, with style counts and photos`, card.seg.join("|") === "Women's:true|Men's:false" && card.tiles.join("|") === "Sneakers 9 styles|Sandals 7 styles|Boots 5 styles|Loafers 4 styles|Wedges 3 styles|Slippers 2 styles" && card.imgs === 6 && card.hidden === 1, JSON.stringify(card));
  check(`tf intro (${label}): ${phone ? 2 : 3} tiles a row, nothing spills sideways`, card.cols === (phone ? 2 : 3) && card.overflow <= 1, JSON.stringify({ cols: card.cols, overflow: card.overflow }));
  check(`tf intro (${label}): opens at its top, so the steps are read first`, card.top > -40 && card.top < 120, String(card.top));
  check(`tf intro (${label}): typing a shoe's name is offered too`, /type its name/.test(card.note));
  await page.click('[data-tfi-show="men"]');
  const men = await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-tfi")].pop(); return { seg: [...c.querySelectorAll("[data-tfi-show]")].map((b) => b.getAttribute("aria-checked")).join(), shown: c.querySelector(".ai-tfi__grid:not([hidden])").getAttribute("data-tfi-grid"), first: c.querySelector(".ai-tfi__grid:not([hidden]) .ai-tfi__tile").getAttribute("aria-label") }; });
  check(`tf intro (${label}): Men's switches the tiles`, men.seg === "false,true" && men.shown === "men" && men.first === "Men's Sneakers, 4 styles", JSON.stringify(men));
  await page.click('.ai-tfi__grid:not([hidden]) [data-tfi-ask]');
  await page.waitForFunction(() => document.querySelectorAll(".ai-chat-msg:last-child .ai-chat-product-card").length >= 1, null, { timeout: 5000 });
  const pick = chatBodies.at(-1);
  check(`tf intro (${label}): a tile asks for those shoes, saying what it's for`, pick.message === "Show me men's sneakers" && pick.size_pick === true && !pick.size_intro, JSON.stringify(pick));
  check(`tf intro (${label}): the shoes that come back each have True Fit`, (await page.$$eval(".ai-chat-msg:last-child .ai-chat-product-card", (cs) => cs.filter((c) => c.querySelector("[data-truefit]")).length)) >= 2);
  if (!phone) {
    // Typing the same words isn't the tap.
    await page.fill(".ai-chat-input", "Help me find my shoe size with True Fit.");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
    check(`tf intro (${label}): typed, the words go to the assistant as usual`, chatBodies.at(-1).size_intro === undefined && chatBodies.at(-1).size_pick === undefined);
    // The card comes back with the chat.
    await page.reload();
    await page.click(".ai-chat-launcher__text");
    await page.waitForSelector(".ai-tfi", { timeout: 5000 });
    check(`tf intro (${label}): after a reload the card is still there, tiles and all`, (await page.$$eval(".ai-tfi .ai-tfi__tile", (t) => t.length)) === 12);
  }
  check(`tf intro (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// A chat left alone for a day starts fresh: a shopper back next week sees the
// chat's home screen, not last week's conversation. A recent chat comes back;
// a chat saved before the clock existed gets its clock started; a tab left
// open overnight opens on the home screen too.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full");
  const old = [{ role: "user", content: "boots please" }, { role: "assistant", content: "Here are our warmest boots from last week.", products: [] }];
  const seed = (at) => page.evaluate(([h, t]) => {
    localStorage.setItem("hajirai_chat_history", JSON.stringify(h));
    localStorage.setItem("hajirai_chat_session", "sess_old");
    if (t) localStorage.setItem("hajirai_chat_at", String(t)); else localStorage.removeItem("hajirai_chat_at");
  }, [old, at]);
  const look = () => page.evaluate(() => ({
    welcome: Boolean(document.querySelector(".ai-chat-welcome")),
    old: document.querySelector(".ai-chat-messages, .ai-chat-msgs, .ai-chat-panel")?.textContent.includes("warmest boots from last week") || false,
    history: localStorage.getItem("hajirai_chat_history"),
    session: localStorage.getItem("hajirai_chat_session"),
    at: localStorage.getItem("hajirai_chat_at"),
  }));
  const reopen = async () => { await page.reload(); await page.click(".ai-chat-launcher__text"); await page.waitForTimeout(500); };
  await seed(Date.now() - 2 * 864e5);
  await reopen();
  const a = await look();
  check("a day without messages: the chat opens on its home screen, the old chat and session gone", a.welcome && !a.old && !a.history && a.session !== "sess_old", JSON.stringify(a));
  await seed(Date.now() - 2 * 3600e3);
  await reopen();
  const b = await look();
  check("a chat from two hours ago comes back as it was", b.old && !b.welcome && b.session === "sess_old", JSON.stringify(b));
  await seed(null);
  await reopen();
  const c = await look();
  check("a chat saved before the clock existed comes back, and its clock starts now", c.old && Math.abs(Date.now() - Number(c.at)) < 60e3, JSON.stringify(c));
  // Left open in a tab: the next open after a day starts fresh.
  await page.click(".ai-chat-close-btn");
  await page.waitForTimeout(300);
  await page.evaluate(() => localStorage.setItem("hajirai_chat_at", String(Date.now() - 2 * 864e5)));
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(500);
  const d = await look();
  check("a tab left open overnight: the next open is the home screen", d.welcome && !d.old, JSON.stringify(d));
  check("fresh after a day: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// A reopened chat reads the same: everything under a reply comes back with
// it after a reload — the sign-in / look-up card, True Fit's button, the FIT
// result, quick replies — and only the last reply's choices stay tappable.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(500);
  const send = async (t, sel) => {
    const n = await page.$$eval(".ai-chat-msg.assistant, .ai-chat-msg--assistant, [data-role=assistant]", (x) => x.length).catch(() => 0);
    await page.fill(".ai-chat-input", t);
    await page.keyboard.press("Enter");
    if (sel) await page.waitForSelector(sel, { timeout: 6000 });
    await page.waitForTimeout(600);
    return n;
  };
  await send("full", ".ai-chat-suggestions");
  const qr = await page.evaluate(() => { const s = document.querySelector(".ai-chat-suggestions"), l = s.querySelector(".ai-chat-suggestions-label"); return { top: getComputedStyle(s).borderTopWidth, style: getComputedStyle(s).borderTopStyle, rule: getComputedStyle(l, "::after").height }; });
  check("quick replies: one line beside the label, none above the section", (qr.top === "0px" || qr.style === "none") && qr.rule === "1px", JSON.stringify(qr));
  await send("where is my order #1172010?", ".ai-ordl");
  await send("what size am I", ".ai-chat-truefit-cta");
  await send("fit please");
  const snap = () => page.evaluate(() => ({
    lookup: [...document.querySelectorAll(".ai-ordl .ai-ordl__opt b")].map((b) => b.textContent).join("|"),
    order: document.querySelector(".ai-ordl [name=order]")?.value || "",
    trueFit: document.querySelectorAll(".ai-chat-truefit-cta").length,
    fit: document.querySelectorAll(".ai-chat-fit-result").length,
    quick: document.querySelectorAll(".ai-chat-suggestions").length,
    staleQuick: document.querySelectorAll(".ai-chat-suggestions.is-stale").length,
    cards: document.querySelectorAll(".ai-chat-product-card").length,
    link: document.querySelectorAll(".ai-chat-msg-bubble a.ai-chat-cta-btn, .ai-chat-msg-bubble .ai-chat-cta-btn[href]").length,
  }));
  const before = await snap();
  await page.reload();
  await page.click(".ai-chat-launcher__text");
  await page.waitForSelector(".ai-ordl", { timeout: 5000 });
  await page.waitForTimeout(400);
  const after = await snap();
  check("reopened chat: the sign-in / look-up card comes back, rows and order number too", after.lookup === "Sign in|Look up an order|Tracking page" && after.order === "1172010", JSON.stringify(after));
  check("reopened chat: True Fit's button, the FIT result, the cards and links come back", after.trueFit === before.trueFit && after.trueFit === 1 && after.fit === before.fit && after.cards === before.cards && after.link === before.link, JSON.stringify({ before, after }));
  check("reopened chat: earlier quick replies come back faded, not tappable", after.quick === 1 && after.staleQuick === 1, JSON.stringify(after));
  check("reopened chat: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// Order status without signing in: one card, two ways in — sign in, or look
// one order up with its number (or confirmation code) and email. The form
// goes straight to the store, never through the chat; the order is shown,
// never saved; the assistant learns its status (not the email) for follow-ups.
for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 900 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
  const phone = label === "phone";
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  mockCtl.lookupTries = null;
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(500);
  await page.fill(".ai-chat-input", "where is my order #1172010?");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ai-ordl", { timeout: 6000 });
  const card0 = await page.evaluate(() => {
    const c = document.querySelector(".ai-ordl"), rows = [...c.querySelectorAll(".ai-ordl__opt")];
    return { title: c.querySelector(".ai-ord__num").textContent, rows: rows.map((r) => r.querySelector("b").textContent), signIn: rows[0].getAttribute("data-ord-login"), expanded: rows[1].getAttribute("aria-expanded"), formHidden: c.querySelector(".ai-ordl__form").hidden, order: c.querySelector("[name=order]").value, overflow: c.scrollWidth - c.clientWidth, track: rows[2]?.getAttribute("href"), trackSub: rows[2]?.querySelector(".ai-ordl__ot span")?.textContent, trackTab: rows[2]?.getAttribute("target") };
  });
  check(`order lookup (${label}): signed out, one card — Sign in, Look up an order, or the store's tracking page`, card0.title === "Check on your order" && card0.rows.join("|") === "Sign in|Look up an order|Tracking page" && card0.signIn === "track" && card0.expanded === "false" && card0.formHidden && card0.overflow <= 1, JSON.stringify(card0));
  check(`order lookup (${label}): the tracking page opens in a new tab, named by its address`, card0.track === "https://orders.example.com/" && card0.trackSub === "orders.example.com" && card0.trackTab === "_blank", JSON.stringify(card0));
  check(`order lookup (${label}): the order number they mentioned is filled in (never an email)`, card0.order === "1172010", card0.order);
  await page.click("[data-ordl-open]");
  const opened = await page.evaluate(() => ({ expanded: document.querySelector("[data-ordl-open]").getAttribute("aria-expanded"), hidden: document.querySelector(".ai-ordl__form").hidden, focus: document.activeElement?.getAttribute("name"), font: getComputedStyle(document.querySelector("[name=email]")).fontSize, type: document.querySelector("[name=email]").type, auto: document.querySelector("[name=email]").autocomplete }));
  check(`order lookup (${label}): the form opens under its row, focus on what's left to fill`, opened.expanded === "true" && !opened.hidden && opened.focus === "email", JSON.stringify(opened));
  check(`order lookup (${label}): a real email field, 16px so phones don't zoom`, opened.type === "email" && opened.auto === "email" && opened.font === "16px", JSON.stringify(opened));
  // Empty / malformed: said per field, nothing sent.
  const sentBefore = lookupBodies.length;
  await page.fill("[name=order]", "");
  await page.click(".ai-ordl__go");
  const bad = await page.evaluate(() => ({ o: document.querySelector("[name=order]").getAttribute("aria-invalid"), e: document.querySelector("[name=email]").getAttribute("aria-invalid"), msgs: [...document.querySelectorAll(".ai-ordl__ferr:not([hidden])")].map((x) => x.textContent), focus: document.activeElement?.getAttribute("name") }));
  check(`order lookup (${label}): empty fields say what's needed, focus on the first, nothing sent`, bad.o === "true" && bad.e === "true" && bad.msgs.length === 2 && bad.focus === "order" && lookupBodies.length === sentBefore, JSON.stringify(bad));
  // Wrong details: the same answer whatever was wrong; what they typed stays.
  const chatsBefore = chatBodies.length;
  await page.fill("[name=order]", "1172099");
  await page.fill("[name=email]", "pat@example.com");
  await page.click(".ai-ordl__go");
  await page.waitForFunction(() => !document.querySelector(".ai-ordl__err").hidden, null, { timeout: 5000 });
  const miss = await page.evaluate(() => ({ err: document.querySelector(".ai-ordl__err").textContent, role: document.querySelector(".ai-ordl__err").getAttribute("role"), order: document.querySelector("[name=order]").value, invalid: document.querySelectorAll("[aria-invalid=true]").length, card: !!document.querySelector(".ai-ord[data-ord]") }));
  check(`order lookup (${label}): not found → one calm message (no hint which detail), inputs kept`, /couldn.t find an order with those details/.test(miss.err) && /last 60 days/.test(miss.err) && miss.role === "alert" && miss.order === "1172099" && miss.invalid === 0 && !miss.card, JSON.stringify(miss));
  check(`order lookup (${label}): sent straight to the store as JSON — never through the chat`, lookupBodies.at(-1).order === "1172099" && lookupBodies.at(-1).email === "pat@example.com" && /application\/json/.test(lookupBodies.at(-1).contentType) && chatBodies.length === chatsBefore, JSON.stringify(lookupBodies.at(-1)));
  // The right details: the order, in place of the form.
  await page.fill("[name=order]", " #1172010 ");
  await page.fill("[name=email]", "Pat@Example.com ");
  await page.click(".ai-ordl__go");
  await page.waitForSelector(".ai-ordl-done", { timeout: 5000 });
  const found = await page.evaluate(() => {
    const d = document.querySelector(".ai-ordl-done"), c = d.querySelector(".ai-ord[data-ord]");
    return { num: c.querySelector(".ai-ord__num").textContent, pill: c.querySelector(".ai-ord__pill").textContent, track: c.querySelector("a.ai-ord__btn")?.textContent, ret: !!c.querySelector("[data-ord-return]"), signRet: c.querySelector("[data-ord-login]")?.getAttribute("data-ord-login"), note: d.querySelector(".ai-ordl__after").textContent, form: !!document.querySelector(".ai-ordl__form"), focus: document.activeElement?.className, overflow: d.scrollWidth - d.clientWidth };
  });
  check(`order lookup (${label}): found → the order's card: status, progress, tracking`, found.num === "Order #1172010" && found.pill === "On its way" && found.track === "Track package" && !found.form && found.overflow <= 1, JSON.stringify(found));
  check(`order lookup (${label}): returns still need sign-in`, !found.ret && found.signRet === "return", JSON.stringify(found));
  check(`order lookup (${label}): the store's returns center is there too (never with the email)`, await page.evaluate(() => { const a = document.querySelector(".ai-ordl-done .ai-ord__alt"); return !!a && a.getAttribute("href") === "https://www.example.com/apps/aftership-returns-center" && /returns center/.test(a.textContent) && a.target === "_blank"; }));
  check(`order lookup (${label}): says it's this order only and not saved; focus moves to the order`, /This order only · not saved/.test(found.note) && /Look up another order/.test(found.note) && /ai-ord__num/.test(found.focus || ""), JSON.stringify(found));
  check(`order lookup (${label}): what they typed was cleaned up before it was sent`, lookupBodies.at(-1).order === "1172010" && lookupBodies.at(-1).email === "Pat@Example.com", JSON.stringify(lookupBodies.at(-1)));
  // Never saved in this browser.
  const stored = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).map((k) => localStorage.getItem(k))) + JSON.stringify(Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k))));
  check(`order lookup (${label}): nothing about it is saved in the browser — no email, no order card`, !/pat@example\.com/i.test(stored) && !/looked up with its number/.test(stored) && !/guest-1172010/.test(stored));
  // The assistant knows the status for follow-ups — never the email.
  await page.fill(".ai-chat-input", "when will it arrive?");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  const hist = JSON.stringify(chatBodies.at(-1).history || []);
  check(`order lookup (${label}): a follow-up question carries the order's status, never the email`, /Order #1172010 \(looked up with its number and email\): On its way, arriving by/.test(hist) && !/pat@example/i.test(JSON.stringify(chatBodies.at(-1))), hist.slice(-300));
  // Look up another: a fresh, empty form.
  await page.click("[data-ordl-again]");
  const again = await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-ordl")].pop(); return { open: !c.querySelector(".ai-ordl__form").hidden, order: c.querySelector("[name=order]").value, email: c.querySelector("[name=email]").value, focus: document.activeElement?.getAttribute("name") }; });
  check(`order lookup (${label}): "Look up another order" opens a fresh, empty form`, again.open && again.order === "" && again.email === "" && again.focus === "order", JSON.stringify(again));
  // Escape folds the form; the chat stays open.
  await page.keyboard.press("Escape");
  const esc = await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-ordl")].pop(); return { hidden: c.querySelector(".ai-ordl__form").hidden, focus: document.activeElement?.hasAttribute("data-ordl-open"), open: document.querySelector(".ai-chat-panel").classList.contains("open") }; });
  check(`order lookup (${label}): Escape folds the form back, the chat stays open`, esc.hidden && esc.focus && esc.open, JSON.stringify(esc));
  if (!phone) {
    // Wanting a return: sign in, the returns center, or the order's status.
    await page.fill(".ai-chat-input", "i want to return my shoes");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ai-chat-msg:last-child .ai-ordl", { timeout: 6000 });
    const ret = await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-chat-msg")].pop().querySelector(".ai-ordl"); return { title: c.querySelector(".ai-ord__num").textContent, rows: [...c.querySelectorAll(".ai-ordl__opt")].map((r) => r.querySelector("b").textContent), signIn: c.querySelector("[data-ord-login]")?.getAttribute("data-ord-login"), returns: c.querySelector('a.ai-ordl__opt')?.getAttribute("href") }; });
    check(`order lookup (${label}): a return → sign in to do it here, the returns center, or the order's status`, ret.title === "Start a return" && ret.rows.join("|") === "Sign in|Returns center|Order status" && ret.signIn === "return" && ret.returns === "https://www.example.com/apps/aftership-returns-center", JSON.stringify(ret));
    // Too many tries: said plainly, with sign-in as the way forward.
    mockCtl.lookupTries = lookupBodies.length;
    await page.click("[data-ordl-open] >> nth=-1");
    await page.fill("[name=order] >> nth=-1", "1172010");
    await page.fill("[name=email] >> nth=-1", "pat@example.com");
    await page.click(".ai-ordl__go >> nth=-1");
    await page.waitForFunction(() => { const e = [...document.querySelectorAll(".ai-ordl__err")].pop(); return e && !e.hidden; }, null, { timeout: 5000 });
    check(`order lookup (${label}): too many tries → wait, or sign in`, /Too many tries/.test(await page.evaluate(() => [...document.querySelectorAll(".ai-ordl__err")].pop().textContent)));
    mockCtl.lookupTries = null;
    // The store turned the lookup off: sign-in only, as before.
    await page.fill(".ai-chat-input", "where is my order? sign-in only");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ai-chat-msg:last-child .ai-ord--signin", { timeout: 6000 });
    check(`order lookup (${label}): lookup off → the sign-in card only`, !(await page.$(".ai-chat-msg:last-child [data-ordl-open]")));
    // After a reload no looked-up order comes back.
    await page.reload();
    await page.click(".ai-chat-launcher__text");
    await page.waitForTimeout(800);
    check(`order lookup (${label}): after a reload no looked-up order is shown`, !(await page.$(".ai-ordl-done")) && !(await page.$('.ai-ord[data-ord^="guest-"]')));
  }
  check(`order lookup (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// Points while signed out: a sign-in card for points; once signed in, the
// chat asks the same question again and answers from their history.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(500);
  await page.fill(".ai-chat-input-area textarea", "were my points restored after my return");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ai-chat-msg:last-child .ai-ord--signin", { timeout: 6000 });
  const card = await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-ord--signin")].pop(); return { title: c.querySelector(".ai-ord__num").textContent, sub: c.querySelector(".ai-ord__date").textContent, login: c.querySelector("[data-ord-login]").getAttribute("data-ord-login"), lookup: !!c.closest(".ai-chat-msg").querySelector(".ai-ordl") }; });
  check("points signed out: a sign-in card for points (no order lookup form)", card.title === "Sign in to see your points" && card.sub === "Your rewards and orders, right here." && card.login === "rewards" && !card.lookup, JSON.stringify(card));
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.click(".ai-chat-msg:last-child [data-ord-login]")]);
  await popup.waitForEvent("close", { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => /4,200 points/.test([...document.querySelectorAll(".ai-chat-msg--assistant")].pop()?.textContent || ""), null, { timeout: 8000 });
  const asked = await page.evaluate(() => [...document.querySelectorAll(".ai-chat-msg--user")].map((m) => m.textContent.trim()));
  check("points: after sign-in the chat asks the same question again and answers it", asked.filter((t) => /were my points restored/.test(t)).length === 2, JSON.stringify(asked));
  check("points: the sign-in card says it's done", !!(await page.$(".ai-ord__signedin")));
  check("points: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// Back in stock: a sold-out size gets a Notify-me card under the reply. The
// email goes from the browser straight to Klaviyo's back-in-stock
// subscription for that Shopify variant; the card remembers it's done.
for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["phone", { width: 375, height: 740 }]]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, ...(label === "phone" ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const klaviyo = [];
  let klaviyoStatus = 202;
  await page.route("https://a.klaviyo.com/**", (r) => { klaviyo.push({ url: r.request().url(), headers: r.request().headers(), body: r.request().postDataJSON() }); return r.fulfill({ status: klaviyoStatus, contentType: "application/json", body: klaviyoStatus === 202 ? "" : JSON.stringify({ errors: [{ detail: "nope" }] }) }); });
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(500);
  await page.fill(".ai-chat-input-area textarea", "when will the miles be back in stock in 13.5");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ai-chat-msg:last-child .ai-bis", { timeout: 6000 });
  const card = await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-bis")].pop(); return { title: c.querySelector(".ai-ord__num").textContent, sub: c.querySelector(".ai-ord__date").textContent, variant: c.getAttribute("data-bis-variant"), input: !!c.querySelector('input[type="email"]'), note: c.querySelector(".ai-bis__note").textContent.trim(), privacy: c.querySelector(".ai-bis__note a")?.getAttribute("href") }; });
  check(`restock (${label}): the Notify-me card names the product and size, with an email field and only a privacy link under it`, card.title === "Get an email when it’s back" && card.sub === "Miles Arch Support Sneaker - Black · 13.5 - 14 US" && card.variant === "51133383639353" && card.input && card.note === "Privacy Policy" && !!card.privacy, JSON.stringify(card));
  if (label === "desktop") {
    const fits = await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-bis")].pop(); const b = c.getBoundingClientRect(), p = c.closest(".ai-chat-msg-bubble").getBoundingClientRect(); return b.right <= p.right + 1 && b.left >= p.left - 1; });
    check("restock (desktop): the card fits the bubble", fits);
  }
  // A bad email: told inline, nothing sent.
  await page.fill(".ai-chat-msg:last-child .ai-bis input", "not-an-email");
  await page.click(".ai-chat-msg:last-child .ai-bis__go");
  await page.waitForTimeout(200);
  const bad = await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-bis")].pop(); return { err: c.querySelector(".ai-bis__err").textContent, hidden: c.querySelector(".ai-bis__err").hidden, invalid: c.querySelector("input").getAttribute("aria-invalid"), focused: document.activeElement === c.querySelector("input") }; });
  check(`restock (${label}): a bad email is said inline, focus back on the field, nothing sent`, bad.err === "Please enter a valid email address." && !bad.hidden && bad.invalid === "true" && bad.focused && klaviyo.length === 0, JSON.stringify(bad));
  // Klaviyo says no: the card says so and lets them try again.
  klaviyoStatus = 500;
  await page.fill(".ai-chat-msg:last-child .ai-bis input", "jo@example.com");
  await page.click(".ai-chat-msg:last-child .ai-bis__go");
  await page.waitForFunction(() => /Couldn’t save that just now/.test([...document.querySelectorAll(".ai-bis__err")].pop()?.textContent || ""), null, { timeout: 4000 });
  const failed = await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-bis")].pop(); return { btn: c.querySelector(".ai-bis__go").textContent, disabled: c.querySelector(".ai-bis__go").disabled, form: !!c.querySelector("form") }; });
  check(`restock (${label}): a failed save is said, the button is back`, failed.btn === "Notify me" && !failed.disabled && failed.form && klaviyo.length === 1, JSON.stringify(failed));
  // It works: one subscription for that exact variant, by email only.
  klaviyoStatus = 202;
  await page.click(".ai-chat-msg:last-child .ai-bis__go");
  await page.waitForSelector(".ai-chat-msg:last-child .ai-bis__done", { timeout: 4000 });
  const sent = klaviyo[1];
  const body = sent?.body?.data;
  check(`restock (${label}): one back-in-stock subscription for that variant, from the browser, with the company id`, klaviyo.length === 2 && /^https:\/\/a\.klaviyo\.com\/client\/back-in-stock-subscriptions\/\?company_id=TESTCO$/.test(sent.url) && sent.headers.revision === "2024-10-15" && body?.type === "back-in-stock-subscription" && JSON.stringify(body.attributes.channels) === '["EMAIL"]' && body.attributes.profile.data.attributes.email === "jo@example.com" && body.relationships.variant.data.id === "$shopify:::$default:::51133383639353" && body.relationships.variant.data.type === "catalog-variant", JSON.stringify(sent));
  const done = await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-bis")].pop(); return { text: c.querySelector(".ai-bis__done").textContent, form: !!c.querySelector("form"), cls: c.className }; });
  check(`restock (${label}): the card says it's done, the form is gone`, /You’re on the list — one email the moment it’s back\./.test(done.text) && !done.form && /is-done/.test(done.cls), JSON.stringify(done));
  check(`restock (${label}): the email is not kept in this browser`, !/jo@example\.com/.test(await page.evaluate(() => JSON.stringify(localStorage))));
  // After a reload the card is still there, still done — no second ask.
  await page.reload();
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(800);
  const again = await page.evaluate(() => { const c = [...document.querySelectorAll(".ai-bis")].pop(); return c ? { done: !!c.querySelector(".ai-bis__done"), form: !!c.querySelector("form"), sub: c.querySelector(".ai-ord__date").textContent } : null; });
  check(`restock (${label}): after a reload the card is back, already done`, !!again && again.done && !again.form && /13\.5 - 14 US/.test(again.sub), JSON.stringify(again));
  check(`restock (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// The store's app: its own small message after the second reply of a visit
// (like the rating question), never again that visit; its button opens a
// QR code (computers) or the phone's own store badge — from the store's
// footer, or from Settings.
{
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36";
  const run = async (label, url, opts, fn) => {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:4789" + url);
    await page.click(".ai-chat-launcher__text");
    await page.waitForTimeout(500);
    const say = async (m) => { await page.fill(".ai-chat-input", m); await page.keyboard.press("Enter"); await page.waitForTimeout(1100); };
    await fn(page, say);
    check(`app message (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  };
  const appShown = (page) => page.waitForSelector(".ai-chat-app.is-in", { timeout: 4000 }).then(() => true, () => false);
  await run("computer", "/full?app=1", { viewport: { width: 1280, height: 900 } }, async (page, say) => {
    await say("show me 2");
    await page.waitForTimeout(1200);
    check("app message: never after the first reply", (await page.$$(".ai-chat-app, .ai-appn")).length === 0);
    await say("show me 3");
    const shown = await appShown(page);
    await page.waitForTimeout(1900);
    const note = await page.evaluate(() => {
      const r = document.querySelector(".ai-chat-app"), m = document.querySelector(".ai-chat-messages"), go = r.querySelector("[data-appn]");
      const rr = r.getBoundingClientRect(), mr = m.getBoundingClientRect(), msgs = [...m.querySelectorAll(".ai-chat-msg")];
      const glow = getComputedStyle(r, "::before");
      return { own: r.parentElement === m && !r.closest(".ai-chat-msg-bubble") && !document.querySelector(".ai-chat-msg-bubble .ai-appn"), afterReply: !!(msgs.pop().compareDocumentPosition(r) & 4),
        text: r.querySelector(".ai-appn__txt").textContent, label: r.getAttribute("aria-label"), button: go.tagName + ":" + go.textContent, expanded: go.getAttribute("aria-expanded"), closed: r.querySelector(".ai-appn__panel").hidden,
        filled: getComputedStyle(go).backgroundColor !== "rgba(0, 0, 0, 0)" && getComputedStyle(go).backgroundColor !== getComputedStyle(r.querySelector(".ai-appn")).backgroundColor, tall: go.getBoundingClientRect().height >= 32,
        x: r.querySelector("[data-appn-x]")?.getAttribute("aria-label"), centered: Math.abs((rr.left - mr.left) - (mr.right - rr.right)) < 3,
        glow: /gradient/.test(glow.backgroundImage) && glow.filter.includes("blur") && +glow.opacity > 0.2 && +glow.opacity < 0.7, glowBehind: glow.zIndex === "-1", rate: !!document.querySelector(".ai-chat-rate") };
    });
    check("app message: its own message after the second reply — the store's name, a real button, closed", shown && note.own && note.afterReply && note.text === "Love Aetrex? You\u2019ll love our app" && note.label === note.text && note.button === "BUTTON:Get it" && note.expanded === "false" && note.closed && note.filled && note.tall && note.x === "Not now" && note.centered, JSON.stringify(note));
    check("app message: a soft glow of color behind it, not on it", note.glow && note.glowBehind, JSON.stringify(note));
    await page.click("[data-appn]");
    const qr = await page.evaluate(() => { const b = document.querySelector(".ai-appn__qrbox"); return b && { src: b.querySelector(".ai-appn__qr img").getAttribute("src"), link: b.querySelector(".ai-appn__qr").getAttribute("href"), cap: b.querySelector(".ai-appn__cap").textContent, seg: [...b.querySelectorAll("[data-appn-pf]")].map((x) => `${x.textContent}:${x.getAttribute("aria-pressed")}`), store: b.querySelector(".ai-appn__store").textContent, badges: document.querySelectorAll(".ai-appn__badge").length, inCard: !!b.closest(".ai-chat-app .ai-appn"), expanded: document.querySelector("[data-appn]").getAttribute("aria-expanded") }; });
    check("app message: its button opens the footer's QR code with an iPhone / Android switch, in the card", !!qr && /app-qr-ios\.svg/.test(qr.src) && qr.link === APP_LINKS.ios && qr.cap === "Scan with your iPhone camera" && qr.seg.join("|") === "iPhone:true|Android:false" && /Or open App Store/.test(qr.store) && qr.badges === 0 && qr.inCard && qr.expanded === "true", JSON.stringify(qr));
    await page.click('[data-appn-pf="android"]');
    const and = await page.evaluate(() => { const b = document.querySelector(".ai-appn__qrbox"); return { src: b.querySelector(".ai-appn__qr img").getAttribute("src"), link: b.querySelector(".ai-appn__qr").getAttribute("href"), cap: b.querySelector(".ai-appn__cap").textContent, store: b.querySelector(".ai-appn__store").getAttribute("href") }; });
    check("app message: Android switches the code, caption and link", /app-qr-android\.svg/.test(and.src) && and.link === APP_LINKS.android && and.store === APP_LINKS.android && /phone.s camera/.test(and.cap), JSON.stringify(and));
    await page.click("[data-appn]");
    check("app message: tapped again, the panel folds away", await page.evaluate(() => document.querySelector(".ai-appn__panel").hidden));
    check("app message: the rating question waits for a later reply", !note.rate);
    await say("show me 2");
    await page.waitForTimeout(1200);
    check("app message: only once a visit — it stays where it was", (await page.$$(".ai-chat-app")).length === 1 && await page.evaluate(() => { const r = document.querySelector(".ai-chat-app"); return !!(r.compareDocumentPosition([...document.querySelectorAll(".ai-chat-msg")].pop()) & 4); }));
    await page.reload();
    await page.click(".ai-chat-launcher__text");
    await page.waitForTimeout(500);
    await say("show me 3");
    await page.waitForTimeout(1200);
    check("app message: not again after a reload in the same visit", (await page.$$(".ai-chat-app")).length === 0);
  });
  await run("Not now", "/full?app=1", { viewport: { width: 1280, height: 900 } }, async (page, say) => {
    await say("show me 2");
    await say("show me 3");
    await appShown(page);
    await page.click("[data-appn-x]");
    await page.waitForTimeout(600);
    check("app message: Not now folds it away, the typing box gets the focus", (await page.$$(".ai-chat-app")).length === 0 && await page.evaluate(() => document.activeElement === document.querySelector(".ai-chat-input")));
    await say("show me 2");
    await page.waitForTimeout(1200);
    check("app message: …and it doesn't come back", (await page.$$(".ai-chat-app")).length === 0);
  });
  await run("own text", "/full?app=txt", { viewport: { width: 1280, height: 900 } }, async (page, say) => {
    await say("show me 2");
    await say("show me 3");
    await appShown(page);
    const t = await page.evaluate(() => ({ text: document.querySelector(".ai-appn__txt").textContent, button: document.querySelector("[data-appn]").textContent }));
    check("app message: the text and button set in Settings", t.text === "Get 15% off your first app order" && t.button === "Download", JSON.stringify(t));
  });
  await run("app picture", "/full?app=img", { viewport: { width: 1280, height: 900 } }, async (page, say) => {
    await say("show me 2");
    await say("show me 3");
    await appShown(page);
    await page.waitForTimeout(600);
    const pic = await page.evaluate(() => {
      const r = document.querySelector(".ai-chat-app"), card = r.querySelector(".ai-appn"), img = r.querySelector(".ai-appn__shot img");
      const c = card.getBoundingClientRect(), i = img ? img.getBoundingClientRect() : null, prev = r.previousElementSibling.getBoundingClientRect();
      return { img: !!img, loaded: !!img && img.complete && img.naturalWidth > 0, icon: !!r.querySelector(".ai-appn__icon"), src: img?.getAttribute("src"),
        above: i ? Math.round(c.top - i.top) : 0, below: i ? Math.round(i.bottom - c.bottom) : 0, clearOfPrev: i ? i.top >= prev.bottom - 1 : false, alt: img?.getAttribute("alt") };
    });
    check("app message: the app's picture in place of the icon, bigger than the card — above and below it", pic.img && pic.loaded && !pic.icon && pic.src === "/apps/hajirai/app-image?v=test1" && pic.above >= 8 && pic.below >= 8 && pic.clearOfPrev && pic.alt === "", JSON.stringify(pic));
    // Opened at the bottom of a short window: the panel is brought into view.
    await page.setViewportSize({ width: 1280, height: 640 });
    await page.evaluate(() => { const m = document.querySelector(".ai-chat-messages"); m.scrollTop = Math.max(0, m.scrollHeight - m.clientHeight - 0); });
    await page.waitForTimeout(200);
    await page.click("[data-appn]");
    await page.waitForTimeout(700);
    const seen = await page.evaluate(() => { const m = document.querySelector(".ai-chat-messages").getBoundingClientRect(), p = document.querySelector(".ai-appn__panel").getBoundingClientRect(); return { panelBottom: Math.round(p.bottom), listBottom: Math.round(m.bottom), panelTop: Math.round(p.top), listTop: Math.round(m.top), open: !document.querySelector(".ai-appn__panel").hidden }; });
    check("app message: Get it scrolls the opened panel fully into view", seen.open && seen.panelBottom <= seen.listBottom + 1 && seen.panelTop >= seen.listTop - 1, JSON.stringify(seen));
  });
  await run("app picture missing", "/full?app=imgbad", { viewport: { width: 1280, height: 900 } }, async (page, say) => {
    await say("show me 2");
    await say("show me 3");
    await appShown(page);
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => ({ icon: !!document.querySelector(".ai-chat-app .ai-appn__icon"), img: !!document.querySelector(".ai-chat-app .ai-appn__shot") }));
    check("app message: a picture that doesn't load → the phone icon instead", r.icon && !r.img, JSON.stringify(r));
  });
  await run("iPhone", "/full?app=1", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: IPHONE }, async (page, say) => {
    await say("show me 2");
    await say("show me 3");
    await appShown(page);
    const fit = await page.evaluate(() => { const r = document.querySelector(".ai-chat-app"), m = document.querySelector(".ai-chat-messages"), go = r.querySelector("[data-appn]").getBoundingClientRect(), x = r.querySelector("[data-appn-x]").getBoundingClientRect(), rr = r.getBoundingClientRect(), mr = m.getBoundingClientRect(); return { inside: rr.left >= mr.left - 0.5 && rr.right <= mr.right + 0.5, buttons: go.right <= x.left + 0.5 && x.right <= rr.right + 0.5, oneRowButtons: Math.abs((go.top + go.bottom) / 2 - (x.top + x.bottom) / 2) < 2 }; });
    check("app message (iPhone): fits the phone, button and close side by side", fit.inside && fit.buttons && fit.oneRowButtons, JSON.stringify(fit));
    await page.click("[data-appn]");
    const m = await page.evaluate(() => ({ badges: [...document.querySelectorAll(".ai-appn__badge")].map((b) => `${b.getAttribute("aria-label")}|${b.getAttribute("href")}|${b.querySelector("img")?.getAttribute("src") || ""}`), other: document.querySelector(".ai-appn__other")?.getAttribute("href"), qr: !!document.querySelector(".ai-appn__qrbox"), overflow: document.querySelector(".ai-appn").scrollWidth - document.querySelector(".ai-appn").clientWidth }));
    check("app message (iPhone): the App Store badge (the footer's), Google Play as a small link", m.badges.length === 1 && m.badges[0].startsWith(`Download on the App Store|${APP_LINKS.ios}|`) && /app-badge-app-store/.test(m.badges[0]) && m.other === APP_LINKS.android && !m.qr && m.overflow <= 1, JSON.stringify(m));
  });
  await run("Android", "/full?app=1", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: ANDROID }, async (page, say) => {
    await say("show me 2");
    await say("show me 3");
    await appShown(page);
    await page.click("[data-appn]");
    const m = await page.evaluate(() => ({ badges: [...document.querySelectorAll(".ai-appn__badge")].map((b) => b.getAttribute("href")), cls: document.querySelector(".ai-appn__badge")?.className, other: document.querySelector(".ai-appn__other")?.getAttribute("href") }));
    check("app message (Android): the Google Play badge, the App Store as a small link", m.badges.join() === APP_LINKS.android && /is-android/.test(m.cls) && m.other === APP_LINKS.ios, JSON.stringify(m));
  });
  await run("Settings links", "/full?app=set", { viewport: { width: 1280, height: 900 } }, async (page, say) => {
    const before = appQrLog.length;
    await say("show me 2");
    await say("show me 3");
    await appShown(page);
    await page.click("[data-appn]");
    await page.waitForTimeout(400);
    const src = await page.getAttribute(".ai-appn__qr img", "src");
    check("app message: links set in Settings → the app makes the QR code", src === "/apps/hajirai/app-qr?p=ios" && appQrLog.length > before, src);
  });
  await run("beside an order", "/full?app=1", { viewport: { width: 1280, height: 900 } }, async (page, say) => {
    await say("show me 2");
    await say("where is my order?");
    await page.waitForTimeout(1200);
    check("app message: never after an order card", (await page.$$(".ai-chat-app")).length === 0);
    await say("show me 3");
    check("app message: …it waits for the next ordinary reply", await appShown(page));
  });
  await run("moved on", "/full?app=1", { viewport: { width: 1280, height: 900 } }, async (page, say) => {
    await say("show me 2");
    await page.fill(".ai-chat-input", "show me 3");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    await page.fill(".ai-chat-input", "still typing");
    await page.waitForTimeout(1800);
    check("app message: not while the shopper is typing", (await page.$$(".ai-chat-app")).length === 0);
  });
  await run("off", "/full", { viewport: { width: 1280, height: 900 } }, async (page, say) => {
    await say("show me 2");
    await say("show me 3");
    await say("show me 2");
    await page.waitForTimeout(1200);
    check("app message: off in Settings → never shown", (await page.$$(".ai-chat-app, .ai-appn")).length === 0);
  });
}
// Settings → Chat text: the store's words replace the theme editor's — the
// name, the greeting, the Start here / Popular headings, the chat button and
// the message box — live, and from the first frame on the next page; with
// none set, the theme editor's stay.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const read = () => page.evaluate(() => ({
    name: document.querySelector(".ai-chat-header__name")?.textContent,
    greeting: document.querySelector(".ai-chat-welcome__title")?.textContent,
    start: document.querySelector('[data-wl="start"]')?.textContent,
    popular: document.querySelector('[data-wl="popular"]')?.textContent,
    launcher: document.querySelector(".ai-chat-launcher__text")?.textContent,
    launcherLabel: document.querySelector(".ai-chat-launcher__text")?.getAttribute("aria-label"),
    input: document.querySelector(".ai-chat-input")?.getAttribute("placeholder"),
  }));
  await page.goto("http://localhost:4789/full?texts=0");
  await page.waitForTimeout(700);
  const theme = await read();
  check("chat text: none set in Settings → the theme editor's words and the defaults", theme.name === "AI Shopping Assistant" && theme.start === "Start here" && theme.popular === "Popular" && theme.greeting === "Hi! I'm your personal shopping assistant." && theme.input === "How can I help you today?", JSON.stringify(theme));
  await page.goto("http://localhost:4789/full?texts=1");
  await page.waitForTimeout(900);
  const live = await read();
  const want = { name: "Aetrex Shopping Assistant", greeting: "Hello there!", start: "Get started", popular: "Trending now", launcher: "Ask Aetrex anything", input: "Type your question" };
  check("chat text: set in Settings → put in place as soon as the settings arrive", Object.entries(want).every(([k, v]) => live[k] === v) && /^Ask Aetrex anything — open/.test(live.launcherLabel), JSON.stringify(live));
  // The next page: the store's words from the first frame (remembered), before the settings arrive.
  await page.route("**/apps/hajirai/widget-config**", async (r) => { await new Promise((res) => setTimeout(res, 3000)); await r.fallback(); });
  await page.goto("http://localhost:4789/full");
  await page.waitForTimeout(400);
  const first = await read();
  check("chat text: the next page shows them from the start", Object.entries(want).every(([k, v]) => first[k] === v), JSON.stringify(first));
  await page.unroute("**/apps/hajirai/widget-config**");
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(500);
  await page.fill(".ai-chat-input", "show me 2");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  check("chat text: the chat works as before", (await page.$$(".ai-chat-product-card")).length >= 1);
  // Cleared in Settings: back to the theme editor's (a fresh chat, so the welcome shows).
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (/^hajirai_chat_(history|at)$/.test(k)) localStorage.removeItem(k); });
  await page.goto("http://localhost:4789/full?texts=0");
  await page.waitForTimeout(900);
  const cleared = await read();
  check("chat text: cleared in Settings → back to the theme editor's", cleared.start === "Start here" && cleared.popular === "Popular" && cleared.name === "AI Shopping Assistant", JSON.stringify(cleared));
  check("chat text: no JS errors", errors.length === 0, errors.join(" | "));
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
  check("known: tapping it shops that size — no second quiz", /^True Fit recommends size 9 - 9\.5 US for me( in the \S.*)?\.$/.test(chatBodies.at(-1)?.message || "") && !(await page.evaluate(() => window.__tfOpens)), chatBodies.at(-1)?.message);

  // A saved FIT: the card shops it, Retake asks the questions again.
  await page.evaluate(() => { sessionStorage.setItem("fitfinder_fit", JSON.stringify({ key: "B", label: "FIT B", code: "00" })); localStorage.removeItem("hajirai_chat_history"); });
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher");
  await page.waitForSelector(".ai-chat-helper--fitfinder.is-known", { timeout: 5000 }).catch(() => {});
  const fitCards = await helperTitles();
  check("known: the saved FIT shows on its card", fitCards.includes("Cushioned Support / Your FIT B"), fitCards.join(" | "));
  check("known: True Fit off a shoe page says what it does: pick a shoe, get its size", fitCards.includes("Find my shoe size / True Fit \u00b7 pick a shoe, get its size"), fitCards.join(" | "));
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
  await page.waitForSelector(".ai-ordl", { timeout: 6000 });
  check("orders signed out: sign in or look it up, no order details", (await page.$$(".ai-ord[data-ord]")).length === 0);
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
  const tray = () => page.evaluate(() => {
    const b = document.querySelector(".ai-chat-msg:last-child .ai-cmp-bar"), r = b.getBoundingClientRect(), x = b.querySelector("[data-cmp-cancel]").getBoundingClientRect();
    return { go: b.querySelector("[data-cmp-go]").textContent, slots: [...b.querySelectorAll(".ai-cmp-slot")].map((s) => (s.matches("[data-cmp-unpick]") ? s.getAttribute("data-cmp-unpick") : "")), oneLine: b.scrollWidth <= b.clientWidth + 1 && Math.round(r.height) <= 56, xLeft: x.left - r.left < 12, xLabel: b.querySelector("[data-cmp-cancel]").getAttribute("aria-label") };
  });
  const t0 = await tray();
  check(`compare (${label}): the tray opens with × on the left, ${phone ? 2 : 3} empty slots and the button saying what to do`, t0.slots.join() === (phone ? "," : ",,") && t0.go === (phone ? "Pick 2" : "Pick 2 or 3") && t0.xLeft && t0.xLabel === "Cancel compare" && t0.oneLine, JSON.stringify(t0));
  await cards4[0].click();
  const t1 = await tray();
  check(`compare (${label}): 4 cards → pick; one pick isn't enough`, (await page.$eval(go, (b) => b.disabled)) && /Pick 1 more/.test(await page.textContent(".ai-chat-msg:last-child .ai-cmp-bar__msg")) && t1.go === "Pick 1 more" && t1.slots[0] === "savannah-red" && t1.oneLine, JSON.stringify(t1));
  // A slot takes its pick out again (focus goes to that card's circle).
  await page.click(".ai-chat-msg:last-child [data-cmp-unpick=savannah-red]");
  const t2 = await tray();
  check(`compare (${label}): tapping a picked slot takes it out`, t2.slots.every((s) => !s) && !(await page.$(".ai-chat-msg:last-child .is-cmp-picked")) && (await page.evaluate(() => document.activeElement?.classList.contains("ai-cmp-pick") && document.activeElement.closest("[data-handle]")?.dataset.handle === "savannah-red")), JSON.stringify(t2));
  await cards4[0].click();
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
  const t3 = await tray();
  if (phone) {
    check(`compare (${label}): two at most on a phone`, picked.join() === "savannah-red,jillian-black" && (await page.textContent(go)) === "Compare 2" && /2 at most/.test(await page.textContent(".ai-chat-msg:last-child .ai-cmp-bar__msg")) && t3.slots.join() === "savannah-red,jillian-black", JSON.stringify({ picked, t3 }));
  } else {
    check(`compare (${label}): three at most`, picked.length === 3 && !picked.includes("orthotic-one") && (await page.textContent(go)) === "Compare 3" && t3.slots.join() === picked.join(), JSON.stringify({ picked, t3 }));
  }
  check(`compare (${label}): the tray stays on one line, full`, t3.oneLine, JSON.stringify(t3));
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
  check(`compare (${label}): Cancel puts the row back`, await page.evaluate(() => { const m = [...document.querySelectorAll(".ai-chat-msg")].pop(); return !m.querySelector(".is-cmp-picking") && !m.querySelector(".ai-cmp-cta__btn").hidden && !m.querySelector(".is-cmp-picked") && !m.querySelector(".ai-cmp-slot") && document.activeElement === m.querySelector("[data-cmp-start]"); }));
  // Escape while picking steps back to the row — the chat stays open.
  await page.click(".ai-chat-msg:last-child [data-cmp-start]");
  await (await page.$$(".ai-chat-msg:last-child .ai-chat-product-card"))[1].click();
  await page.focus(".ai-chat-msg:last-child [data-cmp-cancel]");
  await page.keyboard.press("Escape");
  check(`compare (${label}): Escape while picking cancels it, the chat stays open`, await page.evaluate(() => { const m = [...document.querySelectorAll(".ai-chat-msg")].pop(); return !m.querySelector(".is-cmp-picking") && !m.querySelector(".is-cmp-picked") && document.activeElement === m.querySelector("[data-cmp-start]") && document.querySelector(".ai-chat-panel").classList.contains("open"); }));
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
  check(`view all (${label}): a row under the cards names the full count — no thumbnails, no arrows`, row.label === "View all 10 women's sale boots" && row.hint === "8 more to browse" && row.thumbs === 0 && (await page.$$eval(".ai-chat-msg:last-child .ai-cmp-cta__thumb, .ai-chat-msg:last-child .ai-cmp-cta__go svg", (x) => x.length)) === 0, JSON.stringify(row));
  // With Compare: side by side when the reply is wide (about 70 / 30), one above the other when it's narrow.
  const pairAt = async (w) => page.evaluate((w) => {
    const pr = document.querySelector(".ai-cta-pair"); if (w) pr.style.width = w + "px";
    const v = pr.querySelector(".ai-va-cta").getBoundingClientRect(), c = pr.querySelector(".ai-cmp-cta").getBoundingClientRect(), r = pr.getBoundingClientRect();
    const out = { sameRow: Math.abs(v.top - c.top) < 2, share: +(v.width / (v.width + c.width)).toFixed(2), sameHeight: Math.abs(v.height - c.height) < 2, inside: c.right <= r.right + 0.5 && v.left >= r.left - 0.5 };
    pr.style.width = ""; return out;
  }, w);
  const wide = await pairAt(560), narrow = await pairAt(340);
  check(`view all (${label}): with Compare — side by side 70/30 in a wide reply, stacked in a narrow one`, wide.sameRow && wide.share >= 0.66 && wide.share <= 0.74 && wide.sameHeight && wide.inside && !narrow.sameRow && narrow.inside, JSON.stringify({ wide, narrow }));
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
  check(`view all (${label}): the chat's own card style and buttons, in a grid — no sideways scrolling`, sh.sameStyle && sh.sameButtons && sh.noSideways && sh.imgOnTop && sh.widths.length === 1 && (sh.showcase ? (label === "desktop" ? sh.perRow >= 4 && sh.perRow <= 5 : sh.perRow >= 2 && sh.perRow <= 3) : sh.perRow >= 1), JSON.stringify(sh));
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
  // On a computer the wide view shrinks back first.
  await page.waitForFunction(() => document.querySelector(".ai-chat-fbsheet").hidden, null, { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(100);
  const back = await page.evaluate(() => ({ closed: document.querySelector(".ai-chat-fbsheet").hidden, focus: document.activeElement && document.activeElement.hasAttribute("data-viewall") }));
  check(`view all (${label}): back closes the list and returns focus to the button`, back.closed && back.focus, JSON.stringify(back));
  await page.click("[data-viewall]");
  await page.waitForTimeout(500);
  const kept = await page.evaluate(() => !!document.querySelector(".ai-chat-fbsheet__list .ai-chat-atc-done"));
  check(`view all (${label}): reopening shows the same list (not rebuilt)`, kept);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".ai-chat-fbsheet").hidden, null, { timeout: 4000 }).catch(() => {});
  check(`view all (${label}): Escape closes it`, await page.evaluate(() => document.querySelector(".ai-chat-fbsheet").hidden));
  await page.reload();
  await page.waitForTimeout(600);
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(600);
  check(`view all (${label}): the button is still under the reply after a reload`, (await page.$$eval("[data-viewall]", (b) => b.length)) === 1);
  await page.click("[data-viewall]");
  await page.waitForTimeout(600);
  check(`view all (${label}): and still opens the full list`, (await page.$$eval(".ai-chat-fbsheet__list .ai-chat-product-card", (c) => c.length)) === 10);
  // Picking to compare (four cards): View all steps aside — never squeezed
  // into a sliver beside the tray — and the tray spans the row; Cancel
  // brings both back.
  await page.click(".ai-chat-fbsheet__back");
  await page.waitForFunction(() => !document.querySelector(".ai-chat-fbsheet.is-open"), null, { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "fourboots");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1300);
  await page.evaluate(() => { const prs = document.querySelectorAll(".ai-cta-pair"); prs[prs.length - 1].id = "pick-pair"; });
  const picking = async (w) => {
    await page.evaluate((w) => { document.getElementById("pick-pair").style.width = w + "px"; }, w);
    await page.click("#pick-pair [data-cmp-start]");
    await page.waitForTimeout(400);
    const res = await page.evaluate(() => {
      const pr = document.getElementById("pick-pair"), va = pr.querySelector(".ai-va-cta"), bar = pr.querySelector(".ai-cmp-bar"), r = pr.getBoundingClientRect(), b = bar.getBoundingClientRect();
      return { picking: !!pr.closest(".is-cmp-picking"), vaHidden: getComputedStyle(va).display === "none", fullRow: Math.abs(b.left - r.left) < 1 && Math.abs(b.right - r.right) < 1 };
    });
    await page.screenshot({ path: out(`va-${label}-picking-${w}`) });
    await page.click("#pick-pair [data-cmp-cancel]");
    await page.waitForTimeout(300);
    res.back = await page.evaluate(() => { const pr = document.getElementById("pick-pair"), v = pr.querySelector(".ai-va-cta").getBoundingClientRect(), c = pr.querySelector(".ai-cmp-cta").getBoundingClientRect(); return getComputedStyle(pr.querySelector(".ai-va-cta")).display !== "none" && v.width > 0 && (Math.abs(v.top - c.top) < 2) === (pr.getBoundingClientRect().width >= 420); });
    await page.evaluate(() => { document.getElementById("pick-pair").style.width = ""; });
    return res;
  };
  const pickWide = await picking(560), pickNarrow = await picking(340);
  check(`view all (${label}): picking to compare hides View all and the tray spans the row — wide or narrow — and Cancel brings it back`, [pickWide, pickNarrow].every((p) => p.picking && p.vaHidden && p.fullRow && p.back), JSON.stringify({ pickWide, pickNarrow }));
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
const hasPair = (p, size, width) => p.stock.some((o) => (!size || o.Size === size) && (!width || o.Width === width));
const bootsWith = (fn) => BOOT_PRODUCTS.filter(fn).map((p) => p.handle);
const gridState = (page) => page.evaluate(() => ({
  count: document.querySelector(".ai-chat-viewall__count").textContent,
  handles: [...document.querySelectorAll(".ai-chat-fbsheet__list .ai-chat-products--grid .ai-chat-product-card")].map((c) => c.getAttribute("data-handle")),
  prices: [...document.querySelectorAll(".ai-chat-fbsheet__list .ai-chat-products--grid .ai-chat-product-price")].map((p) => parseFloat(p.firstChild.textContent.replace(/[^0-9.]/g, ""))),
  chips: [...document.querySelectorAll(".ai-vf__chips button")].map((b) => b.textContent.trim()),
  done: (document.querySelector(".ai-vf-pop__done") || {}).textContent || "",
}));
const settled = (page) => page.waitForFunction(() => !document.querySelector("[data-skel]"), null, { timeout: 5000 }).catch(() => {});
// View all on a computer: the chat grows into a wide view (five cards a row,
// × at the top right) and back. Filters on top work instantly from the
// index of every match: sizes and widths paired, colors, sort, chips, Clear
// all — results and counts exactly as the catalog says; cards not seen yet
// are fetched once, by handle.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/showcase");
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(500);
  await page.fill(".ai-chat-input-area textarea", "manyboots");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-viewall]", { timeout: 5000 });
  const idx0 = viewAllIndexLog.length, cards0 = viewAllCardsLog.length;
  const before = await page.evaluate(() => { const r = document.querySelector(".ai-chat-panel").getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  await page.click("[data-viewall]");
  await page.waitForSelector(".ai-vf:not(.is-loading)", { timeout: 5000 });
  await page.waitForTimeout(900);
  const wide = await page.evaluate(() => {
    const p = document.querySelector(".ai-chat-panel"), r = p.getBoundingClientRect(), g = document.querySelector(".ai-chat-fbsheet__list .ai-chat-products--grid"), x = document.querySelector(".ai-chat-fbsheet__x").getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), cols: getComputedStyle(g).gridTemplateColumns.split(" ").length, chatHidden: getComputedStyle(document.querySelector(".ai-chat-messages")).display === "none",
      xTopRight: x.right > r.right - 60 && x.top < r.top + 40, xLabel: document.querySelector(".ai-chat-fbsheet__x").getAttribute("aria-label"),
      pills: [...document.querySelectorAll(".ai-vf [data-vf-open], .ai-vf [data-vf-toggle]")].map((b) => b.getAttribute("data-vf-open") || b.getAttribute("data-vf-toggle")) };
  });
  check("filters: on a computer View all grows almost full width — five a row, × at the top right", wide.w === 1392 && wide.h === 860 && wide.cols === 5 && wide.chatHidden && wide.xTopRight && wide.xLabel === "Close the chat", JSON.stringify({ wide, before }));
  check("filters: the bar offers what these matches can be filtered by, Sort at the end", wide.pills.join(",") === "all,size,width,color,price,type,needs,sort", wide.pills.join(","));
  check("filters: the index is asked for once, with the reply's search", viewAllIndexLog.length === idx0 + 1 && viewAllIndexLog.at(-1).search?.on_sale === true, JSON.stringify(viewAllIndexLog.slice(idx0)));
  await page.screenshot({ path: out("va-wide") });

  // Size: a panel under its button; a size shows only styles with it in stock.
  await page.click('[data-vf-open="size"]');
  await page.waitForSelector(".ai-vf-pop.is-open");
  await page.waitForTimeout(100);
  const pop = await page.evaluate(() => { const d = document.querySelector(".ai-vf-pop"), b = document.querySelector('[data-vf-open="size"]').getBoundingClientRect(), r = d.getBoundingClientRect(); return { role: d.getAttribute("role"), label: d.getAttribute("aria-label"), focusIn: d.contains(document.activeElement), expanded: document.querySelector('[data-vf-open="size"]').getAttribute("aria-expanded"), under: r.top >= b.bottom && Math.abs(r.left - b.left) < 2, sizes: [...d.querySelectorAll(".ai-vf-size")].map((x) => x.textContent) }; });
  check("filters: Size opens a panel right under its button, every size in stock in order, focus inside", pop.role === "dialog" && pop.label === "Size (US)" && pop.focusIn && pop.expanded === "true" && pop.under && pop.sizes.join(",") === "6,6.5,7,7.5,8,8.5,9,9.5,10,11", JSON.stringify(pop));
  await page.click('.ai-vf-size[aria-pressed] >> text="8"');
  await settled(page);
  const want8 = bootsWith((p) => hasPair(p, "8 US"));
  let st = await gridState(page);
  check("filters: a size shows only the styles with it in stock, at once, with the count", want8.length === 45 && st.count === `1–24 of ${want8.length}` && st.handles.join(",") === want8.slice(0, 24).join(",") && st.done === `Show ${want8.length} results`, JSON.stringify({ count: st.count, done: st.done, first: st.handles.slice(0, 4) }));
  await page.click('[data-vf-open="width"]');
  await page.waitForSelector('.ai-vf-pop--width.is-open');
  await page.click('.ai-vf-opt >> text="Wide"');
  await settled(page);
  const want8w = bootsWith((p) => hasPair(p, "8 US", "Wide"));
  st = await gridState(page);
  check("filters: size and width are matched on the same pair (8 and Wide = a Wide 8 in stock)", want8w.length > 0 && want8w.length < want8.length && st.count === `${want8w.length} results` && st.handles.join(",") === want8w.join(","), JSON.stringify({ want: want8w.length, count: st.count }));
  check("filters: what's chosen shows on the buttons and as chips", st.chips.join("|") === "Size 8 US|Wide|Clear all" && (await page.textContent('[data-vf-open="size"]')).includes("8") && (await page.textContent('[data-vf-open="all"]')).includes("2"), st.chips.join("|"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const esc1 = await page.evaluate(() => ({ pop: !!document.querySelector(".ai-vf-pop"), sheet: !document.querySelector(".ai-chat-fbsheet").hidden, focus: document.activeElement && document.activeElement.getAttribute("data-vf-open") }));
  check("filters: Escape closes the panel first (the list stays), focus back on its button", !esc1.pop && esc1.sheet && esc1.focus === "width", JSON.stringify(esc1));
  await page.click('.ai-vf__chip >> text="Wide"');
  await settled(page);
  st = await gridState(page);
  check("filters: a chip's × takes that filter off", st.count === `1–24 of ${want8.length}` && st.chips.join("|") === "Size 8 US|Clear all", JSON.stringify(st.chips));
  await page.click('[data-vf-open="color"]');
  await page.waitForSelector('.ai-vf-pop--color.is-open');
  const reds = await page.evaluate(() => { const b = document.querySelector('.ai-vf-sw[data-k="red"]'); return { n: b.querySelector(".ai-vf-n").textContent, label: b.querySelector(".ai-vf-sw__l").textContent }; });
  const want8r = bootsWith((p) => hasPair(p, "8 US") && /- (Red|Wine)$/.test(p.title));
  check("filters: each color says how many it would show (red and wine together)", reds.label === "Red" && reds.n === String(want8r.length), JSON.stringify(reds));
  await page.click('.ai-vf-sw[data-k="red"]');
  await settled(page);
  st = await gridState(page);
  check("filters: a color narrows it further", st.count === `${want8r.length} results` && st.handles.join(",") === want8r.join(","), JSON.stringify({ want: want8r.length, count: st.count }));
  await page.keyboard.press("Escape");
  await page.click('[data-vf-open="sort"]');
  await page.waitForSelector('.ai-vf-pop--sort.is-open');
  await page.click('[data-vf-sort="price_low"]');
  await settled(page);
  st = await gridState(page);
  check("filters: Sort by price, low to high (and the panel closes)", st.prices.length === want8r.length && st.prices.every((v, i) => i === 0 || v >= st.prices[i - 1]) && !(await page.$(".ai-vf-pop.is-open")) && (await page.textContent(".ai-vf__sort-v")) === "Price: Low to High", JSON.stringify(st.prices));
  await page.click(".ai-vf__clear");
  await settled(page);
  st = await gridState(page);
  check("filters: Clear all shows every match again (the sort stays)", st.count === "1–24 of 60" && st.chips.length === 0 && st.prices.every((v, i) => i === 0 || v >= st.prices[i - 1]), JSON.stringify({ count: st.count, chips: st.chips }));
  await page.click('[data-vf-open="sort"]');
  await page.click('[data-vf-sort="best"]');
  await page.waitForTimeout(300);
  st = await gridState(page);
  check("filters: back to Best match, the list is the reply's pages again", st.count === "1–24 of 60" && st.handles[0] === "boot-1" && st.handles[23] === "boot-24", JSON.stringify(st.handles.slice(0, 3)));
  const asked = viewAllCardsLog.slice(cards0).flat();
  check("filters: cards not seen yet are fetched by handle — each just once, never ones already shown", asked.length > 0 && new Set(asked).size === asked.length && !asked.some((h) => /^boot-([1-9]|1\d|2[0-4])$/.test(h)), JSON.stringify(asked.slice(0, 8)));
  // Pages of a filtered list.
  await page.click('[data-vf-open="size"]');
  await page.click('.ai-vf-size[aria-pressed] >> text="8"');
  await page.keyboard.press("Escape");
  await settled(page);
  await page.click('.ai-va-pager [data-va-step="1"]');
  await settled(page);
  st = await gridState(page);
  check("filters: a filtered list has its own pages", st.count === `25–${want8.length} of ${want8.length}` && st.handles.join(",") === want8.slice(24).join(",") && (await page.textContent(".ai-va-pager__label")) === "Page 2 of 2", JSON.stringify({ count: st.count }));
  // Back: the window shrinks to the chat's size, the conversation is there.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  const narrow = await page.evaluate(() => { const r = document.querySelector(".ai-chat-panel").getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), sheet: document.querySelector(".ai-chat-fbsheet").hidden, chat: getComputedStyle(document.querySelector(".ai-chat-messages")).display !== "none", wide: document.querySelector(".ai-chat-panel").classList.contains("is-wide") }; });
  check("filters: back to the chat, the window returns to its size with the conversation", narrow.w === before.w && narrow.h === before.h && narrow.sheet && narrow.chat && !narrow.wide, JSON.stringify({ narrow, before }));
  // Reopened: the filters are as they were left.
  await page.click("[data-viewall]");
  await page.waitForTimeout(1000);
  st = await gridState(page);
  check("filters: reopening keeps the filters as they were", st.chips.join("|") === "Size 8 US|Clear all" && st.count.endsWith(`of ${want8.length}`), JSON.stringify(st.chips));
  // × closes the whole chat; opening it again shows the conversation.
  await page.click(".ai-chat-fbsheet__x");
  await page.waitForTimeout(900);
  const closed = await page.evaluate(() => ({ open: document.querySelector(".ai-chat-panel").classList.contains("open"), sheet: document.querySelector(".ai-chat-fbsheet").hidden, wide: document.querySelector(".ai-chat-panel").classList.contains("is-wide") }));
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(700);
  const reopened = await page.evaluate(() => { const r = document.querySelector(".ai-chat-panel").getBoundingClientRect(); return { w: Math.round(r.width), chat: getComputedStyle(document.querySelector(".ai-chat-messages")).display !== "none", sheet: document.querySelector(".ai-chat-fbsheet").hidden }; });
  check("filters: × closes the chat; it opens again on the conversation, at its usual size", !closed.open && closed.sheet && !closed.wide && reopened.w === before.w && reopened.chat && reopened.sheet, JSON.stringify({ closed, reopened }));
  check("filters (computer): no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// On a phone: the sheet is already full screen. The buttons scroll sideways,
// Sort is its icon, and a filter opens as a sheet from the bottom.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/showcase");
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(500);
  await page.fill(".ai-chat-input-area textarea", "manyboots");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-viewall]", { timeout: 5000 });
  await page.click("[data-viewall]");
  await page.waitForSelector(".ai-vf:not(.is-loading)", { timeout: 5000 });
  await page.waitForTimeout(500);
  const bar = await page.evaluate(() => { const p = document.querySelector(".ai-chat-panel").getBoundingClientRect(), s = document.querySelector(".ai-vf__sort").getBoundingClientRect(), row = document.querySelector(".ai-vf__pills"); return { w: Math.round(p.width), wide: document.querySelector(".ai-chat-panel").classList.contains("is-wide"), sortW: Math.round(s.width), sortIn: s.right <= p.right, scrolls: row.scrollWidth > row.clientWidth, noSideways: document.documentElement.scrollWidth <= innerWidth }; });
  check("filters (phone): full screen as before, the buttons scroll sideways, Sort is its icon", bar.w === 390 && !bar.wide && bar.sortW === 36 && bar.sortIn && bar.scrolls && bar.noSideways, JSON.stringify(bar));
  await page.click('[data-vf-open="size"]');
  await page.waitForSelector(".ai-vf-pop.is-sheet.is-open");
  await page.waitForTimeout(500);
  const sheet = await page.evaluate(() => { const d = document.querySelector(".ai-vf-pop").getBoundingClientRect(); return { bottom: Math.round(d.bottom), left: Math.round(d.left), w: Math.round(d.width), dim: getComputedStyle(document.querySelector(".ai-vf-scrim")).opacity }; });
  check("filters (phone): a filter opens as a sheet from the bottom, over a dimmed list", Math.abs(sheet.bottom - 844) <= 1 && sheet.left === 0 && sheet.w === 390 && sheet.dim === "1", JSON.stringify(sheet));
  await page.click('.ai-vf-size[aria-pressed] >> text="9"');
  await page.waitForTimeout(200);
  const want9 = bootsWith((p) => hasPair(p, "9 US"));
  check("filters (phone): the button says how many it will show", (await page.textContent(".ai-vf-pop__done")) === `Show ${want9.length} results`, await page.textContent(".ai-vf-pop__done"));
  await page.click(".ai-vf-pop__done");
  await page.waitForTimeout(500);
  await settled(page);
  const st = await gridState(page);
  check("filters (phone): Show closes it; the list and the chip are there", !(await page.$(".ai-vf-pop.is-open")) && st.count === `1–24 of ${want9.length}` && st.chips.join("|") === "Size 9 US|Clear all", JSON.stringify({ count: st.count, chips: st.chips }));
  await page.click('[data-vf-open="all"]');
  await page.waitForSelector(".ai-vf-pop--all.is-open");
  const secs = await page.$$eval(".ai-vf-sec__h", (h) => h.map((x) => x.textContent));
  check("filters (phone): Filters shows them all in one sheet", secs.join(",") === "Size (US),Width,Color,Price,Type,Helps with", secs.join(","));
  await page.screenshot({ path: out("va-phone-filters") });
  check("filters (phone): no JS errors", errors.length === 0, errors.join(" | "));
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
    // Reasons skipped: × after a thumbs-down → the thanks, only the vote sent.
    await page.evaluate(() => { localStorage.removeItem("hajirai_rate_done"); Object.keys(localStorage).filter((k) => k.startsWith("hajirai_rate_")).forEach((k) => localStorage.removeItem(k)); });
    await say(page, "hello 1");
    await page.waitForSelector(".ai-chat-rate.is-in", { timeout: 4000 });
    await page.click('.ai-chat-rate [data-rate="down"]');
    await page.waitForTimeout(300);
    const dq = await page.$eval(".ai-chat-rate__q", (q) => q.textContent);
    const chips = await page.$$eval(".ai-chat-rate [data-rate-why]", (b) => b.map((x) => x.textContent));
    await page.click(".ai-chat-rate [data-rate-x]");
    await page.waitForTimeout(300);
    check("chat rating: a thumbs-down asks what went wrong, in one tap", dq === "Sorry about that. What went wrong?" && chips.join("|") === "Wrong product|Didn’t answer my question|Info was wrong|Too slow|Something else", `${dq} ${chips.join("|")}`);
    check("chat rating: skipping the reasons keeps just the vote", (await page.$eval(".ai-chat-rate", (r) => r.getAttribute("data-state"))) === "done" && feedbackBodies.length === fb0 + 1 && feedbackBodies.at(-1).vote === "down" && feedbackBodies.at(-1).moment === "replies" && !feedbackBodies.at(-1).reason && !feedbackBodies.at(-1).comment, JSON.stringify(feedbackBodies.slice(fb0)));
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
// Thumbs under every answer — not just ones with products — on the newest
// answer only; quiet icons that fold away once the shopper writes again. A
// thumbs-down offers one-tap reasons, sent with the same vote. An answer
// about an order asks in words. A vote is kept with the answer.
{
  const fbCtx = async (opts, cookies) => { const ctx = await browser.newContext(opts); if (cookies) await ctx.addCookies(cookies); const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message)); return { ctx, page, errors }; };
  const say = async (page, q) => {
    const before = await page.$$eval(".ai-chat-msg--assistant", (m) => m.length);
    await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", q);
    await page.keyboard.press("Enter");
    await page.waitForFunction((n) => document.querySelectorAll(".ai-chat-msg--assistant").length > n, before, { timeout: 6000 });
    await page.waitForTimeout(500);
  };
  for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 800 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
    const { ctx, page, errors } = await fbCtx(opts);
    const fb0 = feedbackBodies.length;
    await page.goto("http://localhost:4789/showcase");
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(500);
    await say(page, "show me 2");
    const one = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".ai-chat-feedback")], row = rows[0], b = row && row.closest(".ai-chat-msg-bubble");
      const btns = row ? [...row.querySelectorAll(".ai-chat-fb-btn")] : [];
      const cs = btns[0] && getComputedStyle(btns[0]);
      const icon = btns[0] && btns[0].querySelector("svg").getBoundingClientRect(), text = b && b.querySelector("p").getBoundingClientRect();
      return { rows: rows.length, inBubble: !!b, last: b && b.lastElementChild === row, labels: btns.map((x) => x.getAttribute("aria-label")).join("|"), words: row && row.textContent.trim(),
        size: btns[0] && Math.round(btns[0].getBoundingClientRect().height), border: cs && cs.borderTopWidth, bg: cs && cs.backgroundColor, aligned: icon && Math.abs(icon.left - text.left) <= 3, group: row && row.getAttribute("role") + "|" + row.getAttribute("aria-label") };
    });
    check(`thumbs (${label}): quiet icons at the foot of the answer — no words, no border, no fill`, one.rows === 1 && one.inBubble && one.last && one.labels === "Helpful|Not helpful" && one.words === "" && one.border === "0px" && one.bg === "rgba(0, 0, 0, 0)" && one.group === "group|Was this answer helpful?", JSON.stringify(one));
    check(`thumbs (${label}): easy to tap (${label === "phone" ? "36" : "32"}px), the icon lined up with the text`, one.size === (label === "phone" ? 36 : 32) && one.aligned, JSON.stringify(one));
    await page.screenshot({ path: out(`thumbs-${label}-quiet`) });
    // A text-only answer gets them too; the older answer's fold away.
    await say(page, "storesnear");
    await page.waitForTimeout(450);
    const two = await page.evaluate(() => { const rows = [...document.querySelectorAll(".ai-chat-feedback")]; const msgs = [...document.querySelectorAll(".ai-chat-msg--assistant")]; return { rows: rows.length, onNewest: rows.length === 1 && msgs.at(-1).contains(rows[0]), cards: !!msgs.at(-1).querySelector(".ai-chat-product-card") }; });
    check(`thumbs (${label}): every answer gets them, not just ones with products — on the newest only`, two.rows === 1 && two.onNewest && !two.cards, JSON.stringify(two));
    check(`thumbs (${label}): nothing is sent until they tap`, feedbackBodies.length === fb0);
    // Thumbs-down: reasons, one tap; the answer keeps its width.
    const w0 = await page.$eval(".ai-chat-msg:last-child .ai-chat-msg-bubble", (b) => Math.round(b.getBoundingClientRect().width));
    await page.click('.ai-chat-msg:last-child .ai-chat-fb-btn[data-vote="down"]');
    await page.waitForTimeout(350);
    const why = await page.evaluate(() => { const r = document.querySelector(".ai-chat-msg:last-child .ai-chat-feedback"); return { q: r.querySelector(".ai-chat-fb-say").textContent, chips: [...r.querySelectorAll("[data-why]")].map((b) => b.textContent).join("|"), w: Math.round(r.closest(".ai-chat-msg-bubble").getBoundingClientRect().width), tap: Math.min(...[...r.querySelectorAll("[data-why]")].map((b) => b.getBoundingClientRect().height)), inside: [...r.querySelectorAll("[data-why]")].every((b) => b.getBoundingClientRect().right <= r.closest(".ai-chat-msg-bubble").getBoundingClientRect().right + 0.5) }; });
    await page.screenshot({ path: out(`thumbs-${label}-why`) });
    const v1 = feedbackBodies[fb0];
    check(`thumbs (${label}): a thumbs-down is sent at once`, v1 && v1.vote === "down" && /^v_[A-Za-z0-9]{8,}$/.test(v1.key) && /^sess_/.test(v1.session) && v1.botResponse === "Search your area on our store map." && Array.isArray(v1.conversation) && !v1.reason && !v1.kind, JSON.stringify(v1));
    check(`thumbs (${label}): then "what went wrong?" in one tap ("Wrong product" only when products were shown)`, why.q === "Sorry about that. What went wrong?" && why.chips === "Didn’t answer my question|Info was wrong|Too slow|Something else" && why.tap >= 32 && why.inside, JSON.stringify(why));
    check(`thumbs (${label}): the reasons don't widen the answer`, why.w === w0, `${w0} → ${why.w}`);
    await page.click('.ai-chat-msg:last-child [data-why="wrong_info"]');
    await page.waitForTimeout(300);
    const v2 = feedbackBodies[fb0 + 1];
    check(`thumbs (${label}): the reason goes with the same vote`, v2 && v2.vote === "down" && v2.reason === "wrong_info" && v2.key === v1.key && feedbackBodies.length === fb0 + 2, JSON.stringify(v2));
    check(`thumbs (${label}): a short thanks`, (await page.$eval(".ai-chat-msg:last-child .ai-chat-feedback", (r) => r.textContent.trim())) === "Thanks — this helps us get better");
    // Kept with the answer: a reload doesn't ask again.
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("hajirai_chat_history") || "[]").filter((m) => m.role === "assistant").map((m) => (m.ai ? "ai" : "-") + ":" + (m.fb || "")).join(","));
    await page.reload();
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(600);
    check(`thumbs (${label}): the vote is kept with the answer — a reload doesn't ask again`, kept === "ai:,ai:down" && (await page.$$(".ai-chat-feedback")).length === 0, kept);
    // A thumbs-up on a product answer: the product names go with it.
    await say(page, "show me 2");
    await page.click('.ai-chat-msg:last-child .ai-chat-fb-btn[data-vote="up"]');
    await page.waitForTimeout(300);
    const v3 = feedbackBodies.at(-1);
    check(`thumbs (${label}): a thumbs-up says thanks and sends the products shown`, v3.vote === "up" && v3.products.length === 2 && /Savannah/.test(v3.products[0]) && !v3.conversation && (await page.$eval(".ai-chat-msg:last-child .ai-chat-feedback", (r) => r.textContent.trim())) === "Thanks for the feedback", JSON.stringify(v3));
    check(`thumbs (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // Reloaded before voting: the newest answer still has its thumbs (older ones don't).
  {
    const { ctx, page, errors } = await fbCtx({ viewport: { width: 1280, height: 800 } });
    await page.goto("http://localhost:4789/showcase");
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(500);
    await say(page, "show me 2");
    await say(page, "storesnear");
    await page.reload();
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => { const rows = [...document.querySelectorAll(".ai-chat-feedback")]; return { n: rows.length, newest: rows.length === 1 && document.querySelectorAll(".ai-chat-msg--assistant")[1].contains(rows[0]) }; });
    check("thumbs: after a reload, the newest answer still has its thumbs (and only it)", r.n === 1 && r.newest, JSON.stringify(r));
    check("thumbs: no JS errors (reload)", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // Quick replies stay last: the thumbs go above them.
  {
    const { ctx, page, errors } = await fbCtx({ viewport: { width: 1280, height: 800 } });
    await page.goto("http://localhost:4789/showcase");
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(500);
    await say(page, "full");
    const order = await page.evaluate(() => { const r = document.querySelector(".ai-chat-msg:last-child .ai-chat-feedback"); return r && r.nextElementSibling && r.nextElementSibling.className; });
    check("thumbs: under the answer, above its quick replies", /ai-chat-suggestions/.test(order || ""), String(order));
    check("thumbs: no JS errors (quick replies)", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // An answer about an order asks in words; one waiting for the shopper
  // (sign in, look it up) doesn't — until the order is looked up.
  {
    const { ctx, page, errors } = await fbCtx({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, [{ name: "signedin", value: "1", url: "http://localhost:4789" }]);
    await page.goto("http://localhost:4789/showcase");
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(500);
    await say(page, "where is my order");
    const ask = await page.$eval(".ai-chat-msg:last-child .ai-chat-feedback", (r) => ({ cls: r.className, text: r.textContent.trim(), aria: r.getAttribute("aria-label") }));
    check("thumbs: an order answer asks \"Did that answer your question?\"", /is-ask/.test(ask.cls) && ask.text === "Did that answer your question?" && ask.aria === "Did that answer your question?", JSON.stringify(ask));
    await page.$eval(".ai-chat-msg:last-child .ai-chat-feedback", (r) => r.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(200);
    await page.screenshot({ path: out("thumbs-phone-order") });
    await page.click('.ai-chat-msg:last-child .ai-chat-fb-btn[data-vote="up"]');
    await page.waitForTimeout(300);
    check("thumbs: the vote says it was an order answer", feedbackBodies.at(-1).moment === "order" && feedbackBodies.at(-1).vote === "up", JSON.stringify(feedbackBodies.at(-1)));
    check("thumbs: no JS errors (orders)", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await fbCtx({ viewport: { width: 1280, height: 800 } });
    await page.goto("http://localhost:4789/showcase");
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(500);
    await say(page, "where is my order");
    const before = await page.$eval(".ai-chat-msg:last-child .ai-chat-feedback", (r) => r.textContent.trim());
    await page.click(".ai-chat-msg:last-child [data-ordl-open]");
    await page.fill(".ai-chat-msg:last-child [name=order]", "1172010");
    await page.fill(".ai-chat-msg:last-child [name=email]", "pat@example.com");
    await page.click(".ai-chat-msg:last-child .ai-ordl__go");
    await page.waitForSelector(".ai-chat-msg:last-child .ai-ordl-done", { timeout: 4000 });
    const after = await page.$eval(".ai-chat-msg:last-child .ai-chat-feedback", (r) => r.textContent.trim());
    check("thumbs: a sign-in / look-up answer doesn't ask in words — once the order is looked up, it does", before === "" && after === "Did that answer your question?", `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    check("thumbs: no JS errors (look-up)", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // The moments that matter: right after an add to cart ...
  for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 800 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
    const { ctx, page, errors } = await fbCtx(opts);
    const fb0 = feedbackBodies.length;
    await page.goto("http://localhost:4789/showcase?rate=3");
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(500);
    await say(page, "show me 2");
    await page.waitForTimeout(2000);
    check(`moment (${label}): one answer in, nothing asked yet`, (await page.$$(".ai-chat-rate")).length === 0);
    await page.click('.ai-chat-product-card[data-handle="savannah-red"] [data-atc]');
    await page.waitForSelector(".ai-chat-atc-done", { timeout: 5000 });
    await page.waitForSelector(".ai-chat-rate.is-in", { timeout: 4000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: out(`moment-${label}-cart`) });
    const c = await page.evaluate(() => {
      const r = document.querySelector(".ai-chat-rate"), m = document.querySelector(".ai-chat-messages").getBoundingClientRect(), rr = r.getBoundingClientRect(), done = document.querySelector(".ai-chat-atc-done").getBoundingClientRect();
      return { moment: r.getAttribute("data-moment"), q: r.querySelector(".ai-chat-rate__q").textContent, votes: [...r.querySelectorAll("[data-rate]")].map((b) => b.getAttribute("aria-label")).join("|"), thumbs: document.querySelectorAll(".ai-chat-feedback:not(.is-out)").length,
        seen: rr.top >= m.top && rr.bottom <= m.bottom + 1, added: done.top >= m.top && done.bottom <= m.bottom, h: Math.round(rr.height) };
    });
    check(`moment (${label}): right after an add to cart, "Did … help you find it?"`, c.moment === "cart" && c.q === "Did the chat help you find it?" && c.votes === "Yes, it helped|No, it didn’t" && c.h <= 48, JSON.stringify(c));
    check(`moment (${label}): it takes the place of the answer's thumbs`, c.thumbs === 0, JSON.stringify(c));
    check(`moment (${label}): in view, with "Added to your cart" still in view`, c.seen && c.added, JSON.stringify(c));
    await page.click('.ai-chat-rate [data-rate="down"]');
    await page.waitForTimeout(300);
    const chips = await page.$$eval(".ai-chat-rate [data-rate-why]", (b) => b.map((x) => x.textContent).join("|"));
    await page.click('.ai-chat-rate [data-rate-why="wrong_product"]');
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => ({ state: document.querySelector(".ai-chat-rate").getAttribute("data-state"), q: document.querySelector(".ai-chat-rate__q").textContent, input: !!document.querySelector(".ai-chat-rate__input") }));
    const sent = feedbackBodies.slice(fb0);
    check(`moment (${label}): a thumbs-down, then one tap for why (with "Wrong product")`, chips.startsWith("Wrong product|") && sent.length === 2 && sent[0].kind === "chat" && sent[0].vote === "down" && sent[0].moment === "cart" && !sent[0].reason && sent[1].reason === "wrong_product" && sent[1].moment === "cart", JSON.stringify(sent));
    check(`moment (${label}): then an optional comment`, st.state === "voted" && st.q === "Thanks. Anything to add?" && st.input, JSON.stringify(st));
    await page.fill(".ai-chat-rate__input", "Wrong color");
    await page.press(".ai-chat-rate__input", "Enter");
    await page.waitForTimeout(300);
    const cm = feedbackBodies.at(-1);
    check(`moment (${label}): the comment keeps the reason`, cm.kind === "chat" && cm.comment === "Wrong color" && cm.reason === "wrong_product" && cm.vote === "down", JSON.stringify(cm));
    // Another add in this chat: not asked again.
    await page.waitForTimeout(3600);
    await page.click('.ai-chat-atc-panel [data-atc-close]').catch(() => {});
    await say(page, "show me 1");
    await page.click('.ai-chat-msg:last-child .ai-chat-product-card [data-atc]');
    await page.waitForTimeout(2600);
    check(`moment (${label}): asked once per conversation`, (await page.$$(".ai-chat-rate")).length === 0);
    check(`moment (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // ... and for Buy now (which leaves for checkout) when they're back in the chat.
  {
    const { ctx, page, errors } = await fbCtx({ viewport: { width: 1280, height: 800 } });
    await page.goto("http://localhost:4789/showcase?rate=3&buy=2");
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(500);
    await say(page, "show me 2");
    await page.click('.ai-chat-product-card[data-handle="savannah-red"] .ai-buynow');
    await page.waitForURL(/\/cart\/|\/checkout/, { timeout: 5000 }).catch(() => {});
    const left = page.url();
    await page.goto("http://localhost:4789/showcase?rate=3&buy=2");
    await page.waitForTimeout(2200);
    const closed = (await page.$$(".ai-chat-rate")).length;
    await page.click(".ai-chat-launcher");
    await page.waitForSelector(".ai-chat-rate.is-in", { timeout: 4000 });
    const b = await page.$eval(".ai-chat-rate", (r) => r.getAttribute("data-moment") + "|" + r.querySelector(".ai-chat-rate__q").textContent);
    check("moment: Buy now — asked when they're back in the chat (never on the closed chat)", /\/cart\/|\/checkout/.test(left) && closed === 0 && b === "buy_now|Did the chat help you find it?", `${left} ${closed} ${b}`);
    await page.click('.ai-chat-rate [data-rate="up"]');
    await page.waitForTimeout(300);
    check("moment: the rating says it was after Buy now", feedbackBodies.at(-1).moment === "buy_now" && feedbackBodies.at(-1).vote === "up", JSON.stringify(feedbackBodies.at(-1)));
    check("moment: no JS errors (Buy now)", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // Just rated the answer above: the chat question waits for a later reply.
  {
    const { ctx, page, errors } = await fbCtx({ viewport: { width: 1280, height: 800 } });
    await page.goto("http://localhost:4789/showcase?rate=2");
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(500);
    await say(page, "hello 1");
    await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "hello 1");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".ai-chat-msg--assistant").length >= 2, null, { timeout: 6000 });
    await page.waitForSelector(".ai-chat-msg:last-child .ai-chat-fb-btn", { timeout: 2000 });
    await page.click('.ai-chat-msg:last-child .ai-chat-fb-btn[data-vote="up"]');
    await page.waitForTimeout(2300);
    const waited = (await page.$$(".ai-chat-rate")).length === 0;
    await say(page, "hello 1");
    await page.waitForSelector(".ai-chat-rate.is-in", { timeout: 4000 });
    check("chat rating: never right after they rated the answer above — it comes with the next reply", waited, "");
    check("chat rating: no JS errors (after a thumb)", errors.length === 0, errors.join(" | "));
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
// Fit and size, under the buy button: side by side — Fit (a ring with the
// style's score) and the product's size tool (True Fit / FITFinder); one
// alone takes the row. They fit every card at every width — the words shown
// are never cut — and the Fit tile opens where the number comes from.
{
  const layouts = [
    ["showcase desktop", "/showcase?fitc=1", { viewport: { width: 1280, height: 860 } }],
    ["row cards desktop", "/horizontal?fitc=1", { viewport: { width: 1280, height: 860 } }],
    ["showcase tablet", "/showcase?fitc=1", { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true }],
    ["showcase phone", "/showcase?fitc=1", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
    ["row cards phone", "/horizontal?fitc=1", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
    ["showcase small phone", "/showcase?fitc=1", { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true }],
    ["row cards small phone", "/horizontal?fitc=1", { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true }],
  ];
  // Fit confidence off: the size tool stays a round button beside the buy
  // button, exactly as before — no tiles.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addInitScript(() => { try { localStorage.setItem("hajirai_tf_site", "1"); } catch { /* */ } });
    const page = await ctx.newPage();
    await page.goto("http://localhost:4789/showcase");
    await page.click(".ai-chat-launcher");
    await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "show me 3");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ai-chat-product-card [data-atc]");
    await page.waitForTimeout(300);
    const off = await page.$$eval(".ai-chat-messages .ai-chat-product-card", (cs) => cs.map((c) => {
      const b = c.querySelector(".ai-chat-card-fit"), row = c.querySelector(".ai-chat-buy-row");
      return [c.dataset.handle, b ? (b.dataset.truefit ? "truefit" : b.dataset.helper) : "-", !!row && !!b && b.parentNode === row && !!row.querySelector("[data-atc]"), !!c.querySelector(".ai-tools, .ai-tool, [data-fitq]"), c.querySelector(".ai-chat-view-link")?.textContent || "-"];
    }));
    check("tools off: the size tool beside the buy button and View product, as before — no tiles, no fold", JSON.stringify(off) === JSON.stringify([["savannah-red", "truefit", true, false, "View product"], ["jillian-black", "truefit", true, false, "View product"], ["orthotic-one", "fitfinder", true, false, "View product"]]), JSON.stringify(off));
    await ctx.close();
  }
  // On, with no scores in the reply: every card gets the size tile alone.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addInitScript(() => { try { localStorage.setItem("hajirai_tf_site", "1"); } catch { /* */ } });
    const page = await ctx.newPage();
    await page.goto("http://localhost:4789/showcase?fitc=1");
    await page.waitForTimeout(500);
    await page.click(".ai-chat-launcher");
    await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "show me 3");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ai-chat-product-card [data-atc]");
    await page.waitForTimeout(300);
    const on = await page.$$eval(".ai-chat-messages .ai-chat-product-card", (cs) => cs.map((c) => [c.dataset.handle, c.querySelector(".ai-fitp .ai-tools")?.getAttribute("data-n") || "-", [...c.querySelectorAll(".ai-tool")].map((t) => t.dataset.truefit ? "truefit" : t.dataset.helper).join("+"), !!c.querySelector(".ai-chat-card-fit"), !!c.querySelector(".ai-chat-view-link")]));
    check("tools on, no scores: the size tile alone on every card, folded under the button — never a mix", JSON.stringify(on) === JSON.stringify([["savannah-red", "1", "truefit", false, false], ["jillian-black", "1", "truefit", false, false], ["orthotic-one", "1", "fitfinder", false, false]]), JSON.stringify(on));
    await ctx.close();
  }
  // On, and the shopper finds their FIT: the orthotic's only tool goes, and
  // with nothing left to open, its card shows View product again.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:4789/products/jillian-black?fitc=1");
    await page.waitForTimeout(400);
    await page.click(".ai-chat-launcher");
    await page.fill(".ai-chat-input-area textarea", "show me 3");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".ai-chat-messages .ai-chat-product-card [data-fitq]").length >= 3);
    await page.click('.ai-chat-messages .ai-chat-product-card[data-handle="orthotic-one"] [data-fitq]');
    await page.waitForTimeout(400);
    await page.click('.ai-chat-messages .ai-chat-product-card[data-handle="orthotic-one"] [data-helper="fitfinder"]');
    await page.waitForFunction(() => document.querySelector(".ai-chat-fit-result"), null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const after = await page.$$eval(".ai-chat-messages .ai-chat-product-card", (cs) => cs.slice(0, 3).map((c) => [c.dataset.handle, !!c.querySelector("[data-fitq]"), !!c.querySelector(".ai-fitp"), c.querySelector(".ai-chat-view-link")?.textContent || "-"]));
    const pinned = await page.$$eval(".ai-chat-messages .ai-chat-products", (rs) => rs.some((r) => r.classList.contains("is-fitq-open") || [...r.children].some((c) => c.style.minHeight)));
    check("fold: a FIT found — the orthotic's fold goes, View product comes back; the shoes keep theirs", JSON.stringify(after) === JSON.stringify([["savannah-red", true, true, "-"], ["jillian-black", true, true, "-"], ["orthotic-one", false, false, "View product"]]) && !pinned, JSON.stringify({ after, pinned }));
    check("fold: no JS errors after a FIT is found", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // The store's own words for the button (Settings → Chat text), and no motion
  // for shoppers who prefer less.
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
    await ctx.addInitScript(() => { try { localStorage.setItem("hajirai_tf_site", "1"); } catch { /* */ } });
    const page = await ctx.newPage();
    await page.goto("http://localhost:4789/showcase?fitc=1&texts=fit");
    await page.waitForTimeout(500);
    await page.click(".ai-chat-launcher");
    await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "fitcards");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ai-chat-messages [data-fitq]");
    await page.waitForTimeout(300);
    const words = await page.$$eval(".ai-chat-messages [data-fitq]", (qs) => qs.slice(0, 2).map((q) => [q.textContent, q.getAttribute("aria-label")]));
    check("fold: the store's own words on the button, and the shoe's name for screen readers", JSON.stringify(words) === JSON.stringify([["Does this fit?", "Does this fit?, Savannah Adjustable Quarter Strap Sandal - Red"], ["Does this fit?", "Does this fit?, Jillian Braided Quarter Strap Sandal - Black"]]), JSON.stringify(words));
    const q = '.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"] [data-fitq]';
    const anim = await page.$eval(".ai-chat-messages .ai-fitp", (p) => getComputedStyle(p).transitionDuration);
    await page.click(q);
    const now = await page.$eval(q, (b) => Math.round(document.getElementById(b.getAttribute("aria-controls")).getBoundingClientRect().height));
    check("fold: reduced motion — it opens at once, nothing slides", /^0s(, 0s)*$/.test(anim) && now > 60, `${anim} / ${now}px`);
    await ctx.close();
  }
  // The levels the store shows (Smart Recommenders → Fit confidence): all
  // three — Fair in orange; none — every card keeps just its size tool.
  {
    const levelsOf = async (path) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      await ctx.addInitScript(() => { try { localStorage.setItem("hajirai_tf_site", "1"); } catch { /* */ } });
      const page = await ctx.newPage();
      await page.goto("http://localhost:4789" + path);
      await page.waitForTimeout(500);
      await page.click(".ai-chat-launcher");
      await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "fitcards");
      await page.keyboard.press("Enter");
      await page.waitForSelector(".ai-chat-messages [data-fitq]");
      await page.waitForTimeout(300);
      const res = await page.$$eval(".ai-chat-messages .ai-chat-product-card", (cs) => cs.map((c) => {
        const f = c.querySelector(".ai-tool--fit");
        const lv = f ? ["high", "mid", "fair"].find((v) => f.classList.contains("is-" + v)) : "";
        return { h: c.dataset.handle, fit: lv ? lv[0].toUpperCase() + lv.slice(1) : "", ring: f ? getComputedStyle(f.querySelector(".ai-tool__info")).color : "", color: f ? getComputedStyle(f.querySelector(".ai-tool__title")).color : "", runs: f ? f.querySelector(".ai-tool__title .ai-tool__short").textContent : "", tools: c.querySelectorAll(".ai-fitp .ai-tool").length, dark: c.closest(".ai-chat-panel").getAttribute("data-theme") === "dark" };
      }));
      await ctx.close();
      return Object.fromEntries(res.map((r) => [r.h, r]));
    };
    const all = await levelsOf("/showcase?fitc=1&fitl=all");
    const fair = all["fair-1"];
    const orange = fair?.dark ? ["rgb(255, 169, 77)", "rgb(255, 190, 115)"] : ["rgb(240, 140, 42)", "rgb(178, 90, 7)"];
    check("fit levels: all three shown — a Fair style says Fair in orange, and how it runs in orange", fair?.fit === "Fair" && fair.runs === "Runs small" && fair.ring === orange[0] && fair.color === orange[1] && all["savannah-red"]?.fit === "High" && all["jillian-black"]?.fit === "Mid", JSON.stringify([fair, all["savannah-red"]?.fit]));
    const none = await levelsOf("/showcase?fitc=1&fitl=none");
    check("fit levels: none shown — no Fit tile anywhere; every card keeps its size tool in the fold", Object.values(none).every((r) => !r.fit) && none["savannah-red"]?.tools === 1 && none["orthotic-one"]?.tools === 1, JSON.stringify(Object.values(none).map((r) => [r.h, r.fit, r.tools])));
  }
  // A lone card: the button centered under the buy button; while the size
  // picker is open inside the card, it steps aside like View product did.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(() => { try { localStorage.setItem("hajirai_tf_site", "1"); } catch { /* */ } });
    const page = await ctx.newPage();
    await page.goto("http://localhost:4789/showcase?fitc=1");
    await page.waitForTimeout(500);
    await page.click(".ai-chat-launcher");
    await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "fitcard");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ai-chat-messages [data-fitq]");
    await page.waitForTimeout(300);
    const lone = await page.$eval(".ai-chat-messages .ai-chat-product-card", (c) => {
      const q = c.querySelector("[data-fitq]"), l = q.querySelector(".ai-fitq__label"), cr = c.getBoundingClientRect(), lr = l.getBoundingClientRect(), cta = c.querySelector("[data-atc]").getBoundingClientRect();
      return { only: c.parentNode.children.length === 1, centered: Math.abs((lr.left + lr.right) / 2 - (cta.left + cta.right) / 2) < 2, view: !!c.querySelector(".ai-chat-view-link"), inside: lr.left >= cr.left && lr.right <= cr.right };
    });
    check("fold: a lone card — the button centered under its buy button, no View product", lone.only && lone.centered && !lone.view && lone.inside, JSON.stringify(lone));
    await page.click(".ai-chat-messages .ai-chat-product-card [data-fitq]");
    await page.waitForTimeout(400);
    await page.click(".ai-chat-messages .ai-chat-product-card [data-atc]");
    await page.waitForSelector(".ai-chat-product-card.has-inline-picker", { timeout: 5000 }).catch(() => {});
    const aside = await page.$eval(".ai-chat-messages .ai-chat-product-card", (c) => ({ picker: c.classList.contains("has-inline-picker"), q: getComputedStyle(c.querySelector("[data-fitq]")).display, p: getComputedStyle(c.querySelector(".ai-fitp")).display }));
    check("fold: the size picker inside the card — the button and its tiles step aside", aside.picker && aside.q === "none" && aside.p === "none", JSON.stringify(aside));
    await ctx.close();
  }
  // Every card's tools: where they sit, what they say, whether anything is cut.
  const readTools = (page, scope) => page.evaluate((scope) => [...document.querySelectorAll(`${scope} .ai-chat-product-card`)].map((c) => {
    const row = c.querySelector(".ai-tools");
    if (!row) return { handle: c.dataset.handle, n: 0 };
    const cr = c.getBoundingClientRect(), rr = row.getBoundingClientRect();
    const cta = c.querySelector("[data-atc]"), view = c.querySelector(".ai-chat-view-link");
    const shown = (x) => x && getComputedStyle(x).display !== "none" && x.getBoundingClientRect().width > 0;
    const tiles = [...row.querySelectorAll(".ai-tool")].map((b) => {
      const r = b.getBoundingClientRect();
      const words = [...b.querySelectorAll(".ai-tool__long, .ai-tool__short")].filter(shown);
      const cut = [...b.querySelectorAll(".ai-tool__title, .ai-tool__sub")].filter(shown).some((x) => x.scrollWidth > x.clientWidth + 1);
      const info = b.querySelector(".ai-tool__info"), go = b.querySelector(".ai-tool__go"), ttl = b.querySelector(".ai-tool__title");
      const lv = ["high", "mid", "fair"].find((v) => b.classList.contains("ai-tool--fit") && b.classList.contains("is-" + v));
      return { kind: b.classList.contains("ai-tool--fit") ? "fit" : b.dataset.truefit ? "truefit" : b.dataset.helper, text: words.map((x) => x.textContent).join(" / "), lvl: lv ? lv[0].toUpperCase() + lv.slice(1) : "", info: shown(info), ring: info ? getComputedStyle(info).color : "", go: shown(go), band: getComputedStyle(b).backgroundColor, color: ttl ? getComputedStyle(ttl).color : "", label: b.getAttribute("aria-label"), popup: b.getAttribute("aria-haspopup"), w: Math.round(r.width), h: Math.round(r.height), inside: r.left >= cr.left - 0.5 && r.right <= cr.right + 0.5, cut };
    });
    const t0 = row.children[0]?.getBoundingClientRect(), t1 = row.children[1]?.getBoundingClientRect();
    return { handle: c.dataset.handle, n: tiles.length, data: row.getAttribute("data-n"), tiles, rowW: Math.round(rr.width), afterCta: !!(cta.compareDocumentPosition(row) & 4), inFold: !!row.closest(".ai-fitp.is-open"), view: !!view, dark: c.closest(".ai-chat-panel")?.getAttribute("data-theme") === "dark", sameRow: tiles.length === 2 ? Math.abs(t0.top - t1.top) < 1 : true, stacked: tiles.length === 2 ? t1.top >= t0.bottom - 0.5 && Math.abs(t0.left - t1.left) < 1 : true };
  }), scope);
  for (const [label, path, opts] of layouts) {
    const ctx = await browser.newContext({ ...opts, deviceScaleFactor: 2 });
    await ctx.addInitScript(() => { try { localStorage.setItem("hajirai_tf_site", "1"); } catch { /* */ } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:4789" + path);
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(400);
    await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "fitcards");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ai-chat-messages [data-fitq]", { timeout: 6000 });
    await page.waitForTimeout(300);
    // Folded at first: one quiet button under the buy button, where View product was.
    const folds = () => page.$$eval(".ai-chat-messages .ai-chat-product-card", (cs) => cs.map((c) => {
      const q = c.querySelector("[data-fitq]"), view = c.querySelector(".ai-chat-view-link");
      if (!q) return { h: c.dataset.handle, q: false, view: !!view };
      const p = document.getElementById(q.getAttribute("aria-controls")), cta = c.querySelector("[data-atc]"), info = c.querySelector(".ai-chat-product-info");
      const qr = q.getBoundingClientRect(), cr = c.getBoundingClientRect(), st = getComputedStyle(info);
      const room = info.getBoundingClientRect().width - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight);
      return { h: c.dataset.handle, q: true, view: !!view, text: q.textContent, label: q.getAttribute("aria-label"), exp: q.getAttribute("aria-expanded"), order: !!p && c.contains(p) && !!(cta.compareDocumentPosition(q) & 4) && !!(q.compareDocumentPosition(p) & 4), ph: Math.round(p.getBoundingClientRect().height), hidden: getComputedStyle(p).visibility === "hidden", tall: Math.round(qr.height), full: qr.width >= room - 1, inside: qr.left >= cr.left - 0.5 && qr.right <= cr.right + 0.5, cardH: cr.height };
    }));
    const f0 = await folds();
    check(`fold (${label}): every card folds its tiles under "Check fit & size" — no View product, nothing showing yet`, f0.every((f) => f.q && !f.view && f.text === "Check fit & size" && f.exp === "false" && f.order && f.ph === 0 && f.hidden), JSON.stringify(f0.map((f) => [f.h, f.text, f.exp, f.order, f.ph, f.hidden, f.view])));
    check(`fold (${label}): the button is the card's whole width, easy to tap, inside the card, and names the shoe for screen readers`, f0.every((f) => f.full && f.tall >= 32 && f.inside) && f0[0].label === "Check fit & size, Savannah Adjustable Quarter Strap Sandal - Red", JSON.stringify(f0.map((f) => [f.h, f.tall, f.full, f.inside, f.label])));
    // Folded tiles are out of the tab order.
    await page.focus('.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"] [data-fitq]');
    await page.keyboard.press("Tab");
    const skipped = await page.evaluate(() => !document.activeElement.closest('.ai-chat-product-card[data-handle="savannah-red"] .ai-fitp'));
    check(`fold (${label}): folded, Tab skips its tiles`, skipped);
    // Opening one card's: only that card grows; the rest of its row keep their height.
    await page.click('.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"] [data-fitq]');
    await page.waitForTimeout(450);
    const f1 = await folds();
    const grew = f1[0].cardH - f0[0].cardH, same = f1.slice(1).every((f, i) => Math.abs(f.cardH - f0[i + 1].cardH) < 0.6);
    check(`fold (${label}): tapping it opens that card's tiles smoothly — just that card grows`, f1[0].exp === "true" && f1[0].ph > 60 && !f1[0].hidden && grew > 60 && same && f1.slice(1).every((f) => f.exp === "false"), JSON.stringify({ grew, heights: f1.map((f, i) => Math.round(f.cardH - f0[i].cardH)) }));
    // Tapped again, it folds back.
    await page.click('.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"] [data-fitq]');
    await page.waitForTimeout(450);
    const f2 = await folds();
    const unpinned = await page.$$eval(".ai-chat-messages .ai-chat-products", (rs) => rs.every((r) => !r.classList.contains("is-fitq-open") && [...r.children].every((c) => !c.style.minHeight)));
    check(`fold (${label}): tapped again, it folds back; the row is as it was`, f2[0].exp === "false" && f2[0].ph === 0 && f2[0].hidden && Math.abs(f2[0].cardH - f0[0].cardH) < 0.6 && unpinned, JSON.stringify({ f2: f2[0], unpinned }));
    if (label === "showcase desktop") {
      // The keyboard: Enter and Space open and fold it.
      await page.focus('.ai-chat-messages .ai-chat-product-card[data-handle="jillian-black"] [data-fitq]');
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      const kOpen = await page.$eval('.ai-chat-messages .ai-chat-product-card[data-handle="jillian-black"] [data-fitq]', (q) => q.getAttribute("aria-expanded"));
      await page.keyboard.press("Space");
      await page.waitForTimeout(400);
      const kShut = await page.$eval('.ai-chat-messages .ai-chat-product-card[data-handle="jillian-black"] [data-fitq]', (q) => q.getAttribute("aria-expanded"));
      check("fold: Enter opens it, Space folds it", kOpen === "true" && kShut === "false", `${kOpen}/${kShut}`);
    }
    // Every card open, for the tiles' own checks.
    for (const h of f0.map((f) => f.h)) await page.click(`.ai-chat-messages .ai-chat-product-card[data-handle="${h}"] [data-fitq]`);
    await page.waitForTimeout(450);
    const cards = await readTools(page, ".ai-chat-messages");
    const by = Object.fromEntries(cards.map((c) => [c.handle, c]));
    await page.screenshot({ path: out(`tools-${label.replace(/\s/g, "-")}`) });
    const a = by["savannah-red"];
    const w = a.rowW;
    check(`tools (${label}): opened under the buy button — Fit above Size (${w}px; side by side only from 340px)`, a?.n === 2 && a.data === "2" && a.afterCta && a.inFold && !a.view && (w >= 340 ? a.sameRow : a.stacked) && a.tiles[0].kind === "fit" && a.tiles[1].kind === "truefit", JSON.stringify(a));
    check(`tools (${label}): a word, not a number — High, with ⓘ (more behind it) and no chevron; the row says it all to screen readers and opens a dialog`, a?.tiles[0].lvl === "High" && a.tiles[0].info && !a.tiles[0].go && a.tiles[0].popup === "dialog" && a.tiles[0].label === "Fit confidence: High. Runs true to size. From reviews, sales and return history. Shows where this comes from.", JSON.stringify(a?.tiles[0]));
    // Each level its own color — only the ⓘ ring and how it runs; the rows stay a quiet grey.
    const LEVEL_COLORS = a.dark
      ? { high: ["rgb(79, 208, 129)", "rgb(111, 227, 154)"], mid: ["rgb(110, 164, 255)", "rgb(156, 192, 255)"], row: "rgba(255, 255, 255, 0.07)" }
      : { high: ["rgb(47, 166, 91)", "rgb(21, 122, 59)"], mid: ["rgb(59, 123, 240)", "rgb(31, 95, 207)"], row: "rgb(242, 242, 245)" };
    const jt = by["jillian-black"]?.tiles[0];
    check(`tools (${label}): High is green, Mid is blue — the ⓘ ring and the words, nothing more`, a.tiles[0].ring === LEVEL_COLORS.high[0] && a.tiles[0].color === LEVEL_COLORS.high[1] && jt?.ring === LEVEL_COLORS.mid[0] && jt.color === LEVEL_COLORS.mid[1] && a.tiles[0].band === LEVEL_COLORS.row && jt.band === LEVEL_COLORS.row, JSON.stringify([a.tiles[0], jt]));
    check(`tools (${label}): True Fit is the same quiet grey row, with a chevron where there's room (${w}px)`, a.tiles[1].band === LEVEL_COLORS.row && a.tiles[1].go === (w >= 120) && !a.tiles[1].info, JSON.stringify(a.tiles[1]));
    check(`tools (${label}): a Fair style (not shown by default) has only the size tool`, by["fair-1"]?.n === 1 && by["fair-1"].tiles[0].kind === "truefit", JSON.stringify(by["fair-1"]));
    check(`tools (${label}): every tile inside its card, easy to tap (44px+), no words cut`, cards.every((c) => !c.n || c.tiles.every((t) => t.inside && t.h >= 44 && !t.cut)), JSON.stringify(cards.map((c) => [c.handle, c.rowW, (c.tiles || []).map((t) => `${t.text}@${t.w}x${t.h}${t.cut ? "!" : ""}`)])));
    // How it runs always shows; the line under it and the long words come in as the card widens.
    const fitText = a.tiles[0].text, sizeText = a.tiles[1].text;
    const long = w >= 420 || (w >= 196 && w < 340);
    const expect = long ? ["Runs true to size / High confidence", "Find your size / with True Fit"] : w >= 140 ? ["True to size / High confidence", "Your size / True Fit"] : ["True to size", "Your size"];
    check(`tools (${label}): the words for a ${w}px row`, fitText === expect[0] && sizeText === expect[1], `${fitText} | ${sizeText}`);
    const b = by["jillian-black"];
    check(`tools (${label}): in the shopper's own size`, b?.tiles[0].lvl === "Mid" && b.tiles[0].text === (w >= 140 ? "Runs small / Mid confidence" : "Runs small"), JSON.stringify(b?.tiles[0]));
    check(`tools (${label}): one tool alone takes the row (an orthotic's FITFinder, a shoe without a score)`, by["orthotic-one"]?.n === 1 && by["orthotic-one"].tiles[0].kind === "fitfinder" && by["carly-white"]?.n === 1 && by["carly-white"].tiles[0].kind === "truefit" && by["carly-white"].tiles[0].w >= a.rowW - 1, JSON.stringify([by["orthotic-one"], by["carly-white"]]));
    check(`tools (${label}): no Fit tile without a real score; a made-up label or size is left out`, by["odd-1"]?.tiles.every((t) => t.kind !== "fit") && by["odd-2"]?.tiles[0].kind === "fit" && by["odd-2"].tiles[0].lvl === "Mid" && by["odd-2"].tiles[0].label === "Fit confidence: Mid. Shows where this comes from.", JSON.stringify([by["odd-1"], by["odd-2"]?.tiles[0]]));

    // Where the number comes from.
    const tile = '.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"] [data-fitx]';
    await page.click(tile);
    await page.waitForTimeout(450);
    const sheet = () => page.evaluate(() => {
      const sh = document.querySelector(".ai-fitx"), card = sh && sh.querySelector(".ai-fitx__sheet"), p = document.querySelector(".ai-chat-panel");
      if (!sh || sh.hidden) return { open: false };
      const r = card.getBoundingClientRect(), pr = p.getBoundingClientRect();
      return {
        open: sh.classList.contains("is-open"), role: card.getAttribute("role"), modal: card.getAttribute("aria-modal"), title: card.querySelector("#ai-fitx-title")?.textContent,
        ring: card.querySelector(".ai-fitx__ring .ai-tool__lvl")?.textContent, prod: card.querySelector(".ai-fitx__prod")?.textContent, pill: card.querySelector(".ai-fitx__pill")?.textContent || "",
        pillColor: card.querySelector(".ai-fitx__pill") ? getComputedStyle(card.querySelector(".ai-fitx__pill")).color : "", ringColor: card.querySelector(".ai-fitx__ring .ai-ring__arc") ? getComputedStyle(card.querySelector(".ai-fitx__ring .ai-ring__arc")).stroke : "",
        rows: [...card.querySelectorAll(".ai-fitx__row")].map((x) => x.querySelector(".ai-fitx__rh").textContent + ": " + [...x.querySelectorAll(".ai-fitx__rp, .ai-fitx__key li")].map((y) => y.textContent).join(" | ")),
        tf: !!card.querySelector(".ai-fitx__tf[data-truefit]"), focus: document.activeElement?.className || "",
        inside: r.left >= pr.left - 0.5 && r.right <= pr.right + 0.5 && r.bottom <= pr.bottom + 0.5 && r.top >= pr.top - 0.5, sideways: card.scrollWidth > card.clientWidth + 1,
        behind: document.querySelector(".ai-chat-messages").closest("[inert]") !== null || !!document.querySelector(".ai-chat-panel > [data-fx-inert]"),
      };
    });
    const s1 = await sheet();
    await page.screenshot({ path: out(`fitx-${label.replace(/\s/g, "-")}`) });
    check(`fit sheet (${label}): opens over the chat, inside it, focus on its close button, the chat behind out of reach`, s1.open && s1.role === "dialog" && s1.modal === "true" && s1.inside && !s1.sideways && /ai-fitx__x/.test(s1.focus) && s1.behind, JSON.stringify(s1));
    check(`fit sheet (${label}): the level, the shoe, how it runs — in the level's color`, s1.title === "High confidence" && s1.ring === "High" && s1.prod === "Savannah Adjustable Quarter Strap Sandal - Red" && s1.pill === "Runs true to size" && s1.ringColor === LEVEL_COLORS.high[0] && s1.pillColor === LEVEL_COLORS.high[1], JSON.stringify(s1));
    check(`fit sheet (${label}): what reviewers said and what buyers kept, in words — no counts or percentages; True Fit one tap away`, JSON.stringify(s1.rows) === JSON.stringify([
      "What reviewers said: Most say it’s true to size. | Runs small | True to size | Runs large | Width: most say it’s true to width.",
      "What buyers kept: From sales and return history, most pairs aren’t sent back for fit.",
    ]) && s1.tf && !/\d/.test(s1.rows.join(" ")), JSON.stringify(s1.rows));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const closed = await page.evaluate(() => ({ hidden: document.querySelector(".ai-fitx").hidden, focus: document.activeElement?.getAttribute("data-fitx") !== null && document.activeElement?.closest(".ai-chat-product-card")?.dataset.handle, chatOpen: !!document.querySelector(".ai-chat-panel.open"), inert: document.querySelectorAll(".ai-chat-panel [data-fx-inert]").length }));
    check(`fit sheet (${label}): Escape closes it — back on the tile, the chat still open and usable`, closed.hidden && closed.focus === "savannah-red" && closed.chatOpen && closed.inert === 0, JSON.stringify(closed));
    // The shopper's own size, and no AfterShip reasons: said as they are.
    await page.click('.ai-chat-messages .ai-chat-product-card[data-handle="jillian-black"] [data-fitx]');
    await page.waitForTimeout(400);
    const s2 = await sheet();
    check(`fit sheet (${label}): in the shopper's own size`, s2.pill === "Runs small" && s2.rows[0] === "For your size 9: The size you’ve kept before, from your orders. In size 9, most pairs aren’t sent back for fit.", JSON.stringify(s2.rows));
    await page.click(".ai-fitx__scrim", { position: { x: 20, y: 20 } });
    await page.waitForTimeout(400);
    check(`fit sheet (${label}): a tap outside closes it`, await page.evaluate(() => document.querySelector(".ai-fitx").hidden));
    if (label === "showcase desktop") {
      await page.click('.ai-chat-messages .ai-chat-product-card[data-handle="runs-1"] [data-fitx]');
      await page.waitForTimeout(400);
      const s3 = await sheet();
      check("fit sheet: without AfterShip's reasons, every return counts — said so", s3.rows[1] === "What buyers kept: From sales and return history, most pairs aren’t sent back." && s3.pill === "Runs small", JSON.stringify(s3.rows));
      await page.click(".ai-fitx__x");
      await page.waitForTimeout(400);
      await page.click('.ai-chat-messages .ai-chat-product-card[data-handle="odd-2"] [data-fitx]');
      await page.waitForTimeout(400);
      const s4 = await sheet();
      check("fit sheet: nothing to go on yet — says so, invents nothing (True Fit still there: it's a shoe)",JSON.stringify(s4.rows) === JSON.stringify(["What reviewers said: No reviewer has rated the fit yet.", "What buyers kept: Not enough sales in the last year to go by yet."]) && s4.pill === "" && s4.tf, JSON.stringify(s4));
      // Tab stays in the sheet.
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      check("fit sheet: Tab keeps focus in the sheet", await page.evaluate(() => !!document.activeElement.closest(".ai-fitx__sheet")));
      await page.click(".ai-fitx__x");
      await page.waitForTimeout(400);
      // In View all: over the list; Escape closes only the sheet.
      await page.click("[data-viewall]");
      await page.waitForTimeout(700);
      const list = (await readTools(page, ".ai-chat-fbsheet__list")).map((c) => [c.handle, (c.tiles || []).map((t) => t.kind).join("+")]);
      check("fit: View all's cards have the same tools", JSON.stringify(list.slice(0, 4)) === JSON.stringify([["savannah-red", "fit+truefit"], ["jillian-black", "fit+truefit"], ["orthotic-one", "fitfinder"], ["carly-white", "truefit"]]), JSON.stringify(list));
      check("fold: View all's cards fold theirs too", await page.$$eval(".ai-chat-fbsheet__list .ai-chat-product-card", (cs) => cs.every((c) => c.querySelector("[data-fitq]")?.getAttribute("aria-expanded") === "false" && !c.querySelector(".ai-chat-view-link"))));
      await page.click('.ai-chat-fbsheet__list .ai-chat-product-card[data-handle="savannah-red"] [data-fitq]');
      await page.waitForTimeout(450);
      await page.screenshot({ path: out("fold-view-all") });
      await page.click('.ai-chat-fbsheet__list .ai-chat-product-card[data-handle="savannah-red"] [data-fitx]');
      await page.waitForTimeout(450);
      // Really over it: shown, on top where it's tapped, the list behind out of reach.
      const over = await page.evaluate(() => {
        const a = document.querySelector(".ai-fitx"), b = document.querySelector(".ai-chat-fbsheet"), r = a.querySelector(".ai-fitx__sheet").getBoundingClientRect();
        const hit = r.width > 0 ? document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(40, r.height / 2)) : null;
        return { open: !a.hidden && getComputedStyle(a).display !== "none", above: Number(getComputedStyle(a).zIndex) > Number(getComputedStyle(b).zIndex), onTop: !!hit && !!hit.closest(".ai-fitx__sheet"), wide: document.querySelector(".ai-chat-panel").classList.contains("is-wide"), listInert: !!b.inert };
      });
      await page.screenshot({ path: out("fitx-over-view-all") });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(450);
      const after = await page.evaluate(() => ({ fitx: document.querySelector(".ai-fitx").hidden, list: !document.querySelector(".ai-chat-fbsheet").hidden, listInert: !!document.querySelector(".ai-chat-fbsheet").inert }));
      check("fit sheet: over View all (wide too) — seen and on top, the list out of reach; Escape closes only it, the list usable again", over.open && over.above && over.onTop && over.listInert && after.fitx && after.list && !after.listInert, JSON.stringify({ over, after }));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      // Light theme: its own colors; after a reload the tiles come back.
      const ringDark = await page.$eval(".ai-chat-messages .ai-tool__info", (x) => getComputedStyle(x).color);
      await page.click(".ai-chat-theme-btn");
      await page.waitForTimeout(250);
      const ringLight = await page.$eval(".ai-chat-messages .ai-tool__info", (x) => getComputedStyle(x).color);
      await page.screenshot({ path: out("tools-showcase-light") });
      check("tools: light and dark each have their own ring color", ringDark !== ringLight, `${ringDark} / ${ringLight}`);
      await page.reload();
      await page.waitForTimeout(800);
      if (!(await page.$(".ai-chat-panel.open"))) await page.click(".ai-chat-launcher");
      await page.waitForSelector(".ai-chat-messages [data-fitq]", { timeout: 5000 }).catch(() => {});
      const again = (await readTools(page, ".ai-chat-messages")).map((c) => [c.handle, (c.tiles || []).map((t) => t.kind + (t.lvl ? ":" + t.lvl : "")).join("+")]);
      check("tools: after a reload the cards come back with them, folded", JSON.stringify(again.slice(0, 2)) === JSON.stringify([["savannah-red", "fit:High+truefit"], ["jillian-black", "fit:Mid+truefit"]]) && await page.$$eval(".ai-chat-messages [data-fitq]", (qs) => qs.length > 0 && qs.every((q) => q.getAttribute("aria-expanded") === "false")), JSON.stringify(again));
    }
    check(`tools (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
}

// Buy now (Settings → Shopping tools): off unless the store turns it on; only
// on a card that already knows everything (size, width…); straight to
// checkout with the item, the store's code and the chat's credit — and a
// cart with other things in it is kept, never replaced.
{
  const SAV = vidFor("savannah-red", "8 US", "Medium");
  const CREDIT = "attributes%5B_seos_attributed%5D=1&attributes%5B_seos_buy_now%5D=1&ref=ava-chat";
  const open = async (path, msg = "show me 3", opts = { viewport: { width: 1280, height: 860 } }) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript(() => { try { localStorage.setItem("hajirai_tf_site", "1"); } catch { /* */ } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:4789" + path);
    await page.waitForTimeout(500);
    await page.click(".ai-chat-launcher");
    await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", msg);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ai-chat-messages .ai-chat-product-card [data-atc]");
    await page.waitForTimeout(400);
    return { ctx, page, errors };
  };
  const tapTo = async (page, sel, url) => { await Promise.all([page.waitForURL(url, { timeout: 8000 }), page.click(sel)]).catch(() => {}); return page.url(); };
  // Off by default (and off is exactly as before).
  {
    const { ctx, page } = await open("/showcase");
    check("buy now: off by default — no card shows it", (await page.$$("[data-buynow], .ai-buynow")).length === 0);
    await ctx.close();
  }
  // Which cards, and how it sits, at every width and layout.
  const layouts = [
    ["showcase desktop", "/showcase?buy=1", { viewport: { width: 1280, height: 860 } }],
    ["showcase phone", "/showcase?buy=1", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
    ["showcase small phone", "/showcase?buy=1", { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true }],
    ["row cards desktop", "/horizontal?buy=1", { viewport: { width: 1280, height: 860 } }],
    ["row cards phone", "/horizontal?buy=1", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
    ["row cards small phone", "/horizontal?buy=1", { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true }],
    ["fit confidence on, phone", "/showcase?buy=1&fitc=1", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
    ["fit confidence on, row cards small phone", "/horizontal?buy=1&fitc=1", { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true }],
  ];
  for (const [label, path, opts] of layouts) {
    for (const msg of ["show me 3", "show me 1"]) {
      const { ctx, page, errors } = await open(path, msg, { ...opts, deviceScaleFactor: 2 });
      const cards = await page.$$eval(".ai-chat-messages .ai-chat-product-card", (cs) => cs.map((c) => {
        const b = c.querySelector("[data-buynow]"), cta = c.querySelector("[data-atc]");
        if (!b) return { h: c.dataset.handle, b: false };
        const r = b.getBoundingClientRect(), a = cta.getBoundingClientRect(), cr = c.getBoundingClientRect();
        const cut = (x) => x.scrollWidth > x.clientWidth + 1;
        return { h: c.dataset.handle, b: true, text: b.textContent, label: b.getAttribute("aria-label"), hh: Math.round(r.height), ch: Math.round(a.height),
          inside: r.left >= cr.left - 0.5 && r.right <= cr.right + 0.5, overlap: !(r.right <= a.left + 0.5 || r.left >= a.right - 0.5 || r.bottom <= a.top + 0.5 || r.top >= a.bottom - 0.5),
          beside: Math.abs(r.top - a.top) < 2, below: r.top >= a.bottom - 0.5, cut: cut(b) || cut(cta), row: Math.round(b.parentNode.getBoundingClientRect().width), tool: !!c.querySelector(".ai-chat-card-fit") };
      }));
      const tag = `${label}, ${msg === "show me 1" ? "one card" : "three cards"}`;
      const by = Object.fromEntries(cards.map((c) => [c.h, c]));
      const s = by["savannah-red"];
      await page.screenshot({ path: out(`buynow-${tag.replace(/[ ,]+/g, "-")}`) });
      check(`buy now (${tag}): on the cards that know everything — not on one still to choose`, s?.b && (msg === "show me 1" || (by["jillian-black"] && !by["jillian-black"].b && by["orthotic-one"]?.b)), JSON.stringify(cards.map((c) => [c.h, c.b])));
      check(`buy now (${tag}): says Buy now, names the shoe and size for screen readers, as tall as Add to cart, inside the card, nothing cut or overlapping`, s?.text === "Buy now" && s.label === "Buy now, Savannah Adjustable Quarter Strap Sandal - Red, 8 US · Medium: straight to checkout" && s.hh >= 40 && Math.abs(s.hh - s.ch) <= 1 && s.inside && !s.overlap && !s.cut, JSON.stringify(s));
      const wide = s?.row >= (s?.tool ? 268 : 220);
      check(`buy now (${tag}): beside Add to cart where the row has room (${s?.row}px), under it where not`, wide ? s.beside : s.below, JSON.stringify(s));
      check(`buy now (${tag}): no JS errors`, errors.length === 0, errors.join(" | "));
      await ctx.close();
    }
  }
  // Empty cart: one link carries it all — the item, the code, the chat's credit.
  {
    mockCtl.cartCount = 0;
    const adds = cartLog.length;
    const { ctx, page } = await open("/showcase?buy=1");
    const url = await tapTo(page, '.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"] [data-buynow]', /\/cart\/\d+:1/);
    check("buy now, empty cart: straight to checkout by a cart link — the item, the chat's credit, the code; nothing added the slow way", buyNowLog.at(-1) === `/cart/${SAV}:1?${CREDIT}&discount=CHAT10` && /\/cart\//.test(url) && cartLog.length === adds, JSON.stringify({ last: buyNowLog.at(-1), url }));
    await ctx.close();
  }
  // A cart with other things in it is kept: the item joins it, credited, then checkout with the code.
  {
    mockCtl.cartCount = 2;
    const { ctx, page } = await open("/showcase?buy=1");
    const url = await tapTo(page, '.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"] [data-buynow]', /\/discount\//);
    check("buy now, cart with other things: they're kept — the item joins them, the order credited to the chat, then checkout with the code", cartLog.at(-1) === SAV && JSON.stringify(cartUpdates.at(-1)) === JSON.stringify({ attributes: { _seos_attributed: "1", _seos_buy_now: "1" } }) && buyNowLog.at(-1) === "/discount/CHAT10?redirect=%2Fcheckout" && /\/discount\/CHAT10/.test(url), JSON.stringify({ add: cartLog.at(-1), upd: cartUpdates.at(-1), last: buyNowLog.at(-1) }));
    await ctx.close();
  }
  // No code set: the same, without one.
  {
    mockCtl.cartCount = 0;
    let { ctx, page } = await open("/showcase?buy=2");
    await tapTo(page, '.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"] [data-buynow]', /\/cart\/\d+:1/);
    const a = buyNowLog.at(-1);
    await ctx.close();
    mockCtl.cartCount = 2;
    ({ ctx, page } = await open("/showcase?buy=2"));
    await tapTo(page, '.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"] [data-buynow]', /\/checkout/);
    const b = buyNowLog.at(-1);
    check("buy now, no code set: the cart link and checkout carry none", a === `/cart/${SAV}:1?${CREDIT}` && b === "/checkout", JSON.stringify([a, b]));
    await ctx.close();
  }
  // In the size picker: once the size and width are chosen, Buy now beside Add to cart.
  {
    mockCtl.cartCount = 0;
    const { ctx, page, errors } = await open("/showcase?buy=1", "show me 3", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.click('.ai-chat-messages .ai-chat-product-card[data-handle="jillian-black"] [data-atc]');
    await page.waitForSelector(".ai-chat-atc-panel .ai-chat-atc-val");
    const before = await page.$$(".ai-chat-atc-panel [data-atc-buynow]");
    await page.click('.ai-chat-atc-panel [data-opt="Size"][data-val="8 US"]');
    await page.click('.ai-chat-atc-panel [data-opt="Width"][data-val="Medium"]');
    await page.waitForTimeout(300);
    const row = await page.$eval(".ai-chat-atc-addrow", (r) => {
      const add = r.querySelector("[data-atc-add]"), now = r.querySelector("[data-atc-buynow]"), rr = r.getBoundingClientRect(), list = document.querySelector(".ai-chat-messages").getBoundingClientRect();
      const inside = (x) => { const q = x.getBoundingClientRect(); return q.left >= rr.left - 0.5 && q.right <= rr.right + 0.5; };
      return { now: !!now, text: now?.textContent, inside: !!now && inside(add) && inside(now), cut: !!now && (now.scrollWidth > now.clientWidth + 1 || add.scrollWidth > add.clientWidth + 1), h: now ? Math.round(now.getBoundingClientRect().height) : 0, inView: !!now && now.getBoundingClientRect().bottom <= list.bottom + 0.5 && add.getBoundingClientRect().top >= list.top - 0.5 };
    });
    await page.screenshot({ path: out("buynow-picker-phone") });
    check("buy now, picker: shown only once the choice is complete, with Add to cart, both in view, nothing cut", before.length === 0 && row.now && row.text === "Buy now" && row.inside && !row.cut && row.h >= 40 && row.inView, JSON.stringify(row));
    await tapTo(page, ".ai-chat-atc-panel [data-atc-buynow]", /\/cart\/\d+:1/);
    check("buy now, picker: goes straight to checkout with the size chosen", buyNowLog.at(-1) === `/cart/${vidFor("jillian-black", "8 US", "Medium")}:1?${CREDIT}&discount=CHAT10`, buyNowLog.at(-1));
    check("buy now, picker: no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // The size the card names is sold out: the picker opens to choose another — no checkout.
  {
    mockCtl.cartCount = 0;
    const n = buyNowLog.length;
    const { ctx, page } = await open("/showcase?buy=1", "buysoldout");
    await page.click('.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"] [data-buynow]');
    await page.waitForSelector(".ai-chat-atc-panel", { timeout: 5000 }).catch(() => {});
    const note = await page.textContent(".ai-chat-atc-panel .ai-chat-atc-note").catch(() => "");
    check("buy now, sold out: the picker opens to choose another; nowhere else", /sold out right now/.test(note) && buyNowLog.length === n && /\/showcase/.test(page.url()), JSON.stringify({ note, url: page.url() }));
    await ctx.close();
  }
  // The cart can't be reached: said so, and Buy now is ready to try again.
  {
    mockCtl.cartFail = true;
    const n = buyNowLog.length;
    const { ctx, page } = await open("/showcase?buy=1");
    await page.click('.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"] [data-buynow]');
    await page.waitForSelector(".ai-chat-atc-panel .ai-chat-atc-note.is-error", { timeout: 5000 }).catch(() => {});
    const err = await page.textContent(".ai-chat-atc-panel .ai-chat-atc-note.is-error").catch(() => "");
    const ready = await page.$eval('.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"] [data-buynow]', (b) => !b.disabled && !b.classList.contains("is-busy"));
    check("buy now, cart unreachable: the shopper is told, stays put, and can try again", /couldn’t start checkout/.test(err) && ready && buyNowLog.length === n, JSON.stringify({ err, ready }));
    await ctx.close();
    mockCtl.cartFail = false;
  }
  mockCtl.cartCount = null;
}

// AVA in Shopify Analytics (Settings → Integrations): the chat tells the
// server when a shopper adds to the cart or heads to checkout from it — the
// variant and quantity, never a price or anything about the shopper — and
// nothing at all when the store has it off.
{
  const SAV = String(vidFor("savannah-red", "8 US", "Medium"));
  const go = async (path) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addInitScript(() => { try { localStorage.setItem("hajirai_tf_site", "1"); } catch { /* */ } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:4789" + path);
    await page.waitForTimeout(500);
    await page.click(".ai-chat-launcher");
    await page.fill(".ai-chat-input-area textarea, .ai-chat-input-area input", "show me 3");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ai-chat-messages .ai-chat-product-card [data-atc]");
    await page.waitForTimeout(400);
    return { ctx, page, errors };
  };
  const fields = (a) => Object.keys(a).filter((k) => k !== "ct").sort().join(",");
  // Add to cart, then Checkout from the picker.
  {
    mockCtl.cartCount = 2;
    const n = activityLog.length;
    const { ctx, page, errors } = await go("/showcase?buy=1");
    await page.click('.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"] [data-atc]');
    await page.waitForSelector(".ai-chat-messages .ai-chat-atc-panel .ai-chat-atc-primary", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    const added = activityLog.slice(n);
    check("shopify analytics: an add to cart from the chat is told — its variant, quantity and a one-off id, nothing else", added.length === 1 && added[0].kind === "add_to_cart" && added[0].variant === SAV && added[0].quantity === 1 && /^[A-Za-z0-9_-]{8,64}$/.test(added[0].id) && fields(added[0]) === "id,kind,quantity,variant", JSON.stringify(added));
    const m = activityLog.length;
    await Promise.all([page.waitForURL(/\/checkout/, { timeout: 8000 }).catch(() => {}), page.click(".ai-chat-messages .ai-chat-atc-panel .ai-chat-atc-primary")]);
    await page.waitForTimeout(400);
    const out = activityLog.slice(m);
    check("shopify analytics: Checkout after adding is told as a checkout from the chat", out.length === 1 && out[0].kind === "checkout" && out[0].source === "checkout" && fields(out[0]) === "id,kind,source", JSON.stringify(out));
    check("shopify analytics: no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // Buy now: told as it leaves for checkout, with the variant.
  {
    mockCtl.cartCount = 0;
    const n = activityLog.length;
    const { ctx, page } = await go("/showcase?buy=1");
    await Promise.all([page.waitForURL(/\/cart\/\d+:1/, { timeout: 8000 }).catch(() => {}), page.click('.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"] [data-buynow]')]);
    await page.waitForTimeout(400);
    const out = activityLog.slice(n);
    check("shopify analytics: Buy now is told as a checkout from the chat, with its variant — nothing counted as an add", out.length === 1 && out[0].kind === "checkout" && out[0].source === "buy_now" && out[0].variant === SAV, JSON.stringify(out));
    await ctx.close();
  }
  // The store has it off: nothing told, the rest exactly as before.
  {
    mockCtl.cartCount = 2;
    const n = activityLog.length;
    const { ctx, page } = await go("/showcase?buy=1&aev=0");
    await page.click('.ai-chat-messages .ai-chat-product-card[data-handle="savannah-red"] [data-atc]');
    await page.waitForSelector(".ai-chat-messages .ai-chat-atc-panel .ai-chat-atc-primary", { timeout: 5000 }).catch(() => {});
    const done = await page.$(".ai-chat-messages .ai-chat-atc-panel .ai-chat-atc-primary");
    await Promise.all([page.waitForURL(/\/checkout/, { timeout: 8000 }).catch(() => {}), page.click(".ai-chat-messages .ai-chat-atc-panel .ai-chat-atc-primary").catch(() => {})]);
    await page.waitForTimeout(400);
    check("shopify analytics off: added and off to checkout as usual — nothing told", !!done && activityLog.length === n && /\/checkout/.test(page.url()), JSON.stringify({ told: activityLog.slice(n), url: page.url() }));
    await ctx.close();
  }
  mockCtl.cartCount = null;
}

await browser.close();
srv.close();
console.log(results.join("\n"));
const failedCount = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failedCount} passed, ${failedCount} failed`);
if (failedCount) process.exit(1);

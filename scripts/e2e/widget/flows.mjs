// Widget browser flows: cards, Add to cart (inline size picker, sold out,
// errors), checkout links, showcase/horizontal styles, FITFinder bridge,
// mobile layouts. Run: node scripts/e2e/widget/flows.mjs
import os from "node:os";
import { chromium } from "playwright";
const { start, peakImageLog, cartLog, buyNowLog, cartUpdates, chatBodies, fitSaves, returnBodies, startedReturns, mockCtl, compareLog, feedbackBodies, viewAllLog, viewAllIndexLog, viewAllCardsLog, BOOT_PRODUCTS, lookupBodies, appQrLog, APP_LINKS, activityLog, ordersLog, dealsLog } = await import("./mock-store.mjs");
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
// (Recordings' issues card reads only what shoppers type).
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
  await page.waitForTimeout(900); // past the panel's own post-open focus timers, which would steal the focus checks below
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
  await page.waitForSelector('.ai-chat-fbsheet[data-kind="fitfinder"].is-open', { timeout: 3000 });
  await page.waitForTimeout(300);
  const ffOpen = await page.evaluate(() => { const s = document.querySelector(".ai-chat-fbsheet"); const f = s.querySelector(".ai-chat-fbsheet__ff"); return { title: s.querySelector(".ai-chat-fbsheet__title").textContent, brand: f.querySelector(".ai-ffs__brand")?.textContent, head: f.querySelector(".ai-ffs__title")?.textContent, qs: [...f.querySelectorAll(".ai-ffs__qtext")].map((q) => q.textContent), helps: [...f.querySelectorAll(".ai-ffs__help")].map((b) => b.textContent), opts: [...f.querySelectorAll(".ai-ffs__opt")].map((o) => o.querySelector("b").textContent + "/" + (o.querySelector("small")?.textContent || "")), rec: !!f.querySelector(".ai-ffs__rec"), scan: f.querySelector(".ai-ffs__scan")?.textContent, powered: f.querySelector(".ai-ffs__powered")?.textContent, formHidden: getComputedStyle(s.querySelector(".ai-chat-fbsheet__form")).visibility === "hidden", shown: getComputedStyle(f).visibility === "visible" }; });
  check("tools: Find my FIT opens FITFinder in the chat's own sheet — the FITFINDER mark, Help me find my Fit, the two questions each with How do I know?, Yes / No tiles, no recommendation yet, the in-store scan link and Aetrex's mark; nothing sent to the assistant", ffOpen.title === "FITFinder" && ffOpen.brand === "FITFINDER" && ffOpen.head === "Help me find my Fit" && ffOpen.qs.join("|") === "Do you have flat feet?|Do you have pain beneath the ball of your foot?" && ffOpen.helps.join("|") === "How do I know?|How do I know?" && ffOpen.opts.join("|") === "Yes/Flat feet|No / Unsure/|Yes/I have pain|No / Unsure/No pain" && !ffOpen.rec && ffOpen.scan === "Scanned in one of our stores?" && ffOpen.powered === "Powered by Aetrex Technology" && ffOpen.formHidden && ffOpen.shown && !/orthotic FIT/i.test(chatBodies.at(-1)?.message || ""), JSON.stringify(ffOpen));
  // How do I know? opens its note; the first answer alone shows no FIT; both answers show the card (the open note stays open).
  await page.click(".ai-chat-fbsheet .ai-ffs__help");
  const helpOpen = await page.evaluate(() => { const b = document.querySelector(".ai-chat-fbsheet .ai-ffs__help"); const box = document.getElementById(b.getAttribute("aria-controls")); return { expanded: b.getAttribute("aria-expanded"), shown: !!box && !box.hidden && /wet footprint/.test(box.textContent) }; });
  await page.click('.ai-chat-fbsheet [data-ffs="opt"][data-o="a"]');
  const one = await page.evaluate(() => ({ pressed: [...document.querySelectorAll('.ai-chat-fbsheet [data-ffs="opt"][aria-pressed="true"]')].map((b) => b.dataset.o).join(","), rec: !!document.querySelector(".ai-chat-fbsheet .ai-ffs__rec") }));
  await page.click('.ai-chat-fbsheet [data-ffs="opt"][data-o="c"]');
  await page.waitForTimeout(150);
  const rec = await page.evaluate(() => { const r = document.querySelector(".ai-chat-fbsheet .ai-ffs__rec"); return r ? { label: r.querySelector(".ai-ffs__rec-label")?.textContent, key: r.querySelector(".ai-ffs__rec-key")?.textContent, name: r.querySelector(".ai-ffs__rec-name")?.textContent, desc: r.querySelector(".ai-ffs__rec-desc")?.textContent, more: r.querySelector(".ai-ffs__more")?.textContent, drawerHidden: r.querySelector(".ai-ffs__drawer")?.hidden, ctas: [...r.querySelectorAll(".ai-ffs__btn")].map((b) => b.textContent), note: r.querySelector(".ai-ffs__note")?.textContent, clear: document.querySelector(".ai-chat-fbsheet .ai-ffs__clearbtn")?.textContent, helpStill: !document.querySelector(".ai-chat-fbsheet .ai-ffs__helpbox").hidden, pressed: [...document.querySelectorAll('.ai-chat-fbsheet [data-ffs="opt"][aria-pressed="true"]')].map((b) => b.dataset.o).join(",") } : null; });
  check("tools: How do I know? opens the note under the question; Yes alone shows no FIT; Yes + Yes shows the card — Recommended fit · FIT D Maximum Support, its line, Learn more folded; signed in: Show orthotics in my FIT D / Done with the auto-save note; Start over; the open note stays open", helpOpen.expanded === "true" && helpOpen.shown && one.pressed === "a" && !one.rec && !!rec && rec.label === "Recommended fit" && rec.key === "FIT D" && rec.name === "Maximum Support" && /Posted plus/.test(rec.desc) && rec.more === "Learn more" && rec.drawerHidden === true && rec.ctas.join("|") === "Show orthotics in my FIT D|Done" && /signed in/.test(rec.note) && rec.clear === "Start over" && rec.helpStill && rec.pressed === "a,c", JSON.stringify({ helpOpen, one, rec }));
  // A changed answer changes the card in place; Learn more opens the details; Show orthotics saves the FIT (here and to the signed-in profile), closes the sheet and asks the assistant for them.
  await page.click('.ai-chat-fbsheet [data-ffs="opt"][data-o="d"]');
  await page.waitForTimeout(100);
  const swapped = await page.evaluate(() => document.querySelector(".ai-chat-fbsheet .ai-ffs__rec-key")?.textContent);
  await page.click('.ai-chat-fbsheet [data-ffs="opt"][data-o="c"]');
  await page.waitForTimeout(100);
  await page.click(".ai-chat-fbsheet .ai-ffs__more");
  const more = await page.evaluate(() => { const r = document.querySelector(".ai-chat-fbsheet .ai-ffs__drawer"); return { hidden: r.hidden, text: r.textContent }; });
  const nFit = chatBodies.length;
  await page.click('.ai-chat-fbsheet [data-ffs="shop"]');
  await waitUntil(() => chatBodies.length > nFit);
  await page.waitForTimeout(500);
  const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem("fitfinder_fit") || "{}"));
  check("tools: No under the second question makes it FIT A in place; Learn more opens the details; Show orthotics in my FIT D saves it (here and to the signed-in profile), closes the sheet and asks the assistant for orthotics in it", swapped === "FIT A" && !more.hidden && /most supportive/.test(more.text) && stored.key === "D" && fitSaves.at(-1)?.fitKey === "D" && chatBodies.at(-1)?.message === "Show me orthotics in my FIT D." && !(await page.evaluate(() => document.querySelector(".ai-chat-fbsheet").classList.contains("is-open"))), JSON.stringify({ swapped, more: more.hidden, stored, save: fitSaves.at(-1), msg: chatBodies.at(-1)?.message }));
  check("tools: once a FIT is saved, cards stop offering to find one", (await page.$$('[data-helper="fitfinder"].ai-chat-card-fit')).length === 0);
  check("tools: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// Settings → Focus home: every word on the Focus home comes from the store's
// Settings (blanks keep the built-in words); the line under the greeting and
// the note under the message box too.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full?home=focus&texts=home");
  await page.click(".ai-chat-launcher");
  await page.waitForFunction(() => document.querySelector(".ai-chat-focus__card--pain .ai-chat-focus__card-sub")?.textContent === "PAIN-SUB", null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const t = await page.evaluate(() => { const card = (k) => { const c = document.querySelector(`.ai-chat-focus__card--${k}`); return [c.querySelector(".ai-chat-focus__card-eyebrow").textContent, (c.querySelector(".ai-chat-focus__card-title .is-short") || c.querySelector(".ai-chat-focus__card-title")).textContent, c.querySelector(".ai-chat-focus__card-title .is-long")?.textContent || "", c.querySelector(".ai-chat-focus__card-sub").textContent, c.querySelector(".ai-chat-focus__card-cta").textContent.trim()].join("/"); }; return { pain: card("pain"), footwear: card("footwear"), orthotics: card("orthotics"), links: [...document.querySelectorAll(".ai-chat-focus__links [data-message]")].map((b) => b.textContent + "=" + b.getAttribute("data-message")).join("|"), greet: document.querySelector(".ai-chat-focus__greet .ai-chat-greet__item.is-in")?.textContent, note: document.querySelector(".ai-chat-footer")?.textContent }; });
  check("Settings → Focus home: the cards, the links, the greeting line and the note take the store's words; blanks keep the built-in ones", t.pain === "Sore feet?/Pain help/Tell us where it hurts/PAIN-SUB/Go" && t.footwear === "Help me find/Shoes//Sneakers, sandals, boots and more — support built in./Browse" && t.orthotics === "Help me find/Orthotics//Inserts for the shoes you already own, matched to your arch./See all" && t.links === "My order=Where's my package?|Returns & exchanges=I’d like to return or exchange something.|Sale=Show me the sale" && t.greet === "What brings you in?" && /^NOTE-X\. Privacy Policy$/.test(t.note || ""), JSON.stringify(t));
  const nT = chatBodies.length;
  await page.click('.ai-chat-focus__links [data-message="Show me the sale"]');
  await waitUntil(() => chatBodies.length > nT);
  check("Settings → Focus home: a link sends what it's set to ask", chatBodies.at(-1)?.message === "Show me the sale", chatBodies.at(-1)?.message);
  check("Settings → Focus home: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// FITFinder's sheet is only as tall as what it shows: it rises from the bottom
// at the questions' height, grows (smoothly) when the card comes in, stops
// short of the top; the chat above is dimmed, and a tap there closes it.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher");
  await page.waitForSelector('.ai-chat-welcome__helpers [data-helper="fitfinder"]', { timeout: 5000 });
  await page.click('.ai-chat-welcome__helpers [data-helper="fitfinder"]');
  await page.waitForTimeout(700);
  const geo = () => page.evaluate(() => { const s = document.querySelector(".ai-chat-fbsheet"), p = document.querySelector(".ai-chat-panel"); const r = s.getBoundingClientRect(), pr = p.getBoundingClientRect(); return { h: Math.round(r.height), ph: Math.round(pr.height), bottom: Math.round(pr.bottom - r.bottom), top: Math.round(r.top - pr.top), dim: /0\.3\d?\)\s*0px 0px 0px \d+px|0px 0px 0px \d+px rgba\(13, 13, 18, 0\.3/.test(getComputedStyle(s).boxShadow), groups: [...s.querySelectorAll('.ai-ffs__q[role="group"]')].every((g) => document.getElementById(g.getAttribute("aria-labelledby"))?.textContent) }; });
  const g0 = await geo();
  await page.click('[data-ffs="opt"][data-o="a"]');
  await page.click('[data-ffs="opt"][data-o="c"]');
  const gMid = await geo();
  await page.waitForTimeout(600);
  const g1 = await geo();
  check("FITFinder sheet: rises at the questions' height (not the whole chat), the chat above dimmed, each question a labelled group; the card coming in grows it smoothly (mid-way between), never past 24px from the top", g0.h < g0.ph - 150 && g0.bottom === 0 && g0.dim && g0.groups && g1.h > g0.h && g1.top >= 23 && g1.bottom === 0 && (gMid.h < g1.h || gMid.h === g1.h), JSON.stringify({ g0, gMid, g1 }));
  const pr = await page.evaluate(() => { const r = document.querySelector(".ai-chat-panel").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 10 }; });
  await page.mouse.click(pr.x, pr.y);
  await page.waitForTimeout(600);
  const shut = await page.evaluate(() => ({ open: document.querySelector(".ai-chat-fbsheet").classList.contains("is-open"), chat: getComputedStyle(document.querySelector(".ai-chat-panel")).visibility }));
  check("FITFinder sheet: a tap on the dimmed chat above closes the sheet, the chat stays open", !shut.open && shut.chat === "visible", JSON.stringify(shut));
  check("FITFinder sheet (height): no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// The home's three sheets dim the chat behind them even on a theme that hides
// empty divs (div:empty { display: none }, as the live store does), and a tap
// on the dimmed chat above closes them.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full?home=focus");
  await page.addStyleTag({ content: "div:empty{display:none!important}" });
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(700);
  const seen = [];
  for (const k of ["pain", "footwear", "orthotics"]) {
    await page.click(`[data-focus-sheet="${k}"]`);
    await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    await page.waitForTimeout(350);
    const dim = await page.evaluate(() => { const s = document.querySelector(".ai-chat-focus-sheet"); const m = getComputedStyle(s).backgroundColor.match(/[\d.]+/g) || []; return { a: parseFloat(m[3] || "0"), panelCursor: getComputedStyle(document.querySelector(".ai-chat-focus-sheet__body")).cursor }; });
    const h = await page.evaluate(() => { const r = document.querySelector(".ai-chat-header").getBoundingClientRect(); return [r.left + 60, r.top + r.height / 2]; });
    await page.mouse.click(h[0], h[1]);
    await page.waitForTimeout(450);
    seen.push({ k, ...dim, closed: !(await page.$(".ai-chat-focus-sheet")) });
  }
  check("home sheets (Foot pain, Footwear, Orthotics): the chat behind dims even when the theme hides empty divs, a tap on it closes the sheet, the sheet itself keeps a normal cursor", seen.length === 3 && seen.every((s) => s.a >= 0.3 && s.closed && s.panelCursor === "auto"), JSON.stringify(seen));
  check("home sheets (dim): no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// My rewards (?rw=1) and Talk to a person (?hh=1): instant cards, no AI
// call. "My rewards" is the first link on the Focus home and draws the
// store's card at once (balance read live when signed in; a sign-in link
// otherwise). "Talk to a person" is the first item in the ⋮ menu and shows
// the live chat, phone and email rows; a tap on one is logged. Both cards
// come back after a reload, and the chat sends the service-log fields.
for (const [vp, login, tag] of [[{ width: 390, height: 844 }, "&login=Ann", "phone, signed in"], [{ width: 1280, height: 860 }, "", "computer, signed out"]]) {
  const ctx = await browser.newContext({ viewport: vp });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:4789/full?home=focus&rw=1&hh=1${login}`);
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(800);
  const first = await page.$eval(".ai-chat-focus__links button:first-child", (b) => b.textContent.trim());
  const sentBefore = chatBodies.length;
  await page.click("[data-rewards-open]");
  await page.waitForFunction(() => /points|balance/.test(document.querySelector("[data-rw-bal]")?.textContent || ""), null, { timeout: 4000 });
  const card = await page.evaluate(() => { const c = document.querySelector(".ai-rw"); const r = c.getBoundingClientRect(); const over = [...c.querySelectorAll("*")].filter((e) => { const x = e.getBoundingClientRect(); return x.width && (x.right > r.right + 1 || x.left < r.left - 1); }).length; return { user: document.querySelector(".ai-chat-msg--user .ai-chat-msg-bubble")?.textContent.trim(), logo: !!c.querySelector(".ai-rw__logo"), bal: document.querySelector("[data-rw-bal]").textContent.trim(), earn: c.querySelectorAll(".ai-rw__col")[0]?.querySelectorAll("li").length, spend: c.querySelectorAll(".ai-rw__col")[1]?.querySelectorAll("li").length, notes: c.querySelectorAll(".ai-rw__notes li").length, cta: c.querySelector(".ai-rw__cta")?.getAttribute("href"), width: Math.round(r.width), over, fits: r.right <= window.innerWidth }; });
  check(`My rewards (${tag}): the first link on the home; one tap, no AI call, the card with the lockup, Earn and Spend, the notes and the rewards link`, first === "My rewards" && chatBodies.length === sentBefore && card.user === "My rewards" && card.logo && card.earn === 4 && card.spend === 4 && card.notes === 4 && card.cta === "https://www.example.com/pages/rewards" && card.over === 0 && card.fits, JSON.stringify(card));
  const landed = await page.evaluate(() => { const m = document.querySelector(".ai-chat-messages").getBoundingClientRect(); const u = document.querySelector(".ai-chat-msg--user").getBoundingClientRect(); const c = document.querySelector(".ai-rw").getBoundingClientRect(); return { userTop: Math.round(u.top - m.top), cardTop: Math.round(c.top - m.top), view: Math.round(m.height) }; });
  check(`My rewards (${tag}): the chat lands on the top of the card (the tap and the lockup in view), not its bottom`, landed.userTop >= -2 && landed.userTop < 80 && landed.cardTop < landed.view, JSON.stringify(landed));
  check(`My rewards (${tag}): ${login ? "the balance read live" : "a sign-in link instead of a balance"}`, login ? /^2,350 points · \$11\.75$/.test(card.bal) : /Log in to see your balance/.test(card.bal), card.bal);
  await page.click(".ai-chat-menu-btn");
  const items = await page.$$eval(".ai-chat-menu-item", (b) => b.map((x) => x.textContent.trim()));
  await page.click('.ai-chat-menu-item[data-action="human"]');
  await page.waitForSelector(".ai-hh", { timeout: 3000 });
  const hh = await page.$$eval(".ai-hh__row", (rows) => rows.map((r) => [r.getAttribute("data-human"), r.tagName, r.getAttribute("href") || "", r.querySelector("b").textContent, r.querySelector("span span")?.textContent || ""]));
  check(`Talk to a person (${tag}): first in the menu; live chat, phone (a tel link, with the hours) and email (a mailto link, with the reply time)`, items[0] === "Talk to a person" && hh.length === 3 && hh[0][0] === "live_chat" && hh[0][3] === "Chat with Aetrex Support" && hh[1][0] === "phone" && hh[1][2] === "tel:18885262739" && /Mon–Fri/.test(hh[1][4]) && hh[2][0] === "email" && hh[2][2] === "mailto:help@example.com" && /within 1 business day/.test(hh[2][4]), JSON.stringify({ items, hh }));
  const actsBefore = activityLog.filter((a) => a.kind === "human").length;
  await page.$eval('[data-human="email"]', (a) => a.addEventListener("click", (e) => e.preventDefault(), { once: true }));
  await page.click('[data-human="email"]');
  await page.waitForTimeout(400);
  const acts = activityLog.filter((a) => a.kind === "human").slice(actsBefore);
  check(`Talk to a person (${tag}): the tap is logged for the customer service log`, acts.length === 1 && acts[0].how === "email" && /^sess_/.test(acts[0].session_id || ""), JSON.stringify(acts));
  await page.fill(".ai-chat-input-area textarea", "show me 1");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ai-chat-product-card", { timeout: 8000 });
  const sent = chatBodies.at(-1);
  check(`service log (${tag}): the chat sends this browser's random id, that a person is offered, and the opening words with the first message`, /^v_[a-z0-9]+$/.test(sent.visitor || "") && sent.human_offered === true && typeof sent.disclosure === "string" && /personal shopping assistant/.test(sent.disclosure) && /may make mistakes/.test(sent.disclosure), JSON.stringify({ visitor: sent.visitor, human_offered: sent.human_offered, disclosure: sent.disclosure }));
  await page.reload();
  await page.click(".ai-chat-launcher");
  await page.waitForFunction(() => document.querySelector(".ai-rw") && document.querySelector(".ai-hh"), null, { timeout: 4000 }).catch(() => {});
  const back = await page.evaluate(() => ({ rw: !!document.querySelector(".ai-rw"), hh: !!document.querySelector(".ai-hh") }));
  check(`instant cards (${tag}): both come back after a reload`, back.rw && back.hh, JSON.stringify(back));
  check(`instant cards (${tag}): no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// Returns & exchanges (?rt=1) and the four pills: My rewards, Returns &
// exchanges, then the store's links (Deals) — all alike, no
// icons, one row that scrolls sideways on a phone. One tap on Returns &
// exchanges draws the card at once (no AI): signed in, the recent orders
// with the return button leading; signed out, sign in or an order lookup,
// with where to find the number. The card comes back after a reload.
for (const [vp, login, tag] of [[{ width: 360, height: 760 }, "&login=Ann", "phone, signed in"], [{ width: 1280, height: 860 }, "", "computer, signed out"]]) {
  const ctx = await browser.newContext({ viewport: vp });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (login) await ctx.addCookies([{ name: "signedin", value: "1", url: "http://localhost:4789" }]);
  await page.goto(`http://localhost:4789/full?home=focus&rw=1&hh=1&rt=1${login}`);
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(800);
  const pills = await page.evaluate(() => {
    const row = document.querySelector(".ai-chat-focus__links");
    const btns = [...row.querySelectorAll("button")];
    const st = btns.map((b) => { const c = getComputedStyle(b); return [c.borderColor, c.color, c.height, c.backgroundColor, c.fontWeight, c.fontSize].join("|"); });
    const tops = btns.map((b) => Math.round(b.getBoundingClientRect().top));
    return { labels: btns.map((b) => b.textContent.trim()), icons: row.querySelectorAll("svg, img").length, alike: new Set(st).size === 1, oneRow: new Set(tops).size === 1, scrolls: row.scrollWidth > row.clientWidth + 1, overflowX: getComputedStyle(row).overflowX, barHidden: getComputedStyle(row).scrollbarWidth === "none", rowInside: (() => { const r = row.getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1; })() };
  });
  check(`pills (${tag}): My rewards, Returns & exchanges, then the store's links — all alike, no icons, on one row`, pills.labels.join(" · ") === "My rewards · Returns & exchanges · Deals" && pills.icons === 0 && pills.alike && pills.oneRow, JSON.stringify(pills));
  if (vp.width < 500) check(`pills (${tag}): the row scrolls sideways within the screen, no bar`, pills.scrolls && pills.overflowX === "auto" && pills.barHidden && pills.rowInside, JSON.stringify(pills));
  const sentBefore = chatBodies.length, ordersBefore = ordersLog.length;
  await page.click("[data-returns-open]");
  await page.waitForSelector(".ai-rt", { timeout: 3000 });
  if (login) {
    await page.waitForSelector(".ai-rt .ai-ord", { timeout: 4000 });
    const got = await page.evaluate(() => {
      const card = document.querySelector(".ai-rt"), r = card.getBoundingClientRect();
      const first = card.querySelector(".ai-ord"), btns = [...first.querySelectorAll(".ai-ord__actions .ai-ord__btn")];
      const over = [...card.querySelectorAll("*")].filter((e) => { const x = e.getBoundingClientRect(); return x.width && (x.right > r.right + 1 || x.left < r.left - 1); }).length;
      return { user: document.querySelector(".ai-chat-msg--user .ai-chat-msg-bubble")?.textContent.trim(), title: card.querySelector(".ai-rt__head strong")?.textContent, orders: card.querySelectorAll(".ai-ord").length, lead: btns[0]?.textContent.trim(), leadPrimary: btns[0]?.classList.contains("is-primary"), second: btns[1]?.textContent.trim(), secondPrimary: btns[1]?.classList.contains("is-primary"), why: card.querySelectorAll(".ai-ord__why").length, whyText: card.querySelector(".ai-ord__why")?.textContent, more: card.querySelector(".ai-rt__more")?.textContent || "", over, fits: r.right <= window.innerWidth, wait: !!card.querySelector(".ai-rt__wait") };
    });
    check(`Returns & exchanges (${tag}): one tap, no AI call, the orders read once — the return button leads on the delivered order, tracking second; the one on its way says why; older orders go to the returns center`, chatBodies.length === sentBefore && ordersLog.length === ordersBefore + 1 && got.user === "Returns & exchanges" && got.title === "Returns & exchanges" && got.orders === 2 && got.lead === "Return an item" && got.leadPrimary && got.second === "Track package" && !got.secondPrimary && got.why === 1 && /delivered/.test(got.whyText) && /last 2 orders/.test(got.more) && /returns center/.test(got.more) && got.over === 0 && got.fits && !got.wait, JSON.stringify(got));
    await page.click('.ai-rt [data-ord-return]');
    await page.waitForSelector(".ai-ret", { timeout: 4000 });
    check(`Returns & exchanges (${tag}): Return an item starts the chat's own return flow on that order`, !!(await page.$(".ai-rt .ai-ret")), "");
    // The store's return rules (AfterShip's, mirrored): the gift card is listed greyed with why, never pickable; a damaged item sends back for free.
    await page.waitForSelector(".ai-rt .ai-ret__item[data-ret-item]", { timeout: 4000 });
    const picker = await page.evaluate(() => ({ pickable: document.querySelectorAll(".ai-rt .ai-ret__item[data-ret-item]").length, blocked: [...document.querySelectorAll(".ai-rt .ai-ret__item.is-blocked")].map((b) => [b.querySelector(".ai-ord__ititle")?.textContent, b.querySelector(".ai-ret__blocked")?.textContent, b.tagName, b.getAttribute("aria-disabled")]) }));
    check(`return rules (${tag}): the gift card is listed as not returnable (greyed, with why), the two real items pickable`, picker.pickable === 2 && JSON.stringify(picker.blocked) === JSON.stringify([["Aetrex eGift Card", "Gift cards can't be returned", "DIV", "true"]]), JSON.stringify(picker));
    await page.click('.ai-rt [data-ret-item="9001"]');
    await page.click('.ai-rt [data-ret-next="reason"]');
    await page.click('.ai-rt [data-ret-reason="damaged"]');
    await page.waitForSelector(".ai-rt .ai-ret__method", { timeout: 3000 });
    const fees = await page.evaluate(() => ({ free: [...document.querySelectorAll(".ai-rt .ai-ret__mfee")].map((f) => [f.classList.contains("is-free"), f.textContent.trim()]), note: [...document.querySelectorAll(".ai-rt .ai-ret__note")].map((n) => n.textContent).join(" | ") }));
    check(`return rules (${tag}): damaged — the return fee shows as waived on every way back`, fees.free.length === 2 && fees.free.every((f) => f[0] && /\$5\.95 Free$/.test(f[1])) && /No return fee for this reason/.test(fees.note), JSON.stringify(fees));
    await page.click('.ai-rt [data-ret-next="confirm"]');
    const confirm = await page.evaluate(() => ({ why: [...document.querySelectorAll(".ai-rt .ai-ret__why")].map((w) => w.innerHTML).join(" | "), swap: !!document.querySelector('.ai-rt [data-ret-submit="exchange"]') }));
    check(`return rules (${tag}): the summary shows the fee struck out and Free; damaged has no size swap`, /<s>\$5\.95<\/s> Free/.test(confirm.why) && !confirm.swap, JSON.stringify(confirm));
  } else {
    const got = await page.evaluate(() => {
      const card = document.querySelector(".ai-rt");
      const opts = [...card.querySelectorAll(".ai-ordl__opt")].map((o) => [o.getAttribute("data-ord-login") || (o.hasAttribute("data-ordl-open") ? "lookup" : o.getAttribute("href") || ""), o.querySelector("b")?.textContent]);
      const help = card.querySelector("[data-rt-help]"), list = document.getElementById(help?.getAttribute("aria-controls") || "");
      return { opts, head: !!card.querySelector(".ai-ordl__head"), helpHidden: list?.hidden, helpItems: list?.querySelectorAll("li b").length, helpWords: [...(list?.querySelectorAll("li b") || [])].map((b) => b.textContent), form: !!card.querySelector(".ai-ordl__form[hidden]") };
    });
    check(`Returns & exchanges (${tag}): sign in (back to this card), the returns center and an order lookup; where to find the number folded under`, JSON.stringify(got.opts) === JSON.stringify([["returns-card", "Sign in"], ["https://returns.example/", "Returns center"], ["lookup", "Order status"]]) && !got.head && got.helpHidden === true && got.helpWords.join("|") === "Order number|Confirmation number|Email" && got.form, JSON.stringify(got));
    await page.click("[data-rt-help]");
    const open = await page.evaluate(() => { const h = document.querySelector("[data-rt-help]"); return [h.getAttribute("aria-expanded"), document.getElementById(h.getAttribute("aria-controls")).hidden]; });
    check(`Returns & exchanges (${tag}): the help opens on a tap`, open[0] === "true" && open[1] === false, JSON.stringify(open));
    await page.click(".ai-rt [data-ordl-open]");
    await page.fill(".ai-rt input[name=order]", "1172010");
    await page.fill(".ai-rt input[name=email]", "pat@example.com");
    await page.click(".ai-rt .ai-ordl__go");
    await page.waitForSelector(".ai-rt .ai-ord[data-ord]", { timeout: 4000 }).catch(() => {});
    const looked = await page.evaluate(() => ({ order: document.querySelector(".ai-rt .ai-ord__num")?.textContent, signin: document.querySelector('.ai-rt [data-ord-login="return"]')?.textContent.trim() }));
    check(`Returns & exchanges (${tag}): the looked-up order shows with Sign in to return`, /1172010/.test(looked.order || "") && looked.signin === "Sign in to return", JSON.stringify(looked));
  }
  await page.reload();
  await page.click(".ai-chat-launcher");
  await page.waitForFunction(() => document.querySelector(".ai-rt") && (document.querySelector(".ai-rt .ai-ord") || document.querySelector(".ai-rt .ai-ordl")), null, { timeout: 4000 }).catch(() => {});
  const back = await page.evaluate(() => ({ rt: !!document.querySelector(".ai-rt"), orders: document.querySelectorAll(".ai-rt .ai-ord").length, lookup: !!document.querySelector(".ai-rt .ai-ordl") }));
  check(`Returns & exchanges (${tag}): the card comes back after a reload${login ? " with the orders, without another read" : ""}`, back.rt && (login ? back.orders === 2 && ordersLog.length === ordersBefore + 1 : back.lookup), JSON.stringify({ back, reads: ordersLog.length - ordersBefore }));
  check(`Returns & exchanges (${tag}): no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// Deals (?dl=1): the Deals pill comes last (the store's own "Deals" link
// steps aside), one tap draws the card — the running offers (a code to copy,
// an end) then the products on sale as the chat's usual cards — read once
// and kept with the message, so it comes back after a reload without a read.
for (const [vp, tag] of [[{ width: 390, height: 844 }, "phone"], [{ width: 1280, height: 860 }, "computer"]]) {
  const ctx = await browser.newContext({ viewport: vp });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full?home=focus&rw=1&rt=1&dl=1");
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(800);
  const labels = await page.$$eval(".ai-chat-focus__links button", (b) => b.map((x) => x.textContent.trim()));
  check(`Deals (${tag}): the pills end with Deals, the store's own Deals link stepping aside`, labels.join(" · ") === "My rewards · Returns & exchanges · Deals", labels.join(" · "));
  const sentBefore = chatBodies.length, readsBefore = dealsLog.length;
  await page.click("[data-deals-open]");
  await page.waitForSelector(".ai-dl .ai-dl__offer", { timeout: 4000 });
  await page.waitForSelector(".ai-chat-product-card", { timeout: 4000 });
  const got = await page.evaluate(() => {
    const card = document.querySelector(".ai-dl"), r = card.getBoundingClientRect(), bubble = card.closest(".ai-chat-msg-bubble");
    const offers = [...card.querySelectorAll(".ai-dl__offer")].map((o) => [o.querySelector("b")?.textContent, o.querySelector(".ai-dl__otxt > span")?.textContent || "", o.querySelector("em")?.textContent || "", o.querySelector("[data-dl-code]")?.getAttribute("data-dl-code") || ""]);
    const order = [...bubble.children].map((c) => c.className.split(" ")[0] || c.tagName);
    const over = [...card.querySelectorAll("*")].filter((e) => { const x = e.getBoundingClientRect(); return x.width && (x.right > r.right + 1 || x.left < r.left - 1); }).length;
    const colorful = [...card.querySelectorAll("*")].some((e) => { const cs = getComputedStyle(e); const sat = (c) => { const m = c.match(/\d+/g); if (!m || m.length < 3) return 0; const [a, b, d] = m.map(Number); return Math.max(a, b, d) - Math.min(a, b, d); }; return e.querySelectorAll("svg, img").length === 0 && (sat(cs.color) > 20 || sat(cs.backgroundColor) > 20); });
    return { user: document.querySelector(".ai-chat-msg--user .ai-chat-msg-bubble")?.textContent.trim(), head: card.querySelector(".ai-dl__head strong")?.textContent, sub: card.querySelector(".ai-dl__head span")?.textContent, offers, sale: !!card.querySelector(".ai-dl__sale"), seeAll: card.querySelector(".ai-dl__more a")?.getAttribute("href"), headRow: (() => { const t = card.querySelector(".ai-dl__head strong").getBoundingClientRect(), st = card.querySelector(".ai-dl__head span").getBoundingClientRect(); return Math.abs(t.bottom - st.bottom) <= 3 && st.right >= r.right - 20 && st.left > t.right; })(), cards: bubble.querySelectorAll(".ai-chat-product-card").length, struck: bubble.querySelectorAll(".ai-chat-product-card .compare-at").length, order, over, fits: r.right <= window.innerWidth, icons: card.querySelectorAll("svg, img").length, colorful };
  });
  check(`Deals (${tag}): one tap, no AI, one read — the offers with code and end, then six sale cards with their old prices and no "On sale now" line; the state at the head's right on the name's line; quiet and colourless; the card sits under the words, above the cards`, chatBodies.length === sentBefore && dealsLog.length === readsBefore + 1 && got.user === "Deals" && got.head === "Deals" && got.sub === "Running right now" && got.headRow && JSON.stringify(got.offers) === JSON.stringify([["20% off all boots", "Enter the code at checkout.", "Ends Nov 9", "FALL20"], ["Free shipping on orders over $75", "Lower 48 states.", "", ""]]) && !got.sale && got.seeAll === "https://www.example.com/collections/sale" && got.cards === 6 && got.struck >= 6 && got.order[0] === "P" && got.order[1] === "ai-dl" && got.over === 0 && got.fits && got.icons === 0 && !got.colorful, JSON.stringify(got));
  await page.click('[data-dl-code="FALL20"]');
  await page.waitForTimeout(300);
  const copied = await page.evaluate(async () => ({ label: document.querySelector('[data-dl-code="FALL20"] .ai-dl__copy')?.textContent, clip: await navigator.clipboard.readText().catch(() => "") }));
  check(`Deals (${tag}): the code copies on a tap`, copied.label === "Copied" && copied.clip === "FALL20", JSON.stringify(copied));
  await page.reload();
  await page.click(".ai-chat-launcher");
  await page.waitForFunction(() => document.querySelector(".ai-dl .ai-dl__offer") && document.querySelector(".ai-chat-product-card"), null, { timeout: 4000 }).catch(() => {});
  const back = await page.evaluate(() => ({ offers: document.querySelectorAll(".ai-dl .ai-dl__offer").length, cards: document.querySelectorAll(".ai-chat-product-card").length }));
  check(`Deals (${tag}): the card and the sale cards come back after a reload without another read`, back.offers === 2 && back.cards === 6 && dealsLog.length === readsBefore + 1, JSON.stringify({ back, reads: dealsLog.length - readsBefore }));
  check(`Deals (${tag}): no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// Settings → Showing the chat → Hide on pages: a page can show the chat
// minimized instead (mode "compact"): the bar is the bubble from the first
// paint, the chat opens from it as always, and closing leaves the bubble.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 760 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/compact-page");
  await page.waitForTimeout(900);
  const first = await page.evaluate(() => { const l = document.querySelector(".ai-chat-launcher"); const cs = getComputedStyle(l); return { bubble: l.classList.contains("is-bubble"), shown: cs.display !== "none" && cs.visibility !== "hidden", pill: l.querySelector(".ai-chat-launcher__pill")?.textContent, text: getComputedStyle(l.querySelector(".ai-chat-launcher__text")).display }; });
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(600);
  const opened = await page.evaluate(() => document.querySelector(".ai-chat-panel").classList.contains("open"));
  await page.click(".ai-chat-close-btn");
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({ bubble: document.querySelector(".ai-chat-launcher").classList.contains("is-bubble"), open: document.querySelector(".ai-chat-panel").classList.contains("open") }));
  await page.goto("http://localhost:4789/full");
  await page.waitForTimeout(900);
  const elsewhere = await page.evaluate(() => document.querySelector(".ai-chat-launcher").classList.contains("is-bubble"));
  check("hide on pages (compact): on that page the chat is minimized from the first paint — the bubble, not the bar — opens from it, and is the bubble again after closing; other pages keep the bar", first.bubble && first.shown && first.text === "none" && opened && after.bubble && !after.open && !elsewhere, JSON.stringify({ first, opened, after, elsewhere }));
  check("hide on pages (compact): no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// The chat guard ended the chat (the server answers 423 chat_ended): the
// shopper reads the server's words as a reply, the box is paused, and a
// reload or "Start a new chat" keeps it paused until the time the server
// gave; nothing is sent meanwhile. Once the time passes, it's open again.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(600);
  const sent = chatBodies.length;
  await page.fill(".ai-chat-input-area textarea", "err423");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /paused this chat/.test(document.querySelector(".ai-chat-msg--assistant:last-of-type .ai-chat-msg-bubble")?.textContent || ""), null, { timeout: 5000 });
  const state = () => page.evaluate(() => ({ disabled: document.querySelector(".ai-chat-input-area textarea").disabled, placeholder: document.querySelector(".ai-chat-input-area textarea").placeholder, send: document.querySelector(".ai-chat-send").disabled, paused: Number(localStorage.getItem("hajirai_chat_paused") || 0) > Date.now(), bubbles: document.querySelectorAll(".ai-chat-msg--assistant").length, retry: !!document.querySelector(".ai-chat-retry-btn, .ai-chat-dead-end") }));
  let st = await state();
  check("chat ended: the server's words show as a reply, no retry buttons, the box paused", st.disabled && st.send && st.paused && st.placeholder === "Chat paused for now" && !st.retry, JSON.stringify(st));
  await page.reload();
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(600);
  st = await state();
  check("chat ended: still paused after a reload, the reply kept", st.disabled && st.paused && st.bubbles >= 1, JSON.stringify(st));
  // "Start a new chat" (the menu) resets the box; a send is still refused here.
  await page.evaluate(() => { document.querySelector(".ai-chat-input-area textarea").disabled = false; });
  await page.focus(".ai-chat-input-area textarea");
  await page.keyboard.type("hello again");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  st = await state();
  check("chat ended: nothing is sent while paused, and the box pauses again", chatBodies.length === sent + 1 && st.disabled, JSON.stringify({ sent: chatBodies.length - sent, st }));
  // Time's up: the box opens again by itself.
  await page.evaluate(() => localStorage.setItem("hajirai_chat_paused", String(Date.now() + 700)));
  await page.reload();
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(1600);
  st = await state();
  check("chat ended: open again once the time passes", !st.disabled && !st.send && !st.paused, JSON.stringify(st));
  check("chat ended: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// The Orthotics sheet takes only the Popular buttons that are orthotic quizzes:
// a "Share feedback" Typeform among them stays out.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full?home=focus&qp=fb");
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(700);
  await page.click('[data-focus-sheet="orthotics"]');
  await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
  const rows = await page.$$eval(".ai-chat-focus-sheet .ai-chat-helper .ai-chat-helper__title", (t) => t.map((x) => x.textContent));
  check("Orthotics sheet: the orthotic quiz is there, a Popular \"Share feedback\" Typeform is not", rows.includes("Identify my orthotic") && !rows.includes("Share feedback"), JSON.stringify(rows));
  check("Orthotics sheet (feedback button): no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// FITFinder in the sheet, signed out: the card asks to save (sign in) or carry
// on as a guest; the in-store scan asks to sign in first. Signed in: the scan
// comes back and can be used. Phone and desktop.
{
  mockCtl.ffGuest = true;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher");
  await page.waitForSelector('.ai-chat-welcome__helpers [data-helper="fitfinder"]', { timeout: 5000 });
  await page.click('.ai-chat-welcome__helpers [data-helper="fitfinder"]');
  await page.waitForSelector('.ai-chat-fbsheet[data-kind="fitfinder"].is-open', { timeout: 3000 });
  await page.waitForTimeout(300);
  await page.click('.ai-chat-fbsheet [data-ffs="opt"][data-o="b"]');
  await page.click('.ai-chat-fbsheet [data-ffs="opt"][data-o="d"]');
  await page.waitForTimeout(150);
  const guest = await page.evaluate(() => { const r = document.querySelector(".ai-chat-fbsheet .ai-ffs__rec"); const vw = document.documentElement.clientWidth; return { key: r?.querySelector(".ai-ffs__rec-key")?.textContent, title: r?.querySelector(".ai-ffs__savetitle")?.textContent, ctas: [...(r?.querySelectorAll(".ai-ffs__btn") || [])].map((b) => b.textContent), note: r?.querySelector(".ai-ffs__note")?.textContent, fits: [...document.querySelectorAll(".ai-chat-fbsheet .ai-ffs__opt, .ai-chat-fbsheet .ai-ffs__btn, .ai-chat-fbsheet .ai-ffs__help")].every((b) => { const x = b.getBoundingClientRect(); return x.right <= vw + 1 && x.left >= -1; }), tileH: Math.min(...[...document.querySelectorAll(".ai-chat-fbsheet .ai-ffs__opt")].map((b) => b.getBoundingClientRect().height)) }; });
  const nSaves = fitSaves.length;
  await page.click('.ai-chat-fbsheet [data-ffs="save-guest"]');
  await page.waitForTimeout(150);
  const done = await page.evaluate(() => { const r = document.querySelector(".ai-chat-fbsheet .ai-ffs__rec"); return { label: r?.querySelector(".ai-ffs__rec-label")?.textContent, key: r?.querySelector(".ai-ffs__rec-key")?.textContent, note: r?.querySelector(".ai-ffs__note")?.textContent, ctas: [...(r?.querySelectorAll(".ai-ffs__btn") || [])].map((b) => b.textContent), stored: JSON.parse(sessionStorage.getItem("fitfinder_fit") || "{}").key, clear: !!document.querySelector(".ai-chat-fbsheet .ai-ffs__clearbtn"), qs: document.querySelectorAll(".ai-chat-fbsheet .ai-ffs__q").length }; });
  check("FITFinder (guest, phone): No + No → FIT B Cushioned Support asking 'Save this fit to your account for next time?' — Yes (sign in required) / Continue as guest, 'Either way…'; everything fits the phone, tiles tall enough to tap; Continue as guest keeps it on this device (no profile write) — Your FIT B, 'we'll use this fit while you shop today', Show orthotics / Done, Start over", guest.key === "FIT B" && guest.title === "Save this fit to your account for next time?" && guest.ctas.join("|") === "Yes (sign in required)|Continue as guest" && /Either way/.test(guest.note || "") && guest.fits && guest.tileH >= 44 && done.label === "Your FIT" && done.key === "FIT B" && /shop today/.test(done.note || "") && done.ctas.join("|") === "Show orthotics in my FIT B|Done" && done.stored === "B" && fitSaves.length === nSaves && done.clear && done.qs === 0, JSON.stringify({ guest, done }));
  // Start over: the questions again, nothing picked; the in-store scan, signed out, asks to sign in; Back to the questions returns.
  await page.click('.ai-chat-fbsheet [data-ffs="clear"]');
  const again = await page.evaluate(() => ({ qs: document.querySelectorAll(".ai-chat-fbsheet .ai-ffs__q").length, pressed: document.querySelectorAll('.ai-chat-fbsheet [aria-pressed="true"]').length, rec: !!document.querySelector(".ai-chat-fbsheet .ai-ffs__rec") }));
  await page.click('.ai-chat-fbsheet [data-ffs="scan"]');
  const scanOut = await page.evaluate(() => ({ title: document.querySelector(".ai-chat-fbsheet .ai-ffs__title")?.textContent, note: document.querySelector(".ai-chat-fbsheet .ai-ffs__scanbox .ai-ffs__note")?.textContent, btn: document.querySelector('.ai-chat-fbsheet [data-ffs="scan-login"]')?.textContent, back: document.querySelector('.ai-chat-fbsheet [data-ffs="quiz"]')?.textContent }));
  await page.click('.ai-chat-fbsheet [data-ffs="quiz"]');
  const backQ = await page.evaluate(() => document.querySelectorAll(".ai-chat-fbsheet .ai-ffs__q").length);
  check("FITFinder (guest): Start over clears the picks; Scanned in one of our stores? asks to sign in with the scan's email; Back to the questions returns", again.qs === 2 && again.pressed === 0 && !again.rec && scanOut.title === "Scanned in one of our stores?" && scanOut.note === "Sign in with the email from your scan." && scanOut.btn === "Sign in" && scanOut.back === "Back to the questions" && backQ === 2, JSON.stringify({ again, scanOut, backQ }));
  check("FITFinder (guest): no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
  mockCtl.ffGuest = false;
  // Signed in: the scan lookup finds the store's scan; Use my scanned fit saves it here and to the profile.
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page2 = await ctx2.newPage();
  const errors2 = [];
  page2.on("pageerror", (e) => errors2.push(e.message));
  await page2.goto("http://localhost:4789/full");
  await page2.click(".ai-chat-launcher");
  await page2.waitForSelector('.ai-chat-welcome__helpers [data-helper="fitfinder"]', { timeout: 5000 });
  await page2.click('.ai-chat-welcome__helpers [data-helper="fitfinder"]');
  await page2.waitForSelector('.ai-chat-fbsheet[data-kind="fitfinder"].is-open', { timeout: 3000 });
  await page2.click('.ai-chat-fbsheet [data-ffs="scan"]');
  await page2.waitForSelector('.ai-chat-fbsheet [data-ffs="scan-use"]', { timeout: 3000 });
  const found = await page2.evaluate(() => { const r = document.querySelector(".ai-chat-fbsheet .ai-ffs__scanbox .ai-ffs__rec"); return { label: r?.querySelector(".ai-ffs__rec-label")?.textContent, key: r?.querySelector(".ai-ffs__rec-key")?.textContent, name: r?.querySelector(".ai-ffs__rec-name")?.textContent, date: r?.querySelector(".ai-ffs__scandate")?.textContent, note: r?.querySelector(".ai-ffs__note")?.textContent, report: r?.querySelector('a[href="https://scan.example/report/1"]')?.textContent }; });
  const nS = fitSaves.length;
  await page2.click('.ai-chat-fbsheet [data-ffs="scan-use"]');
  await page2.waitForTimeout(250);
  const used = await page2.evaluate(() => ({ label: document.querySelector(".ai-chat-fbsheet .ai-ffs__rec-label")?.textContent, key: document.querySelector(".ai-chat-fbsheet .ai-ffs__rec-key")?.textContent, stored: JSON.parse(sessionStorage.getItem("fitfinder_fit") || "{}").key }));
  check("FITFinder (signed in): the in-store scan comes back — Your scanned fit · FIT C, its date, the report link — and Use my scanned fit saves it here and to the profile", found.label === "Your scanned fit" && found.key === "FIT C" && found.name === "Cushioned + Metatarsal Support" && /^Scanned September 12, 2026$/.test(found.date || "") && found.note === "From your foot scan at our store." && found.report === "View my scan report" && used.label === "Your FIT" && used.key === "FIT C" && used.stored === "C" && fitSaves.length === nS + 1 && fitSaves.at(-1)?.fitKey === "C", JSON.stringify({ found, used, save: fitSaves.at(-1) }));
  check("FITFinder (signed in): no JS errors", errors2.length === 0, errors2.join(" | "));
  await ctx2.close();
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
  await page.waitForSelector('.ai-chat-fbsheet[data-kind="fitfinder"].is-open', { timeout: 3000 });
  const retake = await page.evaluate(() => ({ pressed: document.querySelectorAll('.ai-chat-fbsheet [data-ffs="opt"][aria-pressed="true"]').length, qs: document.querySelectorAll(".ai-chat-fbsheet .ai-ffs__q").length, rec: !!document.querySelector(".ai-chat-fbsheet .ai-ffs__rec"), kept: JSON.parse(sessionStorage.getItem("fitfinder_fit") || "{}").key }));
  check("known: Retake opens FITFinder's questions again in the sheet, nothing picked, the saved FIT kept until a new one is — no message to the assistant", retake.pressed === 0 && retake.qs === 2 && !retake.rec && retake.kept === "B" && !/retake my orthotic FIT/.test(chatBodies.at(-1)?.message || ""), JSON.stringify(retake));
  await page.click(".ai-chat-fbsheet__back");
  await page.waitForTimeout(500);
  // The card itself, with a FIT saved: the sheet opens on it — Your FIT B — with the orthotics in it one tap away.
  await page.click(".ai-chat-helper--fitfinder");
  await page.waitForSelector('.ai-chat-fbsheet[data-kind="fitfinder"].is-open', { timeout: 3000 });
  const mine = await page.evaluate(() => ({ label: document.querySelector(".ai-chat-fbsheet .ai-ffs__rec-label")?.textContent, key: document.querySelector(".ai-chat-fbsheet .ai-ffs__rec-key")?.textContent, ctas: [...document.querySelectorAll(".ai-chat-fbsheet .ai-ffs__btn")].map((b) => b.textContent), qs: document.querySelectorAll(".ai-chat-fbsheet .ai-ffs__q").length }));
  check("known: the FIT card opens the sheet on the saved FIT — Your FIT B, Show orthotics in my FIT B / Done, no questions", mine.label === "Your FIT" && mine.key === "FIT B" && mine.ctas.join("|") === "Show orthotics in my FIT B|Done" && mine.qs === 0, JSON.stringify(mine));
  await page.click(".ai-chat-fbsheet__back");
  await page.waitForTimeout(500);

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
    await page.waitForSelector('.ai-chat-fbsheet[data-kind="fitfinder"].is-open', { timeout: 3000 });
    await page.click('.ai-chat-fbsheet [data-ffs="opt"][data-o="a"]');
    await page.click('.ai-chat-fbsheet [data-ffs="opt"][data-o="c"]');
    await page.waitForTimeout(150);
    await page.click('.ai-chat-fbsheet [data-ffs="close"]');
    await page.waitForTimeout(600);
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

// Home layout (Theme editor → Home layout). Classic — the default — is the
// welcome exactly as before; Focus is the opt-in foot-pain-first home with the
// face on the header's line, whose ring becomes the line once a chat starts.
{
  const open = async (url, opts = {}, texts = null) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...opts });
    if (texts) await ctx.addInitScript((t) => { try { localStorage.setItem("hajirai_texts", JSON.stringify(t)); } catch (e) { /* storage blocked: the test still runs */ } }, texts);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:4789" + url);
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(700);
    return { ctx, page, errors };
  };
  const lineY = () => { const h = document.querySelector(".ai-chat-header"); return h.getBoundingClientRect().top + parseFloat(getComputedStyle(h).getPropertyValue("--ai-focus-line")); };
  // Starts a chat from the home in one tap: the Deals link above the text box sends its question.
  const startChat = (page) => page.click('.ai-chat-focus__links [data-message="What deals are running right now?"]');
  const state = (page) => page.evaluate(() => { const p = document.querySelector(".ai-chat-panel"); return { focus: p.classList.contains("is-focus"), home: p.classList.contains("is-home"), chatting: p.classList.contains("is-chatting"), streaming: p.classList.contains("is-streaming"), hero: !!document.querySelector(".ai-chat-hero:not(.is-gone)"), heroGone: !!document.querySelector(".ai-chat-hero.is-gone"), line: !!document.querySelector(".ai-chat-band__ring"), focusHome: !!document.querySelector(".ai-chat-welcome--focus"), sheet: !!document.querySelector(".ai-chat-focus-sheet"), classic: !!document.querySelector(".ai-chat-welcome__cta-btn, .ai-chat-welcome__helpers, .ai-chat-welcome__greeting-cta"), msgs: document.querySelectorAll(".ai-chat-msg").length, input: document.querySelector(".ai-chat-input").value, focused: document.activeElement === document.querySelector(".ai-chat-input") }; });
  // Classic (the default): nothing of the Focus layout exists, the welcome is as always.
  {
    const { ctx, page, errors } = await open("/full");
    const st = await state(page);
    check("home layout classic (default): no face on the line, no line, no Focus home — the classic welcome exactly as before", !st.focus && !st.hero && !st.heroGone && !st.line && !st.focusHome && st.classic && st.home, JSON.stringify(st));
    check("home layout classic: no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // Focus
  {
    const { ctx, page, errors } = await open("/full?home=focus&qp=1");
    const st = await state(page);
    const parts = await page.evaluate(() => { const w = document.querySelector(".ai-chat-welcome--focus"); const order = [...w.children].map((c) => c.className.split(" ")[0]); return { heroImg: !!document.querySelector(".ai-chat-hero__photo img, .ai-chat-hero__photo .ai-chat-hero__mono"), glow: document.querySelectorAll(".ai-chat-band__lit .ai-chat-band__linel").length === 4 && document.querySelectorAll(".ai-chat-band__ring .ai-chat-band__ringl").length === 4 && [...document.querySelectorAll(".ai-chat-band use")].every((u) => { const cs = getComputedStyle(u), w = parseFloat(cs.strokeWidth), o = parseFloat(cs.opacity); return cs.filter === "none" && ((w <= 1.5 && o === 1) || (w > 1.5 && o <= 0.1)); }) && [...document.querySelectorAll(".ai-chat-band use")].filter((u) => parseFloat(getComputedStyle(u).opacity) === 1).length === 2, halos: (() => { const h = document.querySelector(".ai-chat-hero .ai-chat-hero__halo"); if (!h) return false; const cs = getComputedStyle(h); const blur = parseFloat((cs.filter.match(/blur\((\d+(?:\.\d+)?)px\)/) || [])[1] || "0"); const r = h.getBoundingClientRect(), p = document.querySelector(".ai-chat-hero__photo").getBoundingClientRect(); return blur >= 6 && parseFloat(cs.opacity) > 0.03 && parseFloat(cs.opacity) <= 0.12 && /radial-gradient/.test(cs.maskImage || cs.webkitMaskImage || "") && h.getAnimations().length === 1 && h.offsetWidth > p.width && h.offsetWidth <= p.width + 40 && Math.abs((r.left + r.right) / 2 - (p.left + p.right) / 2) <= 1; })(), greet: document.querySelector(".ai-chat-focus__greet .ai-chat-greet__item.is-in")?.textContent, greetSet: window.__AI_CHAT_CONFIG.greetingCta, subShown: (() => { const e = document.querySelector(".ai-chat-header__sub"); return !!e && !e.hidden && getComputedStyle(e).display !== "none"; })(), order, banner: !!w.querySelector(".ai-chat-welcome__banner"), label: !!w.querySelector(".ai-chat-focus__label"), rotating: !!w.querySelector(".ai-chat-focus__line"), chips: w.querySelectorAll(".ai-chat-focus__pain, .ai-chat-focus__pains, .ai-chat-focus__ask, .ai-chat-focus__else").length, cards: [...w.querySelectorAll("[data-focus-sheet]")].map((c) => (c.querySelector(".ai-chat-focus__card-title .is-short") || c.querySelector(".ai-chat-focus__card-title")).textContent), eyebrows: [...w.querySelectorAll("[data-focus-sheet] .ai-chat-focus__card-eyebrow")].map((c) => c.textContent), arrows: w.querySelectorAll(".ai-chat-focus__card > svg").length, cardH: Math.max(...[...w.querySelectorAll("[data-focus-sheet]")].map((c) => c.getBoundingClientRect().height)), pics: w.querySelectorAll(".ai-chat-focus__card-ico.has-pic").length, painPic: (w.querySelector('[data-focus-sheet="pain"] .ai-chat-focus__card-ico img')?.getAttribute("src") || "").replace(/^.*focus-pain-/, ""), painPicLoaded: (() => { const i = w.querySelector('[data-focus-sheet="pain"] .ai-chat-focus__card-ico img'); return !!i && i.complete && i.naturalWidth > 0; })(), links: w.querySelectorAll(".ai-chat-focus__links [data-message]").length }; });
    check("home layout focus: the face on the header's line — a solid hairline of colour with a thin faint fade behind it, and a blurred whisper turning slowly just outside (a masked box, never a smeared stroke; very faint), one row in the header, the greeting first on the home (under the name); three cards — Foot pain (Help me with, the heel picture), Footwear, Orthotics (Help me find) — with no arrows (no label, no banner where the theme has none), no chips row, two quiet links; none of the classic welcome", st.focus && st.home && !st.chatting && st.hero && st.line && st.focusHome && !st.classic && parts.heroImg && parts.glow && parts.halos && parts.greet === parts.greetSet && !parts.subShown && !parts.banner && !parts.label && !parts.rotating && parts.order.join(",") === "ai-chat-focus__greet,ai-chat-focus__cards,ai-chat-focus__links" && parts.chips === 0 && parts.cards.join("|") === "Foot pain|Footwear|Orthotics" && parts.eyebrows.join("|") === "Help me with|Help me find|Help me find" && parts.arrows === 0 && parts.cardH <= 330 /* level rows across the three cards (the longer Foot pain title) */ && parts.pics === 1 && parts.painPic === "heel.png" && parts.painPicLoaded && parts.links === 2, JSON.stringify({ st, parts }));
    // The cards: words on the left, the picture filling the whole right side edge to edge, a small call to action under the words; flat — no shadow, no border. In the default 500px panel Foot pain sits across the top with Footwear and Orthotics side by side under it, the same height.
    const cardGeo = () => page.evaluate(() => { const cs = (el) => getComputedStyle(el); const kinds = ["pain", "footwear", "orthotics"]; const q = (k) => document.querySelector(`[data-focus-sheet="${k}"]`); const r = (el) => el.getBoundingClientRect(); const one = (k) => { const c = q(k), cr = r(c), pic = r(c.querySelector(".ai-chat-focus__card-ico")), eb = r(c.querySelector(".ai-chat-focus__card-eyebrow")), ctaBox = r(c.querySelector(".ai-chat-focus__card-cta")), txt = { top: eb.top, left: Math.min(eb.left, ctaBox.left), right: Math.max(eb.right, ctaBox.right), bottom: ctaBox.bottom }, sub = c.querySelector(".ai-chat-focus__card-sub"), cta = c.querySelector(".ai-chat-focus__card-cta > span"); const titleEl = c.querySelector(".ai-chat-focus__card-title"); const title = [...titleEl.querySelectorAll("span")].find((e) => getComputedStyle(e).display !== "none")?.textContent || titleEl.textContent; return { x: Math.round(cr.left), y: Math.round(cr.top), w: Math.round(cr.width), h: Math.round(cr.height), title, eyebrowTop: Math.round(eb.top), titleTop: Math.round(r(titleEl).top), ctaBottom: Math.round(r(cta).bottom), picRight: Math.abs(pic.right - cr.right) < 1, picTall: Math.abs(pic.height - cr.height) < 1 && Math.abs(pic.top - cr.top) < 1, picWide: pic.width >= cr.width * 0.34 && pic.width <= cr.width * 0.46, picAfterText: pic.left >= txt.right - 1, picTop: Math.abs(pic.top - cr.top) < 1 && Math.abs(pic.left - cr.left) < 1 && Math.abs(pic.width - cr.width) < 1 && pic.height >= 72 && pic.height <= cr.height * 0.5, textBelowPic: txt.top >= pic.bottom - 1, sub: sub?.textContent, subWhole: sub.scrollWidth <= sub.clientWidth + 1 && sub.scrollHeight <= sub.clientHeight + 1, cta: cta?.textContent.trim(), ctaIn: cta && r(cta).bottom <= cr.bottom - 8 && r(cta).height >= 24, flat: cs(c).boxShadow === "none" && cs(c).borderStyle === "none", radius: parseFloat(cs(c).borderRadius) }; }; return Object.fromEntries(kinds.map((k) => [k, one(k)])); });
    const cards = await cardGeo();
    const every = (f) => ["pain", "footwear", "orthotics"].every((k) => f(cards[k]));
    const desktopRow = (g) => Math.abs(g.pain.y - g.footwear.y) < 1 && Math.abs(g.footwear.y - g.orthotics.y) < 1 && g.footwear.x + g.footwear.w <= g.pain.x && g.pain.x + g.pain.w <= g.orthotics.x && Math.abs(g.pain.w - 2 * g.footwear.w) <= 12 && Math.abs(g.footwear.w - g.orthotics.w) <= 1 && g.pain.h === g.footwear.h && g.footwear.h === g.orthotics.h && g.pain.h >= 140 && g.pain.picRight && g.pain.picTall && g.pain.picWide && g.pain.picAfterText && g.footwear.picTop && g.footwear.textBelowPic && g.orthotics.picTop && g.orthotics.textBelowPic && g.pain.title === "Let’s talk about your foot pain." && g.footwear.title === "Footwear" && g.orthotics.title === "Orthotics";
    check("home layout focus: on a computer the three cards sit in one row, 25 · 50 · 25 — Footwear and Orthotics with their picture on top and the words under it, Foot pain in the middle with its picture filling the right side and the longer title; every line fits, a small call to action on each (Start; Browse on both line cards, alike); flat (no shadow, no border)", desktopRow(cards) && every((c) => c.subWhole && c.ctaIn && c.flat && c.radius >= 16) && [cards.pain.cta, cards.footwear.cta, cards.orthotics.cta].join("|") === "Start|Browse|Browse" && [cards.pain.sub, cards.footwear.sub, cards.orthotics.sub].join(" | ") === "Say where it hurts and what you wear. A few taps, then Ava’s best match. | Sneakers, sandals, boots and more — support built in. | Inserts for the shoes you already own, matched to your arch.", JSON.stringify(cards));
    // A wide chat: the same row, the same proportions.
    await page.evaluate(() => { document.querySelector(".ai-chat-panel").style.width = "960px"; });
    await page.waitForTimeout(400);
    const wide = await cardGeo();
    check("home layout focus (wide panel): still one row at 25 · 50 · 25, every line whole, every call to action within its card", desktopRow(wide) && ["pain", "footwear", "orthotics"].every((k) => wide[k].subWhole && wide[k].ctaIn), JSON.stringify(wide));
    // Level lines: "Help me…", the titles and the buttons sit on the same lines across the three cards, and Foot pain's words sit low (under the picture row), not at the top.
    const level = (g) => ["eyebrowTop", "titleTop", "ctaBottom"].every((f) => Math.abs(g.pain[f] - g.footwear[f]) <= 1 && Math.abs(g.footwear[f] - g.orthotics[f]) <= 1) && g.pain.eyebrowTop >= g.pain.y + 80;
    check("home layout focus: Help me…, the titles and the buttons sit level across the three cards; Foot pain's words sit low beside the others', not at the top", level(cards) && level(wide), JSON.stringify({ cards: [cards.pain, cards.footwear, cards.orthotics].map((c) => [c.y, c.eyebrowTop, c.titleTop, c.ctaBottom]), wide: [wide.pain, wide.footwear, wide.orthotics].map((c) => [c.y, c.eyebrowTop, c.titleTop, c.ctaBottom]) }));
    await page.evaluate(() => { document.querySelector(".ai-chat-panel").style.width = ""; });
    await page.waitForTimeout(400);
    const tidy = await page.evaluate(() => { const cs = (el) => getComputedStyle(el); const links = [...document.querySelectorAll(".ai-chat-focus__links button")]; return { dots: document.querySelectorAll(".ai-chat-focus__links i").length, links: links.map((b) => ({ h: Math.round(b.getBoundingClientRect().height), border: cs(b).borderStyle, radius: cs(b).borderRadius, padX: parseFloat(cs(b).paddingLeft), bg: cs(b).backgroundColor })) }; });
    check("home layout focus: the links above the text box are compact outlined pills, no dots", tidy.dots === 0 && tidy.links.length === 2 && tidy.links.every((l) => l.h <= 34 && l.h >= 28 && l.border === "solid" && /999/.test(l.radius) && l.padX <= 14 && /rgba\(0, 0, 0, 0\)|transparent/.test(l.bg)), JSON.stringify(tidy));
    const geo = await page.evaluate((lineY) => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const h = r(".ai-chat-hero"), d = r(".ai-chat-header"), g = r(".ai-chat-focus__greet .ai-chat-greet"), c = r(".ai-chat-focus__cards"), n = r(".ai-chat-header__name"); return { heroMid: (h.top + h.bottom) / 2, line: eval(lineY)(), hdrBottom: d.bottom, heroBottom: h.bottom, heroRight: h.right, nameLeft: n.left, nameBottom: n.bottom, greetTop: g.top, greetLeft: g.left, cardsTop: c.top }; }, lineY.toString());
    check("home layout focus: the face is centred on the header's bottom line, the name above it, the greeting just below it and aligned under the name, the home clear of the face", Math.abs(geo.heroMid - geo.line) <= 2 && Math.abs(geo.line - geo.hdrBottom) <= 2 && geo.nameBottom <= geo.line && geo.greetTop >= geo.line && geo.greetTop <= geo.line + 12 && Math.abs(geo.greetLeft - geo.nameLeft) <= 1 && geo.cardsTop > geo.heroBottom + 4 && geo.nameLeft > geo.heroRight + 6, JSON.stringify(geo));
    // "Something else" (under the Foot pain sheet's first question) only puts the cursor in the text box.
    let n = chatBodies.length;
    await page.click('[data-focus-sheet="pain"]');
    await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    await page.waitForTimeout(400);
    await page.click("[data-pain-else]");
    await page.waitForTimeout(250);
    let s2 = await state(page);
    const hint = await page.evaluate(() => document.querySelector(".ai-chat-input").getAttribute("placeholder"));
    check("home layout focus: Something else (in the Foot pain sheet) closes it and only puts the cursor in the text box — its hint the store's own (Settings → Chat text), not a line of its own", s2.focused && s2.home && !s2.sheet && chatBodies.length === n && hint === "How can I help you today?", JSON.stringify({ ...s2, hint }));
    // A link above the text box sends its question straight away (no Send to tap).
    await page.click('.ai-chat-focus__links [data-message="What deals are running right now?"]');
    await waitUntil(() => chatBodies.length > n);
    check("home layout focus: a link above the text box sends its question straight away", chatBodies.at(-1)?.message === "What deals are running right now?" && chatBodies.at(-1)?.typed === false, JSON.stringify(chatBodies.at(-1)));
    await page.waitForTimeout(1500);
    await page.click(".ai-chat-menu-btn");
    await page.waitForTimeout(150);
    await page.click('.ai-chat-menu-item[data-action="clear"]');
    await page.waitForTimeout(1200);
    n = chatBodies.length;
    // The Footwear sheet.
    await page.click('[data-focus-sheet="footwear"]');
    await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    const fw = await page.evaluate(() => { const s = document.querySelector(".ai-chat-focus-sheet"); const pick = s.querySelector(".ai-chat-focus__pick"); const rows = [...pick.querySelectorAll(".ai-chat-focus__pick-row")]; const go = s.querySelector("[data-pick-go]"); const q = s.querySelector("[data-pick-q]"); const ask = s.querySelector(".ai-chat-focus__ask"); const askBox = ask.querySelector(".ai-chat-focus__ask-box").getBoundingClientRect(); const body = s.querySelector(".ai-chat-focus-sheet__body").getBoundingClientRect(); const cs = (el) => getComputedStyle(el); return { title: s.querySelector(".ai-chat-focus-sheet__title")?.textContent, eyebrow: s.querySelector(".ai-chat-focus-sheet__eyebrow")?.textContent, gender: [...s.querySelectorAll("[data-gender]")].map((b) => b.textContent + (b.classList.contains("is-on") ? "*" : "")), thumb: getComputedStyle(s.querySelector(".ai-chat-focus__gender")).getPropertyValue("--seg-i").trim(), tabs: s.querySelectorAll("[data-browse], [role=tablist]:not(.ai-chat-focus__gender)").length, pickLabel: pick.previousElementSibling?.textContent, keys: rows.map((r) => r.querySelector(".ai-chat-focus__pick-key b").textContent), hints: rows.map((r) => r.querySelector(".ai-chat-focus__pick-key small").textContent), hintSmaller: parseFloat(cs(rows[0].querySelector(".ai-chat-focus__pick-key small")).fontSize) < parseFloat(cs(rows[0].querySelector(".ai-chat-focus__pick-key b")).fontSize), keysAligned: Math.abs(rows[0].querySelector(".ai-chat-focus__pick-chips").getBoundingClientRect().left - rows[1].querySelector(".ai-chat-focus__pick-chips").getBoundingClientRect().left) < 1, a: [...rows[0].querySelectorAll("[data-pick-a]")].map((b) => b.textContent), b: [...rows[1].querySelectorAll("[data-pick-b]")].map((b) => b.textContent), dots: pick.querySelectorAll(".ai-chat-focus__pick-chip .ai-chat-focus__pick-dot").length === pick.querySelectorAll(".ai-chat-focus__pick-chip").length && [...pick.querySelectorAll(".ai-chat-focus__pick-dot svg")].every((i) => parseFloat(cs(i).opacity) === 0), arrows: s.querySelectorAll(".ai-chat-focus__chips button .ai-chat-focus__chip-go svg").length === s.querySelectorAll(".ai-chat-focus__chips button").length && pick.querySelectorAll(".ai-chat-focus__chip-go").length === 0, card: cs(pick).backgroundColor !== cs(s.querySelector(".ai-chat-focus-sheet__body")).backgroundColor && cs(pick).backgroundColor !== "rgba(0, 0, 0, 0)", squarer: parseFloat(cs(pick.querySelector(".ai-chat-focus__pick-chip")).borderRadius) < parseFloat(cs(s.querySelector(".ai-chat-focus__chips button")).borderRadius), pressed: pick.querySelectorAll('[aria-pressed="true"]').length, go: q.value, goHint: q.placeholder, qIsInput: q.tagName === "INPUT" && q.type === "text", askCta: go.textContent, askLast: ask === pick.lastElementChild && pick === s.querySelector(".ai-chat-focus__browse").lastElementChild && ask.contains(q) && ask.contains(go), askSticky: cs(ask).position === "sticky", askAtFoot: askBox.bottom <= body.bottom + 1 && askBox.bottom >= body.bottom - 21, askPill: parseFloat(cs(ask.querySelector(".ai-chat-focus__ask-box")).borderRadius) >= 20, goOff: go.disabled, goH: askBox.height, sections: [...s.querySelectorAll(".ai-chat-focus__browse > .ai-chat-focus__label")].map((l) => l.textContent), collections: [...s.querySelectorAll(".ai-chat-focus__chips [data-message]")].map((b) => b.textContent), chipH: Math.max(...[...pick.querySelectorAll(".ai-chat-focus__pick-chip")].map((b) => b.getBoundingClientRect().height)), fits: [...s.querySelectorAll(".ai-chat-focus__pick-chip, .ai-chat-focus__chips button, [data-pick-go]")].every((b) => { const r = b.getBoundingClientRect(); return r.right <= body.right + 1 && r.left >= body.left - 1; }), pickFirst: pick.compareDocumentPosition(s.querySelector(".ai-chat-focus__chips")) & Node.DOCUMENT_POSITION_PRECEDING, tf: !!s.querySelector('.ai-chat-helper[data-helper="truefit"] .ai-chat-helper__icon .ai-chat-tf-logo, .ai-chat-helper[data-helper="truefit"] .ai-chat-helper__icon svg'), modal: s.querySelector('[role="dialog"]')?.getAttribute("aria-modal"), closeFocused: document.activeElement === s.querySelector(".ai-chat-focus-sheet__close") }; });
    const bar = await page.evaluate(() => { const q = (s) => document.querySelector(s), r = (s) => q(s).getBoundingClientRect(); const top = r(".ai-chat-focus-sheet__top"), head = r(".ai-chat-focus-sheet__head"), titles = r(".ai-chat-focus-sheet__titles"), title = r(".ai-chat-focus-sheet__title"), close = r(".ai-chat-focus-sheet__close"), sw = r(".ai-chat-focus__gender"), grip = r(".ai-chat-focus-sheet__grip"), body = r(".ai-chat-focus-sheet__body"), panel = r(".ai-chat-focus-sheet__panel"); const cs = getComputedStyle(q(".ai-chat-focus-sheet__top")); return { pic: !!q(".ai-chat-focus-sheet__head img"), left: titles.left - head.left, titleLeft: Math.abs(title.left - titles.left), sameRow: Math.abs((sw.top + sw.bottom) / 2 - (title.top + title.bottom) / 2) <= 14 && Math.abs((close.top + close.bottom) / 2 - (sw.top + sw.bottom) / 2) <= 2, order: titles.right <= sw.left && sw.right < close.left, closeRight: head.right - close.right, gripAbove: grip.bottom <= head.top && grip.top >= top.top, band: cs.backgroundColor !== getComputedStyle(q(".ai-chat-focus-sheet__body")).backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)", bandTop: Math.abs(top.top - panel.top) <= 1, hairline: parseFloat(cs.borderBottomWidth), bodyBelow: body.top >= top.bottom, eyebrowCaps: getComputedStyle(q(".ai-chat-focus-sheet__eyebrow")).textTransform }; });
    check("home layout focus: the sheet's top is a window's title bar — a tinted band from the sheet's edge with the grip, the words at the left (no picture), the Women's / Men's switch and the round close button on the same row at the right, a hairline under it with the content below", !bar.pic && bar.left >= 16 && bar.left <= 24 && bar.titleLeft <= 1 && bar.sameRow && bar.order && bar.closeRight <= 16 && bar.gripAbove && bar.band && bar.bandTop && bar.hairline >= 1 && bar.bodyBelow && bar.eyebrowCaps === "uppercase", JSON.stringify(bar));
    check("home layout focus: the Footwear sheet — a Women's / Men's switch on Women's, the women's Collections first (one tap each), then Pick & go last as one tinted card: a Shoe row (choose one) and a For row (one or more) with their chips aligned, each chip a round check (empty), and the card's own last row the Ask box, held at the sheet's foot — a text box with its hint, its Ask button off; the Collections a section of round chips with an arrow each (one tap sends), no View all, no tabs; no True Fit row where the store has no True Fit", fw.title === "Footwear" && fw.eyebrow === "Help me find" && fw.gender.join("|") === "Women’s*|Men’s" && fw.thumb === "0" && fw.tabs === 0 && fw.pickLabel === "Pick & go" && fw.keys.join(",") === "Shoe,For" && fw.a.length === 10 && fw.a[0] === "Sneakers" && fw.a.includes("Wedges & heels") && fw.b.length === 8 && fw.b[0] === "Plantar fasciitis" && fw.b.at(-1) === "Wide width" && fw.hints.join(",") === "choose one,one or more" && fw.hintSmaller && fw.keysAligned && fw.dots && fw.arrows && fw.card && fw.squarer && fw.pressed === 0 && fw.goOff && fw.go === "" && fw.goHint === "Pick above, or type here" && fw.qIsInput && /^Ask\b/.test(fw.askCta) && fw.askLast && fw.askSticky && fw.askPill && fw.goH <= 48 && fw.sections.join(",") === "Collections,Pick & go" && fw.collections.length === 8 && fw.collections[0] === "New arrivals" && !fw.collections.includes("View all") && fw.chipH <= 32 && fw.fits && fw.pickFirst && !fw.tf && fw.modal === "true" && fw.closeFocused, JSON.stringify(fw));
    // Picking: one shoe, one condition, either or both; a second tap on a chip clears it; the Go button says exactly what it will ask.
    const pickState = () => page.evaluate(() => { const s = document.querySelector(".ai-chat-focus-sheet"); const go = s.querySelector("[data-pick-go]"); return { go: s.querySelector("[data-pick-q]").value, off: go.disabled, on: [...s.querySelectorAll('[aria-pressed="true"]')].map((b) => b.textContent).join("|"), checks: [...s.querySelectorAll('[aria-pressed="true"] .ai-chat-focus__pick-dot svg')].every((i) => parseFloat(getComputedStyle(i).opacity) === 1), focused: document.activeElement?.getAttribute("aria-pressed") }; });
    // The check fades in (150ms): read each state once it has.
    const checked = () => page.waitForFunction(() => [...document.querySelectorAll('.ai-chat-focus-sheet [aria-pressed="true"] .ai-chat-focus__pick-dot svg')].every((i) => getComputedStyle(i).opacity === "1"), null, { timeout: 2000 }).catch(() => {});
    await page.click('.ai-chat-focus-sheet [data-pick-a="0"]');
    await checked();
    const p1 = await pickState();
    await page.click('.ai-chat-focus-sheet [data-pick-b="0"]');
    await checked();
    const p2 = await pickState();
    await page.click('.ai-chat-focus-sheet [data-pick-a="5"]');
    await checked();
    const p3 = await pickState();
    await page.click('.ai-chat-focus-sheet [data-pick-a="5"]');
    await checked();
    const p4 = await pickState();
    const pressedLook = await page.evaluate(() => { const b = document.querySelector('.ai-chat-focus-sheet [aria-pressed="true"]'), o = document.querySelector('.ai-chat-focus-sheet [aria-pressed="false"]'); const cb = getComputedStyle(b), co = getComputedStyle(o); return { filled: cb.backgroundColor !== co.backgroundColor && cb.color !== co.color, round: cb.borderRadius }; });
    check("home layout focus: Pick & go — Sneakers → \"Show me women’s sneakers\"; + Plantar fasciitis → \"…sneakers for plantar fasciitis\"; Boots swaps the shoe; Boots again clears it → \"…shoes for plantar fasciitis\"; the picked chip is filled with its check shown, the keyboard stays on it", p1.go === "Show me women’s sneakers" && !p1.off && p1.on === "Sneakers" && p2.go === "Show me women’s sneakers for plantar fasciitis" && p2.on === "Sneakers|Plantar fasciitis" && p3.go === "Show me women’s boots for plantar fasciitis" && p3.on === "Boots|Plantar fasciitis" && p4.go === "Show me women’s shoes for plantar fasciitis" && !p4.off && p4.on === "Plantar fasciitis" && p4.focused === "false" && p1.checks && p2.checks && pressedLook.filled && parseFloat(pressedLook.round) >= 8, JSON.stringify({ p1, p2, p3, p4, pressedLook }));
    // The For row takes several: they read as a list, a "for" phrase and a plain one each in its place.
    await page.click('.ai-chat-focus-sheet [data-pick-b="2"]');
    await checked();
    const p5 = await pickState();
    await page.click('.ai-chat-focus-sheet [data-pick-b="7"]');
    await checked();
    const p6 = await pickState();
    check("home layout focus: Pick & go — the For row takes several: + Flat feet → \"…shoes for plantar fasciitis and flat feet\"; + Wide width → \"…for plantar fasciitis and flat feet in wide widths\", each chip checked", p5.go === "Show me women’s shoes for plantar fasciitis and flat feet" && p5.on === "Plantar fasciitis|Flat feet" && p6.go === "Show me women’s shoes for plantar fasciitis and flat feet in wide widths" && p6.on === "Plantar fasciitis|Flat feet|Wide width" && p5.checks && p6.checks, JSON.stringify({ p5, p6 }));
    // Every change nudges the Ask button (the class goes on with the tap; its animation ends it).
    const nudge = await page.evaluate(() => { const s = document.querySelector(".ai-chat-focus-sheet"); const bar = s.querySelector(".ai-chat-focus__ask"); bar.classList.remove("is-nudge"); s.querySelector('[data-pick-b="1"]').click(); const on = bar.classList.contains("is-nudge"), anim = getComputedStyle(bar.querySelector(".ai-chat-focus__ask-cta")).animationName; s.querySelector('[data-pick-b="1"]').click(); return { on, anim, q: s.querySelector("[data-pick-q]").value }; });
    check("home layout focus: Pick & go — a pick nudges the Ask button (a short scale animation), and a second tap on the chip takes it out of the sentence again", nudge.on && nudge.anim !== "none" && nudge.q === "Show me women’s shoes for plantar fasciitis and flat feet in wide widths", JSON.stringify(nudge));
    // Their own words: typing in the box lets every pick go and keeps the button ready; an empty box turns it off; a chip writes the box again.
    await page.fill('.ai-chat-focus-sheet [data-pick-q]', "Show me red sneakers");
    const typed = await pickState();
    await page.fill('.ai-chat-focus-sheet [data-pick-q]', "");
    const emptied = await pickState();
    await page.click('.ai-chat-focus-sheet [data-pick-a="0"]');
    await checked();
    const back = await pickState();
    check("home layout focus: Pick & go — typing in the Ask box (\"Show me red sneakers\") lets every pick go and keeps the button ready; an empty box turns it off; a chip writes the box again", typed.go === "Show me red sneakers" && !typed.off && typed.on === "" && emptied.go === "" && emptied.off && back.go === "Show me women’s sneakers" && !back.off && back.on === "Sneakers", JSON.stringify({ typed, emptied, back }));
    // The switch: Men's slides the thumb, fades the browse box out and in, and brings the men's picks — cleared — with Occasion and Collections as sections.
    await page.click('.ai-chat-focus-sheet [data-gender="men"]');
    const mid = await page.evaluate(() => ({ swapping: document.querySelector(".ai-chat-focus-sheet .ai-chat-focus__browse").classList.contains("is-swapping"), thumb: getComputedStyle(document.querySelector(".ai-chat-focus__gender")).getPropertyValue("--seg-i").trim(), transition: getComputedStyle(document.querySelector(".ai-chat-focus__gender .ai-chat-focus__seg-thumb")).transitionProperty }));
    await page.waitForTimeout(500);
    const men = await page.evaluate(() => { const s = document.querySelector(".ai-chat-focus-sheet"); const rows = [...s.querySelectorAll(".ai-chat-focus__pick-row")]; const go = s.querySelector("[data-pick-go]"); return { on: [...s.querySelectorAll("[data-gender].is-on")].map((b) => b.textContent), a: [...rows[0].querySelectorAll("[data-pick-a]")].map((b) => b.textContent), b: [...rows[1].querySelectorAll("[data-pick-b]")].map((b) => b.textContent), pressed: s.querySelectorAll('[aria-pressed="true"]').length, goOff: go.disabled, sections: [...s.querySelectorAll(".ai-chat-focus__browse > .ai-chat-focus__label")].map((l) => l.textContent), chips: [...s.querySelectorAll(".ai-chat-focus__chips")].map((c) => [...c.querySelectorAll("[data-message]")].map((b) => b.textContent).join("|")), swapping: s.querySelector(".ai-chat-focus__browse").classList.contains("is-swapping"), opacity: getComputedStyle(s.querySelector(".ai-chat-focus__browse")).opacity }; });
    check("home layout focus: Men's — the thumb slides over, the browse box fades out then back in with the men's picks (Sneakers · Sandals · Clogs; five conditions), the picks cleared, Collections as a section (no Occasion for men)", mid.swapping && mid.thumb === "1" && /transform/.test(mid.transition) && men.on.join("") === "Men’s" && men.a.join("|") === "Sneakers|Sandals|Clogs" && men.b.length === 5 && men.b[0] === "Plantar fasciitis" && men.pressed === 0 && men.goOff && men.sections.join(",") === "Collections,Pick & go" && men.chips[0] === "New arrivals|Last chance" && !men.swapping && men.opacity === "1", JSON.stringify({ mid, men }));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(450);
    s2 = await state(page);
    check("home layout focus: Escape closes the sheet, still at home", !s2.sheet && s2.home && !s2.chatting, JSON.stringify(s2));
    // A click on the dimmed chat outside the sheet closes it; so does a click on the page itself.
    await page.click('[data-focus-sheet="footwear"]');
    await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    await page.waitForTimeout(400);
    const dim = await page.evaluate(() => { const b = document.querySelector(".ai-chat-focus-sheet__back").getBoundingClientRect(), p = document.querySelector(".ai-chat-focus-sheet__panel").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + Math.max(8, (p.top - b.top) / 2) }; });
    await page.mouse.click(dim.x, dim.y);
    await page.waitForTimeout(400);
    s2 = await state(page);
    check("home layout focus: a click on the dimmed chat outside the sheet closes it, still at home", !s2.sheet && s2.home, JSON.stringify(s2));
    await page.click('[data-focus-sheet="footwear"]');
    await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    await page.waitForTimeout(400);
    const outside = await page.evaluate(() => { const r = document.querySelector(".ai-chat-panel").getBoundingClientRect(); return { x: Math.max(4, r.left - 40), y: 12 }; });
    await page.mouse.click(outside.x, outside.y);
    await page.waitForTimeout(400);
    s2 = await state(page);
    const stillOpen = await page.evaluate(() => { const p = document.querySelector(".ai-chat-panel"); const r = p.getBoundingClientRect(); return r.width > 0 && getComputedStyle(p).visibility !== "hidden" && getComputedStyle(p).display !== "none"; });
    check("home layout focus: a click on the page outside the chat closes the sheet and leaves the chat open at home", !s2.sheet && s2.home && stillOpen, JSON.stringify({ s2, stillOpen, outside }));
    // The Orthotics sheet: FITFinder and the store's visual quiz (a Typeform quick pick).
    await page.click('[data-focus-sheet="orthotics"]');
    await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    const kept = await page.evaluate(() => { const s = document.querySelector(".ai-chat-focus-sheet"); return { on: [...s.querySelectorAll("[data-gender].is-on")].map((b) => b.textContent).join(""), keys: [...s.querySelectorAll(".ai-chat-focus__pick-key b")].map((k) => k.textContent), hint: s.querySelector("[data-pick-q]")?.placeholder, empty: s.querySelector("[data-pick-q]")?.value === "", first: s.querySelector(".ai-chat-focus__chips [data-message]")?.getAttribute("data-message") }; });
    check("home layout focus: the Orthotics sheet remembers Men's from the Footwear sheet — Activity · For to pick, its collections men's", kept.on === "Men’s" && kept.keys.join(",") === "Activity,For" && kept.hint === "Pick above, or type here" && kept.empty && /men’s Premium Memory Foam/.test(kept.first), JSON.stringify(kept));
    await page.click('.ai-chat-focus-sheet [data-gender="women"]');
    await page.waitForTimeout(500);
    const or = await page.evaluate(() => { const s = document.querySelector(".ai-chat-focus-sheet"); const rows = [...s.querySelectorAll(".ai-chat-focus__pick-row")]; return { title: s.querySelector(".ai-chat-focus-sheet__title")?.textContent, fit: s.querySelector('.ai-chat-helper[data-helper="fitfinder"] .ai-chat-helper__title')?.textContent, fitMono: s.querySelector('.ai-chat-helper[data-helper="fitfinder"] .ai-chat-helper__mono')?.textContent, quiz: s.querySelector(".ai-chat-helper[data-form]")?.getAttribute("data-form"), quizLabel: s.querySelector("[data-form]")?.getAttribute("data-form-label"), tabs: s.querySelectorAll("[data-browse]").length, a: [...rows[0].querySelectorAll("[data-pick-a]")].map((b) => b.textContent), b: [...rows[1].querySelectorAll("[data-pick-b]")].map((b) => b.textContent), sections: [...s.querySelectorAll(".ai-chat-focus__browse > .ai-chat-focus__label")].map((l) => l.textContent), col: [...s.querySelectorAll(".ai-chat-focus__chips [data-message]")].map((b) => b.textContent) }; });
    check("home layout focus: the Orthotics sheet — the chat's own Find my orthotic FIT row, the store's visual quiz, Pick & go with the activity (Casual everyday · All-day standing · Walking · Running…) and the condition, the store's orthotic collections as a section (no View all, no tabs)", or.title === "Orthotics" && or.fit === "Find my orthotic FIT" && or.fitMono === "FIT" && or.quiz === "ojyWbTvZ" && or.quizLabel === "Identify my orthotic" && or.tabs === 0 && or.a.length === 9 && or.a[0] === "Casual everyday" && or.a[3] === "Running" && or.b.length === 8 && or.b[0] === "Plantar fasciitis" && or.sections.join(",") === "Collections,Pick & go" && or.col.length === 10 && or.col[0] === "Premium Memory Foam" && or.col.includes("Speed") && or.col.includes("Work") && !or.col.includes("View all"), JSON.stringify(or));
    // Running + Plantar fasciitis, Go: one sentence sends; the face's ring becomes the header's line.
    await page.click('.ai-chat-focus-sheet [data-pick-a="3"]');
    await page.click('.ai-chat-focus-sheet [data-pick-b="0"]');
    await page.click('.ai-chat-focus-sheet [data-pick-b="2"]');
    const goTxt = await page.evaluate(() => document.querySelector(".ai-chat-focus-sheet [data-pick-q]").value);
    check("home layout focus: Orthotics Pick & go — Running + Plantar fasciitis + Flat feet reads as one sentence", goTxt === "Show me women’s orthotics for running with plantar fasciitis and flat feet", goTxt);
    n = chatBodies.length;
    await page.focus('.ai-chat-focus-sheet [data-pick-q]');
    await page.keyboard.press("Enter");
    await waitUntil(() => chatBodies.length > n);
    check("home layout focus: Enter in the Ask box sends the sentence as the message", chatBodies.at(-1)?.message === "Show me women’s orthotics for running with plantar fasciitis and flat feet", JSON.stringify(chatBodies.at(-1)?.message));
    await page.waitForTimeout(1900);/* the morph (≈1.1s) and the fades after it */
    s2 = await state(page);
    const look = await page.evaluate(() => ({ lineOpacity: parseFloat(getComputedStyle(document.querySelector(".ai-chat-band__lit")).opacity), border: getComputedStyle(document.querySelector(".ai-chat-header")).borderBottomColor, avatar: getComputedStyle(document.querySelector(".ai-chat-msg--assistant .ai-chat-msg-avatar") || document.body).boxShadow }));
    check("home layout focus: Go sends the sentence and the ring becomes the header's line (the gray line gone, the face gone)", chatBodies.at(-1)?.message === "Show me women’s orthotics for running with plantar fasciitis and flat feet" && chatBodies.at(-1)?.typed === false && !s2.sheet && !s2.home && s2.chatting && s2.heroGone && !s2.hero && !s2.focusHome && look.lineOpacity >= 0.7 && /rgba\(\d+, \d+, \d+, 0\)|transparent/.test(look.border), JSON.stringify({ s2, look }));
    check("home layout focus: reply avatars carry no glow — the line has it", look.avatar && !/163, 92, 255/.test(look.avatar), look.avatar);
    await waitUntil(() => false, 1500);
    s2 = await state(page);
    check("home layout focus: the line settles once the reply is in", s2.chatting && !s2.streaming, JSON.stringify(s2));
    // New chat: the line goes back around the face.
    await page.click(".ai-chat-menu-btn");
    await page.waitForTimeout(150);
    await page.click('.ai-chat-menu-item[data-action="clear"]');
    await page.waitForTimeout(1200);
    s2 = await state(page);
    const again = await page.evaluate(() => document.querySelectorAll("[data-focus-sheet]").length);
    check("home layout focus: New chat brings the face and the home back", s2.home && !s2.chatting && s2.hero && !s2.heroGone && s2.focusHome && again === 3, JSON.stringify(s2));
    // The Foot pain bar on a phone is a footer: in view while the tiles scroll under it, a hairline and a fade over them while more are below, nothing at the end; Continue outlined until a pick, solid after.
    {
      const ph = await open("/full?home=focus", { viewport: { width: 390, height: 760 } });
      await ph.page.click('[data-focus-sheet="pain"]');
      await ph.page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
      await ph.page.waitForTimeout(500);
      const foot = () => ph.page.evaluate(() => { const sh = document.querySelector(".ai-chat-focus-sheet"); const body = sh.querySelector(".ai-chat-focus-sheet__body"); const bar = sh.querySelector(".ai-chat-focus__bar"); const next = sh.querySelector('[data-pain-nav="next"]'); const cs = getComputedStyle(bar), fade = getComputedStyle(bar, "::before"), ncs = getComputedStyle(next); const b = bar.getBoundingClientRect(), r = body.getBoundingClientRect(); return { scrolls: body.scrollHeight > body.clientHeight + 4, more: bar.classList.contains("is-more"), sticky: cs.position === "sticky", inView: b.top >= r.top && b.bottom <= r.bottom + 1, line: cs.borderTopColor !== "rgba(0, 0, 0, 0)", fade: parseFloat(fade.opacity) === 1 && /gradient/.test(fade.backgroundImage), nextOff: next.disabled, nextBg: ncs.backgroundColor, nextOpacity: parseFloat(ncs.opacity), nextOutline: ncs.boxShadow !== "none" }; });
      const f1 = await foot();
      check("foot pain sheet (phone): the bar is a footer — held in view while the tiles scroll under it, with a hairline and a fade over them while more are below; Continue waits as an outlined pill, not a greyed one", f1.scrolls && f1.more && f1.sticky && f1.inView && f1.line && f1.fade && f1.nextOff && f1.nextBg === "rgba(0, 0, 0, 0)" && f1.nextOpacity === 1 && f1.nextOutline, JSON.stringify(f1));
      await ph.page.evaluate(() => { const b = document.querySelector(".ai-chat-focus-sheet__body"); b.scrollTop = b.scrollHeight; });
      // The hairline and fade ease out (0.2s); give them their time.
      await ph.page.waitForFunction(() => { const bar = document.querySelector(".ai-chat-focus__bar"); return !bar.classList.contains("is-more") && getComputedStyle(bar).borderTopColor === "rgba(0, 0, 0, 0)"; }, null, { timeout: 2000 }).catch(() => {});
      const f2 = await foot();
      // The last tile is the one in view down here (a click on the first would scroll back up).
      await ph.page.click('[data-pain-opt="none"]');
      await ph.page.waitForTimeout(300);
      const f3 = await foot();
      check("foot pain sheet (phone): at the end of the tiles the hairline and fade go; a pick turns Continue solid", !f2.more && !f2.line && !f2.fade && f2.inView && !f3.more && !f3.nextOff && f3.nextBg !== "rgba(0, 0, 0, 0)", JSON.stringify({ f2, f3 }));
      check("foot pain sheet (phone): no JS errors", ph.errors.length === 0, ph.errors.join(" | "));
      await ph.ctx.close();
    }
    // Peak Mode's home (Settings → Peak Mode → The home on peak days): the
    // day's pictures where the banner was — each just a picture, a link or a
    // question to Ava — shown to its audience; the peak picture on the face;
    // her colours for the days on the glow, the ring and the line; the three
    // layouts (rail, mosaic, grid) at computer and phone widths.
    {
      const readPeak = (page) => page.evaluate(() => {
        const w = document.querySelector(".ai-chat-welcome"); const box = w.querySelector(".ai-chat-peak__tiles"); const tiles = box ? [...box.querySelectorAll(".ai-chat-peak__tile")] : []; const wr = w.getBoundingClientRect();
        const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
        const panel = document.querySelector(".ai-chat-panel"); const halo = document.querySelector(".ai-chat-hero__halo"); const stop = document.querySelector("#ai-chat-band-g stop");
        return {
          banner: !!w.querySelector(".ai-chat-welcome__banner"), layout: (w.querySelector(".ai-chat-peak")?.className.match(/ai-chat-peak--(\w+)/) || [])[1] || "",
          labels: tiles.map((t) => t.getAttribute("aria-label")), tags: tiles.map((t) => t.tagName), hrefs: tiles.map((t) => t.getAttribute("href") || t.getAttribute("data-message") || ""), targets: tiles.map((t) => `${t.getAttribute("target") || ""}|${t.getAttribute("rel") || ""}`),
          words: (w.querySelector(".ai-chat-peak")?.textContent || "").trim(), pics: tiles.filter((t) => t.querySelector("img[src]")).length, clean: !w.querySelector(".ai-chat-peak svg, .ai-chat-peak h3, .ai-chat-peak p, .ai-chat-peak button:not(.ai-chat-peak__tile)"),
          hero: document.querySelector(".ai-chat-hero__photo img")?.getAttribute("src") || "",
          rects: tiles.map(r), box: box ? r(box) : null, inside: box ? box.getBoundingClientRect().right <= wr.right + 1 && box.getBoundingClientRect().left >= wr.left - 1 : false, scrolls: box ? box.scrollWidth > box.clientWidth + 1 : false,
          glow: panel ? panel.style.getPropertyValue("--ai-glow-1") : "", halo: halo ? getComputedStyle(halo).backgroundImage : "", stop: stop ? stop.getAttribute("stop-color") : "",
        };
      });
      const oneRow = (p) => new Set(p.rects.map((x) => x.y)).size <= 1;
      const out = await open("/full?home=focus&pk=1&banner=1");
      const guest = await readPeak(out.page);
      check("peak home (computer, signed out): the pictures take the banner's place — everyone's and the signed-out one, side by side, no banner, not a word or button on them; the link tile is a link that opens in a new tab, the store's own path in this one; each named for screen readers; the face wears the peak picture", !guest.banner && guest.layout === "rail" && guest.labels.join("|") === "Black Friday: 30% off everything|Join free and save 15%" && guest.words === "" && guest.pics === 2 && guest.clean && oneRow(guest) && !guest.scrolls && guest.inside && guest.tags.join() === "A,A" && guest.hrefs[0] === "https://www.example.com/collections/sale" && guest.targets[0] === "_blank|noopener" && guest.hrefs[1] === "/account/register" && guest.targets[1] === "|" && /pic-orthotics/.test(guest.hero), JSON.stringify(guest));
      check("peak home: her colours for the days — the festive red on the glow around her face, on the ring and the line", guest.glow === "#d42b3a" && /rgb\(212, 43, 58\)/.test(guest.halo) && guest.stop === "#d42b3a", JSON.stringify({ glow: guest.glow, stop: guest.stop, halo: guest.halo.slice(0, 90) }));
      const look = await out.page.evaluate(() => { const p = document.querySelector(".ai-chat-panel"); const hdr = document.querySelector(".ai-chat-header"); const hr = hdr.getBoundingClientRect(); const h = getComputedStyle(hdr); const box = hdr.querySelector(".ai-chat-deco--lights"); const br = box ? box.getBoundingClientRect() : null; const words = document.createRange(); words.selectNodeContents(hdr.querySelector(".ai-chat-header__title--home")); const wr = words.getBoundingClientRect(); const greet = document.querySelector(".ai-chat-focus__greet .ai-chat-greet__item.is-in"); const rg = document.createRange(); rg.selectNodeContents(greet); const gr = rg.getBoundingClientRect(); const act = hdr.querySelector(".ai-chat-header__actions").getBoundingClientRect(); const dots = box ? [...box.querySelectorAll(".d-light__dot")].map((c) => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, fill: getComputedStyle(c).fill }; }) : []; const ctl = hdr.querySelector("button"); const cr = ctl.getBoundingClientRect(); const hit = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2); const tile = document.querySelector(".ai-chat-peak__tile"); const tr = tile ? tile.getBoundingClientRect() : null; return { k: p.style.getPropertyValue("--ai-ring-k"), stroke: getComputedStyle(document.querySelector(".ai-chat-band__ringl--1")).strokeWidth, decor: p.getAttribute("data-peak-decor"), n: dots.length, pastWords: br ? br.left >= Math.max(wr.right, gr.right) + 8 : false, right: br ? Math.abs(br.right - hr.right) <= 2 : false, inHeader: br ? br.top >= hr.top && br.bottom <= hr.bottom + 27 : false, underControls: dots.every((d) => d.y >= act.bottom + 4), aboveTiles: !tr || dots.every((d) => d.y < tr.top - 4), inBox: br ? dots.every((d) => d.x >= br.left && d.x <= br.right && d.y >= br.top && d.y <= br.bottom) : false, gold: dots.length ? dots[0].fill : "", pe: box ? getComputedStyle(box).pointerEvents : "", under: hit === ctl || ctl.contains(hit), grey: h.borderBottomColor, tint: p.getAttribute("data-peak-tint"), hbg: h.backgroundImage }; });
      check("peak home: her look — a bold ring (the hairline near three times its usual weight); a few points of the set's gold at the right of the header: past the words, in the band under the controls, inside the header, above the tiles, never in the way of a tap; no grey line; and the tint behind the header", look.k === "2.8" && parseFloat(look.stroke) > 3.2 && parseFloat(look.stroke) < 3.5 && look.decor === "lights" && look.n === 8 && look.pastWords && look.right && look.inHeader && look.underControls && look.aboveTiles && look.inBox && look.gold === "rgb(233, 185, 73)" && look.pe === "none" && look.under && /rgba\(.*, 0\)|transparent/.test(look.grey) && look.tint === "1" && look.hbg !== "none" && /212, 43, 58|0\.83\d* 0\.16\d* 0\.22\d*/.test(look.hbg), JSON.stringify(look));
      const anchors = await out.page.evaluate(() => [...document.querySelectorAll(".ai-chat-peak__tile img")].map((i) => getComputedStyle(i).objectPosition));
      check("peak home: a picture anchored right keeps its right edge in the crop; the others stay centred", anchors[0] === "100% 50%" && anchors[1] === "50% 50%", JSON.stringify(anchors));
      check("peak home: no JS errors", out.errors.length === 0, out.errors.join(" | "));
      await out.ctx.close();
      const inn = await open("/full?home=focus&pk=1&login=Ann");
      const signed = await readPeak(inn.page);
      const n0 = chatBodies.length;
      await inn.page.click('.ai-chat-peak__tile[data-message]');
      await inn.page.waitForTimeout(900);
      const asked = await inn.page.evaluate(() => ({ home: document.querySelector(".ai-chat-panel").classList.contains("is-home"), user: document.querySelector(".ai-chat-msg--user .ai-chat-msg-bubble")?.textContent.trim() }));
      check("peak home (signed in): everyone's and the members' picture, not the signed-out one nor the tag's; a tap on the question tile sends its question to Ava as the shopper's own message", signed.labels.join("|") === "Black Friday: 30% off everything|An extra 10% for members" && signed.tags[1] === "BUTTON" && signed.hrefs[1] === "What is my member offer today?" && chatBodies.length === n0 + 1 && !asked.home && asked.user === "What is my member offer today?", JSON.stringify({ signed: signed.labels, asked, sent: chatBodies.length - n0 }));
      await inn.ctx.close();
      // Settings → Peak Mode → Words on the picture: the lines that are filled in, where they sit, aligned as set, white or black with a soft shade behind; a picture without words stays as it is; the title on the picture names the tile when no screen-reader words were written.
      {
        const readWords = (page) => page.evaluate(() => {
          const tiles = [...document.querySelectorAll(".ai-chat-peak__tile")];
          return tiles.map((t) => {
            const w = t.querySelector(".ai-chat-peak__words"); if (!w) return { label: t.getAttribute("aria-label"), words: null };
            const tr = t.getBoundingClientRect(); const wr = w.getBoundingClientRect(); const cs = getComputedStyle(w);
            const part = (c) => { const el = w.querySelector(c); if (!el) return null; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { text: el.textContent, l: Math.round(r.left - tr.left), r: Math.round(tr.right - r.right), t: Math.round(r.top - tr.top), b: Math.round(tr.bottom - r.bottom), color: s.color, bg: s.backgroundColor, radius: s.borderRadius }; };
            return { label: t.getAttribute("aria-label"), words: { covers: Math.abs(wr.width - tr.width) <= 1 && Math.abs(wr.height - tr.height) <= 1, hidden: w.getAttribute("aria-hidden"), align: cs.textAlign, color: cs.color, at: w.getAttribute("data-at"), shade: `${getComputedStyle(w, "::before").backgroundImage}|${getComputedStyle(w, "::before").backgroundColor}`, eyebrow: part(".ai-chat-peak__eyebrow"), heading: part(".ai-chat-peak__heading"), text: part(".ai-chat-peak__text"), cta: part(".ai-chat-peak__cta"), nested: t.querySelectorAll("button, a").length } };
          });
        });
        const wg = await open("/full?home=focus&pk=1&pkw=1");
        const w1 = await readWords(wg.page);
        const a = w1[0]?.words, h = a?.heading, c = a?.cta;
        check("peak words (bottom left, white): the small line, the title and the button on the first picture, nothing for the empty line of text — low at the left, left-aligned, white words on a soft shade, the button a white pill; the whole tile still the one tap", !!a && a.covers && a.hidden === "true" && a.at === "bottom-left" && a.align === "left" && a.color === "rgb(255, 255, 255)" && /gradient/.test(a.shade) && a.eyebrow?.text === "Meet Ava" && h?.text === "Find the perfect gift" && !a.text && c?.text === "Shop gift ideas" && h.l <= 24 && h.l >= 10 && c.b <= 24 && c.b >= 8 && c.bg === "rgb(255, 255, 255)" && c.color !== "rgb(255, 255, 255)" && parseFloat(c.radius) >= 12 && a.nested === 0, JSON.stringify(w1[0]));
        check("peak words: a picture without words stays as it is, and the tiles keep their screen-reader names", w1[1]?.words === null && w1[0]?.label === "Black Friday: 30% off everything" && w1[1]?.label === "Join free and save 15%", JSON.stringify(w1.map((x) => [x.label, !!x.words])));
        check("peak words: no JS errors", wg.errors.length === 0, wg.errors.join(" | "));
        await wg.ctx.close();
        const wi = await open("/full?home=focus&pk=1&pkw=1&login=Ann");
        const w2 = await readWords(wi.page);
        const m = w2[1]?.words, mh = m?.heading;
        check("peak words (centre, black): the title and the line of text on the members' picture, centred both ways, black words on a light shade, no small line and no button", !!m && m.at === "center" && m.align === "center" && m.color === "rgb(17, 17, 17)" && /rgba\(255, 255, 255, 0\.\d+\)/.test(m.shade) && mh?.text === "An extra 10% for members" && m.text?.text === "Just for signing in." && !m.eyebrow && !m.cta && Math.abs(mh.l - mh.r) <= 3 && Math.abs(mh.t - mh.b) <= 30, JSON.stringify(w2[1]));
        await wi.ctx.close();
        const wp = await open("/full?home=focus&pk=1&pkw=1", { viewport: { width: 390, height: 760 } });
        const w3 = await readWords(wp.page);
        const p = w3[0]?.words;
        check("peak words (phone): the same lines on the first picture, a size down, still inside the tile", !!p && p.at === "bottom-left" && p.heading?.text === "Find the perfect gift" && p.heading.l >= 8 && p.heading.r > 20 && p.cta?.b >= 6 && p.cta.b <= 22, JSON.stringify(w3[0]));
        await wp.ctx.close();
      }
      const vip = await open("/full?home=focus&pk=1&login=Ann&tags=wholesale,vip");
      const tagged = await readPeak(vip.page);
      check("peak home (signed in with the tag, any case): the tag's picture too, in the saved order — and with three the rail shows two and a half, the third a swipe away, no arrows", tagged.labels.join("|") === "Black Friday: 30% off everything|An extra 10% for members|Early access to the winter styles" && oneRow(tagged) && tagged.scrolls && tagged.inside && Math.abs(tagged.rects[0].w - (tagged.box.w - 20) / 2.5) <= 2 && tagged.clean, JSON.stringify({ labels: tagged.labels, w: tagged.rects[0]?.w, box: tagged.box?.w }));
      // The third tile is a video from Shopify Files: silent, looping, playing by itself once in view, its picture as the poster, still a question tile.
      await vip.page.evaluate(() => document.querySelector(".ai-chat-peak__tiles").scrollTo({ left: 9999 }));
      await vip.page.waitForTimeout(1200);
      const vt = await vip.page.evaluate(() => { const t = document.querySelectorAll(".ai-chat-peak__tile")[2]; const v = t.querySelector("video"); return { tag: t.tagName, ask: t.getAttribute("data-message"), has: !!v, muted: v?.muted, loop: v?.loop, inline: v?.hasAttribute("playsinline"), auto: v?.hasAttribute("autoplay"), poster: v?.getAttribute("poster") || "", src: v?.querySelector("source")?.getAttribute("src") || "", type: v?.querySelector("source")?.getAttribute("type") || "", playing: !!v && !v.paused && v.currentTime > 0, hidden: v?.getAttribute("aria-hidden") }; });
      check("peak home (video tile): a silent looping video with its picture as the poster plays by itself in view, inside a tap-to-ask tile", vt.tag === "BUTTON" && vt.ask === "Show me the VIP early-access styles" && vt.has && vt.muted && vt.loop && vt.inline && vt.auto && /pic-pain/.test(vt.poster) && vt.src === "/peak.webm" && vt.type === "video/webm" && vt.playing && vt.hidden === "true", JSON.stringify(vt));
      await vip.ctx.close();
      // The mosaic: the first big over two rows, the rest around it, edges level, no holes.
      const mo = await open("/full?home=focus&pk=1&pkl=mosaic&login=Ann&tags=vip");
      const m3 = await readPeak(mo.page);
      const [a3, b3, c3] = m3.rects;
      check("peak home (mosaic, three): the first picture big on the left over two rows, the other two stacked at its right, the edges level and no holes", m3.layout === "mosaic" && a3.w > b3.w * 1.8 && a3.x < b3.x && b3.x === c3.x && b3.y < c3.y && Math.abs(a3.y - b3.y) <= 1 && Math.abs(a3.y + a3.h - (c3.y + c3.h)) <= 1 && Math.abs(a3.h - (b3.h + c3.h + 10)) <= 2, JSON.stringify(m3.rects));
      await mo.ctx.close();
      // Without the lights, the home still has no straight line under the header: the grey line is a peak-days-off thing.
      const nd = await open("/full?home=focus&pk=1&pkd=off&login=Ann&tags=vip");
      const ndl = await nd.page.evaluate(() => { const p = document.querySelector(".ai-chat-panel"); const hdr = document.querySelector(".ai-chat-header"); return { peak: p.getAttribute("data-peak"), decor: p.getAttribute("data-peak-decor"), lights: !!hdr.querySelector(".ai-chat-deco--lights"), grey: getComputedStyle(hdr).borderBottomColor, home: p.classList.contains("is-home") }; });
      // What shows, not what the styles say: the pixels down the header's foot, in both themes — no row stands out (the tint used to repeat into the border row as a straight pink line).
      const footJump = async (pg) => { const hb = await pg.evaluate(() => document.querySelector(".ai-chat-header").getBoundingClientRect().toJSON()); const buf = await pg.screenshot({ clip: { x: hb.left + hb.width * 0.3, y: hb.bottom - 8, width: 1, height: 16 }, scale: "css" }); return pg.evaluate(async (src) => { const img = new Image(); img.src = src; await img.decode(); const c = document.createElement("canvas"); c.width = 1; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, 1, img.height).data; let jump = 0; for (let i = 4; i < d.length; i += 4) jump = Math.max(jump, Math.abs(d[i] - d[i - 4]) + Math.abs(d[i + 1] - d[i - 3]) + Math.abs(d[i + 2] - d[i - 2])); return jump; }, "data:image/png;base64," + buf.toString("base64")); };
      const jumps = { dark: await footJump(nd.page) };
      await nd.page.click(".ai-chat-header [aria-label='Switch to light mode']");
      await nd.page.waitForTimeout(600);
      jumps.theme = await nd.page.evaluate(() => document.querySelector(".ai-chat-panel").getAttribute("data-theme"));
      jumps.light = await footJump(nd.page);
      check("peak home (set to nothing): no points of light, and no straight grey line under the header either", ndl.peak === "1" && !ndl.decor && !ndl.lights && ndl.home && /rgba\(.*, 0\)|transparent/.test(ndl.grey), JSON.stringify(ndl));
      check("peak home: nothing straight shows along the header's foot in either theme (the pixels down it change by no more than a tint's fade)", jumps.dark <= 12 && jumps.light <= 12 && jumps.theme === "light", JSON.stringify(jumps));
      await nd.ctx.close();
      // A picture with sizes to choose from (an upload's smaller copies, or the CDN's): the page is handed its candidates by width, and asks for the one near the tile's own pixels — on a 1x screen a copy near the tile's width, not the full picture scaled down a long way.
      peakImageLog.length = 0;
      const ps = await open("/full?home=focus&pk=1&pks=1&pkl=grid&login=Ann&tags=vip");
      const psz = await ps.page.evaluate(() => { const img = document.querySelector(".ai-chat-peak__tile img[srcset]"); const w = img.parentElement.getBoundingClientRect().width; return { srcset: img.getAttribute("srcset"), sizes: img.sizes, tile: Math.round(w), picked: img.currentSrc, natural: img.naturalWidth }; });
      check("peak home (a picture with sizes): the tile's picture carries its candidates by width and asks for its own width; at 1x the page took the 400-wide copy for a tile under 400px, no bigger", /400w.*800w.*1600w/.test(psz.srcset) && Math.abs(parseInt(psz.sizes, 10) - psz.tile) <= 2 && /w=400/.test(psz.picked) && peakImageLog.some((q) => /w=400/.test(q)) && !peakImageLog.some((q) => !/w=/.test(q)), JSON.stringify({ ...psz, asked: peakImageLog }));
      await ps.ctx.close();
      const ps2 = await open("/full?home=focus&pk=1&pks=1&pkl=grid&login=Ann&tags=vip", { deviceScaleFactor: 2 });
      const psz2 = await ps2.page.evaluate(() => { const img = document.querySelector(".ai-chat-peak__tile img[srcset]"); return { picked: img.currentSrc, natural: img.naturalWidth, dpr: devicePixelRatio }; });
      check("peak home (a picture with sizes, Retina): at 2x the same tile takes the 800-wide copy", psz2.dpr === 2 && /w=800/.test(psz2.picked), JSON.stringify(psz2));
      await ps2.ctx.close();
      const m4p = await open("/full?home=focus&pk=1&pkl=mosaic&pkn=4");
      const m4 = await readPeak(m4p.page);
      check("peak home (mosaic, four): the big one left, two small on top at the right and one wide under them, level with the big one's bottom", m4.rects.length === 4 && m4.rects[0].w > m4.rects[1].w * 1.8 && m4.rects[1].y === m4.rects[2].y && m4.rects[3].y > m4.rects[1].y && Math.abs(m4.rects[3].w - (m4.rects[1].w * 2 + 10)) <= 2 && Math.abs(m4.rects[0].y + m4.rects[0].h - (m4.rects[3].y + m4.rects[3].h)) <= 1, JSON.stringify(m4.rects));
      await m4p.ctx.close();
      const m6p = await open("/full?home=focus&pk=1&pkl=mosaic&pkn=6");
      const m6 = await readPeak(m6p.page);
      check("peak home (mosaic, six): the big one with two stacked beside it, then three across underneath, all the same size", m6.rects.length === 6 && m6.rects[0].w > m6.rects[1].w * 1.8 && m6.rects[1].x === m6.rects[2].x && new Set(m6.rects.slice(3).map((x) => x.y)).size === 1 && m6.rects[3].y >= m6.rects[0].y + m6.rects[0].h && new Set(m6.rects.slice(3).map((x) => x.w)).size === 1, JSON.stringify(m6.rects));
      await m6p.ctx.close();
      const gr = await open("/full?home=focus&pk=1&pkl=grid&login=Ann&tags=vip");
      const g3 = await readPeak(gr.page);
      check("peak home (grid, three): two across the same size, the odd last one across the whole row", g3.layout === "grid" && g3.rects[0].y === g3.rects[1].y && g3.rects[0].w === g3.rects[1].w && g3.rects[2].y > g3.rects[0].y && Math.abs(g3.rects[2].w - g3.box.w) <= 1, JSON.stringify(g3.rects));
      await gr.ctx.close();
      const ph = await open("/full?home=focus&pk=1&login=Ann&tags=vip", { viewport: { width: 390, height: 760 } });
      const phone = await readPeak(ph.page);
      check("peak home (phone): the rail shows one picture and a quarter of the next, never stacked, scrolling sideways within the screen", phone.labels.length === 3 && oneRow(phone) && phone.scrolls && phone.inside && Math.abs(phone.rects[0].w - (phone.box.w - 8) / 1.25) <= 2, JSON.stringify({ w: phone.rects[0]?.w, box: phone.box?.w }));
      const phl = await ph.page.evaluate(() => { const p = document.querySelector(".ai-chat-panel"); const box = document.querySelector(".ai-chat-header .ai-chat-deco--lights"); return { decor: p.getAttribute("data-peak-decor"), shown: box ? getComputedStyle(box).display : "gone", w: box ? box.getBoundingClientRect().width : 0, grey: getComputedStyle(document.querySelector(".ai-chat-header")).borderBottomColor }; });
      check("peak home (phone): no points of light on a phone — the setting stands, they aren't drawn there; no straight grey line either", phl.decor === "lights" && phl.shown === "none" && phl.w === 0 && /rgba\(.*, 0\)|transparent/.test(phl.grey), JSON.stringify(phl));
      await ph.ctx.close();
      const phm = await open("/full?home=focus&pk=1&pkl=mosaic&login=Ann&tags=vip", { viewport: { width: 390, height: 760 } });
      const pm = await readPeak(phm.page);
      check("peak home (phone, mosaic): the first across the top, the other two side by side under it", pm.rects.length === 3 && Math.abs(pm.rects[0].w - pm.box.w) <= 1 && pm.rects[1].y === pm.rects[2].y && pm.rects[1].y > pm.rects[0].y && Math.abs(pm.rects[1].w - (pm.box.w - 8) / 2) <= 1.5, JSON.stringify(pm.rects));
      await phm.ctx.close();
      // Settings → Peak Mode → Preview: the token on the page link shows the peak home to this browser — and on the pages after it (the session) — with Peak Mode off.
      const pv = await open("/full?home=focus&banner=1&ava_preview=0123456789abcdef0123456789abcdef");
      const previewed = await readPeak(pv.page);
      await pv.page.goto("http://localhost:4789/full?home=focus&banner=1");
      await pv.page.click(".ai-chat-launcher");
      await pv.page.waitForTimeout(1200);
      const nextPage = await readPeak(pv.page);
      check("peak preview: the signed token on the link shows the peak home to this browser with Peak Mode off, and keeps showing it on the pages after", previewed.labels.length === 2 && !previewed.banner && nextPage.labels.length === 2 && !nextPage.banner, JSON.stringify({ previewed: previewed.labels, nextPage: nextPage.labels }));
      await pv.ctx.close();
      const cl = await open("/full?pk=1&banner=1");
      const classic = await cl.page.evaluate(() => ({ peak: document.querySelectorAll(".ai-chat-welcome .ai-chat-peak__tile").length, banner: !!document.querySelector(".ai-chat-welcome__banner"), avatar: document.querySelector(".ai-chat-welcome__avatar img")?.getAttribute("src") || "", glow: getComputedStyle(document.querySelector(".ai-chat-avatar-glow")).backgroundImage }));
      check("peak home (classic layout): the pictures in place of the banner there too, the peak picture on the welcome, her colours on the glow around it", classic.peak === 2 && !classic.banner && /pic-orthotics/.test(classic.avatar) && /rgb\(212, 43, 58\)/.test(classic.glow), JSON.stringify({ ...classic, glow: classic.glow.slice(0, 80) }));
      await cl.ctx.close();
      // Peak Mode with the tint off: the header's straight grey line stays at home (the tint is what takes it away).
      const pt = await open("/full?home=focus&pk=1&pkt=0&login=Ann&tags=vip");
      const ptl = await pt.page.evaluate(() => { const p = document.querySelector(".ai-chat-panel"); return { peak: p.getAttribute("data-peak"), tint: p.getAttribute("data-peak-tint"), grey: getComputedStyle(document.querySelector(".ai-chat-header")).borderBottomColor, home: p.classList.contains("is-home"), k: p.style.getPropertyValue("--ai-ring-k") }; });
      check("peak home (tint off): the straight grey line under the header stays at home — her colours, the bold ring and the lights still on", ptl.peak === "1" && !ptl.tint && ptl.home && !/rgba\(.*, 0\)|transparent/.test(ptl.grey) && ptl.k === "2.8", JSON.stringify(ptl));
      await pt.ctx.close();
    }
    // Settings → Focus home → Her look (every other day, Peak Mode off): the same colours, ring, lights and tint as peak days have — the winter blue on the glow, the ring and the line, a regular ring, the lights; the tint off, so the grey line stays; the tint on, and it goes.
    {
      const lk = await open("/full?home=focus&look=1&lkd=1&banner=1");
      const lkl = await lk.page.evaluate(() => { const p = document.querySelector(".ai-chat-panel"); const hdr = document.querySelector(".ai-chat-header"); const l = document.querySelector(".ai-chat-launcher"); const box = hdr.querySelector(".ai-chat-deco--lights"); return { peak: p.getAttribute("data-peak"), k: p.style.getPropertyValue("--ai-ring-k"), glow: p.style.getPropertyValue("--ai-glow-1"), lglow: l.style.getPropertyValue("--ai-glow-1"), stop: document.querySelector("#ai-chat-band-g stop")?.getAttribute("stop-color"), halo: getComputedStyle(document.querySelector(".ai-chat-hero__halo")).backgroundImage, decor: p.getAttribute("data-peak-decor"), lights: box ? box.querySelectorAll(".d-light").length : 0, tint: p.getAttribute("data-peak-tint"), grey: getComputedStyle(hdr).borderBottomColor, banner: !!document.querySelector(".ai-chat-welcome__banner"), peakTiles: document.querySelectorAll(".ai-chat-peak__tile").length, home: p.classList.contains("is-home"), avatar: document.querySelector(".ai-chat-hero__photo img, .ai-chat-header__avatar img")?.getAttribute("src") || "" }; });
      check("her look (every other day): the winter blue on the glow around her face, the ring, the line and the bar's glow; a regular ring; the points of light — with no peak marking, the banner in place, her usual picture; the tint off, so the straight grey line under the header stays", !lkl.peak && lkl.k === "1.8" && lkl.glow === "#8fd3ff" && lkl.lglow === "#8fd3ff" && lkl.stop === "#8fd3ff" && /rgb\(143, 211, 255\)/.test(lkl.halo) && lkl.decor === "lights" && lkl.lights === 8 && !lkl.tint && !/rgba\(.*, 0\)|transparent/.test(lkl.grey) && lkl.banner && lkl.peakTiles === 0 && lkl.home && !/pic-orthotics/.test(lkl.avatar), JSON.stringify(lkl));
      check("her look: no JS errors", lk.errors.length === 0, lk.errors.join(" | "));
      await lk.ctx.close();
      const lt = await open("/full?home=focus&look=1&lkt=1");
      const ltl = await lt.page.evaluate(() => { const p = document.querySelector(".ai-chat-panel"); const hdr = document.querySelector(".ai-chat-header"); return { peak: p.getAttribute("data-peak"), tint: p.getAttribute("data-peak-tint"), hbg: getComputedStyle(hdr).backgroundImage, grey: getComputedStyle(hdr).borderBottomColor, decor: p.getAttribute("data-peak-decor"), home: p.classList.contains("is-home") }; });
      check("her look (tint on): a breath of the first colour behind the header, and the straight grey line is gone at home — no lights unless asked", !ltl.peak && ltl.tint === "1" && ltl.hbg !== "none" && /143, 211, 255|0\.56\d* 0\.82\d* 1\b/.test(ltl.hbg) && /rgba\(.*, 0\)|transparent/.test(ltl.grey) && !ltl.decor && ltl.home, JSON.stringify(ltl));
      // Once a chat starts the page's look is the chat's own: the tint stays with the header, the home marking goes.
      await startChat(lt.page);
      await lt.page.waitForTimeout(1500);
      const ltc = await lt.page.evaluate(() => ({ home: document.querySelector(".ai-chat-panel").classList.contains("is-home"), grey: getComputedStyle(document.querySelector(".ai-chat-header")).borderBottomColor }));
      check("her look (tint on, in a chat): the home is left, the header's foot as the chat has it", !ltc.home, JSON.stringify(ltc));
      await lt.ctx.close();
      // A page remembers the look: the next page starts with it before the settings are read again.
      const rm = await open("/full?home=focus&look=1");
      await rm.page.goto("http://localhost:4789/full?home=focus&look=1");
      const early = await rm.page.evaluate(() => { const p = document.querySelector(".ai-chat-panel"); return { k: p.style.getPropertyValue("--ai-ring-k"), glow: p.style.getPropertyValue("--ai-glow-1"), kept: localStorage.getItem("hajirai_look") }; });
      check("her look: remembered for the next page — the ring and the colours are there from the first paint", early.k === "1.8" && early.glow === "#8fd3ff" && /8fd3ff/.test(early.kept || ""), JSON.stringify(early));
      await rm.ctx.close();
    }
    // Settings → Focus home → Her look → The three cards: simple — the full cards' places and widths (on a computer Footwear, Foot pain the wide one, Orthotics in one row; on phones Foot pain across the top with the two under it; the smallest phones stacked), each a flat box with the store's line drawing big and faded in from its left edge, the small line and the name; no pictures, no line under the name, no button; each still opening its sheet. The cards' colours: soft grey (the chat's), white, charcoal, a breath of her first colour, or the store's own two. The Peak Mode editor has the same choices for peak days. Without the choice, the cards are as they were.
    {
      const readCards = (page) => page.evaluate(() => {
        const box = document.querySelector(".ai-chat-focus__cards"); const cards = [...box.querySelectorAll(".ai-chat-focus__card")]; const b = box.getBoundingClientRect();
        const shown = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0;
        const by = Object.fromEntries(cards.map((c) => [c.getAttribute("data-focus-sheet"), c]));
        const r = (k) => by[k].getBoundingClientRect();
        const ico = (k) => by[k].querySelector(".ai-chat-focus__card-ico");
        const rect = (k) => { const x = r(k); return { x: Math.round(x.left - b.left), y: Math.round(x.top - b.top), w: Math.round(x.width), h: Math.round(x.height) }; };
        const drawing = (k) => { const i = ico(k); const ir = i.getBoundingClientRect(); const cs = getComputedStyle(i); const t = by[k].querySelector(".ai-chat-focus__card-title").getBoundingClientRect(); return { left: Math.round(ir.left - r(k).left), h: Math.round(ir.height), w: Math.round(ir.width), opacity: Number(cs.opacity), masked: /data:image\/png;base64/.test(cs.webkitMaskImage || cs.maskImage || ""), svgs: i.querySelectorAll("svg").length, imgs: by[k].querySelectorAll("img").length, titleX: Math.round(t.left - r(k).left), titleBottom: Math.round(r(k).bottom - t.bottom) }; };
        return { simple: box.classList.contains("is-simple"), n: cards.length, kinds: cards.map((c) => c.getAttribute("data-focus-sheet")),
          pain: rect("pain"), footwear: rect("footwear"), orthotics: rect("orthotics"), box: Math.round(b.width),
          d: { pain: drawing("pain"), footwear: drawing("footwear"), orthotics: drawing("orthotics") },
          eyebrows: cards.map((c) => shown(c.querySelector(".ai-chat-focus__card-eyebrow")) ? c.querySelector(".ai-chat-focus__card-eyebrow").textContent : ""), titles: cards.map((c) => c.querySelector(".ai-chat-focus__card-title").textContent),
          subs: cards.map((c) => shown(c.querySelector(".ai-chat-focus__card-sub"))), ctas: cards.map((c) => shown(c.querySelector(".ai-chat-focus__card-cta"))),
          bg: getComputedStyle(by.pain).backgroundColor, ink: getComputedStyle(by.pain.querySelector(".ai-chat-focus__card-title")).color, tone: document.querySelector(".ai-chat-panel").getAttribute("data-cards-tone"),
          buttons: cards.every((c) => c.tagName === "BUTTON" && c.getAttribute("aria-haspopup") === "dialog") };
      });
      const drawn = (d) => d.masked && d.svgs === 0 && d.imgs === 0 && d.left <= 0 && d.opacity > 0.1 && d.opacity < 0.5 && d.h >= 50;
      const sameRow = (a, c) => Math.abs(a.y - c.y) <= 1 && Math.abs(a.h - c.h) <= 1;
      const sc = await open("/full?home=focus&cards=simple&pics=1&texts=home");
      const c1 = await readCards(sc.page);
      check("simple cards (computer): the full cards' row — Footwear, Foot pain twice as wide in the middle, Orthotics — one height; no pictures, no line under the name, no button; the store's words", c1.simple && c1.n === 3 && c1.kinds.join() === "pain,footwear,orthotics" && sameRow(c1.footwear, c1.pain) && sameRow(c1.pain, c1.orthotics) && c1.footwear.x < c1.pain.x && c1.pain.x < c1.orthotics.x && c1.pain.w / c1.footwear.w >= 1.85 && c1.pain.w / c1.footwear.w <= 2.15 && Math.abs(c1.footwear.w - c1.orthotics.w) <= 1 && c1.orthotics.x + c1.orthotics.w <= c1.box + 1 && c1.eyebrows.join("|") === "Sore feet?|Help me find|Help me find" && c1.titles.join("|") === "Pain help|Shoes|Orthotics" && c1.subs.every((x) => !x) && c1.ctas.every((x) => !x) && c1.buttons, JSON.stringify(c1));
      check("simple cards (computer): each card's drawing is the store's own (a mask, no svg, no picture), big, faded and in from the left edge; the words over its tail — the two narrow cards' low at the left, the wide card's beside it", drawn(c1.d.pain) && drawn(c1.d.footwear) && drawn(c1.d.orthotics) && c1.d.footwear.titleX <= 20 && c1.d.footwear.titleBottom <= 20 && c1.d.pain.titleX >= c1.d.pain.w - 12 && c1.d.pain.h >= 80, JSON.stringify(c1.d));
      check("simple cards (computer): soft grey as the chat by default, nothing else marked", c1.tone === "soft" && c1.bg === "rgb(35, 35, 41)", JSON.stringify([c1.tone, c1.bg]));
      await sc.page.click('[data-focus-sheet="footwear"]');
      await sc.page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 }).catch(() => {});
      await sc.page.waitForTimeout(400);
      const c2 = await sc.page.evaluate(() => ({ sheet: document.querySelector(".ai-chat-focus-sheet")?.getAttribute("data-kind") || "", open: !!document.querySelector(".ai-chat-focus-sheet.is-open") }));
      check("simple cards: a tap on Footwear opens the Footwear sheet as before", c2.sheet === "footwear" && c2.open, JSON.stringify(c2));
      check("simple cards: no JS errors", sc.errors.length === 0, sc.errors.join(" | "));
      await sc.ctx.close();
      const sp = await open("/full?home=focus&cards=simple&pics=1", { viewport: { width: 390, height: 760 } });
      const c3 = await readCards(sp.page);
      check("simple cards (phone): Foot pain across the top, Footwear and Orthotics side by side under it, alike — the drawings in from the left, no pictures, no button", c3.simple && c3.n === 3 && c3.pain.y < c3.footwear.y && Math.abs(c3.pain.w - c3.box) <= 1 && sameRow(c3.footwear, c3.orthotics) && Math.abs(c3.footwear.w - c3.orthotics.w) <= 1 && c3.footwear.x < c3.orthotics.x && drawn(c3.d.pain) && drawn(c3.d.footwear) && drawn(c3.d.orthotics) && c3.titles.join("|") === "Foot pain|Footwear|Orthotics" && c3.subs.every((x) => !x) && c3.ctas.every((x) => !x), JSON.stringify(c3));
      await sp.ctx.close();
      const sn = await open("/full?home=focus&cards=simple", { viewport: { width: 320, height: 700 } });
      const c4 = await readCards(sn.page);
      check("simple cards (small phone): the three stacked full width, the words beside the drawing in each, nothing cut off", c4.simple && c4.n === 3 && [c4.pain, c4.footwear, c4.orthotics].every((x) => Math.abs(x.w - c4.box) <= 1) && c4.pain.y < c4.footwear.y && c4.footwear.y < c4.orthotics.y && drawn(c4.d.footwear) && c4.d.footwear.titleX >= c4.d.footwear.w - 12 && c4.d.orthotics.titleX >= c4.d.orthotics.w - 12, JSON.stringify(c4));
      await sn.ctx.close();
      const pk = await open("/full?home=focus&pk=1&pkc=simple&pkct=dark&login=Ann&tags=vip");
      const c5 = await readCards(pk.page);
      check("simple cards (peak days): the Peak Mode editor's own choice, with its colours — the three under the peak pictures, charcoal with white words", c5.simple && c5.n === 3 && sameRow(c5.footwear, c5.pain) && c5.footwear.x < c5.pain.x && c5.pain.x < c5.orthotics.x && drawn(c5.d.pain) && c5.tone === "dark" && c5.bg === "rgb(28, 28, 30)" && c5.ink === "rgb(255, 255, 255)", JSON.stringify([c5.tone, c5.bg, c5.ink, c5.pain, c5.footwear]));
      await pk.ctx.close();
      // The cards' colours, light theme and dark: the words follow the box.
      const light = { viewport: { width: 1280, height: 860 } };
      const toLight = async (page) => { await page.click('.ai-chat-header [aria-label="Switch to light mode"]'); await page.waitForTimeout(1000); };
      const tw = await open("/full?home=focus&cards=simple&ctone=white", light);
      await toLight(tw.page);
      const c6 = await readCards(tw.page);
      check("the cards' colours — white: white boxes with dark words, a hairline round each (light theme)", c6.tone === "white" && c6.bg === "rgb(255, 255, 255)" && c6.ink !== "rgb(255, 255, 255)" && /inset/.test(await tw.page.evaluate(() => getComputedStyle(document.querySelector(".ai-chat-focus__card--pain")).boxShadow)), JSON.stringify([c6.tone, c6.bg, c6.ink]));
      await tw.ctx.close();
      const td = await open("/full?home=focus&cards=simple&ctone=dark", light);
      await toLight(td.page);
      const c7 = await readCards(td.page);
      check("the cards' colours — charcoal: dark boxes with white words even in the light theme", c7.tone === "dark" && c7.bg === "rgb(28, 28, 30)" && c7.ink === "rgb(255, 255, 255)", JSON.stringify([c7.tone, c7.bg, c7.ink]));
      await td.ctx.close();
      const tt = await open("/full?home=focus&look=1&cards=simple&ctone=tint", light);
      await toLight(tt.page);
      const c8 = await readCards(tt.page);
      const tintDrawing = await tt.page.evaluate(() => { const i = document.querySelector(".ai-chat-focus__card--pain .ai-chat-focus__card-ico"); return { bg: getComputedStyle(i).backgroundColor, op: getComputedStyle(i).opacity }; });
      check("the cards' colours — a breath of her first colour: the boxes tinted with it (her winter blue), the drawings in it", c8.tone === "tint" && c8.bg !== "rgb(245, 245, 247)" && c8.bg !== "rgb(255, 255, 255)" && tintDrawing.bg === "rgb(143, 211, 255)" && Number(tintDrawing.op) > 0.3, JSON.stringify([c8.tone, c8.bg, tintDrawing]));
      await tt.ctx.close();
      const tc = await open("/full?home=focus&cards=simple&ctone=custom&cbg=0f2b3a&cink=ffe9c4", light);
      await toLight(tc.page);
      const c9 = await readCards(tc.page);
      const customDrawing = await tc.page.evaluate(() => getComputedStyle(document.querySelector(".ai-chat-focus__card--pain .ai-chat-focus__card-ico")).backgroundColor);
      check("the cards' colours — the store's own two: the box in one, the words and the drawing in the other", c9.tone === "custom" && c9.bg === "rgb(15, 43, 58)" && c9.ink === "rgb(255, 233, 196)" && customDrawing === "rgb(255, 233, 196)", JSON.stringify([c9.tone, c9.bg, c9.ink, customDrawing]));
      await tc.ctx.close();
      const fu = await open("/full?home=focus&look=1&pics=1");
      const c10 = await readCards(fu.page);
      check("the cards as they were: her look alone leaves them whole — pictures, the line under the name, the button; no colours marked", !c10.simple && c10.n === 3 && c10.d.footwear.imgs === 1 && c10.d.pain.imgs === 1 && c10.subs.every(Boolean) && c10.ctas.every(Boolean) && c10.tone === null, JSON.stringify([c10.simple, c10.d.footwear.imgs, c10.subs, c10.ctas, c10.tone]));
      await fu.ctx.close();
    }
    // Settings → Chat text → Welcome greeting on phones: phones show it in the header at home; computers keep the greeting; a signed-in shopper's greeting still wins on both.
    {
      const title = (page) => page.evaluate(() => document.querySelector(".ai-chat-header__title--home")?.textContent || "");
      const gd = await open("/full?home=focus&texts=home");
      const gdt = await title(gd.page);
      await gd.ctx.close();
      const gp = await open("/full?home=focus&texts=home", { viewport: { width: 390, height: 760 } });
      const gpt = await title(gp.page);
      // The screen widens past the phone line: the greeting follows.
      await gp.page.setViewportSize({ width: 1280, height: 860 });
      await gp.page.waitForTimeout(300);
      const gpw = await title(gp.page);
      await gp.ctx.close();
      const gs = await open("/full?home=focus&texts=home&login=Ann", { viewport: { width: 390, height: 760 } });
      const gst = await title(gs.page);
      await gs.ctx.close();
      check("greeting on phones: the phone greeting in the header at home on a phone, the greeting on a computer (and once the window widens), the signed-in greeting for a known shopper on both", gpt === "Hi! Let’s find your fit." && gdt === "Hi! I'm your personal shopping assistant." && gpw === gdt && /Ann/.test(gst), JSON.stringify({ gdt, gpt, gpw, gst }));
    }
    // Phones: the sheets' helper rows stay side by side — two to a row — and on a very narrow phone the row scrolls sideways rather than stacking them.
    for (const w of [390, 320]) {
      const ph = await open("/full?home=focus&qp=1", { viewport: { width: w, height: 760 } });
      await ph.page.click('[data-focus-sheet="orthotics"]');
      await ph.page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
      await ph.page.waitForTimeout(400);
      const hr = await ph.page.evaluate(() => { const r = document.querySelector(".ai-chat-focus__helpers"); const hs = [...r.querySelectorAll(".ai-chat-helper")]; const b = document.querySelector(".ai-chat-focus-sheet__body").getBoundingClientRect(); return { n: hs.length, oneRow: new Set(hs.map((h) => Math.round(h.getBoundingClientRect().top))).size === 1, tall: hs.every((h) => h.getBoundingClientRect().height >= 56), scrolls: r.scrollWidth > r.clientWidth + 1, overflowX: getComputedStyle(r).overflowX, inside: r.getBoundingClientRect().right <= b.right + 1, barHidden: getComputedStyle(r).scrollbarWidth === "none" }; });
      check(`Orthotics sheet (${w}px phone): the two helper rows sit side by side on one row${w < 360 ? ", the row scrolling sideways" : ""}, never stacked`, hr.n === 2 && hr.oneRow && hr.tall && hr.overflowX === "auto" && hr.inside && hr.barHidden && (w < 360 ? hr.scrolls : !hr.scrolls), JSON.stringify(hr));
      await ph.ctx.close();
    }
    // Settings → Focus home → Collections off: both sheets keep their helper rows and Pick & go, with no Collections section.
    {
      const off = await open("/full?home=focus&cl=0");
      const sheetOff = async (kind) => {
        await off.page.click(`[data-focus-sheet="${kind}"]`);
        await off.page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
        await off.page.waitForTimeout(400);
        const got = await off.page.evaluate(() => { const s = document.querySelector(".ai-chat-focus-sheet"); return { sections: [...s.querySelectorAll(".ai-chat-focus__browse > .ai-chat-focus__label")].map((l) => l.textContent), chips: s.querySelectorAll(".ai-chat-focus__chips").length, pick: !!s.querySelector(".ai-chat-focus__pick"), rows: s.querySelectorAll(".ai-chat-focus__pick-row").length }; });
        await off.page.click(".ai-chat-focus-sheet__close");
        await off.page.waitForTimeout(400);
        return got;
      };
      const fwOff = await sheetOff("footwear"), orOff = await sheetOff("orthotics");
      check("Settings → Focus home → Collections off: the Footwear and Orthotics sheets keep Pick & go (both rows), with no Collections section and no one-tap chips", fwOff.sections.join(",") === "Pick & go" && fwOff.chips === 0 && fwOff.pick && fwOff.rows === 2 && orOff.sections.join(",") === "Pick & go" && orOff.chips === 0 && orOff.pick && orOff.rows === 2, JSON.stringify({ fwOff, orOff }));
      check("Settings → Focus home → Collections off: no JS errors", off.errors.length === 0, off.errors.join(" | "));
      await off.ctx.close();
    }
    // The Foot pain flow: where it hurts, orthotics, the shoes, the arch, the ball of the foot — then one message with it all; after a reload the chat opens with the line, no face.
    n = chatBodies.length;
    await page.click('[data-focus-sheet="pain"]');
    await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    await page.waitForTimeout(400);
    const q1 = await page.evaluate(() => { const sh = document.querySelector(".ai-chat-focus-sheet"); return { title: sh.querySelector(".ai-chat-focus__q-title")?.textContent, hint: sh.querySelector(".ai-chat-focus__q-hint")?.textContent, tiles: [...sh.querySelectorAll("[data-pain-opt]")].map((b) => b.querySelector(".ai-chat-focus__opt-title").textContent), subs: [...sh.querySelectorAll("[data-pain-opt]")].map((b) => b.querySelector(".ai-chat-focus__opt-sub")?.textContent || ""), coins: [...sh.querySelectorAll("[data-pain-opt] .ai-chat-focus__coin img")].map((i) => (i.getAttribute("src") || "").replace(/^.*focus-pain-/, "").replace(/\.png$/, "")), coinsLoaded: [...sh.querySelectorAll(".ai-chat-focus__coin img")].every((i) => i.complete && i.naturalWidth > 0), picFull: [...sh.querySelectorAll(".ai-chat-focus__coin")].every((c) => { const r = c.getBoundingClientRect(), t = c.closest("[data-pain-opt]").getBoundingClientRect(); return Math.abs(r.left - t.left) <= 2 && Math.abs(r.height - t.height) <= 3 && r.width >= 60 && getComputedStyle(c).borderRadius === "0px"; }), cols: new Set([...sh.querySelectorAll("[data-pain-opt]")].map((b) => Math.round(b.getBoundingClientRect().left))).size, tileH: Math.min(...[...sh.querySelectorAll("[data-pain-opt]")].map((b) => b.getBoundingClientRect().height)), gender: !!sh.querySelector(".ai-chat-focus__gender"), eyebrow: sh.querySelector(".ai-chat-focus-sheet__eyebrow")?.textContent, name: sh.querySelector(".ai-chat-focus-sheet__title")?.textContent, next: sh.querySelector('[data-pain-nav="next"]')?.disabled, dots: sh.querySelectorAll(".ai-chat-focus__dots i").length, done: sh.querySelectorAll(".ai-chat-focus__dots i.is-done").length, back: !!sh.querySelector('[data-pain-nav="back"]'), else: !!sh.querySelector("[data-pain-else]"), roles: [...sh.querySelectorAll("[data-pain-opt]")].every((b) => b.getAttribute("role") === "checkbox" && b.getAttribute("aria-checked") === "false") }; });
    check("foot pain sheet: opens like the other two (Help me with · Foot pain, the Women's / Men's switch) on Where does it hurt — six tiles in two columns with what each usually is, the four pictures filling each tile's left side edge to edge (no coin), four stage bars (one lit) that never change count, Continue waiting for a pick, no Back yet, Something else under them", q1.eyebrow === "Help me with" && q1.name === "Foot pain" && q1.gender && q1.title === "Where does it hurt?" && /Tap all/.test(q1.hint) && q1.tiles.join("|") === "Heel|Arch|Ball of foot|Toes & bunions|Whole foot|No pain" && /Plantar/.test(q1.subs[0]) && q1.coins.join("|") === "heel|arch|ball|toes" && q1.coinsLoaded && q1.picFull && q1.cols === 2 && q1.tileH >= 52 && q1.next === true && q1.dots === 4 && q1.done === 1 && !q1.back && q1.else && q1.roles, JSON.stringify(q1));
    await page.click('[data-pain-opt="heel"]');
    await page.click('[data-pain-opt="none"]');
    const q1b = await page.evaluate(() => [...document.querySelectorAll("[data-pain-opt].is-on")].map((b) => b.getAttribute("data-pain-opt")).join("|"));
    await page.click('[data-pain-opt="heel"]');
    await page.click('[data-pain-opt="arch"]');
    const q1c = await page.evaluate(() => ({ on: [...document.querySelectorAll("[data-pain-opt].is-on")].map((b) => b.getAttribute("data-pain-opt")).join("|"), checked: document.querySelectorAll('[data-pain-opt][aria-checked="true"]').length, next: document.querySelector('[data-pain-nav="next"]').disabled, sheet: !!document.querySelector(".ai-chat-focus-sheet") }));
    check("foot pain sheet: several places can be picked (No pain stands alone and clears them), the tiles say which are on, nothing sent yet", q1b === "none" && q1c.on === "heel|arch" && q1c.checked === 2 && q1c.next === false && q1c.sheet && chatBodies.length === n, JSON.stringify({ q1b, q1c }));
    await page.click('[data-pain-nav="next"]');
    await page.waitForTimeout(450);
    const q2 = await page.evaluate(() => { const sh = document.querySelector(".ai-chat-focus-sheet"); return { title: sh.querySelector(".ai-chat-focus__q-title")?.textContent, tiles: [...sh.querySelectorAll("[data-pain-opt]")].map((b) => b.querySelector(".ai-chat-focus__opt-title").textContent), back: !!sh.querySelector('[data-pain-nav="back"]'), picks: sh.querySelector(".ai-chat-focus__picks")?.textContent, focused: document.activeElement === sh.querySelector(".ai-chat-focus__q-title"), radios: [...sh.querySelectorAll("[data-pain-opt]")].every((b) => b.getAttribute("role") === "radio") }; });
    check("foot pain sheet: then footwear, orthotics or both — Back and the picks so far under the tiles, the question focused for screen readers", q2.title === "What should I look for?" && q2.tiles.join("|") === "Footwear|Orthotics|Not sure — show me both" && q2.back && q2.picks === "Heel, Arch" && q2.focused && q2.radios, JSON.stringify(q2));
    await page.click('[data-pain-opt="orthotics"]');
    await page.waitForTimeout(500);
    const q3 = await page.evaluate(() => { const sh = document.querySelector(".ai-chat-focus-sheet"); return { title: sh.querySelector(".ai-chat-focus__q-title")?.textContent, tiles: [...sh.querySelectorAll("[data-pain-opt]")].map((b) => b.querySelector(".ai-chat-focus__opt-title").textContent), dots: sh.querySelectorAll(".ai-chat-focus__dots i").length, done: sh.querySelectorAll(".ai-chat-focus__dots i.is-done").length }; });
    check("foot pain sheet: orthotics ask which shoes they go in — the lines' own Best for", q3.title === "Which shoes will they go in?" && q3.tiles.join("|") === "Sneakers & everyday shoes|Running shoes|Gym & training shoes|Dress shoes & heels|Work boots|Hiking & golf shoes|Winter boots|Cleats" && q3.dots === 4 && q3.done === 2, JSON.stringify(q3));
    const q3bar = await page.evaluate(() => ({ bars: document.querySelectorAll(".ai-chat-focus__dots i").length, done: document.querySelectorAll(".ai-chat-focus__dots i.is-done").length, part: document.querySelector(".ai-chat-focus__dots i.is-part")?.style.getPropertyValue("--fill") || "", width: (() => { const p = document.querySelector(".ai-chat-focus__dots i.is-part"); if (!p) return 0; return parseFloat(getComputedStyle(p, "::after").width) / p.getBoundingClientRect().width; })() }));
    check("foot pain sheet: still four stage bars on the details step — two lit, the third a third full (one of three detail questions), the last dark", q3bar.bars === 4 && q3bar.done === 2 && q3bar.part === "0.33" && q3bar.width > 0.28 && q3bar.width < 0.38, JSON.stringify(q3bar));
    await page.click('[data-pain-opt="running"]');
    await page.waitForTimeout(500);
    const q4 = await page.evaluate(() => document.querySelector(".ai-chat-focus__q-title")?.textContent + " / " + [...document.querySelectorAll("[data-pain-opt]")].map((b) => b.querySelector(".ai-chat-focus__opt-title").textContent).join("|"));
    await page.click('[data-pain-opt="flat_low"]');
    await page.waitForTimeout(500);
    const q5 = await page.evaluate(() => document.querySelector(".ai-chat-focus__q-title")?.textContent + " / " + [...document.querySelectorAll("[data-pain-opt]")].map((b) => b.querySelector(".ai-chat-focus__opt-title").textContent).join("|"));
    check("foot pain sheet: then the arch (flat or low, medium or high, not sure) and pain under the ball of the foot — the four things the orthotic finder needs", q4 === "What’s your arch like? / Flat or low|Medium or high|Not sure" && q5 === "Any pain under the ball of your foot? / Yes|No", JSON.stringify({ q4, q5 }));
    await page.click('[data-pain-opt="no"]');
    await page.waitForTimeout(500);
    const sum = await page.evaluate(() => { const sh = document.querySelector(".ai-chat-focus-sheet"); return { title: sh.querySelector(".ai-chat-focus__q-title")?.textContent, rows: [...sh.querySelectorAll(".ai-chat-focus__sum-row")].map((r) => r.querySelector(".ai-chat-focus__sum-k").textContent + ": " + r.querySelector(".ai-chat-focus__sum-v").textContent), ask: sh.querySelector('[data-pain-nav="ask"]')?.textContent.trim(), done: sh.querySelectorAll(".ai-chat-focus__dots i.is-done").length, dots: sh.querySelectorAll(".ai-chat-focus__dots i").length }; });
    check("foot pain sheet: a summary — each line a row to change — and one button to ask Ava", sum.title === "Here’s what I’ll tell Ava" && sum.rows.join(" | ") === "Where it hurts: Heel, Arch | Looking for: Orthotics | Shoes: Running shoes | Arch: Flat or low | Ball of foot: No" && sum.ask === "Ask Ava for my match" && sum.done === sum.dots, JSON.stringify(sum));
    // A row opens its step again with the answer marked; a new answer goes straight back to the summary.
    await page.click('[data-pain-edit="shoes"]');
    await page.waitForTimeout(450);
    const ed = await page.evaluate(() => ({ title: document.querySelector(".ai-chat-focus__q-title")?.textContent, on: document.querySelector("[data-pain-opt].is-on")?.getAttribute("data-pain-opt") }));
    await page.click('[data-pain-opt="gym"]');
    await page.waitForTimeout(500);
    const ed2 = await page.evaluate(() => document.querySelector(".ai-chat-focus__q-title")?.textContent + " / " + [...document.querySelectorAll(".ai-chat-focus__sum-row")].map((r) => r.querySelector(".ai-chat-focus__sum-v").textContent).join("|"));
    check("foot pain sheet: a summary row reopens its step with the answer marked; a new answer goes straight back to the summary", ed.title === "Which shoes will they go in?" && ed.on === "running" && ed2 === "Here’s what I’ll tell Ava / Heel, Arch|Orthotics|Gym & training shoes|Flat or low|No", JSON.stringify({ ed, ed2 }));
    await page.click('[data-pain-nav="ask"]');
    await waitUntil(() => chatBodies.length > n);
    check("foot pain sheet: Ask Ava sends one message in the shopper's own words with everything the orthotic finder needs — women's, the shoes, the pain, the arch, the ball of the foot — nothing typed, the sheet gone", chatBodies.at(-1)?.message === "I’m looking for women’s orthotics for gym and training shoes. I have heel pain (plantar fasciitis) and arch pain. My arches are flat or low and my feet roll inward. No pain in the front of my foot. Which one would you recommend?" && chatBodies.at(-1)?.typed === false && !(await state(page)).sheet, chatBodies.at(-1)?.message);
    await page.waitForTimeout(1500);
    await page.reload();
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(700);
    s2 = await state(page);
    check("home layout focus: after a reload a chat under way opens with the line, not the face", s2.chatting && s2.heroGone && !s2.hero && !s2.home && !s2.focusHome && s2.msgs >= 2, JSON.stringify(s2));
    check("home layout focus: no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // With a second line to the name (Ask Ava! / Aetrex Virtual Assistant): the
  // header keeps one row — the second line stays out of it — the greeting
  // takes its place at the top of the home, and the face sits on the header's
  // line; in chat the colour line takes the same place.
  {
    const { ctx, page, errors } = await open("/full?home=focus", {}, { name: "Ask Ava!", nameSub: "Aetrex Virtual Assistant" });
    const window_greet = await page.evaluate(() => window.__AI_CHAT_CONFIG.greetingCta);
    const g = await page.evaluate((lineY) => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const n = r(".ai-chat-header__name"), gr = r(".ai-chat-focus__greet .ai-chat-greet"), h = r(".ai-chat-hero"), d = r(".ai-chat-header"), c = r(".ai-chat-focus__cards"), a = r(".ai-chat-header__actions"); const sub = document.querySelector(".ai-chat-header__sub"); return { name: document.querySelector(".ai-chat-header__title--chat").textContent, nameOp: parseFloat(getComputedStyle(document.querySelector(".ai-chat-header__title--chat")).opacity), words: document.querySelector(".ai-chat-header__title--home").textContent, wordsOp: parseFloat(getComputedStyle(document.querySelector(".ai-chat-header__title--home")).opacity), subShown: !!sub && !sub.hidden && getComputedStyle(sub).display !== "none", greet: document.querySelector(".ai-chat-focus__greet .ai-chat-greet__item.is-in")?.textContent, line: eval(lineY)(), nameBottom: n.bottom, greetTop: gr.top, greetLeft: gr.left, nameLeft: n.left, heroMid: (h.top + h.bottom) / 2, heroRight: h.right, heroBottom: h.bottom, hdrBottom: d.bottom, cardsTop: c.top, actionsMid: (a.top + a.bottom) / 2, hdrH: Math.round(d.height) }; }, lineY.toString());
    check("home layout focus (two-line name): one row in the header — the greeting as its words above the line, Ask Ava! unseen, its second line kept out — the greeting CTA at the top of the home under it, the face centred on the header's line and clear of both, the controls centred on the row", g.name === "Ask Ava!" && g.nameOp === 0 && g.words === "Hi! I'm your personal shopping assistant." && g.wordsOp === 1 && !g.subShown && g.greet === window_greet && g.nameBottom <= g.line && Math.abs(g.line - g.hdrBottom) <= 2 && g.greetTop >= g.line && Math.abs(g.greetLeft - g.nameLeft) <= 1 && Math.abs(g.heroMid - g.line) <= 2 && g.nameLeft > g.heroRight + 6 && g.cardsTop > g.heroBottom + 4 && g.actionsMid < g.line && g.hdrH <= 56, JSON.stringify(g));
    const n = chatBodies.length;
    await startChat(page);
    await waitUntil(() => chatBodies.length > n);
    await page.waitForTimeout(1900);
    const c = await page.evaluate((lineY) => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const n = r(".ai-chat-header__name"), d = r(".ai-chat-header"); const sub = document.querySelector(".ai-chat-header__sub"); return { name: document.querySelector(".ai-chat-header__title--chat").textContent, nameOp: parseFloat(getComputedStyle(document.querySelector(".ai-chat-header__title--chat")).opacity), wordsOp: parseFloat(getComputedStyle(document.querySelector(".ai-chat-header__title--home")).opacity), hdrH: Math.round(d.height), line: eval(lineY)(), hdrBottom: d.bottom, nameLeft: n.left - d.left, lineOpacity: parseFloat(getComputedStyle(document.querySelector(".ai-chat-band__lit")).opacity), subShown: !!sub && !sub.hidden && getComputedStyle(sub).display !== "none", greetGone: !document.querySelector(".ai-chat-focus__greet"), chatting: document.querySelector(".ai-chat-panel").classList.contains("is-chatting"), titleMid: (() => { const t = r(".ai-chat-header__title--chat"); return (t.top + t.bottom) / 2 - d.top; })(), rowMid: (() => { const a = r(".ai-chat-header__actions"); return (a.top + a.bottom) / 2 - d.top; })(), titleBottom: r(".ai-chat-header__title--chat").bottom - d.top }; }, lineY.toString());
    check("home layout focus (two-line name): in chat the colour line runs along the header's bottom, the header still one row and the same height, Ask Ava! its words now and back at the left, the greeting gone with the home", c.chatting && c.name === "Ask Ava!" && c.nameOp === 1 && c.wordsOp === 0 && c.hdrH === g.hdrH && Math.abs(c.line - c.hdrBottom) <= 2 && c.lineOpacity >= 0.7 && c.nameLeft < 40 && !c.subShown && c.greetGone, JSON.stringify(c));
    check("home layout focus (two-line name): in chat Ask Ava! sits on the row's middle, level with the controls — not down against the line", Math.abs(c.titleMid - c.rowMid) <= 1.5 && c.hdrH - c.titleBottom >= 12, JSON.stringify({ titleMid: c.titleMid, rowMid: c.rowMid, titleBottom: c.titleBottom, hdrH: c.hdrH }));
    check("home layout focus (two-line name): no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // The header's words trade places in one motion: at home the greeting —
  // the signed-in one, with the shopper's name, for a known shopper — and,
  // once a chat starts, the name; the one leaving drifts up and fades as
  // the other rises in, the header never changing height. A new chat
  // brings the greeting back the same way.
  {
    const { ctx, page, errors } = await open("/full?home=focus&login=Ann", {}, { name: "Ask Ava!", nameSub: "Aetrex Virtual Assistant", greetingLoggedIn: "Welcome back, {name}!" });
    // One look at the two titles, as source: taken on demand, and recorded
    // on the page's own animation frames while they trade places (a frame
    // the runner delays moves the fade further, never faster).
    const wordsSrc = `() => { const q = (s) => document.querySelector(s); const op = (el) => parseFloat(getComputedStyle(el).opacity); const c = q(".ai-chat-header__title--chat"), h = q(".ai-chat-header__title--home"), d = q(".ai-chat-header"); const cr = c.getBoundingClientRect(), hr = h.getBoundingClientRect(); return { chat: c.textContent, home: h.textContent, chatOp: op(c), homeOp: op(h), chatHidden: c.getAttribute("aria-hidden"), homeHidden: h.getAttribute("aria-hidden"), chatY: cr.top, homeY: hr.top, hdrH: Math.round(d.getBoundingClientRect().height), chatting: q(".ai-chat-panel").classList.contains("is-chatting") }; }`;
    const words = () => page.evaluate(`(${wordsSrc})()`);
    const record = (untilSrc) => page.evaluate(`(() => { const look = ${wordsSrc}, until = ${untilSrc}; window.__wt = []; window.__wtDone = false; let t0 = 0; const tick = (t) => { if (!t0) t0 = t; const s = look(); s.t = t; window.__wt.push(s); if (!until(s) && t - t0 < 4000 && window.__wt.length < 400) requestAnimationFrame(tick); else window.__wtDone = true; }; requestAnimationFrame(tick); })()`);
    const recorded = async () => { await page.waitForFunction(() => window.__wtDone, null, { timeout: 10000 }); return page.evaluate(() => window.__wt); };
    // Frame to frame, neither title's opacity moves faster than the fade's ease allows (0.4s, at most 3.5× its average speed), and the fade is seen in the making.
    const smooth = (trace) => { let speed = 0, pairs = 0, mid = 0; for (let i = 1; i < trace.length; i++) { const a = trace[i - 1], b = trace[i], dt = b.t - a.t; if (dt <= 0) continue; pairs++; speed = Math.max(speed, Math.abs(b.chatOp - a.chatOp) / dt, Math.abs(b.homeOp - a.homeOp) / dt); if (b.chatOp > 0.02 && b.chatOp < 0.98) mid++; } return { speed: +speed.toFixed(5), pairs, mid }; };
    const calm = (sp) => sp.speed <= 0.011 && sp.mid >= 2 && sp.pairs >= 8;
    const at = await words();
    check("home layout focus (header words): at home the signed-in greeting, with the shopper's name, stands where the name was — the name unseen and out of the reading order", at.home === "Welcome back, Ann!" && at.homeOp === 1 && at.homeHidden === "false" && at.chat === "Ask Ava!" && at.chatOp === 0 && at.chatHidden === "true" && !at.chatting, JSON.stringify(at));
    const n0 = chatBodies.length;
    await record("(s) => s.chatting && s.chatOp >= 0.999 && s.homeOp <= 0.001");
    await startChat(page);
    const into = await recorded();
    const inEnd = into[into.length - 1], inS = smooth(into);
    // The greeting leaves upward, the name comes up from below — never the other way.
    const rise = into.every((s) => s.chatY >= inEnd.chatY - 0.5 && s.homeY <= into[0].homeY + 0.5);
    check("home layout focus (header words): once a chat starts the greeting drifts up and fades as the name rises into its place — a crossfade, nothing pops, the header the same height throughout", inEnd.chatting && inEnd.chat === "Ask Ava!" && inEnd.chatOp >= 0.999 && inEnd.homeOp <= 0.001 && inEnd.chatHidden === "false" && inEnd.homeHidden === "true" && calm(inS) && rise && into.every((s) => s.hdrH === at.hdrH), JSON.stringify({ ...inS, rise, hdrH: [...new Set(into.map((s) => s.hdrH))], end: inEnd }));
    await waitUntil(() => chatBodies.length > n0);
    await page.waitForTimeout(1200);
    await record("(s) => !s.chatting && s.homeOp >= 0.999 && s.chatOp <= 0.001");
    await page.click(".ai-chat-menu-btn");
    await page.waitForTimeout(150);
    await page.click('.ai-chat-menu-item[data-action="clear"]');
    const home = await recorded();
    const hEnd = home[home.length - 1], hS = smooth(home);
    check("home layout focus (header words): a new chat brings the greeting back the same way — the name sinks away as the greeting settles in", !hEnd.chatting && hEnd.home === "Welcome back, Ann!" && hEnd.homeOp >= 0.999 && hEnd.chatOp <= 0.001 && hEnd.homeHidden === "false" && hEnd.chatHidden === "true" && calm(hS) && home.every((s) => s.hdrH === at.hdrH), JSON.stringify({ ...hS, end: hEnd }));
    const level = await page.evaluate((lineY) => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const d = r(".ai-chat-header"), h = r(".ai-chat-header__title--home"); return { line: eval(lineY)(), homeBottom: h.bottom, hdrH: Math.round(d.height) }; }, lineY.toString());
    check("home layout focus (header words): at home a one-line greeting keeps its place just above the line (only the name in a chat is centred)", level.line - level.homeBottom >= 0 && level.line - level.homeBottom <= 8 && level.hdrH === at.hdrH, JSON.stringify(level));
    check("home layout focus (header words): no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // A one-line greeting (a signed-in shopper's): once a chat starts the chat title sits whole in the header — nothing clips its top.
  {
    const { ctx, page, errors } = await open("/full?home=focus&login=Ann", {}, { name: "Ask Ava!", nameSub: "Aetrex Virtual Assistant", greetingLoggedIn: "Hi {name}!" });
    const before = await page.evaluate(() => document.querySelector(".ai-chat-focus__greet .ai-chat-greet__item.is-in")?.textContent);
    await page.click('.ai-chat-focus__links [data-message="What deals are running right now?"]');
    await page.waitForTimeout(900);
    const t = await page.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const hdr = r(".ai-chat-header"), name = document.querySelector(".ai-chat-header__name"), el = document.querySelector(".ai-chat-header__title--chat"); const range = document.createRange(); range.selectNodeContents(el); const ink = range.getBoundingClientRect(); return { hdrTop: hdr.top, hdrH: hdr.height, inkTop: ink.top, inkBottom: ink.bottom, overflow: getComputedStyle(name).overflow, nameLines: Math.round(name.getBoundingClientRect().height / 22), words: el.textContent, chatting: document.querySelector(".ai-chat-panel").classList.contains("is-chatting") }; });
    check("home layout focus (one-line greeting): once a chat starts the chat title sits whole in the header, near its middle — its top inside the header and nothing clipping it (the one-line name box lets it lift)", t.chatting && t.words === "Ask Ava!" && t.nameLines === 1 && t.inkTop >= t.hdrTop + 2 && t.inkBottom <= t.hdrTop + t.hdrH - 2 && t.overflow === "visible" && Math.abs((t.inkTop + t.inkBottom) / 2 - (t.hdrTop + t.hdrH / 2)) <= 7, JSON.stringify({ before, t }));
    check("home layout focus (one-line greeting): no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // The seasonal button (Settings → Seasonal button) sits in the Footwear sheet too, beside Find my shoe size, in the classic tile's words and tint; a tap sends its words marked as the seasonal button.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/apps/hajirai/widget-config**", async (r) => { const res = await r.fetch(); const j = await res.json(); r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...j, seasonalCta: { on: true, label: "Fall favorites", icon: "fall", color: "fall" } }) }); });
    await page.goto("http://localhost:4789/full?home=focus&qp=1");
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(900);
    await page.click('[data-focus-sheet="footwear"]');
    await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    await page.waitForTimeout(400);
    const sea = await page.evaluate(() => { const rows = [...document.querySelectorAll(".ai-chat-focus-sheet .ai-chat-focus__helpers .ai-chat-helper")]; const s = document.querySelector(".ai-chat-focus-sheet .ai-chat-helper--season"); const tf = document.querySelector('.ai-chat-focus-sheet [data-helper="truefit"]'); const r = (el) => el.getBoundingClientRect(); return { rows: rows.map((b) => b.querySelector(".ai-chat-helper__title").textContent), last: rows[rows.length - 1] === s, title: s?.querySelector(".ai-chat-helper__title").textContent, sub: s?.querySelector(".ai-chat-helper__sub").textContent, icon: !!s?.querySelector(".ai-chat-helper__icon .ai-sea-ic--fall"), tinted: s ? getComputedStyle(s.querySelector(".ai-chat-helper__icon")).backgroundImage !== "none" : false, seasonal: s?.getAttribute("data-seasonal") === "1", message: s?.getAttribute("data-message"), beside: !!tf && !!s && Math.abs(r(tf).top - r(s).top) < 1 && r(s).left > r(tf).right, noArrow: s ? getComputedStyle(s.querySelector(".ai-chat-helper__go")).display === "none" : false }; });
    check("footwear sheet (seasonal button on): its row beside Find my shoe size — the button's words, the season's icon on its tint, no arrow when two rows share the line", sea.title === "Fall favorites" && sea.sub === "This season’s picks" && sea.icon && sea.tinted && sea.seasonal && sea.message === "Fall favorites" && sea.last && (!sea.rows.includes("Find my shoe size") || (sea.beside && sea.noArrow)), JSON.stringify(sea));
    const n = chatBodies.length;
    await page.click(".ai-chat-focus-sheet .ai-chat-helper--season");
    await waitUntil(() => chatBodies.length > n);
    const sent = chatBodies.at(-1);
    check("footwear sheet (seasonal button on): a tap closes the sheet and sends its words, marked as the seasonal button (the chat shows its collection)", sent?.message === "Fall favorites" && sent?.seasonal === true && sent?.typed === false && !(await state(page)).sheet, JSON.stringify({ sent, s: await state(page) }));
    check("footwear sheet (seasonal button on): no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // The Foot pain sheet's other paths: footwear (the kind, the width), "show me both", Men's, and reopened.
  {
    const { ctx, page, errors } = await open("/full?home=focus&qp=1");
    const openPain = async () => { await page.click('[data-focus-sheet="pain"]'); await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 }); await page.waitForTimeout(400); };
    const tap = async (sel) => { await page.click(sel); await page.waitForTimeout(500); };
    const newChat = async () => { await page.waitForTimeout(1500); await page.click(".ai-chat-menu-btn"); await page.waitForTimeout(150); await page.click('.ai-chat-menu-item[data-action="clear"]'); await page.waitForTimeout(1200); };
    const titles = () => page.evaluate(() => document.querySelector(".ai-chat-focus__q-title")?.textContent + " / " + [...document.querySelectorAll("[data-pain-opt]")].map((b) => b.querySelector(".ai-chat-focus__opt-title").textContent).join("|"));
    const rows = () => page.evaluate(() => [...document.querySelectorAll(".ai-chat-focus__sum-row")].map((r) => r.querySelector(".ai-chat-focus__sum-k").textContent + ": " + r.querySelector(".ai-chat-focus__sum-v").textContent).join(" | "));
    let n = chatBodies.length;
    await openPain();
    await tap('[data-pain-opt="heel"]'); await tap('[data-pain-nav="next"]'); await tap('[data-pain-opt="footwear"]');
    const k1 = await titles();
    await tap('[data-pain-opt="sneakers"]');
    const k2 = await titles();
    await tap('[data-pain-opt="wide"]');
    const k3 = await rows();
    check("foot pain sheet (footwear): the kind of shoe from the women's menu, then the width, then the summary", k1 === "What kind of shoes? / Sneakers|Sandals|Loafers & oxfords|Slip-ons|Mary Janes|Boots|Slippers|Clogs|Wedges & heels|Any kind" && k2 === "How should they fit? / Regular width|Wide|Narrow|Not sure" && k3 === "Where it hurts: Heel | Looking for: Footwear | Kind: Sneakers | Fit: Wide", JSON.stringify({ k1, k2, k3 }));
    await page.click('[data-pain-nav="ask"]');
    await waitUntil(() => chatBodies.length > n);
    check("foot pain sheet (footwear): the message names the line, the kind, the pain and the width", chatBodies.at(-1)?.message === "I’m looking for women’s sneakers for heel pain (plantar fasciitis), in a wide width. What would you recommend?", chatBodies.at(-1)?.message);
    await newChat();
    // Reopened, the answers are still there: Continue runs straight to the summary.
    n = chatBodies.length;
    await openPain();
    const kept = await page.evaluate(() => [...document.querySelectorAll("[data-pain-opt].is-on")].map((b) => b.getAttribute("data-pain-opt")).join("|"));
    await tap('[data-pain-nav="next"]');
    const sum2 = await page.evaluate(() => document.querySelector(".ai-chat-focus__q-title")?.textContent);
    check("foot pain sheet: reopened, the picks are kept and Continue goes straight to the summary", kept === "heel" && sum2 === "Here’s what I’ll tell Ava", JSON.stringify({ kept, sum2 }));
    // Men's, and "show me both": the switch in the head; Not sure skips the detail steps.
    await tap('[data-pain-edit="what"]');
    await tap('[data-gender="men"]');
    await tap('[data-pain-opt="both"]');
    const b1 = await page.evaluate(() => ({ title: document.querySelector(".ai-chat-focus__q-title")?.textContent, rows: [...document.querySelectorAll(".ai-chat-focus__sum-row")].map((r) => r.querySelector(".ai-chat-focus__sum-v").textContent).join("|"), who: document.querySelector(".ai-chat-focus__picks")?.textContent }));
    await page.click('[data-pain-nav="ask"]');
    await waitUntil(() => chatBodies.length > n);
    check("foot pain sheet (both, men's): Not sure skips the detail steps — the summary, then a message that leaves the choice to Ava for the men's line", b1.title === "Here’s what I’ll tell Ava" && b1.rows === "Heel|Footwear or orthotics" && /Men’s/.test(b1.who) && chatBodies.at(-1)?.message === "I have heel pain (plantar fasciitis). I’m open to men’s footwear or orthotics — what would help most?", JSON.stringify({ b1, msg: chatBodies.at(-1)?.message }));
    await newChat();
    // Men's footwear: the kinds are the men's menu, and the message says men's.
    n = chatBodies.length;
    await openPain();
    await tap('[data-pain-nav="next"]');
    await tap('[data-pain-edit="what"]');
    await tap('[data-pain-opt="footwear"]');
    const m1 = await titles();
    await tap('[data-pain-opt="clogs"]');
    await tap('[data-pain-opt="regular"]');
    const m2 = await rows();
    await page.click('[data-pain-nav="ask"]');
    await waitUntil(() => chatBodies.length > n);
    check("foot pain sheet (men's footwear): the kinds are the men's menu, the summary follows, and the message says men's", m1 === "What kind of shoes? / Sneakers|Sandals|Clogs|Any kind" && m2 === "Where it hurts: Heel | Looking for: Footwear | Kind: Clogs | Fit: Regular width" && chatBodies.at(-1)?.message === "I’m looking for men’s clogs for heel pain (plantar fasciitis). What would you recommend?", JSON.stringify({ m1, m2, msg: chatBodies.at(-1)?.message }));
    await newChat();
    // Back walks the path the other way; Escape closes the sheet.
    await openPain();
    await tap('[data-pain-nav="next"]');
    await tap('[data-pain-nav="back"]');
    const bk = await page.evaluate(() => document.querySelector(".ai-chat-focus__q-title")?.textContent);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    check("foot pain sheet: Back walks the path the other way, Escape closes the sheet", bk === "Where does it hurt?" && !(await state(page)).sheet && (await state(page)).home, JSON.stringify({ bk }));
    check("foot pain sheet: no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // The store's survey (Settings → Feedback button) in the Focus layout:
  // nothing of it on the home — it is the ⋮ menu's feedback line, opened
  // inside the chat. The "which orthotic do I have?" quiz (its own setting)
  // is a row in the Orthotics sheet, once — a Popular button or a survey
  // setting holding the same form folds into it. The classic home and menu
  // are as they were.
  const tfRoute = (page) => page.route("https://embed.typeform.com/**", (r) => r.fulfill({ status: 200, contentType: r.request().url().endsWith(".css") ? "text/css" : "application/javascript", body: r.request().url().endsWith(".css") ? "" : TF_STUB }));
  const menuOf = async (page) => { await page.click(".ai-chat-menu-btn"); await page.waitForTimeout(150); return page.$$eval(".ai-chat-menu-item", (b) => b.map((x) => x.textContent.trim() + "/" + x.dataset.action)); };
  const helperRows = (page) => page.$$eval(".ai-chat-focus-sheet .ai-chat-helper", (r) => r.map((x) => ({ title: x.querySelector(".ai-chat-helper__title").textContent, sub: x.querySelector(".ai-chat-helper__sub")?.textContent, form: x.getAttribute("data-form"), survey: x.hasAttribute("data-survey"), icon: !!x.querySelector(".ai-chat-helper__icon svg") })));
  {
    const { ctx, page, errors } = await open("/full?home=focus&fb=1&wo=1&qp=1", {}, { name: "Ask Ava!" });
    await tfRoute(page);
    await page.waitForTimeout(500);
    const home = await page.evaluate(() => ({ pill: !!document.querySelector(".ai-chat-focus__fb"), onHome: !!document.querySelector(".ai-chat-welcome--focus [data-feedback], .ai-chat-welcome--focus [data-survey], .ai-chat-welcome--focus [data-form]"), tiles: document.querySelectorAll(".ai-chat-welcome__cta-btn").length }));
    check("home layout focus (survey): nothing of the survey or the quiz on the home", !home.pill && !home.onHome && home.tiles === 0, JSON.stringify(home));
    const menu = await menuOf(page);
    check("home layout focus (survey): the ⋮ menu offers the store's survey under Start a new chat — its one feedback line, no separate form", menu[0] === "Start a new chat/clear" && menu[1] === "Share feedback/survey" && menu.filter((m) => /feedback|survey/i.test(m)).length === 1, menu.join(" | "));
    await page.click('.ai-chat-menu-item[data-action="survey"]');
    await page.waitForTimeout(800);
    const viaMenu = await page.evaluate(() => { const s = document.querySelector(".ai-chat-fbsheet"); return { open: !!s && s.classList.contains("is-open"), form: window.__tf && window.__tf.id, kind: s && s.getAttribute("data-kind"), menuShut: document.querySelector(".ai-chat-menu").style.display === "none", noRate: !document.querySelector(".ai-chat-rate") }; });
    check("home layout focus (survey): the menu line opens the store's own Typeform survey inside the chat", viaMenu.open && viaMenu.form === "jdXBrXMa" && viaMenu.menuShut && viaMenu.noRate, JSON.stringify(viaMenu));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    await page.click('[data-focus-sheet="orthotics"]');
    await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    const rows = await helperRows(page);
    const quiz = rows.filter((r) => /identify my orthotic/i.test(r.title));
    check("home layout focus (survey): the quiz from its own setting is one row in the Orthotics sheet — the Popular button with the same form folded in — and the survey is not there", quiz.length === 1 && quiz[0].form === "ojyWbTvZ" && !quiz[0].survey && quiz[0].icon && /quiz/.test(quiz[0].sub || "") && !rows.some((r) => r.survey) && !rows.some((r) => /share feedback/i.test(r.title)), JSON.stringify(rows));
    // The two helper rows share one line where the sheet is wide enough, each whole.
    const line = await page.evaluate(() => { const r = [...document.querySelectorAll(".ai-chat-focus-sheet .ai-chat-helper")].map((e) => e.getBoundingClientRect()); const t = [...document.querySelectorAll(".ai-chat-focus-sheet .ai-chat-helper__title, .ai-chat-focus-sheet .ai-chat-helper__sub")]; return { n: r.length, tops: [...new Set(r.map((x) => Math.round(x.top)))].length, whole: t.every((e) => e.scrollWidth <= e.clientWidth + 1), sideBySide: r.length === 2 && r[1].left > r[0].right }; });
    check("home layout focus (survey): on a wide sheet the FIT and quiz rows sit on one line, their words whole", line.n === 2 && line.tops === 1 && line.sideBySide && line.whole, JSON.stringify(line));
    await page.click('.ai-chat-focus-sheet [data-form="ojyWbTvZ"]');
    await page.waitForTimeout(800);
    const opened = await page.evaluate(() => { const s = document.querySelector(".ai-chat-fbsheet"); return { open: !!s && s.classList.contains("is-open"), form: window.__tf && window.__tf.id, sheetGone: !document.querySelector(".ai-chat-focus-sheet") }; });
    check("home layout focus (survey): the quiz row opens the quiz inside the chat, the Orthotics sheet away", opened.open && opened.form === "ojyWbTvZ" && opened.sheetGone, JSON.stringify(opened));
    check("home layout focus (survey): no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
    const ph = await open("/full?home=focus&wo=1", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, { name: "Ask Ava!" });
    await ph.page.click('[data-focus-sheet="orthotics"]');
    await ph.page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    const stack = await ph.page.evaluate(() => { const r = [...document.querySelectorAll(".ai-chat-focus-sheet .ai-chat-helper")].map((e) => e.getBoundingClientRect()); return { n: r.length, stacked: r.length === 2 && r[1].top >= r[0].bottom && Math.abs(r[0].left - r[1].left) < 1, maxRight: Math.max(...r.map((x) => x.right)), vw: innerWidth }; });
    check("home layout focus (survey, phone): the two rows sit side by side, within the sheet", stack.n === 2 && !stack.stacked && stack.maxRight <= stack.vw, JSON.stringify(stack));
    // Pick & go on a phone: the keys read "ACTIVITY choose one" / "FOR one or more" on one line; the Ask box is stuck at the foot; a pick in the first row brings the second into view (smoothly, clear of the bar); the picks make the sentence; Ask sends it.
    const pm = () => ph.page.evaluate(() => { const s = document.querySelector(".ai-chat-focus-sheet"); const body = s.querySelector(".ai-chat-focus-sheet__body"); const bar = s.querySelector(".ai-chat-focus__ask"); const box = bar.querySelector(".ai-chat-focus__ask-box").getBoundingClientRect(); const b = body.getBoundingClientRect(); const r1 = s.querySelectorAll(".ai-chat-focus__pick-row")[1].getBoundingClientRect(); const k = s.querySelector(".ai-chat-focus__pick-key"); const kb = k.querySelector("b").getBoundingClientRect(), ks = k.querySelector("small").getBoundingClientRect(); return { scrollTop: body.scrollTop, scrollable: body.scrollHeight > body.clientHeight + 1, boxAtFoot: box.bottom <= b.bottom + 1 && box.bottom >= b.bottom - 40, row2Clear: r1.top >= b.top - 1 && r1.bottom <= box.top - 4, row2Hidden: r1.bottom > box.top, keyInline: Math.abs(kb.top - ks.top) < 6 && ks.left > kb.right, hints: [...s.querySelectorAll(".ai-chat-focus__pick-key small")].map((x) => x.textContent).join("|"), q: s.querySelector("[data-pick-q]").value, pressed: s.querySelectorAll('[aria-pressed="true"]').length }; });
    // Pick & go comes after the Collections: bring the card up first.
    await ph.page.evaluate(() => document.querySelector(".ai-chat-focus-sheet .ai-chat-focus__pick").scrollIntoView({ block: "start" }));
    await ph.page.waitForTimeout(150);
    const pm0 = await pm();
    await ph.page.click('.ai-chat-focus-sheet [data-pick-a="0"]');
    const scrolled = await (async () => { let last = -1; for (let i = 0; i < 30; i++) { await ph.page.waitForTimeout(100); const t = await ph.page.evaluate(() => document.querySelector(".ai-chat-focus-sheet__body").scrollTop); if (t === last) return t; last = t; } return last; })();
    const pm1 = await pm();
    await ph.page.click('.ai-chat-focus-sheet [data-pick-b="0"]');
    await ph.page.click('.ai-chat-focus-sheet [data-pick-b="2"]');
    const pm2 = await pm();
    check("home layout focus (phone): Pick & go — the keys read on one line with their hint (choose one · one or more); the Ask box is stuck at the foot; Casual everyday brings the For row into view clear of the bar (the sheet scrolled for it), then Plantar fasciitis + Flat feet make the sentence", pm0.keyInline && pm0.hints === "choose one|one or more" && pm0.boxAtFoot && pm0.q === "" && pm1.row2Clear && pm1.boxAtFoot && (!pm0.row2Hidden || scrolled > pm0.scrollTop) && pm1.q === "Show me women’s orthotics for casual everyday wear" && pm2.q === "Show me women’s orthotics for casual everyday wear with plantar fasciitis and flat feet" && pm2.pressed === 3 && pm2.boxAtFoot, JSON.stringify({ pm0, scrolled, pm1, pm2 }));
    const nPh = chatBodies.length;
    await ph.page.click('.ai-chat-focus-sheet [data-pick-go]');
    await waitUntil(() => chatBodies.length > nPh);
    check("home layout focus (phone): Ask sends the sentence, the sheet gone", chatBodies.at(-1)?.message === "Show me women’s orthotics for casual everyday wear with plantar fasciitis and flat feet" && !(await ph.page.$(".ai-chat-focus-sheet")), JSON.stringify(chatBodies.at(-1)?.message));
    check("home layout focus (survey, phone): no JS errors", ph.errors.length === 0, ph.errors.join(" | "));
    await ph.ctx.close();
  }
  {
    // The survey setting holding the quiz (as it may today): the quiz in the sheet, once, and no feedback line.
    const { ctx, page, errors } = await open("/full?home=focus&qp=1&fb=1&fblook=1", {}, { name: "Ask Ava!" });
    await tfRoute(page);
    await page.waitForTimeout(500);
    const menu = await menuOf(page);
    check("home layout focus (quiz as survey): the ⋮ menu offers no quiz and no separate feedback form", !menu.some((m) => /identify my orthotic|feedback|survey/i.test(m)), menu.join(" | "));
    await page.click(".ai-chat-menu-btn");
    await page.waitForTimeout(150);
    await page.click('[data-focus-sheet="orthotics"]');
    await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    const rows = await helperRows(page);
    const quiz = rows.filter((r) => /identify my orthotic/i.test(r.title));
    check("home layout focus (quiz as survey): one row in the Orthotics sheet with the setting's label and icon, the Popular button folded in", quiz.length === 1 && quiz[0].survey && quiz[0].title === "Identify My Orthotic" && quiz[0].icon && !rows.some((r) => r.form === "ojyWbTvZ"), JSON.stringify(rows));
    await page.click(".ai-chat-focus-sheet [data-survey]");
    await page.waitForTimeout(800);
    const opened = await page.evaluate(() => { const s = document.querySelector(".ai-chat-fbsheet"); return { open: !!s && s.classList.contains("is-open"), form: window.__tf && window.__tf.id }; });
    check("home layout focus (quiz as survey): the row opens the quiz inside the chat", opened.open && opened.form === "ojyWbTvZ", JSON.stringify(opened));
    check("home layout focus (quiz as survey): no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  {
    // No survey: no feedback line; the classic home keeps its button and its menu is as it was.
    const { ctx, page, errors } = await open("/full?home=focus", {}, { name: "Ask Ava!" });
    const menu = await menuOf(page);
    await page.click(".ai-chat-menu-btn");
    const p2 = await ctx.newPage();
    await p2.goto("http://localhost:4789/full?fb=1");
    await p2.click(".ai-chat-launcher");
    await p2.waitForTimeout(700);
    const classic = await p2.evaluate(() => ({ tile: !!document.querySelector(".ai-chat-welcome__cta-btn.is-feedback") }));
    const classicMenu = await menuOf(p2);
    check("home layout focus (no survey): no feedback line in the ⋮ menu; the classic home keeps its survey button and its menu is as it was", !menu.some((m) => /feedback|survey/i.test(m)) && classic.tile && !classicMenu.some((m) => /\/(feedback|survey)$/.test(m)), JSON.stringify({ menu, classic, classicMenu }));
    check("home layout focus (no survey): no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // The greeting belongs to the page, not the header: on a short screen it
  // scrolls away under the header, which keeps its one row, its line and
  // the face on it.
  {
    const { ctx, page, errors } = await open("/full?home=focus", { viewport: { width: 390, height: 440 }, isMobile: true, hasTouch: true }, { name: "Ask Ava!", nameSub: "Aetrex Virtual Assistant" });
    const sc = await page.evaluate(async (lineY) => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const m = document.querySelector(".ai-chat-messages"); const before = { greetTop: r(".ai-chat-focus__greet .ai-chat-greet").top, hdrBottom: r(".ai-chat-header").bottom, room: m.scrollHeight - m.clientHeight }; m.scrollTop = 80; await new Promise((res) => setTimeout(res, 250)); if (m.scrollTop < 60) { /* a late settings redraw of the home put it back to the top: once more */ await new Promise((res) => setTimeout(res, 600)); m.scrollTop = 80; await new Promise((res) => setTimeout(res, 250)); } const h = r(".ai-chat-hero"); return { before, scrollTop: m.scrollTop, greetBottom: r(".ai-chat-focus__greet .ai-chat-greet").bottom, hdrBottom: r(".ai-chat-header").bottom, line: eval(lineY)(), heroMid: (h.top + h.bottom) / 2, hdrH: Math.round(r(".ai-chat-header").height) }; }, lineY.toString());
    check("home layout focus (scrolled): the greeting scrolls away under the header — not pinned, no second row left behind — while the header keeps its one row, its line and the face on it", sc.before.room >= 80 && sc.scrollTop >= 60 && sc.greetBottom <= sc.hdrBottom + 1 && sc.hdrBottom === sc.before.hdrBottom && Math.abs(sc.line - sc.hdrBottom) <= 2 && Math.abs(sc.heroMid - sc.line) <= 2 && sc.hdrH <= 56, JSON.stringify(sc));
    check("home layout focus (scrolled): no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // Phone: the chips wrap into a few rows, cards stacked, the sheet within the screen.
  {
    const { ctx, page, errors } = await open("/full?home=focus", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const words = () => page.evaluate(() => { const h = document.querySelector(".ai-chat-header__title--home"), pill = document.querySelector(".ai-chat-header__login-pill"); return { words: h.textContent, whole: h.scrollHeight <= h.clientHeight + 1, lines: Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight)), size: parseFloat(getComputedStyle(h).fontSize), pill: pill ? getComputedStyle(pill).display !== "none" : null, chatting: document.querySelector(".ai-chat-panel").classList.contains("is-chatting") }; });
    const pw = await words();
    check("home layout focus (phone): the greeting is the header's words, whole on two lines — the Log in pill steps out of its way at home (the menu has Log in)", pw.words === "Hi! I'm your personal shopping assistant." && pw.whole && pw.lines <= 2 && pw.size <= 14 && pw.pill === false && !pw.chatting, JSON.stringify(pw));
    const crisp = await page.evaluate(() => { const r = document.querySelector(".ai-chat-band__ring"), i = document.querySelector(".ai-chat-input"); const uses = [...document.querySelectorAll(".ai-chat-band use")]; return { soft: uses.length === 8 && uses.every((u) => { const cs = getComputedStyle(u), w = parseFloat(cs.strokeWidth), o = parseFloat(cs.opacity); return cs.filter === "none" && ((w <= 1.5 && o === 1) || (w > 1.5 && o <= 0.1)); }), widths: [...document.querySelectorAll(".ai-chat-band__ring use")].map((u) => parseFloat(getComputedStyle(u).strokeWidth)), ring: getComputedStyle(r).display, ringOp: parseFloat(getComputedStyle(r).opacity), hintWrap: getComputedStyle(i, "::placeholder").whiteSpace }; });
    check("home layout focus (phone): the band is a solid hairline with a thin faint fade drawn in layers, no blur filter anywhere (Safari smears one); the text box's hint keeps to one line", crisp.soft && crisp.widths.join(",") === "10,6,3,1.2" && crisp.ring !== "none" && crisp.ringOp > 0.5 && crisp.hintWrap === "nowrap", JSON.stringify(crisp));
    const ph = await page.evaluate(() => { const els = [...document.querySelectorAll("[data-focus-sheet]")]; const c = els.map((e) => e.getBoundingClientRect()); const sub = (k) => document.querySelector(`[data-focus-sheet="${k}"] .ai-chat-focus__card-sub`); const pics = els.every((e) => { const cr = e.getBoundingClientRect(), p = e.querySelector(".ai-chat-focus__card-ico").getBoundingClientRect(); return Math.abs(p.right - cr.right) < 1 && Math.abs(p.height - cr.height) < 1 && p.width >= 50; }); const ctas = els.every((e) => { const t = e.querySelector(".ai-chat-focus__card-cta > span"); const r = t.getBoundingClientRect(), cr = e.getBoundingClientRect(); return r.height >= 24 && r.right <= cr.right && r.bottom <= cr.bottom; }); return { cards: c.length, painWide: c[0].width >= innerWidth - 40, pair: Math.abs(c[1].top - c[2].top) < 1 && c[2].left > c[1].right && c[1].top >= c[0].bottom + 6, maxRight: Math.max(...c.map((r) => r.right)), sw: document.documentElement.scrollWidth, vw: innerWidth, cardH: Math.min(...c.map((r) => r.height)), subsPhone: ["footwear", "orthotics"].every((k) => getComputedStyle(sub(k)).display === "none") && getComputedStyle(sub("pain")).display !== "none", fits: ["pain", "footwear", "orthotics"].every((k) => sub(k).scrollHeight <= sub(k).clientHeight + 1 && sub(k).scrollWidth <= sub(k).clientWidth + 1), pics, ctas }; });
    check("home layout focus (phone): Foot pain across the top, the two line cards side by side under it, each picture filling its card's right side, the two line cards without their grey line (name and button only), every line whole and every call to action within its card, nothing off-screen, tall enough to tap", ph.cards === 3 && ph.painWide && ph.pair && ph.maxRight <= ph.vw && ph.sw <= ph.vw && ph.cardH >= 56 && ph.fits && ph.subsPhone && ph.pics && ph.ctas, JSON.stringify(ph));
    // The Foot pain sheet on a phone: two columns of tiles within the screen, Continue in reach.
    await page.click('[data-focus-sheet="pain"]');
    await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    await page.waitForTimeout(450);
    const pq = await page.evaluate(() => { const t = [...document.querySelectorAll("[data-pain-opt]")].map((e) => e.getBoundingClientRect()); const p = document.querySelector(".ai-chat-focus-sheet__panel").getBoundingClientRect(); const nx = document.querySelector('[data-pain-nav="next"]').getBoundingClientRect(); return { cols: new Set(t.map((r) => Math.round(r.left))).size, maxRight: Math.max(...t.map((r) => r.right)), vw: innerWidth, tileH: Math.min(...t.map((r) => r.height)), bottom: p.bottom, vh: innerHeight, nextIn: nx.bottom <= p.bottom && nx.height >= 40 }; });
    check("home layout focus (phone): the Foot pain tiles with their pictures sit one under the other, full width, within the screen, tall enough to tap, Continue within the sheet (its bar stays in view)", pq.cols === 1 && pq.maxRight <= pq.vw && pq.tileH >= 52 && pq.bottom <= pq.vh + 1 && pq.nextIn, JSON.stringify(pq));
    await page.click(".ai-chat-focus-sheet__close");
    await page.waitForTimeout(350);
    await page.click('[data-focus-sheet="footwear"]');
    await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    await page.waitForTimeout(450);/* it slides in */
    const sh = await page.evaluate(() => { const r = document.querySelector(".ai-chat-focus-sheet__panel").getBoundingClientRect(); return { w: r.width, vw: innerWidth, bottom: r.bottom, vh: innerHeight }; });
    check("home layout focus (phone): the sheet fits the screen", sh.w <= sh.vw && sh.bottom <= sh.vh + 1, JSON.stringify(sh));
    const phBar = await page.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const head = r(".ai-chat-focus-sheet__head"), title = r(".ai-chat-focus-sheet__title"), close = r(".ai-chat-focus-sheet__close"), sw = r(".ai-chat-focus__gender"); return { closeBeside: Math.abs((close.top + close.bottom) / 2 - (title.top + title.bottom) / 2) <= 14 && close.left > title.right, switchUnder: sw.top >= Math.max(title.bottom, close.bottom) - 1 && sw.bottom <= head.bottom, wide: sw.width >= head.width - 40 }; });
    check("home layout focus (phone): in the sheet's title bar the close button sits beside the words and the Women's / Men's switch takes its own full-width line under them", phBar.closeBeside && phBar.switchUnder && phBar.wide, JSON.stringify(phBar));
    // A swipe down from the sheet's head pulls it along and closes it.
    const cdp = await ctx.newCDPSession(page);
    const head = await page.evaluate(() => { const r = document.querySelector(".ai-chat-focus-sheet__head").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: head.x, y: head.y }] });
    let pulled = 0;
    for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: head.x, y: head.y + i * 18 }] }); await page.waitForTimeout(20); const m = await page.evaluate(() => getComputedStyle(document.querySelector(".ai-chat-focus-sheet__panel")).transform); const ty = /matrix\(([^)]+)\)/.exec(m); if (ty) pulled = Math.max(pulled, parseFloat(ty[1].split(",")[5])); }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(450);
    const swiped = await page.evaluate(() => ({ sheet: !!document.querySelector(".ai-chat-focus-sheet"), home: document.querySelector(".ai-chat-panel").classList.contains("is-home") }));
    check("home layout focus (phone): a swipe down follows the finger and closes the sheet", pulled >= 60 && !swiped.sheet && swiped.home, JSON.stringify({ pulled, swiped }));
    check("home layout focus (phone): no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // Home → chat, frame by frame: the ring fades out with the face while the
  // line lights up from the left — its light travelling to the far end with
  // a long soft tail, one way only, no leap. Back home is the mirror: the
  // light withdraws, the face comes in and its ring fades up around it.
  {
    const { ctx, page, errors } = await open("/full?home=focus", {}, { name: "Ask Ava!", nameSub: "Aetrex Virtual Assistant" });
    // One look at the band, as source: the test takes one on demand, and a
    // sampler on the page records one every animation frame.
    const lookSrc = `() => {
      const q = (s) => document.querySelector(s); const op = (el) => parseFloat(getComputedStyle(el).opacity);
      const panel = q(".ai-chat-panel"), ring = q(".ai-chat-band__ring"), line = q(".ai-chat-band__line"), sweep = q("#ai-chat-band-s"), grad = q("#ai-chat-band-g"), photo = q(".ai-chat-hero__photo"), hero = q(".ai-chat-hero"), hdr = q(".ai-chat-header"), lit = q(".ai-chat-band__lit");
      const lb = line.getBBox(), rb = ring.getBBox(), W = hdr.clientWidth, gone = hero.classList.contains("is-gone");
      const x1 = parseFloat(sweep.getAttribute("x1")), x2 = parseFloat(sweep.getAttribute("x2")), tail = x2 - x1;
      return { t: performance.now(), W, ringOp: op(ring), ringW: rb.width, ringH: rb.height, lineW: lb.width, lineH: lb.height, lineLeft: lb.x, lineRight: W - (lb.x + lb.width), head: x2, tail, lit: Math.min(1, Math.max(0, (x2 + 3) / (W + 6 + tail))), photoOp: gone ? 0 : op(photo), chatting: panel.classList.contains("is-chatting"), gone, grad: grad.getAttribute("x1"), masked: !!lit && lit.getAttribute("mask") === "url(#ai-chat-band-m)" && lit.contains(line) };
    }`;
    const look = () => page.evaluate(`(${lookSrc})()`);
    // Once a transition is under way, a sampler registered behind it records
    // the band every animation frame for three seconds; the steps are read
    // from those frames filled in at 10ms, so a short moment is found even
    // when the renderer is slow. Frame to frame the light's head, the ring's
    // and the face's opacity may move no faster than the eases allow (a frame
    // the runner delays moves the time-based state further, never faster).
    const record = async () => {
      await page.evaluate(`(() => { const look = ${lookSrc}; window.__tr = []; window.__trDone = false; let t0 = 0; const tick = (t) => { if (!t0) t0 = t; const s = look(); s.t = t; window.__tr.push(s); if (t - t0 < 3000 && window.__tr.length < 400) requestAnimationFrame(tick); else window.__trDone = true; }; requestAnimationFrame(tick); })()`);
      await page.waitForFunction(() => window.__trDone, null, { timeout: 10000 });
      return page.evaluate(() => window.__tr);
    };
    const dense = (tr) => { const out = []; const keys = ["ringOp", "head", "tail", "lit", "photoOp", "W"]; for (let i = 1; i < tr.length; i++) { const a = tr[i - 1], b = tr[i]; const steps = Math.max(1, Math.round((b.t - a.t) / 10)); for (let k = 0; k < steps; k++) { const u = k / steps; const st = { ...a }; for (const key of keys) st[key] = a[key] + (b[key] - a[key]) * u; st.chatting = u < 0.5 ? a.chatting : b.chatting; st.gone = u < 0.5 ? a.gone : b.gone; out.push(st); } } if (tr.length) out.push(tr[tr.length - 1]); return out; };
    const speeds = (tr) => { let head = 0, ring = 0, face = 0, n = 0, maxDt = 0; for (let i = 1; i < tr.length; i++) { const dt = tr[i].t - tr[i - 1].t; if (dt <= 0) continue; n++; maxDt = Math.max(maxDt, dt); head = Math.max(head, Math.abs(tr[i].head - tr[i - 1].head) / dt); ring = Math.max(ring, Math.abs(tr[i].ringOp - tr[i - 1].ringOp) / dt); face = Math.max(face, Math.abs(tr[i].photoOp - tr[i - 1].photoOp) / dt); } return { n, maxDt: Math.round(maxDt), head: +head.toFixed(3), ring: +ring.toFixed(4), face: +face.toFixed(4) }; };
    // The eases' peak speeds, with room: the light's head crosses the header and its tail (~1.6 headers) in 1200ms, the ring fades in 340ms, the face in 300ms — each at most ~3.5× its average.
    const calm = (sp, min) => sp.n >= min && sp.head <= 3.2 && sp.ring <= 0.011 && sp.face <= 0.012;
    const oneWay = (arr, sign) => arr.every((v, i) => i === 0 || sign * (v - arr[i - 1]) >= -0.5);
    const n = chatBodies.length;
    await startChat(page);
    const tr = await record();
    const seen = { fading: null, lighting: null, half: null, full: null };
    for (const st of dense(tr)) {
      if (!seen.fading && st.ringOp > 0.2 && st.ringOp < 0.8 && st.lit < 0.35) seen.fading = st;
      if (!seen.lighting && st.lit > 0.05 && st.lit < 0.5 && st.head > 0 && st.head < st.W * 0.6 && st.tail >= st.W * 0.4) seen.lighting = st;
      if (!seen.half && st.lit >= 0.45 && st.lit <= 0.8 && st.ringOp <= 0.05 && st.photoOp <= 0.05) seen.half = st;
      if (st.chatting && st.lit >= 0.999 && st.gone) { seen.full = st; break; }
    }
    check("light 1: the ring fades out with the face as the line's light sets off from the left", !!seen.fading && seen.fading.head <= seen.fading.W * 0.5, JSON.stringify(seen.fading));
    check("light 2: the light travels across with a long soft tail (about half the header long), its head moving one way only", !!seen.lighting && oneWay(tr.map((s) => s.head), 1), JSON.stringify(seen.lighting));
    check("light 3: the ring and the face are gone while the light is still on its way", !!seen.half, JSON.stringify(seen.half));
    const sp = speeds(tr);
    check("light: one continuous motion — the head's speed, the ring's and the face's fades within the eases (no leap, no pop)", calm(sp, 30), JSON.stringify(sp));
    await waitUntil(() => chatBodies.length > n);
    const fin = await look();
    check("light 4: it ends lit edge to edge — the mask past the line's end, the line itself edge to edge, the ring out — in chat, the face gone", !!seen.full && fin.lit >= 0.999 && fin.lineH === 0 && fin.lineLeft <= 0 && fin.lineRight <= 0 && fin.ringOp === 0 && fin.chatting && fin.gone && fin.masked, JSON.stringify({ full: seen.full, fin }));
    const done = await state(page);
    check("light: ends in chat — the line on, the face gone, no welcome", done.chatting && done.heroGone && !done.home && !done.focusHome, JSON.stringify(done));
    const g0 = (await look()).grad; await page.waitForTimeout(350); const g1 = (await look()).grad;
    check("light: once settled, the line's colours keep sliding", g0 !== g1, JSON.stringify({ g0, g1 }));
    // Back home.
    await page.waitForTimeout(600);
    await page.click(".ai-chat-menu-btn");
    await page.waitForTimeout(150);
    await page.click('.ai-chat-menu-item[data-action="clear"]');
    const btr = await record();
    const back = { withdrawing: null, faceComing: null, ringUp: null };
    for (const st of dense(btr)) {
      if (!back.withdrawing && st.lit < 0.9 && st.lit > 0.3 && !st.chatting) back.withdrawing = st;
      if (!back.faceComing && !st.gone && st.photoOp > 0.2 && st.photoOp < 0.9 && st.lit < 0.7) back.faceComing = st;
      if (!back.ringUp && st.ringOp > 0.2 && st.ringOp < 0.9 && st.lit < 0.5) back.ringUp = st;
      if (st.ringOp >= 0.999 && st.lit <= 0.001 && st.photoOp >= 0.98) break;
    }
    check("light back 1: the light withdraws toward the left the same way, the name back to the greeting", !!back.withdrawing && oneWay(btr.map((s) => s.head), -1), JSON.stringify(back.withdrawing));
    check("light back 2: as it goes, the face eases in and its ring fades up around it", !!back.faceComing && !!back.ringUp, JSON.stringify(back));
    const bsp = speeds(btr);
    check("light back: one continuous motion — nothing leaps, nothing pops, frame to frame", calm(bsp, 30), JSON.stringify(bsp));
    const b2 = await state(page);
    const end = await look();
    check("light back: ends at home — the face in its round ring, the line dark", b2.home && !b2.chatting && b2.hero && end.ringH >= 60 && end.ringW >= 60 && end.ringOp === 1 && end.lit <= 0.001, JSON.stringify({ b2, end }));
    check("light: no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // The theme's banner right under the greeting (as the classic home shows
  // it), and the greeting sliding through its languages at the top of the
  // home — a right-to-left one anchored under the name like the others.
  {
    const { ctx, page, errors } = await open("/full?home=focus&banner=1&gct=1", {}, { name: "Ask Ava!", nameSub: "Aetrex Virtual Assistant" });
    const b = await page.evaluate(() => { const w = document.querySelector(".ai-chat-welcome--focus"); const banner = w.querySelector(".ai-chat-welcome__banner"); const img = banner?.querySelector("img"); const r = banner?.getBoundingClientRect(); const hero = document.querySelector(".ai-chat-hero").getBoundingClientRect(); return { hasBanner: w.classList.contains("has-banner"), afterGreet: banner === w.children[1] && banner?.previousElementSibling?.classList.contains("ai-chat-focus__greet"), src: img?.getAttribute("src"), h: r?.height, clearOfFace: r ? r.top > hero.bottom + 4 : false, nextIsCards: banner?.nextElementSibling?.classList.contains("ai-chat-focus__cards") }; });
    check("home layout focus: the theme's banner sits right under the greeting, clear of the face, the shop cards under it — 136px at least", b.hasBanner && b.afterGreet && b.src === "/pic-footwear.svg" && b.h >= 136 && b.clearOfFace && b.nextIsCards, JSON.stringify(b));
    const greet0 = await page.evaluate(() => document.querySelector(".ai-chat-focus__greet .ai-chat-greet__item.is-in")?.textContent);
    const greetSet = await page.evaluate(() => window.__AI_CHAT_CONFIG.greetingCta);
    await page.waitForTimeout(4600);
    const stillEn = await page.evaluate(() => document.querySelector(".ai-chat-focus__greet .ai-chat-greet__item.is-in")?.textContent);
    check("home layout focus: the greeting starts in the store's own words and stays there a good while before it starts to travel", greet0 === greetSet && stillEn === greetSet, JSON.stringify({ greet0, stillEn }));
    const slid = await waitUntil(() => false, 10) || await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 5000) { const g = await page.evaluate(() => { const it = document.querySelector(".ai-chat-focus__greet .ai-chat-greet__item.is-in"); return it ? { text: it.textContent, dir: it.getAttribute("dir"), lang: it.getAttribute("lang"), n: document.querySelectorAll(".ai-chat-focus__greet .ai-chat-greet__item").length } : null; }); if (g && g.text !== greet0) return g; await page.waitForTimeout(100); } return null; })();
    check("home layout focus: the greeting slides to its next language under the name, marked with its language and direction", !!slid && slid.text === "¿En qué puedo ayudarte hoy?" && slid.lang === "es" && slid.dir === "ltr", JSON.stringify({ greet0, slid }));
    const sliding = await page.evaluate(() => { const it = document.querySelector(".ai-chat-focus__greet .ai-chat-greet__item.is-in"); const cs = getComputedStyle(it); return { transition: cs.transitionProperty, box: getComputedStyle(it.parentElement).overflow }; });
    check("home layout focus: the languages slide (a transform in a clipped line), no jump", /transform/.test(sliding.transition) && sliding.box === "hidden", JSON.stringify(sliding));
    // Closed and opened again: it starts over in the store's own words, and holds there.
    await page.click(".ai-chat-close-btn");
    await page.waitForTimeout(400);
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(300);
    const re0 = await page.evaluate(() => document.querySelector(".ai-chat-focus__greet .ai-chat-greet__item.is-in")?.textContent);
    await page.waitForTimeout(4200);
    const re1 = await page.evaluate(() => document.querySelector(".ai-chat-focus__greet .ai-chat-greet__item.is-in")?.textContent);
    check("home layout focus: opened again, the greeting starts over in the store's own words and holds", re0 === greetSet && re1 === greetSet, JSON.stringify({ re0, re1 }));
    // A right-to-left language: it reads right to left but starts where the others do, under the name — not at the far right.
    const rtl = await page.evaluate(() => { const box = document.querySelector(".ai-chat-focus__greet .ai-chat-greet"); box.insertAdjacentHTML("beforeend", '<span class="ai-chat-greet__item is-in" dir="rtl" lang="ar">كيف يمكنني مساعدتك اليوم؟</span>'); const it = box.lastElementChild; const range = document.createRange(); range.selectNodeContents(it); const text = range.getBoundingClientRect(); const name = document.querySelector(".ai-chat-header__name").getBoundingClientRect(); const cs = getComputedStyle(it); const out = { textLeft: text.left, nameLeft: name.left, boxRight: box.getBoundingClientRect().right, textRight: text.right, align: cs.textAlign, dir: cs.direction }; it.remove(); return out; });
    check("home layout focus: a right-to-left greeting stays anchored under the name (reads right to left, starts at the left)", Math.abs(rtl.textLeft - rtl.nameLeft) <= 1 && rtl.textRight < rtl.boxRight - 40 && rtl.align === "left" && rtl.dir === "rtl", JSON.stringify(rtl));
    // Once a chat starts the greeting leaves with the home; the header keeps its one row.
    const n = chatBodies.length;
    await startChat(page);
    await waitUntil(() => chatBodies.length > n);
    await page.waitForTimeout(2200);
    const gone = await page.evaluate(() => { const sub = document.querySelector(".ai-chat-header__sub"); return { greet: !document.querySelector(".ai-chat-focus__greet"), subShown: !!sub && !sub.hidden && getComputedStyle(sub).display !== "none", hdrH: Math.round(document.querySelector(".ai-chat-header").getBoundingClientRect().height) }; });
    check("home layout focus: once a chat starts the greeting leaves with the home and the header keeps its one row (no second line)", gone.greet && !gone.subShown && gone.hdrH <= 56, JSON.stringify(gone));
    check("home layout focus (banner, greeting): no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // A tall screen: the banner takes the spare room, as the classic home's
  // does — more of the picture, never past 240px — and the home still
  // fits without scrolling, the links at its foot.
  {
    const { ctx, page, errors } = await open("/full?home=focus&banner=1", { viewport: { width: 1280, height: 1200 } });
    const t = await page.evaluate(() => { const w = document.querySelector(".ai-chat-welcome--focus"); const sc = w.parentElement; const el = w.querySelector(".ai-chat-welcome__banner"); const cs = getComputedStyle(el); const links = w.querySelector(".ai-chat-focus__links").getBoundingClientRect(); return { h: el.getBoundingClientRect().height, grow: cs.flexGrow, max: cs.maxHeight, min: cs.minHeight, cover: getComputedStyle(el.querySelector("img")).objectFit, scrolls: sc.scrollHeight > sc.clientHeight + 1, linksAtFoot: sc.getBoundingClientRect().bottom - links.bottom >= 0 && sc.getBoundingClientRect().bottom - links.bottom <= 24 }; });
    check("home layout focus (tall screen): the banner grows into the spare room like the classic home's — taller than its 136px floor, no more than 240px, the picture covering it — and the home fits without scrolling, the links at its foot", t.h > 136 && t.h <= 240.5 && t.grow === "1" && t.max === "240px" && t.min === "136px" && t.cover === "cover" && !t.scrolls && t.linksAtFoot, JSON.stringify(t));
    check("home layout focus (tall screen): no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // On a shoe page with True Fit, the Footwear sheet carries the chat's own True Fit row — same logo, same words.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:4789/products/jillian-black?home=focus");
    await page.click(".ai-chat-launcher");
    await page.waitForTimeout(700);
    await page.click('[data-focus-sheet="footwear"]');
    await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    const tf = await page.evaluate(() => { const row = document.querySelector('.ai-chat-focus-sheet .ai-chat-helper[data-helper="truefit"]'); return row ? { logo: !!row.querySelector(".ai-chat-helper__icon .ai-chat-tf-logo, .ai-chat-helper__icon svg"), title: row.querySelector(".ai-chat-helper__title")?.textContent, sub: row.querySelector(".ai-chat-helper__sub")?.textContent, cls: row.className } : null; });
    check("home layout focus (shoe page): the Footwear sheet's True Fit row is the chat's own — the True Fit mark (the logo where the theme has one), 'Find my size · for this shoe'", !!tf && tf.logo && tf.title === "Find my size" && tf.sub === "True Fit \u00b7 for this shoe" && /\bai-chat-helper\b/.test(tf.cls), JSON.stringify(tf));
    check("home layout focus (shoe page): no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // Pictures on the two line cards (Settings → Focus home).
  {
    const { ctx, page, errors } = await open("/full?home=focus&pics=1&qp=1");
    await page.waitForTimeout(600);
    const pics = await page.evaluate(() => ({ cards: [...document.querySelectorAll(".ai-chat-focus__card-ico")].map((b) => ({ pic: b.classList.contains("has-pic"), src: b.querySelector("img")?.getAttribute("src") || "" })) }));
    check("home layout focus: the cards show the store's pictures when set — the Foot pain card's own picture in place of the heel", pics.cards.length === 3 && pics.cards.every((c) => c.pic) && pics.cards[0].src === "/pic-pain.svg" && pics.cards[1].src === "/pic-footwear.svg" && pics.cards[2].src === "/pic-orthotics.svg", JSON.stringify(pics));
    await page.click('[data-focus-sheet="orthotics"]');
    await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    const head = await page.evaluate(() => ({ pic: !!document.querySelector(".ai-chat-focus-sheet__head img, .ai-chat-focus-sheet__head .ai-chat-focus__card-ico"), title: document.querySelector(".ai-chat-focus-sheet__title")?.textContent }));
    check("home layout focus: the sheet's head carries no picture — the words alone", !head.pic && head.title === "Orthotics", JSON.stringify(head));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    await page.click('[data-focus-sheet="pain"]');
    await page.waitForSelector(".ai-chat-focus-sheet.is-open", { timeout: 3000 });
    const tilesAtOnce = await page.evaluate(() => document.querySelectorAll("[data-pain-opt]").length);
    check("home layout focus: the Foot pain sheet opens with its tiles already there — no blank beat before the first question", tilesAtOnce === 6, String(tilesAtOnce));
    const painHead = await page.evaluate(() => ({ pic: !!document.querySelector(".ai-chat-focus-sheet__head img"), tile: document.querySelector('[data-pain-opt="heel"] .ai-chat-focus__coin img')?.getAttribute("src") || "" }));
    check("home layout focus: the Foot pain sheet's head carries no picture while the heel tile inside keeps the heel", !painHead.pic && /focus-pain-heel/.test(painHead.tile), JSON.stringify(painHead));
    check("home layout focus (pictures): no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // Reduced motion: the switch from face to line happens without the journey.
  {
    const { ctx, page, errors } = await open("/full?home=focus", { reducedMotion: "reduce" });
    const n = chatBodies.length;
    await startChat(page);
    await page.waitForTimeout(80);
    const at = await state(page);
    await waitUntil(() => chatBodies.length > n);
    const anim = await page.evaluate(() => { const line = document.querySelector(".ai-chat-band__line"), bb = line.getBBox(), W = document.querySelector(".ai-chat-header").clientWidth, sweep = document.querySelector("#ai-chat-band-s"); return { running: [...document.querySelectorAll(".ai-chat-hero__photo, .ai-chat-band__ring, .ai-chat-band__line, .ai-chat-hero__halo")].reduce((a, el) => a + el.getAnimations().length, 0), fullLine: bb.height <= 1 && bb.width >= W - 2 && parseFloat(sweep.getAttribute("x1")) >= W, ringOut: getComputedStyle(document.querySelector(".ai-chat-band__ring")).opacity === "0" }; });
    check("home layout focus (reduced motion): the line is there at once, edge to edge, the face gone, nothing animates", at.chatting && at.heroGone && !at.home && anim.running === 0 && anim.fullLine && anim.ringOut, JSON.stringify({ at, anim }));
    check("home layout focus (reduced motion): no JS errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
}

// A streamed reply: the words show as they are written — a draft bubble in
// the typing dots' place, growing, with no thumbs and nothing saved — then
// the verified answer takes the draft's place with its cards and
// suggestions. "stream fix" is a rewrite after the fact check: the final
// words differ from the last draft, and the final is what stays and is saved.
for (const [label, viewport, msg, finalText] of [
  ["desktop", { width: 1280, height: 860 }, "stream", "Here are two boots that come in wide — the Rebecca and the Jillian."],
  ["phone", { width: 375, height: 740 }, "stream fix", "Here are two boots that come in wide — the Rebecca and the Jillian, both in stock in a 10 wide."],
]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, ...(label === "phone" ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    window.__drafts = [];
    const msgs = document.querySelector(".ai-chat-messages");
    new MutationObserver(() => { const d = document.querySelector(".ai-chat-msg.is-draft .ai-chat-msg-bubble"); const t = d ? d.textContent.trim() : ""; if (t && window.__drafts[window.__drafts.length - 1] !== t) window.__drafts.push(t); }).observe(msgs, { subtree: true, childList: true, characterData: true });
  });
  await page.fill(".ai-chat-input-area textarea", msg);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ai-chat-msg.is-draft", { timeout: 6000 });
  const mid = await page.evaluate(() => { const d = document.querySelector(".ai-chat-msg.is-draft"); return { text: d.querySelector(".ai-chat-msg-bubble").textContent.trim(), busy: d.getAttribute("aria-busy"), avatar: !!d.querySelector(".ai-chat-msg-avatar"), typing: document.querySelector(".ai-chat-typing").classList.contains("visible"), thumbs: !!d.querySelector(".ai-chat-feedback"), cards: d.querySelectorAll(".ai-chat-product-card").length, saved: (JSON.parse(localStorage.getItem("hajirai_chat_history") || "[]")).filter((m) => m.role === "assistant").length, caret: getComputedStyle(d.querySelector(".ai-chat-msg-bubble > p:last-of-type"), "::after").display }; });
  check(`streamed reply (${label}): the first words show in a draft bubble while the rest is written — typing dots gone, a caret after the words, no thumbs, no cards, nothing saved`, /^Here are/.test(mid.text) && mid.text !== finalText && mid.busy === "true" && mid.avatar && !mid.typing && !mid.thumbs && mid.cards === 0 && mid.saved === 0 && mid.caret === "inline-block", JSON.stringify(mid));
  await page.waitForSelector(".ai-chat-msg:last-child .ai-chat-product-card", { timeout: 8000 });
  await page.waitForTimeout(150);
  const done = await page.evaluate((finalText) => {
    const all = [...document.querySelectorAll(".ai-chat-msg--assistant")];
    const last = all[all.length - 1];
    const boots = all.filter((m) => /two boots/.test(m.textContent)).length;
    const hist = JSON.parse(localStorage.getItem("hajirai_chat_history") || "[]").filter((m) => m.role === "assistant");
    return { drafts: window.__drafts, text: last.querySelector(".ai-chat-msg-bubble > p").textContent.trim(), draft: last.classList.contains("is-draft"), busy: last.getAttribute("aria-busy"), boots, cards: last.querySelectorAll(".ai-chat-product-card").length, sugg: document.querySelectorAll(".ai-chat-suggest-btn").length, thumbs: !!document.querySelector(".ai-chat-feedback"), hist: hist.map((m) => m.content), typing: document.querySelector(".ai-chat-typing").classList.contains("visible"), finalText };
  }, finalText);
  const growing = done.drafts.length >= 2 && done.drafts.every((t, i) => i === 0 || (t.length > done.drafts[i - 1].length && t.startsWith(done.drafts[i - 1].slice(0, 8))));
  check(`streamed reply (${label}): the draft grew word by word (${done.drafts.length} steps)`, growing, JSON.stringify(done.drafts));
  check(`streamed reply (${label}): the verified answer took the draft's place — one bubble, the final words, two cards, suggestions, thumbs, saved once`, done.text === finalText && !done.draft && done.busy === null && done.boots === 1 && done.cards === 2 && done.sugg >= 2 && done.thumbs && done.hist.length === 1 && done.hist[0] === finalText && !done.typing, JSON.stringify({ ...done, drafts: done.drafts.length }));
  if (label === "phone") check("streamed reply (phone): the rewrite's words replaced the last draft's", done.drafts[done.drafts.length - 1] !== finalText && done.text === finalText, JSON.stringify({ last: done.drafts[done.drafts.length - 1], text: done.text }));
  check(`streamed reply (${label}): no JS errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// A reply that fails after a draft began: the draft goes, the error is said
// in its own bubble, nothing saved.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4789/full");
  await page.click(".ai-chat-launcher__text");
  await page.waitForTimeout(900);
  await page.fill(".ai-chat-input-area textarea", "stream error");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ai-chat-msg.is-draft", { timeout: 6000 });
  await page.waitForFunction(() => !document.querySelector(".ai-chat-msg.is-draft") && [...document.querySelectorAll(".ai-chat-msg--assistant")].some((m) => /try again/i.test(m.textContent)), null, { timeout: 8000 });
  const after = await page.evaluate(() => { const all = [...document.querySelectorAll(".ai-chat-msg--assistant")]; return { n: all.length, boots: all.filter((m) => /Here are/.test(m.textContent)).length, saved: JSON.parse(localStorage.getItem("hajirai_chat_history") || "[]").filter((m) => m.role === "assistant").length, typing: document.querySelector(".ai-chat-typing").classList.contains("visible") }; });
  check("streamed reply (error after a draft): the draft is gone, the error is said, nothing saved", after.boots === 0 && after.saved === 0 && !after.typing, JSON.stringify(after));
  check("streamed reply (error after a draft): no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(results.join("\n"));
const failedCount = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failedCount} passed, ${failedCount} failed`);
if (failedCount) process.exit(1);

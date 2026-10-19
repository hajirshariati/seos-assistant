// Every theme-editor setting reaches the shopper: the widget is loaded with a
// distinctive value in each setting (plus the theme block's own styles) and
// each one is checked on the page.
//
// Run: node scripts/e2e/widget/settings.mjs
import http from "node:http";
import fs from "node:fs";
import { chromium } from "playwright";
const W = new URL("../../../extensions/hajirai-chat-widget/assets/", import.meta.url).pathname;
const AV = "/avatar.png", BN = "/banner.png";
const base = {
  shopDomain: "s.myshopify.com", greeting: "GREETING-X", greetingLoggedIn: "Welcome back, {name}! LOGGED-X", greetingCta: "CTA-LINE-X",
  avatarUrl: AV, bannerUrl: BN, assistantName: "NAME-X", launcherPlaceholder: "LAUNCHER-X", inputPlaceholder: "INPUT-X",
  widgetPosition: "bottom-right",
  cta1Label: "C1-X", cta1Message: "c1 msg", cta1Icon: "heart", cta2Label: "C2-X", cta2Message: "c2 msg", cta2Icon: "auto",
  cta3Label: "C3-X", cta3Message: "c3 msg", cta3Icon: "auto", cta4Label: "C4-X", cta4Message: "c4 msg", cta4Icon: "gift",
  ctaHint: "HINT-X", ctaHintLoggedIn: "HINTIN-X {name}",
  quickPick1Label: "Q1-X", quickPick1Message: "q1 msg", quickPick2Label: "Q2-X", quickPick2Message: "q2 msg", quickPick3Label: "Q3-X", quickPick3Message: "q3 msg", quickPick4Label: "Q4-X", quickPick4Message: "q4 msg",
  showBanner: true, launcherWidth: "420", chatWidth: "700", hideOnMobile: false, trueFit: false, trueFitLogo: "/tf.png", rotateGreetingCta: false,
  customerLoggedIn: false, customerFirstName: "", customerLoginUrl: "/account/login", customerLogoutUrl: "/account/logout", customerId: null,
  disclaimerText: "DISCLAIMER-X", privacyUrl: "/pages/privacy-X", supportUrl: "https://help.example/x",
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const LIQ = fs.readFileSync(new URL("../../../extensions/hajirai-chat-widget/blocks/hajirai_chat.liquid", import.meta.url), "utf8").match(/<style>[\s\S]*?<\/style>/)[0];
const page = (cfg) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/w.css">${LIQ}<script>window.Shopify={routes:{root:"/"}};window.__AI_CHAT_CONFIG=${JSON.stringify(cfg)}</script></head><body><div style="height:1200px">Store</div><script src="/w.js"></script></body></html>`;
let cfgNow = base; let wcNow = {}; const bodies = [];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    if (u.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(page(cfgNow)); }
    if (u.pathname === "/w.js") { res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" }); return res.end(fs.readFileSync(W + "hajirai-chat-widget.js")); }
    if (u.pathname === "/w.css") { res.writeHead(200, { "Content-Type": "text/css" }); return res.end(fs.readFileSync(W + "hajirai-chat-widget.css")); }
    if (u.pathname.endsWith(".png")) { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(png); }
    if (u.pathname === "/axe.js") { try { res.writeHead(200, { "Content-Type": "application/javascript" }); return res.end(fs.readFileSync(new URL("../../../node_modules/axe-core/axe.min.js", import.meta.url))); } catch { res.writeHead(404); return res.end(); } }
    if (u.pathname.startsWith("/apps/hajirai/widget-config")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(wcNow)); }
    if (u.pathname === "/apps/hajirai/chat") { bodies.push(JSON.parse(b || "{}")); res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write('data: {"type":"text","text":"ok"}\n\n'); res.write('data: {"type":"products","products":[{"title":"Test Shoe","handle":"test-shoe","url":"/products/test-shoe","price":"10.00","price_formatted":"$10.00","kind":"footwear"}]}\n\n'); res.write('data: {"type":"done"}\n\n'); return res.end(); }
    res.writeHead(404); res.end();
  });
}).listen(4795);
const browser = await chromium.launch();
const out = [];
const check = (name, ok, detail = "") => out.push(`${ok ? "OK  " : "FAIL"} ${name}${ok ? "" : "  -> " + detail}`);
async function run(cfg, vp, fn) { cfgNow = cfg; const ctx = await browser.newContext({ viewport: vp }); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); await p.goto("http://localhost:4795/"); await p.waitForTimeout(400); await fn(p); if (errs.length) check("no JS errors", false, errs.join("|")); await ctx.close(); }
await run(base, { width: 1280, height: 900 }, async (p) => {
  check("launcherPlaceholder", (await p.textContent(".ai-chat-launcher__text")).trim() === "LAUNCHER-X");
  const lw = await p.evaluate(() => document.querySelector(".ai-chat-launcher").getBoundingClientRect().width);
  check("launcherWidth 420", Math.round(lw) === 420, lw);
  check("position bottom-right (launcher)", await p.evaluate(() => document.querySelector(".ai-chat-launcher").classList.contains("ai-chat-launcher--bottom-right")));
  await p.click(".ai-chat-launcher__text"); await p.waitForTimeout(700);
  const pw = await p.evaluate(() => document.querySelector(".ai-chat-panel").getBoundingClientRect());
  check("chatWidth 700", Math.round(pw.width) === 700, pw.width);
  check("position bottom-right (panel on the right)", pw.right > 1200, JSON.stringify(pw));
  check("assistantName in header", (await p.textContent(".ai-chat-header__name")).trim() === "NAME-X");
  check("avatar in header + welcome", await p.evaluate(() => /avatar\.png/.test(document.querySelector(".ai-chat-header__avatar img")?.src || "") && /avatar\.png/.test(document.querySelector(".ai-chat-welcome__avatar img")?.src || "")));
  check("banner shown", await p.evaluate(() => /banner\.png/.test(document.querySelector(".ai-chat-welcome__banner img")?.src || "")));
  check("greeting", (await p.textContent(".ai-chat-welcome__title")).trim() === "GREETING-X");
  check("greetingCta", (await p.textContent(".ai-chat-welcome__greeting-cta")).trim() === "CTA-LINE-X");
  check("inputPlaceholder", (await p.getAttribute(".ai-chat-input", "placeholder")) === "INPUT-X");
  const ctas = await p.$$eval(".ai-chat-welcome__cta-btn", (b) => b.map((x) => x.querySelector(".ai-chat-welcome__cta-label").textContent + "|" + x.dataset.message));
  check("4 CTA labels + messages", ctas.join(",") === "C1-X|c1 msg,C2-X|c2 msg,C3-X|c3 msg,C4-X|c4 msg", ctas.join(","));
  check("CTA icon picks (heart, gift)", await p.evaluate(() => { const i = document.querySelectorAll(".ai-chat-welcome__cta-icon"); return /M12 20s/.test(i[0].innerHTML) && /rx="1"/.test(i[3].innerHTML); }));
  const qps = await p.$$eval(".ai-chat-welcome__qp-btn", (b) => b.map((x) => x.textContent + "|" + x.dataset.message));
  check("4 quick picks", qps.join(",") === "Q1-X|q1 msg,Q2-X|q2 msg,Q3-X|q3 msg,Q4-X|q4 msg", qps.join(","));
  check("ctaHint (logged out, links to login)", await p.evaluate(() => { const h = document.querySelector(".ai-chat-welcome__hint"); return h && h.textContent === "HINT-X" && /\/account\/login\?return_url=/.test(h.getAttribute("href")); }));
  check("disclaimer + privacy link", await p.evaluate(() => { const f = document.querySelector(".ai-chat-footer"); return f && /DISCLAIMER-X/.test(f.textContent) && f.querySelector("a").getAttribute("href") === "/pages/privacy-X"; }));
  check("trueFit off → no True Fit card", !(await p.$('[data-helper="truefit"]')));
  await p.waitForTimeout(3800);
  check("rotateGreetingCta off → stays", (await p.textContent(".ai-chat-welcome__greeting-cta")).trim() === "CTA-LINE-X");
  await p.click(".ai-chat-welcome__qp-btn");
  await p.waitForTimeout(500);
  check("theme support url sent to the server (label defaults until set in Settings)", bodies.at(-1)?.support_url === "https://help.example/x" && bodies.at(-1)?.support_label === "Chat with Aetrex Support", JSON.stringify({ u: bodies.at(-1)?.support_url, l: bodies.at(-1)?.support_label }));
  check("quick pick sends its message", bodies.at(-1)?.message === "q1 msg", bodies.at(-1)?.message);
});
await run({ ...base, showBanner: false, customerLoggedIn: true, customerFirstName: "Dana", customerId: 5, widgetPosition: "bottom-left" }, { width: 1280, height: 900 }, async (p) => {
  await p.click(".ai-chat-launcher__text"); await p.waitForTimeout(700);
  check("showBanner off", !(await p.$(".ai-chat-welcome__banner")));
  check("greetingLoggedIn with {name}", (await p.textContent(".ai-chat-welcome__title")).trim() === "Welcome back, Dana! LOGGED-X");
  check("ctaHintLoggedIn with {name}", (await p.textContent(".ai-chat-welcome__hint")).trim() === "HINTIN-X Dana");
  check("logged-in pill", (await p.textContent(".ai-chat-header__vip-pill")).trim() === "Hi Dana!");
  const pw = await p.evaluate(() => document.querySelector(".ai-chat-panel").getBoundingClientRect());
  check("position bottom-left (panel on the left)", pw.left < 80, JSON.stringify(pw));
});
await run({ ...base, hideOnMobile: true }, { width: 390, height: 844 }, async (p) => {
  check("hideOnMobile", await p.evaluate(() => getComputedStyle(document.querySelector(".ai-chat-launcher")).display === "none"));
});
await run({ ...base, greeting: "", greetingCta: "", disclaimerText: "", ctaHint: "", cta1Label: "", cta2Label: "", cta3Label: "", cta4Label: "" }, { width: 1280, height: 900 }, async (p) => {
  await p.click(".ai-chat-launcher__text"); await p.waitForTimeout(700);
  check("blank greeting → falls back", (await p.textContent(".ai-chat-welcome__title")).trim().length > 0, await p.textContent(".ai-chat-welcome__title"));
  check("blank CTAs → section hidden", !(await p.$(".ai-chat-welcome__ctas")));
  check("blank disclaimer → no footer", !(await p.$(".ai-chat-footer")));
});
// App admin settings that reach the storefront through widget-config.
wcNow = { showFeedback: false, showLoginPill: false, supportUrl: "https://admin.example/help", supportLabel: "ADMIN-SUPPORT" };
await run(base, { width: 1280, height: 900 }, async (p) => {
  await p.click(".ai-chat-launcher__text"); await p.waitForTimeout(700);
  check("admin: login pill off", await p.evaluate(() => { const x = document.querySelector(".ai-chat-header__login-pill"); return !x || getComputedStyle(x).display === "none"; }));
  await p.click(".ai-chat-welcome__qp-btn"); await p.waitForTimeout(700);
  check("admin: feedback buttons off", !(await p.$(".ai-chat-feedback")));
  check("admin: Settings support link wins over the theme's", bodies.at(-1)?.support_url === "https://admin.example/help" && bodies.at(-1)?.support_label === "ADMIN-SUPPORT", JSON.stringify({ u: bodies.at(-1)?.support_url, l: bodies.at(-1)?.support_label }));
});
wcNow = {};
await run(base, { width: 1280, height: 900 }, async (p) => {
  await p.click(".ai-chat-launcher__text"); await p.waitForTimeout(700);
  await p.click(".ai-chat-welcome__qp-btn"); await p.waitForTimeout(700);
  check("admin: feedback buttons on by default", !!(await p.$(".ai-chat-feedback")));
});
// The rotating welcome line: English first on every open (held 3s), then
// the other languages; English again after closing and reopening.
wcNow = { greetingCtaTranslations: [{ text: "ES-LINE", dir: "ltr", code: "es" }, { text: "AR-LINE", dir: "rtl", code: "ar" }] };
await run({ ...base, rotateGreetingCta: true }, { width: 1280, height: 900 }, async (p) => {
  const line = () => p.textContent(".ai-chat-welcome__greeting-cta").then((t) => t.trim());
  await p.waitForTimeout(6000); // the page sits a while before the chat is opened
  await p.click(".ai-chat-launcher__text");
  await p.waitForTimeout(600);
  check("rotator: opens in English", (await line()) === "CTA-LINE-X", await line());
  await p.waitForTimeout(1800);
  check("rotator: English holds ~3s", (await line()) === "CTA-LINE-X", await line());
  await p.waitForTimeout(1200);
  check("rotator: then other languages", (await line()) === "ES-LINE", await line());
  await p.waitForTimeout(4600);
  check("rotator: back to English and held again", (await line()) === "CTA-LINE-X", await line());
  await p.waitForTimeout(800);
  await p.click(".ai-chat-close-btn"); await p.waitForTimeout(400);
  await p.click(".ai-chat-launcher__text"); await p.waitForTimeout(500);
  check("rotator: reopening starts in English", (await line()) === "CTA-LINE-X", await line());
});
wcNow = {};
// Settings → Appearance: Dark themes the whole assistant and is remembered
// for the next page load (no flash of light); Light is the default.
wcNow = { theme: "dark" };
await run(base, { width: 1280, height: 900 }, async (p) => {
  await p.waitForTimeout(400);
  const themed = await p.evaluate(() => [".ai-chat-launcher", ".ai-chat-panel", ".ai-chat-overlay"].map((s) => document.querySelector(s)?.getAttribute("data-theme")).join(","));
  check("dark: launcher, panel and overlay carry the theme", themed === "dark,dark,dark", themed);
  const bg = await p.evaluate(() => getComputedStyle(document.querySelector(".ai-chat-launcher")).backgroundColor);
  check("dark: the launcher bar is charcoal", bg === "rgb(20, 20, 24)", bg);
  await p.click(".ai-chat-launcher__text"); await p.waitForTimeout(700);
  const panel = await p.evaluate(() => ({ bg: getComputedStyle(document.querySelector(".ai-chat-panel")).backgroundColor, text: getComputedStyle(document.querySelector(".ai-chat-welcome__title")).color, input: getComputedStyle(document.querySelector(".ai-chat-input")).color }));
  check("dark: panel charcoal, text light", panel.bg === "rgb(20, 20, 24)" && panel.text === "rgb(245, 245, 247)" && panel.input === "rgb(245, 245, 247)", JSON.stringify(panel));
  await p.fill(".ai-chat-input-area textarea", "show me 1"); await p.keyboard.press("Enter");
  await p.waitForFunction(() => document.querySelectorAll(".ai-chat-product-card").length >= 1, null, { timeout: 5000 });
  const card = await p.evaluate(() => ({ card: getComputedStyle(document.querySelector(".ai-chat-product-card")).backgroundColor, user: getComputedStyle(document.querySelector(".ai-chat-msg--user .ai-chat-msg-bubble")).backgroundColor }));
  check("dark: product card raised charcoal, shopper bubble light", card.card === "rgb(28, 28, 33)" && card.user === "rgb(245, 245, 247)", JSON.stringify(card));
  const remembered = await p.evaluate(() => localStorage.getItem("hajirai_theme"));
  check("dark: remembered for the next page load", remembered === "dark", remembered);
  const axe = await p.evaluate(async () => { if (!window.axe) { await new Promise((r) => { const s = document.createElement("script"); s.src = "/axe.js"; s.onload = r; s.onerror = r; document.head.appendChild(s); }); } if (!window.axe) return null; const res = await window.axe.run(document.querySelector(".ai-chat-panel"), { runOnly: ["color-contrast"] }); return res.violations.map((v) => v.id + ":" + v.nodes.length); });
  if (axe !== null) check("dark: text contrast passes (axe color-contrast)", axe.length === 0, axe.join(" | "));
});
wcNow = { theme: "light" };
await run(base, { width: 1280, height: 900 }, async (p) => {
  await p.evaluate(() => { try { localStorage.setItem("hajirai_theme", "dark"); } catch { /* */ } });
  await p.reload(); await p.waitForTimeout(500);
  check("light: the saved setting wins over a stale cached theme", (await p.evaluate(() => document.querySelector(".ai-chat-launcher").getAttribute("data-theme") + "," + getComputedStyle(document.querySelector(".ai-chat-launcher")).backgroundColor)) === "light,rgb(255, 255, 255)");
});
wcNow = {};
console.log(out.join("\n"));
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(`\n${out.length - failed} passed, ${failed} failed`);
await browser.close(); srv.close(); process.exit(failed ? 1 : 0);

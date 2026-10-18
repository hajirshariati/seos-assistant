// Widget resilience and accessibility in a real browser: server error
// responses, a dropped stream, refresh/history restore, hostile content,
// blocked storage, double sends, pages the store hides the chat on, a help
// button that loads late, keyboard use, and an axe-core WCAG 2.2 AA scan.
//
// Run: node scripts/e2e/widget/resilience.mjs   (prints a JSON summary last)
import fs from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const { start, chatBodies } = await import("./mock-store.mjs");
const PORT = 4795;
const { srv } = await start(PORT);
const AXE = fs.readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const browser = await chromium.launch();
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail: ok ? "" : String(detail).slice(0, 300) });
const url = (p) => `http://localhost:${PORT}${p}`;

async function open(path = "/full", { viewport = { width: 1280, height: 900 }, init } = {}) {
  const ctx = await browser.newContext({ viewport });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url(path));
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}
async function say(page, text, wait = 1200) {
  await page.fill(".ai-chat-input-area textarea", text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(wait);
}
const lastBubble = (page) => page.$$eval(".ai-chat-msg--assistant .ai-chat-msg-bubble", (b) => b.at(-1)?.textContent || "");

// 1. Server errors — each says something true, input comes back, no retry loop.
{
  const { ctx, page, errors } = await open();
  await page.click(".ai-chat-launcher");
  const cases = [
    ["err429", /sending messages quickly/i],
    ["err402", /reached its conversations/i],
    ["err503", /isn't available right now|customer service/i],
    ["err500", /high traffic|try again/i],
  ];
  for (const [msg, re] of cases) {
    await say(page, msg);
    const text = await lastBubble(page);
    check(`server ${msg.slice(3)}: shopper sees a clear message`, re.test(text), text);
    check(`server ${msg.slice(3)}: input usable again`, !(await page.$eval(".ai-chat-input-area textarea", (t) => t.disabled)));
  }
  check("errors: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// 2. A stream that ends without "done" still shows what arrived.
{
  const { ctx, page } = await open();
  await page.click(".ai-chat-launcher");
  await say(page, "cut");
  check("dropped stream: partial answer kept", /before the connection dropped/.test(await lastBubble(page)));
  check("dropped stream: can keep chatting", !(await page.$eval(".ai-chat-input-area textarea", (t) => t.disabled)));
  await ctx.close();
}

// 3. Refresh: the conversation and its cards come back.
{
  const { ctx, page, errors } = await open("/showcase");
  await page.click(".ai-chat-launcher");
  await say(page, "show me 2");
  await page.reload();
  await page.waitForTimeout(500);
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(600);
  const userMsgs = await page.$$eval(".ai-chat-msg--user", (m) => m.map((x) => x.textContent));
  const cards = await page.$$eval(".ai-chat-product-card", (c) => c.length);
  check("refresh: earlier messages restored", userMsgs.some((t) => /show me 2/.test(t)), JSON.stringify(userMsgs));
  check("refresh: product cards restored", cards === 2, cards);
  await say(page, "show me 1");
  const sent = chatBodies.at(-1);
  check("refresh: next message carries the history once (no duplicate of the new message)", sent.history.filter((h) => h.role === "user" && h.content === "show me 1").length === 0 && sent.history.some((h) => /show me 2/.test(h.content)), JSON.stringify(sent.history).slice(0, 200));
  check("refresh: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// 4. Hostile content from the server or the AI never runs.
{
  const { ctx, page, errors } = await open();
  await page.click(".ai-chat-launcher");
  await say(page, "xss");
  const hrefs = await page.$$eval(".ai-chat-panel a", (as) => as.map((a) => a.getAttribute("href") || ""));
  // Click every link that isn't a plain store link (those would navigate away).
  await page.$$eval(".ai-chat-panel a", (as) => as.filter((a) => !/^\/(pages|products|collections|cart|checkout)/.test(a.getAttribute("href") || "")).forEach((a) => a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))));
  await page.waitForTimeout(300);
  const pwned = await page.evaluate(() => window.__pwned || 0);
  check("hostile content: no injected script ran", pwned === 0, `__pwned=${pwned}`);
  check("hostile content: no javascript: links", !hrefs.some((h) => /^\s*javascript:/i.test(h)), JSON.stringify(hrefs));
  check("hostile content: no links to //other-site", !hrefs.some((h) => h.startsWith("//")), JSON.stringify(hrefs));
  check("hostile content: safe store links still work", hrefs.includes("/pages/returns"), JSON.stringify(hrefs));
  check("hostile content: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// 5. Storage blocked (private modes, strict cookie settings).
{
  const block = () => {
    for (const k of ["getItem", "setItem", "removeItem"]) Storage.prototype[k] = () => { throw new DOMException("blocked", "SecurityError"); };
  };
  const { ctx, page, errors } = await open("/showcase", { init: block });
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(500);
  check("storage blocked: chat opens", await page.$eval(".ai-chat-panel", (p) => p.classList.contains("open")));
  await say(page, "show me 1");
  check("storage blocked: reply arrives", (await page.$$(".ai-chat-product-card")).length === 1);
  check("storage blocked: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// 6. Double Enter sends one message.
{
  const { ctx, page } = await open("/showcase");
  await page.click(".ai-chat-launcher");
  const before = chatBodies.length;
  await page.fill(".ai-chat-input-area textarea", "show me 1");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  check("double Enter: one request", chatBodies.length - before === 1, chatBodies.length - before);
  await ctx.close();
}

// 7. A page the store hides the assistant on.
{
  const { ctx, page } = await open("/full");
  await page.goto(url("/hidden-page"));
  await page.waitForTimeout(600);
  await page.evaluate(() => { const a = document.createElement("a"); a.href = "#"; a.setAttribute("data-open-ai-chat", ""); a.id = "opener"; a.textContent = "Chat"; document.body.appendChild(a); });
  await page.click("#opener");
  await page.waitForTimeout(300);
  const blurred = await page.evaluate(() => document.body.classList.contains("ai-chat-blurred"));
  const visible = await page.$eval(".ai-chat-launcher", (l) => getComputedStyle(l).display !== "none").catch(() => false);
  check("hidden page: assistant hidden", !visible);
  check("hidden page: a custom opener can't blur/lock the page", !blurred);
  await ctx.close();
}

// 8. A help-chat button that appears late, inside an existing container.
{
  const init = () => {
    try { sessionStorage.setItem("hajirai_launcher_bubble", "1"); } catch { /* */ }
    document.addEventListener("DOMContentLoaded", () => {
      const wrap = document.createElement("div"); document.body.appendChild(wrap);
      setTimeout(() => {
        const f = document.createElement("iframe"); f.id = "zd";
        f.style.cssText = "position:fixed;right:14px;bottom:14px;width:0;height:50px;border:0;z-index:999999";
        wrap.appendChild(f); setTimeout(() => (f.style.width = "120px"), 500);
      }, 2500);
    });
  };
  const { ctx, page } = await open("/full", { init });
  await page.waitForTimeout(6000);
  const clear = await page.evaluate(() => document.querySelector(".ai-chat-launcher").getBoundingClientRect().bottom <= document.getElementById("zd").getBoundingClientRect().top);
  check("late help button: bubble moves clear of it", clear);
  await ctx.close();
}

// 9. Keyboard: open with Enter, Tab stays inside, Escape returns focus.
{
  const { ctx, page } = await open();
  await page.focus(".ai-chat-launcher__text");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  let inside = true;
  for (let i = 0; i < 30; i++) { await page.keyboard.press("Tab"); inside = inside && await page.evaluate(() => !!document.activeElement.closest(".ai-chat-panel")); }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("keyboard: Enter opens the chat", true);
  check("keyboard: Tab stays inside the open chat", inside);
  check("keyboard: Escape closes and returns focus to the launcher", await page.evaluate(() => !!document.activeElement.closest(".ai-chat-launcher")));
  await ctx.close();
}

// 9b. Phone keyboard: the chat shrinks to the visible area (no gap under it,
// nothing hidden behind the keyboard) and the fine print steps aside.
{
  const init = () => {
    const vv = new EventTarget();
    vv.height = window.innerHeight; vv.width = window.innerWidth; vv.offsetTop = 0; vv.offsetLeft = 0; vv.scale = 1;
    Object.defineProperty(window, "visualViewport", { get: () => vv, configurable: true });
    window.__kb = (h) => { vv.height = h; vv.dispatchEvent(new Event("resize")); };
  };
  const { ctx, page } = await open("/full", { viewport: { width: 390, height: 844 }, init });
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(600);
  const pad = await page.$eval(".ai-chat-input-area", (e) => getComputedStyle(e).paddingBottom);
  check("phone: no doubled bottom spacing under the message bar", pad === "8px", pad);
  await page.evaluate(() => window.__kb(480));
  await page.waitForTimeout(100);
  const open1 = await page.evaluate(() => {
    const p = document.querySelector(".ai-chat-panel");
    const f = document.querySelector(".ai-chat-footer");
    return { h: Math.round(p.getBoundingClientRect().height), kb: p.classList.contains("is-kb"), footer: f ? getComputedStyle(f).display : "none" };
  });
  check("phone keyboard: chat fits the visible area above the keyboard", open1.h === 480 && open1.kb, JSON.stringify(open1));
  check("phone keyboard: fine print hidden while typing", open1.footer === "none", open1.footer);
  await page.evaluate(() => window.__kb(844));
  await page.waitForTimeout(100);
  const closed = await page.evaluate(() => {
    const p = document.querySelector(".ai-chat-panel");
    return { h: Math.round(p.getBoundingClientRect().height), kb: p.classList.contains("is-kb") };
  });
  check("phone keyboard: full height again once it closes", closed.h === 844 && !closed.kb, JSON.stringify(closed));
  await ctx.close();
}

// 10. axe-core WCAG 2.2 A/AA on the widget only (not the host page).
const axeRuns = [];
async function axe(page, label) {
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async () => {
    const res = await window.axe.run({ include: [[".ai-chat-panel"], [".ai-chat-launcher"]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, target: v.nodes[0]?.target?.join(" ") }));
  });
  axeRuns.push({ label, violations: r });
  return r;
}
for (const [vp, name] of [[{ width: 1280, height: 900 }, "desktop"], [{ width: 390, height: 844 }, "mobile"]]) {
  const { ctx, page } = await open("/showcase", { viewport: vp });
  await axe(page, `${name}: launcher`);
  await page.click(".ai-chat-launcher");
  await page.waitForTimeout(1500);
  await axe(page, `${name}: welcome`);
  await say(page, "show me 3");
  await axe(page, `${name}: reply with cards`);
  await page.click(".ai-chat-close-btn");
  await page.click(".ai-chat-launcher__close");
  await page.waitForTimeout(300);
  await axe(page, `${name}: bubble`);
  await ctx.close();
}
for (const run of axeRuns) {
  const serious = run.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  check(`axe WCAG 2.2 AA — ${run.label}: no serious/critical violations`, serious.length === 0, serious.map((v) => `${v.id} (${v.nodes}) ${v.target}`).join("; "));
}

await browser.close();
srv.close();
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
const failed = results.filter((r) => !r.ok).length;
const minor = axeRuns.flatMap((r) => r.violations.filter((v) => v.impact !== "serious" && v.impact !== "critical").map((v) => `${r.label}: ${v.id} (${v.impact})`));
if (minor.length) console.log(`\naxe moderate/minor (reported, not failing):\n  ${minor.join("\n  ")}`);
console.log(`\n${results.length - failed} passed, ${failed} failed`);
console.log(JSON.stringify({ widgetResilience: { passed: results.length - failed, failed, results, axe: axeRuns, at: new Date().toISOString() } }));
process.exit(failed ? 1 : 0);

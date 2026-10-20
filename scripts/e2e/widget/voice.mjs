// Talk instead of typing, and the store's orb colors. A stand-in for the
// browser's speech recognition plays a script (words as they're heard, then
// a pause, an error or nothing) so every path of the talk button is checked:
// live words in the box, sending on the pause, stop, cancel, Escape, errors,
// the store switch, and browsers without speech recognition.
//
// Run: node scripts/e2e/widget/voice.mjs
import http from "node:http";
import fs from "node:fs";
import { chromium } from "playwright";
const W = new URL("../../../extensions/hajirai-chat-widget/assets/", import.meta.url).pathname;
const cfg = { shopDomain: "s.myshopify.com", greeting: "Hi!", assistantName: "Assistant", inputPlaceholder: "INPUT-X", widgetPosition: "bottom-right" };
let wcNow = {}; const bodies = [];
const page = () => `<!doctype html><html lang="en-US"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/w.css"><script>window.Shopify={routes:{root:"/"}};window.__AI_CHAT_CONFIG=${JSON.stringify(cfg)}</script></head><body style="margin:0;font-family:-apple-system,Helvetica"><main style="padding:20px">Store</main><script src="/w.js"></script></body></html>`;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    if (u.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(page()); }
    if (u.pathname === "/w.js") { res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" }); return res.end(fs.readFileSync(W + "hajirai-chat-widget.js")); }
    if (u.pathname === "/w.css") { res.writeHead(200, { "Content-Type": "text/css" }); return res.end(fs.readFileSync(W + "hajirai-chat-widget.css")); }
    if (u.pathname === "/axe.js") { try { res.writeHead(200, { "Content-Type": "application/javascript" }); return res.end(fs.readFileSync(new URL("../../../node_modules/axe-core/axe.min.js", import.meta.url))); } catch { res.writeHead(404); return res.end(); } }
    if (u.pathname.startsWith("/apps/hajirai/widget-config")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(wcNow)); }
    if (u.pathname === "/apps/hajirai/chat") { bodies.push(JSON.parse(b || "{}")); res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write('data: {"type":"text","text":"Here you go."}\n\n'); res.write('data: {"type":"done"}\n\n'); return res.end(); }
    res.writeHead(404); res.end();
  });
}).listen(4796);

// The stand-in recognizer. window.__voice sets the script before the mic is tapped.
const FAKE = () => {
  window.__voice = { words: ["show me", "show me sandals"], error: null, hold: false, delay: 150 };
  window.__rec = { started: 0, lang: "", stopped: 0, aborted: 0 };
  class FakeRec {
    start() {
      const s = window.__voice; window.__rec.started++; window.__rec.lang = this.lang; window.__rec.interim = this.interimResults;
      this._timers = [];
      const later = (fn, ms) => this._timers.push(setTimeout(fn, ms));
      if (s.error) { later(() => { this.onerror?.({ error: s.error }); this.onend?.(); }, s.delay); return; }
      if (s.words.length) later(() => this.onspeechstart?.(), s.delay / 2);
      s.words.forEach((w, i) => later(() => { const r = [{ transcript: w }]; r.isFinal = i === s.words.length - 1; this.onresult?.({ results: [r] }); }, s.delay * (i + 1)));
      if (!s.hold) later(() => this.onend?.(), s.delay * (s.words.length + 1) + 60);
    }
    stop() { window.__rec.stopped++; this._timers.forEach(clearTimeout); setTimeout(() => this.onend?.(), 30); }
    abort() { window.__rec.aborted++; this._timers.forEach(clearTimeout); setTimeout(() => { this.onerror?.({ error: "aborted" }); this.onend?.(); }, 10); }
  }
  window.SpeechRecognition = FakeRec;
  window.webkitSpeechRecognition = FakeRec;
};
const NONE = () => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; };

const browser = await chromium.launch();
const out = [];
const check = (name, ok, detail = "") => out.push(`${ok ? "OK  " : "FAIL"} ${name}${ok ? "" : "  -> " + detail}`);
async function run({ fake = true, theme = null } = {}, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(fake ? FAKE : NONE);
  if (theme) await ctx.addInitScript((t) => { try { localStorage.setItem("hajirai_theme_pick", t); } catch { /* */ } }, theme);
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("http://localhost:4796/"); await p.waitForTimeout(400);
  await p.click(".ai-chat-launcher__text"); await p.waitForTimeout(600);
  await fn(p);
  if (errs.length) check("no JS errors", false, errs.join("|"));
  await ctx.close();
}
const state = (p) => p.evaluate(() => {
  const panel = document.querySelector(".ai-chat-panel"), mic = document.querySelector(".ai-chat-mic"), input = document.querySelector(".ai-chat-input");
  return { listening: panel.classList.contains("is-listening"), pressed: mic.getAttribute("aria-pressed"), label: mic.getAttribute("aria-label"), value: input.value, placeholder: input.getAttribute("placeholder"), readOnly: input.readOnly, cancelShown: !document.querySelector(".ai-chat-voice-cancel").hidden, wave: getComputedStyle(document.querySelector(".ai-chat-wave")).display, users: [...document.querySelectorAll(".ai-chat-msg--user")].map((m) => m.textContent.trim()), rec: window.__rec, open: panel.classList.contains("open") || getComputedStyle(panel).display !== "none" };
});

// Speak, see the words, sent on the pause
const shown = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); const cs = getComputedStyle(e); return !e.hidden && cs.visibility !== "hidden" && Number(cs.opacity) > 0.5; }, sel);
await run({}, async (p) => {
  check("empty box: the mic sits in Send's place", (await shown(p, ".ai-chat-mic")) && !(await shown(p, ".ai-chat-send")));
  check("mic and Send share one slot at the end of the box", await p.evaluate(() => { const m = document.querySelector(".ai-chat-mic"), s = document.querySelector(".ai-chat-send"); return m.parentElement === s.parentElement && !!m.closest(".ai-chat-input-wrap") && m.offsetLeft === s.offsetLeft && m.offsetTop === s.offsetTop && m.offsetWidth === s.offsetWidth; }));
  await p.evaluate(() => { window.__voice.delay = 300; });
  const before = bodies.length;
  await p.click(".ai-chat-mic"); await p.waitForTimeout(80);
  let s = await state(p);
  check("tap: listening state, mic pressed, offers to stop", s.listening && s.pressed === "true" && s.label === "Stop listening", JSON.stringify(s));
  check("tap: box says Listening…, read-only, wave in place of the icon, × shown", s.placeholder === "Listening…" && s.readOnly && s.wave === "flex" && s.cancelShown, JSON.stringify(s));
  check("tap: recognizer in the page's language with live words", s.rec.lang === "en-US" && s.rec.interim === true, JSON.stringify(s.rec));
  await p.waitForTimeout(300);
  s = await state(p);
  check("speaking: words appear in the box as they're heard", s.value === "show me" && s.listening, JSON.stringify(s));
  await p.waitForTimeout(260);
  check("speaking: the same button turns into Send", (await shown(p, ".ai-chat-send")) && !(await shown(p, ".ai-chat-mic")));
  await p.waitForTimeout(450);
  s = await state(p);
  check("pause: the message sends itself", bodies.length === before + 1 && bodies.at(-1).message === "show me sandals", JSON.stringify(bodies.at(-1)));
  check("pause: shown as the shopper's message, box cleared, back to the mic", s.users.at(-1) === "show me sandals" && s.value === "" && !s.listening && s.pressed === "false" && s.placeholder === "INPUT-X", JSON.stringify(s));
  await p.waitForTimeout(300);
  check("pause: the mic is back in place", (await shown(p, ".ai-chat-mic")) && !(await shown(p, ".ai-chat-send")));
  await p.waitForSelector(".ai-chat-msg--assistant", { timeout: 4000 }).catch(() => {});
  check("reply arrives as text", /Here you go/.test(await p.textContent(".ai-chat-messages")));
});

// Typing turns the mic into Send; clearing brings the mic back
await run({}, async (p) => {
  await p.fill(".ai-chat-input", "red sandals"); await p.waitForTimeout(350);
  check("typing: the mic turns into Send", (await shown(p, ".ai-chat-send")) && !(await shown(p, ".ai-chat-mic")));
  await p.fill(".ai-chat-input", ""); await p.waitForTimeout(350);
  check("cleared: the mic comes back", (await shown(p, ".ai-chat-mic")) && !(await shown(p, ".ai-chat-send")));
  await p.fill(".ai-chat-input", "red sandals"); const before = bodies.length;
  await p.click(".ai-chat-send"); await p.waitForTimeout(250);
  check("typing: Send sends as usual", bodies.length === before + 1 && bodies.at(-1).message === "red sandals", JSON.stringify(bodies.at(-1)));
});

// Send while still talking sends now; tapping the mic before any words just stops
await run({}, async (p) => {
  await p.evaluate(() => { window.__voice.hold = true; window.__voice.words = ["wide shoes"]; });
  await p.click(".ai-chat-mic"); await p.waitForTimeout(400);
  const b2 = bodies.length;
  await p.click(".ai-chat-send"); await p.waitForTimeout(250);
  check("Send while talking sends what was heard", bodies.length === b2 + 1 && bodies.at(-1).message === "wide shoes", JSON.stringify(bodies.at(-1)));
  await p.waitForTimeout(600);
  await p.evaluate(() => { window.__voice.words = []; });
  await p.click(".ai-chat-mic"); await p.waitForTimeout(120);
  const b3 = bodies.length;
  await p.click(".ai-chat-mic"); await p.waitForTimeout(150);
  const s = await state(p);
  check("mic again before any words: stops quietly, nothing sent", !s.listening && bodies.length === b3 && s.placeholder === "INPUT-X", JSON.stringify(s));
});

// Cancel with × or Escape: nothing sent, the box cleared, chat stays open
await run({}, async (p) => {
  await p.evaluate(() => { window.__voice.hold = true; });
  await p.click(".ai-chat-mic"); await p.waitForTimeout(400);
  const before = bodies.length;
  await p.click(".ai-chat-voice-cancel"); await p.waitForTimeout(150);
  let s = await state(p);
  check("×: cancels, nothing sent, box cleared", bodies.length === before && !s.listening && s.value === "" && s.rec.aborted === 1, JSON.stringify(s));
  await p.waitForTimeout(300);
  check("×: the mic is back", await shown(p, ".ai-chat-mic"));
  await p.click(".ai-chat-mic"); await p.waitForTimeout(300);
  await p.keyboard.press("Escape"); await p.waitForTimeout(150);
  s = await state(p);
  check("Escape: cancels listening, the chat stays open", bodies.length === before && !s.listening && s.open && s.value === "", JSON.stringify(s));
});

// When it can't hear: a short hint in the box, nothing sent
for (const [error, words, hint] of [["not-allowed", [], "Allow microphone access to talk"], [null, [], "Didn’t catch that — tap the mic and try again"], ["network", [], "Voice isn’t available right now — please type"]]) {
  await run({}, async (p) => {
    await p.evaluate(([e, w]) => { window.__voice.error = e; window.__voice.words = w; }, [error, words]);
    const before = bodies.length;
    await p.click(".ai-chat-mic"); await p.waitForTimeout(500);
    const s = await state(p);
    check(`${error || "no speech"}: hint shown, nothing sent, idle again`, s.placeholder === hint && bodies.length === before && !s.listening, JSON.stringify(s));
    await p.waitForTimeout(3600);
    check(`${error || "no speech"}: the usual prompt returns`, (await state(p)).placeholder === "INPUT-X");
  });
}

// Not offered where it can't work, or when the store turns it off
await run({ fake: false }, async (p) => {
  check("no speech recognition in the browser: no mic", !(await p.isVisible(".ai-chat-mic")));
  check("no speech recognition: Send sits in the slot", await shown(p, ".ai-chat-send"));
});
wcNow = { voiceInput: false };
await run({}, async (p) => {
  await p.waitForTimeout(200);
  check("store turned the talk button off: no mic", !(await p.isVisible(".ai-chat-mic")));
});
wcNow = {};

// Looks right and reads right in both themes
for (const theme of ["dark", "light"]) {
  await run({ theme }, async (p) => {
    await p.evaluate(() => { window.__voice.hold = true; });
    await p.click(".ai-chat-mic"); await p.waitForTimeout(400);
    const look = await p.evaluate(() => { const cs = getComputedStyle(document.querySelector(".ai-chat-mic")); return { bg: cs.backgroundColor, fg: cs.color }; });
    check(`${theme}: listening mic is solid with a clear stop mark`, look.bg !== look.fg && look.bg !== "rgba(0, 0, 0, 0)", JSON.stringify(look));
    const axe = await p.evaluate(async () => { if (!window.axe) { await new Promise((r) => { const s = document.createElement("script"); s.src = "/axe.js"; s.onload = r; s.onerror = r; document.head.appendChild(s); }); } if (!window.axe) return null; const res = await window.axe.run(document.querySelector(".ai-chat-input-area"), { resultTypes: ["violations"] }); return res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id); });
    if (axe !== null) check(`${theme}: listening bar has no serious accessibility issues`, axe.length === 0, axe.join(","));
  });
}

// The store's orb colors reach the page (and are remembered); bad ones fall back
const PICK = ["#112233", "#445566", "#778899", "#aabbcc", "#ddeeff"];
wcNow = { orbColors: PICK, orbBackground: "#f4efe8" };
await run({}, async (p) => {
  await p.waitForTimeout(200);
  const got = await p.evaluate(() => ({ css: [0, 1, 2, 3, 4].map((i) => getComputedStyle(document.querySelector(".ai-chat-panel")).getPropertyValue(`--orb-c${i}`).trim()), cached: localStorage.getItem("hajirai_orb_colors") }));
  check("orb colors: the store's five colors applied", JSON.stringify(got.css) === JSON.stringify(PICK), JSON.stringify(got));
  check("orb colors: remembered for the next page", got.cached === JSON.stringify(PICK), got.cached);
  const bg = await p.evaluate(() => localStorage.getItem("hajirai_orb_bg"));
  check("globe color: the store's color applied and remembered", bg === "#f4efe8", bg);
});
wcNow = { orbColors: ["#112233", "red", "#778899"] };
await run({}, async (p) => {
  await p.waitForTimeout(200);
  const c0 = await p.evaluate(() => getComputedStyle(document.querySelector(".ai-chat-panel")).getPropertyValue("--orb-c0").trim());
  check("orb colors: malformed colors fall back to the defaults", c0 === "#ff1f33", c0);
});
wcNow = {};

console.log(out.join("\n"));
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(`\n${out.length - failed} passed, ${failed} failed`);
await browser.close(); srv.close(); process.exit(failed ? 1 : 0);

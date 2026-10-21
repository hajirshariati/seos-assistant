// Light and dark, every state of the chat: the widget is driven through each
// state (cards, both size pickers, added-to-cart, sold-out, horizontal cards,
// phone, fit tools, support, errors, the sign-up form, See It Styled, talking)
// in both themes, and every visible element is checked on screen — no surface
// in the other theme's color, no unreadable text, no invisible icon, no harsh
// lines. Elements that are ink on purpose (primary buttons, the shopper's
// bubble, badges) are allowed.
//
// Run: node scripts/e2e/widget/themes.mjs [screenshot-dir] [state,state]
import { chromium } from "playwright";
import { start } from "./mock-store.mjs";
const { srv } = await start(4791);
const OUT = process.argv[2] || "", ONLY = (process.argv[3] || "").split(",").filter(Boolean);
const img = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#fff"/><path d="M40 120 Q100 70 165 115 L165 132 L40 132Z" fill="#eee" stroke="#999"/></svg>');
const card = (h, t, extra = {}) => ({ title: t, handle: h, url: "/products/" + h, image: img, price: "129.95", price_formatted: "$129.95", kind: "footwear", ...extra });
const SAVPRE = card("savannah-red", "Savannah Adjustable Quarter Strap Sandal - Red", { preselect: { Size: "8 US", Width: "Medium" }, compare_at_price: 15995 });
const JIL = card("jillian-black", "Jillian Braided Quarter Strap Sandal - Black", { choose: ["Size", "Width"] });
const ORT = card("orthotic-one", "Women's Casual Orthotics", { kind: "orthotic", price: "69.95", price_formatted: "$69.95" });
const ev = (text, products, more = []) => [{ type: "text", text }, ...(products ? [{ type: "products", products }] : []), ...more];
const SSE = {
  one: ev("It's rated 4.3 ⭐ — want help with your size?", [JIL], [{ type: "visualize_cta", productHandle: "jillian-black", productTitle: "Jillian", productImage: img, label: "See It Styled", scenes: null }, { type: "suggestions", questions: ["Find my size", "Does it come in wide?"] }]),
  many: ev("Here are a few picks:\n\n- **Arch support**\n- Memory foam\n\nSee [returns](/pages/returns).", [SAVPRE, JIL, ORT], [{ type: "suggestions", questions: ["Does it come in wide?", "What's your return policy?"] }]),
  orth: ev("This orthotic fits most casual shoes.", [ORT]),
  choices: ev("Who are these for? <<Women>> <<Men>> <<Kids>>"),
  fit: [{ type: "text", text: "That's FIT D." }, { type: "products", products: [] }, { type: "fitfinder_fit", key: "D" }],
  report: ev("Here's how it should fit.", [JIL], [{ type: "fit_report", handle: "jillian-black", productTitle: "Jillian", recommendedSize: "8.5 US", confidence: 82, reasons: ["Runs true to size", "Wide feet sized up"] }]),
  size: [{ type: "text", text: "True Fit can find your size." }, { type: "size_finder", provider: "truefit", handle: "jillian-black", title: "Jillian" }],
  support: [{ type: "text", text: "Our customer service team can help." }, { type: "support_cta", label: "Chat with Aetrex Support", fallbackUrl: "https://help.example" }],
  error: [{ type: "error", message: "I'm having trouble right now. Please try again in a moment." }],
  klaviyo: [{ type: "text", text: "Want early access to new arrivals?" }, { type: "klaviyo_form" }],
  chips: ev("Which style? <<Sneakers>> <<Sandals>> <<Boots>> <<Loafers>> <<Wedges>> <<Mary Janes>> <<Clogs>> <<Slippers>>"),
  viz: ev("Here it is.", [JIL], [{ type: "visualize_cta", productHandle: "jillian-black", productTitle: "Jillian", productImage: img, label: "See It Styled", scenes: null }]),
  orders: ev("Here are your recent orders.", [], [{ type: "order_cards", intent: "track", orders: [
    { id: "5001", number: "1171674", date: "2026-10-14", stage: "delivered", stageLabel: "Delivered", step: 3, deliveredAt: "2026-10-18", eta: "", carrier: "UPS", trackUrl: "https://track.example/1", returnStatus: "", canReturn: true,
      items: [{ lineId: "9001", title: "Savannah Adjustable Quarter Strap Sandal - Red", options: { Size: "8 US", Width: "Medium" }, image: img, quantity: 1, returnable: 1, handle: "savannah-red" }, { lineId: "9002", title: "Women's Casual Orthotics", options: {}, image: "", quantity: 2, returnable: 2, handle: "orthotic-one" }] },
    { id: "5002", number: "1172010", date: "2026-10-20", stage: "shipped", stageLabel: "On its way", step: 1, deliveredAt: "", eta: "2026-10-24", carrier: "USPS", trackUrl: "https://track.example/2", returnStatus: "Return in progress", canReturn: false,
      items: [{ lineId: "9003", title: "Jillian Braided Quarter Strap Sandal - Black", options: { Size: "9 US" }, image: "", quantity: 1, returnable: 1, handle: "jillian-black" }] },
    { id: "5003", number: "1169000", date: "2026-09-02", stage: "cancelled", stageLabel: "Cancelled", step: 0, deliveredAt: "", eta: "", carrier: "", trackUrl: "", returnStatus: "", canReturn: false, items: [{ lineId: "9004", title: "Orthotic Flip Flops", options: {}, image: "", quantity: 1, returnable: 0, handle: "x" }] },
  ] }]),
  signin: ev("Sign in and I'll pull up your orders right here.", [], [{ type: "login_prompt", intent: "track" }]),
};
// scene name -> steps
const SCENES = {
  home: [], menu: ["menu"], one: ["one"], oneAtc: ["one", "atc0"], oneAdded: ["one", "atc0", "pick", "add"],
  many: ["many"], manyAtc: ["many", "atc1"], manyAtcPick: ["many", "atc1", "pick"], manyAdded: ["many", "atc1", "pick", "add"], manySoldOut: ["many", "atc0x"], manyOneTap: ["many", "tap0"],
  orth: ["orth"], orthAdd: ["orth", "tap0"], choices: ["choices"], fit: ["fit"], report: ["report"], size: ["size"], support: ["support"], error: ["error"],
  horiz: ["horiz", "many"], horizAtc: ["horiz", "many", "atc1", "pick"], phoneMany: ["phone", "many"], phoneAtc: ["phone", "many", "atc1", "pick"], phoneOneAtc: ["phone", "one", "atc0", "pick"],
  talk: ["talk"], typed: ["typed"],
  bar: ["noopen"], bubble: ["noopen", "bubble"],
  recording: ["url:/full?hajirai_tester=Ann", "recon"],
  klaviyo: ["kl", "klaviyo"], klaviyoErr: ["kl", "klaviyo", "klbad"], klaviyoDone: ["kl", "klaviyo", "klgood"],
  homeLogged: ["url:/full?login=Dana"], helpersKnown: ["url:/products/savannah-red?tf=known&login=Dana", "fitknown", "reload"],
  typing: ["slowchat", "typing"], cut: ["cut"], e429: ["e429"], thanks: ["one", "thumb"], chips: ["chips"],
  signin: ["signin"], orders: ["orders"], phoneOrders: ["phone", "orders"],
  retItems: ["orders", "ret"], retReason: ["orders", "ret", "retitem", "retnext"], retConfirm: ["orders", "ret", "retitem", "retnext", "retsmall"],
  retDone: ["retok", "orders", "ret", "retitem", "retnext", "retsmall", "retgo"], retErr: ["retbad", "orders", "ret", "retitem", "retnext", "retsmall", "retgo"],
  vizGen: ["vizslow", "viz", "vizgo"], vizDone: ["vizok", "viz", "vizgo", "wait3"], vizErr: ["vizbad", "viz", "vizgo", "wait3"],
};
const probe = () => {
  const theme = document.querySelector(".ai-chat-panel").getAttribute("data-theme");
  const lum = (c) => { const m = c && c.match(/[\d.]+/g); if (!m) return null; const [r, g, b] = m.slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return { L: 0.2126 * r + 0.7152 * g + 0.0722 * b, a: m[3] === undefined ? 1 : Number(m[3]) }; };
  const INK = ".ai-chat-helper__icon, .ai-kl-submit, .ai-chat-wave i, .ai-chat-mic, .ai-chat-send, .ai-chat-msg--user .ai-chat-msg-bubble, .ai-chat-cta-btn, .ai-chat-product-cta, .ai-chat-atc-primary, .ai-chat-atc-add, .ai-chat-atc-check, .ai-chat-fit-result__badge, .ai-chat-avatar-placeholder, .ai-chat-header__avatar, .ai-chat-welcome__avatar, .ai-chat-atc-val.is-on, .ai-chat-viz-opt[aria-pressed=true], .ai-chat-viz-retry, .ai-chat-retry-btn, .ai-chat-fit-bar, .ai-chat-fit-bar *, [class*=confidence] *, .ai-chat-products-arrow, .ai-chat-choices-arrow, .ai-ord__btn.is-primary, .ai-ord__steps, .ai-ret__refund button.is-on, .ai-ret__item.is-on .ai-ret__check";
  const PHOTO = ".ai-chat-product-img, .ai-chat-product-img *, .ai-chat-atc-thumb, .ai-chat-atc-thumb *, img, .ai-chat-viz-result-imgwrap, canvas, .ai-chat-glow";
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); const l = lum(cs.backgroundColor); if (l && l.a > 0.5) return { l: l.L, el: e }; } return { l: theme === "dark" ? 0 : 1, el: document.body }; };
  const nm = (e) => (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : e.tagName.toLowerCase());
  const out = new Set();
  const root = document.querySelector(".ai-chat-panel");
  for (const e of root.querySelectorAll("*")) {
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(e); if (cs.visibility === "hidden" || Number(cs.opacity) < 0.05) continue;
    let hidden = false; for (let a = e; a && a !== root; a = a.parentElement) { const s = getComputedStyle(a); if (Number(s.opacity) < 0.05 || s.display === "none") { hidden = true; break; } } if (hidden) continue;
    const faded = e.closest(".is-out, :disabled, [disabled], .is-stale");
    const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own && !faded) { const fg = lum(cs.color), bg = bgOf(e); if (fg && bg) { const cr = (Math.max(fg.L, bg.l) + 0.05) / (Math.min(fg.L, bg.l) + 0.05); if (cr < 3) out.add(`TEXT ${cr.toFixed(1)} ${nm(e)} on ${nm(bg.el)} "${e.textContent.trim().slice(0, 28)}"`); } }
    if (e.tagName.toLowerCase() === "svg" && !e.closest(".ai-chat-viz-icon") && !e.closest("defs")) {
      const usesCurrent = [...e.querySelectorAll("path,line,polyline,polygon,circle,rect")].some((n) => { const a = getComputedStyle(n); return a.stroke !== "none" || a.fill !== "none"; });
      const fg = lum(cs.color), bg = bgOf(e);
      if (usesCurrent && fg && bg) { const cr = (Math.max(fg.L, bg.l) + 0.05) / (Math.min(fg.L, bg.l) + 0.05); if (cr < 2) out.add(`ICON ${cr.toFixed(1)} svg in ${nm(e.parentElement)} on ${nm(bg.el)}`); }
    }
    if (!e.matches(PHOTO) && !e.matches(INK) && !e.closest(INK)) {
      const b = lum(cs.backgroundColor);
      if (b && b.a > 0.5) { if (theme === "dark" && b.L > 0.45) out.add(`LIGHT-SURFACE ${nm(e)} L=${b.L.toFixed(2)}`); if (theme === "light" && b.L < 0.08) out.add(`DARK-SURFACE ${nm(e)} L=${b.L.toFixed(2)}`); }
      for (const side of ["Top", "Bottom", "Left", "Right"]) { const w = parseFloat(cs[`border${side}Width`]); if (w > 0 && cs[`border${side}Style`] !== "none") { const bc = lum(cs[`border${side}Color`]); if (bc && bc.a > 0.4 && ((theme === "dark" && bc.L > 0.45) || (theme === "light" && bc.L < 0.05 && !e.matches(":focus")))) out.add(`HARSH-LINE ${side} ${nm(e)} L=${bc.L.toFixed(2)}`); } }
      for (const pse of ["::before", "::after"]) { const ps = getComputedStyle(e, pse); if (ps.content !== "none" && ps.display !== "none" && parseFloat(ps.height) <= 2) { const pb = lum(ps.backgroundColor); if (pb && pb.a > 0.4 && theme === "dark" && pb.L > 0.45) out.add(`HARSH-LINE ${pse} ${nm(e)}`); } }
    }
  }
  return [...out];
};
// Hover, keyboard focus and press: every button, link and field in the open
// chat (and the launcher) is put in each state and its text and icons must
// still read against what's behind them.
const tagInteractive = () => {
  document.querySelectorAll("[data-hv]").forEach((e) => e.removeAttribute("data-hv"));
  const sel = "button, a[href], input, textarea, [role=button]";
  let i = 0;
  for (const e of document.querySelectorAll(`.ai-chat-panel :is(${sel}), .ai-chat-launcher :is(${sel})`)) {
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
    let hid = false; for (let a = e; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05) { hid = true; break; } }
    if (hid || e.closest(".is-out, .is-stale") || e.disabled) continue;
    e.setAttribute("data-hv", String(i++));
  }
  return i;
};
const checkOne = ([k, state]) => {
  const el = document.querySelectorAll("[data-hv]")[k]; if (!el) return [];
  const lum = (c) => { const m = c && c.match(/[\d.]+/g); if (!m) return null; const [r, g, b] = m.slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return { L: 0.2126 * r + 0.7152 * g + 0.0722 * b, a: m[3] === undefined ? 1 : Number(m[3]) }; };
  const theme = document.querySelector(".ai-chat-panel").getAttribute("data-theme");
  const bgOf = (e) => { for (let x = e; x; x = x.parentElement) { const l = lum(getComputedStyle(x).backgroundColor); if (l && l.a > 0.5) return l.L; } return theme === "dark" ? 0.008 : 1; };
  const cr = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const nm = (e) => (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : e.tagName.toLowerCase());
  const out = [];
  const nodes = [el, ...el.querySelectorAll("*")];
  for (const n of nodes) {
    const cs = getComputedStyle(n);
    if (cs.visibility === "hidden" || Number(cs.opacity) < 0.05) continue;
    const own = [...n.childNodes].some((t) => t.nodeType === 3 && t.textContent.trim());
    if (own || (n.tagName === "INPUT" && n.value)) { const fg = lum(cs.color); if (fg) { const c = cr(fg.L, bgOf(n)); if (c < 3) out.push(`${state} TEXT ${c.toFixed(1)} ${nm(el)}${n !== el ? " > " + nm(n) : ""} "${(n.value || n.textContent).trim().slice(0, 24)}"`); } }
    if (n.tagName && n.tagName.toLowerCase() === "svg" && !n.closest(".ai-chat-viz-icon")) {
      const paints = [...n.querySelectorAll("path,line,polyline,polygon,circle,rect")].some((q) => { const a = getComputedStyle(q); return (a.stroke !== "none" && /currentcolor|rgb/i.test(a.stroke)) || (a.fill !== "none" && /rgb/i.test(a.fill)); });
      const fg = lum(cs.color); if (paints && fg) { const c = cr(fg.L, bgOf(n)); if (c < 2) out.push(`${state} ICON ${c.toFixed(1)} ${nm(el)}`); }
    }
  }
  if (state === "focus") { const cs = getComputedStyle(el); const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== "none"); if (!ring && !["INPUT", "TEXTAREA"].includes(el.tagName)) out.push(`focus NO-RING ${nm(el)}`); if (ring && cs.outlineStyle !== "none") { const oc = lum(cs.outlineColor); if (oc && cr(oc.L, parseFloat(cs.outlineOffset) < 0 ? bgOf(el) : bgOf(el.parentElement)) < 1.5) out.push(`focus FAINT-RING ${nm(el)}`);
      const grow = parseFloat(cs.outlineOffset) + parseFloat(cs.outlineWidth); const r = el.getBoundingClientRect();
      if (grow > 0) for (let a = el.parentElement; a && a !== document.body && !a.matches(".ai-chat-messages"); a = a.parentElement) { const ac = getComputedStyle(a); if (/(hidden|auto|scroll|clip)/.test(ac.overflowX + ac.overflowY)) { const ar = a.getBoundingClientRect(); if (r.top - grow < ar.top - 0.5 || r.bottom + grow > ar.bottom + 0.5 || (r.left - grow < ar.left - 0.5 && r.left >= ar.left) || (r.right + grow > ar.right + 0.5 && r.right <= ar.right)) { out.push(`focus CLIPPED-RING ${nm(el)} by ${nm(a)}`); } break; } } } }
  return out;
};
const b = await chromium.launch();
const report = [];
for (const theme of ["dark", "light"]) for (const [name, steps] of Object.entries(SCENES)) {
  if (ONLY.length && !ONLY.includes(name)) continue;
  const phone = steps.includes("phone");
  const ctx = await b.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(([t, talk]) => { try { localStorage.setItem("hajirai_theme_pick", t); } catch { /* storage blocked */ }
    if (talk) { class R { start() { setTimeout(() => { const r = [{ transcript: "show me sandals" }]; this.onresult?.({ results: [r] }); }, 300); } stop() {} abort() {} } window.SpeechRecognition = R; window.webkitSpeechRecognition = R; } }, [theme, steps.includes("talk")]);
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.route("**/apps/hajirai/chat**", async (route) => { const k = JSON.parse(route.request().postData() || "{}").message; if (!SSE[k]) return route.continue(); route.fulfill({ status: 200, contentType: "text/event-stream", body: SSE[k].concat([{ type: "done" }]).map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") }); });
  if (steps.includes("horiz")) await p.route("**/products/savannah-red**", async (route) => { const res = await route.fetch(); route.fulfill({ response: res, body: (await res.text()).replace(/"showcase"/g, '"horizontal"') }); });
  if (steps.includes("horiz")) await p.route("**/apps/hajirai/widget-config**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ productCardStyle: "horizontal" }) }));
  if (steps.includes("recon")) await p.route("**/apps/hajirai/widget-config**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ recording: { on: true, scope: "testers" } }) }));
  if (steps.includes("kl")) await p.route("**/apps/hajirai/widget-config**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ klaviyoCompanyId: "ABC123", klaviyoListId: "L1" }) }));
  if (steps.includes("klgood")) await p.route("https://a.klaviyo.com/**", (r) => r.fulfill({ status: 202, body: "" }));
  if (steps.includes("slowchat")) await p.route("**/apps/hajirai/chat**", async () => { await new Promise((res) => setTimeout(res, 20000)); });
  if (steps.includes("e429")) await p.route("**/apps/hajirai/chat**", (r) => r.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "rate_limited", retryAfter: 5 }) }));
  for (const [k, ms, body] of [["vizslow", 30000, { ok: true, imageDataUrl: img }], ["vizok", 300, { ok: true, imageDataUrl: img }], ["vizbad", 300, { ok: false, message: "Could not create the preview right now." }]]) if (steps.includes(k)) await p.route("**/apps/hajirai/visualize**", async (r) => { await new Promise((res) => setTimeout(res, ms)); r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }); });
  if (steps.includes("retok")) await p.route("**/apps/hajirai/returns**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, rma: "R1001", labelUrl: "https://label.example/1", returnsUrl: "https://returns.example/", refundTo: "original_payment", exchangeCards: [{ ...JIL, preselect: { Size: "9.5 US" }, exchange_to: "9.5 US" }] }) }));
  if (steps.includes("retbad")) await p.route("**/apps/hajirai/returns**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, message: "I couldn't start this return here — you can finish it on our returns page.", fallbackUrl: "https://returns.example/" }) }));
  const urlStep = steps.find((x) => x.startsWith("url:"));
  await p.goto("http://localhost:4791" + (urlStep ? urlStep.slice(4) : "/products/savannah-red")); await p.waitForTimeout(500);
  if (!steps.includes("noopen")) { await p.click(".ai-chat-launcher__text"); await p.waitForTimeout(1100); }
  for (const st of steps) {
    if (st === "bubble") { await p.click(".ai-chat-launcher__close"); await p.waitForTimeout(700); }
    if (SSE[st]) { await p.fill(".ai-chat-input", st); await p.keyboard.press("Enter"); await p.waitForTimeout(1200); }
    if (st === "menu") { await p.click(".ai-chat-menu-btn"); await p.waitForTimeout(300); }
    if (st === "atc0") { await p.click(".ai-chat-product-card >> nth=0 >> [data-atc]"); await p.waitForTimeout(600); }
    if (st === "atc1") { await p.click(".ai-chat-product-card >> nth=1 >> [data-atc]"); await p.waitForTimeout(600); }
    if (st === "atc0x") { await p.evaluate(() => { const c = document.querySelectorAll(".ai-chat-product-card")[0]; c.querySelector("[data-atc]")?.click(); }); await p.waitForTimeout(600); await p.evaluate(() => document.querySelector(".ai-chat-atc-val")?.click()); await p.waitForTimeout(300); }
    if (st === "tap0") { await p.click(".ai-chat-product-card >> nth=0 >> [data-atc]"); await p.waitForTimeout(900); }
    if (st === "pick") { for (let gi = 0; gi < 4; gi++) { const ok = await p.evaluate((i) => { const g = document.querySelectorAll(".ai-chat-atc-group")[i]; if (!g) return false; const v = g.querySelector(".ai-chat-atc-val:not(.is-out):not([disabled]):not(.is-on)"); if (v && !g.querySelector(".ai-chat-atc-val.is-on")) v.click(); return true; }, gi); if (!ok) break; await p.waitForTimeout(250); } }
    if (st === "add") { const a = await p.$(".ai-chat-atc-add:not([disabled])"); if (a) { await a.click(); await p.waitForTimeout(900); } }
    if (st === "fitknown") { await p.evaluate(() => { try { sessionStorage.setItem("fitfinder_fit", JSON.stringify({ key: "B", label: "FIT B", code: "00" })); } catch { /* storage blocked */ } }); }
    if (st === "reload") { await p.reload(); await p.waitForTimeout(1200); await p.click(".ai-chat-launcher__text"); await p.waitForTimeout(1100); }
    if (st === "klbad") { await p.fill(".ai-kl-email", "nope"); await p.click(".ai-kl-submit"); await p.waitForTimeout(300); }
    if (st === "klgood") { await p.fill(".ai-kl-email", "a@b.co"); await p.click(".ai-kl-submit"); await p.waitForTimeout(800); }
    if (st === "typing") { await p.fill(".ai-chat-input", "hello"); await p.keyboard.press("Enter"); await p.waitForTimeout(900); }
    if (st === "cut" || st === "e429") { await p.fill(".ai-chat-input", st); await p.keyboard.press("Enter"); await p.waitForTimeout(1500); }
    if (st === "thumb") { await p.click(".ai-chat-fb-btn >> nth=0"); await p.waitForTimeout(400); }
    if (st === "vizgo") { await p.click(".ai-chat-viz-btn"); await p.waitForTimeout(1300); }
    if (st === "wait3") { await p.waitForTimeout(1500); }
    if (st === "talk") { await p.click(".ai-chat-mic"); await p.waitForTimeout(700); }
    if (st === "ret") { await p.click('[data-ord-return="5001"]'); await p.waitForTimeout(300); }
    if (st === "retitem") { await p.click('[data-ret-item="9001"]'); await p.waitForTimeout(200); }
    if (st === "retnext") { await p.click('[data-ret-next="reason"]'); await p.waitForTimeout(200); }
    if (st === "retsmall") { await p.click('[data-ret-reason="too_small"]'); await p.waitForTimeout(300); }
    if (st === "retgo") { await p.click('[data-ret-submit="exchange"]'); await p.waitForTimeout(1200); }
    if (st === "typed") { await p.fill(".ai-chat-input", "red sandals"); await p.waitForTimeout(400); }
  }
  await p.evaluate(() => { const m = document.querySelector(".ai-chat-messages"); if (m) m.scrollTop = m.scrollHeight; });
  await p.waitForTimeout(250);
  const issues = await p.evaluate(probe);
  // the pseudo-state pass
  await p.addStyleTag({ content: "*,*::before,*::after{transition:none!important}" });
  const count = await p.evaluate(tagInteractive);
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-hv]" });
  for (let k = 0; k < Math.min(count, nodeIds.length); k++) {
    for (const [state, forced] of [["hover", ["hover"]], ["focus", ["focus", "focus-visible", "focus-within"]], ["press", ["active", "hover"]]]) {
      await cdp.send("CSS.forcePseudoState", { nodeId: nodeIds[k], forcedPseudoClasses: forced });
      for (const x of await p.evaluate(checkOne, [k, state])) issues.push(x);
      await cdp.send("CSS.forcePseudoState", { nodeId: nodeIds[k], forcedPseudoClasses: [] });
    }
  }
  const pb = steps.includes("noopen") ? await (await p.$(".ai-chat-launcher")).boundingBox() : await (await p.$(".ai-chat-panel")).boundingBox();
  if (OUT) await p.screenshot({ path: `${OUT}/${theme}-${name}.png`, clip: pb });
  report.push(`== ${theme} ${name}${errs.length ? "  JSERR " + errs.join("|") : ""}\n${issues.join("\n")}`);
  await ctx.close();
}
const failed = report.filter((r) => r.split("\n").length > 1 && r.split("\n").slice(1).some(Boolean) || /JSERR/.test(r));
console.log(report.map((r) => (r.split("\n").slice(1).some(Boolean) || /JSERR/.test(r) ? "FAIL " : "OK   ") + r.split("\n")[0].slice(3) + (r.split("\n").slice(1).some(Boolean) ? "\n      " + r.split("\n").slice(1).filter(Boolean).join("\n      ") : "")).join("\n"));
console.log(`\n${report.length - failed.length} passed, ${failed.length} failed`);
await b.close(); srv.close(); process.exit(failed.length ? 1 : 0);

import { useState, useEffect, useRef } from "react";
import { PHASES, STEPS, ATTRIBUTE_MAPPINGS, CADENCE_SECTIONS } from "../lib/onboarding-data";
import seosLogo from "../assets/SEoS.png";

const SUPPORT_EMAIL = "hajiraiapp@gmail.com";

export const meta = () => [
  { title: "Setup guide — SEoS Assistant" },
  { name: "robots", content: "noindex, nofollow" },
  {
    name: "description",
    content:
      "Setup guide for SEoS Assistant — the AI shopping assistant for Shopify stores.",
  },
  { name: "viewport", content: "width=device-width, initial-scale=1" },
];

export const headers = () => ({
  "Cache-Control": "private, no-cache",
});

const STYLES = `
  :root {
    color-scheme: light;
    --bg:            #f6f7f6;
    --bg-card:       #ffffff;
    --bg-muted:      #f1f4f2;
    --bg-cmd:        #12241c;
    --bg-cmd-text:   #d9e8e0;
    --text:          #1a2e26;
    --text-secondary:#36473f;
    --text-muted:    #5e6f67;
    --text-faint:    #8a978f;
    --border:        rgba(26,46,38,0.10);
    --border-strong: rgba(26,46,38,0.20);
    --border-soft:   rgba(26,46,38,0.06);
    --accent:        #2d6b4f;
    --accent-soft:   rgba(45,107,79,0.08);
    --accent-border: rgba(45,107,79,0.30);
    --accent-hover:  #245a42;
    --accent-on:     #ffffff;
    --tip-bg:        #fffbeb;
    --tip-text:      #78350f;
    --tip-strong:    #92400e;
    --tip-border:    #f59e0b;
    --code-bg:       rgba(45,107,79,0.08);
    --code-text:     #2d6b4f;
    --shadow-card:   0 1px 2px rgba(26,46,38,0.05);
    --shadow-hover:  0 10px 26px rgba(26,46,38,0.10), 0 2px 6px rgba(26,46,38,0.06);
  }
  [data-theme="dark"] {
    color-scheme: dark;
    --bg:            #0b1220;
    --bg-card:       #101a2b;
    --bg-muted:      #131c2e;
    --bg-cmd:        #050a14;
    --bg-cmd-text:   #d9e8e0;
    --text:          #f3f4f6;
    --text-secondary:#d1d5db;
    --text-muted:    #9ca3af;
    --text-faint:    #6b7280;
    --border:        rgba(255,255,255,0.10);
    --border-strong: rgba(255,255,255,0.22);
    --border-soft:   rgba(255,255,255,0.06);
    --accent:        #4ade80;
    --accent-soft:   rgba(74,222,128,0.10);
    --accent-border: rgba(74,222,128,0.35);
    --accent-hover:  #22c55e;
    --accent-on:     #0b1220;
    --tip-bg:        #2a1f05;
    --tip-text:      #fde68a;
    --tip-strong:    #fcd34d;
    --tip-border:    #f59e0b;
    --code-bg:       rgba(74,222,128,0.12);
    --code-text:     #4ade80;
    --shadow-card:   0 1px 2px rgba(0,0,0,0.3);
    --shadow-hover:  0 10px 26px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.3);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI",
                 Roboto, "Helvetica Neue", Arial, sans-serif;
    color: var(--text);
    background: var(--bg);
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    transition: background 0.18s ease, color 0.18s ease;
  }

  /* ── Globe backdrop — fixed to the viewport's top-right corner,
        behind everything, like the admin home. ────────────────── */
  .globe-bg {
    position: fixed;
    top: -300px;
    right: -200px;
    z-index: 0;
    pointer-events: none;
  }
  @media (max-width: 1000px) {
    .globe-bg { display: none; }
  }
  .page { position: relative; z-index: 1; }

  /* ── Hero — centered, animated, Apple-clean. ──────────────── */
  .hero {
    position: relative;
    padding: 64px 24px 28px;
    text-align: center;
  }
  .hero-inner {
    max-width: 880px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .hero-brand {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    margin-bottom: 18px;
    opacity: 0;
    animation: rise 0.55s cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
  }
  .hero-brand img { display: block; height: 26px; width: auto; cursor: pointer; }
  .hero-brand-name {
    font-size: 11.5px;
    font-weight: 650;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    color: var(--accent);
  }
  .hero h1 {
    margin: 0 0 14px;
    font-size: clamp(28px, 4.5vw, 40px);
    font-weight: 650;
    letter-spacing: -0.5px;
    line-height: 1.15;
    color: var(--text);
    opacity: 0;
    animation: rise 0.55s cubic-bezier(0.2, 0.7, 0.2, 1) 0.1s forwards;
  }
  .hero p {
    margin: 0;
    max-width: 600px;
    font-size: 15.5px;
    color: var(--text-muted);
    opacity: 0;
    animation: rise 0.55s cubic-bezier(0.2, 0.7, 0.2, 1) 0.22s forwards;
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(10px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* ── SEoS glow + acronym reveal ───────────────────────────── */
  .seos {
    position: relative;
    color: var(--accent);
    font-weight: 700;
  }
  [data-theme="dark"] .seos {
    text-shadow:
      0 0 14px rgba(74, 222, 128, 0.45),
      0 0 28px rgba(74, 222, 128, 0.22),
      0 0 56px rgba(74, 222, 128, 0.10);
    transition: text-shadow 0.25s ease;
  }
  [data-theme="dark"] .seos:hover {
    text-shadow:
      0 0 12px rgba(74, 222, 128, 0.75),
      0 0 32px rgba(74, 222, 128, 0.45),
      0 0 64px rgba(74, 222, 128, 0.22);
  }
  .seos.is-boosted { animation: seos-boost 1.6s ease-out; }
  @keyframes seos-boost {
    0%   { text-shadow: 0 0 0 rgba(74, 222, 128, 0); }
    25%  { text-shadow: 0 0 24px rgba(74, 222, 128, 1), 0 0 48px rgba(74, 222, 128, 0.7), 0 0 96px rgba(74, 222, 128, 0.4); }
    100% { text-shadow: 0 0 14px rgba(74, 222, 128, 0.45), 0 0 28px rgba(74, 222, 128, 0.22), 0 0 56px rgba(74, 222, 128, 0.10); }
  }

  /* ── Theme toggle (fixed top-right) ───────────────────────── */
  .theme-toggle {
    position: fixed;
    top: 18px;
    right: 20px;
    z-index: 5;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 7px 14px 7px 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
    cursor: pointer;
    box-shadow: var(--shadow-card);
    transition: all 0.15s ease;
    font-family: inherit;
  }
  .theme-toggle:hover {
    border-color: var(--accent-border);
    color: var(--text);
    transform: translateY(-1px);
    box-shadow: var(--shadow-hover);
  }
  .theme-toggle svg { width: 16px; height: 16px; flex-shrink: 0; }

  /* ── Container ────────────────────────────────────────────── */
  .container { max-width: 880px; margin: 0 auto; padding: 0 24px; }
  main { padding: 8px 0 80px; }

  /* ── Phase navigator — centered white pills. ──────────────── */
  .phase-nav {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    padding: 18px 0 30px;
    opacity: 0;
    animation: rise 0.55s cubic-bezier(0.2, 0.7, 0.2, 1) 0.32s forwards;
  }
  .phase-tab {
    flex-shrink: 0;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 9px 16px;
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    box-shadow: var(--shadow-card);
    transition: all 0.15s ease;
    font-family: inherit;
  }
  .phase-tab:hover {
    border-color: var(--accent-border);
    color: var(--text);
    transform: translateY(-1px);
    box-shadow: var(--shadow-hover);
  }
  .phase-tab[aria-selected="true"] {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-on);
    box-shadow: 0 4px 14px rgba(45,107,79,0.30);
  }
  .phase-tab[aria-selected="true"]:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .phase-tab .num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    font-weight: 700;
  }
  .phase-tab[aria-selected="true"] .num {
    background: rgba(255,255,255,0.22);
    color: var(--accent-on);
  }

  /* ── Phase intro — text left, illustration right. ─────────── */
  .phase-intro {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    margin: 0 0 22px;
    padding: 22px 24px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: var(--shadow-card);
  }
  .phase-intro-text { min-width: 0; }
  .phase-intro h2 {
    margin: 0 0 6px;
    font-size: 21px;
    font-weight: 650;
    letter-spacing: -0.2px;
    color: var(--text);
  }
  .phase-intro h2 .phase-kicker {
    display: block;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1.2px;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 4px;
  }
  .phase-intro p {
    margin: 0;
    color: var(--text-muted);
    font-size: 14.5px;
  }
  .phase-intro-art { flex-shrink: 0; }
  .phase-intro-art svg {
    display: block;
    width: 190px;
    height: auto;
    border-radius: 12px;
  }
  @media (max-width: 640px) {
    .phase-intro-art { display: none; }
  }

  .cadence-section {
    margin: 30px 0 14px;
    padding: 0 0 8px;
    border-bottom: 1px solid var(--border);
  }
  .cadence-section:first-of-type { margin-top: 8px; }
  .cadence-section h3 {
    margin: 0 0 4px;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--accent);
  }
  .cadence-section p {
    margin: 0;
    font-size: 13px;
    color: var(--text-muted);
  }

  /* ── Step list — soft cards with hover lift. ──────────────── */
  .steps { display: flex; flex-direction: column; gap: 10px; }
  .step {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-card);
    transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
  }
  .step:hover {
    border-color: var(--accent-border);
    box-shadow: var(--shadow-hover);
    transform: translateY(-1px);
  }
  .step[data-open="true"], .step:has(details[open]) {
    border-color: var(--accent-border);
    transform: none;
  }

  .step-summary {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 16px 18px;
    cursor: pointer;
    list-style: none;
    user-select: none;
  }
  .step-summary::-webkit-details-marker { display: none; }
  .step-num {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 12px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .step-text { flex: 1; min-width: 0; }
  .step-title {
    font-size: 15px;
    font-weight: 600;
    margin: 2px 0 0;
    color: var(--text);
    letter-spacing: -0.005em;
  }
  .step-short {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 4px 0 0;
  }
  .step-chevron {
    flex-shrink: 0;
    margin-top: 6px;
    color: var(--text-faint);
    transition: transform 0.15s;
  }
  details[open] > .step-summary .step-chevron {
    transform: rotate(90deg);
    color: var(--accent);
  }

  .step-detail {
    padding: 4px 20px 20px 58px;
    border-top: 1px solid var(--border-soft);
    margin-top: 0;
  }
  .step-body {
    color: var(--text-secondary);
    font-size: 14.5px;
    margin: 16px 0 12px;
  }
  .step-detail ul {
    margin: 8px 0;
    padding-left: 18px;
    color: var(--text-secondary);
    font-size: 14px;
  }
  .step-detail li { margin: 5px 0; }
  @media (max-width: 640px) {
    .step-detail { padding-left: 20px; }
  }

  /* ── Tip ──────────────────────────────────────────────────── */
  .tip {
    margin-top: 14px;
    padding: 12px 14px;
    background: var(--tip-bg);
    border-left: 3px solid var(--tip-border);
    border-radius: 6px;
    font-size: 13.5px;
    color: var(--tip-text);
  }
  .tip strong { color: var(--tip-strong); font-weight: 600; }

  /* ── Command block ────────────────────────────────────────── */
  .cmd-block {
    margin: 14px 0;
    padding: 14px 16px;
    background: var(--bg-cmd);
    color: var(--bg-cmd-text);
    border-radius: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    line-height: 1.65;
    overflow-x: auto;
    white-space: pre;
  }

  /* ── Reference table ──────────────────────────────────────── */
  .ref-table {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 10px;
    border-collapse: separate;
    border-spacing: 0;
    overflow: hidden;
    margin: 14px 0;
  }
  .ref-table th, .ref-table td {
    text-align: left;
    padding: 11px 14px;
    font-size: 13.5px;
    border-bottom: 1px solid var(--border);
  }
  .ref-table th {
    background: var(--bg-muted);
    font-weight: 600;
    color: var(--text-secondary);
    font-size: 12px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .ref-table tr:last-child td { border-bottom: none; }
  .ref-table code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px;
    background: var(--code-bg);
    padding: 2px 6px;
    border-radius: 3px;
    color: var(--code-text);
    white-space: nowrap;
  }
  @media (max-width: 700px) {
    .ref-table-wrap { overflow-x: auto; }
  }

  /* ── Help block ───────────────────────────────────────────── */
  .help {
    margin-top: 56px;
    padding: 22px 24px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 12px;
    background: var(--bg-card);
    box-shadow: var(--shadow-card);
  }
  .help h3 {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 650;
    color: var(--text);
  }
  .help p {
    margin: 0;
    font-size: 14px;
    color: var(--text-secondary);
  }
  .help a {
    color: var(--accent);
    text-decoration: none;
    font-weight: 500;
  }
  .help a:hover { text-decoration: underline; }

  /* ── Footer ───────────────────────────────────────────────── */
  footer.foot {
    border-top: 1px solid var(--border);
    padding: 24px;
    text-align: center;
    color: var(--text-faint);
    font-size: 13px;
    position: relative;
    z-index: 1;
  }
  footer.foot .links {
    display: inline-flex;
    gap: 20px;
    flex-wrap: wrap;
    justify-content: center;
    margin-bottom: 6px;
  }
  footer.foot a {
    color: var(--text-muted);
    text-decoration: none;
  }
  footer.foot a:hover { color: var(--accent); }

  /* ── Easter-egg chat bubble — a miniature of the storefront
        widget, popping up bottom-right when the logo is
        triple-clicked. Click to dismiss; auto-hides. ───────────── */
  .egg-chat {
    position: fixed;
    right: 24px;
    bottom: 24px;
    z-index: 50;
    width: 290px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: 0 18px 44px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10);
    overflow: hidden;
    cursor: pointer;
    animation: egg-pop 0.4s cubic-bezier(0.2, 0.9, 0.3, 1.2);
  }
  @keyframes egg-pop {
    from { opacity: 0; transform: translateY(16px) scale(0.94); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  .egg-chat-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: var(--accent);
  }
  .egg-chat-head img { height: 18px; width: auto; display: block; }
  .egg-chat-head span:first-of-type {
    font-size: 12.5px;
    font-weight: 650;
    color: var(--accent-on);
    letter-spacing: 0.2px;
    flex: 1;
  }
  .egg-chat-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #7CF2AE;
    box-shadow: 0 0 0 3px rgba(124,242,174,0.25);
  }
  .egg-chat-body {
    padding: 13px 14px 14px;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--text-secondary);
  }

  @media (prefers-reduced-motion: reduce) {
    .hero-brand, .hero h1, .hero p, .phase-nav { animation: none; opacity: 1; transform: none; }
    .phase-tab, .step, .theme-toggle { transition: none; }
    .egg-chat { animation: none; }
  }
`;

// Inline script that runs BEFORE React hydrates so the saved theme
// applies on first paint — no flash on first load. Defaults to dark
// (the brand default for this internal page); a stored preference
// from a prior visit always wins.
const THEME_INIT_SCRIPT = `
  (function () {
    try {
      var stored = localStorage.getItem("aetrex-onboarding-theme");
      document.documentElement.setAttribute("data-theme", stored || "dark");
    } catch (e) { document.documentElement.setAttribute("data-theme", "dark"); }
  })();
`;

// ---------------------------------------------------------------------------
// Globe — the slow-spinning dotted sphere, pinned to the viewport's
// top-right corner behind the content. Quiet grey-sage dots, plus a
// "setup mode" layer: individual nodes keep coming online — a random dot
// lights up brand green, emits a soft expanding ping ring, then settles
// back down — like systems booting one by one. `boostRef` lets the page
// trigger a brief hyper-spin (easter egg). Respects prefers-reduced-motion
// with a single static frame.
// ---------------------------------------------------------------------------
function Globe({ size = 820, points = 1700, theme = "light", boostRef = null }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const N = points;
    const pts = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      pts.push([Math.cos(th) * r, y, Math.sin(th) * r]);
    }

    const R = size / 2 - 10;
    const cx = size / 2;
    const cy = size / 2;
    const tilt = -0.4;
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);
    const dark = theme === "dark";
    // Per-frame projected coordinates, reused by the blip pass.
    const px = new Float32Array(N);
    const py = new Float32Array(N);
    const pd = new Float32Array(N);
    // Nodes currently "coming online".
    const blips = [];
    let lastSpawn = 0;

    const drawFrame = (rot, tMs) => {
      ctx.clearRect(0, 0, size, size);
      const grad = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.1, cx, cy, R);
      if (dark) {
        grad.addColorStop(0, "rgba(74,222,128,0.07)");
        grad.addColorStop(0.7, "rgba(74,222,128,0.03)");
        grad.addColorStop(1, "rgba(74,222,128,0)");
      } else {
        grad.addColorStop(0, "rgba(255,255,255,0.85)");
        grad.addColorStop(0.75, "rgba(255,255,255,0.35)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();

      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);
      const dotScale = Math.max(1, size / 280) * 0.75;
      for (let i = 0; i < N; i++) {
        const [x, y, z] = pts[i];
        const xr = x * cosR + z * sinR;
        const zr = -x * sinR + z * cosR;
        const yr = y * cosT - zr * sinT;
        const zt = y * sinT + zr * cosT;
        const depth = (zt + 1) / 2;
        const sx = cx + xr * R;
        const sy = cy + yr * R;
        px[i] = sx; py[i] = sy; pd[i] = depth;
        // Grey-sage on light (visible on the grey page background),
        // soft green on dark.
        ctx.fillStyle = dark
          ? `rgba(74,222,128,${0.05 + depth * 0.24})`
          : `rgba(101,117,109,${0.04 + depth * 0.15})`;
        ctx.beginPath();
        ctx.arc(sx, sy, (0.6 + depth * 1.25) * dotScale, 0, Math.PI * 2);
        ctx.fill();
      }

      // Setup-mode blips: spawn a node every ~300ms, let it flare brand
      // green with an expanding ping ring, then fade. Front hemisphere
      // only, so the effect reads as activity ON the visible sphere.
      if (tMs - lastSpawn > 300 && blips.length < 9) {
        lastSpawn = tMs;
        blips.push({ idx: Math.floor(Math.random() * N), born: tMs, life: 1500 + Math.random() * 1300 });
      }
      const coreColor = dark ? "74,222,128" : "45,107,79";
      for (let b = blips.length - 1; b >= 0; b--) {
        const age = (tMs - blips[b].born) / blips[b].life;
        if (age >= 1) { blips.splice(b, 1); continue; }
        const i = blips[b].idx;
        if (pd[i] < 0.45) continue; // node is on the far side right now
        const env = age < 0.22 ? age / 0.22 : 1 - (age - 0.22) / 0.78;
        // Lit core.
        ctx.fillStyle = `rgba(${coreColor},${(0.85 * env).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(px[i], py[i], (1.6 + pd[i] * 1.6) * dotScale, 0, Math.PI * 2);
        ctx.fill();
        // Expanding ping ring.
        ctx.strokeStyle = `rgba(${coreColor},${(0.4 * (1 - age)).toFixed(3)})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(px[i], py[i], 4 + age * 22, 0, Math.PI * 2);
        ctx.stroke();
      }
    };

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduced) {
      drawFrame(0.6, 0);
      return undefined;
    }
    let raf;
    let last = 0;
    let rot = 0.6;
    const loop = (t) => {
      const dt = last ? Math.min(t - last, 100) : 16;
      last = t;
      // Glacial spin — one rotation every ~3.5 minutes — unless the
      // easter egg kicked the engine, in which case it sprints for a
      // few seconds and settles back down.
      const boostedAgo = boostRef ? t - (boostRef.current || -1e9) : Infinity;
      const speed = boostedAgo < 4000 ? 1 + 11 * (1 - boostedAgo / 4000) : 1;
      rot += dt * 0.00003 * speed;
      drawFrame(rot, t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [size, points, theme, boostRef]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{ width: size, height: size, display: "block" }}
    />
  );
}

// ---------------------------------------------------------------------------
// Phase illustrations — the same hand-built vector language as the admin
// home cards: soft green gradient backdrop, floating white panels with drop
// shadows, slight tilts, brand-green accents. One small scene per phase.
// Fixed light palette by design — on the dark theme they read as image
// blocks, like photos in a dark UI.
// ---------------------------------------------------------------------------
function IllInstall() {
  return (
    <svg viewBox="0 0 260 160" role="presentation" focusable="false">
      <defs>
        <linearGradient id="oi-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#DCEEE5" /><stop offset="1" stopColor="#F4FAF7" />
        </linearGradient>
        <filter id="oi-sh" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="5" stdDeviation="7" floodColor="#1a2e26" floodOpacity="0.13" />
        </filter>
      </defs>
      <rect width="260" height="160" rx="16" fill="url(#oi-bg)" />
      <circle cx="232" cy="20" r="36" fill="rgba(58,138,102,0.10)" />
      <g filter="url(#oi-sh)" transform="rotate(-2 120 88)">
        <rect x="42" y="40" width="150" height="96" rx="12" fill="#fff" />
        <circle cx="68" cy="66" r="9" fill="none" stroke="#2D6B4F" strokeWidth="2.6" />
        <rect x="75" y="63.5" width="26" height="5" rx="2.5" fill="#2D6B4F" />
        <rect x="92" y="68" width="4" height="7" rx="1.5" fill="#2D6B4F" />
        <rect x="114" y="60" width="62" height="9" rx="4.5" fill="#E4ECE8" />
        <rect x="58" y="92" width="120" height="9" rx="4.5" fill="#E4ECE8" />
        <rect x="58" y="110" width="86" height="9" rx="4.5" fill="#EDF3F0" />
      </g>
      <g filter="url(#oi-sh)">
        <rect x="176" y="22" width="68" height="28" rx="14" fill="#2D6B4F" />
        <path d="M188 36 l4 4 L200 31" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <text x="206" y="40.5" fontSize="11.5" fontWeight="700" fill="#fff">Live</text>
      </g>
    </svg>
  );
}

function IllConfigure() {
  const row = (y) => (
    <g key={y}>
      <rect x="50" y={y} width="58" height="20" rx="6" fill="#EDF3F0" />
      <rect x="58" y={y + 6.5} width="42" height="7" rx="3.5" fill="#C9DCD3" />
      <path d={`M116 ${y + 10} h22 m-6 -5 l6 5 -6 5`} stroke="#3a8a66" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="146" y={y} width="64" height="20" rx="10" fill="#E7F3ED" stroke="#2D6B4F" strokeWidth="1.4" />
      <rect x="158" y={y + 6.5} width="40" height="7" rx="3.5" fill="#7FB59C" />
    </g>
  );
  return (
    <svg viewBox="0 0 260 160" role="presentation" focusable="false">
      <defs>
        <linearGradient id="oc-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#E0EFE8" /><stop offset="1" stopColor="#F5FBF8" />
        </linearGradient>
        <filter id="oc-sh" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="5" stdDeviation="7" floodColor="#1a2e26" floodOpacity="0.13" />
        </filter>
      </defs>
      <rect width="260" height="160" rx="16" fill="url(#oc-bg)" />
      <circle cx="28" cy="140" r="38" fill="rgba(58,138,102,0.08)" />
      <g filter="url(#oc-sh)">
        <rect x="34" y="28" width="192" height="108" rx="12" fill="#fff" />
        {row(44)}{row(72)}{row(100)}
      </g>
    </svg>
  );
}

function IllIntegrate() {
  return (
    <svg viewBox="0 0 260 160" role="presentation" focusable="false">
      <defs>
        <linearGradient id="og-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#DEEFE6" /><stop offset="1" stopColor="#F4FAF7" />
        </linearGradient>
        <filter id="og-sh" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="5" stdDeviation="7" floodColor="#1a2e26" floodOpacity="0.13" />
        </filter>
      </defs>
      <rect width="260" height="160" rx="16" fill="url(#og-bg)" />
      <path d="M76 50 C100 60 110 70 126 80 M76 110 C100 100 110 90 126 80 M196 46 C170 58 152 70 134 80 M196 116 C170 104 152 92 134 80"
        stroke="#3a8a66" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeDasharray="0.1 7" />
      <g filter="url(#og-sh)">
        <circle cx="130" cy="80" r="22" fill="#2D6B4F" />
        <path d="M122 80 l5.5 5.5 L139 73" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <g filter="url(#og-sh)">
        <rect x="30" y="36" width="48" height="28" rx="9" fill="#fff" />
        <circle cx="44" cy="50" r="5.5" fill="#F5C84C" />
        <rect x="54" y="46.5" width="16" height="7" rx="3.5" fill="#E4ECE8" />
      </g>
      <g filter="url(#og-sh)">
        <rect x="30" y="96" width="48" height="28" rx="9" fill="#fff" />
        <circle cx="44" cy="110" r="5.5" fill="#7C9CF5" />
        <rect x="54" y="106.5" width="16" height="7" rx="3.5" fill="#E4ECE8" />
      </g>
      <g filter="url(#og-sh)">
        <rect x="186" y="32" width="48" height="28" rx="9" fill="#fff" />
        <circle cx="200" cy="46" r="5.5" fill="#E58A6E" />
        <rect x="210" y="42.5" width="16" height="7" rx="3.5" fill="#E4ECE8" />
      </g>
      <g filter="url(#og-sh)">
        <rect x="186" y="102" width="48" height="28" rx="9" fill="#fff" />
        <circle cx="200" cy="116" r="5.5" fill="#8FC6AC" />
        <rect x="210" y="112.5" width="16" height="7" rx="3.5" fill="#E4ECE8" />
      </g>
    </svg>
  );
}

function IllLaunch() {
  return (
    <svg viewBox="0 0 260 160" role="presentation" focusable="false">
      <defs>
        <linearGradient id="ol-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#DCEEE5" /><stop offset="1" stopColor="#F5FBF8" />
        </linearGradient>
        <linearGradient id="ol-img" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#BFE0D1" /><stop offset="1" stopColor="#8FC6AC" />
        </linearGradient>
        <filter id="ol-sh" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="5" stdDeviation="7" floodColor="#1a2e26" floodOpacity="0.13" />
        </filter>
      </defs>
      <rect width="260" height="160" rx="16" fill="url(#ol-bg)" />
      <g filter="url(#ol-sh)">
        <rect x="38" y="26" width="148" height="112" rx="12" fill="#fff" />
        <rect x="50" y="38" width="124" height="40" rx="8" fill="url(#ol-img)" />
        <rect x="50" y="88" width="80" height="8" rx="4" fill="#D8E2DD" />
        <rect x="50" y="104" width="56" height="8" rx="4" fill="#E4ECE8" />
        <rect x="50" y="120" width="40" height="9" rx="4.5" fill="#2D6B4F" opacity="0.85" />
      </g>
      <g filter="url(#ol-sh)">
        <circle cx="206" cy="114" r="26" fill="#2D6B4F" />
        <path d="M196 110 a10 8 0 1 1 4 12 l-6 4 2 -7" fill="#fff" />
        <circle cx="226" cy="92" r="9" fill="#fff" stroke="#2D6B4F" strokeWidth="2" />
        <text x="226" y="96" textAnchor="middle" fontSize="10" fontWeight="700" fill="#2D6B4F">1</text>
      </g>
    </svg>
  );
}

function IllMaintain() {
  return (
    <svg viewBox="0 0 260 160" role="presentation" focusable="false">
      <defs>
        <linearGradient id="om-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#E0EFE8" /><stop offset="1" stopColor="#F5FBF8" />
        </linearGradient>
        <linearGradient id="om-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2D6B4F" stopOpacity="0.22" />
          <stop offset="1" stopColor="#2D6B4F" stopOpacity="0.02" />
        </linearGradient>
        <filter id="om-sh" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="5" stdDeviation="7" floodColor="#1a2e26" floodOpacity="0.13" />
        </filter>
      </defs>
      <rect width="260" height="160" rx="16" fill="url(#om-bg)" />
      <g filter="url(#om-sh)">
        <rect x="36" y="30" width="152" height="104" rx="12" fill="#fff" />
        <path d="M52 108 C72 76 86 112 104 92 C120 76 140 86 172 60 L172 120 L52 120 Z" fill="url(#om-area)" />
        <path d="M52 108 C72 76 86 112 104 92 C120 76 140 86 172 60" stroke="#2D6B4F" strokeWidth="2.6" fill="none" strokeLinecap="round" />
        <circle cx="172" cy="60" r="4.5" fill="#2D6B4F" />
        <rect x="52" y="44" width="56" height="8" rx="4" fill="#D8E2DD" />
      </g>
      <g filter="url(#om-sh)">
        <rect x="176" y="92" width="58" height="52" rx="10" fill="#fff" />
        <rect x="176" y="92" width="58" height="16" rx="8" fill="#2D6B4F" />
        <circle cx="190" cy="120" r="3.5" fill="#BFD8CC" />
        <circle cx="204" cy="120" r="3.5" fill="#BFD8CC" />
        <circle cx="218" cy="120" r="3.5" fill="#2D6B4F" />
        <circle cx="190" cy="132" r="3.5" fill="#BFD8CC" />
        <circle cx="204" cy="132" r="3.5" fill="#BFD8CC" />
      </g>
    </svg>
  );
}

const PHASE_ART = {
  install: <IllInstall />,
  configure: <IllConfigure />,
  integrate: <IllIntegrate />,
  launch: <IllLaunch />,
  maintain: <IllMaintain />,
};

function groupByPhase(steps) {
  const groups = {};
  for (const step of steps) {
    if (!groups[step.phase]) groups[step.phase] = [];
    groups[step.phase].push(step);
  }
  return PHASES.filter((p) => groups[p.id]?.length > 0).map((p) => ({
    ...p,
    steps: groups[p.id],
  }));
}

// Maintain phase has too many steps to read flat — group by cadence
// (Weekly / Monthly / Quarterly / As-needed / Reference) so the user
// knows what to do when. Order is determined by CADENCE_SECTIONS.
function renderMaintainSteps(steps) {
  const buckets = new Map(CADENCE_SECTIONS.map((s) => [s.id, []]));
  const other = [];
  for (const step of steps) {
    if (step.cadence && buckets.has(step.cadence)) buckets.get(step.cadence).push(step);
    else other.push(step);
  }
  const sections = CADENCE_SECTIONS
    .map((s) => ({ ...s, steps: buckets.get(s.id) }))
    .filter((s) => s.steps.length > 0);
  if (other.length > 0) sections.push({ id: "other", label: "Other", blurb: "", steps: other });

  let runningIdx = 0;
  return (
    <>
      {sections.map((section) => (
        <div key={section.id}>
          <div className="cadence-section">
            <h3>{section.label}</h3>
            {section.blurb ? <p>{section.blurb}</p> : null}
          </div>
          <ol className="steps" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {section.steps.map((step) => {
              const stepIdx = runningIdx++;
              return (
                <li className="step" key={`maintain-${stepIdx}`}>
                  <details>
                    <summary className="step-summary">
                      <span className="step-num" aria-hidden="true">{String(stepIdx + 1).padStart(2, "0")}</span>
                      <div className="step-text">
                        <p className="step-title">{step.title}</p>
                        <p className="step-short">{step.short}</p>
                      </div>
                      <svg className="step-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </summary>
                    <div className="step-detail">
                      <p className="step-body">{step.body}</p>
                      {step.list ? (
                        <ul>
                          {step.list.map((item, j) => (<li key={j}>{item}</li>))}
                        </ul>
                      ) : null}
                      {step.commands ? (
                        <pre className="cmd-block" aria-label="Terminal commands">
                          {step.commands.map((c) => `$ ${c}`).join("\n")}
                        </pre>
                      ) : null}
                      {step.tip ? (
                        <div className="tip"><strong>Tip:</strong> {step.tip}</div>
                      ) : null}
                    </div>
                  </details>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </>
  );
}

export default function Onboarding() {
  const grouped = groupByPhase(STEPS);
  const [activeId, setActiveId] = useState(grouped[0]?.id || "");
  const active = grouped.find((p) => p.id === activeId) || grouped[0];
  const activeIndex = grouped.findIndex((p) => p.id === activeId);

  // Theme: the inline THEME_INIT_SCRIPT below sets data-theme on
  // <html> before React hydrates, so first paint is correct. We
  // sync React state from that on mount, then write back to both
  // documentElement and localStorage on change.
  const [theme, setTheme] = useState("dark");
  useEffect(() => {
    if (typeof document === "undefined") return;
    const initial = document.documentElement.getAttribute("data-theme") || "dark";
    setTheme(initial);
  }, []);
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("aetrex-onboarding-theme", theme); } catch { /* ignore */ }
  }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  // ── Hidden surface for the curious ───────────────────────────
  // Four subtle eggs, none visible without poking around:
  //   1. Console boot banner with ASCII "SEoS" + the acronym + a
  //      welcome line. Stripe-style — only devs who open DevTools
  //      ever see it.
  //   2. Konami code → triggers a glow pulse on "SEoS" and a
  //      console message. Click on the SEoS word does the same so
  //      keyboard-less users can stumble onto it too.
  //   3. Type the word "hajir" anywhere on the page → the globe
  //      sprints for a few seconds (the engine literally gets a shot
  //      of hajir energy), the SEoS word pulses, and the console confirms.
  //   4. Triple-click the logo in the header → a miniature chat
  //      bubble pops up bottom-right, the assistant introducing
  //      itself the way it does to shoppers on the storefront.
  const [boosted, setBoosted] = useState(false);
  const globeBoostRef = useRef(-1e9);
  useEffect(() => {
    if (boosted) {
      const t = setTimeout(() => setBoosted(false), 1700);
      return () => clearTimeout(t);
    }
  }, [boosted]);

  // Egg 4 state — the pop-up assistant bubble.
  const EGG_LINES = [
    "Hi, I'm SEoS 👋 I help shoppers find the right product before they finish typing.",
    "Three clicks? You'd make a great QA tester. Everything I say is fact-checked against the live catalog first.",
    "I never guess. If a product fact isn't in the catalog, it doesn't leave my mouth.",
  ];
  const [eggMsg, setEggMsg] = useState(null);
  const logoClicks = useRef({ n: 0, t: 0 });
  const onLogoClick = () => {
    const now = Date.now();
    if (now - logoClicks.current.t > 1500) logoClicks.current.n = 0;
    logoClicks.current.t = now;
    logoClicks.current.n += 1;
    if (logoClicks.current.n >= 3) {
      logoClicks.current.n = 0;
      setEggMsg(EGG_LINES[Math.floor(Math.random() * EGG_LINES.length)]);
    }
  };
  useEffect(() => {
    if (eggMsg) {
      const t = setTimeout(() => setEggMsg(null), 8000);
      return () => clearTimeout(t);
    }
  }, [eggMsg]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Egg 1 — console boot banner. Only fires once per page load.
    const banner = [
      "%c   ____   _____      ____  ",
      "  / ___| | ____|___  / ___| ",
      "  \\___ \\ |  _| / _ \\ \\___ \\ ",
      "   ___) || |__| (_) | ___) |",
      "  |____(_)_____\\___(_)____(_)",
      "",
      "  Search Engine on Steroids · SEoS Assistant",
      "  Built with caffeine and a stubborn refusal to ship hallucinations.",
      "  Curious how it works? See app/lib/chat-tools.server.js",
      "",
    ].join("\n");
    // eslint-disable-next-line no-console
    console.log(banner, "color:#4ade80;font-family:ui-monospace,monospace;font-size:11px;line-height:1.3");

    // Egg 2 — Konami code. ↑↑↓↓←→←→ B A
    // Egg 3 — typing "hajir" hyper-spins the globe.
    const KONAMI = ["ArrowUp","ArrowUp","ArrowDown","ArrowDown","ArrowLeft","ArrowRight","ArrowLeft","ArrowRight","b","a"];
    let pos = 0;
    let typed = "";
    const onKey = (e) => {
      const k = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === KONAMI[pos]) {
        pos++;
        if (pos === KONAMI.length) {
          pos = 0;
          setBoosted(true);
          globeBoostRef.current = performance.now();
          // eslint-disable-next-line no-console
          console.log("%c💪 Steroids engaged — search engine boosted.", "color:#4ade80;font-weight:700;font-size:13px");
        }
      } else {
        pos = k === KONAMI[0] ? 1 : 0;
      }
      if (e.key && e.key.length === 1) {
        typed = (typed + e.key.toLowerCase()).slice(-12);
        if (typed.endsWith("hajir")) {
          typed = "";
          setBoosted(true);
          globeBoostRef.current = performance.now();
          // eslint-disable-next-line no-console
          console.log("%c🌍 Hajir would be proud. Engine spinning at full search speed.", "color:#4ade80;font-weight:700;font-size:13px");
        }
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />

      <div className="globe-bg" aria-hidden="true">
        <Globe size={820} points={1700} theme={theme} boostRef={globeBoostRef} />
      </div>

      <button
        type="button"
        className="theme-toggle"
        onClick={toggleTheme}
        aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      >
        {theme === "dark" ? (
          // Sun icon — currently in dark mode, click to go light
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </svg>
        ) : (
          // Moon icon — currently in light mode, click to go dark
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        )}
        <span>{theme === "dark" ? "Light" : "Dark"} mode</span>
      </button>

      <div className="page">
        <header className="hero">
          <div className="hero-inner">
            <div className="hero-brand">
              <img src={seosLogo} alt="SEoS" onClick={onLogoClick} />
              <span className="hero-brand-name">SEoS Assistant · Setup guide</span>
            </div>
            <h1>
              {"Set up your "}
              <span
                className={"seos" + (boosted ? " is-boosted" : "")}
                onClick={() => setBoosted(true)}
              >
                SEoS
              </span>
              {" Assistant."}
            </h1>
            <p>
              Everything to install, configure, launch, and maintain the AI
              shopping assistant on your Shopify store. A first install
              typically takes under an hour end to end.
            </p>
          </div>
        </header>

        <main>
          <div className="container">
            <nav className="phase-nav" role="tablist" aria-label="Setup phases">
              {grouped.map((phase, idx) => (
                <button
                  key={phase.id}
                  role="tab"
                  aria-selected={phase.id === activeId}
                  className="phase-tab"
                  onClick={() => setActiveId(phase.id)}
                  type="button"
                >
                  <span className="num">{idx + 1}</span>
                  <span>{phase.name}</span>
                </button>
              ))}
            </nav>

            {active ? (
              <section aria-labelledby={`phase-${active.id}-heading`}>
                <header className="phase-intro">
                  <div className="phase-intro-text">
                    <h2 id={`phase-${active.id}-heading`}>
                      <span className="phase-kicker">Phase {activeIndex + 1} of {grouped.length}</span>
                      {active.name}
                    </h2>
                    <p>{active.description}</p>
                  </div>
                  <div className="phase-intro-art" aria-hidden="true">
                    {PHASE_ART[active.id] || null}
                  </div>
                </header>

                {active.id === "maintain" ? renderMaintainSteps(active.steps) : (
                <ol className="steps" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {active.steps.map((step, stepIdx) => (
                    <li className="step" key={`${active.id}-${stepIdx}`}>
                      <details>
                        <summary className="step-summary">
                          <span className="step-num" aria-hidden="true">
                            {String(stepIdx + 1).padStart(2, "0")}
                          </span>
                          <div className="step-text">
                            <p className="step-title">{step.title}</p>
                            <p className="step-short">{step.short}</p>
                          </div>
                          <svg
                            className="step-chevron"
                            width="16"
                            height="16"
                            viewBox="0 0 16 16"
                            fill="none"
                            aria-hidden="true"
                          >
                            <path
                              d="M6 4l4 4-4 4"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </summary>
                        <div className="step-detail">
                          <p className="step-body">{step.body}</p>
                          {step.list ? (
                            <ul>
                              {step.list.map((item, j) => (
                                <li key={j}>{item}</li>
                              ))}
                            </ul>
                          ) : null}
                          {step.showAttributeTable ? (
                            <div className="ref-table-wrap">
                              <table className="ref-table">
                                <thead>
                                  <tr>
                                    <th>Source (Shopify)</th>
                                    <th>Maps to</th>
                                    <th>Notes</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {ATTRIBUTE_MAPPINGS.map((m) => (
                                    <tr key={m.attribute}>
                                      <td><code>{m.source}</code></td>
                                      <td><code>{m.attribute}</code></td>
                                      <td>{m.note}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : null}
                          {step.commands ? (
                            <pre className="cmd-block" aria-label="Terminal commands">
                              {step.commands.map((c) => `$ ${c}`).join("\n")}
                            </pre>
                          ) : null}
                          {step.tip ? (
                            <div className="tip">
                              <strong>Tip:</strong> {step.tip}
                            </div>
                          ) : null}
                        </div>
                      </details>
                    </li>
                  ))}
                </ol>
                )}
              </section>
            ) : null}

            <aside className="help">
              <h3>Need help?</h3>
              <p>
                Email{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>{" "}
                with your shop domain and a screenshot of what you&apos;re seeing.
                Common issues — catalog stuck syncing, fit predictor at 0%
                confidence, VIP mode not personalizing — are usually fixed in
                under 24 hours.
              </p>
            </aside>
          </div>
        </main>

        <footer className="foot">
          <div className="links">
            <a href={`mailto:${SUPPORT_EMAIL}`}>Email support</a>
            <a href="/privacy">Privacy</a>
            <a href="/app" target="_blank" rel="noopener noreferrer">Open admin</a>
          </div>
          <div>© HajirAi · SEoS Assistant</div>
        </footer>
      </div>

      {eggMsg ? (
        <div className="egg-chat" role="status" onClick={() => setEggMsg(null)}>
          <div className="egg-chat-head">
            <img src={seosLogo} alt="" aria-hidden="true" />
            <span>SEoS Assistant</span>
            <span className="egg-chat-dot" aria-hidden="true" />
          </div>
          <div className="egg-chat-body">{eggMsg}</div>
        </div>
      ) : null}
    </>
  );
}

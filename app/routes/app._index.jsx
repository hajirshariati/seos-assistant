import { useEffect, useMemo, useRef, useState } from "react";
import { useLoaderData, useFetcher, Link } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Box,
  Button,
  Icon,
  Badge,
  Banner,
} from "@shopify/polaris";
import { CheckCircleIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, getKnowledgeFiles, updateShopConfig } from "../models/ShopConfig.server";
import { getCatalogSyncState, syncCatalogAsync } from "../models/Product.server";
import { countEnrichmentsByShop } from "../models/ProductEnrichment.server";
import { getUsageSummary, getDailySeries } from "../models/ChatUsage.server";
import { getFeedbackSummary } from "../models/ChatFeedback.server";
import { getConversionSummary, getConversionDailySeries } from "../models/ChatConversion.server";
import { listDecisionTrees } from "../models/DecisionTree.server";
import seosLogo from "../assets/SEoS.png";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const [config, files, syncState, enrichmentCount, usage, feedback, conversions, decisionTrees, dailySeries, conversionSeries] = await Promise.all([
    getShopConfig(session.shop),
    getKnowledgeFiles(session.shop),
    getCatalogSyncState(session.shop),
    countEnrichmentsByShop(session.shop),
    getUsageSummary(session.shop, 30),
    getFeedbackSummary(session.shop, 30),
    getConversionSummary(session.shop, 30),
    listDecisionTrees(session.shop).catch(() => []),
    getDailySeries(session.shop, 30).catch(() => []),
    getConversionDailySeries(session.shop, 30).catch(() => []),
  ]);

  if (!syncState.lastSyncedAt && syncState.status !== "running") {
    syncCatalogAsync(admin, session.shop);
  }

  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const rateLimitHits = config.rateLimitHitsMonth === currentMonth ? (config.rateLimitHits || 0) : 0;

  // The chat widget pings /widget-config on every storefront page load when
  // the app embed is enabled. If we've heard from it in the last 7 days, the
  // embed is currently active in the merchant's theme. 7 days tolerates a
  // store with very low traffic without flipping back to "undone" the moment
  // a quiet weekend passes.
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const widgetEnabled =
    Boolean(config.lastWidgetSeenAt) &&
    Date.now() - new Date(config.lastWidgetSeenAt).getTime() < SEVEN_DAYS;

  // Catalog freshness: anything older than 7 days suggests the
  // merchant changed inventory but the sync didn't run. Surfaces in
  // the status cluster as 'Stale' to prompt a manual sync from
  // Catalog → Refresh.
  const lastSyncedAt = syncState.lastSyncedAt
    ? new Date(syncState.lastSyncedAt).toISOString()
    : null;
  const hoursSinceSync = lastSyncedAt
    ? Math.round((Date.now() - new Date(lastSyncedAt).getTime()) / 3_600_000)
    : null;

  // Recommender status: master toggle ON + at least one enabled
  // recommender row. The toggle alone isn't enough — a shop with
  // no enabled trees yet should show 'Off' on the cluster.
  const enabledRecommenderCount = (decisionTrees || []).filter((t) => t?.enabled).length;
  const recommenderActive =
    config.decisionTreeEnabled === true && enabledRecommenderCount > 0;

  return {
    hasApiKey: config.anthropicApiKey !== "",
    fileCount: files.length,
    shop: session.shop,
    themeEditorUrl: `https://${session.shop}/admin/themes/current/editor?context=apps`,
    widgetEnabled,
    productsCount: syncState.productsCount || 0,
    enrichmentCount,
    totalCost: usage.totalCost,
    totalMessages: usage.totalMessages,
    avgCostPerMessage: usage.avgCostPerMessage,
    feedbackTotal: feedback.total,
    satisfactionRate: feedback.satisfactionRate,
    conversionCount: conversions.count,
    conversionRevenue: conversions.revenue,
    conversionCurrency: conversions.currency,
    modelStrategy: config.modelStrategy || "smart",
    rateLimitHits,
    semanticEnabled: !!(config.embeddingProvider && (
      (config.embeddingProvider === "voyage" && config.voyageApiKey) ||
      (config.embeddingProvider === "openai" && config.openaiApiKey)
    )),
    semanticProvider: config.embeddingProvider || "",
    categoryGroupsCount: (() => {
      try { return (JSON.parse(config.categoryGroups || "[]") || []).length; } catch { return 0; }
    })(),
    // Status-cluster fields
    catalogSyncStatus: syncState.status || "idle",
    lastSyncedAt,
    hoursSinceSync,
    recommenderActive,
    enabledRecommenderCount,
    // 30-day daily series for the metric strip sparklines / detail charts
    dailySeries,
    conversionSeries,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("intent") === "dismiss_rate_limit") {
    await updateShopConfig(session.shop, { rateLimitHits: 0, rateLimitHitsMonth: "" });
    return { dismissed: true };
  }
  return null;
};

function formatCost(n) {
  if (!n) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatRevenue(n, currency) {
  const code = (currency && String(currency).trim()) || "USD";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      maximumFractionDigits: n >= 1000 ? 0 : 2,
    }).format(n || 0);
  } catch {
    return `${code} ${(n || 0).toFixed(2)}`;
  }
}

// ---------------------------------------------------------------------------
// Globe — slow-spinning dotted sphere on a <canvas>, drawn in brand greens.
// Points are distributed with a Fibonacci sphere, rotated around Y with a
// gentle axial tilt, and projected orthographically. Front-facing dots are
// brighter and larger; back-facing dots fade out, which is what reads as a
// 3-D globe without any 3-D library. Respects prefers-reduced-motion by
// rendering one static frame.
// ---------------------------------------------------------------------------
function Globe({ size = 280, points = 800, dim = 1, variant = "brand" }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const N = points;
    const pts = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      // Every third dot carries the brand-green accent in the subtle
      // palette; the rest stay white so the globe reads as a quiet
      // background texture, not a graphic competing with content.
      pts.push([Math.cos(th) * r, y, Math.sin(th) * r, i % 3 === 0]);
    }
    const R = size / 2 - 10;
    const cx = size / 2;
    const cy = size / 2;
    const tilt = -0.4;
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);

    const subtle = variant === "subtle";
    const drawFrame = (rot) => {
      ctx.clearRect(0, 0, size, size);
      // Soft inner sphere shading so the dot field sits on a body. The
      // subtle palette uses a white sheen (a quiet lighter orb on the
      // grey admin background, like Shopify's); the brand palette uses
      // the green tint.
      const grad = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.1, cx, cy, R);
      if (subtle) {
        grad.addColorStop(0, `rgba(255,255,255,${0.70 * dim})`);
        grad.addColorStop(0.75, `rgba(255,255,255,${0.28 * dim})`);
        grad.addColorStop(1, "rgba(255,255,255,0)");
      } else {
        grad.addColorStop(0, `rgba(58,138,102,${0.16 * dim})`);
        grad.addColorStop(0.7, `rgba(45,107,79,${0.08 * dim})`);
        grad.addColorStop(1, `rgba(45,107,79,${0.02 * dim})`);
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();

      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);
      // Dot radius scales gently with globe size so a viewport-sized
      // globe doesn't render pin-prick dots.
      const dotScale = Math.max(1, size / 280) * 0.75;
      for (const [x, y, z] of pts) {
        // Spin around Y, then tilt around X.
        const xr = x * cosR + z * sinR;
        const zr = -x * sinR + z * cosR;
        const yr = y * cosT - zr * sinT;
        const zt = y * sinT + zr * cosT;
        const depth = (zt + 1) / 2; // 0 = back, 1 = front
        const sx = cx + xr * R;
        const sy = cy + yr * R;
        if (subtle) {
          // Single colour — pure white dots, low-alpha. Quiet texture
          // on the grey admin canvas; never competes with content.
          ctx.fillStyle = `rgba(255,255,255,${(0.22 + depth * 0.66) * dim})`;
        } else {
          const alpha = (0.06 + depth * 0.78) * dim;
          ctx.fillStyle = depth > 0.72
            ? `rgba(58,138,102,${alpha})`
            : `rgba(45,107,79,${alpha})`;
        }
        ctx.beginPath();
        ctx.arc(sx, sy, (0.6 + depth * 1.25) * dotScale, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduced) {
      drawFrame(0.6);
      return undefined;
    }
    let raf;
    const loop = (t) => {
      // Glacial spin — one full rotation every ~3.5 minutes. The globe
      // is ambience; you should sense the motion, not watch it.
      drawFrame(t * 0.00003);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [size, points, dim, variant]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{ width: size, height: size, display: "block" }}
    />
  );
}

// ---------------------------------------------------------------------------
// Sparkline — tiny inline area chart used inside each metric cell.
// ---------------------------------------------------------------------------
function Sparkline({ points, width = 104, height = 28, id }) {
  if (!points || points.length < 2) return <div style={{ width, height }} />;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);
  const coords = points.map((v, i) => [
    i * stepX,
    height - 3 - ((v - min) / range) * (height - 6),
  ]);
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const gid = `seos-spark-${id}`;
  return (
    <svg width={width} height={height} aria-hidden="true" style={{ display: "block" }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2D6B4F" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#2D6B4F" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke="#2D6B4F" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// DetailChart — the large area chart revealed when a metric is hovered.
// Includes a hover crosshair that snaps to the nearest day and shows the
// exact value, so the strip works as a real mini-dashboard, not decoration.
// ---------------------------------------------------------------------------
function DetailChart({ metric }) {
  const [hover, setHover] = useState(null);
  const series = metric.series || [];
  const W = 1000;
  const H = 220;
  const PAD = 12;
  const values = series.map((p) => p.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = (W - PAD * 2) / Math.max(series.length - 1, 1);
  const coords = values.map((v, i) => [
    PAD + i * stepX,
    H - 24 - ((v - min) / range) * (H - 52),
  ]);
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${W - PAD},${H - 18} L${PAD},${H - 18} Z`;

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const idx = Math.max(0, Math.min(series.length - 1, Math.round(frac * (series.length - 1))));
    setHover(idx);
  };

  const fmtDay = (d) => {
    try {
      return new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
    } catch {
      return d;
    }
  };

  const hovered = hover !== null ? series[hover] : null;

  return (
    <div className="seos-detail-inner">
      <div className="seos-detail-head">
        <div>
          <div className="seos-detail-label">{metric.label} · last 30 days</div>
          <div className="seos-detail-value">{metric.value}</div>
          {metric.sublabel ? <div className="seos-detail-sub">{metric.sublabel}</div> : null}
        </div>
        {hovered ? (
          <div className="seos-detail-readout">
            <span className="seos-detail-readout-date">{fmtDay(hovered.date)}</span>
            <span className="seos-detail-readout-value">{metric.format(hovered.value)}</span>
          </div>
        ) : (
          <div className="seos-detail-readout seos-detail-readout-hint">Hover the chart for daily detail</div>
        )}
      </div>
      <div className="seos-detail-chart" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height: "100%" }}>
          <defs>
            <linearGradient id="seos-detail-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2D6B4F" stopOpacity="0.30" />
              <stop offset="100%" stopColor="#2D6B4F" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={PAD} x2={W - PAD} y1={28 + (H - 52) * f} y2={28 + (H - 52) * f} stroke="rgba(0,0,0,0.06)" strokeWidth="1" />
          ))}
          <path d={area} fill="url(#seos-detail-fill)" />
          <path d={line} fill="none" stroke="#2D6B4F" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {hovered && coords[hover] ? (
            <line x1={coords[hover][0]} x2={coords[hover][0]} y1={20} y2={H - 18} stroke="rgba(45,107,79,0.45)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
          ) : null}
        </svg>
        {hovered && coords[hover] ? (
          // The SVG stretches non-uniformly (preserveAspectRatio="none"),
          // which would squash a <circle> into an ellipse — so the hover
          // dot is an HTML overlay positioned in percent space instead.
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              left: `${(coords[hover][0] / W) * 100}%`,
              top: `${(coords[hover][1] / H) * 100}%`,
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "#2D6B4F",
              border: "2px solid #fff",
              boxShadow: "0 0 0 3px rgba(45,107,79,0.18)",
              transform: "translate(-50%, -50%)",
              pointerEvents: "none",
            }}
          />
        ) : null}
      </div>
      <div className="seos-detail-axis">
        <span>{series.length > 0 ? fmtDay(series[0].date) : ""}</span>
        <Link to="/app/analytics" className="seos-detail-link">View detailed analytics →</Link>
        <span>{series.length > 0 ? fmtDay(series[series.length - 1].date) : ""}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MetricStrip — Shopify-style compact stats bar pinned to the top of the
// page: small label over value + tiny sparkline, no card chrome. Hovering
// a metric opens a floating dropdown OVERLAY with the full 30-day chart —
// it doesn't push page content, so an accidental open never reflows the
// page — and a 160ms hover-intent delay means brushing the mouse across
// the strip doesn't trigger it. The dropdown keeps rendering the last
// active metric while fading out so the close animation doesn't snap.
// ---------------------------------------------------------------------------
function MetricStrip({ metrics }) {
  const [active, setActive] = useState(null);
  const [lastActive, setLastActive] = useState(0);
  const openTimer = useRef(null);
  const closeTimer = useRef(null);

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  const requestOpen = (i) => {
    clearTimers();
    // Panel already open → switch metrics instantly; the delay only
    // guards the initial open against drive-by hovers.
    if (active !== null) {
      setActive(i);
      setLastActive(i);
      return;
    }
    openTimer.current = setTimeout(() => {
      setActive(i);
      setLastActive(i);
    }, 160);
  };
  const openNow = (i) => {
    clearTimers();
    setActive(i);
    setLastActive(i);
  };
  const cancelPendingOpen = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
  };
  const scheduleClose = () => {
    clearTimers();
    closeTimer.current = setTimeout(() => setActive(null), 200);
  };
  useEffect(() => () => clearTimers(), []);

  return (
    <div
      className="seos-metrics-wrap"
      onMouseLeave={scheduleClose}
      onMouseEnter={() => closeTimer.current && clearTimeout(closeTimer.current)}
    >
      <div className="seos-metrics" role="group" aria-label="Last 30 days at a glance">
        {metrics.map((m, i) => (
          <button
            key={m.label}
            type="button"
            title={`${m.label} — last 30 days`}
            className={"seos-metric" + (active === i ? " is-active" : "")}
            onMouseEnter={() => requestOpen(i)}
            onMouseLeave={cancelPendingOpen}
            onFocus={() => openNow(i)}
            onClick={() => openNow(i)}
          >
            <span className="seos-metric-label">{m.label}</span>
            <span className="seos-metric-row">
              <span className="seos-metric-value">{m.value}</span>
              <Sparkline points={(m.series || []).map((p) => p.value)} width={52} height={18} id={i} />
            </span>
          </button>
        ))}
      </div>
      <div className={"seos-metric-detail" + (active !== null ? " is-open" : "")} aria-hidden={active === null}>
        {metrics[active !== null ? active : lastActive] ? (
          <DetailChart metric={metrics[active !== null ? active : lastActive]} />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusCluster — the engine's gauge cluster. One segmented instrument bar;
// each segment links to the page that manages it and the tooltip carries
// the detail. A verdict line appears ONLY when something needs attention —
// when every gauge is green, the gauges say it and an extra "all systems
// running" line would just be noise.
// ---------------------------------------------------------------------------
function StatusCluster({ items }) {
  const TONE = {
    success:  { dot: "#2D6B4F", cls: "" },
    subdued:  { dot: "#C2C9C5", cls: " seos-pip-off" },
    warning:  { dot: "#B98900", cls: " seos-pip-warn" },
    critical: { dot: "#D72C0D", cls: " seos-pip-crit" },
  };
  const attention = items.filter((it) => it.tone === "warning" || it.tone === "critical");
  const hasCritical = items.some((it) => it.tone === "critical");
  return (
    <div className="seos-status-wrap">
      {attention.length > 0 ? (
        <div className="seos-status-summary">
          <span
            aria-hidden="true"
            className={"seos-status-summary-dot" + (hasCritical ? " is-crit" : " is-warn")}
          />
          <span>
            {attention.length} system{attention.length > 1 ? "s" : ""} need
            {attention.length > 1 ? "" : "s"} attention
          </span>
        </div>
      ) : null}
      <div role="group" aria-label="System status" className="seos-status-bar">
        {items.map((it) => {
          const t = TONE[it.tone] || TONE.subdued;
          const isAttention = it.tone === "warning" || it.tone === "critical";
          const labelText = `${it.label}${isAttention ? ` · ${it.value}` : ""}`;
          const tooltip = `${it.label}: ${it.value}${it.tooltip ? " — " + it.tooltip : ""}`;
          const className = "seos-pip" + t.cls;
          const inner = (
            <>
              <span
                aria-hidden="true"
                className={it.tone === "critical" ? "seos-pip-dot seos-pip-pulse" : "seos-pip-dot"}
                style={{ background: t.dot }}
              />
              <span className="seos-pip-label">{labelText}</span>
            </>
          );
          if (!it.url) {
            return <span key={it.label} className={className} title={tooltip}>{inner}</span>;
          }
          if (it.external) {
            return (
              <a key={it.label} className={className} href={it.url} target="_blank" rel="noopener noreferrer" title={tooltip}>
                {inner}
              </a>
            );
          }
          return (
            <Link key={it.label} className={className} to={it.url} title={tooltip}>{inner}</Link>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TestChat — Shopify-style "ask anything" box in the centre of the home
// page. It talks to the EXACT engine customers get: the input posts to
// /chat with an App Bridge session token, and the action runs the same
// shared handler as the storefront widget (same prompt, same tools,
// same grounding validator). The conversation panel expands above the
// input on first send and streams the reply token by token.
// ---------------------------------------------------------------------------
function TestChat({ shop }) {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const listRef = useRef(null);
  const sessionIdRef = useRef(`admin-test-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [msgs]);

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    // History mirrors the widget contract: assistant turns carry their
    // displayed product cards so the engine can resolve "the first one".
    const history = msgs
      .filter((m) => !m.error)
      .map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.role === "assistant" && m.products?.length
          ? {
              products: m.products.slice(0, 10).map((p) => ({
                handle: p.handle || "",
                title: p.title || "",
                url: p.url || "",
                image: p.image || "",
                price: p.price || "",
                price_formatted: p.price_formatted || "",
              })),
            }
          : {}),
      }))
      .slice(-20);
    setMsgs((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "", products: [], pending: true },
    ]);
    setStreaming(true);

    const setLast = (patch) =>
      setMsgs((prev) => {
        const next = prev.slice();
        next[next.length - 1] = { ...next[next.length - 1], ...patch };
        return next;
      });

    try {
      // /chat authenticates the admin via an App Bridge session token in
      // the Authorization header (the storefront widget uses the app
      // proxy instead). Ask App Bridge for the token explicitly so this
      // works regardless of its fetch-patching behaviour.
      const headers = { "Content-Type": "application/json", Accept: "text/event-stream" };
      try {
        if (window.shopify?.idToken) {
          headers.Authorization = `Bearer ${await window.shopify.idToken()}`;
        }
      } catch { /* fall through — App Bridge fetch patching may still cover us */ }
      const res = await fetch("/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: text,
          session_id: sessionIdRef.current,
          shop_domain: shop,
          history,
        }),
      });
      const ct = res.headers.get("content-type") || "";
      if (!res.ok || !ct.includes("text/event-stream")) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.message || d.error || "The assistant couldn't reply. Please try again.");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let full = "";
      let prods = [];
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") { finished = true; break; }
          let p;
          try { p = JSON.parse(data); } catch { continue; }
          if (p.type === "text" || p.type === "content_block_delta") {
            full += p.text || p.delta?.text || "";
          } else if (p.type === "products" && p.products) {
            prods = prods.concat(p.products);
          } else if (p.type === "error") {
            throw new Error(p.message || "The assistant hit an error.");
          } else if (p.type === "done") {
            finished = true;
            break;
          }
        }
        setLast({ content: full, products: prods });
      }
      setLast({ content: full || "(no reply)", products: prods, pending: false });
    } catch (err) {
      setLast({
        content: err?.message || "Something went wrong. Please try again.",
        pending: false,
        error: true,
      });
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div className="seos-testchat">
      {msgs.length > 0 ? (
        <div className="seos-testchat-panel" ref={listRef}>
          {msgs.map((m, i) => (
            <div key={i} className={"seos-testchat-row " + (m.role === "user" ? "is-user" : "is-bot")}>
              <div className={"seos-testchat-bubble" + (m.error ? " is-error" : "")}>
                {m.pending && !m.content ? (
                  <span className="seos-testchat-typing" aria-label="Assistant is typing">
                    <span /><span /><span />
                  </span>
                ) : (
                  m.content
                )}
                {m.products?.length > 0 ? (
                  <div className="seos-testchat-prods">
                    {m.products.slice(0, 6).map((p) => (
                      <a
                        key={p.handle || p.title}
                        href={p.url || "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="seos-testchat-prod"
                      >
                        {p.image ? <img src={p.image} alt="" /> : null}
                        <span className="seos-testchat-prod-title">{p.title}</span>
                        {p.price_formatted ? (
                          <span className="seos-testchat-prod-price">{p.price_formatted}</span>
                        ) : null}
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <form
        className="seos-testchat-input"
        onSubmit={(e) => { e.preventDefault(); send(); }}
      >
        <img src={seosLogo} alt="" aria-hidden="true" className="seos-testchat-avatar" />
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Test your assistant — ask anything, just like a customer…"
          aria-label="Test your assistant"
        />
        <button type="submit" disabled={!input.trim() || streaming} aria-label="Send">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
            <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </form>
      {msgs.length > 0 ? (
        <div className="seos-testchat-note">
          Live engine — same answers your customers get on the storefront.
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card illustrations — hand-built vector scenes in the Shopify-home style:
// a soft green gradient backdrop, floating white panels with drop shadows,
// slight rotations for depth, brand-green accents. Vector keeps them crisp
// at any DPI and on-brand without an asset pipeline. Each uses a unique
// ID prefix so the six <defs> blocks don't collide on one page.
// ---------------------------------------------------------------------------
function ArtSetup() {
  return (
    <svg viewBox="0 0 340 210" role="presentation" focusable="false">
      <defs>
        <linearGradient id="su-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#DCEEE5" />
          <stop offset="1" stopColor="#F4FAF7" />
        </linearGradient>
        <filter id="su-sh" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="6" stdDeviation="9" floodColor="#1a2e26" floodOpacity="0.13" />
        </filter>
      </defs>
      <rect width="340" height="210" rx="20" fill="url(#su-bg)" />
      <circle cx="306" cy="26" r="48" fill="rgba(58,138,102,0.10)" />
      <g filter="url(#su-sh)" transform="rotate(-3 170 115)">
        <rect x="62" y="42" width="204" height="150" rx="14" fill="#fff" />
        <rect x="82" y="60" width="92" height="9" rx="4.5" fill="#C9DCD3" />
        <circle cx="93" cy="95" r="10" fill="#2D6B4F" />
        <path d="M88 95 l3.5 3.5 L98.5 91" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="112" y="90" width="118" height="9" rx="4.5" fill="#E4ECE8" />
        <circle cx="93" cy="128" r="10" fill="#2D6B4F" />
        <path d="M88 128 l3.5 3.5 L98.5 124" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="112" y="123" width="96" height="9" rx="4.5" fill="#E4ECE8" />
        <circle cx="93" cy="161" r="10" fill="#2D6B4F" />
        <path d="M88 161 l3.5 3.5 L98.5 157" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="112" y="156" width="132" height="9" rx="4.5" fill="#E4ECE8" />
      </g>
      <g filter="url(#su-sh)">
        <rect x="240" y="22" width="80" height="32" rx="16" fill="#2D6B4F" />
        <path d="M254 38 l4.5 4.5 L268 32.5" stroke="#fff" strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <text x="277" y="43" fontSize="13" fontWeight="700" fill="#fff">Live</text>
      </g>
    </svg>
  );
}

function ArtAnalytics() {
  return (
    <svg viewBox="0 0 340 210" role="presentation" focusable="false">
      <defs>
        <linearGradient id="an-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#E2F0E9" />
          <stop offset="1" stopColor="#F5FBF8" />
        </linearGradient>
        <linearGradient id="an-panel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2D6B4F" />
          <stop offset="1" stopColor="#235843" />
        </linearGradient>
        <linearGradient id="an-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.02" />
        </linearGradient>
        <filter id="an-sh" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="6" stdDeviation="9" floodColor="#1a2e26" floodOpacity="0.14" />
        </filter>
      </defs>
      <rect width="340" height="210" rx="20" fill="url(#an-bg)" />
      <g filter="url(#an-sh)">
        <rect x="86" y="36" width="254" height="174" rx="18" fill="url(#an-panel)" />
        <line x1="104" y1="84" x2="322" y2="84" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
        <line x1="104" y1="124" x2="322" y2="124" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
        <line x1="104" y1="164" x2="322" y2="164" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
        <path d="M104 170 C136 122 158 178 192 140 C220 110 252 130 318 88 L318 196 L104 196 Z" fill="url(#an-area)" />
        <path d="M104 170 C136 122 158 178 192 140 C220 110 252 130 318 88" stroke="#fff" strokeWidth="3.6" fill="none" strokeLinecap="round" />
        <circle cx="192" cy="140" r="5.5" fill="#fff" />
        <circle cx="318" cy="88" r="5.5" fill="#fff" />
      </g>
      <g filter="url(#an-sh)">
        <rect x="34" y="58" width="106" height="38" rx="11" fill="#fff" />
        <circle cx="52" cy="77" r="6" fill="#3a8a66" />
        <rect x="64" y="68" width="62" height="7" rx="3.5" fill="#D8E2DD" />
        <rect x="64" y="81" width="44" height="7" rx="3.5" fill="#E7EEEA" />
      </g>
      <g filter="url(#an-sh)">
        <rect x="232" y="16" width="80" height="32" rx="16" fill="#fff" />
        <text x="272" y="37" textAnchor="middle" fontSize="13" fontWeight="700" fill="#2D6B4F">+24%</text>
      </g>
    </svg>
  );
}

function ArtKnowledge() {
  return (
    <svg viewBox="0 0 340 210" role="presentation" focusable="false">
      <defs>
        <linearGradient id="kn-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#DFEFE7" />
          <stop offset="1" stopColor="#F4FAF7" />
        </linearGradient>
        <filter id="kn-sh" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="6" stdDeviation="9" floodColor="#1a2e26" floodOpacity="0.13" />
        </filter>
      </defs>
      <rect width="340" height="210" rx="20" fill="url(#kn-bg)" />
      <circle cx="42" cy="180" r="52" fill="rgba(58,138,102,0.08)" />
      <g transform="rotate(6 230 120)">
        <rect x="172" y="56" width="112" height="142" rx="12" fill="#fff" opacity="0.75" />
      </g>
      <g filter="url(#kn-sh)">
        <rect x="86" y="44" width="134" height="158" rx="12" fill="#fff" />
        <rect x="102" y="64" width="70" height="9" rx="4.5" fill="#C9DCD3" />
        <rect x="102" y="86" width="100" height="7" rx="3.5" fill="#E4ECE8" />
        <rect x="102" y="100" width="88" height="7" rx="3.5" fill="#E4ECE8" />
        <rect x="102" y="114" width="100" height="7" rx="3.5" fill="#E4ECE8" />
        <rect x="102" y="128" width="64" height="7" rx="3.5" fill="#E4ECE8" />
        <rect x="102" y="152" width="100" height="7" rx="3.5" fill="#EDF3F0" />
        <rect x="102" y="166" width="76" height="7" rx="3.5" fill="#EDF3F0" />
        <circle cx="200" cy="62" r="14" fill="#2D6B4F" />
        <path d="M200 53.5 l2.3 5.9 5.9 2.3 -5.9 2.3 -2.3 5.9 -2.3 -5.9 -5.9 -2.3 5.9 -2.3 Z" fill="#fff" />
      </g>
      <g filter="url(#kn-sh)">
        <rect x="206" y="148" width="112" height="36" rx="12" fill="#fff" />
        <rect x="218" y="157" width="36" height="18" rx="5" fill="#2D6B4F" />
        <text x="236" y="170" textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff">CSV</text>
        <path d="M264 166 l4 4 L276 161" stroke="#3a8a66" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="284" y="162" width="22" height="7" rx="3.5" fill="#D8E2DD" />
      </g>
    </svg>
  );
}

function ArtRecommenders() {
  return (
    <svg viewBox="0 0 340 210" role="presentation" focusable="false">
      <defs>
        <linearGradient id="re-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#E0EFE8" />
          <stop offset="1" stopColor="#F5FBF8" />
        </linearGradient>
        <linearGradient id="re-img" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#BFE0D1" />
          <stop offset="1" stopColor="#8FC6AC" />
        </linearGradient>
        <filter id="re-sh" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="6" stdDeviation="9" floodColor="#1a2e26" floodOpacity="0.13" />
        </filter>
      </defs>
      <rect width="340" height="210" rx="20" fill="url(#re-bg)" />
      <path d="M158 64 C190 48 208 60 236 92" stroke="#3a8a66" strokeWidth="3" fill="none" strokeLinecap="round" strokeDasharray="0.1 9" />
      <path d="M236 92 l-9 -1.5 4 -8.5 Z" fill="#3a8a66" />
      <g filter="url(#re-sh)">
        <rect x="34" y="44" width="122" height="38" rx="19" fill="#fff" />
        <circle cx="54" cy="63" r="6" fill="#2D6B4F" />
        <rect x="66" y="59" width="74" height="8" rx="4" fill="#D8E2DD" />
      </g>
      <g filter="url(#re-sh)">
        <rect x="46" y="98" width="80" height="30" rx="15" fill="#fff" stroke="#BCD6C9" strokeWidth="1.5" />
        <rect x="60" y="109" width="52" height="8" rx="4" fill="#E4ECE8" />
      </g>
      <g filter="url(#re-sh)">
        <rect x="58" y="140" width="96" height="30" rx="15" fill="#E7F3ED" stroke="#2D6B4F" strokeWidth="1.5" />
        <path d="M72 155 l4 4 L84 150" stroke="#2D6B4F" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="92" y="151" width="48" height="8" rx="4" fill="#BFD8CC" />
      </g>
      <g filter="url(#re-sh)">
        <rect x="214" y="78" width="106" height="126" rx="12" fill="#fff" />
        <rect x="224" y="88" width="86" height="62" rx="8" fill="url(#re-img)" />
        <circle cx="248" cy="108" r="9" fill="rgba(255,255,255,0.55)" />
        <path d="M224 142 L252 118 L274 134 L292 122 L310 134 L310 150 L224 150 Z" fill="rgba(255,255,255,0.35)" />
        <rect x="224" y="160" width="66" height="8" rx="4" fill="#D8E2DD" />
        <rect x="224" y="176" width="38" height="9" rx="4.5" fill="#2D6B4F" opacity="0.85" />
      </g>
      <g filter="url(#re-sh)">
        <circle cx="318" cy="84" r="13" fill="#2D6B4F" />
        <path d="M312 84 l4 4 L324 79.5" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

function ArtCatalog() {
  const card = (x, y, highlight) => (
    <g key={`${x}-${y}`}>
      <rect x={x} y={y} width="88" height="82" rx="10" fill="#fff" stroke={highlight ? "#2D6B4F" : "rgba(0,0,0,0)"} strokeWidth="2" />
      <rect x={x + 10} y={y + 10} width="68" height="38" rx="6" fill={highlight ? "url(#ca-img)" : "#DFEDE6"} />
      <rect x={x + 10} y={y + 56} width="52" height="7" rx="3.5" fill="#D8E2DD" />
      <rect x={x + 10} y={y + 68} width="30" height="7" rx="3.5" fill="#9EC4B2" />
    </g>
  );
  return (
    <svg viewBox="0 0 340 210" role="presentation" focusable="false">
      <defs>
        <linearGradient id="ca-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#DEEFE6" />
          <stop offset="1" stopColor="#F4FAF7" />
        </linearGradient>
        <linearGradient id="ca-img" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#BFE0D1" />
          <stop offset="1" stopColor="#8FC6AC" />
        </linearGradient>
        <filter id="ca-sh" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="6" stdDeviation="9" floodColor="#1a2e26" floodOpacity="0.13" />
        </filter>
      </defs>
      <rect width="340" height="210" rx="20" fill="url(#ca-bg)" />
      <circle cx="32" cy="36" r="44" fill="rgba(58,138,102,0.09)" />
      <g filter="url(#ca-sh)">
        {card(96, 36, false)}
        {card(194, 36, true)}
        {card(96, 126, false)}
        {card(194, 126, false)}
      </g>
      <g filter="url(#ca-sh)">
        <circle cx="288" cy="38" r="13" fill="#2D6B4F" />
        <path d="M282 38 l4 4 L294 33.5" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <g filter="url(#ca-sh)">
        <rect x="24" y="92" width="92" height="32" rx="16" fill="#fff" />
        <circle cx="42" cy="108" r="5" fill="#3a8a66" />
        <text x="54" y="113" fontSize="12" fontWeight="650" fill="#2D6B4F">Synced</text>
      </g>
    </svg>
  );
}

function ArtSettings() {
  return (
    <svg viewBox="0 0 340 210" role="presentation" focusable="false">
      <defs>
        <linearGradient id="se-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#DFEFE7" />
          <stop offset="1" stopColor="#F5FBF8" />
        </linearGradient>
        <linearGradient id="se-fill" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#2D6B4F" />
          <stop offset="1" stopColor="#3a8a66" />
        </linearGradient>
        <filter id="se-sh" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="6" stdDeviation="9" floodColor="#1a2e26" floodOpacity="0.13" />
        </filter>
      </defs>
      <rect width="340" height="210" rx="20" fill="url(#se-bg)" />
      <circle cx="312" cy="186" r="50" fill="rgba(58,138,102,0.09)" />
      <g filter="url(#se-sh)">
        <rect x="68" y="40" width="214" height="154" rx="14" fill="#fff" />
        {/* slider rows */}
        <rect x="90" y="68" width="146" height="7" rx="3.5" fill="#E4ECE8" />
        <rect x="90" y="68" width="92" height="7" rx="3.5" fill="url(#se-fill)" />
        <circle cx="182" cy="71.5" r="9" fill="#fff" stroke="#2D6B4F" strokeWidth="2.4" />
        <rect x="90" y="104" width="146" height="7" rx="3.5" fill="#E4ECE8" />
        <rect x="90" y="104" width="46" height="7" rx="3.5" fill="url(#se-fill)" />
        <circle cx="136" cy="107.5" r="9" fill="#fff" stroke="#2D6B4F" strokeWidth="2.4" />
        <rect x="90" y="140" width="146" height="7" rx="3.5" fill="#E4ECE8" />
        <rect x="90" y="140" width="118" height="7" rx="3.5" fill="url(#se-fill)" />
        <circle cx="208" cy="143.5" r="9" fill="#fff" stroke="#2D6B4F" strokeWidth="2.4" />
        {/* toggle row */}
        <rect x="90" y="164" width="42" height="22" rx="11" fill="#2D6B4F" />
        <circle cx="122" cy="175" r="8" fill="#fff" />
        <rect x="144" y="171" width="74" height="8" rx="4" fill="#E4ECE8" />
      </g>
      <g filter="url(#se-sh)">
        <rect x="236" y="16" width="84" height="34" rx="17" fill="#fff" />
        <circle cx="256" cy="33" r="6.5" fill="none" stroke="#2D6B4F" strokeWidth="2.6" />
        <rect x="262" y="31" width="22" height="4" rx="2" fill="#2D6B4F" />
        <rect x="276" y="35" width="4" height="6" rx="1.5" fill="#2D6B4F" />
        <rect x="284" y="35" width="4" height="6" rx="1.5" fill="#2D6B4F" />
        <rect x="294" y="29" width="16" height="8" rx="4" fill="#E4ECE8" />
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// ActionCard — Shopify-home-style illustrated card: title + description up
// top, the illustration filling the lower area and bleeding to the card's
// bottom-right edge, and a white pill CTA floating over it bottom-left.
// ---------------------------------------------------------------------------
function ActionCard({ art, title, description, cta, url, external, stat }) {
  const inner = (
    <>
      <div className="seos-card-body">
        <div className="seos-card-titlerow">
          <div className="seos-card-title">{title}</div>
          {stat ? <span className="seos-card-stat">{stat}</span> : null}
        </div>
        <div className="seos-card-desc">{description}</div>
      </div>
      <div className="seos-card-art" aria-hidden="true">{art}</div>
      <span className="seos-card-btn">
        {cta}
        <span className="seos-card-arrow" aria-hidden="true">→</span>
      </span>
    </>
  );
  if (external) {
    return (
      <a className="seos-card" href={url} target="_blank" rel="noopener noreferrer">
        {inner}
      </a>
    );
  }
  return (
    <Link className="seos-card" to={url}>
      {inner}
    </Link>
  );
}

function StepCircle({ done, number }) {
  if (done) {
    return (
      <div style={{ width: "28px", height: "28px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#2D6B4F" }}>
        <Icon source={CheckCircleIcon} tone="success" />
      </div>
    );
  }
  return (
    <div style={{
      width: "28px", height: "28px", flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      borderRadius: "50%", background: "var(--p-color-bg-surface-secondary)",
      border: "1px solid var(--p-color-border)",
    }}>
      <Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">
        {number}
      </Text>
    </div>
  );
}

// Wraps the five-step setup list. When everything's done, render a
// compact 'Setup complete' banner instead of stacking five 'Done'
// rows — keeps the home page short for established merchants but
// stays one click away if they want to revisit. Tracks expand
// state in component state; defaults to collapsed when complete,
// expanded when anything's still pending or in 'Action needed'.
function SetupChecklist({
  hasApiKey, widgetEnabled, fileCount, categoryGroupsCount, semanticEnabled,
  semanticProvider, themeEditorUrl,
}) {
  const items = [
    {
      done: hasApiKey,
      number: "1",
      title: "Connect the AI engine",
      description: "Paste your API key to power the AI assistant. Pay-as-you-go — you only pay for what you use.",
      actionLabel: hasApiKey ? "Manage" : "Add key",
      actionUrl: "/app/api-keys",
    },
    {
      done: widgetEnabled,
      number: "2",
      title: "Enable the chat widget",
      description: widgetEnabled
        ? "Your storefront is loading the chat widget. Use the theme editor to adjust appearance and content."
        : "Turn on the SEoS Assistant chat block in your active Shopify theme so customers see it on your storefront.",
      actionLabel: widgetEnabled ? "Customize" : "Open theme editor",
      actionUrl: themeEditorUrl,
      external: true,
    },
    {
      done: fileCount > 0,
      number: "3",
      title: "Upload extra knowledge (optional)",
      description: "FAQs, brand voice, sizing guides, product specs — CSV files with a SKU column are automatically linked to your catalog.",
      actionLabel: fileCount > 0 ? "Manage files" : "Upload",
      actionUrl: "/app/knowledge",
    },
    {
      done: categoryGroupsCount > 0,
      number: "4",
      title: "Define category groups (optional)",
      description: "Group your catalog (e.g. Footwear / Orthotics / Accessories) so the AI never offers irrelevant categories when a customer asks about one of them. Keeps choice buttons sharp and on-topic.",
      actionLabel: categoryGroupsCount > 0 ? `Manage (${categoryGroupsCount})` : "Set up groups",
      actionUrl: "/app/catalog",
    },
    {
      done: semanticEnabled,
      number: "5",
      title: "Enable semantic search (optional)",
      description: "Match products by meaning, not just keywords. Customers asking for \"shoes for standing all day\" find arch-support styles even when descriptions don't contain those words. Bring your own Voyage AI or OpenAI key — typically under $1/month.",
      actionLabel: semanticEnabled ? `Manage (${semanticProvider === "voyage" ? "Voyage AI" : "OpenAI"})` : "Add provider",
      actionUrl: "/app/api-keys",
    },
  ];
  const doneCount = items.filter((i) => i.done).length;
  const allDone = doneCount === items.length;
  const requiredDone = hasApiKey && widgetEnabled;
  // Default collapsed once all done; expanded if anything's pending
  // OR the required steps aren't met yet.
  const [expanded, setExpanded] = useState(!allDone);

  if (allDone && !expanded) {
    return (
      <Card>
        <InlineStack align="space-between" blockAlign="center" wrap>
          <InlineStack gap="300" blockAlign="center" wrap={false}>
            <div style={{ width: 28, height: 28, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#108043" }}>
              <Icon source={CheckCircleIcon} tone="success" />
            </div>
            <BlockStack gap="050">
              <Text as="h2" variant="headingMd">Setup complete</Text>
              <Text as="span" tone="subdued" variant="bodySm">
                All 5 steps done. Your assistant is fully configured.
              </Text>
            </BlockStack>
          </InlineStack>
          <Button variant="plain" onClick={() => setExpanded(true)}>
            View checklist
          </Button>
        </InlineStack>
      </Card>
    );
  }

  return (
    <BlockStack gap="300">
      <InlineStack gap="300" blockAlign="center" align="space-between" wrap>
        <InlineStack gap="300" blockAlign="center">
          <Text as="h2" variant="headingMd">Setup checklist</Text>
          {allDone ? (
            <Badge tone="success">Complete</Badge>
          ) : requiredDone ? (
            <Badge tone="success">Ready</Badge>
          ) : (
            <Badge tone="attention">Action needed</Badge>
          )}
          <Text as="span" tone="subdued" variant="bodySm">
            {doneCount} of {items.length} done
          </Text>
        </InlineStack>
        {allDone && (
          <Button variant="plain" onClick={() => setExpanded(false)}>
            Collapse
          </Button>
        )}
      </InlineStack>
      <BlockStack gap="300">
        {items.map((item) => (
          <ChecklistItem
            key={item.number}
            done={item.done}
            number={item.number}
            title={item.title}
            description={item.description}
            actionLabel={item.actionLabel}
            actionUrl={item.actionUrl}
            external={item.external}
          />
        ))}
      </BlockStack>
    </BlockStack>
  );
}

function ChecklistItem({ done, number, title, description, actionLabel, actionUrl, external }) {
  return (
    <Box
      background={done ? "bg-surface-success-subdued" : "bg-surface"}
      borderRadius="300"
      borderWidth="025"
      borderColor={done ? "border-success-subdued" : "border"}
      padding="400"
    >
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <StepCircle done={done} number={number} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingSm">{title}</Text>
              {done && <Badge tone="success">Done</Badge>}
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">{description}</Text>
          </BlockStack>
        </div>
        <div style={{ flexShrink: 0 }}>
          <Button url={actionUrl} external={external} variant={done ? "plain" : "primary"}>
            {actionLabel}
          </Button>
        </div>
      </div>
    </Box>
  );
}

function timeGreeting() {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export default function Home() {
  const {
    hasApiKey, fileCount, shop, themeEditorUrl, widgetEnabled,
    productsCount, enrichmentCount, totalCost, totalMessages, avgCostPerMessage,
    feedbackTotal, satisfactionRate, modelStrategy, rateLimitHits,
    semanticEnabled, semanticProvider, categoryGroupsCount,
    conversionCount, conversionRevenue, conversionCurrency,
    catalogSyncStatus, lastSyncedAt, hoursSinceSync,
    recommenderActive, enabledRecommenderCount,
    dailySeries, conversionSeries,
  } = useLoaderData();

  // Server renders with server-clock greeting; correct to the merchant's
  // local time after mount. The swap happens before the entrance
  // animation finishes, so it's invisible in practice.
  const [greeting, setGreeting] = useState(timeGreeting);
  useEffect(() => { setGreeting(timeGreeting()); }, []);

  // Build the status-cluster items shown under the greeting. Each item
  // has tone (success/warning/critical/subdued), short value text,
  // optional tooltip, and a click target (URL). Order is from
  // most-likely-to-need-attention down to nice-to-have.
  const statusItems = (() => {
    const items = [];
    // AI pip carries the API-key state AND the rate-limit signal.
    // Errors surface on the pip itself rather than a separate banner
    // above, per the "everything lives in the cluster" UX rule.
    if (!hasApiKey) {
      items.push({ label: "AI Engine", value: "Missing key", tone: "critical", url: "/app/api-keys", tooltip: "Add your Anthropic API key to enable the chat." });
    } else if (rateLimitHits >= 10) {
      items.push({ label: "AI Engine", value: `${rateLimitHits} rate-limited`, tone: "critical", url: "https://console.anthropic.com/settings/limits", external: true, tooltip: `${rateLimitHits} requests rate-limited in the last 30 days. Your Anthropic tier is too low — upgrade at console.anthropic.com.` });
    } else if (rateLimitHits > 0) {
      items.push({ label: "AI Engine", value: `${rateLimitHits} rate-limited`, tone: "warning", url: "https://console.anthropic.com/settings/limits", external: true, tooltip: `${rateLimitHits} requests rate-limited in the last 30 days. Consider upgrading your Anthropic tier if this keeps growing.` });
    } else {
      items.push({ label: "AI Engine", value: "Connected", tone: "success", url: "/app/api-keys", tooltip: "Anthropic API key configured." });
    }
    items.push(
      widgetEnabled
        ? { label: "Widget", value: "Live", tone: "success", url: themeEditorUrl, external: true, tooltip: "Storefront chat widget is loading on your theme." }
        : { label: "Widget", value: "Not enabled", tone: "warning", url: themeEditorUrl, external: true, tooltip: "Enable the SEoS Assistant block in your active theme." }
    );
    if (catalogSyncStatus === "running") {
      items.push({ label: "Catalog", value: "Syncing…", tone: "warning", url: "/app/catalog", tooltip: "Catalog sync currently in progress." });
    } else if (productsCount === 0) {
      items.push({ label: "Catalog", value: "Not synced", tone: "critical", url: "/app/catalog", tooltip: "No products synced yet. Run a manual sync." });
    } else if (hoursSinceSync !== null && hoursSinceSync > 168) {
      items.push({ label: "Catalog", value: `Stale (${Math.round(hoursSinceSync / 24)}d)`, tone: "warning", url: "/app/catalog", tooltip: `Last sync ${Math.round(hoursSinceSync / 24)} days ago. Run a refresh from the Catalog page.` });
    } else {
      items.push({ label: "Catalog", value: `${productsCount} synced`, tone: "success", url: "/app/catalog", tooltip: lastSyncedAt ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}` : "Synced." });
    }
    items.push(
      semanticEnabled
        ? { label: "Smart Search", value: semanticProvider === "voyage" ? "Voyage AI" : "OpenAI", tone: "success", url: "/app/api-keys", tooltip: "Semantic search active. Customers find products by meaning, not just keywords." }
        : { label: "Smart Search", value: "Off", tone: "subdued", url: "/app/api-keys", tooltip: "Optional. Add a Voyage AI or OpenAI key to enable meaning-based product matching." }
    );
    items.push(
      recommenderActive
        ? { label: "Recommenders", value: `${enabledRecommenderCount} active`, tone: "success", url: "/app/recommenders", tooltip: "Smart Recommender flow is live for at least one intent." }
        : { label: "Recommenders", value: "Off", tone: "subdued", url: "/app/recommenders", tooltip: "Optional. Configure a guided product finder for orthotics, mattresses, etc." }
    );
    items.push(
      fileCount > 0
        ? { label: "Knowledge", value: `${fileCount} file${fileCount > 1 ? "s" : ""}`, tone: "success", url: "/app/knowledge", tooltip: "Custom FAQs / brand info available to the AI." }
        : { label: "Knowledge", value: "None", tone: "subdued", url: "/app/knowledge", tooltip: "Optional. Upload FAQs or product specs the AI can reference." }
    );
    return items;
  })();

  // Metric strip definitions. Each metric carries its 30-day daily
  // series (date + value) for the sparkline and the hover detail chart.
  const metrics = useMemo(() => {
    const days = Array.isArray(dailySeries) ? dailySeries : [];
    const conv = Array.isArray(conversionSeries) ? conversionSeries : [];
    const fmtInt = (v) => String(Math.round(v));
    return [
      {
        label: "Chat-driven revenue",
        value: conversionCount > 0 ? formatRevenue(conversionRevenue, conversionCurrency) : "—",
        sublabel: conversionCount > 0
          ? `${conversionCount} order${conversionCount === 1 ? "" : "s"} attributed to chat (tagged "SEoS")`
          : 'Tracked via the SEoS order tag — awaiting first chat-attributed order',
        series: conv.map((d) => ({ date: d.date, value: d.revenue })),
        format: (v) => formatRevenue(v, conversionCurrency),
      },
      {
        label: "Chat-driven orders",
        value: String(conversionCount || 0),
        sublabel: conversionCount > 0 ? 'Orders tagged "SEoS" in Shopify' : "Awaiting first chat-attributed order",
        series: conv.map((d) => ({ date: d.date, value: d.count })),
        format: fmtInt,
      },
      {
        label: "AI requests",
        value: String(totalMessages),
        sublabel: totalMessages > 0 ? `Avg ${formatCost(avgCostPerMessage)} per request` : "Awaiting first chat",
        series: days.map((d) => ({ date: d.date, value: d.messages })),
        format: fmtInt,
      },
      {
        label: "Satisfaction",
        value: feedbackTotal > 0 ? `${satisfactionRate}%` : "—",
        sublabel: feedbackTotal > 0 ? `${feedbackTotal} customer ratings · chart shows 👍 per day` : "Awaiting first customer rating",
        series: days.map((d) => ({ date: d.date, value: d.up })),
        format: fmtInt,
      },
      {
        label: "AI cost",
        value: formatCost(totalCost),
        sublabel: "Anthropic API spend, billed pay-as-you-go",
        series: days.map((d) => ({ date: d.date, value: d.cost })),
        format: (v) => formatCost(v),
      },
    ];
  }, [dailySeries, conversionSeries, conversionCount, conversionRevenue, conversionCurrency, totalMessages, avgCostPerMessage, feedbackTotal, satisfactionRate, totalCost]);

  const rateFetcher = useFetcher();
  const rateDismissed = rateFetcher.state !== "idle" || rateFetcher.data?.dismissed;
  const showRateLimit = rateLimitHits > 0 && !rateDismissed;

  const greetWords = `${greeting}.`.split(" ");

  return (
    <Page>
      <TitleBar title="SEoS Assistant" />
      <style>{`
        /* ------------------------------------------------------------------
           Home page — Apple-clean, futuristic-AI styling.
           Brand green #2D6B4F with #3a8a66 as the light end.
        ------------------------------------------------------------------ */
        .seos-home { position: relative; }
        /* Page content layers above the fixed globe backdrop. */
        .seos-home > div:not(.seos-globe-bg), .seos-home > .Polaris-BlockStack { position: relative; z-index: 1; }

        /* Globe backdrop — pinned to the viewport's top-right corner,
           behind all content, bleeding off the edge like the Shopify
           admin home. position:fixed keeps it outside layout flow, so
           the overhang never creates a horizontal scrollbar. */
        .seos-globe-bg {
          position: fixed;
          top: -300px;
          right: -200px;
          z-index: 0;
          pointer-events: none;
        }
        @media (max-width: 1000px) {
          .seos-globe-bg { display: none; }
        }

        /* Hero: transparent and fully centered — brand lockup, greeting,
           and status pills all share one axis with the metric strip
           above, like the Shopify admin home. */
        .seos-hero {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          padding: 26px 4px 8px;
        }
        .seos-hero-brand {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 9px;
          margin-bottom: 16px;
          opacity: 0;
          animation: seos-rise 0.55s cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
        }
        .seos-hero-brand img { display: block; height: 26px; width: auto; }
        .seos-hero-brand-name {
          font-size: 11.5px;
          font-weight: 650;
          letter-spacing: 1.6px;
          text-transform: uppercase;
          color: #2D6B4F;
        }
        .seos-greet {
          margin: 0;
          font-size: 34px;
          line-height: 1.15;
          font-weight: 650;
          letter-spacing: -0.5px;
          color: #1a2e26;
        }
        .seos-greet .seos-word {
          display: inline-block;
          opacity: 0;
          transform: translateY(10px);
          animation: seos-rise 0.55s cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
        }
        @keyframes seos-rise {
          to { opacity: 1; transform: translateY(0); }
        }
        @media (max-width: 760px) {
          .seos-greet { font-size: 26px; }
        }
        .seos-subline {
          margin: 10px 0 0;
          font-size: 15px;
          color: rgba(26,46,38,0.6);
          opacity: 0;
          animation: seos-rise 0.55s cubic-bezier(0.2, 0.7, 0.2, 1) 0.2s forwards;
        }

        /* Test chat — the centred "ask anything" box. Same engine as
           the storefront widget, embedded right in the home page. */
        .seos-testchat {
          width: min(640px, 100%);
          margin-top: 22px;
          position: relative;
          z-index: 2;
          opacity: 0;
          animation: seos-rise 0.55s cubic-bezier(0.2, 0.7, 0.2, 1) 0.3s forwards;
        }
        .seos-testchat-panel {
          text-align: left;
          background: #fff;
          border: 1px solid rgba(26,46,38,0.10);
          border-radius: 16px;
          box-shadow: 0 10px 30px rgba(26,46,38,0.08), 0 1px 3px rgba(26,46,38,0.06);
          padding: 16px;
          margin-bottom: 12px;
          max-height: 380px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .seos-testchat-row { display: flex; }
        .seos-testchat-row.is-user { justify-content: flex-end; }
        .seos-testchat-row.is-bot { justify-content: flex-start; }
        .seos-testchat-bubble {
          max-width: 86%;
          padding: 10px 14px;
          border-radius: 14px;
          font-size: 13.5px;
          line-height: 1.55;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .is-user .seos-testchat-bubble {
          background: #2D6B4F;
          color: #fff;
          border-bottom-right-radius: 5px;
        }
        .is-bot .seos-testchat-bubble {
          background: #f2f5f3;
          color: #1a2e26;
          border-bottom-left-radius: 5px;
        }
        .seos-testchat-bubble.is-error {
          background: #FFF6F4;
          color: #8C1F11;
          border: 1px solid rgba(215,44,13,0.25);
        }
        .seos-testchat-typing { display: inline-flex; gap: 4px; padding: 4px 2px; }
        .seos-testchat-typing span {
          width: 6px; height: 6px; border-radius: 50%;
          background: rgba(45,107,79,0.55);
          animation: seos-typing 1.1s ease-in-out infinite;
        }
        .seos-testchat-typing span:nth-child(2) { animation-delay: 0.18s; }
        .seos-testchat-typing span:nth-child(3) { animation-delay: 0.36s; }
        @keyframes seos-typing {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
          30% { transform: translateY(-4px); opacity: 1; }
        }
        .seos-testchat-prods {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 10px;
        }
        .seos-testchat-prod {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px 11px 6px 7px;
          border-radius: 10px;
          background: #fff;
          border: 1px solid rgba(45,107,79,0.25);
          text-decoration: none !important;
          color: #1a2e26 !important;
          font-size: 12px;
          transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
        }
        .seos-testchat-prod:hover {
          border-color: rgba(45,107,79,0.55);
          box-shadow: 0 3px 10px rgba(26,46,38,0.10);
          transform: translateY(-1px);
        }
        .seos-testchat-prod img {
          width: 28px; height: 28px;
          border-radius: 6px;
          object-fit: cover;
          display: block;
        }
        .seos-testchat-prod-title {
          font-weight: 600;
          max-width: 180px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .seos-testchat-prod-price { color: #2D6B4F; font-weight: 650; }
        .seos-testchat-input {
          display: flex;
          align-items: center;
          gap: 10px;
          background: #fff;
          border: 1px solid rgba(26,46,38,0.12);
          border-radius: 999px;
          padding: 8px 8px 8px 16px;
          box-shadow: 0 4px 16px rgba(26,46,38,0.08), 0 1px 2px rgba(26,46,38,0.05);
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .seos-testchat-input:focus-within {
          border-color: rgba(45,107,79,0.5);
          box-shadow: 0 6px 22px rgba(26,46,38,0.12), 0 0 0 3px rgba(45,107,79,0.10);
        }
        .seos-testchat-avatar { height: 22px; width: auto; flex-shrink: 0; }
        .seos-testchat-input input {
          flex: 1;
          min-width: 0;
          border: none;
          outline: none;
          background: transparent;
          font: inherit;
          font-size: 14px;
          color: #1a2e26;
        }
        .seos-testchat-input input::placeholder { color: rgba(26,46,38,0.45); }
        .seos-testchat-input button {
          flex-shrink: 0;
          width: 34px;
          height: 34px;
          border-radius: 50%;
          border: none;
          background: #2D6B4F;
          color: #fff;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: background 0.15s ease, transform 0.15s ease;
        }
        .seos-testchat-input button:hover:not(:disabled) { background: #245a42; transform: translateY(-1px); }
        .seos-testchat-input button:disabled { background: rgba(26,46,38,0.18); cursor: default; }
        .seos-testchat-note {
          margin-top: 8px;
          font-size: 11.5px;
          color: rgba(26,46,38,0.45);
        }

        /* Status — the engine's gauge cluster. A one-line verdict
           ("All systems running") above a single segmented instrument
           bar. One container, hairline dividers between segments — it
           reads as status, not as a second row of navigation. */
        .seos-status-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          padding-top: 18px;
          position: relative;
          z-index: 1;
          opacity: 0;
          animation: seos-rise 0.55s cubic-bezier(0.2, 0.7, 0.2, 1) 0.25s forwards;
        }
        .seos-status-summary {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          font-weight: 500;
          color: rgba(26,46,38,0.65);
        }
        .seos-status-summary-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #2D6B4F;
          animation: seos-breathe 2.8s ease-in-out infinite;
        }
        .seos-status-summary-dot.is-warn {
          background: #B98900;
          animation: none;
          box-shadow: 0 0 0 3px rgba(185,137,0,0.18);
        }
        .seos-status-summary-dot.is-crit {
          background: #D72C0D;
          animation: seos-pulse 1.6s ease-in-out infinite;
        }
        @keyframes seos-breathe {
          0%, 100% { box-shadow: 0 0 0 3px rgba(45,107,79,0.16); }
          50%      { box-shadow: 0 0 0 6px rgba(45,107,79,0.05); }
        }
        .seos-status-bar {
          display: inline-flex;
          flex-wrap: wrap;
          justify-content: center;
          align-items: stretch;
          background: #fff;
          border: 1px solid rgba(26,46,38,0.10);
          border-radius: 999px;
          box-shadow: 0 1px 2px rgba(26,46,38,0.05);
          padding: 4px;
        }
        .seos-pip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 14px;
          border-radius: 999px;
          background: transparent;
          border: none;
          text-decoration: none !important;
          color: #1a2e26 !important;
          line-height: 1;
          user-select: none;
          cursor: pointer;
          position: relative;
          transition: background 0.15s ease;
          outline: none;
        }
        /* Hairline divider between segments. */
        .seos-pip + .seos-pip::before {
          content: "";
          position: absolute;
          left: -0.5px;
          top: 26%;
          bottom: 26%;
          width: 1px;
          background: rgba(26,46,38,0.09);
        }
        .seos-pip:hover { background: rgba(45,107,79,0.07); }
        .seos-pip:hover::before, .seos-pip:hover + .seos-pip::before { background: transparent; }
        .seos-pip:focus-visible {
          box-shadow: inset 0 0 0 2px rgba(45,107,79,0.4);
        }
        .seos-pip-off .seos-pip-label { color: rgba(26,46,38,0.45); }
        .seos-pip-warn { background: rgba(255,196,83,0.16); }
        .seos-pip-warn:hover { background: rgba(255,196,83,0.28); }
        .seos-pip-crit { background: rgba(215,44,13,0.08); }
        .seos-pip-crit:hover { background: rgba(215,44,13,0.15); }
        .seos-pip-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .seos-pip-label {
          font-size: 10.5px;
          font-weight: 600;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          white-space: nowrap;
        }
        .seos-pip-pulse { animation: seos-pulse 1.6s ease-in-out infinite; }
        @keyframes seos-pulse {
          0%, 100% { box-shadow: 0 0 0 3px rgba(215,44,13,0.25), 0 0 10px rgba(215,44,13,0.45); }
          50%      { box-shadow: 0 0 0 5px rgba(215,44,13,0.12), 0 0 16px rgba(215,44,13,0.6); }
        }
        @media (max-width: 640px) {
          .seos-status-bar { border-radius: 22px; }
        }

        /* Metric strip — compact, no card chrome, centered at the very
           top of the page like the Shopify admin home. */
        .seos-metrics-wrap {
          position: relative;
          z-index: 40;
        }
        .seos-metrics {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 2px 6px;
        }
        .seos-metric {
          appearance: none;
          font: inherit;
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 3px;
          padding: 7px 14px 8px;
          background: transparent;
          border: none;
          border-radius: 10px;
          cursor: pointer;
          transition: background 0.15s ease;
        }
        .seos-metric:hover, .seos-metric.is-active { background: rgba(45,107,79,0.06); }
        .seos-metric:focus-visible {
          outline: 2px solid rgba(45,107,79,0.5);
          outline-offset: -2px;
        }
        .seos-metric-label {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.1px;
          color: rgba(26,46,38,0.55);
          white-space: nowrap;
        }
        .seos-metric-row {
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .seos-metric-value {
          font-size: 14px;
          font-weight: 700;
          letter-spacing: -0.2px;
          color: #1a2e26;
          font-variant-numeric: tabular-nums;
        }

        /* Detail dropdown — a floating overlay below the strip. It never
           pushes page content, so an accidental open doesn't reflow the
           page; it just fades/slides in above it. */
        .seos-metric-detail {
          position: absolute;
          top: calc(100% + 8px);
          left: 0;
          right: 0;
          background: #fff;
          border: 1px solid rgba(0,0,0,0.08);
          border-radius: 14px;
          box-shadow: 0 18px 44px rgba(26,46,38,0.16), 0 2px 8px rgba(26,46,38,0.08);
          opacity: 0;
          transform: translateY(-6px) scale(0.99);
          transform-origin: top center;
          pointer-events: none;
          visibility: hidden;
          transition: opacity 0.2s ease, transform 0.24s cubic-bezier(0.2, 0.8, 0.2, 1),
                      visibility 0s linear 0.24s;
        }
        .seos-metric-detail.is-open {
          opacity: 1;
          transform: none;
          pointer-events: auto;
          visibility: visible;
          transition: opacity 0.2s ease, transform 0.24s cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        .seos-detail-inner { padding: 16px 20px 12px; }
        .seos-detail-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 8px;
        }
        .seos-detail-label {
          font-size: 11.5px;
          font-weight: 600;
          letter-spacing: 0.2px;
          color: rgba(26,46,38,0.6);
        }
        .seos-detail-value {
          font-size: 20px;
          font-weight: 650;
          letter-spacing: -0.3px;
          color: #1a2e26;
          font-variant-numeric: tabular-nums;
        }
        .seos-detail-sub { font-size: 12px; color: rgba(26,46,38,0.55); margin-top: 2px; }
        .seos-detail-readout {
          display: flex;
          align-items: baseline;
          gap: 10px;
          padding: 6px 12px;
          border-radius: 8px;
          background: rgba(45,107,79,0.06);
          border: 1px solid rgba(45,107,79,0.14);
          white-space: nowrap;
        }
        .seos-detail-readout-date { font-size: 12px; color: rgba(26,46,38,0.6); }
        .seos-detail-readout-value { font-size: 15px; font-weight: 650; color: #2D6B4F; font-variant-numeric: tabular-nums; }
        .seos-detail-readout-hint { font-size: 12px; color: rgba(26,46,38,0.45); background: transparent; border-color: transparent; }
        .seos-detail-chart { height: 150px; cursor: crosshair; position: relative; }
        .seos-detail-axis {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          font-size: 11px;
          color: rgba(26,46,38,0.45);
          padding-top: 4px;
        }
        .seos-detail-link {
          font-size: 12px;
          font-weight: 600;
          color: #2D6B4F !important;
          text-decoration: none !important;
        }
        .seos-detail-link:hover { text-decoration: underline !important; }

        /* Card grid — Shopify-home-style illustrated cards. */
        .seos-card-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 16px;
        }
        .seos-card {
          position: relative;
          display: flex;
          flex-direction: column;
          min-height: 320px;
          border-radius: 16px;
          background: #fff;
          border: 1px solid rgba(0,0,0,0.07);
          overflow: hidden;
          text-decoration: none !important;
          color: inherit !important;
          box-shadow: 0 1px 2px rgba(0,0,0,0.04);
          transition: transform 0.2s cubic-bezier(0.2, 0.7, 0.2, 1), box-shadow 0.2s ease, border-color 0.2s ease;
        }
        .seos-card:hover {
          transform: translateY(-3px);
          border-color: rgba(45,107,79,0.30);
          box-shadow: 0 12px 28px rgba(26,46,38,0.12), 0 2px 6px rgba(26,46,38,0.06);
        }
        .seos-card:focus-visible {
          outline: 2px solid rgba(45,107,79,0.5);
          outline-offset: 2px;
        }
        .seos-card-body { padding: 18px 18px 6px; }
        .seos-card-titlerow {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .seos-card-stat {
          font-size: 11px;
          font-weight: 600;
          color: #2D6B4F;
          background: rgba(45,107,79,0.08);
          border: 1px solid rgba(45,107,79,0.18);
          border-radius: 999px;
          padding: 3px 9px;
          white-space: nowrap;
        }
        .seos-card-title { font-size: 15px; font-weight: 650; color: #1a2e26; letter-spacing: -0.1px; }
        .seos-card-desc { font-size: 12.5px; line-height: 1.5; color: rgba(26,46,38,0.62); margin-top: 6px; }
        .seos-card-art {
          flex: 1;
          display: flex;
          align-items: flex-end;
          justify-content: flex-end;
          padding: 14px 0 0 30px;
          min-height: 160px;
          pointer-events: none;
        }
        .seos-card-art svg {
          display: block;
          width: 94%;
          max-width: 330px;
          height: auto;
          /* Bleed past the card's bottom-right edge so the illustration's
             own rounded corners are cropped — same trick as Shopify home. */
          margin-right: -12px;
          margin-bottom: -12px;
        }
        .seos-card-btn {
          position: absolute;
          left: 16px;
          bottom: 16px;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          background: #fff;
          border: 1px solid rgba(0,0,0,0.05);
          border-radius: 999px;
          padding: 9px 15px;
          font-size: 12.5px;
          font-weight: 600;
          color: #1a2e26;
          box-shadow: 0 2px 10px rgba(26,46,38,0.16), 0 1px 2px rgba(26,46,38,0.10);
          transition: transform 0.18s cubic-bezier(0.2, 0.7, 0.2, 1), box-shadow 0.18s ease;
          white-space: nowrap;
        }
        .seos-card:hover .seos-card-btn {
          transform: translateY(-1px);
          box-shadow: 0 4px 14px rgba(26,46,38,0.22), 0 1px 3px rgba(26,46,38,0.12);
        }
        .seos-card-arrow {
          display: inline-block;
          color: #2D6B4F;
          transition: transform 0.18s cubic-bezier(0.2, 0.7, 0.2, 1);
        }
        .seos-card:hover .seos-card-arrow { transform: translateX(4px); }

        @media (prefers-reduced-motion: reduce) {
          .seos-greet .seos-word, .seos-hero-brand, .seos-status-wrap, .seos-subline, .seos-testchat { animation: none; opacity: 1; transform: none; }
          .seos-testchat-typing span { animation: none; }
          .seos-status-summary-dot { animation: none; }
          .seos-pip, .seos-card, .seos-card-arrow, .seos-metric, .seos-metric-detail { transition: none; }
          .seos-pip-pulse { animation: none; }
        }
      `}</style>
      <div className="seos-home">
        <div className="seos-globe-bg" aria-hidden="true">
          <Globe size={820} points={1700} variant="subtle" />
        </div>
        <BlockStack gap="500">
          {hasApiKey ? <MetricStrip metrics={metrics} /> : null}

          <div className="seos-hero">
            <div className="seos-hero-brand">
              <img src={seosLogo} alt="SEoS" />
              <span className="seos-hero-brand-name">SEoS Assistant</span>
            </div>
            <h1 className="seos-greet">
              {greetWords.map((w, i) => (
                <span key={`${w}-${i}`} className="seos-word" style={{ animationDelay: `${i * 90}ms` }}>
                  {w}{i < greetWords.length - 1 ? " " : ""}
                </span>
              ))}
            </h1>
            <p className="seos-subline">Let’s turn browsers into buyers.</p>
            {hasApiKey ? <TestChat shop={shop} /> : null}
            <StatusCluster items={statusItems} />
          </div>

          {showRateLimit && (
            <Banner
              title={rateLimitHits >= 10 ? "Customers are being turned away" : "Some customers hit the AI rate limit"}
              tone={rateLimitHits >= 10 ? "critical" : "warning"}
              action={{ content: "Increase limits", url: "https://console.anthropic.com/settings/limits", external: true }}
              secondaryAction={{ content: "Dismiss", onAction: () => rateFetcher.submit({ intent: "dismiss_rate_limit" }, { method: "post" }) }}
              onDismiss={() => rateFetcher.submit({ intent: "dismiss_rate_limit" }, { method: "post" })}
            >
              <Text as="p" variant="bodySm">
                {rateLimitHits} {rateLimitHits === 1 ? "request was" : "requests were"} rate-limited this month.
                {rateLimitHits >= 10
                  ? " Your Anthropic API tier is too low for your traffic. Add credits at console.anthropic.com to auto-upgrade."
                  : " This happens when many customers chat simultaneously. If this keeps growing, consider upgrading your Anthropic API tier."}
              </Text>
            </Banner>
          )}

          <div className="seos-card-grid">
              <ActionCard
                art={<ArtSetup />}
                title="Setup guide"
                description="Full walkthrough for installing, configuring, and going live with the assistant."
                cta="Open setup guide"
                url="/onboarding"
                external
              />
              <ActionCard
                art={<ArtAnalytics />}
                title="Analytics"
                description="Requests, costs, satisfaction trends, and the questions customers actually ask."
                cta="View analytics"
                url="/app/analytics"
              />
              <ActionCard
                art={<ArtKnowledge />}
                title="Knowledge"
                description="Upload FAQs, sizing guides, and brand voice so the AI answers in your words."
                cta="Manage knowledge"
                url="/app/knowledge"
                stat={fileCount > 0 ? `${fileCount} file${fileCount > 1 ? "s" : ""}` : null}
              />
              <ActionCard
                art={<ArtRecommenders />}
                title="Smart Recommenders"
                description="Guided product finders that walk customers to the right product, step by step."
                cta="Configure flows"
                url="/app/recommenders"
                stat={recommenderActive ? `${enabledRecommenderCount} active` : null}
              />
              <ActionCard
                art={<ArtCatalog />}
                title="Catalog"
                description="Synced products, enrichment, and category groups that keep answers on-topic."
                cta="Open catalog"
                url="/app/catalog"
                stat={productsCount > 0 ? `${productsCount} products` : null}
              />
              <ActionCard
                art={<ArtSettings />}
                title="Settings"
                description="API keys, model strategy, semantic search, and safety limits — all in one place."
                cta="Open settings"
                url="/app/api-keys"
              />
          </div>

          <SetupChecklist
            hasApiKey={hasApiKey}
            widgetEnabled={widgetEnabled}
            fileCount={fileCount}
            categoryGroupsCount={categoryGroupsCount}
            semanticEnabled={semanticEnabled}
            semanticProvider={semanticProvider}
            themeEditorUrl={themeEditorUrl}
          />

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">About SEoS Assistant</Text>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px" }}>
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm"><strong>Version:</strong> 1.0.0</Text>
                  <Text as="p" variant="bodySm"><strong>AI Engine:</strong> Anthropic Claude</Text>
                  <Text as="p" variant="bodySm"><strong>Semantic Search:</strong> {semanticEnabled ? `${semanticProvider === "voyage" ? "Voyage AI" : "OpenAI"} (active)` : "Optional — bring your own key"}</Text>
                </BlockStack>
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm"><strong>Attribution:</strong> Chat-driven sales tagged "SEoS" on the order; product links carry utm_content=SEoS so other channel UTMs stay intact.</Text>
                  <Text as="p" variant="bodySm"><strong>Privacy:</strong> Feedback data hashed, auto-deleted after 90 days</Text>
                  <Text as="p" variant="bodySm"><strong>Billing:</strong> Pay-as-you-go AI usage — no markup</Text>
                </BlockStack>
              </div>
            </BlockStack>
          </Card>
        </BlockStack>
      </div>
    </Page>
  );
}

import { useState, useMemo, useCallback, useEffect } from "react";
import { useLoaderData, useSearchParams, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Page, Card, BlockStack, InlineStack, Box, Button, Badge, Banner, Popover, DatePicker, ActionList,
} from "@shopify/polaris";
import { ExportIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getUsageSummary, getDailySeries, getReplyCostSample } from "../models/ChatUsage.server";
import { getShopTimeZone } from "../lib/shop-timezone.server";
import { getShopPlan } from "../lib/billing.server";
import { getFeedbackSummary, cleanupOldFeedback, getRecentQuestions } from "../models/ChatFeedback.server";
import {
  getTopProducts, getProductsByTool, getInterestBreakdown, cleanupOldMentions,
} from "../models/ChatProductMention.server";
import { getTopicRows } from "../models/ChatTopic.server";
import { summarizeWeek } from "../lib/weekly-summary";
import { getConversionSummary } from "../models/ChatConversion.server";
import { getShopConfig } from "../models/ShopConfig.server";
import BrandHeader from "../components/BrandHeader";
import { SETTINGS_CSS, Row, Group } from "../components/SettingsUI";
import CostEstimator from "../components/CostEstimator";
import { getMonthlySessions } from "../lib/store-traffic.server";
import { estimateStoreReplyCost } from "../lib/lean/cost-model.server";
import { warmAverage } from "../lib/cost-estimator-math";

function parseRange(searchParams) {
  const preset = searchParams.get("range") || "30d";
  const now = new Date();
  const end = now;
  let start;

  if (preset === "custom") {
    const s = searchParams.get("start");
    const e = searchParams.get("end");
    if (s && e) return { startDate: new Date(s), endDate: new Date(e), preset, label: `${s} → ${e}` };
  }

  if (preset === "7d") start = new Date(now.getTime() - 7 * 86400000);
  else if (preset === "90d") start = new Date(now.getTime() - 90 * 86400000);
  else if (preset === "ytd") start = new Date(now.getFullYear(), 0, 1);
  else { start = new Date(now.getTime() - 30 * 86400000); }

  return { startDate: start, endDate: end, preset, label: { "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", ytd: "Year to date" }[preset] || "Last 30 days" };
}

// Clamp any requested window to the plan's analytics retention — a
// custom range must not read further back than the plan advertises.
function clampToRetention(range, retentionDays) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return range;
  const floor = new Date(Date.now() - days * 86400000);
  if (range.startDate < floor) {
    return { ...range, startDate: floor };
  }
  return range;
}

function daysBetween(a, b) {
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000));
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const parsed = parseRange(url.searchParams);
  const planForRetention = await getShopPlan(session.shop);
  const { startDate, endDate } = clampToRetention(parsed, planForRetention.analyticsRetentionDays);
  const { preset, label } = parsed;
  const rangeArg = { startDate, endDate };

  const spanDays = daysBetween(startDate, endDate);
  const prevEnd = new Date(startDate.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - spanDays * 86400000);
  const prevRange = { startDate: prevStart, endDate: prevEnd };

  const weekRange = { startDate: new Date(Date.now() - 7 * 86400000), endDate: new Date() };
  const [usage, feedback, topProducts, productsByTool, interest, recentQuestions, daily, prevUsage, prevFeedback, conversions, prevConversions, config, weekTopics, weekUsage] = await Promise.all([
    getUsageSummary(session.shop, rangeArg),
    getFeedbackSummary(session.shop, rangeArg),
    getTopProducts(session.shop, rangeArg, 10),
    getProductsByTool(session.shop, rangeArg, 10),
    getInterestBreakdown(session.shop, rangeArg),
    getRecentQuestions(session.shop, rangeArg, 20),
    getShopTimeZone(admin, session.shop).then((timeZone) => getDailySeries(session.shop, rangeArg, { timeZone })),
    getUsageSummary(session.shop, prevRange),
    getFeedbackSummary(session.shop, prevRange),
    getConversionSummary(session.shop, rangeArg),
    getConversionSummary(session.shop, prevRange),
    getShopConfig(session.shop),
    getTopicRows(session.shop, { days: 7 }).catch(() => []),
    getUsageSummary(session.shop, weekRange),
  ]);
  // Cost estimator: real traffic, this store's priced setup, recorded replies.
  const [traffic, modeled, costRows] = await Promise.all([
    getMonthlySessions(admin, session.shop).catch((err) => ({ error: String(err?.message || err) })),
    config?.anthropicApiKey ? estimateStoreReplyCost(session.shop, config).catch(() => null) : Promise.resolve(null),
    getReplyCostSample(session.shop).catch(() => []),
  ]);
  const measured = warmAverage(costRows, { prefixTokens: modeled?.prefixTokens || 0, coldStartExtra: modeled?.coldStartExtra || 0 });
  cleanupOldFeedback().catch(() => {});
  cleanupOldMentions().catch(() => {});

  return {
    usage, feedback, topProducts, productsByTool, interest, recentQuestions, daily, conversions,
    week: { ...summarizeWeek(weekTopics), messages: weekUsage.totalMessages },
    estimator: {
      traffic,
      modeled: modeled && {
        perReply: modeled.perReply, coldStartExtra: modeled.coldStartExtra, model: modeled.model,
        prefixTokens: modeled.prefixTokens, searchTokens: modeled.searchTokens, products: modeled.products,
      },
      measured,
    },
    previous: {
      messages: prevUsage.totalMessages,
      cost: prevUsage.totalCost,
      satisfaction: prevFeedback.satisfactionRate,
      toolCalls: prevUsage.totalToolCalls,
      conversionCount: prevConversions.count,
      conversionRevenue: prevConversions.revenue,
    },
    range: { preset, label, startDate: startDate.toISOString(), endDate: endDate.toISOString(), days: spanDays },
  };
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

function pctChange(curr, prev) {
  if (!prev) return curr > 0 ? { delta: 100, direction: "up" } : { delta: 0, direction: "flat" };
  const delta = ((curr - prev) / prev) * 100;
  return { delta: Math.abs(delta), direction: delta > 0.5 ? "up" : delta < -0.5 ? "down" : "flat" };
}

// Dates read the browser's clock and time zone, so they're shown once the
// page runs in the browser (the server's render then matches the browser's).
function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

// The page shows what a merchant acts on; every other number is in the
// Export menu (Summary and the lists behind each card).
const ANALYTICS_CSS = `
  .an .set-group__title { padding-bottom: 2px; }
  .an-top { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 16px; }
  .an-top h2 { margin: 0; font-size: 20px; line-height: 26px; font-weight: 650; color: #1a2e26; letter-spacing: -0.01em; }
  .an-top p { margin: 2px 0 0; font-size: 13px; color: #5e6f67; min-height: 18px; }
  .an-ctl { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .an-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 9px; background: rgba(26,46,38,0.06); }
  .an-seg a { padding: 5px 11px; border-radius: 7px; font-size: 12.5px; line-height: 18px; font-weight: 550; color: #4a4a4a !important; text-decoration: none !important; white-space: nowrap; }
  .an-seg a:hover { color: #1a1a1a !important; }
  .an-seg a.is-on { background: #fff; color: #1a1a1a !important; font-weight: 650; box-shadow: 0 1px 2px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.05); }
  .an-seg a:focus-visible { outline: 2px solid #2D6B4F; outline-offset: 1px; }
  .an-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  .an-kpi { display: grid; gap: 2px; align-content: start; min-width: 0; padding: 14px 16px; border-radius: 16px; background: #fff;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 0 0 1px rgba(0,0,0,0.07); }
  .an-kpi--lead { background: linear-gradient(160deg, rgba(45,107,79,0.07), rgba(58,138,102,0.02)), #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 0 0 1px rgba(45,107,79,0.18); }
  .an-kpi__label { font-size: 12px; line-height: 16px; color: #616161; }
  .an-kpi__value { font-size: 24px; line-height: 30px; font-weight: 700; color: #1a2e26; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .an-kpi__sub { font-size: 12px; line-height: 16px; color: #616161; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .an-delta { justify-self: start; margin-top: 6px; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; line-height: 17px; font-weight: 650; color: #616161; background: rgba(26,46,38,0.05); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .an-delta small { font-weight: 500; opacity: .8; }
  .an-delta.is-good { color: #2D6B4F; background: rgba(45,107,79,0.10); }
  .an-delta.is-warn { color: #8a5a1f; background: rgba(185,138,90,0.16); }
  .an-chart { padding: 4px 12px 12px; }
  .an-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12px; color: #616161; }
  .an-legend span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .an-legend i { display: inline-block; width: 14px; height: 3px; border-radius: 2px; }
  .an-cols { display: grid; grid-template-columns: repeat(var(--an-cols, 3), minmax(0, 1fr)); gap: 16px 24px; padding: 10px 16px 16px; }
  .an-col__title { margin-bottom: 8px; font-size: 12px; line-height: 16px; font-weight: 650; color: #303030; }
  .an-rank { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; }
  .an-rank__top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .an-rank__title { min-width: 0; font-size: 13px; line-height: 18px; color: #1a1a1a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .an-rank__n { flex: none; font-size: 12.5px; font-weight: 650; color: #1a2e26; font-variant-numeric: tabular-nums; }
  .an-rank__bar { height: 4px; margin-top: 4px; border-radius: 999px; background: rgba(26,46,38,0.06); overflow: hidden; }
  .an-rank__bar span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #2D6B4F, #3a8a66); }
  .an-callout { margin: 10px 16px 0; padding: 10px 12px; border-radius: 10px; background: rgba(185,137,0,0.09); font-size: 12.5px; line-height: 18px; color: #4a3b00; }
  .an-callout strong { color: #1a1a1a; }
  .an-empty { padding: 18px 16px 20px; font-size: 13px; color: #616161; }
  .an-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 16px 12px; }
  .an-chip { all: unset; box-sizing: border-box; padding: 4px 11px; border-radius: 999px; font-size: 12px; line-height: 18px; font-weight: 600; color: #4a4a4a; cursor: pointer;
    box-shadow: inset 0 0 0 1px rgba(0,0,0,0.12); transition: background .15s ease, color .15s ease; }
  .an-chip small { margin-left: 3px; font-weight: 650; opacity: .7; font-variant-numeric: tabular-nums; }
  .an-chip:hover { box-shadow: inset 0 0 0 1px rgba(45,107,79,0.45); }
  .an-chip[aria-pressed="true"] { background: #2D6B4F; color: #fff; box-shadow: none; }
  .an-chip:focus-visible { outline: 2px solid #2D6B4F; outline-offset: 2px; }
  .an-convo { padding: 11px 16px; border-top: 1px solid rgba(30,27,51,0.07); }
  .an-convo.is-flagged { background: rgba(197,40,12,0.035); }
  .an-convo__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 12px; color: #8a8a8a; min-height: 18px; }
  .an-pill { padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 16px; font-weight: 650; color: #616161; background: rgba(26,46,38,0.06); white-space: nowrap; }
  .an-pill.is-up { color: #2D6B4F; background: rgba(45,107,79,0.10); }
  .an-pill.is-down { color: #a33d3d; background: rgba(185,90,90,0.13); }
  .an-convo__q { font-size: 13.5px; line-height: 19px; font-weight: 600; color: #1a1a1a; overflow-wrap: anywhere; }
  .an-convo__line { margin-top: 2px; font-size: 12.5px; line-height: 18px; color: #4a4a4a; overflow-wrap: anywhere; }
  .an-convo__line b { font-weight: 600; color: #616161; }
  .an-clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .an-convo__toggle { all: unset; margin-top: 6px; font-size: 12px; font-weight: 600; color: #2D6B4F; cursor: pointer; }
  .an-convo__toggle:hover { text-decoration: underline; }
  .an-convo__toggle:focus-visible { outline: 2px solid #2D6B4F; outline-offset: 2px; border-radius: 4px; }
  .an-chat { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; padding: 12px; border-radius: 12px; background: rgba(26,46,38,0.03); }
  .an-msg { max-width: 85%; padding: 7px 11px; border-radius: 12px; font-size: 13px; line-height: 18px; color: #1a1a1a; white-space: pre-wrap; overflow-wrap: anywhere; }
  .an-msg.is-user { align-self: flex-end; background: rgba(45,107,79,0.12); border-bottom-right-radius: 4px; }
  .an-msg.is-ai { align-self: flex-start; background: #fff; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.06); border-bottom-left-radius: 4px; }
  .an-more { padding: 10px 16px 12px; border-top: 1px solid rgba(30,27,51,0.07); }
  .an-foot { padding: 4px 8px 8px; text-align: center; font-size: 12px; line-height: 18px; color: #8a8a8a; }
  @media (prefers-reduced-motion: reduce) { .an-chip { transition: none; } }
  @media (max-width: 900px) { .an-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 760px) {
    .an-cols { grid-template-columns: minmax(0, 1fr); }
    .an-kpi__value { font-size: 21px; line-height: 27px; }
  }
`;

// Compact change pill — green when the move is in the good direction,
// amber when it isn't, quiet gray when flat.
function Delta({ curr, prev, goodDirection = "up" }) {
  const { delta, direction } = pctChange(curr, prev);
  if (direction === "flat") return <span className="an-delta">No change</span>;
  const good = direction === goodDirection;
  return (
    <span className={`an-delta ${good ? "is-good" : "is-warn"}`}>
      {direction === "up" ? "↑" : "↓"} {delta.toFixed(0)}% <small>vs prior</small>
    </span>
  );
}

function Kpi({ label, value, sub, curr, prev, goodDirection = "up", lead = false }) {
  return (
    <div className={`an-kpi${lead ? " an-kpi--lead" : ""}`}>
      <span className="an-kpi__label">{label}</span>
      <span className="an-kpi__value">{value}</span>
      {sub ? <span className="an-kpi__sub" title={sub}>{sub}</span> : null}
      {typeof curr === "number" && typeof prev === "number" ? <Delta curr={curr} prev={prev} goodDirection={goodDirection} /> : null}
    </div>
  );
}

function LineChart({ data, height = 170 }) {
  const width = 800;
  const padL = 40, padR = 44, padT = 14, padB = 26;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  if (!data || data.length === 0) {
    return <div className="an-empty">No data for this range yet.</div>;
  }

  const maxMsg = Math.max(1, ...data.map((d) => d.messages));
  const maxCost = Math.max(0.01, ...data.map((d) => d.cost));
  const x = (i) => padL + (data.length === 1 ? innerW / 2 : (i * innerW) / (data.length - 1));
  const yMsg = (v) => padT + innerH - (v / maxMsg) * innerH;
  const yCost = (v) => padT + innerH - (v / maxCost) * innerH;

  const pathMsg = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yMsg(d.messages).toFixed(1)}`).join(" ");
  const pathCost = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yCost(d.cost).toFixed(1)}`).join(" ");
  const areaMsg = `${pathMsg} L${x(data.length - 1).toFixed(1)},${padT + innerH} L${x(0).toFixed(1)},${padT + innerH} Z`;

  const ticks = [];
  const step = Math.max(1, Math.floor(data.length / 6));
  for (let i = 0; i < data.length; i += step) ticks.push(i);
  if (ticks[ticks.length - 1] !== data.length - 1) ticks.push(data.length - 1);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily conversations and cost" style={{ width: "100%", height: "auto", display: "block" }}>
      <defs>
        <linearGradient id="seosAnArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2D6B4F" stopOpacity="0.16" />
          <stop offset="1" stopColor="#2D6B4F" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
        const y = padT + innerH * t;
        return <line key={i} x1={padL} y1={y} x2={width - padR} y2={y} stroke="rgba(26,46,38,0.08)" strokeDasharray="2 4" />;
      })}
      {[0, 0.5, 1].map((t, i) => (
        <text key={i} x={padL - 6} y={padT + innerH * (1 - t) + 4} fontSize="10" fill="rgba(26,46,38,0.45)" textAnchor="end">{Math.round(maxMsg * t)}</text>
      ))}
      {[0, 0.5, 1].map((t, i) => (
        <text key={i} x={width - padR + 6} y={padT + innerH * (1 - t) + 4} fontSize="10" fill="rgba(26,46,38,0.45)" textAnchor="start">${(maxCost * t).toFixed(2)}</text>
      ))}
      {ticks.map((i) => (
        <text key={i} x={x(i)} y={height - 7} fontSize="10" fill="rgba(26,46,38,0.45)" textAnchor="middle">
          {data[i].date.slice(5)}
        </text>
      ))}
      <path d={areaMsg} fill="url(#seosAnArea)" />
      <path d={pathCost} fill="none" stroke="#b98a5a" strokeWidth="2" strokeDasharray="4 3" />
      <path d={pathMsg} fill="none" stroke="#2D6B4F" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {data.length <= 45 && data.map((d, i) => <circle key={`m${i}`} cx={x(i)} cy={yMsg(d.messages)} r="2.5" fill="#2D6B4F" />)}
    </svg>
  );
}

// Ranked list with proportional bars — the bar tells you "how much more"
// at a glance.
function RankList({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ol className="an-rank">
      {rows.map((r, i) => (
        <li key={`${r.title}-${i}`}>
          <div className="an-rank__top">
            <span className="an-rank__title" title={r.title}>{r.title}</span>
            <span className="an-rank__n">{r.count.toLocaleString()}</span>
          </div>
          <div className="an-rank__bar" aria-hidden="true"><span style={{ width: `${Math.max(3, (r.count / max) * 100)}%` }} /></div>
        </li>
      ))}
    </ol>
  );
}

// Always the last 7 days, whatever range is picked — the quick "what are
// customers asking?" read. The page shows the top lists; every topic is in
// the Topics export.
function WeekCard({ week }) {
  if (!week) return null;
  const lists = [
    { title: "Shopping for", rows: week.categories },
    { title: "Foot conditions", rows: week.conditions },
    { title: "Store questions", rows: week.storeQuestions },
    { title: "Products asked about", rows: week.products },
    { title: "Colors", rows: week.colors },
  ].filter((l) => l.rows?.length > 0).slice(0, 3);
  const meta = [
    week.messages ? `${week.messages.toLocaleString()} messages` : "",
    week.supportHandoffs ? `${week.supportHandoffs} sent to customer service` : "",
  ].filter(Boolean).join(" · ");
  return (
    <Group title="What customers asked about" badge={<Badge>Last 7 days</Badge>}>
      {meta && <div className="set-row__help" style={{ padding: "0 16px" }}>{meta}</div>}
      {week.empty ? (
        <div className="an-empty">Nothing yet this week — topics show up here as customers chat.</div>
      ) : (
        <>
          {week.unanswered?.length > 0 && (
            <div className="an-callout">
              <strong>Couldn't answer from your store info:</strong>{" "}
              {week.unanswered.map((u) => `${u.label}${u.count > 1 ? ` (${u.count})` : ""}`).join(" · ")}.{" "}
              Add the answer in <Link to="/app/knowledge">Knowledge → Your team's notes</Link> and AVA uses it right away.
            </div>
          )}
          {lists.length > 0 ? (
            <div className="an-cols" style={{ "--an-cols": lists.length }}>
              {lists.map((l) => (
                <div key={l.title}>
                  <div className="an-col__title">{l.title}</div>
                  <RankList rows={l.rows.map((r) => ({ title: r.label, count: r.count }))} />
                </div>
              ))}
            </div>
          ) : <div style={{ height: 14 }} />}
        </>
      )}
    </Group>
  );
}

function ProductsCard({ searched, viewed }) {
  const cols = [
    { title: "Searched for", rows: searched },
    { title: "Details asked — sizes, colors, price", rows: viewed },
  ].filter((c) => c.rows.length > 0);
  if (cols.length === 0) return null;
  return (
    <Group title="Top products in chats">
      <div className="an-cols" style={{ "--an-cols": cols.length }}>
        {cols.map((c) => (
          <div key={c.title}>
            <div className="an-col__title">{c.title}</div>
            <RankList rows={c.rows} />
          </div>
        ))}
      </div>
    </Group>
  );
}

// One conversation: the question, what went wrong (if flagged), and the
// full chat on demand.
function ConversationRow({ row, mounted }) {
  const [open, setOpen] = useState(false);
  const chat = row.kind === "chat";
  const transcript = Array.isArray(row.transcript) ? row.transcript : [];
  const products = row.products || [];
  return (
    <div className={`an-convo${row.vote === "down" ? " is-flagged" : ""}`}>
      <div className="an-convo__meta">
        {mounted && <span>{new Date(row.date).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>}
        {row.vote === "up" && <span className="an-pill is-up">{chat ? "Chat went well" : "Helpful"}</span>}
        {row.vote === "down" && <span className="an-pill is-down">{chat ? "Chat not great" : "Not helpful"}</span>}
        {chat && <span className="an-pill">Rated the whole chat</span>}
        {products.length > 0 && <span className="an-pill">{`${products.length} product${products.length > 1 ? "s" : ""}`}</span>}
      </div>
      {(row.lastUserQuestion || row.question) && <div className="an-convo__q an-clamp">{row.lastUserQuestion || row.question}</div>}
      {row.comment && <div className="an-convo__line"><b>Comment:</b> {row.comment}</div>}
      {row.flaggedAiResponse && <div className="an-convo__line an-clamp"><b>AVA said:</b> {row.flaggedAiResponse}</div>}
      {transcript.length > 0 && (
        <button type="button" className="an-convo__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide conversation" : `Read the conversation (${transcript.length} message${transcript.length > 1 ? "s" : ""})`}
        </button>
      )}
      {open && transcript.length > 0 && (
        <div className="an-chat">
          {transcript.map((m, idx) => (
            <div key={idx} className={`an-msg ${m.role === "user" ? "is-user" : "is-ai"}`}>{m.content}</div>
          ))}
          {products.length > 0 && <div className="set-row__help">{`Products shown: ${products.join(", ")}`}</div>}
        </div>
      )}
    </div>
  );
}

// Recent rated / finished chats: filter chips, the latest few, the rest on
// demand. Export downloads the active filter.
function ConversationsCard({ rows, onExport, exporting, mounted }) {
  const [filter, setFilter] = useState("all");
  const [showAll, setShowAll] = useState(false);
  const filtered = useMemo(() => {
    if (filter === "down") return rows.filter((r) => r.vote === "down");
    if (filter === "up") return rows.filter((r) => r.vote === "up");
    if (filter === "unrated") return rows.filter((r) => r.vote !== "up" && r.vote !== "down");
    if (filter === "comments") return rows.filter((r) => r.comment);
    return rows;
  }, [rows, filter]);
  // Counts derive from the loaded rows so each chip matches what it shows.
  const counts = useMemo(() => {
    let up = 0, down = 0;
    for (const r of rows) {
      if (r.vote === "up") up++;
      else if (r.vote === "down") down++;
    }
    return { up, down, unrated: rows.length - up - down, comments: rows.filter((r) => r.comment).length };
  }, [rows]);
  const FIRST = 5;
  const shown = showAll ? filtered : filtered.slice(0, FIRST);

  const chips = [
    { value: "all", label: "All", n: rows.length },
    { value: "down", label: "Not helpful", n: counts.down },
    { value: "up", label: "Helpful", n: counts.up },
    { value: "unrated", label: "No vote", n: counts.unrated },
    { value: "comments", label: "With comments", n: counts.comments },
  ].filter((c) => c.value === "all" || c.n > 0);

  return (
    <Card padding="0">
      <Row
        title={<InlineStack gap="200" blockAlign="center"><span>Customer conversations</span><Badge>{String(rows.length)}</Badge></InlineStack>}
        help="Recent chats customers rated, or that ended with a recommendation. Export downloads the filter you pick."
        control={
          <Button size="slim" onClick={() => onExport("conversations", filter === "all" ? {} : { vote: filter })} loading={exporting === "conversations"} disabled={Boolean(exporting) && exporting !== "conversations"}>
            Export
          </Button>
        }
      />
      <div className="an-chips" role="group" aria-label="Show">
        {chips.map((c) => (
          <button key={c.value} type="button" className="an-chip" aria-pressed={filter === c.value} onClick={() => { setFilter(c.value); setShowAll(false); }}>
            {c.label}<small>{c.n}</small>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="an-empty" style={{ borderTop: "1px solid rgba(30,27,51,0.07)" }}>No conversations match this filter.</div>
      ) : (
        shown.map((r) => <ConversationRow key={r.id} row={r} mounted={mounted} />)
      )}
      {filtered.length > FIRST && (
        <div className="an-more">
          <Button variant="plain" disclosure={showAll ? "up" : "down"} onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show fewer" : `Show ${filtered.length - FIRST} more`}
          </Button>
        </div>
      )}
    </Card>
  );
}

function RangeSelector({ current, searchParams }) {
  const [open, setOpen] = useState(false);
  const [pickerMonth, setPickerMonth] = useState(new Date().getMonth());
  const [pickerYear, setPickerYear] = useState(new Date().getFullYear());
  const [picked, setPicked] = useState({ start: new Date(searchParams.get("start") || Date.now() - 30 * 86400000), end: new Date(searchParams.get("end") || Date.now()) });

  const buildUrl = useCallback((preset, start, end) => {
    const p = new URLSearchParams();
    p.set("range", preset);
    if (preset === "custom" && start && end) {
      p.set("start", start.toISOString().slice(0, 10));
      p.set("end", end.toISOString().slice(0, 10));
    }
    return `?${p.toString()}`;
  }, []);

  return (
    <>
      <div className="an-seg" role="group" aria-label="Date range">
        {[
          { id: "7d", label: "7 days" },
          { id: "30d", label: "30 days" },
          { id: "90d", label: "90 days" },
          { id: "ytd", label: "YTD" },
        ].map((opt) => (
          <Link key={opt.id} to={buildUrl(opt.id)} className={current === opt.id ? "is-on" : ""} aria-current={current === opt.id ? "true" : undefined}>
            {opt.label}
          </Link>
        ))}
      </div>
      <Popover
        active={open}
        activator={<Button size="slim" pressed={current === "custom"} onClick={() => setOpen((v) => !v)} disclosure>Custom</Button>}
        onClose={() => setOpen(false)}
      >
        <Box padding="300" minWidth="320px">
          <BlockStack gap="300">
            <DatePicker
              month={pickerMonth}
              year={pickerYear}
              onMonthChange={(m, y) => { setPickerMonth(m); setPickerYear(y); }}
              selected={{ start: picked.start, end: picked.end }}
              onChange={({ start, end }) => setPicked({ start, end })}
              allowRange
            />
            <InlineStack align="end" gap="200">
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" url={buildUrl("custom", picked.start, picked.end)}>Apply</Button>
            </InlineStack>
          </BlockStack>
        </Box>
      </Popover>
    </>
  );
}

// Everything the page leaves off, one click away.
const EXPORTS = [
  { section: "summary", content: "Summary", helpText: "Every number for this range — cost, tokens, actions, votes" },
  { section: "daily", content: "Daily activity", helpText: "Conversations, cost and votes per day" },
  { section: "topics", content: "Topics", helpText: "Everything customers asked about, last 7 days" },
  { section: "searched", content: "Products searched for", helpText: "Every product, ranked" },
  { section: "viewed", content: "Product details asked", helpText: "Every product, ranked" },
  { section: "conversations", content: "Conversations", helpText: "With the full back-and-forth" },
  { section: "models", content: "Cost by AI model", helpText: "Conversations and cost per model" },
];

function ExportMenu({ onExport, exporting }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      active={open}
      activator={<Button size="slim" icon={ExportIcon} onClick={() => setOpen((v) => !v)} loading={Boolean(exporting)} disclosure>Export</Button>}
      onClose={() => setOpen(false)}
      preferredAlignment="right"
    >
      <ActionList
        actionRole="menuitem"
        sections={[{
          title: "Download a CSV",
          items: EXPORTS.map((e) => ({ content: e.content, helpText: e.helpText, onAction: () => { setOpen(false); onExport(e.section); } })),
        }]}
      />
    </Popover>
  );
}

export default function Analytics() {
  const { usage, feedback, productsByTool, recentQuestions, daily, conversions, previous, range, estimator, week } = useLoaderData();
  const [searchParams] = useSearchParams();
  const shopify = useAppBridge();
  const mounted = useMounted();
  const [exporting, setExporting] = useState(null);
  const [showEstimator, setShowEstimator] = useState(false);
  const hasData = usage.totalMessages > 0;

  // CSV download has to run from inside the embedded iframe so the App Bridge
  // session token is available. Opening ?export=… in a new tab (the old
  // `external` Button) bypasses the iframe, has no session token, and gets
  // bounced to the OAuth login page. Instead we fetch a dedicated resource
  // route (/app/exports) with the App Bridge JWT in the Authorization header
  // and trigger a download client-side from the returned blob. The exports
  // route is loader-only (no default component) so React Router serves the
  // CSV Response directly without server-rendering a page underneath it.
  const handleExport = useCallback(async (section, extraParams = {}) => {
    if (exporting) return;
    setExporting(section);
    try {
      const params = new URLSearchParams(searchParams);
      params.delete("export");
      params.set("section", section);
      for (const [k, v] of Object.entries(extraParams)) {
        if (v) params.set(k, v);
      }
      const url = `/app/exports?${params.toString()}`;
      const token = await shopify.idToken();
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const filename =
        res.headers.get("Content-Disposition")?.match(/filename="?([^";]+)"?/)?.[1] ||
        `${section}.csv`;
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err) {
      console.error("[analytics export] failed:", err);
      shopify.toast.show("Export failed. Please try again.", { isError: true });
    } finally {
      setExporting(null);
    }
  }, [searchParams, shopify, exporting]);

  const top5 = (list) => (list || []).slice(0, 5).map((p) => ({ title: p.title, count: p.count }));
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  return (
    <Page>
      <TitleBar title="Analytics" />
      {/* Static CSS, injected as-is: as a text child React would escape its
          quotes on the server and the page wouldn't hydrate. */}
      <style dangerouslySetInnerHTML={{ __html: SETTINGS_CSS + ANALYTICS_CSS }} />
      <div className="an set-links">
        <BlockStack gap="400">
          <BrandHeader title="Analytics" gutter={false} />

          <div className="an-top">
            <div>
              <h2>{range.label}</h2>
              <p>{mounted ? `${day(range.startDate)} – ${day(range.endDate)} · ${range.days} days` : ""}</p>
            </div>
            <div className="an-ctl">
              <RangeSelector current={range.preset} searchParams={searchParams} />
              <ExportMenu onExport={handleExport} exporting={exporting} />
            </div>
          </div>

          {!hasData && (
            <Banner tone="info" title="No conversations in this range yet">
              <p>Pick a wider range, or wait for customers to start chatting — numbers appear here as soon as AVA is live.</p>
            </Banner>
          )}

          <div className="an-kpis">
            <Kpi
              lead
              label="Chat-driven revenue"
              value={conversions.count > 0 ? formatRevenue(conversions.revenue, conversions.currency) : "—"}
              sub={conversions.count > 0
                ? `${conversions.count.toLocaleString()} order${conversions.count === 1 ? "" : "s"} · avg ${formatRevenue(conversions.aov, conversions.currency)}`
                : "Orders tagged “SEoS” show here"}
              curr={conversions.revenue}
              prev={previous.conversionRevenue}
            />
            <Kpi label="Conversations" value={usage.totalMessages.toLocaleString()} curr={usage.totalMessages} prev={previous.messages} />
            <Kpi
              label="Satisfaction"
              value={feedback.total > 0 ? `${feedback.satisfactionRate}%` : "—"}
              sub={feedback.total > 0 ? `${feedback.up} helpful · ${feedback.down} not` : "No votes yet"}
              curr={feedback.satisfactionRate}
              prev={previous.satisfaction}
            />
            <Kpi
              label="AI cost"
              value={formatCost(usage.totalCost)}
              sub={`${formatCost(usage.avgCostPerMessage)} per conversation`}
              curr={usage.totalCost}
              prev={previous.cost}
              goodDirection="down"
            />
          </div>

          <Card padding="0">
            <Row
              title="Conversations per day"
              control={
                <div className="an-legend">
                  <span><i style={{ background: "#2D6B4F" }} />Conversations</span>
                  <span><i style={{ background: "#b98a5a" }} />Cost</span>
                </div>
              }
            />
            <div className="an-chart"><LineChart data={daily} /></div>
          </Card>

          <WeekCard week={week} />

          <ProductsCard searched={top5(productsByTool?.searched)} viewed={top5(productsByTool?.viewed)} />

          {recentQuestions.length > 0 && (
            <ConversationsCard rows={recentQuestions} onExport={handleExport} exporting={exporting} mounted={mounted} />
          )}

          <div>
            <Button variant="plain" disclosure={showEstimator ? "up" : "down"} onClick={() => setShowEstimator((v) => !v)}>
              Estimate your monthly AI cost
            </Button>
            {showEstimator && <div style={{ marginTop: 12 }}><CostEstimator {...estimator} /></div>}
          </div>

          <div className="an-foot">
            More numbers — tokens, AI actions, cost by model — are in Export. Costs use AI engine pricing. User data is hashed for privacy; feedback is deleted after 90 days.
          </div>
        </BlockStack>
      </div>
    </Page>
  );
}

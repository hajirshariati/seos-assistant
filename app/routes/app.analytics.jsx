import { useState, useMemo, useCallback } from "react";
import { useLoaderData, useSearchParams, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Page, BlockStack, InlineStack, Box, Button, Popover, DatePicker,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getUsageSummary, getDailySeries } from "../models/ChatUsage.server";
import { getShopPlan } from "../lib/billing.server";
import { getFeedbackSummary, cleanupOldFeedback, getRecentQuestions } from "../models/ChatFeedback.server";
import {
  getTopProducts, getProductsByTool, getInterestBreakdown, cleanupOldMentions,
} from "../models/ChatProductMention.server";
import { getConversionSummary } from "../models/ChatConversion.server";
import BrandHeader from "../components/BrandHeader";
import CostEstimator from "../components/CostEstimator";

const MODEL_LABELS = {
  "claude-sonnet-4-20250514": "Standard",
  "claude-sonnet-4-6": "Standard",
  "claude-haiku-4-5-20251001": "Fast",
  "claude-haiku-4-5": "Fast",
  "claude-opus-4-20250514": "Advanced",
  "claude-opus-4-6": "Advanced",
  "claude-opus-4-7": "Advanced",
  "claude-opus-4-8": "Advanced",
};
const modelLabel = (m) => MODEL_LABELS[m] || m;

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
  const { session } = await authenticate.admin(request);
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

  const [usage, feedback, topProducts, productsByTool, interest, recentQuestions, daily, prevUsage, prevFeedback, conversions, prevConversions] = await Promise.all([
    getUsageSummary(session.shop, rangeArg),
    getFeedbackSummary(session.shop, rangeArg),
    getTopProducts(session.shop, rangeArg, 10),
    getProductsByTool(session.shop, rangeArg, 10),
    getInterestBreakdown(session.shop, rangeArg),
    getRecentQuestions(session.shop, rangeArg, 20),
    getDailySeries(session.shop, rangeArg),
    getUsageSummary(session.shop, prevRange),
    getFeedbackSummary(session.shop, prevRange),
    getConversionSummary(session.shop, rangeArg),
    getConversionSummary(session.shop, prevRange),
  ]);
  cleanupOldFeedback().catch(() => {});
  cleanupOldMentions().catch(() => {});

  return {
    usage, feedback, topProducts, productsByTool, interest, recentQuestions, daily, conversions,
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

function formatTokens(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function pctChange(curr, prev) {
  if (!prev) return curr > 0 ? { delta: 100, direction: "up" } : { delta: 0, direction: "flat" };
  const delta = ((curr - prev) / prev) * 100;
  return { delta: Math.abs(delta), direction: delta > 0.5 ? "up" : delta < -0.5 ? "down" : "flat" };
}

// Compact change pill — green when the move is in the good direction,
// amber when it isn't, quiet gray when flat.
function Delta({ curr, prev, goodDirection = "up" }) {
  const { delta, direction } = pctChange(curr, prev);
  if (direction === "flat") {
    return <span className="seos-an-delta">No change</span>;
  }
  const good = direction === goodDirection;
  return (
    <span className={`seos-an-delta ${good ? "is-good" : "is-warn"}`}>
      {direction === "up" ? "↑" : "↓"} {delta.toFixed(0)}% <small>vs prior</small>
    </span>
  );
}

function Kpi({ label, value, sub, curr, prev, goodDirection = "up" }) {
  return (
    <div className="seos-an-kpi">
      <span className="seos-an-kpi-label">{label}</span>
      <span className="seos-an-kpi-value">{value}</span>
      {sub ? <span className="seos-an-kpi-sub">{sub}</span> : null}
      {typeof curr === "number" && typeof prev === "number" ? (
        <Delta curr={curr} prev={prev} goodDirection={goodDirection} />
      ) : null}
    </div>
  );
}

// Card shell with a standard header row (title, optional count chip,
// description, optional Export CSV button) so every section reads the same.
function SectionCard({ title, description, count, exportSection, onExport, exporting, children }) {
  return (
    <section className="seos-an-card">
      <div className="seos-an-cardhead">
        <div className="seos-an-cardhead-text">
          <div className="seos-an-title">
            {title}
            {count != null ? <span className="seos-an-count">{count}</span> : null}
          </div>
          {description ? <div className="seos-an-desc">{description}</div> : null}
        </div>
        {exportSection ? (
          <button
            type="button"
            className="seos-an-export"
            disabled={Boolean(exporting)}
            onClick={() => onExport(exportSection)}
          >
            {exporting === exportSection ? "Exporting…" : "Export CSV"}
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function LineChart({ data, height = 220 }) {
  const width = 800;
  const padL = 40, padR = 44, padT = 16, padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  if (!data || data.length === 0) {
    return <div className="seos-an-empty">No data for this range yet.</div>;
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
        <text key={i} x={x(i)} y={height - 8} fontSize="10" fill="rgba(26,46,38,0.45)" textAnchor="middle">
          {data[i].date.slice(5)}
        </text>
      ))}
      <path d={areaMsg} fill="url(#seosAnArea)" />
      <path d={pathCost} fill="none" stroke="#b98a5a" strokeWidth="2" strokeDasharray="4 3" />
      <path d={pathMsg} fill="none" stroke="#2D6B4F" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {data.map((d, i) => <circle key={`m${i}`} cx={x(i)} cy={yMsg(d.messages)} r="2.5" fill="#2D6B4F" />)}
    </svg>
  );
}

// Ranked list with proportional bars — easier to scan than a numbered
// DataTable: the bar tells you "how much more" at a glance.
function RankList({ rows, countLabel }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="seos-an-rank" role="list">
      {rows.map((r, i) => (
        <div className="seos-an-rankrow" role="listitem" key={`${r.title}-${i}`}>
          <span className="seos-an-rankidx">{i + 1}</span>
          <div className="seos-an-rankmain">
            <div className="seos-an-ranktop">
              <span className="seos-an-ranktitle" title={r.title}>{r.title}</span>
              <span className="seos-an-rankcount">{r.count} <small>{countLabel}</small></span>
            </div>
            <div className="seos-an-rankbar"><span style={{ width: `${Math.max(2, (r.count / max) * 100)}%` }} /></div>
          </div>
        </div>
      ))}
    </div>
  );
}

// One conversation row: date + vote pill + the customer's question and the
// AI's answer, expanding into the full chat-bubble transcript on click.
function ConversationRow({
  date, vote, productsCount, productsList, headlineText, aiResponseText, transcript,
}) {
  const [open, setOpen] = useState(false);
  const hasTranscript = Array.isArray(transcript) && transcript.length > 0;
  return (
    <div className={`seos-an-convo ${vote === "down" ? "is-flagged" : ""}`}>
      <div className="seos-an-convo-meta">
        <span className="seos-an-convo-date">
          {new Date(date).toLocaleString(undefined, {
            year: "numeric", month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit",
          })}
        </span>
        {vote === "up" && <span className="seos-an-vote is-up">Helpful</span>}
        {vote === "down" && <span className="seos-an-vote is-down">Not helpful</span>}
        {productsCount > 0 && (
          <span className="seos-an-vote">{productsCount} product{productsCount > 1 ? "s" : ""}</span>
        )}
        {hasTranscript && (
          <span className="seos-an-vote">{transcript.length} turn{transcript.length > 1 ? "s" : ""}</span>
        )}
      </div>
      {headlineText && (
        <div className="seos-an-convo-block">
          <span className="seos-an-convo-role">Customer asked</span>
          <p>{headlineText}</p>
        </div>
      )}
      {aiResponseText && (
        <div className="seos-an-convo-block">
          <span className="seos-an-convo-role">AI responded</span>
          <p>{aiResponseText}</p>
        </div>
      )}
      {Array.isArray(productsList) && productsList.length > 0 && (
        <div className="seos-an-convo-products">Products shown: {productsList.join(", ")}</div>
      )}
      {hasTranscript && (
        <button type="button" className="seos-an-convo-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide full conversation" : `Show full conversation (${transcript.length} turn${transcript.length > 1 ? "s" : ""})`}
        </button>
      )}
      {open && hasTranscript && (
        <div className="seos-an-transcript">
          {transcript.map((m, idx) => {
            const isUser = m.role === "user";
            return (
              <div key={idx} className={`seos-an-msg ${isUser ? "is-user" : "is-ai"}`}>
                <span className="seos-an-msg-role">{isUser ? "Customer" : "Assistant"}</span>
                <div className="seos-an-msg-bubble">{m.content}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Unified feedback card: one list, pill filters, one export.
function ConversationsCard({ rows, onExport, exporting }) {
  const [filter, setFilter] = useState("all");
  const filtered = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "down") return rows.filter((r) => r.vote === "down");
    if (filter === "up") return rows.filter((r) => r.vote === "up");
    if (filter === "unrated") return rows.filter((r) => r.vote !== "up" && r.vote !== "down");
    return rows;
  }, [rows, filter]);
  // Counts derive from the visible rows (capped at 20) so the chip numbers
  // always match what each filter actually shows.
  const counts = useMemo(() => {
    let up = 0, down = 0;
    for (const r of rows) {
      if (r.vote === "up") up++;
      else if (r.vote === "down") down++;
    }
    return { up, down, unrated: rows.length - up - down };
  }, [rows]);

  const Chip = ({ value, label, count, tone }) => (
    <button
      type="button"
      className={`seos-an-chip ${filter === value ? "is-on" : ""} ${tone ? `tone-${tone}` : ""}`}
      onClick={() => setFilter(value)}
    >
      {label} <small>{count}</small>
    </button>
  );

  return (
    <SectionCard
      title="Customer conversations"
      count={rows.length}
      description="Recent chats where the customer voted or that completed with a recommendation. Filter, then expand any row to read the full back-and-forth. Export CSV downloads the active filter — select Not helpful to download just the flagged responses."
      exportSection="conversations"
      onExport={(section) => onExport(section, filter === "all" ? {} : { vote: filter })}
      exporting={exporting}
    >
      <div className="seos-an-chips">
        <Chip value="all" label="All" count={rows.length} />
        {counts.down > 0 && <Chip value="down" label="Not helpful" count={counts.down} tone="down" />}
        {counts.up > 0 && <Chip value="up" label="Helpful" count={counts.up} tone="up" />}
        {counts.unrated > 0 && <Chip value="unrated" label="No vote" count={counts.unrated} />}
      </div>
      {filtered.length === 0 ? (
        <div className="seos-an-empty">No conversations match this filter.</div>
      ) : (
        <div className="seos-an-convos">
          {filtered.map((q) => (
            <ConversationRow
              key={q.id}
              date={q.date}
              vote={q.vote}
              productsCount={q.products?.length || 0}
              productsList={q.products}
              headlineText={q.lastUserQuestion || q.question}
              aiResponseText={q.flaggedAiResponse}
              transcript={q.transcript}
            />
          ))}
        </div>
      )}
    </SectionCard>
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
    <div className="seos-an-rangectl">
      <div className="seos-an-seg" role="group" aria-label="Date range">
        {[
          { id: "7d", label: "7 days" },
          { id: "30d", label: "30 days" },
          { id: "90d", label: "90 days" },
          { id: "ytd", label: "YTD" },
        ].map((opt) => (
          <Link key={opt.id} to={buildUrl(opt.id)} className={current === opt.id ? "is-on" : ""}>
            {opt.label}
          </Link>
        ))}
      </div>
      <Popover
        active={open}
        activator={(
          <button type="button" className={`seos-an-rangebtn ${current === "custom" ? "is-on" : ""}`} onClick={() => setOpen((v) => !v)}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M1.5 6h13" stroke="currentColor" strokeWidth="1.5" />
              <path d="M5 1v3M11 1v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Custom
          </button>
        )}
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
    </div>
  );
}

export default function Analytics() {
  const { usage, feedback, productsByTool, interest, recentQuestions, daily, conversions, previous, range } = useLoaderData();
  const [searchParams] = useSearchParams();
  const shopify = useAppBridge();
  const [exporting, setExporting] = useState(null);
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

  const modelRows = useMemo(() => {
    const rows = Object.entries(usage.byModel).map(([m, d]) => ({
      model: modelLabel(m),
      messages: d.messages,
      cost: d.cost,
      avg: d.messages > 0 ? d.cost / d.messages : null,
    }));
    // Quiet breakout of the semantic-search (embedding) share — already
    // included in the model totals above, surfaced so merchants can see
    // what the optional embedding provider actually costs.
    if (usage.embeddingCost > 0) {
      rows.push({
        model: "Semantic search",
        messages: usage.totalMessages,
        cost: usage.embeddingCost,
        avg: usage.avgEmbeddingCostPerMessage,
      });
    }
    return rows;
  }, [usage]);

  const searchedRows = (productsByTool?.searched || []).slice(0, 10).map((p) => ({ title: p.title, count: p.count }));
  const viewedRows = (productsByTool?.viewed || []).slice(0, 10).map((p) => ({ title: p.title, count: p.count }));
  const activeDays = daily.filter((d) => d.messages > 0).length;

  return (
    <Page>
      <TitleBar title="Analytics" />
      <style>{`
        .seos-an { display: flex; flex-direction: column; gap: 16px; }
        .seos-an, .seos-an * { box-sizing: border-box; }

        /* Card chrome — same as the home page Explore cards. */
        .seos-an-card {
          background: #fff;
          border: 1px solid rgba(0,0,0,0.07);
          border-radius: 16px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.04);
          padding: 20px;
        }
        .seos-an-cardhead {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 16px;
        }
        .seos-an-cardhead-text { min-width: 0; }
        .seos-an-title {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 15px;
          font-weight: 650;
          color: #1a2e26;
          letter-spacing: -0.1px;
        }
        .seos-an-count {
          font-size: 11px;
          font-weight: 600;
          color: #2D6B4F;
          background: rgba(45,107,79,0.08);
          border: 1px solid rgba(45,107,79,0.18);
          border-radius: 999px;
          padding: 1px 8px;
        }
        .seos-an-desc { font-size: 12.5px; line-height: 1.5; color: rgba(26,46,38,0.62); margin-top: 4px; }
        .seos-an-export {
          appearance: none;
          font: inherit;
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: #fff;
          border: 1px solid rgba(0,0,0,0.1);
          border-radius: 999px;
          padding: 6px 13px;
          font-size: 12px;
          font-weight: 600;
          color: #1a2e26;
          cursor: pointer;
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
          white-space: nowrap;
        }
        .seos-an-export:hover:not(:disabled) { border-color: rgba(45,107,79,0.4); box-shadow: 0 1px 4px rgba(26,46,38,0.1); }
        .seos-an-export:disabled { opacity: 0.5; cursor: default; }

        /* Range bar. */
        .seos-an-rangebar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
        }
        .seos-an-rangelabel { font-size: 17px; font-weight: 650; color: #1a2e26; letter-spacing: -0.2px; }
        .seos-an-rangedates { font-size: 12px; color: rgba(26,46,38,0.55); margin-top: 2px; }
        .seos-an-rangectl { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .seos-an-seg {
          display: inline-flex;
          gap: 2px;
          padding: 2px;
          background: rgba(26,46,38,0.05);
          border-radius: 9px;
        }
        .seos-an-seg a {
          font-size: 12px;
          font-weight: 600;
          color: rgba(26,46,38,0.6) !important;
          text-decoration: none !important;
          border-radius: 7px;
          padding: 5px 11px;
          transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
        }
        .seos-an-seg a.is-on { background: #fff; color: #1a2e26 !important; box-shadow: 0 1px 3px rgba(26,46,38,0.14); }
        .seos-an-rangebtn {
          appearance: none;
          font: inherit;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: #fff;
          border: 1px solid rgba(0,0,0,0.1);
          border-radius: 999px;
          padding: 6px 13px;
          font-size: 12px;
          font-weight: 600;
          color: #1a2e26;
          cursor: pointer;
          transition: border-color 0.15s ease;
        }
        .seos-an-rangebtn:hover { border-color: rgba(45,107,79,0.4); }
        .seos-an-rangebtn.is-on { border-color: #2D6B4F; color: #2D6B4F; background: rgba(45,107,79,0.06); }

        /* KPI tiles. */
        .seos-an-heroes {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: 16px;
        }
        .seos-an-hero {
          background: linear-gradient(160deg, rgba(45,107,79,0.055), rgba(58,138,102,0.03)), #fff;
          border: 1px solid rgba(45,107,79,0.16);
          border-radius: 16px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.04);
          padding: 20px;
        }
        .seos-an-hero .seos-an-kpi-value { font-size: 34px; letter-spacing: -1px; }
        .seos-an-kpis {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
          gap: 16px;
        }
        .seos-an-kpitile {
          background: #fff;
          border: 1px solid rgba(0,0,0,0.07);
          border-radius: 16px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.04);
          padding: 16px 18px;
        }
        .seos-an-kpi { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .seos-an-kpi-label {
          font-size: 11px;
          font-weight: 650;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: rgba(26,46,38,0.5);
        }
        .seos-an-kpi-value {
          font-size: 24px;
          font-weight: 700;
          letter-spacing: -0.6px;
          color: #1a2e26;
          font-variant-numeric: tabular-nums;
          line-height: 1.15;
        }
        .seos-an-kpi-sub { font-size: 11.5px; color: rgba(26,46,38,0.5); }
        .seos-an-delta {
          align-self: flex-start;
          margin-top: 4px;
          font-size: 11px;
          font-weight: 650;
          color: rgba(26,46,38,0.5);
          background: rgba(26,46,38,0.05);
          border-radius: 999px;
          padding: 2px 9px;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .seos-an-delta small { font-weight: 500; opacity: 0.75; }
        .seos-an-delta.is-good { color: #2D6B4F; background: rgba(45,107,79,0.1); }
        .seos-an-delta.is-warn { color: #8a5a1f; background: rgba(185,138,90,0.16); }

        /* Inline stat row (How the AI helps customers). */
        .seos-an-statrow {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 16px;
        }
        .seos-an-statrow .seos-an-kpi {
          padding: 12px 16px;
          background: rgba(26,46,38,0.025);
          border: 1px solid rgba(0,0,0,0.05);
          border-radius: 12px;
        }

        /* Ranked lists with bars. */
        .seos-an-twocol {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
          gap: 16px;
          align-items: start;
        }
        .seos-an-rank { display: flex; flex-direction: column; gap: 12px; }
        .seos-an-rankrow { display: flex; align-items: flex-start; gap: 12px; }
        .seos-an-rankidx {
          flex-shrink: 0;
          width: 22px;
          height: 22px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          font-weight: 650;
          color: rgba(26,46,38,0.55);
          background: rgba(26,46,38,0.05);
          border-radius: 999px;
          margin-top: 1px;
          font-variant-numeric: tabular-nums;
        }
        .seos-an-rankmain { flex: 1; min-width: 0; }
        .seos-an-ranktop {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
        }
        .seos-an-ranktitle {
          font-size: 13px;
          font-weight: 550;
          color: #1a2e26;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .seos-an-rankcount {
          flex-shrink: 0;
          font-size: 12.5px;
          font-weight: 650;
          color: #1a2e26;
          font-variant-numeric: tabular-nums;
        }
        .seos-an-rankcount small { font-weight: 500; color: rgba(26,46,38,0.45); }
        .seos-an-rankbar {
          margin-top: 5px;
          height: 5px;
          border-radius: 999px;
          background: rgba(26,46,38,0.06);
          overflow: hidden;
        }
        .seos-an-rankbar span {
          display: block;
          height: 100%;
          border-radius: 999px;
          background: linear-gradient(90deg, #2D6B4F, #3a8a66);
        }

        /* Chart bits. */
        .seos-an-legend { display: flex; gap: 20px; margin-top: 10px; flex-wrap: wrap; }
        .seos-an-legend span { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: rgba(26,46,38,0.6); }
        .seos-an-legend i { width: 16px; height: 3px; border-radius: 2px; display: inline-block; }
        .seos-an-empty {
          padding: 28px 16px;
          text-align: center;
          font-size: 13px;
          color: rgba(26,46,38,0.5);
          background: rgba(26,46,38,0.025);
          border-radius: 12px;
        }
        .seos-an-note {
          background: rgba(45,107,79,0.05);
          border: 1px solid rgba(45,107,79,0.16);
          border-radius: 16px;
          padding: 14px 18px;
          font-size: 13px;
          line-height: 1.5;
          color: rgba(26,46,38,0.75);
        }
        .seos-an-note strong { color: #1a2e26; }

        /* Conversations. */
        .seos-an-chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
        .seos-an-chip {
          appearance: none;
          font: inherit;
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
          color: rgba(26,46,38,0.65);
          background: #fff;
          border: 1px solid rgba(0,0,0,0.1);
          border-radius: 999px;
          padding: 5px 12px;
          transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
        }
        .seos-an-chip small { font-weight: 650; opacity: 0.7; }
        .seos-an-chip:hover { border-color: rgba(45,107,79,0.4); }
        .seos-an-chip.is-on { background: #2D6B4F; border-color: #2D6B4F; color: #fff; }
        .seos-an-chip.is-on small { opacity: 0.85; }
        .seos-an-convos { display: flex; flex-direction: column; gap: 10px; }
        .seos-an-convo {
          border: 1px solid rgba(0,0,0,0.06);
          background: rgba(26,46,38,0.018);
          border-radius: 12px;
          padding: 14px 16px;
        }
        .seos-an-convo.is-flagged { background: rgba(185,90,90,0.045); border-color: rgba(185,90,90,0.18); }
        .seos-an-convo-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
        .seos-an-convo-date { font-size: 11.5px; color: rgba(26,46,38,0.5); }
        .seos-an-vote {
          font-size: 10.5px;
          font-weight: 650;
          color: rgba(26,46,38,0.55);
          background: rgba(26,46,38,0.06);
          border-radius: 999px;
          padding: 2px 8px;
          white-space: nowrap;
        }
        .seos-an-vote.is-up { color: #2D6B4F; background: rgba(45,107,79,0.1); }
        .seos-an-vote.is-down { color: #a33d3d; background: rgba(185,90,90,0.12); }
        .seos-an-convo-block { margin-top: 6px; }
        .seos-an-convo-role {
          display: block;
          font-size: 10px;
          font-weight: 650;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: rgba(26,46,38,0.45);
          margin-bottom: 2px;
        }
        .seos-an-convo-block p { margin: 0; font-size: 13px; line-height: 1.5; color: #1a2e26; }
        .seos-an-convo-products { margin-top: 8px; font-size: 11.5px; color: rgba(26,46,38,0.5); }
        .seos-an-convo-toggle {
          appearance: none;
          font: inherit;
          background: none;
          border: none;
          padding: 0;
          margin-top: 10px;
          font-size: 12px;
          font-weight: 600;
          color: #2D6B4F;
          cursor: pointer;
        }
        .seos-an-convo-toggle:hover { text-decoration: underline; }
        .seos-an-transcript {
          margin-top: 12px;
          padding: 14px;
          background: #fff;
          border: 1px solid rgba(0,0,0,0.06);
          border-radius: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .seos-an-msg { display: flex; flex-direction: column; gap: 3px; max-width: 85%; }
        .seos-an-msg.is-user { align-self: flex-end; align-items: flex-end; }
        .seos-an-msg.is-ai { align-self: flex-start; align-items: flex-start; }
        .seos-an-msg-role {
          font-size: 10px;
          font-weight: 650;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          color: rgba(26,46,38,0.4);
        }
        .seos-an-msg-bubble {
          font-size: 13px;
          line-height: 1.5;
          color: #1a2e26;
          padding: 8px 12px;
          border-radius: 12px;
          background: rgba(26,46,38,0.04);
        }
        .seos-an-msg.is-user .seos-an-msg-bubble {
          background: rgba(45,107,79,0.1);
          border-bottom-right-radius: 4px;
        }
        .seos-an-msg.is-ai .seos-an-msg-bubble {
          border: 1px solid rgba(0,0,0,0.06);
          background: #fff;
          border-bottom-left-radius: 4px;
        }

        /* Model breakdown table. */
        .seos-an-table { display: flex; flex-direction: column; }
        .seos-an-tr {
          display: grid;
          grid-template-columns: 1.4fr 1fr 1fr 1fr;
          gap: 12px;
          padding: 9px 4px;
          font-size: 13px;
          color: #1a2e26;
          border-bottom: 1px solid rgba(0,0,0,0.05);
          font-variant-numeric: tabular-nums;
        }
        .seos-an-tr:last-child { border-bottom: none; }
        .seos-an-tr span:not(:first-child) { text-align: right; }
        .seos-an-tr--head {
          font-size: 11px;
          font-weight: 650;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          color: rgba(26,46,38,0.45);
        }

        .seos-an-foot {
          text-align: center;
          font-size: 11.5px;
          color: rgba(26,46,38,0.45);
          padding: 6px 8px 2px;
          line-height: 1.6;
        }

        @media (prefers-reduced-motion: reduce) {
          .seos-an * { transition: none !important; }
        }
      `}</style>
      <BlockStack gap="500">
        <BrandHeader title="Analytics" gutter={false} />
        <div className="seos-an">

          <div className="seos-an-card seos-an-rangebar">
            <div>
              <div className="seos-an-rangelabel">{range.label}</div>
              <div className="seos-an-rangedates">
                {new Date(range.startDate).toLocaleDateString()} &mdash; {new Date(range.endDate).toLocaleDateString()} &middot; {range.days} days
              </div>
            </div>
            <RangeSelector current={range.preset} searchParams={searchParams} />
          </div>

          {!hasData && (
            <div className="seos-an-note">
              <strong>No conversations yet in this range.</strong> Pick a wider range
              or wait for customers to start chatting — data appears here as soon as
              the widget is live.
            </div>
          )}

          <div className="seos-an-heroes">
            <div className="seos-an-hero">
              <Kpi
                label="Chat-driven orders"
                value={String(conversions.count)}
                sub={conversions.count > 0 ? `Tagged “SEoS” in Shopify` : "Awaiting first chat-attributed order"}
                curr={conversions.count}
                prev={previous.conversionCount}
              />
            </div>
            <div className="seos-an-hero">
              <Kpi
                label="Chat-driven revenue"
                value={conversions.count > 0 ? formatRevenue(conversions.revenue, conversions.currency) : "—"}
                sub={conversions.count > 0 ? `Avg ${formatRevenue(conversions.aov, conversions.currency)} / order` : "Tracked via the SEoS order tag"}
                curr={conversions.revenue}
                prev={previous.conversionRevenue}
              />
            </div>
          </div>

          <div className="seos-an-kpis">
            <div className="seos-an-kpitile">
              <Kpi label="Conversations" value={String(usage.totalMessages)} curr={usage.totalMessages} prev={previous.messages} />
            </div>
            <div className="seos-an-kpitile">
              <Kpi
                label="Satisfaction"
                value={feedback.total > 0 ? `${feedback.satisfactionRate}%` : "—"}
                sub={feedback.total > 0 ? `${feedback.up} helpful · ${feedback.down} not` : "Awaiting feedback"}
                curr={feedback.satisfactionRate}
                prev={previous.satisfaction}
              />
            </div>
            <div className="seos-an-kpitile">
              <Kpi label="AI Actions" value={String(usage.totalToolCalls)} sub="Searches & lookups" curr={usage.totalToolCalls} prev={previous.toolCalls} />
            </div>
            <div className="seos-an-kpitile">
              <Kpi
                label="API Cost"
                value={formatCost(usage.totalCost)}
                sub={usage.embeddingCost > 0
                  ? `Avg ${formatCost(usage.avgCostPerMessage)} / msg · incl. semantic search ${formatCost(usage.embeddingCost)}`
                  : `Avg ${formatCost(usage.avgCostPerMessage)} / msg`}
                curr={usage.totalCost}
                prev={previous.cost}
                goodDirection="down"
              />
            </div>
          </div>

          <SectionCard
            title="Daily activity"
            description="Conversations and API cost, day by day across the selected range."
            exportSection="daily"
            onExport={handleExport}
            exporting={exporting}
          >
            <LineChart data={daily} />
            <div className="seos-an-legend">
              <span><i style={{ background: "#2D6B4F" }} />Conversations (left axis)</span>
              <span><i style={{ background: "#b98a5a" }} />Cost (right axis)</span>
            </div>
          </SectionCard>

          {interest.total > 0 && (
            <SectionCard
              title="How the AI helps customers"
              description="What the assistant actually does when customers ask questions."
            >
              <div className="seos-an-statrow">
                <Kpi label="Product searches" value={String(interest.searches)} sub="Customers looking for products" />
                <Kpi label="Product views" value={String(interest.views)} sub="Detailed info requested" />
                <Kpi label="SKU lookups" value={String(interest.skuLookups)} sub="Matched to uploaded data" />
                <Kpi label="Total actions" value={String(interest.total)} sub="Across all interactions" />
              </div>
            </SectionCard>
          )}

          {(searchedRows.length > 0 || viewedRows.length > 0) && (
            <div className="seos-an-twocol">
              {searchedRows.length > 0 && (
                <SectionCard
                  title="What customers search for"
                  description="Products customers asked the AI to find."
                  exportSection="searched"
                  onExport={handleExport}
                  exporting={exporting}
                >
                  <RankList rows={searchedRows} countLabel="searches" />
                </SectionCard>
              )}
              {viewedRows.length > 0 && (
                <SectionCard
                  title="Products with detail requests"
                  description="Strongest purchase signals — pricing, sizes, availability."
                  exportSection="viewed"
                  onExport={handleExport}
                  exporting={exporting}
                >
                  <RankList rows={viewedRows} countLabel="views" />
                </SectionCard>
              )}
            </div>
          )}

          {recentQuestions.length > 0 && (
            <ConversationsCard
              rows={recentQuestions}
              onExport={handleExport}
              exporting={exporting}
            />
          )}

          <SectionCard
            title="Under the hood"
            description="Token usage and per-model cost. Smart routing answers short follow-ups on the Fast model and product questions on Standard."
            exportSection={modelRows.length > 0 ? "models" : undefined}
            onExport={handleExport}
            exporting={exporting}
          >
            <div className="seos-an-statrow" style={{ marginBottom: modelRows.length > 0 ? 18 : 0 }}>
              <Kpi label="Input tokens" value={formatTokens(usage.totalInputTokens)} sub="Prompts sent to AI" />
              <Kpi label="Output tokens" value={formatTokens(usage.totalOutputTokens)} sub="Responses generated" />
              <Kpi label="Avg cost / message" value={formatCost(usage.avgCostPerMessage)} sub="Across all models" />
              <Kpi label="Active days" value={`${activeDays}/${daily.length}`} sub={`${Math.round((activeDays / Math.max(1, daily.length)) * 100)}% of range`} />
            </div>
            {modelRows.length > 0 && (
              <div className="seos-an-table" role="table" aria-label="Cost by model">
                <div className="seos-an-tr seos-an-tr--head" role="row">
                  <span>Model</span><span>Messages</span><span>Total cost</span><span>Avg / msg</span>
                </div>
                {modelRows.map((r) => (
                  <div className="seos-an-tr" role="row" key={r.model}>
                    <span>{r.model}</span>
                    <span>{r.messages.toLocaleString()}</span>
                    <span>{formatCost(r.cost)}</span>
                    <span>{r.avg != null ? formatCost(r.avg) : "—"}</span>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <CostEstimator avgCostPerMessage={usage.avgCostPerMessage} totalMessages={usage.totalMessages} />

          <div className="seos-an-foot">
            Cost estimates based on AI engine pricing. User data hashed for privacy.
            Feedback auto-deleted after 90 days.
          </div>
        </div>
      </BlockStack>
    </Page>
  );
}

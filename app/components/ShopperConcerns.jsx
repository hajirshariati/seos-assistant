// "Top shopper issues & questions" — the card at the top of Test recordings:
// the three issues, needs or questions the most shopper chats raised (all
// time; everyday browsing isn't counted), each with its count, a shopper's
// own words and what to look at; the next few below.
// "View chats" narrows the list underneath to that theme's kept chats.
import { useState } from "react";
import { Card, Button, Spinner } from "@shopify/polaris";
import { SectionHead } from "./SettingsUI";
import { KIND_LABELS } from "../lib/chat-concerns.js";

export const CONCERNS_CSS = `
  .sc-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .sc-tile { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 16px; }
  .sc-tile + .sc-tile { border-left: 1px solid rgba(30,27,51,0.07); }
  .sc-tile[data-active="true"] { background: rgba(45,107,79,0.05); }
  .sc-tile[data-active="true"] .sc-quote { background: #fff; }
  .sc-top { display: flex; align-items: center; gap: 8px; }
  .sc-rank { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; flex: none;
    font-size: 12px; font-weight: 700; color: #1a2e26; background: rgba(26,46,38,0.07); font-variant-numeric: tabular-nums; }
  .sc-kind { font-size: 11.5px; line-height: 16px; font-weight: 650; padding: 2px 8px; border-radius: 999px; }
  .sc-kind--complaint { color: #a33d3d; background: #fff1f0; }
  .sc-kind--question { color: #245a86; background: #eef4fb; }
  .sc-kind--request { color: #7a5412; background: #fbf3e4; }
  .sc-title { font-size: 15px; line-height: 21px; font-weight: 650; color: #1a1a1a; overflow-wrap: anywhere; }
  .sc-count { display: flex; align-items: baseline; gap: 6px; font-size: 12.5px; color: #616161; }
  .sc-count b { font-size: 22px; line-height: 26px; font-weight: 700; color: #1a2e26; font-variant-numeric: tabular-nums; }
  .sc-bar { height: 4px; border-radius: 999px; background: rgba(26,46,38,0.07); overflow: hidden; }
  .sc-bar span { display: block; height: 100%; border-radius: inherit; background: #2D6B4F; }
  .sc-summary { margin: 0; font-size: 13px; line-height: 19px; color: #303030; }
  .sc-quote { margin: 0; padding: 8px 10px; border-radius: 10px; background: #f5f5f7; font-size: 12.5px; line-height: 18px; color: #4a4a4a;
    font-style: italic; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .sc-look { font-size: 12.5px; line-height: 18px; color: #303030; }
  .sc-look b { display: block; font-size: 11px; line-height: 16px; font-weight: 650; letter-spacing: .02em; text-transform: uppercase; color: #2D6B4F; }
  .sc-view { margin-top: auto; padding-top: 2px; }
  .sc-note { padding: 22px 16px; text-align: center; font-size: 13px; line-height: 19px; color: #616161; }
  .sc-note b { display: block; margin-bottom: 2px; font-size: 14px; color: #1a1a1a; }
  .sc-more { border-top: 1px solid rgba(30,27,51,0.07); }
  .sc-more__row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 10px; padding: 9px 16px; font-size: 13px; }
  .sc-more__row + .sc-more__row { border-top: 1px solid rgba(30,27,51,0.05); }
  .sc-more__title { min-width: 0; font-weight: 600; color: #1a1a1a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sc-more__n { font-size: 12.5px; color: #616161; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sc-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; padding: 10px 16px;
    border-top: 1px solid rgba(30,27,51,0.07); font-size: 12.5px; color: #616161; }
  .sc-foot__state { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
  .sc-err { color: #a33d3d; font-weight: 600; }
  @media (max-width: 760px) {
    .sc-grid { grid-template-columns: minmax(0, 1fr); }
    .sc-tile + .sc-tile { border-left: 0; border-top: 1px solid rgba(30,27,51,0.07); }
    .sc-more__row { grid-template-columns: minmax(0, 1fr) auto; }
    .sc-more__row .sc-kind { display: none; }
  }
`;

const plural = (n, one, many) => `${Number(n || 0).toLocaleString()} ${n === 1 ? one : many}`;
const pct = (share) => (share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`);

function Kind({ kind }) {
  return <span className={`sc-kind sc-kind--${KIND_LABELS[kind] ? kind : "question"}`}>{KIND_LABELS[kind] || KIND_LABELS.question}</span>;
}

function Tile({ t, rank, active, onView }) {
  const kept = t.sessionIds.length;
  return (
    <div className="sc-tile" data-active={active ? "true" : undefined}>
      <div className="sc-top">
        <span className="sc-rank" aria-label={`Number ${rank}`}>{rank}</span>
        <Kind kind={t.kind} />
      </div>
      <div className="sc-title">{t.title}</div>
      <div className="sc-count"><b>{t.count.toLocaleString()}</b><span>{`${t.count === 1 ? "chat" : "chats"} · ${pct(t.share)} of shopper chats`}</span></div>
      <div className="sc-bar" aria-hidden="true"><span style={{ width: `${Math.max(2, Math.min(100, Math.round(t.share * 100)))}%` }} /></div>
      {t.summary && <p className="sc-summary">{t.summary}</p>}
      {t.quote && <blockquote className="sc-quote">{`“${t.quote}”`}</blockquote>}
      {t.lookAt && <div className="sc-look"><b>Look at</b>{t.lookAt}</div>}
      {kept > 0 && (
        <div className="sc-view">
          <Button variant="plain" onClick={() => onView(active ? null : t)} accessibilityLabel={active ? "Show all chats" : `View the ${kept} chats about ${t.title}`}>
            {active ? "Show all chats" : `View ${plural(kept, "chat", "chats")}`}
          </Button>
        </div>
      )}
    </div>
  );
}

// concerns: the loader's concernSummary (+ hasKey, sinceLabel, updatedLabel).
export default function ShopperConcerns({ concerns, activeId, onView, onRefresh, refreshing }) {
  const [showMore, setShowMore] = useState(false);
  const { read, top, more, pending, run, hasKey } = concerns;
  const running = Boolean(run?.running);
  const head = read > 0
    ? `All time: ${plural(read, "shopper chat", "shopper chats")} read since ${concerns.sinceLabel}. Everyday browsing ("show me shoes") and testers' chats aren't counted.`
    : "The issues, needs and questions shoppers raise most in recorded chats. Everyday browsing and testers' chats aren't counted.";

  let body;
  if (!hasKey) {
    body = <div className="sc-note"><b>Add your Claude API key</b>Once it's in Settings → API keys, the issues and questions shoppers raise most show here.</div>;
  } else if (top.length > 0) {
    body = (
      <div className="sc-grid">
        {top.map((t, i) => <Tile key={t.id} t={t} rank={i + 1} active={activeId === t.id} onView={onView} />)}
      </div>
    );
  } else if (running) {
    body = <div className="sc-note"><b>Reading shopper chats…</b>The first read takes a minute or two. You can leave this page; it carries on.</div>;
  } else if (read > 0) {
    body = <div className="sc-note"><b>No issue or question has come up twice yet</b>{`One shows once two or more chats raise it (${plural(read, "chat", "chats")} read so far; everyday browsing isn't counted).`}</div>;
  } else {
    body = <div className="sc-note"><b>No shopper chats yet</b>With recording on for every shopper (Settings → Testing), the three issues and questions shoppers raise most show here.</div>;
  }

  const showFoot = hasKey && (read > 0 || pending > 0 || running || run?.error);
  return (
    <div>
      <SectionHead title="Top shopper issues & questions">{head}</SectionHead>
      <Card padding="0">
        {body}
        {hasKey && more.length > 0 && (
          <div className="sc-more">
            {showMore && more.map((t) => (
              <div className="sc-more__row" key={t.id}>
                <span className="sc-more__title" title={t.summary || t.title}>{t.title}</span>
                <Kind kind={t.kind} />
                <span className="sc-more__n">{plural(t.count, "chat", "chats")}</span>
              </div>
            ))}
            <div className="sc-more__row" style={{ gridTemplateColumns: "1fr" }}>
              <span>
                <Button variant="plain" disclosure={showMore ? "up" : "down"} onClick={() => setShowMore((v) => !v)}>
                  {showMore ? "Hide the other themes" : `Show ${plural(more.length, "more theme", "more themes")}`}
                </Button>
              </span>
            </div>
          </div>
        )}
        {showFoot && (
          <div className="sc-foot">
            <span className="sc-foot__state">
              {running ? (
                <>
                  <Spinner size="small" accessibilityLabel="Reading chats" />
                  <span>{run.total > 0 ? `Reading chats… ${Math.min(run.done, run.total).toLocaleString()} of ${run.total.toLocaleString()}` : "Reading chats…"}</span>
                </>
              ) : run?.error ? (
                <span className="sc-err">{run.error}</span>
              ) : (
                <span>
                  {[concerns.updatedLabel ? `Updated ${concerns.updatedLabel}` : "", pending > 0 ? `${plural(pending, "new chat", "new chats")} to read` : ""].filter(Boolean).join(" · ") || "Up to date"}
                </span>
              )}
            </span>
            <Button size="slim" onClick={onRefresh} loading={refreshing} disabled={running || pending === 0}>Refresh</Button>
          </div>
        )}
      </Card>
    </div>
  );
}

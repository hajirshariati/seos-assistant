import { useState } from "react";
import {
  DEFAULTS,
  SOURCE_COPY,
  monthlyEstimate,
  resolvePerReply,
} from "../lib/cost-estimator-math";

// ---------------------------------------------------------------------------
// CostEstimator — what the assistant will cost at this store's real traffic.
// Sessions come from the store's Shopify Analytics (last 12 full months); the
// cost per reply is measured from recorded replies, or estimated from the
// store's actual catalog and instructions until there are enough. Math lives
// in lib/cost-estimator-math.js (unit-tested).
// ---------------------------------------------------------------------------

function calcMoney(n) {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

const rateFmt = (r) => `$${r.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const monthName = (ym) => {
  const [y, m] = String(ym).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
};

export default function CostEstimator({ traffic = null, modeled = null, measured = null }) {
  const hasTraffic = traffic && !traffic.error && traffic.average > 0;
  const { perReply, source } = resolvePerReply({ measured, modeled });
  const coldStartExtra = modeled?.coldStartExtra || 0;

  const [sessionsRaw, setSessionsRaw] = useState(
    (hasTraffic ? traffic.average : 25000).toLocaleString("en-US"),
  );
  const [engagement, setEngagement] = useState(DEFAULTS.engagementPct);
  const [repliesPerChat, setRepliesPerChat] = useState(DEFAULTS.repliesPerChat);

  const onSessions = (e) => {
    const digits = e.target.value.replace(/[^\d]/g, "").slice(0, 9);
    setSessionsRaw(digits ? Number(digits).toLocaleString("en-US") : "");
  };
  const setSessions = (n) => setSessionsRaw(Math.round(n).toLocaleString("en-US"));
  const sessions = parseInt(sessionsRaw.replace(/[^\d]/g, ""), 10) || 0;

  const est = monthlyEstimate({ sessions, engagementPct: engagement, repliesPerChat, perReply, coldStartExtra });
  // The next 12 months if traffic repeats the last 12.
  const yearCost = hasTraffic
    ? traffic.months.reduce((sum, m) => sum + monthlyEstimate({ sessions: m.sessions, engagementPct: engagement, repliesPerChat, perReply, coldStartExtra }).cost, 0)
    : est.cost * 12;
  const scenarios = [1, 2, 3, 5].map((pct) => ({
    pct,
    avg: monthlyEstimate({ sessions, engagementPct: pct, repliesPerChat, perReply, coldStartExtra }).cost,
    peak: hasTraffic ? monthlyEstimate({ sessions: traffic.peak.sessions, engagementPct: pct, repliesPerChat, perReply, coldStartExtra }).cost : null,
  }));

  const ENG_MIN = 0.5;
  const ENG_MAX = 10;
  const fill = `${(((engagement - ENG_MIN) / (ENG_MAX - ENG_MIN)) * 100).toFixed(1)}%`;

  return (
    <section className="seos-calc" aria-label="AI cost estimator">
      <style>{`
        /* Cost estimator — full-width interactive card. Left: three
           controls (sessions, engagement slider, depth). Right: a quiet
           green result panel with the live figure. */
        .seos-calc {
          display: flex;
          flex-direction: column;
          border-radius: 16px;
          background: #fff;
          border: 1px solid rgba(0,0,0,0.07);
          box-shadow: 0 1px 2px rgba(0,0,0,0.04);
          overflow: hidden;
        }
        .seos-calc-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.25fr) minmax(280px, 1fr);
        }
        .seos-calc-controls {
          padding: 24px 28px 26px;
          display: flex;
          flex-direction: column;
          gap: 22px;
          min-width: 0;
        }
        .seos-calc-title { font-size: 15px; font-weight: 650; color: #1a2e26; letter-spacing: -0.1px; }
        .seos-calc-desc { font-size: 12.5px; line-height: 1.5; color: rgba(26,46,38,0.62); margin-top: 4px; }
        .seos-calc-field { display: flex; flex-direction: column; gap: 8px; }
        .seos-calc-labelrow {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .seos-calc-label { font-size: 12.5px; font-weight: 650; color: #1a2e26; }
        .seos-calc-hint { font-size: 11.5px; color: rgba(26,46,38,0.45); }
        .seos-calc-input {
          appearance: none;
          width: 100%;
          box-sizing: border-box;
          font: inherit;
          font-size: 17px;
          font-weight: 650;
          letter-spacing: -0.2px;
          font-variant-numeric: tabular-nums;
          color: #1a2e26;
          background: rgba(26,46,38,0.035);
          border: 1px solid rgba(0,0,0,0.08);
          border-radius: 12px;
          padding: 11px 14px;
          transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
        }
        .seos-calc-input:hover { border-color: rgba(45,107,79,0.3); }
        .seos-calc-input:focus {
          outline: none;
          background: #fff;
          border-color: #2D6B4F;
          box-shadow: 0 0 0 3px rgba(45,107,79,0.15);
        }
        .seos-calc-readout {
          font-size: 13px;
          font-weight: 650;
          color: #2D6B4F;
          font-variant-numeric: tabular-nums;
          background: rgba(45,107,79,0.08);
          border: 1px solid rgba(45,107,79,0.18);
          border-radius: 999px;
          padding: 2px 10px;
        }
        .seos-calc-seg {
          display: inline-flex;
          gap: 2px;
          padding: 2px;
          background: rgba(26,46,38,0.05);
          border-radius: 9px;
        }
        .seos-calc-seg button {
          appearance: none;
          font: inherit;
          border: none;
          cursor: pointer;
          font-size: 11.5px;
          font-weight: 600;
          color: rgba(26,46,38,0.6);
          background: transparent;
          border-radius: 7px;
          padding: 4px 10px;
          transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
        }
        .seos-calc-seg button:focus-visible {
          outline: 2px solid rgba(45,107,79,0.5);
          outline-offset: 1px;
        }
        .seos-calc-seg button.is-on {
          background: #fff;
          color: #1a2e26;
          box-shadow: 0 1px 3px rgba(26,46,38,0.14);
        }
        .seos-calc-seg--wide { display: flex; width: 100%; box-sizing: border-box; }
        .seos-calc-seg--wide button {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1px;
          padding: 8px 10px;
        }
        .seos-calc-seg--wide button small { font-size: 10.5px; font-weight: 500; color: rgba(26,46,38,0.45); }
        .seos-calc-seg--wide button.is-on small { color: rgba(26,46,38,0.55); }
        .seos-calc-slider {
          appearance: none;
          -webkit-appearance: none;
          width: 100%;
          height: 6px;
          border-radius: 999px;
          background: linear-gradient(90deg, #2D6B4F 0%, #3a8a66 var(--fill, 0%), rgba(26,46,38,0.10) var(--fill, 0%));
          outline: none;
          cursor: pointer;
          margin: 8px 0 2px;
        }
        .seos-calc-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: #fff;
          border: 1px solid rgba(0,0,0,0.06);
          box-shadow: 0 2px 8px rgba(26,46,38,0.28), 0 1px 2px rgba(26,46,38,0.18);
          transition: transform 0.15s ease;
        }
        .seos-calc-slider::-webkit-slider-thumb:hover { transform: scale(1.08); }
        .seos-calc-slider::-moz-range-thumb {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: #fff;
          border: 1px solid rgba(0,0,0,0.06);
          box-shadow: 0 2px 8px rgba(26,46,38,0.28);
        }
        .seos-calc-slider:focus-visible { box-shadow: 0 0 0 3px rgba(45,107,79,0.2); }
        .seos-calc-result {
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 4px;
          padding: 26px 28px;
          background: linear-gradient(160deg, rgba(45,107,79,0.055), rgba(58,138,102,0.035));
          border-left: 1px solid rgba(45,107,79,0.12);
          min-width: 0;
        }
        .seos-calc-result-label {
          font-size: 10.5px;
          font-weight: 650;
          letter-spacing: 1.1px;
          text-transform: uppercase;
          color: rgba(45,107,79,0.75);
        }
        .seos-calc-bignum {
          font-size: 44px;
          font-weight: 700;
          letter-spacing: -1.5px;
          color: #1a2e26;
          font-variant-numeric: tabular-nums;
          line-height: 1.1;
        }
        .seos-calc-per {
          font-size: 16px;
          font-weight: 600;
          letter-spacing: 0;
          color: rgba(26,46,38,0.5);
          margin-left: 4px;
        }
        .seos-calc-yearly { font-size: 13px; color: rgba(26,46,38,0.55); font-variant-numeric: tabular-nums; }
        .seos-calc-breakdown {
          display: flex;
          margin-top: 16px;
          border-top: 1px solid rgba(45,107,79,0.12);
          padding-top: 14px;
          gap: 12px;
        }
        .seos-calc-breakdown > div { flex: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        .seos-calc-breakdown span { font-size: 15px; font-weight: 650; color: #1a2e26; font-variant-numeric: tabular-nums; }
        .seos-calc-breakdown small { font-size: 10.5px; color: rgba(26,46,38,0.5); }
        .seos-calc-anchor { margin-top: 14px; font-size: 11.5px; line-height: 1.5; color: rgba(26,46,38,0.5); }
        @media (max-width: 860px) {
          .seos-calc-grid { grid-template-columns: 1fr; }
          .seos-calc-result {
            border-left: none;
            border-top: 1px solid rgba(45,107,79,0.12);
          }
        }
      
        .seos-calc-months { display: flex; gap: 6px; flex-wrap: wrap; }
        .seos-calc-table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 12px; font-variant-numeric: tabular-nums; }
        .seos-calc-table th, .seos-calc-table td { text-align: right; padding: 5px 6px; border-bottom: 1px solid rgba(45,107,79,0.10); }
        .seos-calc-table th:first-child, .seos-calc-table td:first-child { text-align: left; }
        .seos-calc-table th { font-size: 10.5px; font-weight: 650; color: rgba(26,46,38,0.55); }
        .seos-calc-table tr.is-on td { font-weight: 700; color: #1a2e26; }
      `}</style>
      <div className="seos-calc-grid">
        <div className="seos-calc-controls">
          <div>
            <div className="seos-calc-title">Cost estimator</div>
            <div className="seos-calc-desc">
              What the assistant will cost at your store&rsquo;s real traffic. Every figure below can be changed.
            </div>
          </div>

          <div className="seos-calc-field">
            <div className="seos-calc-labelrow">
              <label className="seos-calc-label" htmlFor="seos-calc-sessions">Store sessions per month</label>
            </div>
            <input
              id="seos-calc-sessions"
              className="seos-calc-input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={sessionsRaw}
              onChange={onSessions}
            />
            {hasTraffic ? (
              <>
                <div className="seos-calc-months">
                  <div className="seos-calc-seg" role="group" aria-label="Traffic level">
                    <button type="button" className={sessions === traffic.average ? "is-on" : ""} onClick={() => setSessions(traffic.average)}>
                      Average {fmtInt(traffic.average)}
                    </button>
                    <button type="button" className={sessions === traffic.peak.sessions ? "is-on" : ""} onClick={() => setSessions(traffic.peak.sessions)}>
                      Busiest {monthName(traffic.peak.month)}
                    </button>
                    <button type="button" className={sessions === traffic.low.sessions ? "is-on" : ""} onClick={() => setSessions(traffic.low.sessions)}>
                      Quietest {monthName(traffic.low.month)}
                    </button>
                  </div>
                </div>
                <div className="seos-calc-hint">
                  From your Shopify Analytics, last {traffic.months.length} full months ({monthName(traffic.months[0].month)} – {monthName(traffic.months[traffic.months.length - 1].month)}).
                </div>
              </>
            ) : (
              <div className="seos-calc-hint">
                {traffic?.error === "permission"
                  ? "Approve the app's new Analytics permission to fill this in from your real traffic. Until then, type your sessions from Shopify admin → Analytics."
                  : "Type your sessions from Shopify admin → Analytics → Sessions."}
              </div>
            )}
          </div>

          <div className="seos-calc-field">
            <div className="seos-calc-labelrow">
              <label className="seos-calc-label" htmlFor="seos-calc-engagement">Sessions that start a chat</label>
              <span className="seos-calc-readout">{engagement}%</span>
            </div>
            <input
              id="seos-calc-engagement"
              className="seos-calc-slider"
              type="range"
              min={ENG_MIN}
              max={ENG_MAX}
              step="0.5"
              value={engagement}
              onChange={(e) => setEngagement(Number(e.target.value))}
              style={{ "--fill": fill }}
              aria-valuetext={`${engagement} percent of sessions`}
            />
            <div className="seos-calc-hint">AI shopping assistants usually see 1&ndash;3% of sessions start a chat. After launch, compare with your real count in Analytics.</div>
          </div>

          <div className="seos-calc-field">
            <div className="seos-calc-labelrow">
              <span className="seos-calc-label" id="seos-calc-depth-label">Replies per chat</span>
            </div>
            <div className="seos-calc-seg seos-calc-seg--wide" role="group" aria-labelledby="seos-calc-depth-label">
              {[2, 3, 5, 8].map((n) => (
                <button key={n} type="button" className={repliesPerChat === n ? "is-on" : ""} onClick={() => setRepliesPerChat(n)}>
                  {n}
                  <small>{n === 2 ? "quick" : n === 3 ? "typical" : n === 5 ? "detailed" : "long"}</small>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="seos-calc-result">
          <div className="seos-calc-result-label">Estimated AI cost</div>
          <div className="seos-calc-bignum">
            {calcMoney(est.cost)}
            <span className="seos-calc-per">/month</span>
          </div>
          <div className="seos-calc-yearly">
            &asymp; {calcMoney(yearCost)} per year{hasTraffic ? " at your last 12 months of traffic" : ""}
          </div>
          <div className="seos-calc-breakdown">
            <div><span>{fmtInt(est.chats)}</span><small>chats / mo</small></div>
            <div><span>{fmtInt(est.replies)}</span><small>replies / mo</small></div>
            <div><span>{perReply > 0 ? rateFmt(est.rate) : "—"}</span><small>per reply</small></div>
          </div>
          <table className="seos-calc-table">
            <thead>
              <tr><th>Sessions that chat</th><th>At sessions above</th>{hasTraffic && <th>Busiest month</th>}</tr>
            </thead>
            <tbody>
              {scenarios.map((s) => (
                <tr key={s.pct} className={s.pct === engagement ? "is-on" : ""}>
                  <td>{s.pct}%</td>
                  <td>{calcMoney(s.avg)}</td>
                  {hasTraffic && <td>{calcMoney(s.peak)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="seos-calc-anchor">
            {source === "measured" ? SOURCE_COPY.measured(measured.replies) : SOURCE_COPY[source]}
          </div>
          {modeled && (
            <div className="seos-calc-anchor" style={{ marginTop: 4 }}>
              Measured on your setup: {modeled.products.toLocaleString("en-US")} products; instructions of about {fmtInt(modeled.prefixTokens)} tokens (the unit AI is billed in —
              cached, so each reply pays about a tenth for them); about {fmtInt(modeled.searchTokens)} tokens per product search.
              {source === "measured" && ` Estimate from your setup: ${rateFmt(modeled.perReply)} per reply.`}
            </div>
          )}
          <div className="seos-calc-anchor" style={{ marginTop: 4 }}>
            AI engine (Anthropic) cost only, at today&rsquo;s list prices. Semantic search adds a fraction of a cent per thousand replies; &ldquo;Visualize my look&rdquo; images are billed separately.
          </div>
        </div>
      </div>
    </section>
  );
}

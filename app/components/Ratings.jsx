// Ratings — every thumbs up and thumbs down shoppers left, and the lessons
// drafted from the thumbs-down — on the Recordings page, so the customer
// service team has one page: the chats, the votes and what to do about
// them. Analytics keeps the numbers. The cards take rows from
// getRecentQuestions and the lessons from listLessons.
import { useState, useMemo, useCallback } from "react";
import { useFetcher } from "react-router";
import { Card, InlineStack, Badge, Button } from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Row } from "./SettingsUI";
import { FEEDBACK_REASONS, FEEDBACK_MOMENTS, FEEDBACK_SUBJECTS } from "../lib/chat-rating.js";
import { reviewRunLine } from "../lib/chat-review.js";

export const RATINGS_CSS = `
  .an-col__title { margin-bottom: 8px; font-size: 12px; line-height: 16px; font-weight: 650; color: #303030; }
  .an-rank { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; }
  .an-rank__top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .an-rank__title { min-width: 0; font-size: 13px; line-height: 18px; color: #1a1a1a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .an-rank__n { flex: none; font-size: 12.5px; font-weight: 650; color: #1a2e26; font-variant-numeric: tabular-nums; }
  .an-rank__bar { height: 4px; margin-top: 4px; border-radius: 999px; background: rgba(26,46,38,0.06); overflow: hidden; }
  .an-rank__bar span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #2D6B4F, #3a8a66); }
  .an-rank--down .an-rank__n { color: #a33d3d; }
  .an-rank--down .an-rank__bar span { background: linear-gradient(90deg, #a33d3d, #c46a6a); }
  .an-callout { margin: 10px 16px 0; padding: 10px 12px; border-radius: 10px; background: rgba(185,137,0,0.09); font-size: 12.5px; line-height: 18px; color: #4a3b00; }
  .an-callout strong { color: #1a1a1a; }
  .an-empty { padding: 18px 16px 20px; font-size: 13px; color: #616161; }
  .an-convo__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 12px; color: #8a8a8a; min-height: 18px; }
  .an-pill { padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 16px; font-weight: 650; color: #616161; background: rgba(26,46,38,0.06); white-space: nowrap; }
  .an-pill.is-up { color: #2D6B4F; background: rgba(45,107,79,0.10); }
  .an-pill.is-down { color: #a33d3d; background: rgba(185,90,90,0.13); }
  .an-lesson { padding: 12px 16px 14px; border-top: 1px solid rgba(30,27,51,0.07); }
  .an-lesson__line { margin-top: 4px; font-size: 14px; line-height: 20px; font-weight: 600; color: #1a1a1a; overflow-wrap: anywhere; }
  .an-lesson__fix { margin-top: 6px; padding: 8px 10px; border-radius: 8px; background: rgba(45,107,79,0.06); font-size: 13px; line-height: 18px; color: #1a2e26; white-space: pre-wrap; overflow-wrap: anywhere; }
  .an-lesson__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .an-review__line { padding: 10px 16px 2px; font-size: 12.5px; line-height: 18px; color: #616161; }
  .an-finding .an-lesson__line { font-size: 13px; }
  .an-finding__open { margin-left: auto; padding: 0; border: 0; background: none; font: inherit; font-size: 12px; font-weight: 600; color: #2D6B4F; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
  .an-finding__open:focus-visible { outline: 2px solid #2D6B4F; outline-offset: 2px; border-radius: 4px; }
  .an-lesson__past { display: grid; gap: 5px; padding: 10px 16px 12px; border-top: 1px solid rgba(30,27,51,0.07); font-size: 12.5px; line-height: 18px; color: #616161; }
  .an-lesson__done { display: flex; align-items: flex-start; gap: 8px; }
  .an-lesson__done span:last-child { overflow-wrap: anywhere; }
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
  .an-why { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 24px; padding: 12px 16px 16px; border-top: 1px solid rgba(30,27,51,0.07); }
  .an-vote { padding: 12px 16px 13px; border-top: 1px solid rgba(30,27,51,0.07); }
  .an-vote__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 0; margin-bottom: 7px; font-size: 12px; line-height: 18px; color: #8a8a8a; }
  .an-vote__meta > span + span:not(.an-vote__reason)::before { content: "·"; margin: 0 7px; color: #c4c4c4; }
  .an-vote__reason { margin-left: auto; }
  .an-vote__grid { display: grid; grid-template-columns: 62px minmax(0, 1fr); gap: 4px 10px; margin: 0; }
  .an-vote__grid dt { margin: 0; padding-top: 1px; font-size: 10.5px; line-height: 17px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #9a9a9a; }
  .an-vote__grid dd { margin: 0; min-width: 0; font-size: 13px; line-height: 18px; color: #4a4a4a; overflow-wrap: anywhere; }
  .an-vote__grid dd.is-q { font-size: 13.5px; line-height: 19px; font-weight: 600; color: #1a1a1a; }
  .an-vote__grid dd.is-c { justify-self: start; padding: 4px 9px; border-radius: 8px; background: rgba(185,137,0,0.10); color: #3d3000; white-space: pre-wrap; }
  .an-vote .an-convo__toggle, .an-vote .an-chat { margin-left: 72px; }
  @media (max-width: 760px) {
    .an-why { grid-template-columns: minmax(0, 1fr); }
    .an-vote__grid { grid-template-columns: 54px minmax(0, 1fr); }
    .an-vote .an-convo__toggle, .an-vote .an-chat { margin-left: 0; }
  }
`;

// A ranked list with bars: the biggest first, each bar against the biggest.
export function RankList({ rows, tone }) {
  if (!rows || rows.length === 0) return <div className="an-empty" style={{ padding: "4px 0 0" }}>Nothing yet.</div>;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <ol className={`an-rank${tone === "down" ? " an-rank--down" : ""}`}>
      {rows.map((r, i) => (
        <li key={`${r.title}-${i}`}>
          <div className="an-rank__top"><span className="an-rank__title" title={r.title}>{r.title}</span><span className="an-rank__n">{r.count}</span></div>
          <div className="an-rank__bar"><span style={{ width: `${Math.max(4, Math.round((r.count / max) * 100))}%` }} /></div>
        </li>
      ))}
    </ol>
  );
}

// CSV download from inside the embedded iframe: the App Bridge session token
// goes in the header (a new tab would have none and bounce to the login).
export function useCsvExport(baseParams = {}) {
  const shopify = useAppBridge();
  const [exporting, setExporting] = useState(null);
  const handleExport = useCallback(async (section, extraParams = {}) => {
    if (exporting) return;
    setExporting(section);
    try {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...baseParams, ...extraParams })) if (v) params.set(k, v);
      params.set("section", section);
      const token = await shopify.idToken();
      const res = await fetch(`/app/exports?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const filename = res.headers.get("Content-Disposition")?.match(/filename="?([^";]+)"?/)?.[1] || `${section}.csv`;
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err) {
      console.error("[export] failed:", err);
      shopify.toast.show("Export failed. Please try again.", { isError: true });
    } finally {
      setExporting(null);
    }
  }, [shopify, exporting, baseParams]);
  return [exporting, handleExport];
}

function avaSaid(row) {
  if (row.flaggedAiResponse) return row.flaggedAiResponse;
  if (row.aiResponse) return row.aiResponse;
  const t = Array.isArray(row.transcript) ? row.transcript : [];
  for (let i = t.length - 1; i >= 0; i--) if (t[i].role === "assistant" && t[i].content) return t[i].content;
  return null;
}

// One vote, readable at a glance: when it was and what it was about on one
// line (a thumbs-down carries the reason the shopper picked, at the right,
// so the reasons line up down the list), then what the shopper asked, what
// AVA said, and the shopper's own words when they left any. The whole chat
// opens under it.
export function VoteRow({ row, mounted, tone }) {
  const [open, setOpen] = useState(false);
  const chat = row.kind === "chat";
  const transcript = Array.isArray(row.transcript) ? row.transcript : [];
  const products = row.products || [];
  const asked = row.lastUserQuestion || row.question;
  const said = avaSaid(row);
  const when = chat
    ? (row.moment && FEEDBACK_MOMENTS[row.moment] ? `Whole chat · ${FEEDBACK_MOMENTS[row.moment].toLowerCase()}` : "Whole chat")
    : (row.moment === "order" ? "An order answer" : "One reply");
  const reason = row.reason && FEEDBACK_REASONS[row.reason] ? FEEDBACK_REASONS[row.reason] : null;
  return (
    <div className="an-vote">
      <div className="an-vote__meta">
        {mounted && <span>{new Date(row.date).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>}
        {row.subject && FEEDBACK_SUBJECTS[row.subject] && <span>{FEEDBACK_SUBJECTS[row.subject]}</span>}
        <span>{when}</span>
        {products.length > 0 && <span>{`${products.length} product${products.length > 1 ? "s" : ""} shown`}</span>}
        {tone === "down" && (reason
          ? <span className="an-pill is-down an-vote__reason">{reason}</span>
          : <span className="an-pill an-vote__reason">No reason picked</span>)}
      </div>
      {(asked || said || row.comment) && (
        <dl className="an-vote__grid">
          {asked && <><dt>Shopper</dt><dd className="is-q">{asked}</dd></>}
          {said && <><dt>AVA</dt><dd className={open ? "" : "an-clamp"}>{said}</dd></>}
          {row.comment && <><dt>Comment</dt><dd className="is-c">{row.comment}</dd></>}
        </dl>
      )}
      {transcript.length > 0 && (
        <button type="button" className="an-convo__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide the conversation" : `Read the conversation (${transcript.length} message${transcript.length > 1 ? "s" : ""})`}
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

// Lessons from thumbs-down, waiting for a decision: once a day (or on Draft
// now) the assistant reads the week's not-helpful chats and drafts, for
// every subject with two or more, one line to do differently and, for a
// missing fact, the fact. Approve writes it into Knowledge or Rules;
// Dismiss rests it a week. Nothing reaches the assistant until approved.
export function LessonsCard({ lessons, mounted }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const drafting = busy && fetcher.formData?.get("intent") === "lessons_draft";
  const drafts = lessons?.drafts || [];
  const decided = lessons?.decided || [];
  const result = fetcher.state === "idle" ? fetcher.data : null;
  return (
    <Card padding="0">
      <Row
        title={<InlineStack gap="200" blockAlign="center"><span>Lessons to review</span>{drafts.length > 0 && <Badge tone="attention">{String(drafts.length)}</Badge>}</InlineStack>}
        help="Once a day AVA reads the chats rated not helpful this week — and the answers the chat review flagged — and, for every subject with two or more, drafts one line to do differently and, when a fact was missing, the fact to add. Approve adds it to Knowledge (a fact) or Rules (how to handle it); Dismiss rests the subject for a week. Nothing changes until you approve."
        control={
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="lessons_draft" />
            <Button size="slim" submit loading={drafting} disabled={busy && !drafting}>Draft now</Button>
          </fetcher.Form>
        }
      />
      {result?.error && <div className="an-callout">{result.error}</div>}
      {result && !result.error && typeof result.drafted === "number" && (
        <div className="an-callout">{result.drafted > 0 ? `${result.drafted} new lesson${result.drafted === 1 ? "" : "s"} drafted.` : "Nothing new to draft: no subject has two or more thumbs down this week, or its lesson is already here."}</div>
      )}
      {drafts.length === 0 ? (
        <div className="an-empty">No lessons waiting. A draft appears once a subject gets two or more thumbs down, or two or more answers flagged by the review, in a week.</div>
      ) : drafts.map((l) => (
        <div key={l.id} className="an-lesson">
          <div className="an-convo__meta">
            <span className="an-pill is-down">{l.label}</span>
            <span className="an-pill">{l.source === "review" ? `${l.count} flagged by the review` : `${l.count} thumbs down`}</span>
            <span className="an-pill">{l.kind === "knowledge" && l.fix ? "A fact to add" : "How to handle it"}</span>
            {mounted && <span>{new Date(l.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>}
          </div>
          <div className="an-lesson__line">{l.lesson}</div>
          {l.kind === "knowledge" && l.fix && <div className="an-lesson__fix">{l.fix}</div>}
          {l.examples.length > 0 && <div className="an-convo__line"><b>Shoppers asked:</b> {l.examples.map((q) => `“${q}”`).join(" · ")}</div>}
          <div className="an-lesson__actions">
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="lesson_decide" />
              <input type="hidden" name="id" value={l.id} />
              <input type="hidden" name="decision" value="approved" />
              <Button size="slim" variant="primary" submit disabled={busy}>{l.kind === "knowledge" && l.fix ? "Approve — add to Knowledge" : "Approve — add to Rules"}</Button>
            </fetcher.Form>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="lesson_decide" />
              <input type="hidden" name="id" value={l.id} />
              <input type="hidden" name="decision" value="dismissed" />
              <Button size="slim" submit disabled={busy}>Dismiss</Button>
            </fetcher.Form>
          </div>
        </div>
      ))}
      {decided.length > 0 && (
        <div className="an-lesson__past">
          {decided.map((l) => (
            <div key={l.id} className="an-lesson__done">
              <span className={`an-pill${l.status === "approved" ? " is-up" : ""}`}>{l.status === "approved" ? "Approved" : "Dismissed"}</span>
              <span>{`${l.label}: ${l.lesson}`}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// The chat review: once a day AVA reads every recorded chat it hasn't read
// yet and flags the answers the chat itself shows went wrong, each with what
// would have been better. The newest findings, with a link to the chat; a
// subject flagged twice in a week becomes a lesson above.
export function ReviewCard({ review, mounted, onOpenChat }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const run = review?.run || {};
  const running = run.running || (busy && fetcher.formData?.get("intent") === "review_now");
  const state = review?.state;
  const findings = review?.findings || [];
  const result = fetcher.state === "idle" ? fetcher.data : null;
  const when = (d) => (mounted ? new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const line = reviewRunLine(state, { label: when });
  return (
    <Card padding="0">
      <Row
        title={<InlineStack gap="200" blockAlign="center"><span>What the chat review flagged</span>{findings.length > 0 && <Badge tone="attention">{String(findings.length)}</Badge>}</InlineStack>}
        help="Once a day AVA reads every recorded chat she hasn't read yet — not only the rated ones — and flags an answer only when the chat itself shows it went wrong: a fact the same chat contradicts, a question answered with something else, a hand-off to customer service before trying, a vague answer where a plain one was asked for. Each comes with what would have been better. A subject flagged twice in a week becomes a lesson above."
        control={
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="review_now" />
            <Button size="slim" submit loading={running} disabled={busy && !running}>Review now</Button>
          </fetcher.Form>
        }
      />
      {result?.error && <div className="an-callout">{result.error}</div>}
      {run.error && !running && <div className="an-callout">{run.error}</div>}
      <div className="an-review__line">{running ? `Reading${run.total ? ` ${run.done} of ${run.total} chats` : ""}…` : line}</div>
      {findings.length === 0 ? (
        <div className="an-empty">{state?.lastRunAt ? "Nothing flagged. Every answer read held up against its chat." : "Nothing read yet."}</div>
      ) : findings.map((f) => (
        <div key={f.id} className="an-lesson an-finding">
          <div className="an-convo__meta">
            <span className="an-pill is-down">{f.problemLabel}</span>
            <span className="an-pill">{f.label}</span>
            {f.tester && <span className="an-pill">{`Test chat · ${f.tester}`}</span>}
            {mounted && <span>{when(f.at)}</span>}
            {onOpenChat && <button type="button" className="an-finding__open" onClick={() => onOpenChat(f.sessionId)}>Open the chat</button>}
          </div>
          <div className="an-convo__line"><b>Shopper asked:</b> {f.message}</div>
          <div className="an-convo__line"><b>AVA said:</b> {f.reply}</div>
          <div className="an-lesson__line">{f.note}</div>
          {f.better && <div className="an-lesson__fix">{f.better}</div>}
        </div>
      ))}
    </Card>
  );
}

const VOTES_FIRST = 8;

// Every thumbs down in one place, newest first — what went wrong, readable
// without a click: on top, why the shoppers said so and what they were
// asking about (counted); then each vote with the question, AVA's reply and
// the reason. Export downloads these rows.
export function NotHelpfulCard({ rows, onExport, exporting, mounted, rangeWords = "this range" }) {
  const [showAll, setShowAll] = useState(false);
  const why = useMemo(() => {
    const reasons = {}, subjects = {};
    let noReason = 0;
    for (const r of rows) {
      if (r.reason && FEEDBACK_REASONS[r.reason]) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
      else noReason++;
      const key = r.subject && FEEDBACK_SUBJECTS[r.subject] ? r.subject : "other";
      subjects[key] = (subjects[key] || 0) + 1;
    }
    const list = (o, labels) => Object.entries(o).sort((x, y) => y[1] - x[1]).map(([key, n]) => ({ title: labels[key], count: n }));
    const reasonRows = list(reasons, FEEDBACK_REASONS);
    if (noReason > 0) reasonRows.push({ title: "No reason picked", count: noReason });
    return { reasons: reasonRows, subjects: list(subjects, FEEDBACK_SUBJECTS) };
  }, [rows]);
  const shown = showAll ? rows : rows.slice(0, VOTES_FIRST);
  return (
    <Card padding="0">
      <Row
        title={<InlineStack gap="200" blockAlign="center"><span>Not helpful</span>{rows.length > 0 && <Badge tone="critical">{String(rows.length)}</Badge>}</InlineStack>}
        help={`Every thumbs down from ${rangeWords}, newest first — on one reply, or on the whole chat at its check-in. Each one shows what the shopper asked, what AVA said, and the reason they picked.`}
        control={
          <Button size="slim" onClick={() => onExport("conversations", { vote: "down" })} loading={exporting === "conversations"} disabled={(Boolean(exporting) && exporting !== "conversations") || rows.length === 0}>
            Export
          </Button>
        }
      />
      {rows.length === 0 ? (
        <div className="an-empty">{`Nothing rated not helpful in ${rangeWords}.`}</div>
      ) : (
        <>
          {rows.length > 1 && (
            <div className="an-why">
              <div>
                <div className="an-col__title">Why they said so</div>
                <RankList rows={why.reasons} tone="down" />
              </div>
              <div>
                <div className="an-col__title">What they were asking about</div>
                <RankList rows={why.subjects} tone="down" />
              </div>
            </div>
          )}
          {shown.map((r) => <VoteRow key={r.id} row={r} mounted={mounted} tone="down" />)}
          {rows.length > VOTES_FIRST && (
            <div className="an-more">
              <Button variant="plain" disclosure={showAll ? "up" : "down"} onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show ${rows.length - VOTES_FIRST} more`}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// The thumbs up, in their own card and folded by default: the number is
// what matters day to day; the rows are there to read when wanted.
export function HelpfulCard({ rows, onExport, exporting, mounted, rangeWords = "this range" }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, VOTES_FIRST);
  return (
    <Card padding="0">
      <Row
        title={<InlineStack gap="200" blockAlign="center"><span>Helpful</span><Badge tone="success">{String(rows.length)}</Badge></InlineStack>}
        help={`Every thumbs up from ${rangeWords}, newest first — on one reply, or on the whole chat at its check-in.`}
        control={
          <InlineStack gap="200">
            <Button size="slim" disclosure={open ? "up" : "down"} onClick={() => setOpen((v) => !v)} ariaExpanded={open} disabled={rows.length === 0}>{open ? "Hide" : "Show"}</Button>
            <Button size="slim" onClick={() => onExport("conversations", { vote: "up" })} loading={exporting === "conversations"} disabled={(Boolean(exporting) && exporting !== "conversations") || rows.length === 0}>
              Export
            </Button>
          </InlineStack>
        }
      />
      {open && shown.map((r) => <VoteRow key={r.id} row={r} mounted={mounted} tone="up" />)}
      {open && rows.length > VOTES_FIRST && (
        <div className="an-more">
          <Button variant="plain" disclosure={showAll ? "up" : "down"} onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show fewer" : `Show ${rows.length - VOTES_FIRST} more`}
          </Button>
        </div>
      )}
    </Card>
  );
}

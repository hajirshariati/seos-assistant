// Learn — the card on Analytics: an inbox of decisions. Two tabs: Improve
// AVA (the lessons drafted from thumbs-down and from the daily chat review:
// approve one and it joins Rules or Knowledge, or dismiss it) and Improve
// the website (changes to the site drafted from what shoppers said: mark
// one done, or dismiss it). One line per item with its buttons; the facts
// behind it fold open on Details. Nothing changes until a button is pressed.
import { useState } from "react";
import { Card, Button, Spinner } from "@shopify/polaris";
import { useFetcher } from "react-router";

export const LEARN_CSS = `
  .ln-tabs { display: flex; align-items: center; gap: 2px; padding: 6px 10px 0; border-bottom: 1px solid rgba(30,27,51,0.08); }
  .ln-tab { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; padding: 9px 10px 10px; margin-bottom: -1px; border-bottom: 2px solid transparent; cursor: pointer; white-space: nowrap; font-size: 13.5px; line-height: 18px; font-weight: 600; color: #616161; }
  .ln-tab:hover { color: #1a1a1a; }
  .ln-tab[aria-selected="true"] { color: #1a1a1a; border-bottom-color: #2D6B4F; }
  .ln-tab:focus-visible, .ln-more:focus-visible, .ln-open:focus-visible { outline: 2px solid #2D6B4F; outline-offset: 2px; }
  .ln-tab__n { padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 16px; font-weight: 650; color: #7a5412; background: #fbf3e4; font-variant-numeric: tabular-nums; }
  .ln-tab__n.is-zero { color: #616161; background: rgba(26,46,38,0.07); }
  .ln-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 10px 16px; font-size: 12.5px; line-height: 18px; color: #616161; border-bottom: 1px solid rgba(30,27,51,0.08); }
  .ln-bar__text { flex: 1 1 320px; min-width: 0; }
  .ln-bar__acts { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; }
  .ln-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 14px; align-items: start; padding: 11px 16px; border-bottom: 1px solid rgba(30,27,51,0.07); }
  .ln-item__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 11.5px; line-height: 16px; color: #8a8a8a; }
  .ln-pill { padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 16px; font-weight: 650; color: #616161; background: rgba(26,46,38,0.06); white-space: nowrap; }
  .ln-pill.is-do { color: #1f4d39; background: rgba(45,107,79,0.10); }
  .ln-pill.is-high { color: #a33d3d; background: rgba(185,90,90,0.13); }
  .ln-pill.is-medium { color: #7a5412; background: #fbf3e4; }
  .ln-pill.is-low { color: #245a86; background: #eef4fb; }
  .ln-item__title { font-size: 14px; line-height: 20px; font-weight: 600; color: #1a1a1a; overflow-wrap: anywhere; }
  .ln-item__acts { display: inline-flex; align-items: center; gap: 6px; padding-top: 14px; white-space: nowrap; }
  .ln-more { all: unset; box-sizing: border-box; cursor: pointer; font-size: 12.5px; line-height: 18px; font-weight: 600; color: #2D6B4F; }
  .ln-more:hover { text-decoration: underline; text-underline-offset: 2px; }
  .ln-details { grid-column: 1 / -1; display: grid; gap: 8px; padding: 6px 0 2px; font-size: 13px; line-height: 19px; color: #303030; }
  .ln-details b { font-weight: 650; color: #616161; }
  .ln-fix { padding: 8px 10px; border-radius: 8px; background: rgba(45,107,79,0.06); color: #1a2e26; white-space: pre-wrap; overflow-wrap: anywhere; }
  .ln-quotes { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .ln-quotes li { padding: 5px 10px; border-radius: 8px; background: #f5f5f7; font-size: 12.5px; line-height: 18px; color: #4a4a4a; font-style: italic; overflow-wrap: anywhere; }
  .ln-empty { padding: 22px 16px 24px; text-align: center; font-size: 13px; line-height: 19px; color: #616161; }
  .ln-empty b { display: block; margin-bottom: 2px; font-size: 14px; color: #1a1a1a; }
  .ln-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; padding: 9px 16px; font-size: 12.5px; line-height: 18px; color: #616161; }
  .ln-past { display: grid; gap: 5px; padding: 8px 16px 12px; font-size: 12.5px; line-height: 18px; color: #616161; border-top: 1px solid rgba(30,27,51,0.07); }
  .ln-past__row { display: flex; align-items: flex-start; gap: 8px; }
  .ln-past__row span:last-child { overflow-wrap: anywhere; }
  .ln-flag { display: grid; gap: 2px; padding: 9px 16px; border-top: 1px solid rgba(30,27,51,0.07); font-size: 12.5px; line-height: 18px; color: #303030; }
  .ln-flag__top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .ln-open { all: unset; box-sizing: border-box; cursor: pointer; margin-left: auto; font-size: 12px; font-weight: 600; color: #2D6B4F; text-decoration: underline; text-underline-offset: 2px; }
  .ln-callout { margin: 10px 16px 0; padding: 8px 12px; border-radius: 10px; background: rgba(185,137,0,0.09); font-size: 12.5px; line-height: 18px; color: #4a3b00; }
  @media (max-width: 600px) {
    .ln-item { grid-template-columns: minmax(0, 1fr); }
    .ln-item__acts { padding-top: 2px; }
  }
`;

const when = (d, mounted) => (mounted && d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");

function Decide({ fetcher, intent, id, yes, yesValue, busy }) {
  return (
    <>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value={intent} />
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="decision" value={yesValue} />
        <Button size="slim" variant="primary" submit disabled={busy}>{yes}</Button>
      </fetcher.Form>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value={intent} />
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="decision" value="dismissed" />
        <Button size="slim" submit disabled={busy}>Dismiss</Button>
      </fetcher.Form>
    </>
  );
}

function LessonItem({ l, fetcher, busy, mounted }) {
  const [open, setOpen] = useState(false);
  const fact = l.kind === "knowledge" && l.fix;
  return (
    <div className="ln-item">
      <div>
        <div className="ln-item__meta">
          <span className="ln-pill is-do">{fact ? "Add a fact" : "Add a rule"}</span>
          <span className="ln-pill">{l.label}</span>
          <span>{l.source === "review" ? `${l.count} answers flagged by the review` : `${l.count} thumbs down`}</span>
          {mounted && <span>{when(l.createdAt, mounted)}</span>}
        </div>
        <div className="ln-item__title">{l.lesson}</div>
        {(fact || l.examples.length > 0) && (
          <button type="button" className="ln-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Hide details" : "Details"}</button>
        )}
      </div>
      <div className="ln-item__acts">
        <Decide fetcher={fetcher} intent="lesson_decide" id={l.id} yes={fact ? "Approve → Knowledge" : "Approve → Rules"} yesValue="approved" busy={busy} />
      </div>
      {open && (
        <div className="ln-details">
          {fact && <div><b>The fact AVA will learn:</b><div className="ln-fix" style={{ marginTop: 4 }}>{l.fix}</div></div>}
          {l.examples.length > 0 && <div><b>Shoppers asked:</b> {l.examples.map((q) => `“${q}”`).join(" · ")}</div>}
        </div>
      )}
    </div>
  );
}

function IdeaItem({ i, n, fetcher, busy, mounted }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ln-item">
      <div>
        <div className="ln-item__meta">
          <span className={`ln-pill is-${i.impact}`}>{`#${n} · ${i.impactLabel}`}</span>
          <span className="ln-pill">{i.effortLabel}</span>
          <span className="ln-pill">{i.areaLabel}</span>
          {i.shoppers > 0 && <span>{`${i.shoppers.toLocaleString()} shopper${i.shoppers === 1 ? "" : "s"}`}</span>}
          {mounted && <span>{when(i.createdAt, mounted)}</span>}
        </div>
        <div className="ln-item__title">{i.title}</div>
        <button type="button" className="ln-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Hide details" : "Details"}</button>
      </div>
      <div className="ln-item__acts">
        <Decide fetcher={fetcher} intent="idea_decide" id={i.id} yes="Mark done" yesValue="done" busy={busy} />
      </div>
      {open && (
        <div className="ln-details">
          <div><b>What to change:</b> {i.change}</div>
          {i.why && <div><b>Why:</b> {i.why}</div>}
          {i.evidence.length > 0 && <ul className="ln-quotes">{i.evidence.map((q, k) => <li key={k}>{`“${q}”`}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}

export function LearnCard({ lessons, review, ideas, mounted, onOpenChat }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const intent = busy ? fetcher.formData?.get("intent") : "";
  const result = fetcher.state === "idle" ? fetcher.data : null;
  const drafts = lessons?.drafts || [];
  const open = ideas?.open || [];
  const findings = review?.findings || [];
  const run = review?.run || {};
  const reviewing = Boolean(run.running) || intent === "review_now";
  const [tab, setTab] = useState(drafts.length === 0 && open.length > 0 ? "site" : "ava");
  const [showFlags, setShowFlags] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const decided = tab === "ava" ? (lessons?.decided || []).map((l) => ({ id: l.id, word: l.status === "approved" ? "Approved" : "Dismissed", good: l.status === "approved", text: `${l.label}: ${l.lesson}` })) : (ideas?.decided || []).map((i) => ({ id: i.id, word: i.status === "done" ? "Done" : "Dismissed", good: i.status === "done", text: i.title }));
  const note = result?.error
    ? result.error
    : result && typeof result.drafted === "number"
      ? (result.drafted > 0 ? `${result.drafted} new ${result.drafted === 1 ? "item" : "items"} drafted.` : result.thin ? "Not enough to work from yet — ideas appear once shoppers have raised an issue or two, rated answers, or the review has flagged something." : "Nothing new to draft right now.")
      : result?.started ? "The review is reading the chats; new lessons appear here when it's done." : "";
  return (
    <Card padding="0">
      <div className="ln-tabs" role="tablist" aria-label="What to improve">
        <button type="button" role="tab" className="ln-tab" aria-selected={tab === "ava"} onClick={() => setTab("ava")}>Improve AVA<span className={`ln-tab__n${drafts.length ? "" : " is-zero"}`}>{drafts.length}</span></button>
        <button type="button" role="tab" className="ln-tab" aria-selected={tab === "site"} onClick={() => setTab("site")}>Improve the website<span className={`ln-tab__n${open.length ? "" : " is-zero"}`}>{open.length}</span></button>
      </div>
      {note && <div className="ln-callout">{note}</div>}
      {tab === "ava" ? (
        <>
          <div className="ln-bar">
            <span className="ln-bar__text">Lessons drafted from thumbs-down and from the daily review of every chat. Approve one and AVA follows it from the next chat; dismiss what doesn't fit.</span>
            <span className="ln-bar__acts">
              <fetcher.Form method="post"><input type="hidden" name="intent" value="lessons_draft" /><Button size="slim" submit loading={intent === "lessons_draft"} disabled={busy && intent !== "lessons_draft"}>Draft now</Button></fetcher.Form>
            </span>
          </div>
          {drafts.length === 0
            ? <div className="ln-empty"><b>Nothing to decide</b>A lesson appears once a subject gets two thumbs down, or two answers flagged by the review, in a week.</div>
            : drafts.map((l) => <LessonItem key={l.id} l={l} fetcher={fetcher} busy={busy} mounted={mounted} />)}
          <div className="ln-foot">
            <span>
              {reviewing ? <><Spinner size="small" accessibilityLabel="Reading chats" /> {run.total ? `Reading ${run.done} of ${run.total} chats…` : "Reading the chats…"}</>
                : review?.state?.lastRunAt ? `The review last read ${review.state.chats} chat${review.state.chats === 1 ? "" : "s"}${mounted ? ` on ${when(review.state.lastRunAt, mounted)}` : ""} and flagged ${review.state.findings}.`
                  : "The review hasn't read the chats yet; it runs every night."}
              {findings.length > 0 && !reviewing && <> <button type="button" className="ln-more" aria-expanded={showFlags} onClick={() => setShowFlags((v) => !v)}>{showFlags ? "Hide the flagged answers" : `See the ${findings.length} flagged`}</button></>}
            </span>
            <fetcher.Form method="post"><input type="hidden" name="intent" value="review_now" /><Button size="slim" variant="plain" submit disabled={busy || reviewing}>Review now</Button></fetcher.Form>
          </div>
          {showFlags && findings.map((f) => (
            <div key={f.id} className="ln-flag">
              <div className="ln-flag__top">
                <span className="ln-pill is-high">{f.problemLabel}</span>
                <span className="ln-pill">{f.label}</span>
                {f.tester && <span className="ln-pill">{`Test chat · ${f.tester}`}</span>}
                {onOpenChat && <button type="button" className="ln-open" onClick={() => onOpenChat(f.sessionId)}>Open the chat</button>}
              </div>
              <div><b>Asked:</b> {f.message}</div>
              <div><b>AVA said:</b> {f.reply}</div>
              <div><b>Better:</b> {f.better || f.note}</div>
            </div>
          ))}
        </>
      ) : (
        <>
          <div className="ln-bar">
            <span className="ln-bar__text">Changes to the site drafted once a week from what shoppers told AVA, best first. Mark one done once it's on the site; dismiss what doesn't fit.</span>
            <span className="ln-bar__acts">
              <fetcher.Form method="post"><input type="hidden" name="intent" value="ideas_draft" /><Button size="slim" submit loading={intent === "ideas_draft"} disabled={busy && intent !== "ideas_draft"}>Draft now</Button></fetcher.Form>
            </span>
          </div>
          {open.length === 0
            ? <div className="ln-empty"><b>Nothing to decide</b>The first ideas come a week after chats start, or now with Draft now.</div>
            : open.map((i, n) => <IdeaItem key={i.id} i={i} n={n + 1} fetcher={fetcher} busy={busy} mounted={mounted} />)}
        </>
      )}
      {decided.length > 0 && (
        <div className="ln-past">
          <button type="button" className="ln-more" aria-expanded={showPast} onClick={() => setShowPast((v) => !v)}>{showPast ? "Hide recent decisions" : `Recent decisions (${decided.length})`}</button>
          {showPast && decided.map((d) => (
            <div key={d.id} className="ln-past__row"><span className={`ln-pill${d.good ? " is-do" : ""}`}>{d.word}</span><span>{d.text}</span></div>
          ))}
        </div>
      )}
    </Card>
  );
}

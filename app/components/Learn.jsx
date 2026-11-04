// Learn → Improve the website — the card on Analytics: the changes to the
// store's site AVA drafted from what shoppers said (site-ideas.js), best
// first, each with what to change, the facts behind it and the shoppers'
// own words; the team marks each done or dismisses it. "Improve AVA" beside
// it is the lessons and the chat review (Ratings.jsx).
import { Card, InlineStack, Badge, Button } from "@shopify/polaris";
import { useFetcher } from "react-router";
import { Row } from "./SettingsUI";

export const LEARN_CSS = `
  .ln-idea { display: grid; gap: 6px; padding: 14px 16px 14px; border-top: 1px solid rgba(30,27,51,0.07); }
  .ln-idea__top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; color: #8a8a8a; }
  .ln-rank { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; flex: none; font-size: 12px; font-weight: 700; color: #1a2e26; background: rgba(26,46,38,0.07); font-variant-numeric: tabular-nums; }
  .ln-pill { padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 16px; font-weight: 650; color: #616161; background: rgba(26,46,38,0.06); white-space: nowrap; }
  .ln-pill.is-high { color: #a33d3d; background: rgba(185,90,90,0.13); }
  .ln-pill.is-medium { color: #7a5412; background: #fbf3e4; }
  .ln-pill.is-low { color: #245a86; background: #eef4fb; }
  .ln-pill.is-area { color: #1f4d39; background: rgba(45,107,79,0.10); }
  .ln-idea__title { font-size: 15px; line-height: 21px; font-weight: 650; color: #1a1a1a; overflow-wrap: anywhere; }
  .ln-idea__change { font-size: 13.5px; line-height: 20px; color: #1a1a1a; overflow-wrap: anywhere; }
  .ln-idea__why { font-size: 12.5px; line-height: 18px; color: #4a4a4a; overflow-wrap: anywhere; }
  .ln-idea__why b { font-weight: 650; color: #616161; }
  .ln-quotes { display: grid; gap: 4px; margin: 2px 0 0; padding: 0; list-style: none; }
  .ln-quotes li { padding: 6px 10px; border-radius: 8px; background: #f5f5f7; font-size: 12.5px; line-height: 18px; color: #4a4a4a; font-style: italic; overflow-wrap: anywhere; }
  .ln-idea__acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
  .ln-past { display: grid; gap: 5px; padding: 10px 16px 12px; border-top: 1px solid rgba(30,27,51,0.07); font-size: 12.5px; line-height: 18px; color: #616161; }
  .ln-past__row { display: flex; align-items: flex-start; gap: 8px; }
  .ln-past__row span:last-child { overflow-wrap: anywhere; }
  .ln-note { padding: 10px 16px 2px; font-size: 12.5px; line-height: 18px; color: #616161; }
  .ln-empty { padding: 18px 16px 20px; font-size: 13px; line-height: 19px; color: #616161; }
  .ln-callout { margin: 10px 16px 0; padding: 10px 12px; border-radius: 10px; background: rgba(185,137,0,0.09); font-size: 12.5px; line-height: 18px; color: #4a3b00; }
`;

export function SiteIdeasCard({ ideas, mounted }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const drafting = busy && fetcher.formData?.get("intent") === "ideas_draft";
  const open = ideas?.open || [];
  const decided = ideas?.decided || [];
  const result = fetcher.state === "idle" ? fetcher.data : null;
  const when = (d) => (mounted && d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
  return (
    <Card padding="0">
      <Row
        title={<InlineStack gap="200" blockAlign="center"><span>Improve the website</span>{open.length > 0 && <Badge tone="attention">{String(open.length)}</Badge>}</InlineStack>}
        help="Once a week AVA reads what shoppers told her over the last month — the issues and questions raised most, what she couldn't answer, the thumbs-down and comments, what the chat review flagged, the products asked about most and the orders the chat drove — and drafts changes to the site, each with the facts behind it. Ranked by how many shoppers it touches and how close they were to buying. Mark one done once it's on the site; dismiss what doesn't fit. Nothing changes on its own."
        control={
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="ideas_draft" />
            <Button size="slim" submit loading={drafting} disabled={busy && !drafting}>Draft now</Button>
          </fetcher.Form>
        }
      />
      {result?.error && <div className="ln-callout">{result.error}</div>}
      {result && !result.error && typeof result.drafted === "number" && (
        <div className="ln-callout">{result.drafted > 0 ? `${result.drafted} new idea${result.drafted === 1 ? "" : "s"} drafted.` : result.thin ? "Not enough to work from yet: once shoppers have raised an issue or two, rated answers, or the chat review has flagged something, ideas appear here." : "Nothing new: the facts point to the ideas already listed."}</div>
      )}
      {mounted && ideas?.lastDraftAt && <div className="ln-note">{`Last drafted ${when(ideas.lastDraftAt)}.`}</div>}
      {open.length === 0 ? (
        <div className="ln-empty">No ideas waiting. The first draft comes a week after chats start, or now with Draft now.</div>
      ) : open.map((i, n) => (
        <div key={i.id} className="ln-idea">
          <div className="ln-idea__top">
            <span className="ln-rank" aria-label={`Number ${n + 1}`}>{n + 1}</span>
            <span className={`ln-pill is-${i.impact}`}>{i.impactLabel}</span>
            <span className="ln-pill">{i.effortLabel}</span>
            <span className="ln-pill is-area">{i.areaLabel}</span>
            {i.shoppers > 0 && <span>{`${i.shoppers.toLocaleString()} shopper${i.shoppers === 1 ? "" : "s"}`}</span>}
            {mounted && <span>{when(i.createdAt)}</span>}
          </div>
          <div className="ln-idea__title">{i.title}</div>
          <div className="ln-idea__change">{i.change}</div>
          {i.why && <div className="ln-idea__why"><b>Why:</b> {i.why}</div>}
          {i.evidence.length > 0 && <ul className="ln-quotes">{i.evidence.map((q, k) => <li key={k}>{`“${q}”`}</li>)}</ul>}
          <div className="ln-idea__acts">
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="idea_decide" />
              <input type="hidden" name="id" value={i.id} />
              <input type="hidden" name="decision" value="done" />
              <Button size="slim" variant="primary" submit disabled={busy}>Mark done</Button>
            </fetcher.Form>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="idea_decide" />
              <input type="hidden" name="id" value={i.id} />
              <input type="hidden" name="decision" value="dismissed" />
              <Button size="slim" submit disabled={busy}>Dismiss</Button>
            </fetcher.Form>
          </div>
        </div>
      ))}
      {decided.length > 0 && (
        <div className="ln-past">
          {decided.map((i) => (
            <div key={i.id} className="ln-past__row">
              <span className={`ln-pill${i.status === "done" ? " is-area" : ""}`}>{i.status === "done" ? "Done" : "Dismissed"}</span>
              <span>{i.title}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

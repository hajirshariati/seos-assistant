// Recordings: the conversations saved while the store has recording on
// (Settings → Recording). Chats are grouped by day (or week) in the store's
// time zone, newest first; only the latest group starts open, so the page
// stays short however many chats pile up. The page loads a window of days
// (the last 7 by default; 30, 90 or everything kept on request) plus every
// flagged chat whatever its age. Search, a tester filter, "has errors" and
// "flagged" narrow it down; each chat opens to its full transcript.
// "Delete chat" clears one chat, "Delete day" a day's chats, "Delete all"
// every chat — flagged chats stay through the last two. Deleting never
// changes "Top shopper issues & questions" (components/ShopperConcerns.jsx):
// a chat it hasn't read yet is hidden now and removed once read.
// A chat can be flagged by hand; the chat guard flags the chats it ended
// (or would have, in watch mode), with each counted message marked.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLoaderData, useFetcher, useNavigate, useRevalidator, useSearchParams } from "react-router";
import { Page, Card, BlockStack, InlineStack, Text, Button, Badge, TextField, Select, Icon } from "@shopify/polaris";
import { SearchIcon, ChevronDownIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { adminWithAccess } from "../lib/staff-access.server";
import { getRecentQuestions } from "../models/ChatFeedback.server";
import { listLessons, decideLesson, draftLessonsNow } from "../lib/feedback-lessons.server";
import { RATINGS_CSS, LessonsCard, ReviewCard, NotHelpfulCard, HelpfulCard, useCsvExport } from "../components/Ratings";
import { reviewSummary, reviewNow } from "../lib/chat-review.server";
import { getShopConfig } from "../models/ShopConfig.server";
import { listRecordings, deleteAllRecordings, deleteDayRecordings, deleteRecordingSession } from "../models/ChatRecording.server";
import { listFlags, setFlag, clearFlag } from "../models/ChatFlag.server";
import { unlockGuardSession, getGuardStates, sessionKey } from "../models/ChatGuard.server";
import { recordingState, groupSessions, recordingLabels, dayBounds } from "../lib/chat-recording.js";
import { guardTurnLabel, guardMode } from "../lib/chat-guard.js";
import { getShopTimeZone } from "../lib/shop-timezone.server";
import { concernSummary, startConcernRead, concernRunState, storeButtonTexts } from "../lib/chat-concerns.server";
import BrandHeader from "../components/BrandHeader";
import ShopperConcerns, { CONCERNS_CSS } from "../components/ShopperConcerns";
import { SETTINGS_CSS, Row, SectionHead } from "../components/SettingsUI";

// The windows the page can show: days back, or everything kept.
const WINDOWS = [7, 30, 90, 0];
const windowOf = (value) => (WINDOWS.includes(Number(value)) ? Number(value) : 7);

export const loader = async ({ request }) => {
  const { session, admin } = await adminWithAccess(request);
  const url = new URL(request.url);
  const config = await getShopConfig(session.shop);
  const st = recordingState(config);
  const windowDays = windowOf(url.searchParams.get("days"));
  const days = windowDays || st.keepDays;
  // The shoppers' votes over the same window (everything kept: a year), and
  // the lessons drafted from the thumbs-down.
  const voteDays = days || 365;
  const [rows, flags, timeZone, votes, lessons, review] = await Promise.all([
    listRecordings(session.shop, { days }),
    listFlags(session.shop),
    getShopTimeZone(admin, session.shop).catch(() => ""),
    getRecentQuestions(session.shop, { startDate: new Date(Date.now() - voteDays * 86400000), endDate: new Date() }, 300).catch(() => []),
    listLessons(session.shop).catch(() => ({ drafts: [], decided: [] })),
    reviewSummary(session.shop).catch(() => ({ state: null, run: { running: false }, findings: [] })),
  ]);
  // Flagged chats show whatever their age.
  const seen = new Set(rows.map((r) => r.sessionId));
  const olderFlagged = flags.map((f) => f.sessionId).filter((id) => !seen.has(id));
  const flaggedRows = olderFlagged.length ? await listRecordings(session.shop, { sessionIds: olderFlagged }) : [];
  const flagOf = new Map(flags.map((f) => [f.sessionId, f]));
  // Chats the guard ended that are still ended, for "Unlock now".
  const guardIds = flags.filter((f) => f.kind === "guard").map((f) => f.sessionId);
  const locks = guardIds.length ? await getGuardStates(session.shop, guardIds.map(sessionKey)).catch(() => ({})) : {};
  // Days, weeks and times are worked out here, in the store's time zone.
  const L = recordingLabels({ timeZone });
  const grouped = groupSessions([...rows, ...flaggedRows]);
  // The store's button messages: the card reads only what shoppers typed.
  const buttons = await storeButtonTexts(session.shop, { admin, config });
  // The card never takes the page down: if its data can't be read, it's empty.
  const { since, updatedAt, ...concerns } = await concernSummary(session.shop, grouped, buttons).catch((err) => {
    console.error("[recordings] concerns summary failed:", err?.message || err);
    return { read: 0, top: [], more: [], pending: 0, run: concernRunState(session.shop) };
  });
  const hasKey = Boolean(config?.anthropicApiKey);
  // New shopper chats are read (and top themes described afresh) when the
  // page opens, at most every 30 minutes.
  if (hasKey && (concerns.pending > 0 || concerns.describe > 0)) concerns.run = startConcernRead(session.shop, { apiKey: config.anthropicApiKey, auto: true, buttons });
  const now = Date.now();
  const sessions = grouped
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .map((s) => {
      const f = flagOf.get(s.sessionId);
      const lock = locks[sessionKey(s.sessionId)];
      const lockedUntil = lock?.lockedUntil && new Date(lock.lockedUntil).getTime() > now ? lock.lockedUntil : null;
      let strikes = 0;
      return {
        sessionId: s.sessionId,
        tester: s.tester,
        page: s.page,
        failed: s.failed,
        flag: f ? { kind: f.kind, note: f.note, at: L.dateTime(f.createdAt) } : null,
        lockedUntil: lockedUntil ? L.time(lockedUntil) : null,
        day: L.day(s.startedAt),
        week: L.week(s.startedAt),
        time: L.time(s.startedAt),
        turns: s.turns.map((t) => {
          if (/^(strike|warn):/.test(t.guard || "")) strikes += 1;
          return { id: t.id, at: L.time(t.createdAt), message: t.message, reply: t.reply, products: t.products || [], extras: t.extras, ok: t.ok, guard: t.guard ? guardTurnLabel(t.guard, strikes) : "", ended: /^(end|watch):/.test(t.guard || "") };
        }),
      };
    });
  return {
    recording: { on: st.on, scope: st.scope, keepDays: st.keepDays, guard: guardMode(config) },
    votes: { down: votes.filter((r) => r.vote === "down"), up: votes.filter((r) => r.vote === "up") },
    lessons,
    review,
    window: windowDays,
    sessions,
    flagged: flags.length,
    total: rows.length,
    concerns: {
      ...concerns,
      hasKey,
      sinceLabel: since ? shortDate(since, timeZone) : "",
      updatedLabel: updatedAt ? L.dateTime(updatedAt) : "",
    },
  };
};

function shortDate(date, timeZone) {
  const opts = { month: "short", day: "numeric", year: "numeric" };
  try { return new Intl.DateTimeFormat("en-US", { timeZone: timeZone || "UTC", ...opts }).format(new Date(date)); }
  catch { return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(new Date(date)); }
}

export const action = async ({ request }) => {
  const { session, admin } = await adminWithAccess(request);
  const form = await request.formData();
  const intent = form.get("intent");
  // The chat review, now (it runs in the background; the page polls).
  if (intent === "review_now") {
    try { return await reviewNow(session.shop); } catch (err) { return { error: String(err?.message || err) }; }
  }
  // Lessons from thumbs-down: approve or dismiss one, or draft today's now.
  if (intent === "lesson_decide" || intent === "lessons_draft") {
    try {
      if (intent === "lesson_decide") return await decideLesson(session.shop, String(form.get("id") || ""), String(form.get("decision") || ""));
      return await draftLessonsNow(session.shop);
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  }
  // Deleting never changes "Top shopper issues & questions": chats it hasn't
  // read yet are hidden now and read soon (then removed).
  const readSoon = async () => {
    const config = await getShopConfig(session.shop);
    if (!config?.anthropicApiKey) return;
    const buttons = await storeButtonTexts(session.shop, { admin, config });
    startConcernRead(session.shop, { apiKey: config.anthropicApiKey, buttons });
  };
  if (intent === "delete_all") {
    const out = await deleteAllRecordings(session.shop);
    if (out.trashed) await readSoon();
    return { deleted: out.deleted + out.trashed };
  }
  if (intent === "delete_day") {
    const timeZone = await getShopTimeZone(admin, session.shop).catch(() => "");
    const bounds = dayBounds(String(form.get("day") || ""), timeZone);
    if (!bounds) return { error: "Unknown day." };
    const out = await deleteDayRecordings(session.shop, bounds);
    if (out.trashed) await readSoon();
    return { deleted: out.deleted + out.trashed, chats: out.chats };
  }
  if (intent === "delete_session") {
    const out = await deleteRecordingSession(session.shop, form.get("sessionId"));
    if (out.trashed) await readSoon();
    return { deleted: out.deleted + out.trashed };
  }
  if (intent === "flag_session") {
    await setFlag(session.shop, form.get("sessionId"), { kind: "manual" });
    return { flagged: true };
  }
  if (intent === "unflag_session") {
    await clearFlag(session.shop, form.get("sessionId"));
    return { flagged: false };
  }
  if (intent === "unlock_session") {
    await unlockGuardSession(session.shop, form.get("sessionId"));
    return { unlocked: true };
  }
  if (intent === "refresh_concerns") {
    const config = await getShopConfig(session.shop);
    if (!config?.anthropicApiKey) return { concerns: concernRunState(session.shop) };
    const buttons = await storeButtonTexts(session.shop, { admin, config });
    return { concerns: startConcernRead(session.shop, { apiKey: config.anthropicApiKey, buttons }) };
  }
  return null;
};

const REC_CSS = `
  .rec .set-row__title { overflow-wrap: anywhere; }
  .rec-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
  .rec-search { flex: 1 1 260px; min-width: 0; }
  .rec-tester { width: 180px; }
  .rec-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 9px; background: rgba(26,46,38,0.06); }
  .rec-seg button, .rec-chip { all: unset; box-sizing: border-box; cursor: pointer; white-space: nowrap; }
  .rec-seg button { padding: 5px 11px; border-radius: 7px; font-size: 12.5px; line-height: 18px; font-weight: 550; color: #4a4a4a; }
  .rec-seg button[aria-pressed="true"] { background: #fff; color: #1a1a1a; font-weight: 650; box-shadow: 0 1px 2px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.05); }
  .rec-chip { padding: 5px 12px; border-radius: 999px; font-size: 12.5px; line-height: 18px; font-weight: 600; color: #4a4a4a; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.12); }
  .rec-chip[aria-pressed="true"] { background: #fff1f0; color: #a33d3d; box-shadow: inset 0 0 0 1px rgba(163,61,61,0.35); }
  .rec-tools { scroll-margin-top: 16px; }
  .rec-chip--theme { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; }
  .rec-chip--theme[aria-pressed="true"] { background: rgba(45,107,79,0.10); color: #1f4d39; box-shadow: inset 0 0 0 1px rgba(45,107,79,0.35); }
  .rec-chip__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .rec-seg button:focus-visible, .rec-chip:focus-visible, .rec-head:focus-visible, .rec-chat:focus-visible { outline: 2px solid #2D6B4F; outline-offset: 2px; }
  .rec-summary { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; font-size: 13px; color: #616161; }
  .rec-head { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px 16px; cursor: pointer; }
  .rec-head + .rec-head, .rec-chat + .rec-head, .rec-open + .rec-head, .rec-more + .rec-head { border-top: 1px solid rgba(30,27,51,0.09); }
  .rec-head:hover { background: rgba(26,46,38,0.025); }
  .rec-head__title { font-size: 14px; line-height: 20px; font-weight: 650; color: #1a2e26; }
  .rec-head__sub { flex: 1; min-width: 0; font-size: 12.5px; color: #616161; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rec-head .Polaris-Icon { margin: 0; flex: none; }
  .rec-err { color: #a33d3d; font-weight: 600; }
  .rec-chat { all: unset; box-sizing: border-box; display: grid; grid-template-columns: 66px minmax(0, 110px) minmax(0, 1fr) auto; align-items: center; gap: 12px; width: 100%;
    padding: 9px 16px; border-top: 1px solid rgba(30,27,51,0.07); cursor: pointer; }
  .rec-chat:hover { background: rgba(26,46,38,0.025); }
  .rec-chat[aria-expanded="true"] { background: rgba(45,107,79,0.04); }
  .rec-chat__time { font-size: 12.5px; color: #616161; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rec--week .rec-chat { grid-template-columns: 150px minmax(0, 110px) minmax(0, 1fr) auto; }
  .rec-chat__who { font-size: 13px; font-weight: 600; color: #1a1a1a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rec-chat__q { font-size: 13px; color: #303030; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rec-chat__meta { display: flex; align-items: center; gap: 6px; }
  .rec-open { padding: 4px 16px 14px; background: rgba(45,107,79,0.04); }
  .rec-open__bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; padding: 6px 0 10px; font-size: 12px; color: #616161; }
  .rec-tx { display: grid; gap: 10px; padding: 12px; border-radius: 12px; background: #fff; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.06); }
  .rec-turn { display: grid; gap: 4px; }
  .rec-msg { max-width: 82%; padding: 8px 12px; border-radius: 14px; font-size: 13px; line-height: 19px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .rec-msg--you { justify-self: end; background: #1d1d1f; color: #fff; border-bottom-right-radius: 5px; }
  .rec-msg--ai { justify-self: start; max-width: 88%; background: #f5f5f7; color: #1d1d1f; border-bottom-left-radius: 5px; }
  .rec-msg--fail { background: #fff1f0; box-shadow: inset 0 0 0 1px #ffccc7; }
  .rec-msg__extra { margin-top: 6px; font-size: 12px; line-height: 17px; color: #6e6e73; }
  .rec-at { font-size: 11px; color: #8e8e93; }
  .rec-guard { justify-self: end; display: inline-flex; align-items: center; gap: 6px; max-width: 82%; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; line-height: 16px; font-weight: 650; color: #7a5412; background: #fbf3e4; }
  .rec-guard::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .rec-guard--end { color: #a33d3d; background: #fff1f0; }
  .rec-flag { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; line-height: 16px; font-weight: 650; white-space: nowrap; }
  .rec-flag--manual { color: #1f4d39; background: rgba(45,107,79,0.10); }
  .rec-flag--guard { color: #a33d3d; background: #fff1f0; }
  .rec-flag--watch { color: #7a5412; background: #fbf3e4; }
  .rec-open__note { flex-basis: 100%; margin: -2px 0 6px; font-size: 12.5px; line-height: 18px; color: #303030; }
  .rec-open__acts { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; }
  .rec-head__acts { display: inline-flex; align-items: center; flex: none; }
  .rec-window { display: inline-flex; gap: 2px; padding: 2px; border-radius: 9px; background: rgba(26,46,38,0.06); }
  .rec-window button { all: unset; box-sizing: border-box; cursor: pointer; white-space: nowrap; padding: 5px 11px; border-radius: 7px; font-size: 12.5px; line-height: 18px; font-weight: 550; color: #4a4a4a; }
  .rec-window button[aria-pressed="true"] { background: #fff; color: #1a1a1a; font-weight: 650; box-shadow: 0 1px 2px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.05); }
  .rec-window button:focus-visible { outline: 2px solid #2D6B4F; outline-offset: 2px; }
  .rec-more { padding: 10px 16px 12px; border-top: 1px solid rgba(30,27,51,0.07); }
  .rec-empty { padding: 28px 16px; text-align: center; color: #616161; font-size: 13px; }
  @media (max-width: 760px) {
    .rec-tester { width: 100%; }
    .rec-chat, .rec--week .rec-chat { grid-template-columns: minmax(58px, auto) minmax(0, 1fr) auto; }
    .rec-chat__q { grid-column: 2 / -1; grid-row: 2; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .rec-msg, .rec-msg--ai { max-width: 92%; }
    .rec-guard { max-width: 92%; }
  }
`;

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const PER_GROUP = 25;
const FLAG_WORDS = { manual: "Flagged", guard: "Ended by guard", watch: "Would have ended" };

function FlagBadge({ flag }) {
  if (!flag) return null;
  return <span className={`rec-flag rec-flag--${flag.kind}`}>{FLAG_WORDS[flag.kind] || "Flagged"}</span>;
}

function Transcript({ turns }) {
  return (
    <div className="rec-tx">
      {turns.map((t) => (
        <div key={t.id} className="rec-turn">
          {t.guard && <span className={`rec-guard${t.ended ? " rec-guard--end" : ""}`}>{t.guard}</span>}
          <div className="rec-msg rec-msg--you">{t.message}</div>
          <div className={`rec-msg rec-msg--ai${t.ok ? "" : " rec-msg--fail"}`}>
            {t.reply || (t.ok ? "" : "No reply — the turn failed.")}
            {(t.products.length > 0 || t.extras) && (
              <div className="rec-msg__extra">
                {t.products.length > 0 && <div>Products shown: {t.products.join(" · ")}</div>}
                {t.extras && <div>Also shown: {t.extras}</div>}
              </div>
            )}
          </div>
          <div className="rec-at">{t.at}</div>
        </div>
      ))}
    </div>
  );
}

function ChatRow({ s, open, onToggle, onDelete, onFlag, onUnlock, deleting, withDay }) {
  const n = s.turns.length;
  const who = s.tester || "Shopper";
  return (
    <>
      <button type="button" className="rec-chat" aria-expanded={open} onClick={onToggle}>
        <span className="rec-chat__time">{withDay ? `${s.day.label}, ${s.time}` : s.time}</span>
        <span className="rec-chat__who">{who}</span>
        <span className="rec-chat__q">{s.turns[0]?.message || ""}</span>
        <span className="rec-chat__meta">
          <FlagBadge flag={s.flag} />
          {s.failed > 0 && <Badge tone="critical" size="small">{`${s.failed} failed`}</Badge>}
          <Badge size="small">{plural(n, "message", "messages")}</Badge>
        </span>
      </button>
      {open && (
        <div className="rec-open">
          <div className="rec-open__bar">
            {s.flag && (
              <div className="rec-open__note">
                <b>{FLAG_WORDS[s.flag.kind] || "Flagged"}</b>{s.flag.note ? ` — ${s.flag.note}` : ""}{s.flag.kind === "manual" ? ` (${s.flag.at})` : ""}
                {s.lockedUntil ? ` The chat is paused until ${s.lockedUntil}.` : ""}
              </div>
            )}
            <span>{`${plural(n, "message", "messages")}${s.page ? ` · started on ${s.page}` : ""}`}</span>
            <span className="rec-open__acts">
              {s.lockedUntil && <Button variant="plain" onClick={onUnlock} accessibilityLabel={`Unlock the chat from ${who} now`}>Unlock now</Button>}
              <Button variant="plain" onClick={onFlag} accessibilityLabel={`${s.flag ? "Remove the flag from" : "Flag"} the chat from ${who}`}>{s.flag ? "Remove flag" : "Flag chat"}</Button>
              <Button variant="plain" tone="critical" disabled={deleting} onClick={onDelete} accessibilityLabel={`Delete chat from ${who}`}>Delete chat</Button>
            </span>
          </div>
          <Transcript turns={s.turns} />
        </div>
      )}
    </>
  );
}

function DayGroup({ group, open, onToggle, openChats, toggleChat, onDelete, onFlag, onUnlock, onDeleteDay, removing, withDay }) {
  const [showAll, setShowAll] = useState(false);
  const failed = group.sessions.filter((s) => s.failed > 0).length;
  const flagged = group.sessions.filter((s) => s.flag).length;
  const shown = showAll ? group.sessions : group.sessions.slice(0, PER_GROUP);
  return (
    <>
      <div style={{ display: "flex", alignItems: "center" }}>
        <button type="button" className="rec-head" aria-expanded={open} onClick={onToggle}>
          <Icon source={open ? ChevronDownIcon : ChevronRightIcon} tone="subdued" />
          <span className="rec-head__title">{group.label}</span>
          <span className="rec-head__sub">
            {plural(group.sessions.length, "chat", "chats")} · {plural(group.messages, "message", "messages")}
            {flagged > 0 && ` · ${flagged} flagged`}
            {failed > 0 && <span className="rec-err">{` · ${failed} with errors`}</span>}
          </span>
        </button>
        {open && onDeleteDay && (
          <span className="rec-head__acts" style={{ paddingRight: 12 }}>
            <Button size="slim" variant="tertiary" tone="critical" onClick={() => onDeleteDay(group)} accessibilityLabel={`Delete every chat from ${group.label}`}>Delete day</Button>
          </span>
        )}
      </div>
      {open && (
        <>
          {shown.map((s) => (
            <ChatRow
              key={s.sessionId}
              s={s}
              open={openChats.has(s.sessionId)}
              onToggle={() => toggleChat(s.sessionId)}
              onDelete={() => onDelete(s)}
              onFlag={() => onFlag(s)}
              onUnlock={() => onUnlock(s)}
              deleting={Boolean(removing)}
              withDay={withDay}
            />
          ))}
          {group.sessions.length > PER_GROUP && (
            <div className="rec-more">
              <Button variant="plain" disclosure={showAll ? "up" : "down"} onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show ${group.sessions.length - PER_GROUP} more`}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

// By day, the last week of days shows; older days fold behind one row.
const RECENT_DAYS = 7;
const WINDOW_WORDS = { 7: "Last 7 days", 30: "Last 30 days", 90: "Last 90 days", 0: "Everything kept" };

export default function Recordings() {
  const { recording, sessions, concerns, flagged, window: windowDays, votes, lessons, review } = useLoaderData();
  const [voteExporting, exportVotes] = useCsvExport(windowDays ? { range: windowDays === 7 ? "7d" : windowDays === 30 ? "30d" : "90d" } : { range: "custom", start: new Date(Date.now() - 365 * 86400000).toISOString(), end: new Date().toISOString() });
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const fetcher = useFetcher();
  const rowFetcher = useFetcher();
  const flagFetcher = useFetcher();
  const concernFetcher = useFetcher();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [by, setBy] = useState("day");
  const [query, setQuery] = useState("");
  const [tester, setTester] = useState("");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  // The newest day (or week) starts open; the rest stay folded.
  const [openGroups, setOpenGroups] = useState(() => new Set(sessions[0] ? [`day:${sessions[0].day.key}`, `week:${sessions[0].week.key}`] : []));
  // While searching or filtering every matching group opens; these are the
  // ones folded again by hand.
  const [foldedMatches, setFoldedMatches] = useState(() => new Set());
  const [openChats, setOpenChats] = useState(() => new Set());
  const [exporting, setExporting] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  // "View chats" on a theme: the list shows only that theme's kept chats.
  const [theme, setTheme] = useState(null);
  const listRef = useRef(null);
  const viewTheme = (t) => {
    setTheme(t ? { id: t.id, title: t.title, ids: t.sessionIds } : null);
    if (t) requestAnimationFrame(() => listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  // "Open the chat" on a flagged answer: the list shows that chat alone, open.
  const openChatById = useCallback((sessionId) => {
    setTheme({ id: `chat:${sessionId}`, title: "The flagged chat", ids: [sessionId] });
    setOpenChats(new Set([sessionId]));
    requestAnimationFrame(() => listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);
  // While the chats are being read (the top issues, or the chat review), the
  // page checks back every few seconds.
  const reading = Boolean(concerns.run?.running || review?.run?.running);
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  useEffect(() => {
    if (!reading) return undefined;
    const t = setInterval(() => {
      const r = revalidatorRef.current;
      if (r.state === "idle" && document.visibilityState === "visible") r.revalidate();
    }, 4000);
    return () => clearInterval(t);
  }, [reading]);

  const toggleSet = (setter) => (id) => setter((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleGroup = toggleSet(setOpenGroups);
  const toggleMatch = toggleSet(setFoldedMatches);
  const toggleChat = toggleSet(setOpenChats);

  // Downloads run inside the embedded app with its session token (see Analytics).
  const exportCsv = useCallback(async () => {
    setExporting(true);
    try {
      const token = await shopify.idToken();
      const res = await fetch("/app/exports?section=recordings", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `recordings_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch {
      shopify.toast.show("Export failed. Please try again.", { isError: true });
    } finally {
      setExporting(false);
    }
  }, [shopify]);

  const deleting = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "delete_all";
  const deletingDay = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "delete_day" ? fetcher.formData.get("day") : null;
  // One chat at a time; it disappears as soon as Delete is confirmed.
  const removing = rowFetcher.state !== "idle" ? rowFetcher.formData?.get("sessionId") : null;
  const removeChat = (s) => {
    const note = s.flag ? " This chat is flagged; deleting it removes the flag too." : "";
    if (!window.confirm(`Delete this chat (${plural(s.turns.length, "message", "messages")})?${note} This can't be undone.`)) return;
    rowFetcher.submit({ intent: "delete_session", sessionId: s.sessionId }, { method: "post" });
  };
  const removeDay = (g) => {
    const kept = g.sessions.filter((s) => s.flag).length;
    const n = g.sessions.length - kept;
    if (n <= 0) { shopify.toast.show("Every chat that day is flagged — they stay until deleted one by one."); return; }
    if (!window.confirm(`Delete ${plural(n, "chat", "chats")} from ${g.label}?${kept ? ` ${plural(kept, "flagged chat stays", "flagged chats stay")}.` : ""} "Top shopper issues & questions" keeps its counts. This can't be undone.`)) return;
    fetcher.submit({ intent: "delete_day", day: g.key }, { method: "post" });
  };
  const removeAll = () => {
    if (!window.confirm(`Delete all recorded chats?${flagged ? ` ${plural(flagged, "flagged chat stays", "flagged chats stay")}.` : ""} "Top shopper issues & questions" keeps its counts. This can't be undone.`)) return;
    setTheme(null);
    fetcher.submit({ intent: "delete_all" }, { method: "post" });
  };
  // Flags apply at once: the row shows its new state while the save runs.
  const [flagEdits, setFlagEdits] = useState({});
  const flagChat = (s) => {
    const next = !(flagEdits[s.sessionId] ?? Boolean(s.flag));
    setFlagEdits((o) => ({ ...o, [s.sessionId]: next }));
    flagFetcher.submit({ intent: next ? "flag_session" : "unflag_session", sessionId: s.sessionId }, { method: "post" });
  };
  const unlockChat = (s) => {
    flagFetcher.submit({ intent: "unlock_session", sessionId: s.sessionId }, { method: "post" });
    shopify.toast.show("The chat can send again.");
  };
  useEffect(() => { setFlagEdits({}); }, [sessions]);
  const shown = useMemo(() => sessions.map((s) => {
    const e = flagEdits[s.sessionId];
    if (e === undefined) return s;
    return { ...s, flag: e ? (s.flag || { kind: "manual", note: "", at: "just now" }) : null };
  }), [sessions, flagEdits]);
  const setWindow = (d) => setSearchParams(d === 7 ? {} : { days: String(d) });

  const testers = useMemo(() => [...new Set(shown.map((s) => s.tester || "Shopper"))].sort(), [shown]);
  const q = query.trim().toLowerCase();
  const themeIds = useMemo(() => (theme ? new Set(theme.ids) : null), [theme]);
  const filtering = Boolean(q || tester || onlyErrors || onlyFlagged || themeIds);
  const visible = useMemo(() => shown.filter((s) =>
    s.sessionId !== removing &&
    (deletingDay === null || s.day.key !== deletingDay || s.flag) &&
    (!themeIds || themeIds.has(s.sessionId)) &&
    (!tester || (s.tester || "Shopper") === tester) &&
    (!onlyErrors || s.failed > 0) &&
    (!onlyFlagged || s.flag) &&
    (!q || `${s.tester} ${s.page} ${s.turns.map((t) => `${t.message} ${t.reply}`).join(" ")}`.toLowerCase().includes(q)),
  ), [shown, removing, deletingDay, themeIds, tester, onlyErrors, onlyFlagged, q]);

  const groups = useMemo(() => {
    const out = [];
    const byKey = new Map();
    for (const s of visible) {
      const g = s[by];
      const id = `${by}:${g.key}`;
      if (!byKey.has(id)) { const grp = { id, key: g.key, label: g.label, sessions: [], messages: 0 }; byKey.set(id, grp); out.push(grp); }
      const grp = byKey.get(id);
      grp.sessions.push(s);
      grp.messages += s.turns.length;
    }
    return out;
  }, [visible, by]);
  useEffect(() => { setFoldedMatches(new Set()); }, [q, tester, onlyErrors, onlyFlagged, themeIds]);
  const isOpen = (g) => (filtering ? !foldedMatches.has(g.id) : openGroups.has(g.id));
  const totalMessages = visible.reduce((n, s) => n + s.turns.length, 0);
  const folded = by === "day" && !filtering && !showOlder ? groups.slice(RECENT_DAYS) : [];
  const listed = folded.length ? groups.slice(0, RECENT_DAYS) : groups;
  const withErrors = shown.filter((s) => s.failed > 0).length;
  const withFlags = shown.filter((s) => s.flag).length;
  const keepWords = recording.keepDays === 365 ? "a year" : recording.keepDays === 180 ? "6 months" : recording.keepDays === 90 ? "3 months" : `${recording.keepDays} days`;

  return (
    <Page>
      <TitleBar title="Recordings" />
      {/* Static CSS, injected as-is: as a text child React would escape its
          quotes on the server and the page wouldn't hydrate. */}
      <style dangerouslySetInnerHTML={{ __html: SETTINGS_CSS + RATINGS_CSS + REC_CSS + CONCERNS_CSS }} />
      <div className={`rec set-links${by === "week" ? " rec--week" : ""}`}>
        <BlockStack gap="400">
          <BrandHeader title="Recordings" gutter={false} />
          <ShopperConcerns
            concerns={concerns}
            activeId={theme?.id || ""}
            onView={viewTheme}
            onRefresh={() => concernFetcher.submit({ intent: "refresh_concerns" }, { method: "post" })}
            refreshing={concernFetcher.state !== "idle"}
          />
          <div id="ratings">
            <SectionHead title="Ratings">
              {`What shoppers said with a thumbs up or down${windowDays ? ` in the last ${windowDays} days` : ""}, the answers AVA's daily review of every chat flagged, and the lessons she drafts from both for you to approve.`}
            </SectionHead>
            <BlockStack gap="400">
              <LessonsCard lessons={lessons} mounted={mounted} />
              <ReviewCard review={review} mounted={mounted} onOpenChat={openChatById} />
              <NotHelpfulCard rows={votes.down} onExport={exportVotes} exporting={voteExporting} mounted={mounted} rangeWords={windowDays ? `the last ${windowDays} days` : "everything kept"} />
              <HelpfulCard rows={votes.up} onExport={exportVotes} exporting={voteExporting} mounted={mounted} rangeWords={windowDays ? `the last ${windowDays} days` : "everything kept"} />
            </BlockStack>
          </div>
          <div>
            <SectionHead title="Recordings">
              {`Chats saved while recording is on, kept ${keepWords} — flagged chats until you delete them. Times are in your store's time zone.`}
            </SectionHead>
            <Card padding="0">
              <Row
                title={<InlineStack gap="200" blockAlign="center"><span>Recording</span>{recording.on ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}</InlineStack>}
                help={recording.on
                  ? `Saving ${recording.scope === "everyone" ? "every chat" : "testers' chats"} until you turn it off.`
                  : "Turn it on in Settings, and share the tester link with your team if you only want testers recorded."}
                control={<Button onClick={() => navigate("/app/api-keys#testing")}>Settings → Recording</Button>}
              />
              <Row
                title={<InlineStack gap="200" blockAlign="center"><span>Chat guard</span>{recording.guard === "on" ? <Badge tone="success">On</Badge> : recording.guard === "watch" ? <Badge tone="attention">Watching</Badge> : <Badge>Off</Badge>}</InlineStack>}
                help={recording.guard === "on"
                  ? "Chats that keep trying to work AVA rather than shop are ended; each is flagged here with its counted messages marked."
                  : recording.guard === "watch"
                    ? "Chats it would have ended are flagged here (\"Would have ended\") without changing anything for the shopper. Review them, then turn it on in Settings."
                    : "Off. Turn it on in Settings to flag or end chats that keep trying to work AVA rather than shop."}
              />
            </Card>
          </div>

          {sessions.length === 0 && windowDays === 7 ? (
            <Card>
              <div className="rec-empty">
                <Text as="p" variant="headingSm">No recorded chats in the last 7 days</Text>
                <p style={{ margin: "4px 0 0" }}>{recording.on ? "Chats appear here as they happen." : "Once recording is on, chats appear here."}</p>
                <div style={{ marginTop: 10 }}><Button variant="plain" onClick={() => setWindow(0)}>Show everything kept</Button></div>
              </div>
            </Card>
          ) : (
            <>
              <div className="rec-tools" ref={listRef}>
                {theme && (
                  <button type="button" className="rec-chip rec-chip--theme" aria-pressed="true" onClick={() => setTheme(null)} aria-label={`Showing chats about ${theme.title}. Show all chats`}>
                    <span className="rec-chip__label">{theme.title}</span>
                    <span aria-hidden="true">✕</span>
                  </button>
                )}
                <div className="rec-search">
                  <TextField
                    label="Search chats"
                    labelHidden
                    size="slim"
                    prefix={<Icon source={SearchIcon} tone="subdued" />}
                    placeholder="Search what was said"
                    value={query}
                    onChange={setQuery}
                    clearButton
                    onClearButtonClick={() => setQuery("")}
                    autoComplete="off"
                  />
                </div>
                {testers.length > 1 && (
                  <div className="rec-tester">
                    <Select label="Tester" labelHidden options={[{ label: "All testers", value: "" }, ...testers.map((t) => ({ label: t, value: t }))]} value={tester} onChange={setTester} />
                  </div>
                )}
                {withFlags > 0 && (
                  <button type="button" className="rec-chip" aria-pressed={onlyFlagged} onClick={() => setOnlyFlagged((v) => !v)}>
                    {`Flagged · ${withFlags}`}
                  </button>
                )}
                {withErrors > 0 && (
                  <button type="button" className="rec-chip" aria-pressed={onlyErrors} onClick={() => setOnlyErrors((v) => !v)}>
                    {`Has errors · ${withErrors}`}
                  </button>
                )}
                <div className="rec-window" role="group" aria-label="Show chats from">
                  {WINDOWS.map((d) => (
                    <button key={d} type="button" aria-pressed={windowDays === d} onClick={() => setWindow(d)}>{WINDOW_WORDS[d]}</button>
                  ))}
                </div>
                <div className="rec-seg" role="group" aria-label="Group by">
                  <button type="button" aria-pressed={by === "day"} onClick={() => setBy("day")}>By day</button>
                  <button type="button" aria-pressed={by === "week"} onClick={() => setBy("week")}>By week</button>
                </div>
              </div>

              <div className="rec-summary">
                <span>{`${plural(visible.length, "chat", "chats")} · ${plural(totalMessages, "message", "messages")}${filtering ? " match" : ""}`}</span>
                <InlineStack gap="200">
                  <Button size="slim" onClick={exportCsv} loading={exporting}>Export CSV</Button>
                  <Button size="slim" variant="tertiary" tone="critical" loading={deleting} onClick={removeAll}>Delete all</Button>
                </InlineStack>
              </div>

              {groups.length === 0 ? (
                <Card><div className="rec-empty">{filtering ? "No chats match. Try other words, or clear the filters." : `No chats in ${WINDOW_WORDS[windowDays].toLowerCase()}.`}</div></Card>
              ) : (
                <Card padding="0">
                  {listed.map((g) => (
                    <DayGroup
                      key={g.id}
                      group={g}
                      open={isOpen(g)}
                      onToggle={() => (filtering ? toggleMatch(g.id) : toggleGroup(g.id))}
                      openChats={openChats}
                      toggleChat={toggleChat}
                      onDelete={removeChat}
                      onFlag={flagChat}
                      onUnlock={unlockChat}
                      onDeleteDay={by === "day" && !filtering ? removeDay : null}
                      removing={removing}
                      withDay={by === "week"}
                    />
                  ))}
                  {(folded.length > 0 || (showOlder && by === "day" && !filtering && groups.length > RECENT_DAYS)) && (
                    <div className="rec-more">
                      <Button variant="plain" disclosure={showOlder ? "up" : "down"} onClick={() => setShowOlder((v) => !v)}>
                        {showOlder ? "Hide older days" : `Show ${folded.length} older days (${plural(folded.reduce((n, g) => n + g.sessions.length, 0), "chat", "chats")})`}
                      </Button>
                    </div>
                  )}
                </Card>
              )}
            </>
          )}
        </BlockStack>
      </div>
    </Page>
  );
}

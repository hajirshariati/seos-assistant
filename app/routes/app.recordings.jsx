// Recordings — the customer service team's page: every chat saved while
// recording is on (Settings → Recording), on one screen. The numbers at a
// glance on top (chats, messages, thumbs down, flagged, failed, ended by
// the guard — each one a filter), then one card with tabs: the chats as a
// dense list that pages, the thumbs down and up, and the issues shoppers
// raise most. A chat opens in the reader beside the list (a full sheet on a
// phone), with its flags, its votes and its actions — nothing pushes the
// list down and the page never scrolls for ever. The page loads a window
// of days (the last 7 by default; a day, 30, 90 or everything kept) plus
// every flagged chat whatever its age; ?chat=<id> opens that chat.
// Deleting never changes "Top shopper issues & questions": a chat it
// hasn't read yet is hidden now and removed once read. The lessons and
// the chat review live on Analytics → Learn, not here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLoaderData, useFetcher, useNavigate, useRevalidator, useSearchParams } from "react-router";
import { Page, Card, Button, TextField, Select, Icon, Popover, ActionList } from "@shopify/polaris";
import { SearchIcon, MenuHorizontalIcon, XIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { adminWithAccess } from "../lib/staff-access.server";
import { getRecentQuestions } from "../models/ChatFeedback.server";
import { RATINGS_CSS, useCsvExport } from "../components/Ratings";
import { getShopConfig } from "../models/ShopConfig.server";
import { listRecordings, deleteAllRecordings, deleteDayRecordings, deleteRecordingSession } from "../models/ChatRecording.server";
import { listFlags, setFlag, clearFlag } from "../models/ChatFlag.server";
import { unlockGuardSession, getGuardStates, sessionKey } from "../models/ChatGuard.server";
import { recordingState, groupSessions, recordingLabels, dayBounds } from "../lib/chat-recording.js";
import { guardTurnLabel, guardMode } from "../lib/chat-guard.js";
import { getShopTimeZone } from "../lib/shop-timezone.server";
import { concernSummary, startConcernRead, concernRunState, storeButtonTexts } from "../lib/chat-concerns.server";
import { FEEDBACK_REASONS, FEEDBACK_SUBJECTS } from "../lib/chat-rating.js";
import BrandHeader from "../components/BrandHeader";
import ShopperConcerns, { CONCERNS_CSS } from "../components/ShopperConcerns";
import { SETTINGS_CSS } from "../components/SettingsUI";

// The windows the page can show: days back, or everything kept.
const WINDOWS = [1, 7, 30, 90, 0];
const WINDOW_WORDS = { 1: "24 hours", 7: "7 days", 30: "30 days", 90: "90 days", 0: "All kept" };
const windowOf = (value) => (value !== null && WINDOWS.includes(Number(value)) ? Number(value) : 7);

export const loader = async ({ request }) => {
  const { session, admin } = await adminWithAccess(request);
  const url = new URL(request.url);
  const config = await getShopConfig(session.shop);
  const st = recordingState(config);
  const windowDays = windowOf(url.searchParams.get("days"));
  const days = windowDays || st.keepDays;
  const focus = String(url.searchParams.get("chat") || "").slice(0, 80);
  const tab = ["chats", "down", "up", "issues"].includes(url.searchParams.get("tab")) ? url.searchParams.get("tab") : "chats";
  // The shoppers' votes over the same window (everything kept: a year).
  const voteDays = days || 365;
  const [rows, flags, timeZone, votes] = await Promise.all([
    listRecordings(session.shop, { days }),
    listFlags(session.shop),
    getShopTimeZone(admin, session.shop).catch(() => ""),
    getRecentQuestions(session.shop, { startDate: new Date(Date.now() - voteDays * 86400000), endDate: new Date() }, 300).catch(() => []),
  ]);
  // Flagged chats show whatever their age, and so does the chat a link opens.
  const seen = new Set(rows.map((r) => r.sessionId));
  const extra = [...new Set([...flags.map((f) => f.sessionId), ...(focus ? [focus] : [])])].filter((id) => !seen.has(id));
  const extraRows = extra.length ? await listRecordings(session.shop, { sessionIds: extra }) : [];
  const flagOf = new Map(flags.map((f) => [f.sessionId, f]));
  // Chats the guard ended that are still ended, for "Unlock now".
  const guardIds = flags.filter((f) => f.kind === "guard").map((f) => f.sessionId);
  const locks = guardIds.length ? await getGuardStates(session.shop, guardIds.map(sessionKey)).catch(() => ({})) : {};
  // Days and times are worked out here, in the store's time zone.
  const L = recordingLabels({ timeZone });
  const grouped = groupSessions([...rows, ...extraRows]);
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
  // The votes each chat got, by chat.
  const votesBy = new Map();
  for (const v of votes) if (v.sessionId) { if (!votesBy.has(v.sessionId)) votesBy.set(v.sessionId, []); votesBy.get(v.sessionId).push(v.vote); }
  const sessions = grouped
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .map((s) => {
      const f = flagOf.get(s.sessionId);
      const lock = locks[sessionKey(s.sessionId)];
      const lockedUntil = lock?.lockedUntil && new Date(lock.lockedUntil).getTime() > now ? lock.lockedUntil : null;
      let strikes = 0;
      const sv = votesBy.get(s.sessionId) || [];
      return {
        sessionId: s.sessionId,
        tester: s.tester,
        page: s.page,
        failed: s.failed,
        down: sv.filter((v) => v === "down").length,
        up: sv.filter((v) => v === "up").length,
        flag: f ? { kind: f.kind, note: f.note, at: L.dateTime(f.createdAt) } : null,
        lockedUntil: lockedUntil ? L.time(lockedUntil) : null,
        day: L.day(s.startedAt),
        time: L.time(s.startedAt),
        startedAt: new Date(s.startedAt).toISOString(),
        turns: s.turns.map((t) => {
          if (/^(strike|warn):/.test(t.guard || "")) strikes += 1;
          return { id: t.id, at: L.time(t.createdAt), message: t.message, reply: t.reply, products: t.products || [], extras: t.extras, ok: t.ok, guard: t.guard ? guardTurnLabel(t.guard, strikes) : "", ended: /^(end|watch):/.test(t.guard || "") };
        }),
      };
    });
  return {
    recording: { on: st.on, scope: st.scope, keepDays: st.keepDays, guard: guardMode(config) },
    votes: votes.map((v) => ({ ...v, when: L.dateTime(v.date) })),
    window: windowDays,
    focus,
    tab,
    sessions,
    flagged: flags.length,
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
  .rd { --rd-line: rgba(30,27,51,0.08); --rd-green: #2D6B4F; --rd-red: #a33d3d; }
  .rd-top { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
  .rd-top__title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; min-width: 0; margin-right: auto; }
  .rd-top__title h2 { margin: 0; font-size: 20px; line-height: 26px; font-weight: 700; color: #1a1a1a; letter-spacing: -0.01em; }
  .rd-state { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px 3px 7px; border-radius: 999px; font-size: 11.5px; line-height: 16px; font-weight: 650; color: #4a4a4a; background: rgba(26,46,38,0.06); white-space: nowrap; }
  .rd-state::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #9a9a9a; }
  .rd-state.is-on { color: #1f4d39; background: rgba(45,107,79,0.10); }
  .rd-state.is-on::before { background: var(--rd-green); box-shadow: 0 0 0 3px rgba(45,107,79,0.16); }
  .rd-state.is-watch { color: #7a5412; background: #fbf3e4; }
  .rd-state.is-watch::before { background: #c58a1d; }
  .rd-state a { color: inherit; text-decoration: none; }
  .rd-state a:hover { text-decoration: underline; text-underline-offset: 2px; }
  .rd-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 9px; background: rgba(26,46,38,0.06); }
  .rd-seg button { all: unset; box-sizing: border-box; cursor: pointer; white-space: nowrap; padding: 5px 11px; border-radius: 7px; font-size: 12.5px; line-height: 18px; font-weight: 550; color: #4a4a4a; }
  .rd-seg button[aria-pressed="true"] { background: #fff; color: #1a1a1a; font-weight: 650; box-shadow: 0 1px 2px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.05); }
  .rd-seg button:focus-visible, .rd-stat:focus-visible, .rd-tab:focus-visible, .rd-row:focus-visible, .rd-chip:focus-visible, .rd-pager button:focus-visible, .rd-x:focus-visible { outline: 2px solid var(--rd-green); outline-offset: 2px; }
  .rd-stats { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
  .rd-stat { all: unset; box-sizing: border-box; display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 12px 14px 11px; border-radius: 12px; background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04); color: #1a1a1a; }
  .rd-stat[data-filter] { cursor: pointer; }
  .rd-stat[data-filter]:hover { box-shadow: 0 0 0 1px rgba(45,107,79,0.35), 0 1px 2px rgba(0,0,0,0.04); }
  .rd-stat[aria-pressed="true"] { background: rgba(45,107,79,0.07); box-shadow: 0 0 0 1.5px var(--rd-green); }
  .rd-stat__label { font-size: 11.5px; line-height: 16px; font-weight: 600; color: #616161; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rd-stat__value { font-size: 24px; line-height: 28px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .rd-stat__hint { font-size: 11.5px; line-height: 16px; color: #8a8a8a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rd-stat.is-bad .rd-stat__value { color: var(--rd-red); }
  .rd-stat.is-warn .rd-stat__value { color: #7a5412; }
  .rd-stat.is-zero .rd-stat__value { color: #8a8a8a; }
  .rd-main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 42%); gap: 14px; align-items: start; }
  .rd-tabs { display: flex; gap: 2px; padding: 8px 10px 0; border-bottom: 1px solid var(--rd-line); overflow-x: auto; scrollbar-width: none; }
  .rd-tabs::-webkit-scrollbar { display: none; }
  .rd-tab { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; padding: 8px 10px 9px; border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer; white-space: nowrap; font-size: 13px; line-height: 18px; font-weight: 600; color: #616161; }
  .rd-tab:hover { color: #1a1a1a; }
  .rd-tab[aria-selected="true"] { color: #1a1a1a; border-bottom-color: var(--rd-green); }
  .rd-tab__n { padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 16px; font-weight: 650; color: #4a4a4a; background: rgba(26,46,38,0.08); font-variant-numeric: tabular-nums; }
  .rd-tab__n.is-bad { color: var(--rd-red); background: rgba(185,90,90,0.13); }
  .rd-tab__n.is-good { color: #1f4d39; background: rgba(45,107,79,0.12); }
  .rd-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--rd-line); }
  .rd-search { flex: 1 1 220px; min-width: 0; }
  .rd-tester { width: 160px; }
  .rd-chip { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 5px 11px; border-radius: 999px; cursor: pointer; white-space: nowrap; font-size: 12.5px; line-height: 18px; font-weight: 600; color: #1f4d39; background: rgba(45,107,79,0.10); box-shadow: inset 0 0 0 1px rgba(45,107,79,0.30); }
  .rd-chip__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .rd-count { margin-left: auto; font-size: 12.5px; color: #616161; white-space: nowrap; }
  .rd-scroll { max-height: calc(100vh - 340px); min-height: 320px; overflow: auto; overscroll-behavior: contain; }
  .rd-list { display: grid; }
  .rd-row { all: unset; box-sizing: border-box; display: grid; grid-template-columns: 112px minmax(0, 1fr) auto; align-items: center; gap: 4px 12px; width: 100%; padding: 9px 14px; border-top: 1px solid var(--rd-line); cursor: pointer; }
  .rd-row:first-child { border-top: 0; }
  .rd-row:hover { background: rgba(26,46,38,0.025); }
  .rd-row[aria-current="true"] { background: rgba(45,107,79,0.07); box-shadow: inset 3px 0 0 var(--rd-green); }
  .rd-row__when { display: grid; gap: 1px; min-width: 0; }
  .rd-row__day { font-size: 12.5px; line-height: 16px; font-weight: 600; color: #1a1a1a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rd-row__time { font-size: 11.5px; line-height: 15px; color: #8a8a8a; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .rd-row__main { display: grid; gap: 2px; min-width: 0; }
  .rd-row__who { font-size: 11.5px; line-height: 15px; font-weight: 650; color: #616161; letter-spacing: 0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rd-row__who.is-tester { color: #245a86; }
  .rd-row__q { font-size: 13.5px; line-height: 19px; color: #1a1a1a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rd-row__sub { font-size: 12px; line-height: 16px; color: #616161; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rd-row__meta { display: flex; align-items: center; justify-content: flex-end; gap: 6px; white-space: nowrap; }
  .rd-n { font-size: 12px; color: #8a8a8a; font-variant-numeric: tabular-nums; }
  .rd-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; font-size: 11px; line-height: 16px; font-weight: 650; white-space: nowrap; color: #4a4a4a; background: rgba(26,46,38,0.07); }
  .rd-pill--manual { color: #1f4d39; background: rgba(45,107,79,0.10); }
  .rd-pill--guard, .rd-pill--bad { color: var(--rd-red); background: #fff1f0; }
  .rd-pill--watch { color: #7a5412; background: #fbf3e4; }
  .rd-pill--good { color: #1f4d39; background: rgba(45,107,79,0.10); }
  .rd-pill--subject { color: #4a4a4a; background: rgba(26,46,38,0.06); }
  .rd-pager { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 14px; border-top: 1px solid var(--rd-line); font-size: 12.5px; color: #616161; }
  .rd-pager__btns { display: inline-flex; gap: 4px; }
  .rd-pager button { all: unset; box-sizing: border-box; cursor: pointer; padding: 4px 10px; border-radius: 7px; font-size: 12.5px; line-height: 18px; font-weight: 600; color: #1a1a1a; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.12); }
  .rd-pager button[disabled] { opacity: 0.4; cursor: default; }
  .rd-empty { padding: 36px 16px; text-align: center; color: #616161; font-size: 13px; line-height: 19px; }
  .rd-empty b { display: block; margin-bottom: 2px; font-size: 14px; color: #1a1a1a; }
  .rd-reader { position: sticky; top: 16px; display: flex; flex-direction: column; max-height: calc(100vh - 32px); border-radius: 12px; background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04); overflow: hidden; }
  .rd-reader__empty { display: grid; place-items: center; min-height: 260px; padding: 24px; text-align: center; color: #616161; font-size: 13px; line-height: 19px; }
  .rd-reader__empty b { display: block; margin-bottom: 2px; font-size: 14px; color: #1a1a1a; }
  .rd-reader__head { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px 10px; border-bottom: 1px solid var(--rd-line); }
  .rd-reader__title { flex: 1; min-width: 0; display: grid; gap: 2px; }
  .rd-reader__who { font-size: 15px; line-height: 20px; font-weight: 700; color: #1a1a1a; letter-spacing: -0.01em; }
  .rd-reader__sub { font-size: 12px; line-height: 16px; color: #616161; overflow-wrap: anywhere; }
  .rd-reader__pills { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 4px; }
  .rd-x { all: unset; box-sizing: border-box; display: none; place-items: center; width: 32px; height: 32px; border-radius: 50%; cursor: pointer; color: #4a4a4a; background: rgba(26,46,38,0.06); flex: none; }
  .rd-x .Polaris-Icon { margin: 0; }
  .rd-reader__note { margin: 0 14px; padding: 8px 10px; border-radius: 8px; font-size: 12.5px; line-height: 18px; color: #303030; background: #fbf3e4; }
  .rd-reader__note.is-manual { background: rgba(45,107,79,0.08); }
  .rd-reader__body { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px 14px; display: grid; gap: 12px; align-content: start; }
  .rd-reader__acts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; padding: 8px 14px; border-top: 1px solid var(--rd-line); background: #fafafa; }
  .rd-votes { display: grid; gap: 8px; }
  .rd-votes__title { font-size: 11px; line-height: 16px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; color: #616161; }
  .rd-vote { display: grid; gap: 4px; padding: 8px 10px; border-radius: 10px; background: #f7f7f8; font-size: 12.5px; line-height: 18px; color: #303030; }
  .rd-vote__top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .rd-vote__c { font-style: italic; }
  .rd-tx { display: grid; gap: 10px; }
  .rd-turn { display: grid; gap: 4px; }
  .rd-msg { max-width: 86%; padding: 8px 12px; border-radius: 14px; font-size: 13px; line-height: 19px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .rd-msg--you { justify-self: end; background: #1d1d1f; color: #fff; border-bottom-right-radius: 5px; }
  .rd-msg--ai { justify-self: start; max-width: 92%; background: #f5f5f7; color: #1d1d1f; border-bottom-left-radius: 5px; }
  .rd-msg--fail { background: #fff1f0; box-shadow: inset 0 0 0 1px #ffccc7; }
  .rd-msg__extra { margin-top: 6px; font-size: 12px; line-height: 17px; color: #6e6e73; }
  .rd-at { font-size: 11px; color: #8e8e93; }
  .rd-guard { justify-self: end; display: inline-flex; align-items: center; gap: 6px; max-width: 86%; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; line-height: 16px; font-weight: 650; color: #7a5412; background: #fbf3e4; }
  .rd-guard::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .rd-guard--end { color: var(--rd-red); background: #fff1f0; }
  .rd-dl { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 6px 10px; margin: 0; font-size: 12.5px; line-height: 18px; }
  .rd-dl dt { font-size: 10.5px; line-height: 18px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; color: #8a8a8a; }
  .rd-dl dd { margin: 0; color: #1a1a1a; overflow-wrap: anywhere; }
  .rd-dl dd.is-c { padding: 6px 10px; border-radius: 8px; background: #fff8e1; font-style: italic; }
  .rd-why { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 24px; padding: 12px 14px; border-bottom: 1px solid var(--rd-line); }
  .rd .set-links a { color: var(--rd-green); }
  @media (max-width: 1100px) { .rd-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 920px) {
    .rd-main { grid-template-columns: minmax(0, 1fr); }
    .rd-scroll { max-height: none; min-height: 0; overflow: visible; }
    .rd-reader { position: fixed; inset: 0; z-index: 60; max-height: none; border-radius: 0; box-shadow: none; }
    .rd-reader.is-empty { display: none; }
    .rd-x { display: grid; }
    .rd-why { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 600px) {
    .rd-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .rd-top__title { order: 0; flex: 1 1 0; min-width: 0; }
    .rd-top__menu { order: 1; }
    .rd-seg { order: 2; flex-basis: 100%; overflow-x: auto; scrollbar-width: none; }
    .rd-seg::-webkit-scrollbar { display: none; }
    .rd-seg button { flex: 1 0 auto; text-align: center; }
    .rd-tester { width: 100%; }
    .rd-row { grid-template-columns: minmax(0, 1fr) auto; }
    .rd-row__when { grid-column: 1 / -1; grid-row: 2; display: flex; gap: 6px; }
    .rd-row__day::after { content: "·"; margin-left: 6px; color: #8a8a8a; }
    .rd-row__q { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .rd-msg, .rd-msg--ai { max-width: 94%; }
  }
`;

const plural = (n, one, many) => `${Number(n || 0).toLocaleString()} ${n === 1 ? one : many}`;
const PER_PAGE = 25;
const FLAG_WORDS = { manual: "Flagged", guard: "Ended by guard", watch: "Would have ended" };
const TABS = [["chats", "Chats"], ["down", "Not helpful"], ["up", "Helpful"], ["issues", "Top issues"]];

function Transcript({ turns }) {
  return (
    <div className="rd-tx">
      {turns.map((t) => (
        <div key={t.id} className="rd-turn">
          {t.guard && <span className={`rd-guard${t.ended ? " rd-guard--end" : ""}`}>{t.guard}</span>}
          <div className="rd-msg rd-msg--you">{t.message}</div>
          <div className={`rd-msg rd-msg--ai${t.ok ? "" : " rd-msg--fail"}`}>
            {t.reply || (t.ok ? "" : "No reply — the turn failed.")}
            {(t.products.length > 0 || t.extras) && (
              <div className="rd-msg__extra">
                {t.products.length > 0 && <div>Products shown: {t.products.join(" · ")}</div>}
                {t.extras && <div>Also shown: {t.extras}</div>}
              </div>
            )}
          </div>
          <div className="rd-at">{t.at}</div>
        </div>
      ))}
    </div>
  );
}

const voteWords = (v) => v.lastUserQuestion || v.question || v.comment || v.aiResponse || "";

// A thumbs up or down, in the reader: what was asked, what AVA said, the
// reason or comment, and the messages the widget sent with the vote.
function VoteDetail({ v }) {
  const said = v.flaggedAiResponse || v.aiResponse;
  return (
    <div className="rd-votes">
      <dl className="rd-dl">
        {v.kind === "chat" ? <><dt>Rated</dt><dd>{v.vote === "down" ? "The whole chat, not helpful" : "The whole chat, helpful"}{v.moment ? ` · ${FEEDBACK_MOMENTS_WORDS[v.moment] || v.moment}` : ""}</dd></> : null}
        {v.lastUserQuestion && <><dt>Shopper</dt><dd>{v.lastUserQuestion}</dd></>}
        {said && v.kind !== "chat" && <><dt>AVA</dt><dd>{said}</dd></>}
        {v.reason && FEEDBACK_REASONS[v.reason] && <><dt>Reason</dt><dd>{FEEDBACK_REASONS[v.reason]}</dd></>}
        {v.comment && <><dt>Comment</dt><dd className="is-c">{v.comment}</dd></>}
      </dl>
      {v.transcript?.length > 0 && (
        <div className="rd-tx">
          {v.transcript.map((m, i) => <div key={i} className={`rd-msg ${m.role === "user" ? "rd-msg--you" : "rd-msg--ai"}`}>{m.content}</div>)}
        </div>
      )}
    </div>
  );
}
const FEEDBACK_MOMENTS_WORDS = { cart: "after an add to cart", buy_now: "back from checkout", replies: "after a few replies", order: "about an order" };

function RankList({ rows, tone }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className={`an-rank${tone === "down" ? " an-rank--down" : ""}`}>
      {rows.map((r) => (
        <li key={r.title}>
          <div className="an-rank__top"><span className="an-rank__title">{r.title}</span><span className="an-rank__n">{r.count}</span></div>
          <div className="an-rank__bar"><span style={{ width: `${Math.round((r.count / max) * 100)}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

export default function Recordings() {
  const { recording, sessions, concerns, flagged, window: windowDays, votes, focus, tab: tabParam } = useLoaderData();
  const [voteExporting, exportVotes] = useCsvExport(windowDays ? { range: windowDays <= 7 ? "7d" : windowDays === 30 ? "30d" : "90d" } : { range: "custom", start: new Date(Date.now() - 365 * 86400000).toISOString(), end: new Date().toISOString() });
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const fetcher = useFetcher();
  const rowFetcher = useFetcher();
  const flagFetcher = useFetcher();
  const concernFetcher = useFetcher();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [tab, setTab] = useState(tabParam);
  const [query, setQuery] = useState("");
  const [tester, setTester] = useState("");
  const [only, setOnly] = useState(""); // flagged | failed | down | guard
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // "View chats" on a theme: the list shows only that theme's kept chats.
  const [theme, setTheme] = useState(null);
  // What the reader shows: a chat, or a vote whose chat isn't loaded.
  const [selected, setSelected] = useState(() => (focus ? { kind: "chat", id: focus } : null));
  const readerRef = useRef(null);
  const closeRef = useRef(null);

  // While the chats are being read, the page checks back every few seconds.
  const reading = Boolean(concerns.run?.running);
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
    setSelected(null);
    rowFetcher.submit({ intent: "delete_session", sessionId: s.sessionId }, { method: "post" });
  };
  const removeDay = (s) => {
    const same = sessions.filter((x) => x.day.key === s.day.key);
    const kept = same.filter((x) => x.flag).length;
    const n = same.length - kept;
    if (n <= 0) { shopify.toast.show("Every chat that day is flagged — they stay until deleted one by one."); return; }
    if (!window.confirm(`Delete ${plural(n, "chat", "chats")} from ${s.day.label}?${kept ? ` ${plural(kept, "flagged chat stays", "flagged chats stay")}.` : ""} "Top issues" keeps its counts. This can't be undone.`)) return;
    if (!s.flag) setSelected(null);
    fetcher.submit({ intent: "delete_day", day: s.day.key }, { method: "post" });
  };
  const removeAll = () => {
    if (!window.confirm(`Delete all recorded chats?${flagged ? ` ${plural(flagged, "flagged chat stays", "flagged chats stay")}.` : ""} "Top issues" keeps its counts. This can't be undone.`)) return;
    setTheme(null);
    setSelected(null);
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
  const setWindow = (d) => { setPage(1); setSearchParams(d === 7 ? {} : { days: String(d) }); };

  const testers = useMemo(() => [...new Set(shown.map((s) => s.tester || "Shopper"))].sort(), [shown]);
  const q = query.trim().toLowerCase();
  const themeIds = useMemo(() => (theme ? new Set(theme.ids) : null), [theme]);
  const filtering = Boolean(q || tester || only || themeIds);
  const visible = useMemo(() => shown.filter((s) =>
    s.sessionId !== removing &&
    (deletingDay === null || s.day.key !== deletingDay || s.flag) &&
    (!themeIds || themeIds.has(s.sessionId)) &&
    (!tester || (s.tester || "Shopper") === tester) &&
    (only !== "failed" || s.failed > 0) &&
    (only !== "flagged" || s.flag) &&
    (only !== "down" || s.down > 0) &&
    (only !== "guard" || (s.flag && s.flag.kind !== "manual")) &&
    (!q || `${s.tester} ${s.page} ${s.turns.map((t) => `${t.message} ${t.reply}`).join(" ")}`.toLowerCase().includes(q)),
  ), [shown, removing, deletingDay, themeIds, tester, only, q]);
  const downs = useMemo(() => votes.filter((v) => v.vote === "down" && (!q || voteWords(v).toLowerCase().includes(q) || (v.aiResponse || "").toLowerCase().includes(q))), [votes, q]);
  const ups = useMemo(() => votes.filter((v) => v.vote === "up" && (!q || voteWords(v).toLowerCase().includes(q))), [votes, q]);
  useEffect(() => { setPage(1); }, [q, tester, only, themeIds, tab, windowDays]);

  const list = tab === "chats" ? visible : tab === "down" ? downs : tab === "up" ? ups : [];
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  const pageNow = Math.min(page, pages);
  const slice = list.slice((pageNow - 1) * PER_PAGE, pageNow * PER_PAGE);

  // The numbers on top, for the whole window (not the filters).
  const totals = useMemo(() => ({
    chats: shown.length,
    messages: shown.reduce((n, s) => n + s.turns.length, 0),
    shoppers: shown.filter((s) => !s.tester).length,
    down: votes.filter((v) => v.vote === "down").length,
    up: votes.filter((v) => v.vote === "up").length,
    flagged: shown.filter((s) => s.flag).length,
    failed: shown.filter((s) => s.failed > 0).length,
    guard: shown.filter((s) => s.flag && s.flag.kind !== "manual").length,
  }), [shown, votes]);
  const why = useMemo(() => {
    const reasons = {}, subjects = {};
    let noReason = 0;
    for (const r of downs) {
      if (r.reason && FEEDBACK_REASONS[r.reason]) reasons[r.reason] = (reasons[r.reason] || 0) + 1; else noReason++;
      const key = r.subject && FEEDBACK_SUBJECTS[r.subject] ? r.subject : "other";
      subjects[key] = (subjects[key] || 0) + 1;
    }
    const rank = (o, labels) => Object.entries(o).sort((x, y) => y[1] - x[1]).map(([key, n]) => ({ title: labels[key], count: n }));
    const reasonRows = rank(reasons, FEEDBACK_REASONS);
    if (noReason > 0) reasonRows.push({ title: "No reason picked", count: noReason });
    return { reasons: reasonRows, subjects: rank(subjects, FEEDBACK_SUBJECTS) };
  }, [downs]);

  // The reader: the chat picked (gone once deleted), or a vote on its own.
  const bySession = useMemo(() => new Map(shown.map((s) => [s.sessionId, s])), [shown]);
  const current = selected?.kind === "chat" ? bySession.get(selected.id) || null : null;
  const currentVote = selected?.kind === "vote" ? votes.find((v) => v.id === selected.id) || null : null;
  const open = Boolean(current || currentVote);
  useEffect(() => { if (selected?.kind === "chat" && !bySession.has(selected.id) && !removing) setSelected(null); }, [selected, bySession, removing]);
  const pick = (s) => setSelected({ kind: "chat", id: s.sessionId });
  const pickVote = (v) => setSelected(v.sessionId && bySession.has(v.sessionId) ? { kind: "chat", id: v.sessionId } : { kind: "vote", id: v.id });
  const close = () => setSelected(null);
  // On a phone the reader is a sheet: focus moves in, Escape closes it.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    if (window.matchMedia("(max-width: 920px)").matches) closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, selected]);
  const viewTheme = (t) => {
    setTheme(t ? { id: t.id, title: t.title, ids: t.sessionIds } : null);
    if (t) setTab("chats");
  };
  const toggleOnly = (key) => { setTab("chats"); setOnly((v) => (v === key ? "" : key)); };
  const currentVotes = current ? votes.filter((v) => v.sessionId === current.sessionId) : [];
  const keepWords = recording.keepDays === 365 ? "a year" : recording.keepDays === 180 ? "6 months" : recording.keepDays === 90 ? "3 months" : `${recording.keepDays} days`;
  const windowWords = windowDays === 1 ? "the last 24 hours" : windowDays ? `the last ${windowDays} days` : "everything kept";

  const stat = (label, value, hint, { filter, tone } = {}) => (
    <button
      type="button"
      className={`rd-stat${tone && value > 0 ? ` is-${tone}` : ""}${value === 0 ? " is-zero" : ""}`}
      data-filter={filter || undefined}
      aria-pressed={filter ? only === filter : undefined}
      onClick={filter ? () => toggleOnly(filter) : undefined}
      disabled={!filter}
      style={filter ? undefined : { cursor: "default" }}
    >
      <span className="rd-stat__label">{label}</span>
      <span className="rd-stat__value">{Number(value).toLocaleString()}</span>
      <span className="rd-stat__hint">{hint}</span>
    </button>
  );

  return (
    <Page fullWidth>
      <TitleBar title="Recordings" />
      {/* Static CSS, injected as-is: as a text child React would escape its
          quotes on the server and the page wouldn't hydrate. */}
      <style dangerouslySetInnerHTML={{ __html: SETTINGS_CSS + RATINGS_CSS + REC_CSS + CONCERNS_CSS }} />
      <div className="rd set-links">
        <div style={{ display: "grid", gap: 14 }}>
          <BrandHeader title="Recordings" gutter={false} />

          <div className="rd-top">
            <div className="rd-top__title">
              <h2>Chats</h2>
              <span className={`rd-state${recording.on ? " is-on" : ""}`} title={recording.on ? `Saving ${recording.scope === "everyone" ? "every chat" : "testers' chats"}, kept ${keepWords}` : "Recording is off"}>
                {recording.on ? `Recording ${recording.scope === "everyone" ? "everyone" : "testers"}` : "Recording off"}
              </span>
              <span className={`rd-state${recording.guard === "on" ? " is-on" : recording.guard === "watch" ? " is-watch" : ""}`} title={recording.guard === "on" ? "Chats that keep trying to work AVA rather than shop are ended and flagged here" : recording.guard === "watch" ? "Chats the guard would have ended are flagged here without changing anything for the shopper" : "The chat guard is off"}>
                {recording.guard === "on" ? "Guard on" : recording.guard === "watch" ? "Guard watching" : "Guard off"}
              </span>
            </div>
            <div className="rd-seg" role="group" aria-label="Show chats from">
              {WINDOWS.map((d) => (
                <button key={d} type="button" aria-pressed={windowDays === d} onClick={() => setWindow(d)}>{WINDOW_WORDS[d]}</button>
              ))}
            </div>
            <div className="rd-top__menu"><Popover
              active={menuOpen}
              onClose={() => setMenuOpen(false)}
              activator={<Button icon={MenuHorizontalIcon} accessibilityLabel="More actions" onClick={() => setMenuOpen((v) => !v)} disclosure={false} />}
            >
              <ActionList
                actionRole="menuitem"
                items={[
                  { content: exporting ? "Exporting…" : "Export chats (CSV)", onAction: () => { setMenuOpen(false); exportCsv(); }, disabled: exporting },
                  { content: "Export thumbs down (CSV)", onAction: () => { setMenuOpen(false); exportVotes("conversations", { vote: "down" }); }, disabled: Boolean(voteExporting) || totals.down === 0 },
                  { content: "Settings → Recording", onAction: () => { setMenuOpen(false); navigate("/app/api-keys#testing"); } },
                  { content: deleting ? "Deleting…" : "Delete all chats", destructive: true, onAction: () => { setMenuOpen(false); removeAll(); }, disabled: deleting || sessions.length === 0 },
                ]}
              />
            </Popover></div>
          </div>

          <div className="rd-stats" role="group" aria-label={`Numbers for ${windowWords}`}>
            {stat("Chats", totals.chats, `${plural(totals.messages, "message", "messages")}${totals.chats - totals.shoppers > 0 ? ` · ${totals.chats - totals.shoppers} test` : ""}`)}
            {stat("Not helpful", totals.down, `${totals.up} helpful`, { filter: "down", tone: "bad" })}
            {stat("Flagged", totals.flagged, "kept until deleted", { filter: "flagged" })}
            {stat("Failed replies", totals.failed, "chats with an error", { filter: "failed", tone: "bad" })}
            {stat("Guard", totals.guard, recording.guard === "watch" ? "would have ended" : "ended by the guard", { filter: "guard", tone: "warn" })}
            {stat("Top issue", concerns.top?.[0]?.count || 0, concerns.top?.[0]?.title || "none yet")}
          </div>

          <div className="rd-main">
            <Card padding="0">
              <div className="rd-tabs" role="tablist" aria-label="What to list">
                {TABS.map(([id, label]) => {
                  const n = id === "chats" ? visible.length : id === "down" ? totals.down : id === "up" ? totals.up : (concerns.top?.length || 0) + (concerns.more?.length || 0);
                  return (
                    <button key={id} type="button" role="tab" className="rd-tab" aria-selected={tab === id} id={`rd-tab-${id}`} aria-controls="rd-panel" onClick={() => setTab(id)}>
                      {label}
                      {(id !== "issues" || n > 0) && <span className={`rd-tab__n${id === "down" && n > 0 ? " is-bad" : id === "up" && n > 0 ? " is-good" : ""}`}>{n.toLocaleString()}</span>}
                    </button>
                  );
                })}
              </div>
              <div id="rd-panel" role="tabpanel" aria-labelledby={`rd-tab-${tab}`}>
                {tab !== "issues" && (
                  <div className="rd-tools">
                    {theme && tab === "chats" && (
                      <button type="button" className="rd-chip" onClick={() => setTheme(null)} aria-label={`Showing chats about ${theme.title}. Show all chats`}>
                        <span className="rd-chip__label">{theme.title}</span>
                        <span aria-hidden="true">✕</span>
                      </button>
                    )}
                    {only && tab === "chats" && (
                      <button type="button" className="rd-chip" onClick={() => setOnly("")} aria-label="Show every chat">
                        <span className="rd-chip__label">{{ down: "Not helpful", flagged: "Flagged", failed: "Failed replies", guard: "Guard" }[only]}</span>
                        <span aria-hidden="true">✕</span>
                      </button>
                    )}
                    <div className="rd-search">
                      <TextField
                        label="Search"
                        labelHidden
                        size="slim"
                        prefix={<Icon source={SearchIcon} tone="subdued" />}
                        placeholder={tab === "chats" ? "Search what was said" : "Search the votes"}
                        value={query}
                        onChange={setQuery}
                        clearButton
                        onClearButtonClick={() => setQuery("")}
                        autoComplete="off"
                      />
                    </div>
                    {tab === "chats" && testers.length > 1 && (
                      <div className="rd-tester">
                        <Select label="Who" labelHidden options={[{ label: "Everyone", value: "" }, ...testers.map((t) => ({ label: t, value: t }))]} value={tester} onChange={setTester} />
                      </div>
                    )}
                    <span className="rd-count">{tab === "chats" ? `${plural(list.length, "chat", "chats")}${filtering ? " match" : ""}` : plural(list.length, "vote", "votes")}</span>
                  </div>
                )}

                {tab === "chats" && (
                  <div className="rd-scroll">{slice.length === 0 ? (
                    <div className="rd-empty">
                      {filtering ? <><b>No chats match</b>Try other words, or clear the filters.</> : sessions.length === 0
                        ? <><b>{`No recorded chats in ${windowWords}`}</b>{recording.on ? "Chats appear here as they happen." : "Turn recording on in Settings and chats appear here."}{windowDays !== 0 && <div style={{ marginTop: 10 }}><Button variant="plain" onClick={() => setWindow(0)}>Show everything kept</Button></div>}</>
                        : <><b>Nothing here</b>Pick another window above.</>}
                    </div>
                  ) : (
                    <div className="rd-list">
                      {slice.map((s) => (
                        <button key={s.sessionId} type="button" className="rd-row" aria-current={current?.sessionId === s.sessionId ? "true" : undefined} onClick={() => pick(s)}>
                          <span className="rd-row__when"><span className="rd-row__day">{s.day.label}</span><span className="rd-row__time">{s.time}</span></span>
                          <span className="rd-row__main">
                            <span className={`rd-row__who${s.tester ? " is-tester" : ""}`}>{s.tester ? `Test · ${s.tester}` : "Shopper"}{s.page ? ` · ${s.page}` : ""}</span>
                            <span className="rd-row__q">{s.turns[0]?.message || "(nothing typed)"}</span>
                            {s.turns.length > 1 && <span className="rd-row__sub">{`↳ ${s.turns[s.turns.length - 1].message}`}</span>}
                          </span>
                          <span className="rd-row__meta">
                            {s.flag && <span className={`rd-pill rd-pill--${s.flag.kind}`}>{FLAG_WORDS[s.flag.kind] || "Flagged"}</span>}
                            {s.down > 0 && <span className="rd-pill rd-pill--bad">{`👎 ${s.down}`}</span>}
                            {s.up > 0 && <span className="rd-pill rd-pill--good">{`👍 ${s.up}`}</span>}
                            {s.failed > 0 && <span className="rd-pill rd-pill--bad">{`${s.failed} failed`}</span>}
                            <span className="rd-n">{plural(s.turns.length, "msg", "msgs")}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}</div>
                )}

                {(tab === "down" || tab === "up") && (
                  <div className="rd-scroll">
                    {tab === "down" && downs.length > 1 && (
                      <div className="rd-why">
                        <div><div className="an-col__title">Why they said so</div><RankList rows={why.reasons} tone="down" /></div>
                        <div><div className="an-col__title">What they were asking about</div><RankList rows={why.subjects} tone="down" /></div>
                      </div>
                    )}
                    {slice.length === 0 ? (
                      <div className="rd-empty"><b>{tab === "down" ? `Nothing rated not helpful in ${windowWords}` : `No thumbs up in ${windowWords}`}</b>{q ? "Nothing matches the search." : "Votes land here as shoppers leave them."}</div>
                    ) : (
                      <div className="rd-list">
                        {slice.map((v) => {
                          const isCurrent = (currentVote && currentVote.id === v.id) || (current && v.sessionId === current.sessionId);
                          return (
                            <button key={v.id} type="button" className="rd-row" aria-current={isCurrent ? "true" : undefined} onClick={() => pickVote(v)}>
                              <span className="rd-row__when"><span className="rd-row__day">{v.when}</span><span className="rd-row__time">{v.kind === "chat" ? "whole chat" : "one reply"}</span></span>
                              <span className="rd-row__main">
                                <span className="rd-row__who">{FEEDBACK_SUBJECTS[v.subject] || "Something else"}</span>
                                <span className="rd-row__q">{voteWords(v) || "(no words saved)"}</span>
                                {v.kind !== "chat" && (v.flaggedAiResponse || v.aiResponse) && <span className="rd-row__sub">{`AVA: ${v.flaggedAiResponse || v.aiResponse}`}</span>}
                              </span>
                              <span className="rd-row__meta">
                                {v.reason && FEEDBACK_REASONS[v.reason] && <span className="rd-pill rd-pill--bad">{FEEDBACK_REASONS[v.reason]}</span>}
                                {v.comment && <span className="rd-pill">Comment</span>}
                                {v.sessionId && bySession.has(v.sessionId) && <span className="rd-n">chat kept</span>}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {tab === "issues" && (
                  <ShopperConcerns
                    bare
                    concerns={concerns}
                    activeId={theme?.id || ""}
                    onView={viewTheme}
                    onRefresh={() => concernFetcher.submit({ intent: "refresh_concerns" }, { method: "post" })}
                    refreshing={concernFetcher.state !== "idle"}
                  />
                )}

                {tab !== "issues" && list.length > PER_PAGE && (
                  <div className="rd-pager">
                    <span>{`${(pageNow - 1) * PER_PAGE + 1}–${Math.min(pageNow * PER_PAGE, list.length)} of ${list.length.toLocaleString()}`}</span>
                    <span className="rd-pager__btns">
                      <button type="button" disabled={pageNow <= 1} onClick={() => setPage(pageNow - 1)} aria-label="Previous page">‹ Newer</button>
                      <button type="button" disabled={pageNow >= pages} onClick={() => setPage(pageNow + 1)} aria-label="Next page">Older ›</button>
                    </span>
                  </div>
                )}
              </div>
            </Card>

            <div className={`rd-reader${open ? "" : " is-empty"}`} ref={readerRef} role={open ? "dialog" : "region"} aria-modal={undefined} aria-label={current ? `Chat from ${current.tester || "a shopper"}, ${current.day.label} ${current.time}` : currentVote ? "A vote" : "The chat reader"}>
              {!open && (
                <div className="rd-reader__empty"><div><b>Pick a chat to read it here</b>Flag it, delete it, or see the votes it got.</div></div>
              )}
              {current && (
                <>
                  <div className="rd-reader__head">
                    <div className="rd-reader__title">
                      <span className="rd-reader__who">{current.tester ? `Test chat · ${current.tester}` : "Shopper"}</span>
                      <span className="rd-reader__sub">{`${current.day.label}, ${current.time} · ${plural(current.turns.length, "message", "messages")}${current.page ? ` · started on ${current.page}` : ""}`}</span>
                      {(current.flag || current.down > 0 || current.up > 0 || current.failed > 0 || current.lockedUntil) && (
                        <span className="rd-reader__pills">
                          {current.flag && <span className={`rd-pill rd-pill--${current.flag.kind}`}>{FLAG_WORDS[current.flag.kind] || "Flagged"}</span>}
                          {current.down > 0 && <span className="rd-pill rd-pill--bad">{`👎 ${current.down}`}</span>}
                          {current.up > 0 && <span className="rd-pill rd-pill--good">{`👍 ${current.up}`}</span>}
                          {current.failed > 0 && <span className="rd-pill rd-pill--bad">{`${current.failed} failed`}</span>}
                          {current.lockedUntil && <span className="rd-pill rd-pill--watch">{`Paused until ${current.lockedUntil}`}</span>}
                        </span>
                      )}
                    </div>
                    <button type="button" className="rd-x" ref={closeRef} onClick={close} aria-label="Close the chat"><Icon source={XIcon} /></button>
                  </div>
                  {current.flag && (current.flag.note || current.flag.kind === "manual") && (
                    <div className={`rd-reader__note${current.flag.kind === "manual" ? " is-manual" : ""}`} style={{ marginTop: 10 }}>
                      <b>{FLAG_WORDS[current.flag.kind] || "Flagged"}</b>{current.flag.note ? ` — ${current.flag.note}` : ""}{current.flag.kind === "manual" ? ` (${current.flag.at})` : ""}
                    </div>
                  )}
                  <div className="rd-reader__body">
                    <Transcript turns={current.turns} />
                    {currentVotes.length > 0 && (
                      <div className="rd-votes">
                        <div className="rd-votes__title">{plural(currentVotes.length, "vote", "votes")} on this chat</div>
                        {currentVotes.map((v) => (
                          <div key={v.id} className="rd-vote">
                            <div className="rd-vote__top">
                              <span className={`rd-pill ${v.vote === "down" ? "rd-pill--bad" : "rd-pill--good"}`}>{v.vote === "down" ? "👎 Not helpful" : "👍 Helpful"}</span>
                              <span className="rd-pill rd-pill--subject">{v.kind === "chat" ? "Whole chat" : "One reply"}</span>
                              {v.reason && FEEDBACK_REASONS[v.reason] && <span className="rd-pill">{FEEDBACK_REASONS[v.reason]}</span>}
                              <span className="rd-n">{v.when}</span>
                            </div>
                            {v.kind !== "chat" && (v.flaggedAiResponse || v.aiResponse) && <span>{`On: “${v.flaggedAiResponse || v.aiResponse}”`}</span>}
                            {v.comment && <span className="rd-vote__c">{`“${v.comment}”`}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="rd-reader__acts">
                    <Button variant="plain" onClick={() => flagChat(current)}>{current.flag ? "Remove flag" : "Flag chat"}</Button>
                    {current.lockedUntil && <Button variant="plain" onClick={() => unlockChat(current)}>Unlock now</Button>}
                    <Button variant="plain" tone="critical" disabled={Boolean(removing)} onClick={() => removeChat(current)}>Delete chat</Button>
                    <Button variant="plain" tone="critical" disabled={Boolean(deletingDay)} onClick={() => removeDay(current)}>{`Delete ${current.day.label === "Today" || current.day.label === "Yesterday" ? current.day.label.toLowerCase() : current.day.label}`}</Button>
                  </div>
                </>
              )}
              {currentVote && (
                <>
                  <div className="rd-reader__head">
                    <div className="rd-reader__title">
                      <span className="rd-reader__who">{currentVote.vote === "down" ? "Not helpful" : "Helpful"}</span>
                      <span className="rd-reader__sub">{`${currentVote.when} · ${FEEDBACK_SUBJECTS[currentVote.subject] || "Something else"} · the chat itself is not in ${windowWords}`}</span>
                    </div>
                    <button type="button" className="rd-x" ref={closeRef} onClick={close} aria-label="Close"><Icon source={XIcon} /></button>
                  </div>
                  <div className="rd-reader__body"><VoteDetail v={currentVote} /></div>
                </>
              )}
            </div>
          </div>

          <div style={{ fontSize: 12.5, lineHeight: "18px", color: "#616161" }}>
            {`Chats are kept ${keepWords} — flagged chats until you delete them. Times are in your store's time zone. Deleting never changes Top issues: its counts cover every chat read.`}
          </div>
        </div>
      </div>
    </Page>
  );
}

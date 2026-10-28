// Test recordings: the conversations saved while the store had recording on
// (Settings → Testing). Chats are grouped by day (or week) in the store's
// time zone, newest first; only the latest group starts open, so the page
// stays short however many chats pile up. Search, a tester filter and "has
// errors" narrow it down; each chat opens to its full transcript.
// Kept 30 days; "Delete" clears one chat now, "Delete all" every chat.
// On top, "Top shopper issues & questions" (components/ShopperConcerns.jsx):
// the issues, needs and questions the most shopper chats raised, all time.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLoaderData, useFetcher, useNavigate, useRevalidator } from "react-router";
import { Page, Card, BlockStack, InlineStack, Text, Button, Badge, TextField, Select, Icon } from "@shopify/polaris";
import { SearchIcon, ChevronDownIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig } from "../models/ShopConfig.server";
import { listRecordings, deleteAllRecordings, deleteRecordingSession } from "../models/ChatRecording.server";
import { recordingState, groupSessions, recordingLabels, KEEP_DAYS } from "../lib/chat-recording.js";
import { getShopTimeZone } from "../lib/shop-timezone.server";
import { concernSummary, startConcernRead, concernRunState, forgetConcernChat, resetConcerns } from "../lib/chat-concerns.server";
import BrandHeader from "../components/BrandHeader";
import ShopperConcerns, { CONCERNS_CSS } from "../components/ShopperConcerns";
import { SETTINGS_CSS, Row, SectionHead } from "../components/SettingsUI";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const [config, rows, timeZone] = await Promise.all([
    getShopConfig(session.shop),
    listRecordings(session.shop),
    getShopTimeZone(admin, session.shop).catch(() => ""),
  ]);
  const st = recordingState(config);
  // Days, weeks and times are worked out here, in the store's time zone.
  const L = recordingLabels({ timeZone });
  const grouped = groupSessions(rows);
  // The card never takes the page down: if its data can't be read, it's empty.
  const { since, updatedAt, ...concerns } = await concernSummary(session.shop, grouped).catch((err) => {
    console.error("[recordings] concerns summary failed:", err?.message || err);
    return { read: 0, top: [], more: [], pending: 0, run: concernRunState(session.shop) };
  });
  const hasKey = Boolean(config?.anthropicApiKey);
  // New shopper chats are read when the page opens (at most every 30 minutes).
  if (hasKey && concerns.pending > 0) concerns.run = startConcernRead(session.shop, { apiKey: config.anthropicApiKey, auto: true });
  const sessions = grouped
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .map((s) => ({
      sessionId: s.sessionId,
      tester: s.tester,
      page: s.page,
      failed: s.failed,
      day: L.day(s.startedAt),
      week: L.week(s.startedAt),
      time: L.time(s.startedAt),
      turns: s.turns.map((t) => ({ id: t.id, at: L.time(t.createdAt), message: t.message, reply: t.reply, products: t.products || [], extras: t.extras, ok: t.ok })),
    }));
  return {
    recording: { on: st.on, until: st.until ? L.dateTime(st.until) : null, scope: st.scope },
    sessions,
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
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") === "delete_all") {
    const count = await deleteAllRecordings(session.shop);
    await resetConcerns(session.shop);
    return { deleted: count };
  }
  if (form.get("intent") === "delete_session") {
    const count = await deleteRecordingSession(session.shop, form.get("sessionId"));
    await forgetConcernChat(session.shop, form.get("sessionId"));
    return { deleted: count };
  }
  if (form.get("intent") === "refresh_concerns") {
    const config = await getShopConfig(session.shop);
    if (!config?.anthropicApiKey) return { concerns: concernRunState(session.shop) };
    return { concerns: startConcernRead(session.shop, { apiKey: config.anthropicApiKey }) };
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
  .rec-more { padding: 10px 16px 12px; border-top: 1px solid rgba(30,27,51,0.07); }
  .rec-empty { padding: 28px 16px; text-align: center; color: #616161; font-size: 13px; }
  @media (max-width: 760px) {
    .rec-tester { width: 100%; }
    .rec-chat, .rec--week .rec-chat { grid-template-columns: minmax(58px, auto) minmax(0, 1fr) auto; }
    .rec-chat__q { grid-column: 2 / -1; grid-row: 2; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .rec-msg, .rec-msg--ai { max-width: 92%; }
  }
`;

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const PER_GROUP = 25;

function Transcript({ turns }) {
  return (
    <div className="rec-tx">
      {turns.map((t) => (
        <div key={t.id} className="rec-turn">
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

function ChatRow({ s, open, onToggle, onDelete, deleting, withDay }) {
  const n = s.turns.length;
  return (
    <>
      <button type="button" className="rec-chat" aria-expanded={open} onClick={onToggle}>
        <span className="rec-chat__time">{withDay ? `${s.day.label}, ${s.time}` : s.time}</span>
        <span className="rec-chat__who">{s.tester || "Shopper"}</span>
        <span className="rec-chat__q">{s.turns[0]?.message || ""}</span>
        <span className="rec-chat__meta">
          {s.failed > 0 && <Badge tone="critical" size="small">{`${s.failed} failed`}</Badge>}
          <Badge size="small">{plural(n, "message", "messages")}</Badge>
        </span>
      </button>
      {open && (
        <div className="rec-open">
          <div className="rec-open__bar">
            <span>{`${plural(n, "message", "messages")}${s.page ? ` · started on ${s.page}` : ""}`}</span>
            <Button variant="plain" tone="critical" disabled={deleting} onClick={onDelete} accessibilityLabel={`Delete chat from ${s.tester || "shopper"}`}>Delete chat</Button>
          </div>
          <Transcript turns={s.turns} />
        </div>
      )}
    </>
  );
}

function DayGroup({ group, open, onToggle, openChats, toggleChat, onDelete, removing, withDay }) {
  const [showAll, setShowAll] = useState(false);
  const failed = group.sessions.filter((s) => s.failed > 0).length;
  const shown = showAll ? group.sessions : group.sessions.slice(0, PER_GROUP);
  return (
    <>
      <button type="button" className="rec-head" aria-expanded={open} onClick={onToggle}>
        <Icon source={open ? ChevronDownIcon : ChevronRightIcon} tone="subdued" />
        <span className="rec-head__title">{group.label}</span>
        <span className="rec-head__sub">
          {plural(group.sessions.length, "chat", "chats")} · {plural(group.messages, "message", "messages")}
          {failed > 0 && <span className="rec-err">{` · ${failed} with errors`}</span>}
        </span>
      </button>
      {open && (
        <>
          {shown.map((s) => (
            <ChatRow
              key={s.sessionId}
              s={s}
              open={openChats.has(s.sessionId)}
              onToggle={() => toggleChat(s.sessionId)}
              onDelete={() => onDelete(s)}
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

export default function Recordings() {
  const { recording, sessions, concerns } = useLoaderData();
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const rowFetcher = useFetcher();
  const concernFetcher = useFetcher();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [by, setBy] = useState("day");
  const [query, setQuery] = useState("");
  const [tester, setTester] = useState("");
  const [onlyErrors, setOnlyErrors] = useState(false);
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
      a.download = `test-recordings_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch {
      shopify.toast.show("Export failed. Please try again.", { isError: true });
    } finally {
      setExporting(false);
    }
  }, [shopify]);

  const deleting = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "delete_all";
  // One chat at a time; it disappears as soon as Delete is confirmed.
  const removing = rowFetcher.state !== "idle" ? rowFetcher.formData?.get("sessionId") : null;
  const removeChat = (s) => {
    if (!window.confirm(`Delete this chat (${plural(s.turns.length, "message", "messages")})? This can't be undone.`)) return;
    rowFetcher.submit({ intent: "delete_session", sessionId: s.sessionId }, { method: "post" });
  };

  const testers = useMemo(() => [...new Set(sessions.map((s) => s.tester || "Shopper"))].sort(), [sessions]);
  const q = query.trim().toLowerCase();
  const themeIds = useMemo(() => (theme ? new Set(theme.ids) : null), [theme]);
  const filtering = Boolean(q || tester || onlyErrors || themeIds);
  const visible = useMemo(() => sessions.filter((s) =>
    s.sessionId !== removing &&
    (!themeIds || themeIds.has(s.sessionId)) &&
    (!tester || (s.tester || "Shopper") === tester) &&
    (!onlyErrors || s.failed > 0) &&
    (!q || `${s.tester} ${s.page} ${s.turns.map((t) => `${t.message} ${t.reply}`).join(" ")}`.toLowerCase().includes(q)),
  ), [sessions, removing, themeIds, tester, onlyErrors, q]);

  const groups = useMemo(() => {
    const out = [];
    const byKey = new Map();
    for (const s of visible) {
      const g = s[by];
      const id = `${by}:${g.key}`;
      if (!byKey.has(id)) { const grp = { id, label: g.label, sessions: [], messages: 0 }; byKey.set(id, grp); out.push(grp); }
      const grp = byKey.get(id);
      grp.sessions.push(s);
      grp.messages += s.turns.length;
    }
    return out;
  }, [visible, by]);
  useEffect(() => { setFoldedMatches(new Set()); }, [q, tester, onlyErrors, themeIds]);
  const isOpen = (g) => (filtering ? !foldedMatches.has(g.id) : openGroups.has(g.id));
  const totalMessages = visible.reduce((n, s) => n + s.turns.length, 0);
  const folded = by === "day" && !filtering && !showOlder ? groups.slice(RECENT_DAYS) : [];
  const listed = folded.length ? groups.slice(0, RECENT_DAYS) : groups;
  const withErrors = sessions.filter((s) => s.failed > 0).length;

  return (
    <Page>
      <TitleBar title="Test recordings" />
      {/* Static CSS, injected as-is: as a text child React would escape its
          quotes on the server and the page wouldn't hydrate. */}
      <style dangerouslySetInnerHTML={{ __html: SETTINGS_CSS + REC_CSS + CONCERNS_CSS }} />
      <div className={`rec set-links${by === "week" ? " rec--week" : ""}`}>
        <BlockStack gap="400">
          <BrandHeader title="Test recordings" gutter={false} />
          <ShopperConcerns
            concerns={concerns}
            activeId={theme?.id || ""}
            onView={viewTheme}
            onRefresh={() => concernFetcher.submit({ intent: "refresh_concerns" }, { method: "post" })}
            refreshing={concernFetcher.state !== "idle"}
          />
          <div>
            <SectionHead title="Test recordings">
              {`Chats saved while recording is on, kept ${KEEP_DAYS} days. Times are in your store's time zone.`}
            </SectionHead>
            <Card padding="0">
              <Row
                title={<InlineStack gap="200" blockAlign="center"><span>Recording</span>{recording.on ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}</InlineStack>}
                help={recording.on
                  ? `Saving ${recording.scope === "everyone" ? "every chat" : "testers' chats"} until ${recording.until}.`
                  : "Turn it on and share the tester link with your team."}
                control={<Button onClick={() => navigate("/app/api-keys#testing")}>Settings → Testing</Button>}
              />
            </Card>
          </div>

          {sessions.length === 0 ? (
            <Card>
              <div className="rec-empty">
                <Text as="p" variant="headingSm">No recorded chats yet</Text>
                <p style={{ margin: "4px 0 0" }}>Once recording is on, chats from people using the tester link appear here.</p>
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
                {withErrors > 0 && (
                  <button type="button" className="rec-chip" aria-pressed={onlyErrors} onClick={() => setOnlyErrors((v) => !v)}>
                    {`Has errors · ${withErrors}`}
                  </button>
                )}
                <div className="rec-seg" role="group" aria-label="Group by">
                  <button type="button" aria-pressed={by === "day"} onClick={() => setBy("day")}>By day</button>
                  <button type="button" aria-pressed={by === "week"} onClick={() => setBy("week")}>By week</button>
                </div>
              </div>

              <div className="rec-summary">
                <span>{`${plural(visible.length, "chat", "chats")} · ${plural(totalMessages, "message", "messages")}${filtering ? " match" : ""}`}</span>
                <InlineStack gap="200">
                  <Button size="slim" onClick={exportCsv} loading={exporting}>Export CSV</Button>
                  <Button size="slim" variant="tertiary" tone="critical" loading={deleting} onClick={() => { if (window.confirm("Delete all recorded chats? \"Top shopper issues & questions\" starts over too. This can't be undone.")) { setTheme(null); fetcher.submit({ intent: "delete_all" }, { method: "post" }); } }}>Delete all</Button>
                </InlineStack>
              </div>

              {groups.length === 0 ? (
                <Card><div className="rec-empty">No chats match. Try other words, or clear the filters.</div></Card>
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

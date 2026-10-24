// Test recordings: the conversations saved while the store had recording on
// (Settings → Testing). Newest chat first; each opens to its full transcript.
// Kept 30 days; "Delete" clears one chat now, "Delete all" every chat.
import { useCallback, useState } from "react";
import { useLoaderData, useFetcher, Link } from "react-router";
import { Page, Layout, Card, BlockStack, InlineStack, Text, Button, Banner, Badge, EmptyState } from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig } from "../models/ShopConfig.server";
import { listRecordings, deleteAllRecordings, deleteRecordingSession } from "../models/ChatRecording.server";
import { recordingState, groupSessions, KEEP_DAYS } from "../lib/chat-recording.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [config, rows] = await Promise.all([getShopConfig(session.shop), listRecordings(session.shop)]);
  const st = recordingState(config);
  const sessions = groupSessions(rows).map((s) => ({
    ...s,
    startedAt: new Date(s.startedAt).toISOString(),
    lastAt: new Date(s.lastAt).toISOString(),
    turns: s.turns.map((t) => ({ id: t.id, at: new Date(t.createdAt).toISOString(), message: t.message, reply: t.reply, products: t.products || [], extras: t.extras, ok: t.ok })),
  }));
  return { recording: { on: st.on, until: st.until ? st.until.toISOString() : null, scope: st.scope }, sessions, total: rows.length };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") === "delete_all") {
    const count = await deleteAllRecordings(session.shop);
    return { deleted: count };
  }
  if (form.get("intent") === "delete_session") {
    const count = await deleteRecordingSession(session.shop, form.get("sessionId"));
    return { deleted: count };
  }
  return null;
};

const when = (iso) => { try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return iso; } };

function Transcript({ turns }) {
  return (
    <div style={{ display: "grid", gap: 12, paddingTop: 12 }}>
      {turns.map((t) => (
        <div key={t.id} style={{ display: "grid", gap: 6 }}>
          <div style={{ justifySelf: "end", maxWidth: "80%", background: "#1d1d1f", color: "#fff", borderRadius: 14, padding: "8px 12px", fontSize: 13, whiteSpace: "pre-wrap" }}>{t.message}</div>
          <div style={{ justifySelf: "start", maxWidth: "88%", background: t.ok ? "#f5f5f7" : "#fff1f0", border: t.ok ? "none" : "1px solid #ffccc7", borderRadius: 14, padding: "8px 12px", fontSize: 13, whiteSpace: "pre-wrap", color: "#1d1d1f" }}>
            {t.reply}
            {(t.products.length > 0 || t.extras) && (
              <div style={{ marginTop: 6, fontSize: 12, color: "#6e6e73" }}>
                {t.products.length > 0 && <div>Products shown: {t.products.join(" · ")}</div>}
                {t.extras && <div>Also shown: {t.extras}</div>}
              </div>
            )}
          </div>
          <div style={{ fontSize: 11, color: "#8e8e93", justifySelf: "start" }}>{when(t.at)}</div>
        </div>
      ))}
    </div>
  );
}

export default function Recordings() {
  const { recording, sessions } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [open, setOpen] = useState(() => new Set(sessions.slice(0, 1).map((s) => s.sessionId)));
  const [exporting, setExporting] = useState(false);
  const toggle = (id) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
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
  const rowFetcher = useFetcher();
  const removing = rowFetcher.state !== "idle" ? rowFetcher.formData?.get("sessionId") : null;
  const shown = sessions.filter((s) => s.sessionId !== removing);
  const removeChat = (s) => {
    if (!window.confirm(`Delete this chat (${s.turns.length} ${s.turns.length === 1 ? "message" : "messages"})? This can't be undone.`)) return;
    rowFetcher.submit({ intent: "delete_session", sessionId: s.sessionId }, { method: "post" });
  };
  return (
    <Page title="Test recordings" subtitle={`Conversations saved while recording is on · kept ${KEEP_DAYS} days`}>
      <TitleBar title="Test recordings" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone={recording.on ? "info" : undefined}>
              {recording.on
                ? <>Recording {recording.scope === "everyone" ? "every chat" : "testers' chats"} until {when(recording.until)}. Change it in <Link to="/app/api-keys">Settings → Testing</Link>.</>
                : <>Recording is off. Turn it on in <Link to="/app/api-keys">Settings → Testing</Link> and share the tester link with your team.</>}
            </Banner>
            {shown.length === 0 ? (
              <Card>
                <EmptyState heading="No recorded chats yet" image="">
                  <p>Once recording is on, chats from people using the tester link appear here.</p>
                </EmptyState>
              </Card>
            ) : (
              <>
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p" tone="subdued">{shown.length} {shown.length === 1 ? "chat" : "chats"} · {shown.reduce((n, s) => n + s.turns.length, 0)} messages</Text>
                  <InlineStack gap="200">
                    <Button onClick={exportCsv} loading={exporting}>Export CSV</Button>
                    <Button tone="critical" loading={deleting} onClick={() => { if (window.confirm("Delete all recorded chats? This can't be undone.")) fetcher.submit({ intent: "delete_all" }, { method: "post" }); }}>Delete all</Button>
                  </InlineStack>
                </InlineStack>
                {shown.map((s) => (
                  <Card key={s.sessionId}>
                    <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
                    <button type="button" onClick={() => toggle(s.sessionId)} aria-expanded={open.has(s.sessionId)} style={{ all: "unset", cursor: "pointer", display: "block", flex: 1, minWidth: 0 }}>
                      <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
                        <BlockStack gap="050">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="headingSm">{s.tester || "Shopper"}</Text>
                            <Badge>{`${s.turns.length} ${s.turns.length === 1 ? "message" : "messages"}`}</Badge>
                            {s.failed > 0 && <Badge tone="critical">{`${s.failed} failed`}</Badge>}
                          </InlineStack>
                          <Text as="span" variant="bodySm" tone="subdued">{when(s.startedAt)}{s.page ? ` · ${s.page}` : ""} — “{(s.turns[0]?.message || "").slice(0, 80)}”</Text>
                        </BlockStack>
                        <Text as="span" tone="subdued">{open.has(s.sessionId) ? "Hide" : "Show"}</Text>
                      </InlineStack>
                    </button>
                    <Button variant="tertiary" tone="critical" disabled={Boolean(removing)} onClick={() => removeChat(s)} accessibilityLabel={`Delete chat from ${s.tester || "shopper"}`}>Delete</Button>
                    </InlineStack>
                    {open.has(s.sessionId) && <Transcript turns={s.turns} />}
                  </Card>
                ))}
              </>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// Settings → Recording: save conversations to review the assistant's
// answers (off by default; by default only testers — people who open the
// store with the tester link — are recorded), and how long they're kept.
// Below it, the chat guard: Off, Watch only (flags the chats it would have
// ended, changes nothing for the shopper) or On (ends them).
import { useState } from "react";
import { useFetcher, Link } from "react-router";
import { Card, BlockStack, InlineStack, Text, Button, ChoiceList, TextField, Banner, Select } from "@shopify/polaris";
import { KEEP_DAYS_CHOICES } from "../lib/chat-recording.js";
import { STRIKES_TO_END, LOCK_MINUTES } from "../lib/chat-guard.js";

const keepLabel = (d) => (d === 365 ? "1 year" : d === 180 ? "6 months" : d === 90 ? "3 months" : `${d} days`);

export function RecordingCard({ initial, shopDomain }) {
  const fetcher = useFetcher();
  const state = fetcher.data?.recording || initial;
  const [scope, setScope] = useState(initial.scope || "testers");
  const [keepDays, setKeepDays] = useState(String(initial.keepDays || 90));
  const [name, setName] = useState("Team");
  const [copied, setCopied] = useState(false);
  const busy = fetcher.state !== "idle";
  const link = `https://${shopDomain}/?hajirai_tester=${encodeURIComponent((name || "Tester").trim() || "Tester")}`;
  const submit = (on, nextScope = scope, nextDays = keepDays) => {
    const fd = new FormData();
    fd.set("intent", "save_recording");
    fd.set("on", on ? "true" : "false");
    fd.set("scope", nextScope);
    fd.set("keepDays", nextDays);
    fetcher.submit(fd, { method: "post" });
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
  };
  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Recording</Text>
            {state.on && <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#b42318" }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "#ff3b30" }} aria-hidden="true" />Recording</span>}
          </InlineStack>
          <Text as="p" tone="subdued">
            Save conversations to review AVA&apos;s answers under Recordings. Recording stays on until you turn it off.
            Chats are deleted after the time you choose below, and never by hand; a flagged chat stays as long as its flag does.
          </Text>
        </BlockStack>
        <ChoiceList
          title="Who is recorded"
          choices={[
            { label: "Only testers — people who open the store with the tester link", value: "testers" },
            { label: "Everyone — every shopper's chat", value: "everyone" },
          ]}
          selected={[scope]}
          onChange={([v]) => { setScope(v); if (state.on) submit(true, v); }}
        />
        {scope === "everyone" && (
          <Banner tone="warning">
            Recording everyone saves real shoppers&apos; conversations (email addresses and phone numbers are replaced before saving). Make sure your privacy policy covers it.
          </Banner>
        )}
        {scope === "testers" && (
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">Tester link — open the store with it once on each device; it lasts two weeks. Add a name to tell testers apart.</Text>
            <InlineStack gap="200" blockAlign="end" wrap={false}>
              <div style={{ width: 140 }}><TextField label="Tester name" value={name} onChange={setName} autoComplete="off" /></div>
              <div style={{ flex: 1, minWidth: 0 }}><TextField label="Link" labelHidden value={link} readOnly autoComplete="off" /></div>
              <Button onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">To stop being a tester on a device, open the store with ?hajirai_tester=off.</Text>
          </BlockStack>
        )}
        <div style={{ maxWidth: 260 }}>
          <Select
            label="Keep chats for"
            options={KEEP_DAYS_CHOICES.map((d) => ({ label: keepLabel(d), value: String(d) }))}
            value={keepDays}
            onChange={(v) => { setKeepDays(v); submit(state.on, scope, v); }}
            helpText="Older chats are deleted each day. “Top shopper issues & questions” keeps its counts whatever you choose."
          />
        </div>
        <InlineStack gap="300" blockAlign="center">
          {state.on
            ? <Button onClick={() => submit(false)} loading={busy}>Stop recording</Button>
            : <Button variant="primary" onClick={() => submit(true)} loading={busy}>Start recording</Button>}
          <Link to="/app/recordings">View recordings</Link>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

const MODES = [
  { value: "off", label: "Off", help: "Nothing is counted." },
  { value: "watch", label: "Watch only (recommended to start)", help: "Counts in the background and flags the chats it would have ended under Recordings. Shoppers notice nothing. Review those for a week or two before turning it on." },
  { value: "on", label: "On", help: `Ends the chat for ${LOCK_MINUTES} minutes on the ${STRIKES_TO_END}rd counted message, with a warning on the ${STRIKES_TO_END - 1}nd. Signed-in customers are warned, never ended.` },
];

export function ChatGuardCard({ initial }) {
  const fetcher = useFetcher();
  const mode = fetcher.data?.guardMode || initial || "watch";
  const busy = fetcher.state !== "idle";
  const save = (v) => {
    const fd = new FormData();
    fd.set("intent", "save_guard");
    fd.set("mode", v);
    fetcher.submit(fd, { method: "post" });
  };
  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Chat guard</Text>
            {mode === "on" && <span style={{ fontSize: 12, fontWeight: 600, color: "#1f4d39" }}>On</span>}
            {mode === "watch" && <span style={{ fontSize: 12, fontWeight: 600, color: "#7a5412" }}>Watching</span>}
          </InlineStack>
          <Text as="p" tone="subdued">
            Some visitors don&apos;t shop: they claim to be staff or a developer, tell AVA to ignore her rules, try to pull her instructions, or dictate exactly what she outputs. Each costs an AI reply.
            The guard counts those messages — one counts only when a fixed phrase list and a separate AI check both agree, never a button tap, a tester, a question about the AI, an off-topic or rude message, or anything with a real shopping, product or order question in it — and after {STRIKES_TO_END} it ends the chat for {LOCK_MINUTES} minutes.
            The same kind of message again within ten minutes doesn&apos;t count twice. Every chat it counts is flagged under Recordings, with each counted message marked.
          </Text>
        </BlockStack>
        <ChoiceList
          title="Mode"
          choices={MODES.map((m) => ({ label: m.label, value: m.value, helpText: m.help }))}
          selected={[mode]}
          onChange={([v]) => save(v)}
          disabled={busy}
        />
      </BlockStack>
    </Card>
  );
}

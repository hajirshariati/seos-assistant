// Settings → Testing: record conversations while the team tests the
// assistant. Off by default; on for two weeks at a time; by default only
// testers (people who open the store with the tester link) are recorded.
import { useState } from "react";
import { useFetcher, Link } from "react-router";
import { Card, BlockStack, InlineStack, Text, Button, ChoiceList, TextField, Banner } from "@shopify/polaris";

function fmt(d) {
  try { return new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return ""; }
}

export function TestRecordingCard({ initial, shopDomain }) {
  const fetcher = useFetcher();
  const state = fetcher.data?.recording || initial;
  const [scope, setScope] = useState(initial.scope || "testers");
  const [name, setName] = useState("Team");
  const [copied, setCopied] = useState(false);
  const busy = fetcher.state !== "idle";
  const link = `https://${shopDomain}/?hajirai_tester=${encodeURIComponent((name || "Tester").trim() || "Tester")}`;
  const submit = (on, nextScope = scope) => {
    const fd = new FormData();
    fd.set("intent", "save_recording");
    fd.set("on", on ? "true" : "false");
    fd.set("scope", nextScope);
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
            <Text as="h2" variant="headingMd">Test recordings</Text>
            {state.on && <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#b42318" }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "#ff3b30" }} />Recording</span>}
          </InlineStack>
          <Text as="p" tone="subdued">
            Save every conversation while your team tests AVA, to review answers later. Recording turns itself
            off after two weeks, and recordings are deleted after 30 days. People being recorded see a small
            &quot;Test recording on&quot; note in the chat.
          </Text>
        </BlockStack>
        <ChoiceList
          title="Who is recorded"
          choices={[
            { label: "Only testers — people who open the store with the tester link (recommended)", value: "testers" },
            { label: "Everyone — every shopper's chat (only on a store that isn't live)", value: "everyone" },
          ]}
          selected={[scope]}
          onChange={([v]) => { setScope(v); if (state.on) submit(true, v); }}
        />
        {scope === "everyone" && (
          <Banner tone="warning">
            Recording everyone saves real shoppers&apos; conversations. Use it only on a test or password-protected store,
            never on the live site, unless your privacy policy covers it.
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
        <InlineStack gap="300" blockAlign="center">
          {state.on
            ? <Button onClick={() => submit(false)} loading={busy}>Stop recording</Button>
            : <Button variant="primary" onClick={() => submit(true)} loading={busy}>Start recording for 2 weeks</Button>}
          {state.on && state.until && <Text as="span" variant="bodySm" tone="subdued">Recording until {fmt(state.until)}</Text>}
          <Link to="/app/recordings">View recordings</Link>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

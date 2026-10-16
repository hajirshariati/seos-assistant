import { useState } from "react";
import {
  Page, Layout, Card, BlockStack, InlineStack, InlineGrid, Text, Button, TextField, Badge, Tag, Banner, Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

// One conversation per line; turns inside a conversation separated by ">>".
const DEFAULT_CASES = [
  "Hi, can you show me shoes in red good for plantar faciatis ?",
  "i need a good dress shoe for my blue dress, what do you recommend? >> are these dress shoes?",
  "I have bunions and need something cute for a wedding",
  "show me men's sneakers under $100",
  "do you have the Jillian sandal in rose?",
  "I need insoles for flat feet, I stand all day at work",
  "what's your return policy?",
  "comfortable black boots for winter >> do they come in wide?",
  "something for my husband, he has heel pain and walks a lot",
  "which of these is on sale? >> show me sandals on sale",
].join("\n");

const ENGINES = [
  { key: "current", label: "Current bot" },
  { key: "lean", label: "New (Claude decides)" },
];

async function askEngine({ engine, message, history }) {
  const headers = { "Content-Type": "application/json", Accept: "text/event-stream" };
  try {
    if (window.shopify?.idToken) headers.Authorization = `Bearer ${await window.shopify.idToken()}`;
  } catch { /* App Bridge fetch patching may still cover us */ }
  const started = performance.now();
  const res = await fetch("/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ message, history, engine, session_id: `compare-${engine}-${Date.now()}` }),
  });
  const ct = res.headers.get("content-type") || "";
  if (!res.ok || !ct.includes("text/event-stream")) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message || d.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let products = [];
  let done = false;
  while (!done) {
    const { done: end, value } = await reader.read();
    if (end) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data: ")) continue;
      let p;
      try { p = JSON.parse(line.slice(6)); } catch { continue; }
      if (p.type === "text") text += p.text || "";
      else if (p.type === "products" && Array.isArray(p.products)) products = p.products.slice();
      else if (p.type === "error") throw new Error(p.message || "error");
      else if (p.type === "done") { done = true; break; }
    }
  }
  return { text, products, ms: Math.round(performance.now() - started) };
}

function toHistoryEntry(role, content, products = []) {
  return {
    role,
    content,
    ...(role === "assistant" && products.length
      ? { products: products.slice(0, 10).map((p) => ({ handle: p.handle || "", title: p.title || "", url: p.url || "", price_formatted: p.price_formatted || "" })) }
      : {}),
  };
}

export default function Compare() {
  const [cases, setCases] = useState(DEFAULT_CASES);
  const [results, setResults] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [copied, setCopied] = useState(false);

  const run = async () => {
    const convos = cases.split("\n").map((l) => l.trim()).filter(Boolean)
      .map((l) => l.split(">>").map((t) => t.trim()).filter(Boolean));
    setRunning(true);
    setCopied(false);
    const out = convos.map((turns) => ({ turns, byEngine: { current: [], lean: [] } }));
    setResults(out.map((r) => ({ ...r })));
    for (let i = 0; i < convos.length; i++) {
      for (const engine of ENGINES) {
        const history = [];
        for (const message of convos[i]) {
          setProgress(`Conversation ${i + 1}/${convos.length} — ${engine.label}: "${message.slice(0, 50)}"`);
          let entry;
          try {
            const r = await askEngine({ engine: engine.key, message, history: history.slice(-20) });
            entry = { message, ...r };
            history.push(toHistoryEntry("user", message), toHistoryEntry("assistant", r.text, r.products));
          } catch (err) {
            entry = { message, error: String(err?.message || err) };
            history.push(toHistoryEntry("user", message));
          }
          out[i].byEngine[engine.key].push(entry);
          setResults(out.map((r) => ({ ...r, byEngine: { ...r.byEngine } })));
        }
      }
    }
    setProgress("");
    setRunning(false);
  };

  const copy = async () => {
    const plain = results.map((r) => ({
      conversation: r.turns,
      current: r.byEngine.current.map((t) => ({ customer: t.message, reply: t.text, cards: (t.products || []).map((p) => p.title), ms: t.ms, error: t.error })),
      lean: r.byEngine.lean.map((t) => ({ customer: t.message, reply: t.text, cards: (t.products || []).map((p) => p.title), ms: t.ms, error: t.error })),
    }));
    try {
      await navigator.clipboard.writeText(JSON.stringify(plain, null, 2));
      setCopied(true);
    } catch { setCopied(false); }
  };

  return (
    <Page fullWidth>
      <TitleBar title="Compare engines" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Side-by-side test</Text>
              <Text as="p" tone="subdued">
                Each line is one conversation; separate follow-up messages with <code>&gt;&gt;</code>. Every conversation runs
                through the current bot and the new engine (Claude decides, code only checks facts). Test runs don't count
                toward usage or plan limits.
              </Text>
              <TextField label="Conversations" labelHidden value={cases} onChange={setCases} multiline={10} autoComplete="off" />
              <InlineStack gap="200" blockAlign="center">
                <Button variant="primary" onClick={run} loading={running} disabled={running}>Run both</Button>
                <Button onClick={copy} disabled={running || results.length === 0}>Copy results</Button>
                {copied && <Badge tone="success">Copied — paste them to Claude</Badge>}
                {progress && <Text as="span" tone="subdued">{progress}</Text>}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {results.map((r, i) => (
          <Layout.Section key={i}>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">Conversation {i + 1}</Text>
                <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                  {ENGINES.map((engine) => (
                    <BlockStack gap="300" key={engine.key}>
                      <Badge tone={engine.key === "lean" ? "info" : undefined}>{engine.label}</Badge>
                      {(r.byEngine[engine.key] || []).map((t, j) => (
                        <BlockStack gap="150" key={j}>
                          <Text as="p" fontWeight="semibold">Customer: {t.message}</Text>
                          {t.error ? (
                            <Banner tone="critical"><p>{t.error}</p></Banner>
                          ) : (
                            <>
                              <Text as="p">{t.text || "(no reply)"}</Text>
                              {t.products?.length > 0 && (
                                <InlineStack gap="100" wrap>
                                  {t.products.map((p, k) => <Tag key={k}>{`${p.title}${p.price_formatted ? ` · ${p.price_formatted}` : ""}`}</Tag>)}
                                </InlineStack>
                              )}
                              <Text as="p" tone="subdued" variant="bodySm">{(t.ms / 1000).toFixed(1)}s</Text>
                            </>
                          )}
                          {j < (r.byEngine[engine.key] || []).length - 1 && <Divider />}
                        </BlockStack>
                      ))}
                    </BlockStack>
                  ))}
                </InlineGrid>
              </BlockStack>
            </Card>
          </Layout.Section>
        ))}
      </Layout>
    </Page>
  );
}

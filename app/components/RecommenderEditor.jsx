// Plain-table editors for a Smart Recommender (DecisionTree.definition):
//   - the questions the assistant asks, with their answer buttons
//   - "which product for which answers" (resolver.masterIndex)
//   - the product to suggest when nothing matches (resolver.fallback)
// and for the Sync-from-Shopify mapping review. The merchant never edits JSON.

import { useMemo, useState } from "react";
import {
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Select,
  Button,
  Badge,
  Box,
} from "@shopify/polaris";

const PRODUCT_KEYS = new Set(["masterSku", "title", "productHandle"]);
const COLUMN_ORDER = ["gender", "useCase", "condition", "arch", "posted", "metSupport"];
const COLUMN_LABELS = {
  gender: "Who it's for",
  useCase: "Shoe type",
  condition: "Foot condition",
  arch: "Arch",
  posted: "Flat-foot control",
  metSupport: "Ball-of-foot pad",
  overpronation: "Ankles roll in",
};
const PAGE_SIZE = 20;

const humanize = (v) =>
  String(v ?? "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^\w/, (c) => c.toUpperCase());

const slug = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export const columnLabel = (key) => COLUMN_LABELS[key] || humanize(key);

// Answer options per attribute: the question's buttons first, then any other
// value already used in the product table, so nothing in use disappears.
export function answerOptions(definition) {
  const out = {};
  const add = (attr, value, label) => {
    if (value === undefined || value === null || value === "") return;
    const list = (out[attr] ||= []);
    const v = String(value);
    if (!list.some((o) => o.value === v)) list.push({ value: v, label: label || humanize(v) });
  };
  for (const n of definition?.nodes || []) {
    if (n?.type !== "question" || !n.attribute) continue;
    for (const c of n.chips || []) add(n.attribute, c.value, c.label);
  }
  for (const row of definition?.resolver?.masterIndex || []) {
    for (const [k, v] of Object.entries(row || {})) {
      if (PRODUCT_KEYS.has(k) || typeof v === "boolean") continue;
      add(k, v);
    }
  }
  return out;
}

export function tableColumns(masterIndex = []) {
  const keys = new Set();
  for (const row of masterIndex) for (const k of Object.keys(row || {})) if (!PRODUCT_KEYS.has(k)) keys.add(k);
  return [...COLUMN_ORDER.filter((k) => keys.has(k)), ...[...keys].filter((k) => !COLUMN_ORDER.includes(k)).sort()];
}

function isBooleanColumn(masterIndex, key) {
  return masterIndex.some((r) => typeof r?.[key] === "boolean");
}

// ── Questions ────────────────────────────────────────────────────────────
function QuestionsTable({ definition, onChange }) {
  const questions = (definition.nodes || []).filter((n) => n?.type === "question");
  const prompts = definition.attributePrompts || {};
  const [newAnswer, setNewAnswer] = useState({});

  const updateNode = (id, patch) =>
    onChange({ ...definition, nodes: definition.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
  const updatePrompt = (attr, text) =>
    onChange({ ...definition, attributePrompts: { ...prompts, [attr]: text } });

  if (questions.length === 0) {
    return (
      <Text as="p" tone="subdued">
        No fixed questions — AVA asks whatever it needs to pick a row from the product table below.
      </Text>
    );
  }
  return (
    <BlockStack gap="400">
      {questions.map((n, i) => (
        <Box key={n.id} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
          <BlockStack gap="300">
            <InlineStack gap="200" blockAlign="center">
              <Badge>{`Question ${i + 1}`}</Badge>
              <Text as="span" tone="subdued" variant="bodySm">Saves the answer as: {columnLabel(n.attribute)}</Text>
            </InlineStack>
            <TextField
              label="Question"
              value={n.question || ""}
              onChange={(v) => updateNode(n.id, { question: v })}
              autoComplete="off"
            />
            <BlockStack gap="150">
              <Text as="span" variant="bodyMd">Answer buttons</Text>
              {(n.chips || []).map((c, ci) => (
                <InlineStack key={`${c.value}-${ci}`} gap="200" blockAlign="center" wrap={false}>
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Button text"
                      labelHidden
                      value={c.label || ""}
                      onChange={(v) => updateNode(n.id, { chips: n.chips.map((x, xi) => (xi === ci ? { ...x, label: v } : x)) })}
                      autoComplete="off"
                    />
                  </div>
                  <Button
                    variant="plain"
                    tone="critical"
                    onClick={() => updateNode(n.id, { chips: n.chips.filter((_, xi) => xi !== ci) })}
                  >
                    Remove
                  </Button>
                </InlineStack>
              ))}
              <InlineStack gap="200" blockAlign="center" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="New answer"
                    labelHidden
                    placeholder="Add an answer…"
                    value={newAnswer[n.id] || ""}
                    onChange={(v) => setNewAnswer((p) => ({ ...p, [n.id]: v }))}
                    autoComplete="off"
                  />
                </div>
                <Button
                  disabled={!slug(newAnswer[n.id])}
                  onClick={() => {
                    const label = newAnswer[n.id].trim();
                    updateNode(n.id, { chips: [...(n.chips || []), { label, value: slug(label) }] });
                    setNewAnswer((p) => ({ ...p, [n.id]: "" }));
                  }}
                >
                  Add
                </Button>
              </InlineStack>
            </BlockStack>
            {prompts[n.attribute] !== undefined && (
              <TextField
                label="How AVA should ask (and what counts as each answer)"
                helpText="Read by the AI, not shown to customers. Use it for tips like “cleats means any field-sport shoe”."
                value={prompts[n.attribute] || ""}
                onChange={(v) => updatePrompt(n.attribute, v)}
                multiline={3}
                autoComplete="off"
              />
            )}
          </BlockStack>
        </Box>
      ))}
    </BlockStack>
  );
}

// ── Which product for which answers ──────────────────────────────────────
function ProductTable({ definition, onChange }) {
  const rawIndex = definition.resolver?.masterIndex;
  const masterIndex = useMemo(() => rawIndex || [], [rawIndex]);
  const columns = useMemo(() => tableColumns(masterIndex), [masterIndex]);
  const options = useMemo(() => answerOptions(definition), [definition]);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);

  const setIndex = (next) => onChange({ ...definition, resolver: { ...(definition.resolver || {}), masterIndex: next } });
  const updateRow = (i, patch) => {
    const row = { ...masterIndex[i], ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete row[k];
    setIndex(masterIndex.map((r, ri) => (ri === i ? row : r)));
  };

  const q = filter.trim().toLowerCase();
  const visible = masterIndex
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => !q || Object.values(row).some((v) => String(v).toLowerCase().includes(q)));
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const slice = visible.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);

  const cell = (row, i, key) => {
    if (isBooleanColumn(masterIndex, key)) {
      const v = row[key] === true ? "yes" : row[key] === false ? "no" : "";
      return (
        <Select
          label={columnLabel(key)}
          labelHidden
          options={[{ label: "Any", value: "" }, { label: "Yes", value: "yes" }, { label: "No", value: "no" }]}
          value={v}
          onChange={(nv) => updateRow(i, { [key]: nv === "" ? undefined : nv === "yes" })}
        />
      );
    }
    const opts = options[key] || [];
    if (opts.length > 0) {
      return (
        <Select
          label={columnLabel(key)}
          labelHidden
          options={[{ label: "Any", value: "" }, ...opts]}
          value={row[key] == null ? "" : String(row[key])}
          onChange={(nv) => updateRow(i, { [key]: nv === "" ? undefined : nv })}
        />
      );
    }
    return (
      <TextField
        label={columnLabel(key)}
        labelHidden
        value={row[key] == null ? "" : String(row[key])}
        onChange={(nv) => updateRow(i, { [key]: nv === "" ? undefined : nv })}
        autoComplete="off"
      />
    );
  };

  const th = { textAlign: "left", padding: "8px", fontSize: 12, fontWeight: 600, color: "#616161", whiteSpace: "nowrap", borderBottom: "1px solid #e1e3e5" };
  const td = { padding: "6px 8px", verticalAlign: "top", borderBottom: "1px solid #f1f1f1", minWidth: 130 };

  return (
    <BlockStack gap="300">
      <InlineStack gap="300" blockAlign="end" wrap>
        <div style={{ flex: 1, minWidth: 220 }}>
          <TextField
            label="Find a row"
            labelHidden
            placeholder="Search by product, SKU or answer…"
            value={filter}
            onChange={(v) => { setFilter(v); setPage(0); }}
            clearButton
            onClearButtonClick={() => setFilter("")}
            autoComplete="off"
          />
        </div>
        <Button
          onClick={() => {
            setIndex([...masterIndex, { masterSku: "", title: "" }]);
            setFilter("");
            setPage(Math.floor(masterIndex.length / PAGE_SIZE));
          }}
        >
          + Add product row
        </Button>
      </InlineStack>
      <div style={{ overflowX: "auto", border: "1px solid #e1e3e5", borderRadius: 8 }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={th}>Product</th>
              {columns.map((k) => <th key={k} style={th}>{columnLabel(k)}</th>)}
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {slice.map(({ row, i }) => (
              <tr key={i}>
                <td style={{ ...td, minWidth: 260 }}>
                  <BlockStack gap="100">
                    <TextField label="Product name" labelHidden placeholder="Product name" value={row.title || ""} onChange={(v) => updateRow(i, { title: v })} autoComplete="off" />
                    <TextField label="SKU" labelHidden placeholder="SKU (e.g. L1800U)" value={row.masterSku || ""} onChange={(v) => updateRow(i, { masterSku: v })} autoComplete="off" />
                  </BlockStack>
                </td>
                {columns.map((k) => <td key={k} style={td}>{cell(row, i, k)}</td>)}
                <td style={{ ...td, minWidth: 0 }}>
                  <Button variant="plain" tone="critical" onClick={() => setIndex(masterIndex.filter((_, ri) => ri !== i))}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
            {slice.length === 0 && (
              <tr><td style={td} colSpan={columns.length + 2}><Text as="span" tone="subdued">No rows match.</Text></td></tr>
            )}
          </tbody>
        </table>
      </div>
      <InlineStack align="space-between" blockAlign="center">
        <Text as="span" tone="subdued" variant="bodySm">
          {visible.length} of {masterIndex.length} rows · “Any” means the row fits every answer to that question.
        </Text>
        {pages > 1 && (
          <InlineStack gap="200" blockAlign="center">
            <Button size="slim" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</Button>
            <Text as="span" variant="bodySm">Page {current + 1} of {pages}</Text>
            <Button size="slim" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</Button>
          </InlineStack>
        )}
      </InlineStack>
    </BlockStack>
  );
}

function FallbackFields({ definition, onChange }) {
  const fb = definition.resolver?.fallback || {};
  const set = (patch) => onChange({ ...definition, resolver: { ...(definition.resolver || {}), fallback: { ...fb, ...patch } } });
  return (
    <InlineStack gap="300" wrap>
      <div style={{ flex: 2, minWidth: 220 }}>
        <TextField label="Product name" value={fb.title || ""} onChange={(v) => set({ title: v })} autoComplete="off" />
      </div>
      <div style={{ flex: 1, minWidth: 140 }}>
        <TextField label="SKU" value={fb.masterSku || ""} onChange={(v) => set({ masterSku: v })} autoComplete="off" />
      </div>
    </InlineStack>
  );
}

export function RecommenderTables({ definition, onChange }) {
  return (
    <BlockStack gap="600">
      <BlockStack gap="300">
        <BlockStack gap="100">
          <Text as="h4" variant="headingSm">Questions AVA asks</Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Customers can tap an answer or just type it — questions they already answered are skipped.
          </Text>
        </BlockStack>
        <QuestionsTable definition={definition} onChange={onChange} />
      </BlockStack>
      <BlockStack gap="300">
        <BlockStack gap="100">
          <Text as="h4" variant="headingSm">Which product for which answers</Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Each row is one product and the answers it's right for. AVA recommends the row that matches the customer's answers.
          </Text>
        </BlockStack>
        <ProductTable definition={definition} onChange={onChange} />
      </BlockStack>
      <BlockStack gap="300">
        <BlockStack gap="100">
          <Text as="h4" variant="headingSm">If nothing matches, suggest</Text>
        </BlockStack>
        <FallbackFields definition={definition} onChange={onChange} />
      </BlockStack>
    </BlockStack>
  );
}

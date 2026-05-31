import { useState } from "react";
import { useLoaderData, useFetcher, Link } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  InlineGrid,
  Box,
  Button,
  Icon,
  Badge,
  Banner,
  Divider,
} from "@shopify/polaris";
import { CheckCircleIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, getKnowledgeFiles, updateShopConfig } from "../models/ShopConfig.server";
import { getCatalogSyncState, syncCatalogAsync } from "../models/Product.server";
import { countEnrichmentsByShop } from "../models/ProductEnrichment.server";
import { getUsageSummary } from "../models/ChatUsage.server";
import { getFeedbackSummary } from "../models/ChatFeedback.server";
import { getConversionSummary } from "../models/ChatConversion.server";
import { listDecisionTrees } from "../models/DecisionTree.server";
import seosLogo from "../assets/SEoS.png";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const [config, files, syncState, enrichmentCount, usage, feedback, conversions, decisionTrees] = await Promise.all([
    getShopConfig(session.shop),
    getKnowledgeFiles(session.shop),
    getCatalogSyncState(session.shop),
    countEnrichmentsByShop(session.shop),
    getUsageSummary(session.shop, 30),
    getFeedbackSummary(session.shop, 30),
    getConversionSummary(session.shop, 30),
    listDecisionTrees(session.shop).catch(() => []),
  ]);

  if (!syncState.lastSyncedAt && syncState.status !== "running") {
    syncCatalogAsync(admin, session.shop);
  }

  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const rateLimitHits = config.rateLimitHitsMonth === currentMonth ? (config.rateLimitHits || 0) : 0;

  // The chat widget pings /widget-config on every storefront page load when
  // the app embed is enabled. If we've heard from it in the last 7 days, the
  // embed is currently active in the merchant's theme. 7 days tolerates a
  // store with very low traffic without flipping back to "undone" the moment
  // a quiet weekend passes.
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const widgetEnabled =
    Boolean(config.lastWidgetSeenAt) &&
    Date.now() - new Date(config.lastWidgetSeenAt).getTime() < SEVEN_DAYS;

  // Catalog freshness: anything older than 7 days suggests the
  // merchant changed inventory but the sync didn't run. Surfaces in
  // the home banner status cluster as 'Stale' to prompt a manual
  // sync from Catalog → Refresh.
  const lastSyncedAt = syncState.lastSyncedAt
    ? new Date(syncState.lastSyncedAt).toISOString()
    : null;
  const hoursSinceSync = lastSyncedAt
    ? Math.round((Date.now() - new Date(lastSyncedAt).getTime()) / 3_600_000)
    : null;

  // Recommender status: master toggle ON + at least one enabled
  // recommender row. The toggle alone isn't enough — a shop with
  // no enabled trees yet should show 'Off' on the cluster.
  const enabledRecommenderCount = (decisionTrees || []).filter((t) => t?.enabled).length;
  const recommenderActive =
    config.decisionTreeEnabled === true && enabledRecommenderCount > 0;

  return {
    hasApiKey: config.anthropicApiKey !== "",
    fileCount: files.length,
    shop: session.shop,
    themeEditorUrl: `https://${session.shop}/admin/themes/current/editor?context=apps`,
    widgetEnabled,
    productsCount: syncState.productsCount || 0,
    enrichmentCount,
    totalCost: usage.totalCost,
    totalMessages: usage.totalMessages,
    avgCostPerMessage: usage.avgCostPerMessage,
    feedbackTotal: feedback.total,
    satisfactionRate: feedback.satisfactionRate,
    conversionCount: conversions.count,
    conversionRevenue: conversions.revenue,
    conversionCurrency: conversions.currency,
    modelStrategy: config.modelStrategy || "smart",
    rateLimitHits,
    semanticEnabled: !!(config.embeddingProvider && (
      (config.embeddingProvider === "voyage" && config.voyageApiKey) ||
      (config.embeddingProvider === "openai" && config.openaiApiKey)
    )),
    semanticProvider: config.embeddingProvider || "",
    categoryGroupsCount: (() => {
      try { return (JSON.parse(config.categoryGroups || "[]") || []).length; } catch { return 0; }
    })(),
    // Status-cluster fields
    catalogSyncStatus: syncState.status || "idle",
    lastSyncedAt,
    hoursSinceSync,
    recommenderActive,
    enabledRecommenderCount,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("intent") === "dismiss_rate_limit") {
    await updateShopConfig(session.shop, { rateLimitHits: 0, rateLimitHitsMonth: "" });
    return { dismissed: true };
  }
  return null;
};

function StepCircle({ done, number }) {
  if (done) {
    return (
      <div style={{ width: "28px", height: "28px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#2D6B4F" }}>
        <Icon source={CheckCircleIcon} tone="success" />
      </div>
    );
  }
  return (
    <div style={{
      width: "28px", height: "28px", flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      borderRadius: "50%", background: "var(--p-color-bg-surface-secondary)",
      border: "1px solid var(--p-color-border)",
    }}>
      <Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">
        {number}
      </Text>
    </div>
  );
}

// Wraps the five-step setup list. When everything's done, render a
// compact 'Setup complete' banner instead of stacking five 'Done'
// rows — keeps the home page short for established merchants but
// stays one click away if they want to revisit. Tracks expand
// state in component state; defaults to collapsed when complete,
// expanded when anything's still pending or in 'Action needed'.
function SetupChecklist({
  hasApiKey, widgetEnabled, fileCount, categoryGroupsCount, semanticEnabled,
  semanticProvider, themeEditorUrl,
}) {
  const items = [
    {
      done: hasApiKey,
      number: "1",
      title: "Connect the AI engine",
      description: "Paste your API key to power the AI assistant. Pay-as-you-go — you only pay for what you use.",
      actionLabel: hasApiKey ? "Manage" : "Add key",
      actionUrl: "/app/api-keys",
    },
    {
      done: widgetEnabled,
      number: "2",
      title: "Enable the chat widget",
      description: widgetEnabled
        ? "Your storefront is loading the chat widget. Use the theme editor to adjust appearance and content."
        : "Turn on the SEoS Assistant chat block in your active Shopify theme so customers see it on your storefront.",
      actionLabel: widgetEnabled ? "Customize" : "Open theme editor",
      actionUrl: themeEditorUrl,
      external: true,
    },
    {
      done: fileCount > 0,
      number: "3",
      title: "Upload extra knowledge (optional)",
      description: "FAQs, brand voice, sizing guides, product specs — CSV files with a SKU column are automatically linked to your catalog.",
      actionLabel: fileCount > 0 ? "Manage files" : "Upload",
      actionUrl: "/app/knowledge",
    },
    {
      done: categoryGroupsCount > 0,
      number: "4",
      title: "Define category groups (optional)",
      description: "Group your catalog (e.g. Footwear / Orthotics / Accessories) so the AI never offers irrelevant categories when a customer asks about one of them. Keeps choice buttons sharp and on-topic.",
      actionLabel: categoryGroupsCount > 0 ? `Manage (${categoryGroupsCount})` : "Set up groups",
      actionUrl: "/app/catalog",
    },
    {
      done: semanticEnabled,
      number: "5",
      title: "Enable semantic search (optional)",
      description: "Match products by meaning, not just keywords. Customers asking for \"shoes for standing all day\" find arch-support styles even when descriptions don't contain those words. Bring your own Voyage AI or OpenAI key — typically under $1/month.",
      actionLabel: semanticEnabled ? `Manage (${semanticProvider === "voyage" ? "Voyage AI" : "OpenAI"})` : "Add provider",
      actionUrl: "/app/api-keys",
    },
  ];
  const doneCount = items.filter((i) => i.done).length;
  const allDone = doneCount === items.length;
  const requiredDone = hasApiKey && widgetEnabled;
  // Default collapsed once all done; expanded if anything's pending
  // OR the required steps aren't met yet.
  const [expanded, setExpanded] = useState(!allDone);

  if (allDone && !expanded) {
    return (
      <Card>
        <InlineStack align="space-between" blockAlign="center" wrap>
          <InlineStack gap="300" blockAlign="center" wrap={false}>
            <div style={{ width: 28, height: 28, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#108043" }}>
              <Icon source={CheckCircleIcon} tone="success" />
            </div>
            <BlockStack gap="050">
              <Text as="h2" variant="headingMd">Setup complete</Text>
              <Text as="span" tone="subdued" variant="bodySm">
                All 5 steps done. Your assistant is fully configured.
              </Text>
            </BlockStack>
          </InlineStack>
          <Button variant="plain" onClick={() => setExpanded(true)}>
            View checklist
          </Button>
        </InlineStack>
      </Card>
    );
  }

  return (
    <BlockStack gap="300">
      <InlineStack gap="300" blockAlign="center" align="space-between" wrap>
        <InlineStack gap="300" blockAlign="center">
          <Text as="h2" variant="headingMd">Setup checklist</Text>
          {allDone ? (
            <Badge tone="success">Complete</Badge>
          ) : requiredDone ? (
            <Badge tone="success">Ready</Badge>
          ) : (
            <Badge tone="attention">Action needed</Badge>
          )}
          <Text as="span" tone="subdued" variant="bodySm">
            {doneCount} of {items.length} done
          </Text>
        </InlineStack>
        {allDone && (
          <Button variant="plain" onClick={() => setExpanded(false)}>
            Collapse
          </Button>
        )}
      </InlineStack>
      <BlockStack gap="300">
        {items.map((item) => (
          <ChecklistItem
            key={item.number}
            done={item.done}
            number={item.number}
            title={item.title}
            description={item.description}
            actionLabel={item.actionLabel}
            actionUrl={item.actionUrl}
            external={item.external}
          />
        ))}
      </BlockStack>
    </BlockStack>
  );
}

function ChecklistItem({ done, number, title, description, actionLabel, actionUrl, external }) {
  return (
    <Box
      background={done ? "bg-surface-success-subdued" : "bg-surface"}
      borderRadius="300"
      borderWidth="025"
      borderColor={done ? "border-success-subdued" : "border"}
      padding="400"
    >
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <StepCircle done={done} number={number} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingSm">{title}</Text>
              {done && <Badge tone="success">Done</Badge>}
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">{description}</Text>
          </BlockStack>
        </div>
        <div style={{ flexShrink: 0 }}>
          <Button url={actionUrl} external={external} variant={done ? "plain" : "primary"}>
            {actionLabel}
          </Button>
        </div>
      </div>
    </Box>
  );
}

function FeatureCard({ icon, title, description, stat }) {
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="300" blockAlign="center">
          <div style={{
            width: "36px", height: "36px", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            borderRadius: "10px", background: "rgba(45,107,79,0.1)",
            fontSize: "18px",
          }}>
            {icon}
          </div>
          <Text as="h3" variant="headingSm">{title}</Text>
        </InlineStack>
        <Text as="p" tone="subdued" variant="bodySm">{description}</Text>
        {stat && (
          <Box paddingBlockStart="100">
            <Badge tone="info">{stat}</Badge>
          </Box>
        )}
      </BlockStack>
    </Card>
  );
}

function formatCost(n) {
  if (!n) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatRevenue(n, currency) {
  const code = (currency && String(currency).trim()) || "USD";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      maximumFractionDigits: n >= 1000 ? 0 : 2,
    }).format(n || 0);
  } catch {
    return `${code} ${(n || 0).toFixed(2)}`;
  }
}

// HeroStatusCluster — gauge-cluster pattern rendered INSIDE the green
// hero banner. Every system is always present, but healthy / off
// states are nearly invisible (low-opacity dot, faded label) so the
// hero reads as a clean banner at a glance. Only WARNING and CRITICAL
// pips light up — coloured dot, halo glow, bright label — pulling the
// eye exactly where action is needed. Click any pip to jump to the
// page that manages it. This replaces the separate "System status"
// card that used to live below the hero (now removed as a duplicate).
function HeroStatusCluster({ items }) {
  const TONE = {
    // Healthy / off — barely visible against the green hero.
    success:  { dot: "rgba(255,255,255,0.65)", label: "rgba(255,255,255,0.7)",  glow: "none" },
    subdued:  { dot: "rgba(255,255,255,0.35)", label: "rgba(255,255,255,0.5)",  glow: "none" },
    // Attention — glow.
    warning:  { dot: "#FFC453",                label: "rgba(255,255,255,0.98)", glow: "0 0 0 3px rgba(255,196,83,0.30), 0 0 10px rgba(255,196,83,0.55)" },
    critical: { dot: "#FF7866",                label: "rgba(255,255,255,1.00)", glow: "0 0 0 3px rgba(255,120,102,0.40), 0 0 12px rgba(255,120,102,0.7)"  },
  };
  return (
    <div
      role="group"
      aria-label="System status"
      style={{
        // Single-line bar that wraps gracefully only on very narrow
        // viewports. Tight spacing keeps all six pips on one row at
        // typical admin widths.
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "2px 4px",
        paddingTop: 4,
      }}
    >
      {items.map((it, i) => {
        const t = TONE[it.tone] || TONE.subdued;
        const isAttention = it.tone === "warning" || it.tone === "critical";
        const content = (
          <span
            onMouseEnter={(e) => {
              if (!it.url) return;
              e.currentTarget.style.background = "rgba(255,255,255,0.14)";
              const lbl = e.currentTarget.querySelector("[data-label]");
              if (lbl) lbl.style.color = "rgba(255,255,255,1)";
            }}
            onMouseLeave={(e) => {
              if (!it.url) return;
              e.currentTarget.style.background = "transparent";
              const lbl = e.currentTarget.querySelector("[data-label]");
              if (lbl) lbl.style.color = t.label;
            }}
            style={{
              // No persistent surface — looks like a clean indicator
              // at rest, gains a subtle pill background only on hover
              // to signal interactivity.
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 8px",
              borderRadius: 999,
              background: "transparent",
              transition: "background 0.15s ease, color 0.15s ease",
              cursor: it.url ? "pointer" : "default",
              userSelect: "none",
              lineHeight: 1,
            }}
            title={`${it.label}: ${it.value}${it.tooltip ? " — " + it.tooltip : ""}`}
          >
            <span
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: t.dot,
                boxShadow: t.glow,
                flexShrink: 0,
                animation: it.tone === "critical" ? "seos-pulse 1.6s ease-in-out infinite" : "none",
              }}
            />
            <span
              data-label
              style={{
                color: t.label,
                fontSize: 10.5,
                fontWeight: isAttention ? 600 : 500,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                whiteSpace: "nowrap",
                transition: "color 0.15s ease",
              }}
            >
              {it.label}
              {isAttention ? ` · ${it.value}` : ""}
            </span>
          </span>
        );
        // Thin vertical separator between pips so they read as one
        // continuous status bar rather than disconnected chips. No
        // separator after the last pip.
        const sep = i < items.length - 1 ? (
          <span
            aria-hidden="true"
            style={{
              width: 1,
              height: 10,
              background: "rgba(255,255,255,0.18)",
              flexShrink: 0,
            }}
          />
        ) : null;
        if (!it.url) {
          return (
            <span key={it.label} style={{ display: "inline-flex", alignItems: "center" }}>
              {content}
              {sep}
            </span>
          );
        }
        if (it.external) {
          return (
            <span key={it.label} style={{ display: "inline-flex", alignItems: "center" }}>
              <a
                href={it.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ textDecoration: "none", display: "inline-flex" }}
              >
                {content}
              </a>
              {sep}
            </span>
          );
        }
        return (
          <span key={it.label} style={{ display: "inline-flex", alignItems: "center" }}>
            <Link to={it.url} style={{ textDecoration: "none", display: "inline-flex" }}>
              {content}
            </Link>
            {sep}
          </span>
        );
      })}
    </div>
  );
}

// Retained for backward-compat — the old StatusPanel section below the
// hero is no longer rendered (the gauge cluster inside the hero is
// the new at-a-glance view). Kept as a no-op so any import elsewhere
// doesn't break; if nothing imports it, it's dead code we can prune
// later.
function StatusPanel({ items }) {
  // "Check-engine light" pattern: tiles stay visually quiet when
  // everything is healthy (small grey dot, minimal accent) so the
  // dashboard reads calmly at a glance. Only WARNING and CRITICAL
  // tiles light up — coloured left border, coloured chip, subtle glow
  // on the dot — drawing the eye exactly where action is needed.
  // SUBDUED (a feature that's simply off) shares the quiet treatment.
  const TONE = {
    // Quiet states — barely there. Healthy is the default; subdued is
    // for optional features the merchant hasn't enabled.
    success:  { dot: "#8C9196", border: "#E1E3E5", chipBg: "transparent", chipFg: "#5C5F62", glow: false },
    subdued:  { dot: "#C9CCCF", border: "#E1E3E5", chipBg: "transparent", chipFg: "#8C9196", glow: false },
    // Attention states — these glow.
    warning:  { dot: "#B85C00", border: "#FFC453", chipBg: "#FFF3D6", chipFg: "#7A4100", glow: true },
    critical: { dot: "#D72C0D", border: "#D72C0D", chipBg: "#FFEAE5", chipFg: "#8C1F11", glow: true },
  };
  const attentionCount = items.filter((it) => it.tone === "critical" || it.tone === "warning").length;
  const allHealthy = attentionCount === 0;
  return (
    <Card padding="0">
      <Box padding="400" borderBlockEndWidth="025" borderColor="border">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">System status</Text>
            {!allHealthy && (
              <Badge tone={items.some((it) => it.tone === "critical") ? "critical" : "warning"}>
                {`${attentionCount} item${attentionCount > 1 ? "s" : ""} need${attentionCount > 1 ? "" : "s"} attention`}
              </Badge>
            )}
          </InlineStack>
          {allHealthy ? (
            <Text as="span" variant="bodySm" tone="subdued">
              All clear · click any tile to manage
            </Text>
          ) : (
            <Text as="span" variant="bodySm" tone="subdued">
              Click any tile to manage.
            </Text>
          )}
        </InlineStack>
      </Box>
      <Box padding="400">
        <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="300">
          {items.map((it) => {
            const t = TONE[it.tone] || TONE.subdued;
            const isAttention = it.tone === "warning" || it.tone === "critical";
            const inner = (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  padding: "14px 16px",
                  borderRadius: 12,
                  background: "var(--p-color-bg-surface)",
                  border: "1px solid var(--p-color-border)",
                  borderLeft: `4px solid ${t.border}`,
                  cursor: it.url ? "pointer" : "default",
                  transition: "transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease",
                  height: "100%",
                  minHeight: 78,
                  // Attention tiles get a soft outer glow ring so they
                  // pull the eye without screaming. Quiet tiles stay
                  // flat — the check-engine-light pattern.
                  boxShadow: isAttention ? `0 0 0 1px ${t.border}33, 0 0 12px ${t.dot}1f` : "none",
                }}
                onMouseEnter={(e) => {
                  if (!it.url) return;
                  e.currentTarget.style.background = "var(--p-color-bg-surface-secondary)";
                  e.currentTarget.style.boxShadow = isAttention
                    ? `0 0 0 1px ${t.border}55, 0 0 14px ${t.dot}33`
                    : "0 2px 6px rgba(0,0,0,0.06)";
                }}
                onMouseLeave={(e) => {
                  if (!it.url) return;
                  e.currentTarget.style.background = "var(--p-color-bg-surface)";
                  e.currentTarget.style.boxShadow = isAttention
                    ? `0 0 0 1px ${t.border}33, 0 0 12px ${t.dot}1f`
                    : "none";
                }}
                title={it.tooltip || ""}
              >
                <InlineStack gap="200" blockAlign="center" wrap={false}>
                  <span
                    style={{
                      width: 10, height: 10, borderRadius: "50%",
                      background: t.dot, flexShrink: 0,
                      // Only attention tiles get the halo (the "glow").
                      boxShadow: t.glow ? `0 0 0 3px ${t.dot}33` : "none",
                    }}
                    aria-hidden="true"
                  />
                  <Text as="span" variant="bodySm" tone="subdued" fontWeight="semibold">
                    {it.label.toUpperCase()}
                  </Text>
                </InlineStack>
                <div
                  style={{
                    display: "inline-flex",
                    alignSelf: "flex-start",
                    padding: t.chipBg === "transparent" ? "0" : "3px 10px",
                    borderRadius: t.chipBg === "transparent" ? "0" : 999,
                    background: t.chipBg,
                    color: t.chipFg,
                    fontSize: 13,
                    fontWeight: t.chipBg === "transparent" ? 500 : 600,
                    lineHeight: 1.3,
                  }}
                >
                  {it.value}
                </div>
              </div>
            );
            if (!it.url) return <div key={it.label}>{inner}</div>;
            // External URLs need target=_blank to escape the iframe;
            // internal admin paths must use react-router Link to keep
            // the App Bridge session token alive (raw <a> drops it
            // and bounces to the 'Install from a Shopify-owned
            // surface' fallback).
            if (it.external) {
              return (
                <a
                  key={it.label}
                  href={it.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  {inner}
                </a>
              );
            }
            return (
              <Link
                key={it.label}
                to={it.url}
                style={{ textDecoration: "none", color: "inherit" }}
              >
                {inner}
              </Link>
            );
          })}
        </InlineGrid>
      </Box>
    </Card>
  );
}

function MetricTile({ label, value, sublabel }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" tone="subdued" variant="bodySm">{label}</Text>
        <Text as="p" variant="heading2xl">{value}</Text>
        {sublabel ? <Text as="p" tone="subdued" variant="bodySm">{sublabel}</Text> : null}
      </BlockStack>
    </Card>
  );
}

export default function Home() {
  const {
    hasApiKey, fileCount, shop, themeEditorUrl, widgetEnabled,
    productsCount, enrichmentCount, totalCost, totalMessages, avgCostPerMessage,
    feedbackTotal, satisfactionRate, modelStrategy, rateLimitHits,
    semanticEnabled, semanticProvider, categoryGroupsCount,
    conversionCount, conversionRevenue, conversionCurrency,
    catalogSyncStatus, lastSyncedAt, hoursSinceSync,
    recommenderActive, enabledRecommenderCount,
  } = useLoaderData();

  // Build the status-cluster items shown in the hero banner. Each
  // item has tone (success/warning/critical/subdued), short value
  // text, optional tooltip, and a click target (URL). Order is from
  // most-likely-to-need-attention down to nice-to-have.
  const statusItems = (() => {
    const items = [];
    items.push(
      hasApiKey
        ? { label: "AI", value: "Connected", tone: "success", url: "/app/api-keys", tooltip: "Anthropic API key configured." }
        : { label: "AI", value: "Missing key", tone: "critical", url: "/app/api-keys", tooltip: "Add your Anthropic API key to enable the chat." }
    );
    items.push(
      widgetEnabled
        ? { label: "Widget", value: "Live", tone: "success", url: themeEditorUrl, external: true, tooltip: "Storefront chat widget is loading on your theme." }
        : { label: "Widget", value: "Not enabled", tone: "warning", url: themeEditorUrl, external: true, tooltip: "Enable the SEoS Assistant block in your active theme." }
    );
    if (catalogSyncStatus === "running") {
      items.push({ label: "Catalog", value: "Syncing…", tone: "warning", url: "/app/catalog", tooltip: "Catalog sync currently in progress." });
    } else if (productsCount === 0) {
      items.push({ label: "Catalog", value: "Not synced", tone: "critical", url: "/app/catalog", tooltip: "No products synced yet. Run a manual sync." });
    } else if (hoursSinceSync !== null && hoursSinceSync > 168) {
      items.push({ label: "Catalog", value: `Stale (${Math.round(hoursSinceSync / 24)}d)`, tone: "warning", url: "/app/catalog", tooltip: `Last sync ${Math.round(hoursSinceSync / 24)} days ago. Run a refresh from the Catalog page.` });
    } else {
      items.push({ label: "Catalog", value: `${productsCount} synced`, tone: "success", url: "/app/catalog", tooltip: lastSyncedAt ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}` : "Synced." });
    }
    items.push(
      semanticEnabled
        ? { label: "Semantic", value: semanticProvider === "voyage" ? "Voyage AI" : "OpenAI", tone: "success", url: "/app/api-keys", tooltip: "Semantic search active. Customers find products by meaning, not just keywords." }
        : { label: "Semantic", value: "Off", tone: "subdued", url: "/app/api-keys", tooltip: "Optional. Add a Voyage AI or OpenAI key to enable meaning-based product matching." }
    );
    items.push(
      recommenderActive
        ? { label: "Recommenders", value: `${enabledRecommenderCount} active`, tone: "success", url: "/app/recommenders", tooltip: "Smart Recommender flow is live for at least one intent." }
        : { label: "Recommenders", value: "Off", tone: "subdued", url: "/app/recommenders", tooltip: "Optional. Configure a guided product finder for orthotics, mattresses, etc." }
    );
    items.push(
      fileCount > 0
        ? { label: "Knowledge", value: `${fileCount} file${fileCount > 1 ? "s" : ""}`, tone: "success", url: "/app/knowledge", tooltip: "Custom FAQs / brand info available to the AI." }
        : { label: "Knowledge", value: "None", tone: "subdued", url: "/app/knowledge", tooltip: "Optional. Upload FAQs or product specs the AI can reference." }
    );
    return items;
  })();

  const rateFetcher = useFetcher();
  const rateDismissed = rateFetcher.state !== "idle" || rateFetcher.data?.dismissed;
  const showRateLimit = rateLimitHits > 0 && !rateDismissed;

  return (
    <Page>
      <TitleBar title="SEoS Assistant" />
      {/* Keyframes for the critical-state pulse on hero status pips.
          Inlined once at the page root so they're available wherever
          HeroStatusCluster renders. */}
      <style>{`
        @keyframes seos-pulse {
          0%, 100% { box-shadow: 0 0 0 4px rgba(255,120,102,0.35), 0 0 16px rgba(255,120,102,0.7); }
          50%      { box-shadow: 0 0 0 6px rgba(255,120,102,0.20), 0 0 22px rgba(255,120,102,0.85); }
        }
      `}</style>
      <BlockStack gap="600">
        <div style={{
          background: "linear-gradient(135deg, #2D6B4F 0%, #3a8a66 100%)",
          borderRadius: "12px", padding: "24px 28px", marginTop: "-8px",
        }}>
          <InlineStack align="start" blockAlign="center" wrap gap="500">
            <div style={{ flex: "1 1 320px", minWidth: 0 }}>
              <BlockStack gap="200">
                <Text as="h1" variant="headingXl">
                  <span style={{ color: "#fff" }}>SEoS Assistant</span>
                </Text>
                <Text as="p" variant="bodyMd">
                  <span style={{ color: "rgba(255,255,255,0.85)" }}>Search Engine on Steroids</span>
                </Text>
                {(totalMessages > 0 || showRateLimit) && (
                  <Box paddingBlockStart="100">
                    <InlineStack align="start" gap="200" wrap>
                      {totalMessages > 0 && (
                        <Badge tone="info">{totalMessages} AI requests · last 30 days</Badge>
                      )}
                      {showRateLimit && (
                        <Badge tone={rateLimitHits >= 10 ? "critical" : "attention"}>
                          {rateLimitHits} rate-limited {rateLimitHits === 1 ? "request" : "requests"}
                        </Badge>
                      )}
                    </InlineStack>
                  </Box>
                )}
                <Box paddingBlockStart="300">
                  <HeroStatusCluster items={statusItems} />
                </Box>
              </BlockStack>
            </div>
            <div style={{ flex: "0 0 auto", marginLeft: "auto", display: "flex", alignItems: "center" }}>
              <img
                src={seosLogo}
                alt="SEoS"
                style={{ display: "block", maxWidth: "180px", maxHeight: "140px", width: "auto", height: "auto" }}
              />
            </div>
          </InlineStack>
        </div>

        {/* System status now lives inside the hero as a gauge cluster
            (HeroStatusCluster) — semi-invisible when healthy, glows on
            issues. The standalone StatusPanel card was removed as a
            duplicate. */}

        {showRateLimit && (
          <Banner
            title={rateLimitHits >= 10 ? "Customers are being turned away" : "Some customers hit the AI rate limit"}
            tone={rateLimitHits >= 10 ? "critical" : "warning"}
            action={{ content: "Increase limits", url: "https://console.anthropic.com/settings/limits", external: true }}
            secondaryAction={{ content: "Dismiss", onAction: () => rateFetcher.submit({ intent: "dismiss_rate_limit" }, { method: "post" }) }}
            onDismiss={() => rateFetcher.submit({ intent: "dismiss_rate_limit" }, { method: "post" })}
          >
            <Text as="p" variant="bodySm">
              {rateLimitHits} {rateLimitHits === 1 ? "request was" : "requests were"} rate-limited this month.
              {rateLimitHits >= 10
                ? " Your Anthropic API tier is too low for your traffic. Add credits at console.anthropic.com to auto-upgrade."
                : " This happens when many customers chat simultaneously. If this keeps growing, consider upgrading your Anthropic API tier."}
            </Text>
          </Banner>
        )}

        {hasApiKey ? (
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" wrap>
              <Text as="h2" variant="headingMd">Last 30 days</Text>
              <Button url="/app/analytics" variant="plain">View detailed analytics</Button>
            </InlineStack>
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
              <MetricTile
                label="Chat-driven orders"
                value={String(conversionCount || 0)}
                sublabel={conversionCount > 0 ? `Tagged "SEoS" in Shopify` : "Awaiting first chat-attributed order"}
              />
              <MetricTile
                label="Chat-driven revenue"
                value={conversionCount > 0 ? formatRevenue(conversionRevenue, conversionCurrency) : "—"}
                sublabel={conversionCount > 0 ? `${conversionCount} order${conversionCount === 1 ? "" : "s"} attributed to chat` : "Tracked via the SEoS order tag"}
              />
            </InlineGrid>
            <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
              <MetricTile
                label="AI requests"
                value={String(totalMessages)}
                sublabel={totalMessages > 0 ? `Avg ${formatCost(avgCostPerMessage)} / request · last 30 days` : "Awaiting first chat"}
              />
              <MetricTile
                label="Satisfaction"
                value={feedbackTotal > 0 ? `${satisfactionRate}%` : "—"}
                sublabel={feedbackTotal > 0 ? `${feedbackTotal} ratings` : "Awaiting feedback"}
              />
              <MetricTile
                label="AI cost"
                value={formatCost(totalCost)}
                sublabel="Anthropic API spend"
              />
              <MetricTile
                label="Rate-limit hits"
                value={String(rateLimitHits)}
                sublabel={rateLimitHits > 0 ? "Increase your Anthropic tier" : "Within limits"}
              />
            </InlineGrid>
          </BlockStack>
        ) : null}

        <Divider />

        <SetupChecklist
          hasApiKey={hasApiKey}
          widgetEnabled={widgetEnabled}
          fileCount={fileCount}
          categoryGroupsCount={categoryGroupsCount}
          semanticEnabled={semanticEnabled}
          semanticProvider={semanticProvider}
          themeEditorUrl={themeEditorUrl}
        />

        {/* Setup guide quick-link — opens the public /onboarding page
            in a new tab. Rendered as a calm Card (not a second green
            gradient) so the page reads professionally: one hero up
            top, the rest neutral. */}
        <Card>
          <InlineStack align="space-between" blockAlign="center" wrap gap="400">
            <InlineStack gap="300" blockAlign="center" wrap={false}>
              <div
                style={{
                  flexShrink: 0,
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  background: "rgba(45,107,79,0.08)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20,
                }}
                aria-hidden="true"
              >
                {"📘"}
              </div>
              <BlockStack gap="050">
                <Text as="h2" variant="headingMd">Setup guide</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Full walkthrough for installing, configuring, and going live.
                </Text>
              </BlockStack>
            </InlineStack>
            <Button url="/onboarding" external variant="primary">
              Open setup guide
            </Button>
          </InlineStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">About SEoS Assistant</Text>
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
              <BlockStack gap="200">
                <Text as="p" variant="bodySm"><strong>Version:</strong> 1.0.0</Text>
                <Text as="p" variant="bodySm"><strong>AI Engine:</strong> Anthropic Claude</Text>
                <Text as="p" variant="bodySm"><strong>Semantic Search:</strong> {semanticEnabled ? `${semanticProvider === "voyage" ? "Voyage AI" : "OpenAI"} (active)` : "Optional — bring your own key"}</Text>
              </BlockStack>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm"><strong>Attribution:</strong> Chat-driven sales tagged "SEoS" on the order; product links carry utm_content=SEoS so other channel UTMs stay intact.</Text>
                <Text as="p" variant="bodySm"><strong>Privacy:</strong> Feedback data hashed, auto-deleted after 90 days</Text>
                <Text as="p" variant="bodySm"><strong>Billing:</strong> Pay-as-you-go AI usage — no markup</Text>
              </BlockStack>
            </InlineGrid>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

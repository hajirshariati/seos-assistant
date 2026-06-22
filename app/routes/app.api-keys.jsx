import { useLoaderData, useActionData, useNavigation, Form, useFetcher } from "react-router";
import { useState, useRef, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  TextField,
  Select,
  Button,
  Banner,
  Box,
  Text,
  Icon,
  Badge,
  Divider,
  Checkbox,
  Tag,
  FormLayout,
} from "@shopify/polaris";
import { CheckCircleIcon } from "@shopify/polaris-icons";
import { TitleBar, SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, updateShopConfig } from "../models/ShopConfig.server";
import { getShopPlan } from "../lib/billing.server";
import { PlanGate } from "../components/PlanGate";
import BrandHeader from "../components/BrandHeader";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const config = await getShopConfig(session.shop);
  const plan = await getShopPlan(session.shop);
  let hideOnUrls = [];
  try { hideOnUrls = JSON.parse(config.hideOnUrls || "[]"); } catch { hideOnUrls = []; }
  return {
    hasAnthropicKey: config.anthropicApiKey !== "",
    anthropicModel: config.anthropicModel,
    modelStrategy: config.modelStrategy || "smart",
    showFollowUps: config.showFollowUps !== false,
    showFeedback: config.showFeedback !== false,
    hasYotpoKey: config.yotpoApiKey !== "",
    hasAftershipKey: config.aftershipApiKey !== "",
    hideOnUrls,
    welcomeGlowStyle: ["none", "internal", "external"].includes(config.welcomeGlowStyle)
      ? config.welcomeGlowStyle
      : "internal",
    welcomeGlowColors: String(config.welcomeGlowColors || "")
      .split(",")
      .map((c) => c.trim())
      .filter((c) => /^#[0-9a-f]{3,8}$/i.test(c)),
    welcomeGlowBorderWidth: Number.isFinite(config.welcomeGlowBorderWidth) ? config.welcomeGlowBorderWidth : 2,
    welcomeGlowSize:        Number.isFinite(config.welcomeGlowSize)        ? config.welcomeGlowSize        : 18,
    welcomeGlowFadeInMs:    Number.isFinite(config.welcomeGlowFadeInMs)    ? config.welcomeGlowFadeInMs    : 1500,
    welcomeGlowHoldMs:      Number.isFinite(config.welcomeGlowHoldMs)      ? config.welcomeGlowHoldMs      : 4000,
    welcomeGlowFadeOutMs:   Number.isFinite(config.welcomeGlowFadeOutMs)   ? config.welcomeGlowFadeOutMs   : 2000,
    welcomeGlowSpeed:       Number.isFinite(config.welcomeGlowSpeed)       ? config.welcomeGlowSpeed       : 1.0,
    supportUrl: config.supportUrl || "",
    supportLabel: config.supportLabel || "",
    trackingPageUrl: config.trackingPageUrl || "",
    returnsPageUrl: config.returnsPageUrl || "",
    referralPageUrl: config.referralPageUrl || "",
    promptCaching: config.promptCaching === true,
    klaviyoFormId: config.klaviyoFormId || "",
    klaviyoCompanyId: config.klaviyoCompanyId || "",
    klaviyoListId: config.klaviyoListId || "",
    vipModeEnabled: config.vipModeEnabled === true,
    showLoginPill: config.showLoginPill !== false,
    hasKlaviyoPrivateKey: config.klaviyoPrivateKey !== "",
    hasYotpoLoyaltyKey: config.yotpoLoyaltyApiKey !== "",
    yotpoLoyaltyGuid: config.yotpoLoyaltyGuid || "",
    loyaltyDisplay: config.loyaltyDisplay || "points",
    loyaltyPointsPerDollar: config.loyaltyPointsPerDollar ?? 100,
    loyaltyRounding: config.loyaltyRounding || "exact",
    dailyCapEnabled: config.dailyCapEnabled === true,
    dailyCapMessages: config.dailyCapMessages ?? 200,
    embeddingProvider: config.embeddingProvider || "",
    hasVoyageKey: (config.voyageApiKey || "") !== "",
    hasOpenaiKey: (config.openaiApiKey || "") !== "",
    visualizeLookEnabled: config.visualizeLookEnabled === true,
    imageProvider: config.imageProvider || "",
    visualizeLookLabel: config.visualizeLookLabel || "Visualize My Look",
    hasGeminiKey: (config.geminiApiKey || "") !== "",
    knowledgeRagEnabled: config.knowledgeRagEnabled === true,
    plan: { id: plan.id, name: plan.name, features: plan.features },
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  // Intent-based handlers for cards that submit independently via
  // useFetcher (own success/error banners, isolated from the big
  // settings form). Each returns its own response shape.
  const intent = formData.get("intent");
  if (intent === "save_welcome_glow") {
    const style = String(formData.get("welcomeGlowStyle") || "");
    if (!["none", "internal", "external"].includes(style)) {
      return { error: "Invalid welcome glow style." };
    }
    const colors = String(formData.get("welcomeGlowColors") || "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    for (const c of colors) {
      if (!/^#[0-9a-f]{3,8}$/i.test(c)) {
        return { error: `Invalid hex color: ${c}. Use #rgb, #rrggbb, or #rrggbbaa.` };
      }
    }
    if (style !== "none" && colors.length < 2) {
      return { error: "Welcome glow needs at least 2 colors for a gradient." };
    }
    // Parse tuning fields with sensible clamps so a typo can't make the
    // animation unusable (e.g. 0ms hold or 999999ms fade-out).
    const clampInt = (raw, def, min, max) => {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) return def;
      return Math.max(min, Math.min(max, n));
    };
    const clampFloat = (raw, def, min, max) => {
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) return def;
      return Math.max(min, Math.min(max, n));
    };
    const borderWidth = clampInt(formData.get("welcomeGlowBorderWidth"), 2,    1,  20);
    const size        = clampInt(formData.get("welcomeGlowSize"),        18,   2,  80);
    const fadeInMs    = clampInt(formData.get("welcomeGlowFadeInMs"),    1500, 100, 8000);
    const holdMs      = clampInt(formData.get("welcomeGlowHoldMs"),      4000, 0,   30000);
    const fadeOutMs   = clampInt(formData.get("welcomeGlowFadeOutMs"),   2000, 100, 8000);
    const speed       = clampFloat(formData.get("welcomeGlowSpeed"),     1.0,  0.2, 5.0);
    await updateShopConfig(session.shop, {
      welcomeGlowStyle:       style,
      welcomeGlowColors:      colors.join(","),
      welcomeGlowBorderWidth: borderWidth,
      welcomeGlowSize:        size,
      welcomeGlowFadeInMs:    fadeInMs,
      welcomeGlowHoldMs:      holdMs,
      welcomeGlowFadeOutMs:   fadeOutMs,
      welcomeGlowSpeed:       speed,
    });
    return { saved: true };
  }

  if (intent === "save_visualize_look") {
    const enabled = formData.get("visualizeLookEnabled") === "true";
    const provider = String(formData.get("imageProvider") || "").trim();
    if (provider !== "" && provider !== "gemini" && provider !== "openai") {
      return { error: "Invalid image provider." };
    }
    const label = String(formData.get("visualizeLookLabel") || "").trim().slice(0, 40);
    const vData = {
      visualizeLookEnabled: enabled,
      imageProvider: provider,
      visualizeLookLabel: label || "Visualize My Look",
    };
    const geminiKey = formData.get("geminiApiKey");
    if (geminiKey !== null && geminiKey !== "") vData.geminiApiKey = geminiKey;
    const oaiKey = formData.get("openaiApiKey");
    if (oaiKey !== null && oaiKey !== "") vData.openaiApiKey = oaiKey;
    await updateShopConfig(session.shop, vData);
    return { saved: true };
  }

  const data = {};

  const anthropicKey = formData.get("anthropicApiKey");
  if (anthropicKey !== null && anthropicKey !== "") {
    data.anthropicApiKey = anthropicKey;
  }

  const model = formData.get("anthropicModel");
  if (model) data.anthropicModel = model;

  const strategy = formData.get("modelStrategy");
  if (strategy) data.modelStrategy = strategy;

  const yotpoKey = formData.get("yotpoApiKey");
  if (yotpoKey !== null && yotpoKey !== "") {
    data.yotpoApiKey = yotpoKey;
  }

  const aftershipKey = formData.get("aftershipApiKey");
  if (aftershipKey !== null && aftershipKey !== "") {
    data.aftershipApiKey = aftershipKey;
  }

  const embeddingProvider = formData.get("embeddingProvider");
  if (embeddingProvider !== null) {
    const v = String(embeddingProvider).trim();
    if (v === "" || v === "voyage" || v === "openai") {
      data.embeddingProvider = v;
    }
  }
  const voyageKey = formData.get("voyageApiKey");
  if (voyageKey !== null && voyageKey !== "") {
    data.voyageApiKey = voyageKey;
  }
  const openaiKey = formData.get("openaiApiKey");
  if (openaiKey !== null && openaiKey !== "") {
    data.openaiApiKey = openaiKey;
  }

  const supportUrl = formData.get("supportUrl");
  if (supportUrl !== null) data.supportUrl = supportUrl.trim();

  const supportLabel = formData.get("supportLabel");
  if (supportLabel !== null) data.supportLabel = supportLabel.trim();

  const trackingPageUrl = formData.get("trackingPageUrl");
  if (trackingPageUrl !== null) data.trackingPageUrl = trackingPageUrl.trim();

  const returnsPageUrl = formData.get("returnsPageUrl");
  if (returnsPageUrl !== null) data.returnsPageUrl = returnsPageUrl.trim();

  const referralPageUrl = formData.get("referralPageUrl");
  if (referralPageUrl !== null) data.referralPageUrl = referralPageUrl.trim();

  const klaviyoFormId = formData.get("klaviyoFormId");
  if (klaviyoFormId !== null) data.klaviyoFormId = klaviyoFormId.trim();
  const klaviyoCompanyId = formData.get("klaviyoCompanyId");
  if (klaviyoCompanyId !== null) data.klaviyoCompanyId = klaviyoCompanyId.trim();
  const klaviyoListId = formData.get("klaviyoListId");
  if (klaviyoListId !== null) data.klaviyoListId = klaviyoListId.trim();

  const hideUrlsRaw = formData.get("hideOnUrls");
  if (hideUrlsRaw !== null) {
    try {
      const parsed = JSON.parse(hideUrlsRaw);
      if (Array.isArray(parsed)) data.hideOnUrls = JSON.stringify(parsed);
    } catch { /* ignore invalid JSON */ }
  }

  const followUps = formData.get("showFollowUps");
  if (followUps !== null) data.showFollowUps = followUps === "true";

  const feedbackToggle = formData.get("showFeedback");
  if (feedbackToggle !== null) data.showFeedback = feedbackToggle === "true";

  const cachingToggle = formData.get("promptCaching");
  if (cachingToggle !== null) data.promptCaching = cachingToggle === "true";

  const vipToggle = formData.get("vipModeEnabled");
  if (vipToggle !== null) data.vipModeEnabled = vipToggle === "true";

  const loginPillToggle = formData.get("showLoginPill");
  if (loginPillToggle !== null) data.showLoginPill = loginPillToggle === "true";

  const klaviyoPrivateKey = formData.get("klaviyoPrivateKey");
  if (klaviyoPrivateKey !== null && klaviyoPrivateKey !== "") {
    data.klaviyoPrivateKey = klaviyoPrivateKey;
  }

  const yotpoLoyaltyKey = formData.get("yotpoLoyaltyApiKey");
  if (yotpoLoyaltyKey !== null && yotpoLoyaltyKey !== "") {
    data.yotpoLoyaltyApiKey = yotpoLoyaltyKey;
  }

  const yotpoLoyaltyGuid = formData.get("yotpoLoyaltyGuid");
  if (yotpoLoyaltyGuid !== null) data.yotpoLoyaltyGuid = yotpoLoyaltyGuid.trim();

  const loyaltyDisplay = formData.get("loyaltyDisplay");
  if (loyaltyDisplay !== null) data.loyaltyDisplay = loyaltyDisplay === "dollars" ? "dollars" : "points";

  const loyaltyPointsPerDollar = formData.get("loyaltyPointsPerDollar");
  if (loyaltyPointsPerDollar !== null) {
    const n = parseInt(loyaltyPointsPerDollar, 10);
    data.loyaltyPointsPerDollar = Number.isFinite(n) && n > 0 ? n : 100;
  }

  const loyaltyRounding = formData.get("loyaltyRounding");
  if (loyaltyRounding !== null) {
    data.loyaltyRounding = ["up", "down", "exact"].includes(loyaltyRounding) ? loyaltyRounding : "exact";
  }

  const dailyCapToggle = formData.get("dailyCapEnabled");
  if (dailyCapToggle !== null) data.dailyCapEnabled = dailyCapToggle === "true";

  const dailyCapMessagesRaw = formData.get("dailyCapMessages");
  if (dailyCapMessagesRaw !== null) {
    const n = parseInt(dailyCapMessagesRaw, 10);
    // Clamp to a sensible range so a typo can't soft-disable the assistant
    // (0 messages) or set a useless absurdly-high cap.
    data.dailyCapMessages = Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : 200;
  }

  if (Object.keys(data).length > 0) {
    await updateShopConfig(session.shop, data);
  }

  return { success: true };
};

const WELCOME_GLOW_STYLE_OPTIONS = [
  { label: "None — no animation", value: "none" },
  { label: "Internal — gradient ring inside the panel", value: "internal" },
  { label: "External — blurred halo around the panel", value: "external" },
];

const DEFAULT_GLOW_COLORS = "#6366f1,#a855f7,#ec4899,#f59e0b,#10b981,#06b6d4";

function VisualizeLookCard({ initialEnabled, initialProvider, initialLabel, hasGeminiKey, hasOpenaiKey }) {
  const fetcher = useFetcher();
  const [enabled, setEnabled] = useState(Boolean(initialEnabled));
  const [provider, setProvider] = useState(initialProvider || "");
  const [label, setLabel] = useState(initialLabel || "Visualize My Look");
  const [geminiKey, setGeminiKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const saving = fetcher.state !== "idle";
  const saved = fetcher.data?.saved === true;
  const errorMsg = fetcher.data?.error;

  const save = () => {
    const fd = new FormData();
    fd.set("intent", "save_visualize_look");
    fd.set("visualizeLookEnabled", enabled ? "true" : "false");
    fd.set("imageProvider", provider);
    fd.set("visualizeLookLabel", label);
    if (geminiKey) fd.set("geminiApiKey", geminiKey);
    if (openaiKey) fd.set("openaiApiKey", openaiKey);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <Card>
      <BlockStack gap="400">
        <Checkbox
          label="Enable “Visualize My Look”"
          checked={enabled}
          onChange={setEnabled}
          helpText="When the assistant recommends exactly ONE product, customers get a standout button that generates an AI styling preview — the real product, styled for what they described. Shown only for single-product recommendations."
        />
        {enabled && (
          <>
            <Select
              label="Image provider (you bring the key; you pay the provider per image)"
              options={[
                { label: "Choose a provider…", value: "" },
                { label: "Google Gemini (Nano Banana) — best product fidelity", value: "gemini" },
                { label: "OpenAI (gpt-image-1)", value: "openai" },
              ]}
              value={provider}
              onChange={setProvider}
              helpText="Gemini keeps the product most faithful to the original. Either way, generated images are AI styling previews — labeled as such to shoppers."
            />
            {provider === "gemini" && (
              <TextField
                label="Google AI Studio API key"
                type="password"
                value={geminiKey}
                onChange={setGeminiKey}
                autoComplete="off"
                placeholder={hasGeminiKey ? "•••••••• (saved)" : "AIza..."}
                helpText={hasGeminiKey
                  ? "A key is saved. Leave blank to keep it; paste a new value to replace."
                  : "Get a key at aistudio.google.com → API keys."}
              />
            )}
            {provider === "openai" && (
              <TextField
                label="OpenAI API key"
                type="password"
                value={openaiKey}
                onChange={setOpenaiKey}
                autoComplete="off"
                placeholder={hasOpenaiKey ? "•••••••• (saved)" : "sk-..."}
                helpText={hasOpenaiKey
                  ? "A key is saved (shared with Semantic search if set there). Leave blank to keep it."
                  : "Get a key at platform.openai.com → API keys. Uses gpt-image-1 edits."}
              />
            )}
            <TextField
              label="Button label"
              value={label}
              onChange={setLabel}
              autoComplete="off"
              maxLength={40}
              showCharacterCount
              helpText="The text on the standout button shoppers tap."
            />
            <Banner tone="info">
              <Text as="p" variant="bodySm">
                Generative AI can occasionally alter fine product details. The preview is labeled “AI styling preview” to shoppers, and we feed your real product image as the locked reference to keep it faithful.
              </Text>
            </Banner>
          </>
        )}
        {errorMsg && <Banner tone="critical"><Text as="p" variant="bodySm">{errorMsg}</Text></Banner>}
        {saved && <Banner tone="success"><Text as="p" variant="bodySm">Saved.</Text></Banner>}
        <div>
          <Button onClick={save} loading={saving} variant="primary"
            disabled={enabled && !provider}>Save</Button>
        </div>
      </BlockStack>
    </Card>
  );
}

function WelcomeGlowCard({
  initialStyle,
  initialColors,
  initialBorderWidth,
  initialSize,
  initialFadeInMs,
  initialHoldMs,
  initialFadeOutMs,
  initialSpeed,
}) {
  const fetcher = useFetcher();
  const [style, setStyle] = useState(initialStyle || "internal");
  const [colors, setColors] = useState(
    Array.isArray(initialColors) && initialColors.length > 0
      ? initialColors.join(", ")
      : DEFAULT_GLOW_COLORS,
  );
  const [borderWidth, setBorderWidth] = useState(String(initialBorderWidth ?? 2));
  const [size,        setSize]        = useState(String(initialSize        ?? 18));
  const [fadeInMs,    setFadeInMs]    = useState(String(initialFadeInMs    ?? 1500));
  const [holdMs,      setHoldMs]      = useState(String(initialHoldMs      ?? 4000));
  const [fadeOutMs,   setFadeOutMs]   = useState(String(initialFadeOutMs   ?? 2000));
  const [speed,       setSpeed]       = useState(String(initialSpeed       ?? 1.0));
  const saving = fetcher.state !== "idle";
  const saved = fetcher.data?.saved === true;
  const errorMsg = fetcher.data?.error;

  const save = () => {
    const fd = new FormData();
    fd.set("intent", "save_welcome_glow");
    fd.set("welcomeGlowStyle", style);
    fd.set(
      "welcomeGlowColors",
      colors.split(",").map((c) => c.trim()).filter(Boolean).join(","),
    );
    fd.set("welcomeGlowBorderWidth", borderWidth);
    fd.set("welcomeGlowSize",        size);
    fd.set("welcomeGlowFadeInMs",    fadeInMs);
    fd.set("welcomeGlowHoldMs",      holdMs);
    fd.set("welcomeGlowFadeOutMs",   fadeOutMs);
    fd.set("welcomeGlowSpeed",       speed);
    fetcher.submit(fd, { method: "post" });
  };

  const resetColors = () => setColors(DEFAULT_GLOW_COLORS);
  const resetTiming = () => {
    setBorderWidth("2");
    setSize("18");
    setFadeInMs("1500");
    setHoldMs("4000");
    setFadeOutMs("2000");
    setSpeed("1.0");
  };

  const swatches = colors
    .split(",")
    .map((c) => c.trim())
    .filter((c) => /^#[0-9a-f]{3,8}$/i.test(c));

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Welcome panel intro effect</Text>
            <Badge tone="info">First-open animation</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            Plays a brief animated gradient effect on the chat panel when a customer first opens it (welcome view only — returning customers with chat history skip it). Pick: no animation, a gradient ring inside the panel, or a blurred halo outside.
          </Text>
        </BlockStack>

        <FormLayout>
          <Select
            label="Style"
            options={WELCOME_GLOW_STYLE_OPTIONS}
            value={style}
            onChange={setStyle}
            helpText="None disables the effect entirely. Internal stays inside the panel border. External creates a soft glowing halo around the panel."
          />
          <TextField
            label="Colors"
            value={colors}
            onChange={setColors}
            placeholder={DEFAULT_GLOW_COLORS}
            autoComplete="off"
            disabled={style === "none"}
            helpText="Comma-separated hex codes (3+ recommended for a smooth gradient). The animation rotates through them like a conic gradient."
          />
        </FormLayout>

        {swatches.length > 0 && (
          <InlineStack gap="100" blockAlign="center" wrap>
            <Text as="span" variant="bodySm" tone="subdued">Preview:</Text>
            {swatches.map((c, i) => (
              <span
                key={i}
                title={c}
                style={{
                  display: "inline-block",
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: c,
                  border: "1px solid rgba(0,0,0,0.1)",
                }}
              />
            ))}
          </InlineStack>
        )}

        {errorMsg && (
          <Banner tone="critical"><Text as="p">{errorMsg}</Text></Banner>
        )}
        {saved && !errorMsg && (
          <Banner tone="success"><Text as="p">Saved. New panel opens will use the updated effect.</Text></Banner>
        )}

        <Divider />

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Tuning</Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Fine-tune the look and timing of the effect. All durations are in milliseconds (1000 ms = 1 second).
          </Text>
          <FormLayout>
            <FormLayout.Group>
              <TextField
                type="number"
                label="Border thickness (px)"
                value={borderWidth}
                onChange={setBorderWidth}
                min={1}
                max={20}
                helpText="Width of the sharp gradient line at the panel edge. 1–20."
                disabled={style === "none"}
              />
              <TextField
                type="number"
                label="Glow size (px)"
                value={size}
                onChange={setSize}
                min={2}
                max={80}
                helpText="How far the soft halo extends past the panel. 2–80."
                disabled={style === "none"}
              />
              <TextField
                type="number"
                label="Animation speed"
                value={speed}
                onChange={setSpeed}
                min={0.2}
                max={5}
                step={0.1}
                helpText="Multiplier. 1.0 = default; 0.5 = half speed; 2.0 = double."
                disabled={style === "none"}
              />
            </FormLayout.Group>
            <FormLayout.Group>
              <TextField
                type="number"
                label="Fade-in (ms)"
                value={fadeInMs}
                onChange={setFadeInMs}
                min={100}
                max={8000}
                helpText="100–8000."
                disabled={style === "none"}
              />
              <TextField
                type="number"
                label="Hold (ms)"
                value={holdMs}
                onChange={setHoldMs}
                min={0}
                max={30000}
                helpText="Full-opacity hold. 0–30000."
                disabled={style === "none"}
              />
              <TextField
                type="number"
                label="Fade-out (ms)"
                value={fadeOutMs}
                onChange={setFadeOutMs}
                min={100}
                max={8000}
                helpText="100–8000."
                disabled={style === "none"}
              />
            </FormLayout.Group>
          </FormLayout>
        </BlockStack>

        <InlineStack gap="200">
          <Button onClick={save} loading={saving} variant="primary">Save</Button>
          <Button onClick={resetColors} variant="plain">Reset colors</Button>
          <Button onClick={resetTiming} variant="plain">Reset tuning</Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function ConnectionStatus({ connected }) {
  return connected ? (
    <InlineStack gap="150" blockAlign="center">
      <Icon source={CheckCircleIcon} tone="success" />
      <Text as="span" variant="bodySm" tone="success">Connected</Text>
    </InlineStack>
  ) : (
    <Badge tone="attention">Not configured</Badge>
  );
}

const MODEL_OPTIONS = [
  { label: "Standard — recommended", value: "claude-sonnet-4-6" },
  { label: "Fast — lower cost", value: "claude-haiku-4-5-20251001" },
  { label: "Advanced — most capable", value: "claude-opus-4-7" },
];

// Three user-facing strategy buckets. The backend still accepts the
// older 5-value vocabulary (smart, cost-optimized, always-sonnet,
// always-haiku, always-opus) so stored configs keep working — but the
// admin only exposes three so the choice stays clear.
//   • Smart (recommended): best balance — Fast model for standard
//     turns, Standard for comparisons + automatic escalation when a
//     reply fails the grounding fact-check.
//   • Cost optimized: Fast model for every turn (comparisons too);
//     Standard only on grounding-check escalations. Lowest spend.
//   • Premium quality: every turn on the Advanced model. Maximum
//     capability, highest cost. Enterprise plan only.
// "Always use Standard" and "Always use Fast" were removed: Standard
// is what Smart picks for substantive turns anyway, and Fast-on-every-
// turn measurably degrades correctness.
const STRATEGY_OPTIONS = [
  { label: "Smart routing (recommended)", value: "smart" },
  { label: "Cost optimized", value: "cost-optimized" },
  { label: "Premium quality", value: "always-opus" },
];

const STRATEGY_HELP = {
  smart: "Uses the Fast model for standard shopping turns and the Standard model for product comparisons and complex queries. Every reply is fact-checked against live catalog data; if a check fails, the turn automatically re-runs on the Standard model. Best balance of cost and quality.",
  "cost-optimized": "Uses the Fast model for every turn, including comparisons. Every reply is still fact-checked against live catalog data, and a failed check automatically re-runs the turn on the Standard model — so product facts stay correct at the lowest cost.",
  "always-opus": "Every message uses the Advanced model. Maximum capability for complex catalogs and nuanced shopper questions. Highest cost.",
  // Legacy values still mapped so existing configs render a sensible
  // helper line; the dropdown auto-normalizes them to 'smart' below.
  "always-sonnet": "Every message uses the Standard model. Consistent quality for all conversations.",
  "always-haiku": "Every message uses the Fast model. Lowest cost — degrades correctness on complex turns.",
};

// Map any legacy stored strategy to a value the new 3-option dropdown
// can display. Saving from this UI overwrites with the normalized
// value; until then the legacy backend logic keeps working.
function normalizeStrategyForUi(value) {
  const valid = new Set(STRATEGY_OPTIONS.map((o) => o.value));
  if (valid.has(value)) return value;
  // always-sonnet behaves like smart in practice (smart routes
  // substantive turns to Sonnet). always-haiku is the option we'd
  // most like merchants off — map to smart so they get correctness
  // back the next time they save.
  return "smart";
}

function HideUrlsPanel({ initial }) {
  const [rules, setRules] = useState(initial || []);
  const [matchType, setMatchType] = useState("equals");
  const [pattern, setPattern] = useState("");

  const addRule = () => {
    const p = pattern.trim();
    if (!p) return;
    const exists = rules.some((r) => r.matchType === matchType && r.pattern === p);
    if (exists) return;
    setRules([...rules, { matchType, pattern: p }]);
    setPattern("");
  };

  const removeRule = (idx) => {
    setRules(rules.filter((_, i) => i !== idx));
  };

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">Hide widget on specific pages</Text>
          <Text as="p" tone="subdued" variant="bodySm">
            The chat widget will be hidden on pages matching any of these rules. Use "equals" for exact path matches or "contains" for substring matches (e.g. all pages starting with a prefix).
          </Text>
        </BlockStack>

        {rules.length > 0 && (
          <BlockStack gap="200">
            {rules.map((r, i) => (
              <InlineStack key={i} gap="200" blockAlign="center">
                <Badge tone={r.matchType === "contains" ? "attention" : "info"}>
                  {r.matchType === "contains" ? "Contains" : "Equals"}
                </Badge>
                <Text as="span" variant="bodyMd"><code>{r.pattern}</code></Text>
                <Button variant="plain" tone="critical" onClick={() => removeRule(i)}>Remove</Button>
              </InlineStack>
            ))}
          </BlockStack>
        )}

        <Divider />

        <InlineStack gap="200" blockAlign="end" wrap={false}>
          <div style={{ minWidth: 130 }}>
            <Select
              label="Match type"
              options={[
                { label: "URL equals", value: "equals" },
                { label: "URL contains", value: "contains" },
              ]}
              value={matchType}
              onChange={setMatchType}
            />
          </div>
          <div style={{ flex: 1 }}>
            <TextField
              label="URL pattern"
              value={pattern}
              onChange={setPattern}
              placeholder="/pages/technology"
              autoComplete="off"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRule(); } }}
            />
          </div>
          <Button onClick={addRule} disabled={!pattern.trim()}>Add</Button>
        </InlineStack>

        <input type="hidden" name="hideOnUrls" value={JSON.stringify(rules)} />
      </BlockStack>
    </Card>
  );
}

export default function ApiKeys() {
  const { hasAnthropicKey, anthropicModel, modelStrategy, showFollowUps: initFollowUps, showFeedback: initFeedback, hasYotpoKey, hasAftershipKey, hideOnUrls, supportUrl: initSupportUrl, supportLabel: initSupportLabel, trackingPageUrl: initTrackingPageUrl, returnsPageUrl: initReturnsPageUrl, referralPageUrl: initReferralPageUrl, promptCaching: initCaching, klaviyoFormId: initKlaviyoFormId, klaviyoCompanyId: initKlaviyoCompanyId, klaviyoListId: initKlaviyoListId, vipModeEnabled: initVipMode, showLoginPill: initShowLoginPill, hasKlaviyoPrivateKey, hasYotpoLoyaltyKey, yotpoLoyaltyGuid: initYotpoLoyaltyGuid, loyaltyDisplay: initLoyaltyDisplay, loyaltyPointsPerDollar: initLoyaltyPointsPerDollar, loyaltyRounding: initLoyaltyRounding, dailyCapEnabled: initDailyCapEnabled, dailyCapMessages: initDailyCapMessages, embeddingProvider: initEmbeddingProvider, hasVoyageKey, hasOpenaiKey, visualizeLookEnabled: initVizEnabled, imageProvider: initImageProvider, visualizeLookLabel: initVizLabel, hasGeminiKey, knowledgeRagEnabled, plan, welcomeGlowStyle, welcomeGlowColors, welcomeGlowBorderWidth, welcomeGlowSize, welcomeGlowFadeInMs, welcomeGlowHoldMs, welcomeGlowFadeOutMs, welcomeGlowSpeed } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  const [anthropicKey, setAnthropicKey] = useState("");
  const [model, setModel] = useState(anthropicModel || "claude-sonnet-4-6");
  const [strategy, setStrategy] = useState(normalizeStrategyForUi(modelStrategy));
  const [followUps, setFollowUps] = useState(initFollowUps);
  const [feedbackOn, setFeedbackOn] = useState(initFeedback);
  const [yotpoKey, setYotpoKey] = useState("");
  const [aftershipKey, setAftershipKey] = useState("");
  const [embeddingProvider, setEmbeddingProvider] = useState(initEmbeddingProvider || "");
  const [voyageKey, setVoyageKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [supportUrl, setSupportUrl] = useState(initSupportUrl);
  const [supportLabel, setSupportLabel] = useState(initSupportLabel);
  const [trackingPageUrl, setTrackingPageUrl] = useState(initTrackingPageUrl);
  const [returnsPageUrl, setReturnsPageUrl] = useState(initReturnsPageUrl);
  const [referralPageUrl, setReferralPageUrl] = useState(initReferralPageUrl);
  const [caching, setCaching] = useState(initCaching);
  const [klaviyoFormId, setKlaviyoFormId] = useState(initKlaviyoFormId);
  const [klaviyoCompanyId, setKlaviyoCompanyId] = useState(initKlaviyoCompanyId);
  const [klaviyoListId, setKlaviyoListId] = useState(initKlaviyoListId);
  const [vipMode, setVipMode] = useState(initVipMode);
  const [showLoginPill, setShowLoginPill] = useState(initShowLoginPill);
  const [dailyCapEnabled, setDailyCapEnabled] = useState(initDailyCapEnabled);
  const [dailyCapMessages, setDailyCapMessages] = useState(String(initDailyCapMessages ?? 200));
  const [klaviyoPrivateKey, setKlaviyoPrivateKey] = useState("");
  const [yotpoLoyaltyKey, setYotpoLoyaltyKey] = useState("");
  const [yotpoLoyaltyGuidState, setYotpoLoyaltyGuidState] = useState(initYotpoLoyaltyGuid);
  const [loyaltyDisplay, setLoyaltyDisplay] = useState(initLoyaltyDisplay);
  const [loyaltyPointsPerDollar, setLoyaltyPointsPerDollar] = useState(String(initLoyaltyPointsPerDollar));
  const [loyaltyRounding, setLoyaltyRounding] = useState(initLoyaltyRounding);

  // Contextual Save Bar plumbing — BFS 4.1.5. Track dirty state via the
  // form's onChange (Polaris components bubble change events to the parent
  // form), reset on successful save, and let "Discard" restore the snapshot.
  const formRef = useRef(null);
  const [isDirty, setIsDirty] = useState(false);
  const initialSnapshot = useRef({
    model: anthropicModel || "claude-sonnet-4-6",
    strategy: modelStrategy,
    followUps: initFollowUps,
    feedbackOn: initFeedback,
    supportUrl: initSupportUrl,
    supportLabel: initSupportLabel,
    trackingPageUrl: initTrackingPageUrl,
    returnsPageUrl: initReturnsPageUrl,
    referralPageUrl: initReferralPageUrl,
    caching: initCaching,
    klaviyoFormId: initKlaviyoFormId,
    klaviyoCompanyId: initKlaviyoCompanyId,
    klaviyoListId: initKlaviyoListId,
    vipMode: initVipMode,
    showLoginPill: initShowLoginPill,
    dailyCapEnabled: initDailyCapEnabled,
    dailyCapMessages: String(initDailyCapMessages ?? 200),
    yotpoLoyaltyGuid: initYotpoLoyaltyGuid,
    loyaltyDisplay: initLoyaltyDisplay,
    loyaltyPointsPerDollar: String(initLoyaltyPointsPerDollar),
    loyaltyRounding: initLoyaltyRounding,
  });

  // Reset dirty + clear secret-input fields after a successful save, and
  // confirm with an always-visible toast (not an out-of-view top banner).
  useEffect(() => {
    if (actionData?.success) {
      if (typeof window !== "undefined" && window.shopify?.toast) window.shopify.toast.show("Settings saved");
      setIsDirty(false);
      setAnthropicKey("");
      setYotpoKey("");
      setAftershipKey("");
      setKlaviyoPrivateKey("");
      setYotpoLoyaltyKey("");
      setVoyageKey("");
      setOpenaiKey("");
    }
  }, [actionData]);

  const discardChanges = () => {
    const s = initialSnapshot.current;
    setAnthropicKey("");
    setModel(s.model);
    setStrategy(normalizeStrategyForUi(s.strategy));
    setFollowUps(s.followUps);
    setFeedbackOn(s.feedbackOn);
    setYotpoKey("");
    setAftershipKey("");
    setSupportUrl(s.supportUrl);
    setSupportLabel(s.supportLabel);
    setTrackingPageUrl(s.trackingPageUrl);
    setReturnsPageUrl(s.returnsPageUrl);
    setReferralPageUrl(s.referralPageUrl);
    setCaching(s.caching);
    setKlaviyoFormId(s.klaviyoFormId);
    setKlaviyoCompanyId(s.klaviyoCompanyId);
    setKlaviyoListId(s.klaviyoListId);
    setVipMode(s.vipMode);
    setShowLoginPill(s.showLoginPill);
    setKlaviyoPrivateKey("");
    setYotpoLoyaltyKey("");
    setYotpoLoyaltyGuidState(s.yotpoLoyaltyGuid);
    setLoyaltyDisplay(s.loyaltyDisplay);
    setLoyaltyPointsPerDollar(s.loyaltyPointsPerDollar);
    setLoyaltyRounding(s.loyaltyRounding);
    setDailyCapEnabled(s.dailyCapEnabled);
    setDailyCapMessages(s.dailyCapMessages);
    setIsDirty(false);
  };

  const submitForm = () => {
    if (formRef.current) formRef.current.requestSubmit();
  };

  return (
    <Page>
      <TitleBar title="Settings" />
      <Form method="post" ref={formRef} onChange={() => setIsDirty(true)}>
        <BlockStack gap="500">
          <BrandHeader title="Settings" gutter={false} />
          {/* Save feedback is an always-visible App Bridge toast, not a top banner. */}

          <Layout>
            <Layout.AnnotatedSection
              title="AI Engine (required)"
              description={
                <BlockStack gap="200">
                  <Text as="p" tone="subdued" variant="bodySm">
                    Powers the AI assistant. Pay-as-you-go usage — SEoS Assistant adds no markup.
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">
                      Get your API key here
                    </a>
                    .
                  </Text>
                </BlockStack>
              }
            >
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingSm">API Key</Text>
                    <ConnectionStatus connected={hasAnthropicKey} />
                  </InlineStack>

                  <TextField
                    label="API key"
                    type="password"
                    value={anthropicKey}
                    onChange={setAnthropicKey}
                    placeholder={hasAnthropicKey ? "••••••••••••••••" : "Paste API key"}
                    autoComplete="off"
                    helpText="Encrypted at rest. Leave blank to keep your existing key."
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Model routing"
              description={
                <BlockStack gap="200">
                  <Text as="p" tone="subdued" variant="bodySm">
                    Control which AI model handles customer messages. Smart routing saves money by using
                    a cheaper model for simple interactions.
                  </Text>
                </BlockStack>
              }
            >
              <Card>
                <BlockStack gap="400">
                  <Select
                    label="Primary model"
                    options={MODEL_OPTIONS.filter(
                      (o) => o.value !== "claude-opus-4-7" || plan.features?.advancedModel,
                    )}
                    value={model}
                    onChange={setModel}
                    helpText={
                      plan.features?.advancedModel
                        ? "Your Standard model. With Smart routing it handles product comparisons, complex queries, and automatic escalations when a reply fails the grounding fact-check; routine turns use the Fast model."
                        : "Your Standard model. With Smart routing it handles product comparisons, complex queries, and automatic escalations when a reply fails the grounding fact-check; routine turns use the Fast model. The Advanced model is available on the Enterprise plan."
                    }
                  />

                  <Divider />

                  <PlanGate
                    plan={plan}
                    feature="smartRouting"
                    summary="Smart routing can automatically use the Fast model for safe turns, lowering cost while keeping complex requests on the Standard model."
                  >
                    <BlockStack gap="400">
                      <Select
                        label="Routing strategy"
                        options={STRATEGY_OPTIONS.filter(
                          (o) => o.value !== "always-opus" || plan.features?.advancedModel,
                        )}
                        value={strategy}
                        onChange={setStrategy}
                        helpText={STRATEGY_HELP[strategy]}
                      />

                      {strategy === "smart" && (
                        <Banner tone="info">
                          <Text as="p" variant="bodySm">
                            <strong>How smart routing works:</strong> Standard shopping turns run on the
                            Fast model. Product comparisons and complex queries run on your primary model.
                            Every reply is fact-checked against your live catalog before it reaches the
                            customer — if a check fails, the turn automatically re-runs on your primary model.
                          </Text>
                        </Banner>
                      )}
                      {strategy === "cost-optimized" && (
                        <Banner tone="info">
                          <Text as="p" variant="bodySm">
                            <strong>How cost optimized routing works:</strong> Every turn — including
                            comparisons — runs on the Fast model for the lowest cost. Every reply is still
                            fact-checked against your live catalog, and any reply that fails the check
                            automatically re-runs on your primary model, so product facts stay correct.
                          </Text>
                        </Banner>
                      )}
                    </BlockStack>
                  </PlanGate>
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Semantic search (optional)"
              description={
                <BlockStack gap="200">
                  <Text as="p" tone="subdued" variant="bodySm">
                    Sharpen product matching by meaning, not just keywords. Customers asking for "shoes for standing all day" will find arch-support styles even when the description doesn't say "standing". Handles typos, synonyms (red ≈ crimson), and use-case queries.
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Optional — the assistant already searches your catalog with AI and works fully without this. Bring your own API key from Voyage AI (recommended) or OpenAI. Cost is paid by you to the provider — typically under $1/month for catalogs under 5,000 products.
                  </Text>
                </BlockStack>
              }
            >
              <Card>
                <BlockStack gap="400">
                  <Select
                    label="Embedding provider"
                    options={[
                      { label: "Disabled (use keyword search only)", value: "" },
                      { label: "Voyage AI — recommended (cheaper, optimized for retrieval)", value: "voyage" },
                      { label: "OpenAI", value: "openai" },
                    ]}
                    value={embeddingProvider}
                    onChange={setEmbeddingProvider}
                    helpText="Disabled keeps the current keyword search. Enabling either provider adds semantic matching on top."
                  />

                  {embeddingProvider === "voyage" && (
                    <BlockStack gap="200">
                      <TextField
                        label="Voyage AI API key"
                        type="password"
                        value={voyageKey}
                        onChange={setVoyageKey}
                        autoComplete="off"
                        placeholder={hasVoyageKey ? "•••••••• (saved)" : "pa-..."}
                        helpText={hasVoyageKey
                          ? "A key is saved. Leave blank to keep it; paste a new value to replace."
                          : "Get a key at voyageai.com → Account → API keys."}
                      />
                    </BlockStack>
                  )}

                  {embeddingProvider === "openai" && (
                    <BlockStack gap="200">
                      <TextField
                        label="OpenAI API key"
                        type="password"
                        value={openaiKey}
                        onChange={setOpenaiKey}
                        autoComplete="off"
                        placeholder={hasOpenaiKey ? "•••••••• (saved)" : "sk-..."}
                        helpText={hasOpenaiKey
                          ? "A key is saved. Leave blank to keep it; paste a new value to replace."
                          : "Get a key at platform.openai.com → API keys. Uses text-embedding-3-small."}
                      />
                    </BlockStack>
                  )}

                  {embeddingProvider !== "" && (
                    <Banner tone="info">
                      <Text as="p" variant="bodySm">
                        After saving, click <strong>Backfill embeddings</strong> on the Rules &amp; Knowledge page to embed your existing catalog. New and updated products are embedded automatically going forward.
                      </Text>
                    </Banner>
                  )}
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Visualize My Look (AI styling preview)"
              description={
                <BlockStack gap="200">
                  <Text as="p" tone="subdued" variant="bodySm">
                    When the assistant lands on a single best product, shoppers can tap a standout button to see an AI styling preview — their actual product, styled for what they described (e.g. “heels to go with my blue dress”).
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Optional. Only appears for single-product recommendations. You bring your own image-provider key and pay that provider per image.
                  </Text>
                </BlockStack>
              }
            >
              <VisualizeLookCard
                initialEnabled={initVizEnabled}
                initialProvider={initImageProvider}
                initialLabel={initVizLabel}
                hasGeminiKey={hasGeminiKey}
                hasOpenaiKey={hasOpenaiKey}
              />
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Knowledge retrieval (RAG)"
              description={
                <BlockStack gap="200">
                  <Text as="p" tone="subdued" variant="bodySm">
                    Instead of injecting every knowledge file into every chat, RAG embeds your knowledge files and pulls only the most relevant sections per customer message. Keeps prompts focused and chat quality high as your knowledge base grows.
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Uses the same embedding provider as Semantic search above. No extra setup or extra cost beyond the embedding provider you already configured.
                  </Text>
                </BlockStack>
              }
            >
              <Card>
                <BlockStack gap="400">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">Status:</Text>
                    {!embeddingProvider ? (
                      <Badge tone="warning">Requires embedding provider</Badge>
                    ) : knowledgeRagEnabled ? (
                      <Badge tone="success">Enabled</Badge>
                    ) : (
                      <Badge>Disabled</Badge>
                    )}
                  </InlineStack>

                  <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodySm" fontWeight="semibold">How it works</Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        1. You upload knowledge files (FAQs, brand voice, rules) on the Rules &amp; Knowledge page.
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        2. The app splits each file into sections and creates an embedding for each one — one-time, on upload.
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        3. On every chat turn, your customer&apos;s message is embedded and matched against your sections. Only the top-5 most relevant ones are sent to the AI.
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        4. The AI answers using that focused context — fewer distractions, better responses, lower token cost.
                      </Text>
                    </BlockStack>
                  </Box>

                  <Banner tone="info">
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm">
                        <strong>To turn on or off:</strong> open <strong>Rules &amp; Knowledge</strong> → <strong>Knowledge files</strong> section → toggle <em>&ldquo;Use RAG retrieval&rdquo;</em>. After enabling, run <strong>Backfill embeddings</strong> from the same page.
                      </Text>
                    </BlockStack>
                  </Banner>
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Daily message cap"
              description={
                <BlockStack gap="200">
                  <Text as="p" tone="subdued" variant="bodySm">
                    Optional safety net to keep daily AI costs predictable.
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    When enabled, the assistant pauses for the rest of the day once the cap is hit and resumes the next day at midnight UTC. Customers see a friendly &quot;back tomorrow&quot; message instead of an error. Counts every conversation across your storefront.
                  </Text>
                </BlockStack>
              }
            >
              <Card>
                <BlockStack gap="400">
                  <Checkbox
                    label="Enable daily cap"
                    checked={dailyCapEnabled}
                    onChange={setDailyCapEnabled}
                    helpText="Off by default. Most stores leave this off and rely on monthly plan limits."
                  />
                  <TextField
                    label="Maximum messages per day"
                    type="number"
                    min="1"
                    max="100000"
                    value={dailyCapMessages}
                    onChange={setDailyCapMessages}
                    disabled={!dailyCapEnabled}
                    autoComplete="off"
                    helpText="Conversations counted against the cap reset at midnight UTC."
                  />
                  {dailyCapEnabled && (
                    <Banner tone="info">
                      <Text as="p" variant="bodySm">
                        <strong>Tip:</strong> a typical store costs roughly 1–3¢ per conversation depending on the AI model. Pick a cap based on how much you&apos;re willing to spend per day — for example, 200 messages at 2¢ each ≈ $4/day.
                      </Text>
                    </Banner>
                  )}
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Chat features"
              description="Toggle AI behaviors for the storefront chat widget."
            >
              <Card>
                <BlockStack gap="400">
                  <Checkbox
                    label="Follow-up questions"
                    checked={followUps}
                    onChange={setFollowUps}
                    helpText="AI suggests 2-3 clickable follow-up questions after each response. Only suggests questions it can answer."
                  />
                  <Divider />
                  <Checkbox
                    label="Helpful / Not helpful feedback"
                    checked={feedbackOn}
                    onChange={setFeedbackOn}
                    helpText="Shows thumbs up/down on product responses. Negative feedback appears in Analytics with hashed user data."
                  />
                  <Divider />
                  <PlanGate
                    plan={plan}
                    feature="promptCaching"
                    summary="Prompt caching lowers input token cost by reusing the cached system prompt across turns. The current chat engine always caches the stable part of the prompt; this toggle only affects the legacy engine."
                  >
                    <Checkbox
                      label="Prompt caching"
                      checked={caching}
                      onChange={setCaching}
                      helpText="The current chat engine always caches the stable part of the system prompt (this is what keeps responses fast and costs low). This toggle is kept for the legacy engine only — leaving it on or off does not change the current engine's behavior."
                    />
                  </PlanGate>
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Support link"
              description="When a customer asks for help or customer service, the AI shows a 'Visit Support Hub' button linking to this URL."
            >
              <Card>
                <BlockStack gap="400">
                  <TextField
                    label="Support page URL"
                    value={supportUrl}
                    onChange={setSupportUrl}
                    placeholder="https://yourstore.com/pages/contact"
                    autoComplete="off"
                    helpText="Leave blank to disable the support button."
                  />
                  <TextField
                    label="Button label (optional)"
                    value={supportLabel}
                    onChange={setSupportLabel}
                    placeholder="Visit Support Hub"
                    autoComplete="off"
                    helpText="Defaults to 'Visit Support Hub' if left blank."
                  />
                  <TextField
                    label="Order tracking page URL"
                    value={trackingPageUrl}
                    onChange={setTrackingPageUrl}
                    placeholder="https://orders.yourstore.com"
                    autoComplete="off"
                    helpText="AfterShip, Parcel Panel, or any branded tracking page. When set, logged-in customers get a tracking link to this page instead of the raw carrier URL. The AI appends the tracking number automatically."
                  />
                  <TextField
                    label="Returns page URL"
                    value={returnsPageUrl}
                    onChange={setReturnsPageUrl}
                    placeholder="https://returns.yourstore.com"
                    autoComplete="off"
                    helpText="AfterShip Returns or similar self-serve portal. When set, logged-in customers asking about returns or exchanges get a pre-filled link to this page (with their order number + email) instead of being routed to the support team."
                  />
                  <TextField
                    label="Referral program page URL"
                    value={referralPageUrl}
                    onChange={setReferralPageUrl}
                    placeholder="https://yourstore.com/pages/refer"
                    autoComplete="off"
                    helpText="Your Give-$X-Get-$X / referral landing page. When a customer asks how to refer friends, the AI links them here so they can get their personal referral link and share options. Used as a fallback when the customer's personal link isn't available from Yotpo."
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Integrations (optional)"
              description="Connect third-party services for richer AI context — product reviews, sizing data, and return insights. Each service is independent; connect only what you use."
            >
              <BlockStack gap="400">
                <PlanGate
                  plan={plan}
                  feature="yotpoIntegration"
                  summary="Pull review data and customer sizing feedback into the chat — powers fit summaries, star ratings, and 'what do reviewers say' answers."
                >
                  <Card>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="h3" variant="headingMd">Yotpo Reviews</Text>
                        </InlineStack>
                        <Badge tone={hasYotpoKey ? "success" : undefined}>
                          {hasYotpoKey ? "Connected" : "Not set"}
                        </Badge>
                      </InlineStack>
                      <Text as="p" tone="subdued" variant="bodySm">
                        Product review data — fit summaries, star ratings, sample reviews. Powers sizing recommendations and "what do reviewers say" answers.
                      </Text>
                      <TextField
                        label="Yotpo API key"
                        labelHidden
                        type="password"
                        value={yotpoKey}
                        onChange={setYotpoKey}
                        placeholder={hasYotpoKey ? "••••••••••••••••" : "Paste key to enable"}
                        autoComplete="off"
                        helpText="Lets the AI reference product reviews and customer sizing feedback."
                      />
                    </BlockStack>
                  </Card>
                </PlanGate>

                <PlanGate
                  plan={plan}
                  feature="yotpoIntegration"
                  summary="Show points, VIP tier, and personal referral links to logged-in customers via the chat."
                >
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingMd">Yotpo Loyalty &amp; Referrals</Text>
                      <Badge tone={hasYotpoLoyaltyKey ? "success" : undefined}>
                        {hasYotpoLoyaltyKey ? "Connected" : "Not set"}
                      </Badge>
                    </InlineStack>
                    <Text as="p" tone="subdued" variant="bodySm">
                      Points, VIP tier, and personal referral link for logged-in customers. Only used when VIP mode is enabled below.
                    </Text>
                    <TextField
                      label="Yotpo Loyalty API key"
                      type="password"
                      value={yotpoLoyaltyKey}
                      onChange={setYotpoLoyaltyKey}
                      placeholder={hasYotpoLoyaltyKey ? "••••••••••••••••" : "Paste key to enable loyalty VIP perks"}
                      autoComplete="off"
                      helpText="From Yotpo Loyalty admin → Program Settings → API Key."
                    />
                    <TextField
                      label="Yotpo Loyalty GUID"
                      value={yotpoLoyaltyGuidState}
                      onChange={setYotpoLoyaltyGuidState}
                      placeholder="Optional — GUID from Program Settings"
                      autoComplete="off"
                      helpText="Optional. Some Yotpo accounts require the GUID alongside the API key. Leave blank if your API key works alone."
                    />
                    <Select
                      label="How should the chat display loyalty balances?"
                      options={[
                        { label: "Points (e.g. '250 points')", value: "points" },
                        { label: "Dollar value (e.g. '$2.50 in rewards')", value: "dollars" },
                      ]}
                      value={loyaltyDisplay}
                      onChange={setLoyaltyDisplay}
                      helpText="Controls how the AI references loyalty balances to logged-in customers."
                    />
                    {loyaltyDisplay === "dollars" && (
                      <BlockStack gap="300">
                        <TextField
                          label="Conversion rate (points per $1)"
                          type="number"
                          min={1}
                          value={loyaltyPointsPerDollar}
                          onChange={setLoyaltyPointsPerDollar}
                          helpText="Example: 100 means 100 points = $1. 500 points → $5.00."
                          autoComplete="off"
                        />
                        <Select
                          label="Rounding"
                          options={[
                            { label: "Exact (e.g. $2.53)", value: "exact" },
                            { label: "Round down (e.g. $2)", value: "down" },
                            { label: "Round up (e.g. $3)", value: "up" },
                          ]}
                          value={loyaltyRounding}
                          onChange={setLoyaltyRounding}
                          helpText="How the converted dollar amount is displayed."
                        />
                      </BlockStack>
                    )}
                  </BlockStack>
                </Card>
                </PlanGate>

                <PlanGate
                  plan={plan}
                  feature="aftershipIntegration"
                  summary="Lets the AI cite return-reason data so it can warn customers when a product runs small or large based on real return rates."
                >
                  <Card>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h3" variant="headingMd">Aftership</Text>
                        <Badge tone={hasAftershipKey ? "success" : undefined}>
                          {hasAftershipKey ? "Connected" : "Not set"}
                        </Badge>
                      </InlineStack>
                      <Text as="p" tone="subdued" variant="bodySm">
                        Return-reason data for sizing intelligence — if customers return products as "too small", the AI picks that up.
                      </Text>
                      <TextField
                        label="Aftership API key"
                        labelHidden
                        type="password"
                        value={aftershipKey}
                        onChange={setAftershipKey}
                        placeholder={hasAftershipKey ? "••••••••••••••••" : "Paste key to enable"}
                        autoComplete="off"
                        helpText="Enables fit intelligence and sizing guidance from return-reason data."
                      />
                    </BlockStack>
                  </Card>
                </PlanGate>

                <PlanGate
                  plan={plan}
                  feature="klaviyoIntegration"
                  summary="Show a newsletter signup form in the chat and (optionally) enrich logged-in customers with Klaviyo segment data like VIP or Winback."
                >
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingMd">Klaviyo</Text>
                      <Badge tone={hasKlaviyoPrivateKey ? "success" : undefined}>
                        {hasKlaviyoPrivateKey ? "Enrichment on" : "Signup only"}
                      </Badge>
                    </InlineStack>
                    <Text as="p" tone="subdued" variant="bodySm">
                      Newsletter signup form in chat (with Company ID + List ID). Optional private key unlocks VIP segment enrichment.
                    </Text>
                    <TextField
                      label="Company ID (public API key)"
                      value={klaviyoCompanyId}
                      onChange={setKlaviyoCompanyId}
                      placeholder="AbC123"
                      autoComplete="off"
                      helpText="Found in Klaviyo → Settings → API Keys → Public API Key. Used for the in-chat signup form."
                    />
                    <TextField
                      label="List ID"
                      value={klaviyoListId}
                      onChange={setKlaviyoListId}
                      placeholder="XyZ789"
                      autoComplete="off"
                      helpText="The list to subscribe to. Found in Klaviyo → Audience → Lists → click your list → ID in the URL."
                    />
                    <TextField
                      label="Private API key"
                      type="password"
                      value={klaviyoPrivateKey}
                      onChange={setKlaviyoPrivateKey}
                      placeholder={hasKlaviyoPrivateKey ? "••••••••••••••••" : "pk_..."}
                      autoComplete="off"
                      helpText="Optional. Required for VIP mode enrichment — lets the AI see logged-in customers' Klaviyo segments (e.g. VIP, Winback). Klaviyo → Settings → API Keys → Create Private API Key (scopes: profiles:read, segments:read)."
                    />
                  </BlockStack>
                </Card>
                </PlanGate>
              </BlockStack>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="VIP customer experience"
              description="Personalize the chat for logged-in customers using their order history and profile."
            >
              <PlanGate
                plan={plan}
                feature="vipMode"
                summary="VIP mode greets logged-in customers by name, references their past orders for size recommendations, and unlocks Yotpo/Klaviyo enrichment in the chat."
              >
              <Card>
                <BlockStack gap="400">
                  <Checkbox
                    label="Show login pill in chat header"
                    checked={showLoginPill}
                    onChange={setShowLoginPill}
                    helpText="Adds a 'Login' button next to the menu for anonymous visitors, and 'Hi [name]!' for logged-in customers."
                  />
                  <Checkbox
                    label="Enable VIP mode for logged-in customers"
                    checked={vipMode}
                    onChange={setVipMode}
                    helpText="Gives the AI access to the customer's order history, lifetime spend, and tags so it can deliver a more personalized experience. No PII (email, address, payment) is ever exposed in chat."
                  />
                </BlockStack>
              </Card>
              </PlanGate>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Widget visibility"
              description="Control which pages the chat widget appears on, and customize the intro animation customers see when they first open the chat."
            >
              <BlockStack gap="400">
                <HideUrlsPanel initial={hideOnUrls} />
                <WelcomeGlowCard
                  initialStyle={welcomeGlowStyle}
                  initialColors={welcomeGlowColors}
                  initialBorderWidth={welcomeGlowBorderWidth}
                  initialSize={welcomeGlowSize}
                  initialFadeInMs={welcomeGlowFadeInMs}
                  initialHoldMs={welcomeGlowHoldMs}
                  initialFadeOutMs={welcomeGlowFadeOutMs}
                  initialSpeed={welcomeGlowSpeed}
                />
              </BlockStack>
            </Layout.AnnotatedSection>
          </Layout>

          <input type="hidden" name="anthropicApiKey" value={anthropicKey} />
          <input type="hidden" name="anthropicModel" value={model} />
          <input type="hidden" name="modelStrategy" value={strategy} />
          <input type="hidden" name="showFollowUps" value={String(followUps)} />
          <input type="hidden" name="showFeedback" value={String(feedbackOn)} />
          <input type="hidden" name="yotpoApiKey" value={yotpoKey} />
          <input type="hidden" name="aftershipApiKey" value={aftershipKey} />
          <input type="hidden" name="embeddingProvider" value={embeddingProvider} />
          <input type="hidden" name="voyageApiKey" value={voyageKey} />
          <input type="hidden" name="openaiApiKey" value={openaiKey} />
          <input type="hidden" name="supportUrl" value={supportUrl} />
          <input type="hidden" name="supportLabel" value={supportLabel} />
          <input type="hidden" name="trackingPageUrl" value={trackingPageUrl} />
          <input type="hidden" name="returnsPageUrl" value={returnsPageUrl} />
          <input type="hidden" name="referralPageUrl" value={referralPageUrl} />
          <input type="hidden" name="promptCaching" value={String(caching)} />
          <input type="hidden" name="klaviyoFormId" value={klaviyoFormId} />
          <input type="hidden" name="klaviyoCompanyId" value={klaviyoCompanyId} />
          <input type="hidden" name="klaviyoListId" value={klaviyoListId} />
          <input type="hidden" name="vipModeEnabled" value={String(vipMode)} />
          <input type="hidden" name="showLoginPill" value={String(showLoginPill)} />
          <input type="hidden" name="klaviyoPrivateKey" value={klaviyoPrivateKey} />
          <input type="hidden" name="yotpoLoyaltyApiKey" value={yotpoLoyaltyKey} />
          <input type="hidden" name="yotpoLoyaltyGuid" value={yotpoLoyaltyGuidState} />
          <input type="hidden" name="loyaltyDisplay" value={loyaltyDisplay} />
          <input type="hidden" name="loyaltyPointsPerDollar" value={loyaltyPointsPerDollar} />
          <input type="hidden" name="loyaltyRounding" value={loyaltyRounding} />
          <input type="hidden" name="dailyCapEnabled" value={String(dailyCapEnabled)} />
          <input type="hidden" name="dailyCapMessages" value={dailyCapMessages} />

          <Box paddingBlockEnd="800">
            <InlineStack align="end">
              <Button variant="primary" submit loading={saving}>
                Save changes
              </Button>
            </InlineStack>
          </Box>
        </BlockStack>
      </Form>

      {/* Contextual Save Bar — App Bridge ui-save-bar. Appears at the top of
          the embedded admin whenever the form is dirty. The native <button>
          children inside SaveBar use App Bridge custom attributes (variant,
          loading) and are intentionally not Polaris components. */}
      <SaveBar id="seos-settings-save-bar" open={isDirty}>
        <button
          variant="primary"
          loading={saving ? "" : undefined}
          onClick={submitForm}
        >
          Save changes
        </button>
        <button onClick={discardChanges}>Discard</button>
      </SaveBar>
    </Page>
  );
}

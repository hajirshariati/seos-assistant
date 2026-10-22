import { useLoaderData, useActionData, useNavigation, Form, useFetcher } from "react-router";
import { visualizeLabel } from "../lib/visualize-cta.server";
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
} from "@shopify/polaris";
import { CheckCircleIcon } from "@shopify/polaris-icons";
import { TitleBar, SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { ALLOWED_MODELS, chatModel } from "../lib/claude-models.js";
import { getShopConfig, updateShopConfig } from "../models/ShopConfig.server";
import { backfillShopEmbeddings } from "../lib/embeddings.server";
import prisma from "../db.server";
import { getShopPlan } from "../lib/billing.server";
import { PlanGate } from "../components/PlanGate";
import BrandHeader from "../components/BrandHeader";
import { OrbColorsCard, VoiceInputCard } from "../components/AssistantLookCards";
import { TestRecordingCard } from "../components/TestRecordingCard";
import { recordingState, RECORD_DAYS } from "../lib/chat-recording.js";
import { parseOrbColors, serializeOrbColors, parseOrbBackground, serializeOrbBackground } from "../lib/orb-colors";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const config = await getShopConfig(session.shop);
  const plan = await getShopPlan(session.shop);
  let hideOnUrls = [];
  try { hideOnUrls = JSON.parse(config.hideOnUrls || "[]"); } catch { hideOnUrls = []; }
  return {
    hasAnthropicKey: config.anthropicApiKey !== "",
    anthropicModel: chatModel(config.anthropicModel),
    showFollowUps: config.showFollowUps !== false,
    showFeedback: config.showFeedback !== false,
    hasYotpoKey: config.yotpoApiKey !== "",
    hasAftershipKey: config.aftershipApiKey !== "",
    hideOnUrls,
    welcomeIntroOn: config.welcomeGlowStyle !== "none",
    orbColors: parseOrbColors(config.orbColors),
    orbBackground: parseOrbBackground(config.orbBackground),
    voiceInput: config.voiceInput !== false,
    recording: (() => { const st = recordingState(config); return { on: st.on, until: st.until ? st.until.toISOString() : null, scope: st.scope }; })(),
    shopDomain: session.shop,
    supportUrl: config.supportUrl || "",
    supportLabel: config.supportLabel || "",
    trackingPageUrl: config.trackingPageUrl || "",
    returnsPageUrl: config.returnsPageUrl || "",
    returnsInChat: config.returnsInChat !== false,
    returnWindowDays: Number.isFinite(config.returnWindowDays) ? config.returnWindowDays : 30,
    returnsDeliveredOnly: config.returnsDeliveredOnly !== false,
    storefrontSearchUrlPattern: config.storefrontSearchUrlPattern || "",
    referralPageUrl: config.referralPageUrl || "",
    klaviyoFormId: config.klaviyoFormId || "",
    klaviyoCompanyId: config.klaviyoCompanyId || "",
    klaviyoListId: config.klaviyoListId || "",
    vipModeEnabled: config.vipModeEnabled === true,
    showLoginPill: config.showLoginPill !== false,
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
    visualizeLookLabel: visualizeLabel(config),
    hasGeminiKey: (config.geminiApiKey || "") !== "",
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
  if (intent === "save_orb_colors") {
    const stored = serializeOrbColors([0, 1, 2, 3, 4].map((i) => formData.get(`c${i}`)));
    const bg = serializeOrbBackground(formData.get("bg"));
    if (stored === null || bg === null) return { orbError: "Each color needs to be a hex value like #1a4dff." };
    await updateShopConfig(session.shop, { orbColors: stored, orbBackground: bg });
    return { orbSaved: true, colors: parseOrbColors(stored), bg: parseOrbBackground(bg) };
  }

  if (intent === "save_recording") {
    const on = formData.get("on") === "true";
    const scope = formData.get("scope") === "everyone" ? "everyone" : "testers";
    const until = on ? new Date(Date.now() + RECORD_DAYS * 24 * 60 * 60 * 1000) : null;
    const saved = await updateShopConfig(session.shop, { recordChatsUntil: until, recordChatsScope: scope });
    const st = recordingState(saved);
    return { recording: { on: st.on, until: st.until ? st.until.toISOString() : null, scope: st.scope } };
  }

  if (intent === "save_voice_input") {
    await updateShopConfig(session.shop, { voiceInput: formData.get("on") === "true" });
    return { saved: true };
  }

  if (intent === "save_welcome_intro") {
    await updateShopConfig(session.shop, { welcomeGlowStyle: formData.get("on") === "true" ? "subtle" : "none" });
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
      visualizeLookLabel: label || "See It Styled",
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
  if (model && ALLOWED_MODELS.has(String(model))) data.anthropicModel = String(model);


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
  const returnsInChat = formData.get("returnsInChat");
  if (returnsInChat !== null) data.returnsInChat = returnsInChat === "true";
  const windowDays = formData.get("returnWindowDays");
  if (windowDays !== null) {
    const n = Number.parseInt(String(windowDays).trim(), 10);
    if (!Number.isFinite(n) || n < 0 || n > 365) return { error: "Return window must be a number of days from 0 to 365 (0 = no limit)." };
    data.returnWindowDays = n;
  }
  const deliveredOnly = formData.get("returnsDeliveredOnly");
  if (deliveredOnly !== null) data.returnsDeliveredOnly = deliveredOnly === "true";

  const storefrontSearchUrlPattern = formData.get("storefrontSearchUrlPattern");
  if (storefrontSearchUrlPattern !== null) data.storefrontSearchUrlPattern = storefrontSearchUrlPattern.trim();

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


  const vipToggle = formData.get("vipModeEnabled");
  if (vipToggle !== null) data.vipModeEnabled = vipToggle === "true";

  const loginPillToggle = formData.get("showLoginPill");
  if (loginPillToggle !== null) data.showLoginPill = loginPillToggle === "true";


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
    const before = await getShopConfig(session.shop);
    const saved = await updateShopConfig(session.shop, data);
    // Turning on semantic search (or changing its provider/key) embeds the
    // catalog in the background — no separate "Backfill" step to remember.
    const embeddingChanged =
      saved.embeddingProvider &&
      (saved.embeddingProvider !== before.embeddingProvider || data.voyageApiKey || data.openaiApiKey);
    if (embeddingChanged) {
      backfillShopEmbeddings(prisma, session.shop, saved)
        .then((r) => console.log(`[settings] auto-embed ${session.shop}:`, JSON.stringify(r)))
        .catch((err) => console.error(`[settings] auto-embed failed ${session.shop}:`, err?.message || err));
    }
  }

  return { success: true };
};

function VisualizeLookCard({ initialEnabled, initialProvider, initialLabel, hasGeminiKey, hasOpenaiKey }) {
  const fetcher = useFetcher();
  const [enabled, setEnabled] = useState(Boolean(initialEnabled));
  const [provider, setProvider] = useState(initialProvider || "");
  const [label, setLabel] = useState(initialLabel || "See It Styled");
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
          label="Enable “See It Styled”"
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

// One switch: the chat opens with a calm, Apple-style motion (the panel
// springs up, the welcome content rises in). No colors or timings to tune.
function WelcomeIntroCard({ initialOn }) {
  const fetcher = useFetcher();
  const [on, setOn] = useState(initialOn !== false);
  const toggle = (next) => {
    setOn(next);
    const fd = new FormData();
    fd.set("intent", "save_welcome_intro");
    fd.set("on", next ? "true" : "false");
    fetcher.submit(fd, { method: "post" });
  };
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center" wrap={false} gap="400">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">Opening animation</Text>
            <Text as="p" tone="subdued">
              When the chat opens, the panel springs up and the welcome message rises in — quick and subtle.
              Shoppers who prefer reduced motion never see it.
            </Text>
          </BlockStack>
          <Checkbox label={on ? "On" : "Off"} checked={on} onChange={toggle} />
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
  const { hasAnthropicKey, anthropicModel, showFollowUps: initFollowUps, showFeedback: initFeedback, hasYotpoKey, hasAftershipKey, hideOnUrls, supportUrl: initSupportUrl, supportLabel: initSupportLabel, trackingPageUrl: initTrackingPageUrl, returnsPageUrl: initReturnsPageUrl, returnsInChat: initReturnsInChat, returnWindowDays: initReturnWindowDays, returnsDeliveredOnly: initReturnsDeliveredOnly, storefrontSearchUrlPattern: initSearchPattern, referralPageUrl: initReferralPageUrl, klaviyoFormId: initKlaviyoFormId, klaviyoCompanyId: initKlaviyoCompanyId, klaviyoListId: initKlaviyoListId, vipModeEnabled: initVipMode, showLoginPill: initShowLoginPill, hasYotpoLoyaltyKey, yotpoLoyaltyGuid: initYotpoLoyaltyGuid, loyaltyDisplay: initLoyaltyDisplay, loyaltyPointsPerDollar: initLoyaltyPointsPerDollar, loyaltyRounding: initLoyaltyRounding, dailyCapEnabled: initDailyCapEnabled, dailyCapMessages: initDailyCapMessages, embeddingProvider: initEmbeddingProvider, hasVoyageKey, hasOpenaiKey, visualizeLookEnabled: initVizEnabled, imageProvider: initImageProvider, visualizeLookLabel: initVizLabel, hasGeminiKey, plan, welcomeIntroOn, orbColors, orbBackground, voiceInput, recording, shopDomain } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  const [anthropicKey, setAnthropicKey] = useState("");
  const [showOptional, setShowOptional] = useState(false);
  const [model, setModel] = useState(anthropicModel || "claude-sonnet-4-6");
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
  const [returnsInChat, setReturnsInChat] = useState(initReturnsInChat);
  const [returnWindowDays, setReturnWindowDays] = useState(String(initReturnWindowDays));
  const [returnsDeliveredOnly, setReturnsDeliveredOnly] = useState(initReturnsDeliveredOnly);
  const [referralPageUrl, setReferralPageUrl] = useState(initReferralPageUrl);
  const [searchPattern, setSearchPattern] = useState(initSearchPattern);
  const [klaviyoFormId, setKlaviyoFormId] = useState(initKlaviyoFormId);
  const [klaviyoCompanyId, setKlaviyoCompanyId] = useState(initKlaviyoCompanyId);
  const [klaviyoListId, setKlaviyoListId] = useState(initKlaviyoListId);
  const [vipMode, setVipMode] = useState(initVipMode);
  const [showLoginPill, setShowLoginPill] = useState(initShowLoginPill);
  const [dailyCapEnabled, setDailyCapEnabled] = useState(initDailyCapEnabled);
  const [dailyCapMessages, setDailyCapMessages] = useState(String(initDailyCapMessages ?? 200));
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
    followUps: initFollowUps,
    feedbackOn: initFeedback,
    supportUrl: initSupportUrl,
    supportLabel: initSupportLabel,
    trackingPageUrl: initTrackingPageUrl,
    returnsPageUrl: initReturnsPageUrl,
    returnsInChat: initReturnsInChat,
    returnWindowDays: String(initReturnWindowDays),
    returnsDeliveredOnly: initReturnsDeliveredOnly,
    referralPageUrl: initReferralPageUrl,
    searchPattern: initSearchPattern,
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
      setYotpoLoyaltyKey("");
      setVoyageKey("");
      setOpenaiKey("");
    }
    if (actionData?.error && typeof window !== "undefined" && window.shopify?.toast) window.shopify.toast.show(actionData.error, { isError: true });
  }, [actionData]);

  const discardChanges = () => {
    const s = initialSnapshot.current;
    setAnthropicKey("");
    setModel(s.model);
    setFollowUps(s.followUps);
    setFeedbackOn(s.feedbackOn);
    setYotpoKey("");
    setAftershipKey("");
    setSupportUrl(s.supportUrl);
    setSupportLabel(s.supportLabel);
    setTrackingPageUrl(s.trackingPageUrl);
    setReturnsPageUrl(s.returnsPageUrl);
    setReturnsInChat(s.returnsInChat);
    setReturnWindowDays(s.returnWindowDays);
    setReturnsDeliveredOnly(s.returnsDeliveredOnly);
    setReferralPageUrl(s.referralPageUrl);
    setSearchPattern(s.searchPattern);
    setKlaviyoFormId(s.klaviyoFormId);
    setKlaviyoCompanyId(s.klaviyoCompanyId);
    setKlaviyoListId(s.klaviyoListId);
    setVipMode(s.vipMode);
    setShowLoginPill(s.showLoginPill);
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

  const optionalOn = [
    embeddingProvider ? "semantic search" : null,
    initVizEnabled ? "styling previews" : null,
    hasYotpoKey || hasAftershipKey || klaviyoCompanyId ? "integrations" : null,
    vipMode ? "VIP experience" : null,
    dailyCapEnabled ? "daily limit" : null,
  ].filter(Boolean);

  return (
    <Page>
      <TitleBar title="Settings" />
      <Form method="post" ref={formRef} onChange={() => setIsDirty(true)}>
        <BlockStack gap="500">
          <BrandHeader title="Settings" gutter={false} />
          {/* Save feedback is an always-visible App Bridge toast, not a top banner. */}

          {/* Data-Eraser-style settings: single-column annotated sections —
              section title above a full-width hairline card, tight spacing, a
              hairline divider between sections. Overrides Polaris' default
              two-column annotated layout (which renders the description in a
              narrow left rail). Page-scoped so it only affects Settings. */}
          <style>{`
            .set-intro { font-size: 13.5px; color: #5e6f67; max-width: 760px; margin: -6px 0 2px; }
            /* Polaris offsets Layout with a negative margin (-space-400) that
               its sections add back (+space-400) to land at the page edge.
               Zeroing the section margin below would leave that negative
               margin uncompensated and shove all content ~16px LEFT of the
               BrandHeader/intro. Zero the Layout margin too so the section,
               header, and intro share one left edge. */
            .Polaris-Layout { margin: 0 !important; }
            .Polaris-Layout__AnnotationWrapper { display: block; margin: 0; }
            .Polaris-Layout__Annotation,
            .Polaris-Layout__AnnotationContent { display: block; margin: 0; max-width: 100%; width: 100%; }
            .Polaris-Layout__Annotation { padding: 0 0 12px 0; }
            .Polaris-Layout__AnnotatedSection { margin: 0 !important; max-width: 100% !important; }
            .Polaris-Layout__AnnotatedSection + .Polaris-Layout__AnnotatedSection {
              border-top: 1px solid rgba(30,27,51,0.08);
              margin-top: 24px !important;
              padding-top: 24px !important;
            }
            /* The "Get your API key here" helper links are raw <a> tags, so
               they don't pick up Polaris' --p-color-text-link token and fall
               back to the browser's blue/visited-purple default — jarring in
               the green theme. Force the brand green on settings-page links. */
            .Polaris-Layout__Annotation a,
            .Polaris-Layout__AnnotationContent a { color: #2D6B4F; text-underline-offset: 2px; }
            .set-optional { border-top: 1px solid rgba(30,27,51,0.08); margin-top: 24px; padding-top: 24px; }
            .Polaris-Layout__Annotation a:hover,
            .Polaris-Layout__AnnotationContent a:hover { color: #245741; }
          `}</style>
          <p className="set-intro">Most stores only need the first few sections below. Everything under "Optional add-ons" can be left as it is.</p>

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
              title="AI model"
              description={
                <BlockStack gap="200">
                  <Text as="p" tone="subdued" variant="bodySm">
                    Which Claude model answers your customers. The default is the best balance of quality, speed and cost.
                  </Text>
                </BlockStack>
              }
            >
              <Card>
                <BlockStack gap="400">
                  <Select
                    label="Model"
                    options={MODEL_OPTIONS.filter(
                      (o) => o.value !== "claude-opus-4-7" || plan.features?.advancedModel,
                    )}
                    value={model}
                    onChange={setModel}
                    helpText="Standard is recommended — every answer is fact-checked, so a bigger model mostly adds cost and wait time."
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Support link"
              description="When a customer needs a person, the assistant shows a button that opens your live chat (Zendesk, Intercom or Gorgias) if your store has one, otherwise this page. This link overrides the Support URL in the theme editor."
            >
              <Card>
                <BlockStack gap="400">
                  <TextField
                    label="Support page URL"
                    value={supportUrl}
                    onChange={setSupportUrl}
                    placeholder="https://yourstore.com/pages/contact"
                    autoComplete="off"
                    helpText="Left blank, the theme editor's Support URL is used."
                  />
                  <TextField
                    label="Button label (optional)"
                    value={supportLabel}
                    onChange={setSupportLabel}
                    placeholder="Chat with Aetrex Support"
                    autoComplete="off"
                    helpText="Shown exactly as typed. Left blank, it reads “Chat with Aetrex Support”."
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
                    helpText="Your AfterShip Returns page. Used for “View return” after a return is started in the chat, and as the fallback (prefilled with the order number and email) when a return can't be started in the chat."
                  />
                  <Checkbox
                    label="Returns and exchanges in the chat"
                    checked={returnsInChat}
                    onChange={setReturnsInChat}
                    helpText={returnsInChat
                      ? "On: signed-in shoppers start returns and exchanges right in the chat (uses the AfterShip API key). Turn off to send them to the returns page instead."
                      : "Off: order cards show “Start a return”, which opens the returns page above with the order filled in. Order tracking is unaffected."}
                  />
                  <TextField
                    label="Return window (days)"
                    type="number"
                    min={0}
                    max={365}
                    value={returnWindowDays}
                    onChange={setReturnWindowDays}
                    autoComplete="off"
                    suffix="days after the order is placed"
                    helpText="Orders older than this don't get a return button, and the assistant explains why. 0 = no limit. Match your return policy."
                  />
                  <Checkbox
                    label="Only after the order is delivered"
                    checked={returnsDeliveredOnly}
                    onChange={setReturnsDeliveredOnly}
                    helpText={returnsDeliveredOnly
                      ? "On: the return button appears once the order shows as delivered."
                      : "Off: the return button appears as soon as the order has shipped."}
                  />
                  <TextField
                    label="Search results page"
                    value={searchPattern}
                    onChange={setSearchPattern}
                    placeholder="/search?q={q}&type=product"
                    autoComplete="off"
                    helpText="The 'View all' button under a set of product cards (e.g. 'View all Women's Sandals') opens your store's search — it's paused for now, so this pattern isn't used yet. Put {q} where the search words go. Leave blank to use Shopify's standard search page."
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
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Widget visibility"
              description="Choose which pages show the chat, and whether it opens with a subtle animation."
            >
              <BlockStack gap="400">
                <HideUrlsPanel initial={hideOnUrls} />
                <WelcomeIntroCard initialOn={welcomeIntroOn} />
              </BlockStack>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Assistant look & voice"
              description="The colors of the assistant's animated mark, and the talk button in the chat."
            >
              <BlockStack gap="400">
                <OrbColorsCard initial={orbColors} initialBg={orbBackground} />
                <VoiceInputCard initialOn={voiceInput} />
              </BlockStack>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Testing"
              description="Record conversations while your team tests the assistant, then review them under Test recordings."
            >
              <TestRecordingCard initial={recording} shopDomain={shopDomain} />
            </Layout.AnnotatedSection>

            <Layout.Section>
              <div className="set-optional">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">Optional add-ons</Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    {optionalOn.length > 0
                      ? `Turned on: ${optionalOn.join(", ")}.`
                      : "None turned on. Your assistant works fully without these."}
                    {" "}Semantic search, styling previews, Yotpo/Klaviyo/AfterShip integrations, VIP customer experience and a daily message limit.
                  </Text>
                  <InlineStack>
                    <Button onClick={() => setShowOptional((v) => !v)} disclosure={showOptional ? "up" : "down"}>
                      {showOptional ? "Hide optional settings" : "Show optional settings"}
                    </Button>
                  </InlineStack>
                </BlockStack>
              </div>
            </Layout.Section>

            {showOptional && (
              <>
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
                        After you save, your catalog is embedded automatically in the background (a few minutes). New and updated products are embedded as they change. Progress shows on the Catalog page.
                      </Text>
                    </Banner>
                  )}
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="See It Styled (AI styling preview)"
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
                        In-chat returns: signed-in customers pick the items and a reason in the chat and the return is created in AfterShip Returns (your return rules, labels and emails stay as they are). "Too small" / "Too large" also offers an exchange: the return plus the same shoe in the next size, ready to add to cart.
                      </Text>
                      <TextField
                        label="AfterShip Returns API key"
                        labelHidden
                        type="password"
                        value={aftershipKey}
                        onChange={setAftershipKey}
                        placeholder={hasAftershipKey ? "••••••••••••••••" : "Paste key to enable"}
                        autoComplete="off"
                        helpText="An AfterShip Returns API key (Settings → API keys in AfterShip; your plan needs API access). Without it, the chat sends customers to the returns page below, with their order filled in."
                      />
                    </BlockStack>
                  </Card>
                </PlanGate>

                <PlanGate
                  plan={plan}
                  feature="klaviyoIntegration"
                  summary="Show a newsletter signup form in the chat."
                >
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingMd">Klaviyo</Text>
                    </InlineStack>
                    <Text as="p" tone="subdued" variant="bodySm">
                      Lets the assistant offer a newsletter signup form in the chat when a customer wants deals or updates.
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
              </>
            )}
          </Layout>

          <input type="hidden" name="anthropicApiKey" value={anthropicKey} />
          <input type="hidden" name="anthropicModel" value={model} />
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
          <input type="hidden" name="returnsInChat" value={String(returnsInChat)} />
          <input type="hidden" name="returnWindowDays" value={returnWindowDays} />
          <input type="hidden" name="returnsDeliveredOnly" value={String(returnsDeliveredOnly)} />
          <input type="hidden" name="referralPageUrl" value={referralPageUrl} />
          <input type="hidden" name="storefrontSearchUrlPattern" value={searchPattern} />
          <input type="hidden" name="klaviyoFormId" value={klaviyoFormId} />
          <input type="hidden" name="klaviyoCompanyId" value={klaviyoCompanyId} />
          <input type="hidden" name="klaviyoListId" value={klaviyoListId} />
          <input type="hidden" name="vipModeEnabled" value={String(vipMode)} />
          <input type="hidden" name="showLoginPill" value={String(showLoginPill)} />
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

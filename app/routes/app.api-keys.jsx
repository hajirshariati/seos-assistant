import { typeformId, FEEDBACK_COLORS, FEEDBACK_ICONS, storepointId, locatorPageUrl } from "../lib/feedback-survey.js";
import { chatRatingConfig } from "../lib/chat-rating.js";
import { appLinkError, cleanAppText, defaultAppText, appImageError, APP_TEXT_MAX, APP_BUTTON_MAX } from "../lib/app-promo.js";
import { getShopName } from "../lib/shop-name.server.js";
import { CHAT_TEXT_FIELDS, chatTextsFromForm, chatTextsForForm } from "../lib/chat-texts.js";
import { buyNowCodeError, BUY_NOW_CODE_MAX } from "../lib/buy-now.js";
import { useLoaderData, useActionData, useNavigation, Form, useFetcher, useRevalidator } from "react-router";
import { visualizeLabel } from "../lib/visualize-cta.server";
import { useState, useEffect, useMemo, useRef } from "react";
import {
  Page,
  BlockStack,
  InlineStack,
  TextField,
  Select,
  Button,
  Banner,
  Text,
  Badge,
  ButtonGroup,
  Box,
  Icon,
} from "@shopify/polaris";
import {
  MagicIcon,
  PaintBrushFlatIcon,
  ViewIcon,
  ChatIcon,
  CartIcon,
  ConnectIcon,
  GaugeIcon,
  PlayCircleIcon,
  CheckCircleIcon,
  FlowerIcon,
} from "@shopify/polaris-icons";
import { TitleBar, SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { ALLOWED_MODELS, chatModel } from "../lib/claude-models.js";
import { getShopConfig, updateShopConfig } from "../models/ShopConfig.server";
import { getChatPulse } from "../models/ChatHealth.server";
import { backfillShopEmbeddings } from "../lib/embeddings.server";
import prisma from "../db.server";
import { getShopPlan } from "../lib/billing.server";
import BrandHeader from "../components/BrandHeader";
import { OrbColorsCard } from "../components/AssistantLookCards";
import { TestRecordingCard } from "../components/TestRecordingCard";
import { SETTINGS_CSS, Row, Group, SectionHead, SettingsNav, Stat, Switch } from "../components/SettingsUI";
import { recordingState, RECORD_DAYS } from "../lib/chat-recording.js";
import { parseOrbColors, serializeOrbColors, parseOrbBackground, serializeOrbBackground } from "../lib/orb-colors";
import { clampDelay, startTheme, parseCountries, APPEAR_DELAY_MIN, APPEAR_DELAY_MAX } from "../lib/appear-delay.js";
import { pageHandleFromUrl } from "../lib/promo-page.js";
import { NORMAL_LIMITS, PEAK_LIMITS, LIMIT_MAX, PEAK_MODES, peakState, storeChatLimits } from "../lib/peak-mode.js";
import { seasonOf, colorOf, collectionHandle, LABEL_MAX } from "../lib/seasonal-cta.js";
import { findCollection } from "../lib/seasonal-cta.server.js";
import { SeasonalSection } from "../components/SeasonalButton";

const iso = (d) => (d ? new Date(d).toISOString() : "");

// The seasonal button's collection as the store has it now (title, size),
// or { missing } when it's gone; null when it can't be checked.
async function seasonalInfo(admin, handle) {
  if (!handle) return null;
  try {
    const c = await findCollection(admin, handle);
    return c || { handle, missing: true };
  } catch {
    return null;
  }
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const [config, plan, pulse, shopName] = await Promise.all([
    getShopConfig(session.shop),
    getShopPlan(session.shop),
    getChatPulse(session.shop).catch(() => null),
    getShopName(admin, session.shop),
  ]);
  const seasonalHandle = collectionHandle(config.seasonalCtaCollection);
  let hideOnUrls = [];
  try { hideOnUrls = JSON.parse(config.hideOnUrls || "[]"); } catch { hideOnUrls = []; }
  return {
    hasAnthropicKey: config.anthropicApiKey !== "",
    anthropicModel: chatModel(config.anthropicModel),
    showFollowUps: config.showFollowUps !== false,
    showFeedback: config.showFeedback !== false,
    chatRatingOn: config.chatRatingOn !== false,
    chatRatingAfter: chatRatingConfig(config).after,
    hasYotpoKey: config.yotpoApiKey !== "",
    hasAftershipKey: config.aftershipApiKey !== "",
    hideOnUrls: Array.isArray(hideOnUrls) ? hideOnUrls : [],
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
    guestOrderLookup: config.guestOrderLookup !== false,
    feedbackSurveyOn: config.feedbackSurveyOn === true,
    feedbackSurvey: config.feedbackSurvey || "",
    feedbackSurveyLabel: config.feedbackSurveyLabel || "Share feedback",
    feedbackSurveyColor: FEEDBACK_COLORS.includes(config.feedbackSurveyColor) ? config.feedbackSurveyColor : "teal",
    feedbackSurveyIcon: FEEDBACK_ICONS.includes(config.feedbackSurveyIcon) ? config.feedbackSurveyIcon : "feedback",
    feedbackSurveyHideAfter: config.feedbackSurveyHideAfter !== false,
    seasonalCtaOn: config.seasonalCtaOn === true,
    seasonalCtaIcon: seasonOf(config.seasonalCtaIcon),
    seasonalCtaColor: colorOf(config.seasonalCtaColor),
    seasonalCtaLabel: config.seasonalCtaLabel || "",
    seasonalCtaCollection: seasonalHandle,
    seasonalInfo: await seasonalInfo(admin, seasonalHandle),
    whichOrthotic: config.whichOrthotic || "",
    whichOrthoticLabel: config.whichOrthoticLabel || "Identify my orthotic",
    storeLocatorMapId: config.storeLocatorMapId || "",
    storeLocatorLabel: config.storeLocatorLabel || "Find a store near you",
    storeLocatorUrl: config.storeLocatorUrl || "",
    appPromoOn: config.appPromoOn !== false,
    appIosUrl: config.appIosUrl || "",
    appAndroidUrl: config.appAndroidUrl || "",
    appPromoText: config.appPromoText || "",
    appPromoButton: config.appPromoButton || "",
    appPromoDefaultText: defaultAppText(shopName),
    appPromoImage: config.appPromoImage || "",
    buyNowEnabled: config.buyNowEnabled === true,
    buyNowCode: config.buyNowCode || "",
    hideLiveChatButton: config.hideLiveChatButton === true,
    appearDelayOn: config.appearDelayOn === true,
    appearDelaySec: clampDelay(config.appearDelaySec),
    startTheme: startTheme(config.startTheme),
    ...chatTextsForForm(config.chatTexts),
    hideInternational: config.hideInternational !== false,
    homeCountries: parseCountries(config.homeCountries).join(", "),
    promoPageUrl: config.promoPageUrl || "",
    promoPageStop: config.promoPageStop || "",
    referralPageUrl: config.referralPageUrl || "",
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
    // Peak Mode and the store-wide chat limits.
    chatLimitPerMin: config.chatLimitPerMin ?? NORMAL_LIMITS.perMin,
    chatLimitPerHour: config.chatLimitPerHour ?? NORMAL_LIMITS.perHour,
    peakMode: PEAK_MODES.includes(config.peakMode) ? config.peakMode : "off",
    peakStartsAt: iso(config.peakStartsAt),
    peakEndsAt: iso(config.peakEndsAt),
    peakLimitPerMin: config.peakLimitPerMin ?? PEAK_LIMITS.perMin,
    peakLimitPerHour: config.peakLimitPerHour ?? PEAK_LIMITS.perHour,
    peakLiftDailyCap: config.peakLiftDailyCap !== false,
    peakPauseSync: config.peakPauseSync !== false,
    limitsOverridden: storeChatLimits(config, { env: process.env }).overridden,
    pulse,
    plan: { id: plan.id, name: plan.name, features: plan.features },
  };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  // Cards that save on their own (orb colors, test recordings, See It
  // Styled) submit with an intent through useFetcher.
  const intent = formData.get("intent");
  if (intent === "save_orb_colors") {
    const stored = serializeOrbColors([0, 1, 2, 3, 4].map((i) => formData.get(`c${i}`)));
    const bg = serializeOrbBackground(formData.get("bg"));
    if (stored === null || bg === null) return { orbError: "Each color needs to be a hex value like #1a4dff." };
    await updateShopConfig(session.shop, { orbColors: stored, orbBackground: bg });
    return { orbSaved: true, colors: parseOrbColors(stored), bg: parseOrbBackground(bg) };
  }

  // Your app → the app's picture (resized in the browser before it's sent).
  if (intent === "save_app_image") {
    const image = String(formData.get("image") || "");
    const err = appImageError(image);
    if (err) return { appImageError: err };
    await updateShopConfig(session.shop, { appPromoImage: image });
    return { appImageSaved: true, appImage: image };
  }

  if (intent === "save_recording") {
    const on = formData.get("on") === "true";
    const scope = formData.get("scope") === "everyone" ? "everyone" : "testers";
    const until = on ? new Date(Date.now() + RECORD_DAYS * 24 * 60 * 60 * 1000) : null;
    const saved = await updateShopConfig(session.shop, { recordChatsUntil: until, recordChatsScope: scope });
    const st = recordingState(saved);
    return { recording: { on: st.on, until: st.until ? st.until.toISOString() : null, scope: st.scope } };
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
  // A problem points back at the section it's in, so the page can open it.
  const fail = (error, section) => ({ error, section });
  const bool = (name, field = name) => {
    const v = formData.get(name);
    if (v !== null) data[field] = v === "true";
  };
  const text = (name, max = 500) => {
    const v = formData.get(name);
    if (v !== null) data[name] = String(v).trim().slice(0, max);
  };
  const secret = (name) => {
    const v = formData.get(name);
    if (v !== null && v !== "") data[name] = v;
  };

  // Assistant
  secret("anthropicApiKey");
  const model = formData.get("anthropicModel");
  if (model && ALLOWED_MODELS.has(String(model))) data.anthropicModel = String(model);
  bool("showFollowUps");
  bool("showFeedback");
  bool("chatRatingOn");
  const ratingAfter = formData.get("chatRatingAfter");
  if (ratingAfter !== null) data.chatRatingAfter = chatRatingConfig({ chatRatingAfter: ratingAfter }).after;

  // Look & feel
  const startLook = formData.get("startTheme");
  if (startLook !== null) data.startTheme = startTheme(String(startLook));
  const intro = formData.get("welcomeIntroOn");
  if (intro !== null) data.welcomeGlowStyle = intro === "true" ? "subtle" : "none";
  bool("voiceInput");

  // Where it shows
  bool("appearDelayOn");
  const delaySec = formData.get("appearDelaySec");
  if (delaySec !== null) {
    const n = Number.parseInt(String(delaySec).trim(), 10);
    if (data.appearDelayOn && (!Number.isFinite(n) || n < APPEAR_DELAY_MIN || n > APPEAR_DELAY_MAX)) return fail(`The delay should be a whole number of seconds from ${APPEAR_DELAY_MIN} to ${APPEAR_DELAY_MAX}.`, "visibility");
    data.appearDelaySec = clampDelay(n);
  }
  bool("hideInternational");
  const homeCountries = formData.get("homeCountries");
  if (homeCountries !== null) data.homeCountries = parseCountries(homeCountries).join(",");
  const hideUrlsRaw = formData.get("hideOnUrls");
  if (hideUrlsRaw !== null) {
    try {
      const parsed = JSON.parse(hideUrlsRaw);
      if (Array.isArray(parsed)) data.hideOnUrls = JSON.stringify(parsed);
    } catch { /* ignore invalid JSON */ }
  }
  bool("hideLiveChatButton");

  // Chat text: saved together, only when the form sent them.
  if (CHAT_TEXT_FIELDS.some(([, field]) => formData.get(field) !== null)) {
    data.chatTexts = chatTextsFromForm((field) => formData.get(field));
  }

  // Customer care
  text("supportUrl");
  text("supportLabel");
  text("trackingPageUrl");
  text("returnsPageUrl");
  bool("returnsInChat");
  bool("guestOrderLookup");
  const windowDays = formData.get("returnWindowDays");
  if (windowDays !== null) {
    const n = Number.parseInt(String(windowDays).trim(), 10);
    if (!Number.isFinite(n) || n < 0 || n > 365) return fail("Return window must be a number of days from 0 to 365 (0 = no limit).", "care");
    data.returnWindowDays = n;
  }
  bool("returnsDeliveredOnly");

  // Shopping tools
  const promoUrl = formData.get("promoPageUrl");
  const promoStop = formData.get("promoPageStop");
  if (promoUrl !== null) {
    const u = String(promoUrl).trim();
    if (u && !pageHandleFromUrl(u)) return fail("The promotions page should be a page link, like https://yourstore.com/pages/terms-conditions.", "tools");
    if (u && !String(promoStop || "").trim()) return fail("Add the line where the promotions end on that page, so only the offers above it are used.", "tools");
    data.promoPageUrl = u.slice(0, 500);
  }
  if (promoStop !== null) data.promoPageStop = String(promoStop).trim().slice(0, 200);
  const which = formData.get("whichOrthotic");
  if (which !== null) {
    const raw = String(which).trim();
    if (raw && !typeformId(raw)) return fail("The orthotic quiz should be a Typeform form ID (like ojyWbTvZ) or its link.", "tools");
    data.whichOrthotic = raw;
  }
  const whichLabel = formData.get("whichOrthoticLabel");
  if (whichLabel !== null) data.whichOrthoticLabel = String(whichLabel).trim().slice(0, 40) || "Identify my orthotic";
  const locMap = formData.get("storeLocatorMapId");
  if (locMap !== null) {
    const raw = String(locMap).trim();
    const id = storepointId(raw);
    if (raw && !id) return fail("The store locator should be your Storepoint map ID (like 15ecd30bd8acd4) or its embed code.", "tools");
    data.storeLocatorMapId = id;
  }
  const locLabel = formData.get("storeLocatorLabel");
  if (locLabel !== null) data.storeLocatorLabel = String(locLabel).trim().slice(0, 40) || "Find a store near you";
  const locUrl = formData.get("storeLocatorUrl");
  if (locUrl !== null) {
    const raw = String(locUrl).trim();
    if (raw && !locatorPageUrl(raw)) return fail("The store locator page should be a link on your store, like /pages/store-locator or https://…", "tools");
    data.storeLocatorUrl = raw;
  }
  const surveyOn = formData.get("feedbackSurveyOn");
  const survey = formData.get("feedbackSurvey");
  if (survey !== null) {
    const raw = String(survey).trim();
    if (raw && !typeformId(raw)) return fail("The feedback survey should be a Typeform form ID (like jdXBrXMa) or its link.", "tools");
    data.feedbackSurvey = raw;
  }
  if (surveyOn !== null) {
    data.feedbackSurveyOn = surveyOn === "true";
    if (data.feedbackSurveyOn && !typeformId(survey ?? "")) return fail("Add your Typeform survey (its ID or link) to show the feedback button.", "tools");
  }
  const surveyLabel = formData.get("feedbackSurveyLabel");
  if (surveyLabel !== null) data.feedbackSurveyLabel = String(surveyLabel).trim().slice(0, 40) || "Share feedback";
  const surveyColor = formData.get("feedbackSurveyColor");
  if (surveyColor !== null) data.feedbackSurveyColor = FEEDBACK_COLORS.includes(surveyColor) ? surveyColor : "teal";
  const surveyIcon = formData.get("feedbackSurveyIcon");
  if (surveyIcon !== null) data.feedbackSurveyIcon = FEEDBACK_ICONS.includes(surveyIcon) ? surveyIcon : "feedback";
  bool("feedbackSurveyHideAfter");
  // Your app: only the App Store / Google Play pages themselves.
  bool("appPromoOn");
  for (const [field, platform] of [["appIosUrl", "ios"], ["appAndroidUrl", "android"]]) {
    const v = formData.get(field);
    if (v === null) continue;
    const raw = String(v).trim();
    const err = appLinkError(platform, raw);
    if (err) return fail(err, "tools");
    data[field] = raw;
  }
  const appText = formData.get("appPromoText");
  if (appText !== null) data.appPromoText = cleanAppText(appText);
  const appButton = formData.get("appPromoButton");
  if (appButton !== null) data.appPromoButton = cleanAppText(appButton, APP_BUTTON_MAX);
  // Buy now: off by default; its code goes into a link as it is.
  bool("buyNowEnabled");
  const buyCode = formData.get("buyNowCode");
  if (buyCode !== null) {
    const err = buyNowCodeError(buyCode);
    if (err) return fail(err, "tools");
    data.buyNowCode = String(buyCode).trim();
  }

  // Seasonal button
  bool("seasonalCtaOn");
  const seaIcon = formData.get("seasonalCtaIcon");
  if (seaIcon !== null) data.seasonalCtaIcon = seasonOf(String(seaIcon));
  const seaColor = formData.get("seasonalCtaColor");
  if (seaColor !== null) data.seasonalCtaColor = colorOf(String(seaColor));
  const seaLabel = formData.get("seasonalCtaLabel");
  if (seaLabel !== null) data.seasonalCtaLabel = String(seaLabel).replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
  const seaCollection = formData.get("seasonalCtaCollection");
  if (seaCollection !== null) {
    const raw = String(seaCollection).trim();
    const handle = collectionHandle(raw);
    if (raw && !handle) return fail("The collection should be its handle (like fall-collection) or its link.", "seasonal");
    const current = await getShopConfig(session.shop);
    if (!handle) {
      data.seasonalCtaCollection = "";
      data.seasonalCtaCollectionTitle = "";
    } else if (handle !== current.seasonalCtaCollection || !current.seasonalCtaCollectionTitle) {
      // Checked against the store when it changes. If Shopify can't be
      // reached, the handle is kept and checked again on the next save.
      let found;
      try { found = await findCollection(admin, handle); } catch { found = undefined; }
      if (found === null) return fail(`There's no collection "${handle}" on your store. Use Browse to pick one.`, "seasonal");
      data.seasonalCtaCollection = found?.handle || handle;
      data.seasonalCtaCollectionTitle = found?.title || "";
    }
  }
  if (data.seasonalCtaOn && !collectionHandle(seaCollection ?? "")) return fail("Choose the collection the seasonal button shows.", "seasonal");

  // Integrations
  secret("yotpoApiKey");
  secret("aftershipApiKey");
  secret("yotpoLoyaltyApiKey");
  text("yotpoLoyaltyGuid");
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
  text("referralPageUrl");
  text("klaviyoCompanyId");
  text("klaviyoListId");
  const embeddingProvider = formData.get("embeddingProvider");
  if (embeddingProvider !== null) {
    const v = String(embeddingProvider).trim();
    if (v === "" || v === "voyage" || v === "openai") data.embeddingProvider = v;
  }
  secret("voyageApiKey");
  secret("openaiApiKey");
  bool("showLoginPill");
  bool("vipModeEnabled");

  // Peak Mode and chat limits
  const limit = (name, max) => {
    const raw = formData.get(name);
    if (raw === null) return null;
    const s = String(raw).trim();
    if (!/^\d+$/.test(s)) return fail("Chat limits are whole numbers of messages (0 = no limit).", "peak");
    data[name] = Math.min(Number.parseInt(s, 10), max);
    return null;
  };
  for (const [name, max] of [["chatLimitPerMin", LIMIT_MAX.perMin], ["chatLimitPerHour", LIMIT_MAX.perHour], ["peakLimitPerMin", LIMIT_MAX.perMin], ["peakLimitPerHour", LIMIT_MAX.perHour]]) {
    const bad = limit(name, max);
    if (bad) return bad;
  }
  const peakMode = formData.get("peakMode");
  if (peakMode !== null) data.peakMode = PEAK_MODES.includes(peakMode) ? peakMode : "off";
  const when = (name) => {
    const raw = formData.get(name);
    if (raw === null) return undefined;
    const d = String(raw).trim() ? new Date(String(raw)) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  };
  const startsAt = when("peakStartsAt");
  const endsAt = when("peakEndsAt");
  if (startsAt !== undefined) data.peakStartsAt = startsAt;
  if (endsAt !== undefined) data.peakEndsAt = endsAt;
  if (data.peakMode === "scheduled") {
    if (!data.peakStartsAt) return fail("Pick the day Peak Mode starts.", "peak");
    if (data.peakEndsAt && data.peakEndsAt <= data.peakStartsAt) return fail("Peak Mode's last day has to be on or after its first day.", "peak");
  }
  bool("peakLiftDailyCap");
  bool("peakPauseSync");
  bool("dailyCapEnabled");
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

// ── Page ─────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: "assistant", label: "Assistant", icon: MagicIcon },
  { id: "look", label: "Look & feel", icon: PaintBrushFlatIcon },
  { id: "seasonal", label: "Seasonal button", icon: FlowerIcon },
  { id: "visibility", label: "Where it shows", icon: ViewIcon },
  { id: "care", label: "Customer care", icon: ChatIcon },
  { id: "tools", label: "Shopping tools", icon: CartIcon },
  { id: "integrations", label: "Integrations", icon: ConnectIcon },
  { id: "peak", label: "Peak Mode", icon: GaugeIcon },
  { id: "testing", label: "Testing", icon: PlayCircleIcon },
];

// Every field the Save button sends, the section it lives in, and its kind
// ("bool" → "true"/"false", "json" → JSON, "secret" → cleared after a save).
const FIELDS = {
  anthropicApiKey: ["assistant", "secret"], anthropicModel: ["assistant"], showFollowUps: ["assistant", "bool"],
  showFeedback: ["assistant", "bool"], chatRatingOn: ["assistant", "bool"], chatRatingAfter: ["assistant"],
  startTheme: ["look"], welcomeIntroOn: ["look", "bool"], voiceInput: ["look", "bool"],
  ...Object.fromEntries(CHAT_TEXT_FIELDS.map(([, field]) => [field, ["look"]])),
  appearDelayOn: ["visibility", "bool"], appearDelaySec: ["visibility"], hideInternational: ["visibility", "bool"],
  homeCountries: ["visibility"], hideOnUrls: ["visibility", "json"], hideLiveChatButton: ["visibility", "bool"],
  supportUrl: ["care"], supportLabel: ["care"], trackingPageUrl: ["care"], returnsPageUrl: ["care"],
  returnsInChat: ["care", "bool"], returnWindowDays: ["care"], returnsDeliveredOnly: ["care", "bool"], guestOrderLookup: ["care", "bool"],
  promoPageUrl: ["tools"], promoPageStop: ["tools"], whichOrthotic: ["tools"], whichOrthoticLabel: ["tools"],
  storeLocatorMapId: ["tools"], storeLocatorLabel: ["tools"], storeLocatorUrl: ["tools"],
  feedbackSurveyOn: ["tools", "bool"], feedbackSurvey: ["tools"], feedbackSurveyLabel: ["tools"],
  feedbackSurveyColor: ["tools"], feedbackSurveyIcon: ["tools"], feedbackSurveyHideAfter: ["tools", "bool"],
  appPromoOn: ["tools", "bool"], appIosUrl: ["tools"], appAndroidUrl: ["tools"], appPromoText: ["tools"], appPromoButton: ["tools"],
  buyNowEnabled: ["tools", "bool"], buyNowCode: ["tools"],
  seasonalCtaOn: ["seasonal", "bool"], seasonalCtaIcon: ["seasonal"], seasonalCtaColor: ["seasonal"],
  seasonalCtaLabel: ["seasonal"], seasonalCtaCollection: ["seasonal"],
  yotpoApiKey: ["integrations", "secret"], yotpoLoyaltyApiKey: ["integrations", "secret"], yotpoLoyaltyGuid: ["integrations"],
  loyaltyDisplay: ["integrations"], loyaltyPointsPerDollar: ["integrations"], loyaltyRounding: ["integrations"],
  referralPageUrl: ["integrations"], aftershipApiKey: ["integrations", "secret"], klaviyoCompanyId: ["integrations"],
  klaviyoListId: ["integrations"], embeddingProvider: ["integrations"], voyageApiKey: ["integrations", "secret"],
  openaiApiKey: ["integrations", "secret"], showLoginPill: ["integrations", "bool"], vipModeEnabled: ["integrations", "bool"],
  peakMode: ["peak"], peakStartsAt: ["peak"], peakEndsAt: ["peak"], chatLimitPerMin: ["peak"], chatLimitPerHour: ["peak"],
  peakLimitPerMin: ["peak"], peakLimitPerHour: ["peak"], peakLiftDailyCap: ["peak", "bool"], peakPauseSync: ["peak", "bool"],
  dailyCapEnabled: ["peak", "bool"], dailyCapMessages: ["peak"],
};

function initialValues(d) {
  const v = {};
  for (const [key, [, kind]] of Object.entries(FIELDS)) {
    if (kind === "secret") v[key] = "";
    else if (kind === "bool") v[key] = Boolean(d[key]);
    else if (kind === "json") v[key] = d[key] || [];
    else v[key] = d[key] === null || d[key] === undefined ? "" : String(d[key]);
  }
  return v;
}

const clearSecrets = (v) => {
  const next = { ...v };
  for (const [k, [, kind]] of Object.entries(FIELDS)) if (kind === "secret") next[k] = "";
  return next;
};
const sameValue = (a, b) => (typeof a === "object" || typeof b === "object" ? JSON.stringify(a) === JSON.stringify(b) : String(a) === String(b));

// Peak Mode's days: stored as the start of the first day and the start of
// the day after the last one, in the browser's time zone.
const pad = (n) => String(n).padStart(2, "0");
function dayOf(isoValue, shiftDays = 0) {
  if (!isoValue) return "";
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + shiftDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function startOfDay(day, shiftDays = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
  if (!m) return "";
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + shiftDays).toISOString();
}
const fmtDay = (isoValue, shift = 0) => {
  if (!isoValue) return "";
  const d = new Date(isoValue);
  d.setDate(d.getDate() + shift);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");
const fmtMoney = (n) => (n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);

const MODEL_OPTIONS = [
  { label: "Standard — recommended", value: "claude-sonnet-4-6" },
  { label: "Fast — lower cost", value: "claude-haiku-4-5-20251001" },
  { label: "Advanced — most capable", value: "claude-opus-4-7" },
];
const SURVEY_COLORS = [
  { label: "Teal", value: "teal" }, { label: "Green", value: "green" }, { label: "Blue", value: "blue" },
  { label: "Purple", value: "purple" }, { label: "Rose", value: "rose" }, { label: "Amber", value: "amber" },
  { label: "Plain (like the other buttons)", value: "plain" },
];
const SURVEY_ICONS = [
  { label: "Chat bubble with dots (feedback)", value: "feedback" }, { label: "Insoles (orthotics)", value: "orthotic" },
  { label: "Shoe", value: "shoe" }, { label: "Search", value: "search" }, { label: "Ruler (sizing)", value: "sizing" },
  { label: "Box (orders)", value: "order" }, { label: "Truck (shipping)", value: "shipping" }, { label: "Return arrow", value: "returns" },
  { label: "Tag (deals)", value: "deals" }, { label: "Gift", value: "gift" }, { label: "Heart", value: "heart" },
  { label: "Star", value: "star" }, { label: "Chat bubble (support)", value: "support" }, { label: "Map pin (stores)", value: "store" },
  { label: "Sparkle", value: "sparkle" },
];

function Connected({ on, label = "Connected" }) {
  return <Badge tone={on ? "success" : undefined}>{on ? label : "Not set"}</Badge>;
}

// An integration: one line with its status; its fields open on demand.
function Integration({ title, help, connected, children, connectedLabel }) {
  const [open, setOpen] = useState(false);
  return (
    <Row
      title={<InlineStack gap="200" blockAlign="center"><span>{title}</span><Connected on={connected} label={connectedLabel} /></InlineStack>}
      help={help}
      control={<Button onClick={() => setOpen((o) => !o)} disclosure={open ? "up" : "down"}>{open ? "Done" : connected ? "Edit" : "Set up"}</Button>}
    >
      {open ? <BlockStack gap="300">{children}</BlockStack> : null}
    </Row>
  );
}

function HideOnPages({ rules, onChange }) {
  const [matchType, setMatchType] = useState("equals");
  const [pattern, setPattern] = useState("");
  const add = () => {
    const p = pattern.trim();
    if (!p || rules.some((r) => r.matchType === matchType && r.pattern === p)) return;
    onChange([...rules, { matchType, pattern: p }]);
    setPattern("");
  };
  return (
    <BlockStack gap="300">
      {rules.length > 0 && (
        <InlineStack gap="200" wrap>
          {rules.map((r, i) => (
            <span key={`${r.matchType}:${r.pattern}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 4px 3px 10px", borderRadius: 999, background: "rgba(26,46,38,0.06)", fontSize: 12.5 }}>
              <span style={{ color: "#616161" }}>{r.matchType === "contains" ? "contains" : "is"}</span>
              <code style={{ fontSize: 12 }}>{r.pattern}</code>
              <Button variant="plain" tone="critical" accessibilityLabel={`Remove ${r.pattern}`} onClick={() => onChange(rules.filter((_, j) => j !== i))}>×</Button>
            </span>
          ))}
        </InlineStack>
      )}
      <InlineStack gap="200" blockAlign="end" wrap={false}>
        <div style={{ width: 140, flex: "none" }}>
          <Select label="Page link" options={[{ label: "is", value: "equals" }, { label: "contains", value: "contains" }]} value={matchType} onChange={setMatchType} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextField label="Path" labelHidden value={pattern} onChange={setPattern} placeholder="/pages/technology" autoComplete="off"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        </div>
        <Button onClick={add} disabled={!pattern.trim()}>Add</Button>
      </InlineStack>
    </BlockStack>
  );
}

function VisualizeLook({ initialEnabled, initialProvider, initialLabel, hasGeminiKey, hasOpenaiKey }) {
  const fetcher = useFetcher();
  const [enabled, setEnabled] = useState(Boolean(initialEnabled));
  const [provider, setProvider] = useState(initialProvider || "");
  const [label, setLabel] = useState(initialLabel || "See It Styled");
  const [geminiKey, setGeminiKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const saving = fetcher.state !== "idle";
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
    <Row
      title="See It Styled"
      help="When the assistant picks one product, shoppers can tap for an AI styling preview of it. You bring an image-provider key and pay per image."
      toggle
      checked={enabled}
      onChange={setEnabled}
      always={initialEnabled}
    >
      <BlockStack gap="300">
        {enabled && (
          <div className="set-grid">
            <Select
              label="Image provider"
              options={[{ label: "Choose a provider…", value: "" }, { label: "Google Gemini — most faithful to the product", value: "gemini" }, { label: "OpenAI (gpt-image-1)", value: "openai" }]}
              value={provider}
              onChange={setProvider}
            />
            <TextField label="Button label" value={label} onChange={setLabel} autoComplete="off" maxLength={40} />
            {provider === "gemini" && (
              <TextField label="Google AI Studio key" type="password" value={geminiKey} onChange={setGeminiKey} autoComplete="off"
                placeholder={hasGeminiKey ? "•••••••• (saved)" : "AIza..."} helpText={hasGeminiKey ? "Leave blank to keep the saved key." : "From aistudio.google.com → API keys."} />
            )}
            {provider === "openai" && (
              <TextField label="OpenAI key" type="password" value={openaiKey} onChange={setOpenaiKey} autoComplete="off"
                placeholder={hasOpenaiKey ? "•••••••• (saved)" : "sk-..."} helpText={hasOpenaiKey ? "Leave blank to keep the saved key." : "From platform.openai.com → API keys."} />
            )}
          </div>
        )}
        {fetcher.data?.error && <Text as="p" tone="critical" variant="bodySm">{fetcher.data.error}</Text>}
        <InlineStack gap="300" blockAlign="center">
          <Button onClick={save} loading={saving} disabled={enabled && !provider}>Save See It Styled</Button>
          {!saving && fetcher.data?.saved && <Text as="span" variant="bodySm" tone="success">Saved.</Text>}
        </InlineStack>
      </BlockStack>
    </Row>
  );
}

export default function Settings() {
  const d = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const revalidator = useRevalidator();
  const saving = nav.state === "submitting";

  const [values, setValues] = useState(() => initialValues(d));
  const [saved, setSaved] = useState(() => initialValues(d));
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const formRef = useRef(null);
  const set = (key) => (val) => setValues((s) => ({ ...s, [key]: val }));
  const [section, setSection] = useState("assistant");
  // Dates and "right now" read the browser's clock and time zone: shown once
  // the page is running in the browser, so the server's render matches.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    const fromHash = window.location.hash.replace("#", "");
    if (SECTIONS.some((s) => s.id === fromHash)) setSection(fromHash);
  }, []);

  const open = (id) => {
    setSection(id);
    try { window.history.replaceState(null, "", `#${id}`); } catch { /* sandboxed frame */ }
  };
  // On a phone the sections are a row of chips: keep the open one in view.
  useEffect(() => {
    const navEl = document.querySelector(".set-nav");
    const item = navEl?.querySelector("[aria-current='page']");
    if (navEl && item && navEl.scrollWidth > navEl.clientWidth) {
      navEl.scrollTo({ left: item.offsetLeft - (navEl.clientWidth - item.offsetWidth) / 2, behavior: "smooth" });
    }
  }, [section]);

  const dirtyKeys = Object.keys(FIELDS).filter((k) => !sameValue(values[k], saved[k]));
  const isDirty = dirtyKeys.length > 0;
  const dirtySections = new Set(dirtyKeys.map((k) => FIELDS[k][0]));

  useEffect(() => {
    if (actionData?.success) {
      window.shopify?.toast?.show("Settings saved");
      // Keys are never shown back: clear them, and take what was saved as
      // the new starting point.
      const next = clearSecrets(valuesRef.current);
      setValues(next);
      setSaved(next);
    }
    if (actionData?.error) {
      window.shopify?.toast?.show(actionData.error, { isError: true });
      if (actionData.section) open(actionData.section);
    }
  }, [actionData]);

  const discard = () => setValues(saved);

  // Peak Mode, as saved (for the sidebar) and as being edited (for the panel).
  const savedPeak = peakState({ peakMode: saved.peakMode, peakStartsAt: saved.peakStartsAt, peakEndsAt: saved.peakEndsAt });
  const draftPeak = peakState({ peakMode: values.peakMode, peakStartsAt: values.peakStartsAt, peakEndsAt: values.peakEndsAt });
  const sections = SECTIONS.map((s) => ({
    ...s,
    dirty: dirtySections.has(s.id),
    pill: s.id === "peak" && mounted ? (savedPeak.active ? "On" : savedPeak.upcoming ? "Soon" : null) : null,
  }));

  const hidden = useMemo(() => Object.entries(FIELDS).map(([k, [, kind]]) => (
    <input key={k} type="hidden" name={k} value={kind === "bool" ? String(Boolean(values[k])) : kind === "json" ? JSON.stringify(values[k] || []) : String(values[k] ?? "")} />
  )), [values]);

  return (
    <Page>
      <TitleBar title="Settings" />
      {/* Static CSS, injected as-is: as a text child React would escape its
          quotes on the server and the page wouldn't hydrate. */}
      <style dangerouslySetInnerHTML={{ __html: SETTINGS_CSS }} />
      <Form method="post" ref={formRef}>
        <BlockStack gap="400">
          <BrandHeader title="Settings" gutter={false} />
          <div className="set-shell">
            <SettingsNav sections={sections} current={section} onSelect={open} />
            <div className="set-links" style={{ minWidth: 0 }}>
              <div hidden={section !== "assistant"}><AssistantSection d={d} values={values} set={set} /></div>
              <div hidden={section !== "look"}><LookSection d={d} values={values} set={set} /></div>
              <div hidden={section !== "seasonal"}><SeasonalSection values={values} set={set} info={d.seasonalInfo} /></div>
              <div hidden={section !== "visibility"}><VisibilitySection values={values} set={set} /></div>
              <div hidden={section !== "care"}><CareSection values={values} set={set} /></div>
              <div hidden={section !== "tools"}><ToolsSection d={d} values={values} set={set} /></div>
              <div hidden={section !== "integrations"}><IntegrationsSection d={d} values={values} set={set} /></div>
              <div hidden={section !== "peak"}>
                <PeakSection d={d} values={values} set={set} draftPeak={draftPeak} mounted={mounted} onRefresh={() => revalidator.revalidate()} refreshing={revalidator.state !== "idle"} />
              </div>
              <div hidden={section !== "testing"}>
                <SectionHead title="Testing">Record conversations while your team tests the assistant, then review them under Test recordings.</SectionHead>
                <TestRecordingCard initial={d.recording} shopDomain={d.shopDomain} />
              </div>
              {section !== "testing" && isDirty && (
                <div className="set-save">
                  <InlineStack gap="200">
                    <Button onClick={discard}>Discard</Button>
                    <Button variant="primary" submit loading={saving}>Save changes</Button>
                  </InlineStack>
                </div>
              )}
            </div>
          </div>
        </BlockStack>
        {hidden}
      </Form>

      {/* Contextual Save Bar — App Bridge ui-save-bar, shown while anything is
          unsaved. Its buttons are native elements with App Bridge attributes. */}
      <SaveBar id="seos-settings-save-bar" open={isDirty}>
        <button variant="primary" loading={saving ? "" : undefined} onClick={() => formRef.current?.requestSubmit()}>Save changes</button>
        <button onClick={discard}>Discard</button>
      </SaveBar>
    </Page>
  );
}

// ── Sections ─────────────────────────────────────────────────────────────

function AssistantSection({ d, values, set }) {
  return (
    <BlockStack gap="400">
      <SectionHead title="Assistant">The AI behind the chat, and what it adds to its answers.</SectionHead>
      <Group title="AI engine" badge={<Connected on={d.hasAnthropicKey} />}>
        <Row stack>
          <div className="set-grid">
            <TextField
              label="Anthropic API key"
              type="password"
              value={values.anthropicApiKey}
              onChange={set("anthropicApiKey")}
              placeholder={d.hasAnthropicKey ? "•••••••••••••••• (saved)" : "Paste API key"}
              autoComplete="off"
              helpText={<>Encrypted. Leave blank to keep the saved key. <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">Get a key</a></>}
            />
            <Select
              label="Model"
              options={MODEL_OPTIONS.filter((o) => o.value !== "claude-opus-4-7" || d.plan.features?.advancedModel)}
              value={values.anthropicModel}
              onChange={set("anthropicModel")}
              helpText="Standard is the best balance — every answer is fact-checked."
            />
          </div>
        </Row>
      </Group>
      <Group title="In the chat">
        <Row title="Follow-up questions" help="2–3 tappable follow-ups after each answer — only ones the assistant can answer." toggle checked={values.showFollowUps} onChange={set("showFollowUps")} />
        <Row title="Helpful / Not helpful" help="Thumbs under product answers. Feedback shows in Analytics." toggle checked={values.showFeedback} onChange={set("showFeedback")} />
        <Row title="Ask how the chat went" help="A quiet “How's the chat going?” after a few replies, once per chat. Ratings and comments show in Analytics." toggle checked={values.chatRatingOn} onChange={set("chatRatingOn")}>
          <div style={{ maxWidth: 220 }}>
            <Select label="Ask after" options={[2, 3, 4, 5, 6].map((n) => ({ label: `${n} replies`, value: String(n) }))} value={values.chatRatingAfter} onChange={set("chatRatingAfter")} />
          </div>
        </Row>
      </Group>
    </BlockStack>
  );
}

const TEXT_DEFAULT = Object.fromEntries(CHAT_TEXT_FIELDS.map(([key, , , def]) => [key, def]));
const TEXT_MAX = Object.fromEntries(CHAT_TEXT_FIELDS.map(([key, , max]) => [key, max]));

function LookSection({ d, values, set }) {
  return (
    <BlockStack gap="400">
      <SectionHead title="Look & feel">How the assistant looks and moves on your store.</SectionHead>
      <Group>
        <Row
          title="Starts in"
          help="The look shoppers see first. They can switch with the sun/moon button; their pick is remembered."
          control={<div style={{ width: 150 }}><Select label="Starts in" labelHidden options={[{ label: "Dark mode", value: "dark" }, { label: "Light mode", value: "light" }]} value={values.startTheme} onChange={set("startTheme")} /></div>}
        />
        <Row title="Opening animation" help="The panel springs up and the welcome rises in. Skipped for shoppers who prefer reduced motion." toggle checked={values.welcomeIntroOn} onChange={set("welcomeIntroOn")} />
        <Row title="Talk button" help="A mic in the message box: shoppers speak and their words appear as they talk. Shown where the browser supports it." toggle checked={values.voiceInput} onChange={set("voiceInput")} />
      </Group>
      <Group title="Chat text">
        <Row stack help="The words shoppers see in the chat. Left blank, the chat uses what's set in the theme editor (or the default shown).">
          <BlockStack gap="300">
            <div className="set-grid">
              <TextField label="Chat name" value={values.textName} onChange={set("textName")} placeholder={TEXT_DEFAULT.name} maxLength={TEXT_MAX.name} autoComplete="off" helpText="At the top of the chat; the assistant goes by it too." />
              <TextField label="Chat button" value={values.textLauncher} onChange={set("textLauncher")} placeholder={TEXT_DEFAULT.launcher} maxLength={TEXT_MAX.launcher} autoComplete="off" helpText="The bar shoppers tap to open the chat." />
            </div>
            <div className="set-grid">
              <TextField label="Welcome greeting" value={values.textGreeting} onChange={set("textGreeting")} placeholder={TEXT_DEFAULT.greeting} maxLength={TEXT_MAX.greeting} autoComplete="off" />
              <TextField label="Welcome greeting, signed in" value={values.textGreetingLoggedIn} onChange={set("textGreetingLoggedIn")} placeholder={TEXT_DEFAULT.greetingLoggedIn} maxLength={TEXT_MAX.greetingLoggedIn} autoComplete="off" helpText="{name} becomes the shopper's first name." />
            </div>
            <div className="set-grid set-grid--3">
              <TextField label="“Start here” heading" value={values.textStartHeading} onChange={set("textStartHeading")} placeholder={TEXT_DEFAULT.startHeading} maxLength={TEXT_MAX.startHeading} autoComplete="off" />
              <TextField label="“Popular” heading" value={values.textPopularHeading} onChange={set("textPopularHeading")} placeholder={TEXT_DEFAULT.popularHeading} maxLength={TEXT_MAX.popularHeading} autoComplete="off" />
              <TextField label="Message box" value={values.textInput} onChange={set("textInput")} placeholder={TEXT_DEFAULT.input} maxLength={TEXT_MAX.input} autoComplete="off" />
            </div>
            <div className="set-grid">
              <TextField label="Fit & size button" value={values.textFitButton} onChange={set("textFitButton")} placeholder={TEXT_DEFAULT.fitButton} maxLength={TEXT_MAX.fitButton} autoComplete="off" helpText="On product cards, under Add to cart, with Fit confidence on (Recommenders). It opens the Fit score and the size finder." />
            </div>
          </BlockStack>
        </Row>
      </Group>
      <OrbColorsCard initial={d.orbColors} initialBg={d.orbBackground} />
    </BlockStack>
  );
}

function VisibilitySection({ values, set }) {
  return (
    <BlockStack gap="400">
      <SectionHead title="Where it shows">When the chat appears, and for whom.</SectionHead>
      <Group>
        <Row title="Wait before showing" help="The chat appears after a short delay, so shoppers see your page first." toggle checked={values.appearDelayOn} onChange={set("appearDelayOn")}>
          <div style={{ maxWidth: 220 }}>
            <TextField label="Delay" type="number" min={APPEAR_DELAY_MIN} max={APPEAR_DELAY_MAX} value={values.appearDelaySec} onChange={set("appearDelaySec")} autoComplete="off" suffix="seconds" helpText={`${APPEAR_DELAY_MIN}–${APPEAR_DELAY_MAX} seconds.`} />
          </div>
        </Row>
        <Row title="Hide for international shoppers" help="Shoppers outside your home countries (as Global-e or Shopify Markets sets them) don't see the chat — its prices are in your store's currency." toggle checked={values.hideInternational} onChange={set("hideInternational")}>
          <div style={{ maxWidth: 320 }}>
            <TextField label="Home countries" value={values.homeCountries} onChange={set("homeCountries")} placeholder="US" autoComplete="off" helpText="Two-letter codes, separated by commas (e.g. US, PR)." />
          </div>
        </Row>
        <Row title="Hide the Zendesk chat button" help="Removes the separate live chat button from the corner. Live chat still opens from the assistant when a shopper asks for a person." toggle checked={values.hideLiveChatButton} onChange={set("hideLiveChatButton")} />
      </Group>
      <Group title="Hidden on these pages">
        <Row stack help="The chat stays off pages whose link is (or contains) one of these.">
          <HideOnPages rules={values.hideOnUrls} onChange={set("hideOnUrls")} />
        </Row>
      </Group>
    </BlockStack>
  );
}

function CareSection({ values, set }) {
  return (
    <BlockStack gap="400">
      <SectionHead title="Customer care">Handing shoppers to your team, and their orders and returns.</SectionHead>
      <Group title="Support">
        <Row stack help="When a shopper needs a person, the assistant shows a button that opens your live chat (Zendesk, Intercom or Gorgias), or this page if there isn't one.">
          <div className="set-grid">
            <TextField label="Support page" value={values.supportUrl} onChange={set("supportUrl")} placeholder="https://yourstore.com/pages/contact" autoComplete="off" helpText="Blank: the theme editor's Support URL." />
            <TextField label="Button label" value={values.supportLabel} onChange={set("supportLabel")} placeholder="Chat with Aetrex Support" autoComplete="off" />
          </div>
        </Row>
      </Group>
      <Group title="Orders & returns">
        <Row stack>
          <div className="set-grid">
            <TextField label="Order tracking page" value={values.trackingPageUrl} onChange={set("trackingPageUrl")} placeholder="https://orders.yourstore.com" autoComplete="off" helpText="Signed-in shoppers' tracking links open here." />
            <TextField label="Returns page" value={values.returnsPageUrl} onChange={set("returnsPageUrl")} placeholder="https://returns.yourstore.com" autoComplete="off" helpText="Your AfterShip Returns page, prefilled with the order." />
          </div>
        </Row>
        <Row
          title="Returns and exchanges in the chat"
          help={values.returnsInChat ? "Signed-in shoppers start returns and exchanges right in the chat (needs the AfterShip key in Integrations)." : "Order cards show “Start a return”, which opens the returns page with the order filled in."}
          toggle
          checked={values.returnsInChat}
          onChange={set("returnsInChat")}
        />
        <Row
          title="Return window"
          help="Older orders don't get a return button, and the assistant explains why. 0 = no limit."
          control={<div style={{ width: 130 }}><TextField label="Return window" labelHidden type="number" min={0} max={365} value={values.returnWindowDays} onChange={set("returnWindowDays")} autoComplete="off" suffix="days" /></div>}
        />
        <Row title="Only after delivery" help={values.returnsDeliveredOnly ? "The return button appears once the order is delivered." : "The return button appears as soon as the order ships."} toggle checked={values.returnsDeliveredOnly} onChange={set("returnsDeliveredOnly")} />
        <Row
          title="Order status without signing in"
          help={values.guestOrderLookup
            ? "Signed-out shoppers can check one order with its order number (or confirmation code) and the email they used. They see status, items and tracking only — never names, addresses or payment details — and need to sign in to start a return. Tries are limited so no one can guess."
            : "Shoppers sign in to see their orders."}
          toggle
          checked={values.guestOrderLookup}
          onChange={set("guestOrderLookup")}
        />
      </Group>
    </BlockStack>
  );
}

// Your app → the app's picture: a PNG (ideally with no background) shown in
// the chat's app message. Resized here to a small file before it's saved.
const APP_IMAGE_HEIGHT = 360;
function resizeAppImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, APP_IMAGE_HEIGHT / img.naturalHeight);
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const webp = c.toDataURL("image/webp", 0.9);
      resolve(webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/png"));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unreadable")); };
    img.src = url;
  });
}
function AppPicture({ initial, disabled }) {
  const fetcher = useFetcher();
  const inputRef = useRef(null);
  const [picked, setPicked] = useState(null);
  const [localError, setLocalError] = useState("");
  const saved = fetcher.data?.appImageSaved ? fetcher.data.appImage : null;
  const image = picked ?? saved ?? initial ?? "";
  const error = localError || fetcher.data?.appImageError || "";
  const busy = fetcher.state !== "idle";
  const send = (value) => {
    const fd = new FormData();
    fd.set("intent", "save_app_image");
    fd.set("image", value);
    fetcher.submit(fd, { method: "post" });
  };
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setLocalError("");
    if (!/^image\/(png|webp|jpeg)$/.test(file.type)) { setLocalError("Choose a PNG, WebP or JPEG image."); return; }
    try {
      const data = await resizeAppImage(file);
      setPicked(data);
      send(data);
    } catch {
      setLocalError("That image couldn't be read — try another one.");
    }
  };
  const remove = () => { setPicked(""); send(""); };
  return (
    <div className="set-app-pic">
      <div className={`set-app-pic__thumb${image ? "" : " is-empty"}`}>{image ? <img src={image} alt="" /> : <span aria-hidden="true">📱</span>}</div>
      <div className="set-app-pic__body">
        <Text as="p" variant="bodyMd" fontWeight="semibold">App picture</Text>
        <Text as="p" variant="bodySm" tone="subdued">A picture of your app on a phone, shown in the chat's app message. A PNG with no background looks best. Without one, a phone icon is shown.</Text>
        <InlineStack gap="200" blockAlign="center">
          <input ref={inputRef} type="file" accept="image/png,image/webp,image/jpeg" hidden onChange={onFile} />
          <Button onClick={() => inputRef.current?.click()} loading={busy && !!picked} disabled={disabled}>{image ? "Replace picture" : "Upload picture"}</Button>
          {image ? <Button variant="plain" tone="critical" onClick={remove} disabled={disabled || busy}>Remove</Button> : null}
          {fetcher.data?.appImageSaved && !busy ? <Text as="span" variant="bodySm" tone="success">Saved</Text> : null}
        </InlineStack>
        {error ? <Text as="p" variant="bodySm" tone="critical">{error}</Text> : null}
      </div>
    </div>
  );
}

function ToolsSection({ d, values, set }) {
  const mapId = storepointId(values.storeLocatorMapId);
  return (
    <BlockStack gap="400">
      <SectionHead title="Shopping tools">Helpers shoppers can open right inside the chat.</SectionHead>
      <Group>
        <Row
          title="Buy now"
          help={values.buyNowEnabled
            ? "Product cards add Buy now next to Add to cart once the shopper's size, width and everything else are known. It goes straight to checkout with the item and your code; anything already in the shopper's cart stays. The order is credited to the chat, tagged SEoS and SEoS Buy now."
            : "Off: product cards offer Add to cart only."}
          toggle
          checked={values.buyNowEnabled}
          onChange={set("buyNowEnabled")}
        >
          <div className="set-grid">
            <TextField label="Discount code" value={values.buyNowCode} onChange={set("buyNowCode")} placeholder="None" maxLength={BUY_NOW_CODE_MAX} autoComplete="off" disabled={!values.buyNowEnabled} helpText="Optional. A code from Shopify → Discounts, applied at checkout, where shoppers will see it. Blank: no code." />
          </div>
        </Row>
      </Group>
      <Group>
        <Row title="Promotions page" help="The assistant reads your offers page live (every 15 minutes), so it knows what's running." stack>
          <div className="set-grid">
            <TextField label="Page link" value={values.promoPageUrl} onChange={set("promoPageUrl")} placeholder="https://www.aetrex.com/pages/terms-conditions" autoComplete="off" />
            <TextField label="Offers end at this line" value={values.promoPageStop} onChange={set("promoPageStop")} placeholder="STANDARD TERMS AND CONDITIONS OF SALE" autoComplete="off" disabled={!values.promoPageUrl.trim()} helpText="Only text above it counts as offers." />
          </div>
        </Row>
        <Row title="Which orthotic do I have?" help="A visual quiz (Typeform) that tells shoppers which orthotic they own, so they can reorder it." stack>
          <div className="set-grid">
            <TextField label="Typeform quiz" value={values.whichOrthotic} onChange={set("whichOrthotic")} placeholder="ojyWbTvZ or its link" autoComplete="off" helpText="Blank turns it off." />
            <TextField label="Button text" value={values.whichOrthoticLabel} onChange={set("whichOrthoticLabel")} maxLength={40} autoComplete="off" disabled={!values.whichOrthotic.trim()} />
          </div>
        </Row>
        <Row title="Store locator" help="Your Storepoint map, opened in the chat when a shopper asks where to buy or try on in person." stack>
          <div className="set-grid set-grid--3">
            <TextField label="Storepoint map" value={values.storeLocatorMapId} onChange={set("storeLocatorMapId")} placeholder="Map ID or embed code" autoComplete="off" helpText={mapId ? `Map ${mapId}` : "Blank turns it off."} />
            <TextField label="Button text" value={values.storeLocatorLabel} onChange={set("storeLocatorLabel")} maxLength={40} autoComplete="off" disabled={!mapId} />
            <TextField label="Locator page" value={values.storeLocatorUrl} onChange={set("storeLocatorUrl")} placeholder="/pages/store-locator" autoComplete="off" disabled={!mapId} helpText="If the map can't load." />
          </div>
        </Row>
        <Row
          title="Feedback button"
          help="The fourth Start here button becomes your survey, opened inside the chat. The site's own floating Feedback button is hidden."
          toggle
          checked={values.feedbackSurveyOn}
          onChange={set("feedbackSurveyOn")}
        >
          <BlockStack gap="300">
            <div className="set-grid">
              <TextField label="Typeform survey" value={values.feedbackSurvey} onChange={set("feedbackSurvey")} placeholder="jdXBrXMa or its link" autoComplete="off" />
              <TextField label="Button text" value={values.feedbackSurveyLabel} onChange={set("feedbackSurveyLabel")} maxLength={40} autoComplete="off" />
              <Select label="Button color" options={SURVEY_COLORS} value={values.feedbackSurveyColor} onChange={set("feedbackSurveyColor")} />
              <Select label="Button icon" options={SURVEY_ICONS} value={values.feedbackSurveyIcon} onChange={set("feedbackSurveyIcon")} />
            </div>
            <InlineStack gap="300" blockAlign="center" wrap={false}>
              <Switch checked={values.feedbackSurveyHideAfter} onChange={set("feedbackSurveyHideAfter")} label="Hide after a shopper sends it" />
              <Text as="span" variant="bodySm">Hide it once a shopper has sent the form <Text as="span" tone="subdued">(right for a one-time survey)</Text></Text>
            </InlineStack>
          </BlockStack>
        </Row>
        <Row
          title="Your app"
          help={values.appPromoOn
            ? "Once a visit, after a couple of replies, your app shows up as its own small message with a button: a QR code to scan on computers, App Store and Google Play buttons on phones. Links left blank: the ones in your store's footer are used."
            : "The chat doesn't mention your app."}
          toggle
          checked={values.appPromoOn}
          onChange={set("appPromoOn")}
        >
          <BlockStack gap="300">
            <div className="set-grid set-grid--app">
              <TextField label="Message" value={values.appPromoText} onChange={set("appPromoText")} placeholder={d.appPromoDefaultText} maxLength={APP_TEXT_MAX} showCharacterCount autoComplete="off" disabled={!values.appPromoOn} helpText="Left blank, the placeholder is used." />
              <TextField label="Button text" value={values.appPromoButton} onChange={set("appPromoButton")} placeholder="Get it" maxLength={APP_BUTTON_MAX} autoComplete="off" disabled={!values.appPromoOn} />
            </div>
            <AppPicture initial={d.appPromoImage} disabled={!values.appPromoOn} />
            <div className="set-grid">
              <TextField label="App Store link" value={values.appIosUrl} onChange={set("appIosUrl")} placeholder="https://apps.apple.com/us/app/…" autoComplete="off" disabled={!values.appPromoOn} />
              <TextField label="Google Play link" value={values.appAndroidUrl} onChange={set("appAndroidUrl")} placeholder="https://play.google.com/store/apps/details?id=…" autoComplete="off" disabled={!values.appPromoOn} />
            </div>
          </BlockStack>
        </Row>
      </Group>
      <Group>
        <VisualizeLook initialEnabled={d.visualizeLookEnabled} initialProvider={d.imageProvider} initialLabel={d.visualizeLookLabel} hasGeminiKey={d.hasGeminiKey} hasOpenaiKey={d.hasOpenaiKey} />
      </Group>
    </BlockStack>
  );
}

function IntegrationsSection({ d, values, set }) {
  return (
    <BlockStack gap="400">
      <SectionHead title="Integrations">Connect the services you already use. Each one is optional.</SectionHead>
      <Group>
        <Integration title="Yotpo Reviews" help="Star ratings, fit summaries and “what do reviewers say” answers." connected={d.hasYotpoKey}>
          <TextField label="Yotpo API key" type="password" value={values.yotpoApiKey} onChange={set("yotpoApiKey")} placeholder={d.hasYotpoKey ? "•••••••• (saved)" : "Paste key"} autoComplete="off" helpText={d.hasYotpoKey ? "Leave blank to keep the saved key." : undefined} />
        </Integration>
        <Integration title="Yotpo Loyalty & Referrals" help="Points, VIP tier and a personal referral link for signed-in shoppers (with VIP mode on)." connected={d.hasYotpoLoyaltyKey}>
          <div className="set-grid">
            <TextField label="Loyalty API key" type="password" value={values.yotpoLoyaltyApiKey} onChange={set("yotpoLoyaltyApiKey")} placeholder={d.hasYotpoLoyaltyKey ? "•••••••• (saved)" : "Paste key"} autoComplete="off" helpText="Yotpo Loyalty → Program Settings → API Key." />
            <TextField label="GUID (optional)" value={values.yotpoLoyaltyGuid} onChange={set("yotpoLoyaltyGuid")} autoComplete="off" helpText="Only if your account needs it." />
            <Select label="Show balances as" options={[{ label: "Points (250 points)", value: "points" }, { label: "Dollars ($2.50 in rewards)", value: "dollars" }]} value={values.loyaltyDisplay} onChange={set("loyaltyDisplay")} />
            <TextField label="Referral page" value={values.referralPageUrl} onChange={set("referralPageUrl")} placeholder="https://yourstore.com/pages/refer" autoComplete="off" helpText="When a shopper's own link isn't available." />
            {values.loyaltyDisplay === "dollars" && (
              <>
                <TextField label="Points per $1" type="number" min={1} value={values.loyaltyPointsPerDollar} onChange={set("loyaltyPointsPerDollar")} autoComplete="off" />
                <Select label="Rounding" options={[{ label: "Exact ($2.53)", value: "exact" }, { label: "Round down ($2)", value: "down" }, { label: "Round up ($3)", value: "up" }]} value={values.loyaltyRounding} onChange={set("loyaltyRounding")} />
              </>
            )}
          </div>
        </Integration>
        <Integration title="AfterShip Returns" help="Returns and exchanges started right in the chat, with your rules, labels and emails." connected={d.hasAftershipKey}>
          <TextField label="AfterShip Returns API key" type="password" value={values.aftershipApiKey} onChange={set("aftershipApiKey")} placeholder={d.hasAftershipKey ? "•••••••• (saved)" : "Paste key"} autoComplete="off" helpText="AfterShip → Settings → API keys (your plan needs API access)." />
        </Integration>
        <Integration title="Klaviyo" help="A newsletter signup form in the chat when a shopper wants deals or updates." connected={Boolean(values.klaviyoCompanyId && values.klaviyoListId)}>
          <div className="set-grid">
            <TextField label="Company ID (public key)" value={values.klaviyoCompanyId} onChange={set("klaviyoCompanyId")} placeholder="AbC123" autoComplete="off" helpText="Klaviyo → Settings → API Keys." />
            <TextField label="List ID" value={values.klaviyoListId} onChange={set("klaviyoListId")} placeholder="XyZ789" autoComplete="off" helpText="Audience → Lists → your list." />
          </div>
        </Integration>
        <Integration
          title="Semantic search"
          help="Finds the right part of your store's pages and team notes by meaning, not just matching words."
          connected={Boolean(values.embeddingProvider)}
          connectedLabel={values.embeddingProvider === "voyage" ? "Voyage AI" : "OpenAI"}
        >
          <div className="set-grid">
            <Select label="Provider" options={[{ label: "Off (keyword matching)", value: "" }, { label: "Voyage AI — recommended", value: "voyage" }, { label: "OpenAI", value: "openai" }]} value={values.embeddingProvider} onChange={set("embeddingProvider")} />
            {values.embeddingProvider === "voyage" && (
              <TextField label="Voyage AI key" type="password" value={values.voyageApiKey} onChange={set("voyageApiKey")} placeholder={d.hasVoyageKey ? "•••••••• (saved)" : "pa-..."} autoComplete="off" />
            )}
            {values.embeddingProvider === "openai" && (
              <TextField label="OpenAI key" type="password" value={values.openaiApiKey} onChange={set("openaiApiKey")} placeholder={d.hasOpenaiKey ? "•••••••• (saved)" : "sk-..."} autoComplete="off" />
            )}
          </div>
        </Integration>
      </Group>
      <Group title="Signed-in shoppers">
        <Row title="Login button in the chat" help="“Login” for visitors, “Hi [name]!” for signed-in shoppers." toggle checked={values.showLoginPill} onChange={set("showLoginPill")} />
        <Row title="VIP mode" help="The assistant uses a signed-in shopper's order history to personalize sizes and suggestions. No email, address or payment details are ever shown." toggle checked={values.vipModeEnabled} onChange={set("vipModeEnabled")} />
      </Group>
    </BlockStack>
  );
}

function PeakSection({ d, values, set, draftPeak, mounted, onRefresh, refreshing }) {
  const p = d.pulse;
  const perMin = Number(values.chatLimitPerMin) || 0;
  const perHour = Number(values.chatLimitPerHour) || 0;
  const peakMin = Number(values.peakLimitPerMin) || 0;
  const peakHour = Number(values.peakLimitPerHour) || 0;
  const avg = p?.avgCostUsd || 0;
  const away = p ? p.turnedAway.storeLimit + p.turnedAway.dailyCap + p.turnedAway.aiBusy : 0;
  const limitText = (m, h) => `${m ? `${fmtNum(m)} a minute` : "no per-minute limit"} · ${h ? `${fmtNum(h)} an hour` : "no hourly limit"}`;
  const tight = p && perMin > 0 && p.busiestMinute >= perMin * 0.7;

  const status = !mounted ? null
    : draftPeak.active ? { tone: "success", text: draftPeak.mode === "on" ? "On now" : `On until ${draftPeak.endsAt ? fmtDay(draftPeak.endsAt, -1) : "you turn it off"}` }
    : draftPeak.upcoming ? { tone: "info", text: `Starts ${fmtDay(draftPeak.startsAt)}` }
    : draftPeak.ended ? { tone: undefined, text: "Schedule ended" }
    : { tone: undefined, text: "Off" };

  const chooseMode = (mode) => set("peakMode")(mode);

  return (
    <BlockStack gap="400">
      <SectionHead title="Peak Mode">Built for your biggest days — sales, launches and holidays. Higher chat limits and nothing heavy running in the background, so every shopper gets an answer.</SectionHead>

      <Group>
        <div className="set-peak-top">
          <div className={`set-peak-mark${draftPeak.active ? " set-peak-mark--on" : ""}`} aria-hidden="true"><Icon source={GaugeIcon} /></div>
          <BlockStack gap="300">
            <InlineStack gap="300" blockAlign="center">
              <ButtonGroup variant="segmented">
                <Button pressed={values.peakMode === "off"} onClick={() => chooseMode("off")}>Off</Button>
                <Button pressed={values.peakMode === "on"} onClick={() => chooseMode("on")}>On now</Button>
                <Button pressed={values.peakMode === "scheduled"} onClick={() => chooseMode("scheduled")}>Schedule</Button>
              </ButtonGroup>
              {status && <Badge tone={status.tone}>{status.text}</Badge>}
            </InlineStack>
            {values.peakMode === "scheduled" && (
              <div className="set-grid" style={{ maxWidth: 420 }}>
                <TextField label="First day" type="date" value={mounted ? dayOf(values.peakStartsAt) : ""} onChange={(day) => set("peakStartsAt")(startOfDay(day))} autoComplete="off" />
                <TextField label="Last day" type="date" value={mounted ? dayOf(values.peakEndsAt, -1) : ""} onChange={(day) => set("peakEndsAt")(startOfDay(day, 1))} autoComplete="off" helpText="Blank: until you turn it off." />
              </div>
            )}
          </BlockStack>
        </div>
        <Row title="Higher chat limits" help={`${limitText(peakMin, peakHour)} — set below.`} control={<span aria-label="Included"><Icon source={CheckCircleIcon} tone="success" /></span>} />
        <Row title="Lift the daily message cap" help={values.dailyCapEnabled ? "The assistant never goes quiet on your busiest day." : "Only matters when the daily cap below is on."} toggle checked={values.peakLiftDailyCap} onChange={set("peakLiftDailyCap")} />
        <Row title="Pause the nightly catalog refresh" help="The full re-sync sits out. Product and stock changes still reach the chat live." toggle checked={values.peakPauseSync} onChange={set("peakPauseSync")} />
      </Group>

      <Group title="Right now" badge={<Button variant="plain" onClick={onRefresh} loading={refreshing}>Refresh</Button>}>
        <Row stack>
          {p ? (
            <BlockStack gap="300">
              <div className="set-grid set-grid--3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
                <Stat label="Last minute" value={fmtNum(p.lastMinute)} hint="messages" />
                <Stat label="Last hour" value={fmtNum(p.lastHour)} hint="messages" />
                <Stat label="Busiest minute" value={fmtNum(p.busiestMinute)} hint="past 7 days" />
                <Stat label="Busiest hour" value={fmtNum(p.busiestHour)} hint="past 7 days" />
              </div>
              <Text as="p" variant="bodySm" tone={away ? "critical" : "subdued"}>
                {away
                  ? `${fmtNum(away)} shopper message${away === 1 ? " was" : "s were"} turned away in the past 7 days — store limit ${fmtNum(p.turnedAway.storeLimit)}, daily cap ${fmtNum(p.turnedAway.dailyCap)}, AI provider busy ${fmtNum(p.turnedAway.aiBusy)}.`
                  : "No shopper was turned away in the past 7 days."}
                {avg > 0 ? ` A message costs about ${(avg * 100).toFixed(1)}¢ on average.` : ""}
              </Text>
            </BlockStack>
          ) : (
            <Text as="p" variant="bodySm" tone="subdued">Numbers show here once shoppers start chatting.</Text>
          )}
        </Row>
      </Group>

      <Group title="Chat limits">
        <Row stack help="Messages from all shoppers together — a safety net against bots and runaway spend. 0 = no limit.">
          <BlockStack gap="300">
            {d.limitsOverridden && <Banner tone="warning">A server setting (CHAT_STORE_PER_MIN / CHAT_STORE_PER_HOUR) is overriding these limits.</Banner>}
            <div className="set-limits" role="group" aria-label="Chat limits">
              <span />
              <Text as="span" variant="headingXs">Every day</Text>
              <Text as="span" variant="headingXs">In Peak Mode</Text>
              <Text as="span" variant="bodySm">Messages a minute</Text>
              <TextField label="Every day, messages a minute" labelHidden type="number" min={0} value={values.chatLimitPerMin} onChange={set("chatLimitPerMin")} autoComplete="off" />
              <TextField label="In Peak Mode, messages a minute" labelHidden type="number" min={0} value={values.peakLimitPerMin} onChange={set("peakLimitPerMin")} autoComplete="off" />
              <Text as="span" variant="bodySm">Messages an hour</Text>
              <TextField label="Every day, messages an hour" labelHidden type="number" min={0} value={values.chatLimitPerHour} onChange={set("chatLimitPerHour")} autoComplete="off" />
              <TextField label="In Peak Mode, messages an hour" labelHidden type="number" min={0} value={values.peakLimitPerHour} onChange={set("peakLimitPerHour")} autoComplete="off" />
            </div>
            {avg > 0 && (perHour > 0 || peakHour > 0) && (
              <Text as="p" variant="bodySm" tone="subdued">
                At about {(avg * 100).toFixed(1)}¢ a message, the hourly limits keep spend under {perHour > 0 ? `${fmtMoney(perHour * avg)} an hour every day` : "— (no everyday limit)"}{peakHour > 0 ? ` and ${fmtMoney(peakHour * avg)} an hour in Peak Mode` : ""}.
              </Text>
            )}
            {tight && <Banner tone="warning">Your busiest minute this week reached {fmtNum(p.busiestMinute)} messages — close to the everyday limit of {fmtNum(perMin)}. Consider raising it.</Banner>}
          </BlockStack>
        </Row>
      </Group>

      <Group title="Daily message cap">
        <Row
          title="Stop for the day after a set number of messages"
          help={`Off for most stores. When it's reached, the assistant says it's back tomorrow (resets at midnight UTC).${values.peakLiftDailyCap ? " Lifted while Peak Mode is on." : ""}`}
          toggle
          checked={values.dailyCapEnabled}
          onChange={set("dailyCapEnabled")}
        >
          <div style={{ maxWidth: 220 }}>
            <TextField label="Messages per day" type="number" min={1} max={100000} value={values.dailyCapMessages} onChange={set("dailyCapMessages")} autoComplete="off" />
          </div>
        </Row>
      </Group>

      <Box paddingInlineStart="100">
        <BlockStack gap="100">
          <Text as="h4" variant="headingXs">Before a big day</Text>
          <Text as="p" variant="bodySm" tone="subdued">· Turn Peak Mode on (or schedule it) a day early.</Text>
          <Text as="p" variant="bodySm" tone="subdued">· Check your Anthropic spend limit covers the event (console.anthropic.com → Settings → Limits).</Text>
          <Text as="p" variant="bodySm" tone="subdued">· Hold app updates until it's over.</Text>
        </BlockStack>
      </Box>
    </BlockStack>
  );
}

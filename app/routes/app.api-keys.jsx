import { typeformId, FEEDBACK_COLORS, FEEDBACK_ICONS, storepointId, locatorPageUrl, locatorStores } from "../lib/feedback-survey.js";
import { chatRatingConfig } from "../lib/chat-rating.js";
import { appLinkError, cleanAppText, defaultAppText, appImageError, APP_TEXT_MAX, APP_BUTTON_MAX, APP_IMAGE_MAX_BYTES } from "../lib/app-promo.js";
import { focusImageError, focusImageKey } from "../lib/focus-home.js";
import { getShopName, getShopHosts } from "../lib/shop-name.server.js";
import { CHAT_TEXT_FIELDS, AVA_TEXT_DEFAULTS, chatTextsFromForm, chatTextsForForm } from "../lib/chat-texts.js";
import { buyNowCodeError, BUY_NOW_CODE_MAX } from "../lib/buy-now.js";
import { useLoaderData, useActionData, useNavigation, Form, useFetcher, useRevalidator, useRouteLoaderData } from "react-router";
import { visualizeLabel } from "../lib/visualize-cta.server";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Page,
  BlockStack,
  InlineStack,
  TextField,
  Select,
  ChoiceList,
  Button,
  Banner,
  Text,
  Badge,
  ButtonGroup,
  Box,
  Icon,
  Modal,
  Spinner,
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
import { TitleBar, SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import { requireFullAccess } from "../lib/staff-access.server";
import { ALLOWED_MODELS, chatModel } from "../lib/claude-models.js";
import { getShopConfig, updateShopConfig } from "../models/ShopConfig.server";
import { getChatPulse } from "../models/ChatHealth.server";
import { backfillShopEmbeddings } from "../lib/embeddings.server";
import prisma from "../db.server";
import { getShopPlan } from "../lib/billing.server";
import BrandHeader from "../components/BrandHeader";
import { DEFAULT_APP_NAME, appBrand } from "../lib/app-brand.js";
import { OrbColorsCard } from "../components/AssistantLookCards";
import { RecordingCard, ChatGuardCard } from "../components/RecordingCard";
import { SETTINGS_CSS, Row, Group, SectionHead, SettingsNav, Stat, Switch } from "../components/SettingsUI";
import { recordingState, keepDays, KEEP_DAYS_CHOICES } from "../lib/chat-recording.js";
import { guardMode } from "../lib/chat-guard.js";
import { parseOrbColors, serializeOrbColors, parseOrbBackground, serializeOrbBackground } from "../lib/orb-colors";
import { launcherMark, cleanLauncherText, avatarPreviewUrl } from "../lib/launcher-mark.js";
import { clampDelay, startTheme, parseCountries, APPEAR_DELAY_MIN, APPEAR_DELAY_MAX } from "../lib/appear-delay.js";
import { pageHandleFromUrl } from "../lib/promo-page.js";
import { NORMAL_LIMITS, PEAK_LIMITS, LIMIT_MAX, PEAK_MODES, peakState, storeChatLimits } from "../lib/peak-mode.js";
import { parsePeakHome, peakHomeError, parseHomeLook, HOME_CARDS as HOME_CARD_STYLES, HOME_CARD_WORDS, cleanPeakColors, PEAK_BLOCKS_MAX, PEAK_MAX, PEAK_AUDIENCE_WORDS, PEAK_LAYOUTS, PEAK_LAYOUT_WORDS, PEAK_SHAPES, PEAK_SHAPE_WORDS, PEAK_COLOR_SETS, PEAK_COLORS_MAX, PEAK_RINGS, PEAK_RING_WORDS, PEAK_DECORS, PEAK_DECOR_WORDS, PEAK_FOCUS } from "../lib/peak-home.js";
import { previewUrl } from "../lib/peak-preview.server.js";
import { parseSupportStaff, SUPPORT_STAFF_MAX } from "../lib/staff-access.js";
import { seasonOf, colorOf, collectionHandle, LABEL_MAX } from "../lib/seasonal-cta.js";
import { parseRewardsCard, REWARDS_MAX, REWARDS_ROWS, REWARDS_NOTES } from "../lib/rewards-card.js";
import { promoMemoryDays, styleMemoryDays, PROMO_DAYS_CHOICES, STYLE_DAYS_CHOICES } from "../lib/memory.js";
import { parseReturnRules, returnRulesDefaults, RETURN_REASONS } from "../lib/return-rules.js";
import { HUMAN_MAX, humanHelpFields } from "../lib/human-help.js";
import { shopFacts } from "../lib/shopify-facts.server.js";
import { appName } from "../lib/app-brand.js";
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
  const { session, admin } = await requireFullAccess(request);
  const [config, plan, pulse, shopName] = await Promise.all([
    getShopConfig(session.shop),
    getShopPlan(session.shop),
    getChatPulse(session.shop).catch(() => null),
    getShopName(admin, session.shop),
  ]);
  // The app's brand (AVA on the Aetrex app) picks the defaults of the
  // rewards card and the ways to reach a person.
  const brand = appBrand(appName(await shopFacts(session.shop, config, { admin }).catch(() => null)));
  const seasonalHandle = collectionHandle(config.seasonalCtaCollection);
  // The store's own domain, for the Peak Mode preview link (the myshopify one when it can't be read).
  const storeUrl = await admin.graphql("{ shop { primaryDomain { url } } }").then((r) => r.json()).then((j) => String(j?.data?.shop?.primaryDomain?.url || "")).catch(() => "");
  // The photo the storefront chat reported, from the store's own domains only.
  const shopHosts = await getShopHosts(admin, session.shop);
  let hideOnUrls = [];
  try { hideOnUrls = JSON.parse(config.hideOnUrls || "[]"); } catch { hideOnUrls = []; }
  return {
    hasAnthropicKey: config.anthropicApiKey !== "",
    anthropicModel: chatModel(config.anthropicModel),
    showFollowUps: config.showFollowUps !== false,
    streamRepliesOn: config.streamRepliesOn !== false,
    showFeedback: config.showFeedback !== false,
    chatRatingOn: config.chatRatingOn !== false,
    chatRatingAfter: chatRatingConfig(config).after,
    hasYotpoKey: config.yotpoApiKey !== "",
    hasAftershipKey: config.aftershipApiKey !== "",
    hideOnUrls: Array.isArray(hideOnUrls) ? hideOnUrls : [],
    welcomeIntroOn: config.welcomeGlowStyle !== "none",
    orbColors: parseOrbColors(config.orbColors),
    orbBackground: parseOrbBackground(config.orbBackground),
    launcherMark: launcherMark(config.launcherMark),
    launcherText: cleanLauncherText(config.launcherText),
    avatarUrl: avatarPreviewUrl(config.widgetAvatarUrl, shopHosts),
    // "photo" (the theme editor has one), "none", or "unknown" (the chat
    // hasn't reported since this was added).
    avatarState: config.widgetAvatarUrl == null ? "unknown" : config.widgetAvatarUrl ? "photo" : "none",
    voiceInput: config.voiceInput !== false,
    recording: recordingState(config),
    guardMode: guardMode(config),
    shopDomain: session.shop,
    // Talk to a person: the brand's defaults, shown as placeholders.
    humanDefaults: humanHelpFields({}, { brand }),
    supportUrl: config.supportUrl || "",
    supportLabel: config.supportLabel || "",
    supportHours: config.supportHours || "",
    supportPhone: config.supportPhone || "",
    supportEmail: config.supportEmail || "",
    supportReplyTime: config.supportReplyTime || "",
    rewardsCard: parseRewardsCard(config.rewardsCard, { brand }),
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
    storeLocatorStores: locatorStores(config.storeLocatorStores),
    appPromoOn: config.appPromoOn !== false,
    appIosUrl: config.appIosUrl || "",
    appAndroidUrl: config.appAndroidUrl || "",
    appPromoText: config.appPromoText || "",
    appPromoButton: config.appPromoButton || "",
    appPromoDefaultText: defaultAppText(shopName),
    appPromoImage: config.appPromoImage || "",
    // Focus home (Theme editor → Home layout → Focus): the cards' pictures.
    focusPainImage: config.focusPainImage || "",
    focusFootwearImage: config.focusFootwearImage || "",
    focusOrthoticsImage: config.focusOrthoticsImage || "",
    buyNowEnabled: config.buyNowEnabled === true,
    buyNowCode: config.buyNowCode || "",
    appEventsEnabled: config.appEventsEnabled !== false,
    hideLiveChatButton: config.hideLiveChatButton === true,
    appearDelayOn: config.appearDelayOn === true,
    appearDelaySec: clampDelay(config.appearDelaySec),
    startTheme: startTheme(config.startTheme),
    ...chatTextsForForm(config.chatTexts),
    hideInternational: config.hideInternational !== false,
    homeCountries: parseCountries(config.homeCountries).join(", "),
    promoPageUrl: config.promoPageUrl || "",
    promoPageStop: config.promoPageStop || "",
    promoMemoryDays: String(promoMemoryDays(config.promoMemoryDays)),
    styleMemoryDays: String(styleMemoryDays(config.styleMemoryDays)),
    returnsCardOn: config.returnsCardOn !== false,
    focusCollectionsOn: config.focusCollectionsOn !== false,
    dealsCardOn: config.dealsCardOn !== false,
    dealsUrl: config.dealsUrl || "",
    returnRules: parseReturnRules(config.returnRules, { reasonKeys: RETURN_REASONS.map((r) => r.key) }),
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
    // The home on peak days (promotion blocks, the peak picture).
    peakHome: parsePeakHome(config.peakHome),
    // Her look on every other day (Focus home): colours, ring, lights, tint, the cards' style.
    homeLook: parseHomeLook(config.homeLook),
    peakPreviewUrl: previewUrl(storeUrl, session.shop),
    supportStaff: parseSupportStaff(config.supportStaff),
    limitsOverridden: storeChatLimits(config, { env: process.env }).overridden,
    pulse,
    plan: { id: plan.id, name: plan.name, features: plan.features },
  };
};

export const action = async ({ request }) => {
  const { session, admin } = await requireFullAccess(request);
  const formData = await request.formData();

  // Cards that save on their own (orb colors, recording, See It
  // Styled) submit with an intent through useFetcher.
  const intent = formData.get("intent");
  if (intent === "save_orb_colors") {
    const stored = serializeOrbColors([0, 1, 2, 3, 4].map((i) => formData.get(`c${i}`)));
    const bg = serializeOrbBackground(formData.get("bg"));
    if (stored === null || bg === null) return { orbError: "Each color needs to be a hex value like #1a4dff." };
    // The AVA mark card also says what sits in the chat bar (older pages
    // that don't send it leave it as it is).
    const mark = formData.get("mark");
    const markData = mark === null ? {} : { launcherMark: launcherMark(mark), launcherText: cleanLauncherText(formData.get("text")) };
    const saved = await updateShopConfig(session.shop, { orbColors: stored, orbBackground: bg, ...markData });
    return {
      orbSaved: true,
      colors: parseOrbColors(stored),
      bg: parseOrbBackground(bg),
      mark: launcherMark(saved?.launcherMark),
      text: cleanLauncherText(saved?.launcherText),
    };
  }

  // Your app → the app's picture (resized in the browser before it's sent).
  if (intent === "save_app_image") {
    const image = String(formData.get("image") || "");
    const err = appImageError(image);
    if (err) return { appImageError: err };
    await updateShopConfig(session.shop, { appPromoImage: image });
    return { appImageSaved: true, appImage: image };
  }

  // Focus home → the Foot pain / Footwear / Orthotics card pictures (resized in the browser).
  if (intent === "save_focus_image") {
    const key = focusImageKey(String(formData.get("kind") || ""));
    if (!key) return { focusImageError: "Unknown card." };
    const image = String(formData.get("image") || "");
    const err = focusImageError(image);
    if (err) return { focusImageError: err };
    await updateShopConfig(session.shop, { [key]: image });
    return { focusImageSaved: true, focusImage: image };
  }

  // Recording → Customer service team: who sees the Recordings page only.
  if (intent === "save_support_staff") {
    const staff = parseSupportStaff(String(formData.get("staff") || ""));
    await updateShopConfig(session.shop, { supportStaff: JSON.stringify(staff) });
    return { supportStaffSaved: true, supportStaff: staff };
  }
  if (intent === "save_recording") {
    const on = formData.get("on") === "true";
    const scope = formData.get("scope") === "everyone" ? "everyone" : "testers";
    const days = Number(formData.get("keepDays"));
    const saved = await updateShopConfig(session.shop, { recordChatsOn: on, recordChatsScope: scope, recordKeepDays: KEEP_DAYS_CHOICES.includes(days) ? days : keepDays(null) });
    return { recording: recordingState(saved) };
  }
  if (intent === "save_guard") {
    const mode = String(formData.get("mode") || "");
    const saved = await updateShopConfig(session.shop, { chatGuardMode: guardMode({ chatGuardMode: mode }) });
    return { guardMode: guardMode(saved) };
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
  bool("streamRepliesOn");
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
      if (Array.isArray(parsed)) data.hideOnUrls = JSON.stringify(parsed.filter((r) => r && typeof r.pattern === "string" && r.pattern.trim()).slice(0, 100).map((r) => ({ matchType: r.matchType === "contains" ? "contains" : "equals", pattern: String(r.pattern).trim().slice(0, 300), ...(r.mode === "compact" ? { mode: "compact" } : {}) })));
    } catch { /* ignore invalid JSON */ }
  }
  bool("hideLiveChatButton");

  // Chat text: saved together, only when the form sent them.
  if (CHAT_TEXT_FIELDS.some(([, field]) => formData.get(field) !== null)) {
    // The Classic home's old headings stay as they were saved.
    const prevTexts = (await getShopConfig(session.shop))?.chatTexts || "{}";
    data.chatTexts = chatTextsFromForm((field) => formData.get(field), prevTexts);
  }

  // Customer care
  text("supportUrl");
  text("supportLabel");
  text("supportHours", HUMAN_MAX.hours);
  text("supportPhone", HUMAN_MAX.phone);
  text("supportEmail", HUMAN_MAX.email);
  text("supportReplyTime", HUMAN_MAX.reply);
  // My rewards: the card as JSON, made safe.
  const rewardsRaw = formData.get("rewardsCard");
  if (rewardsRaw !== null) {
    try { data.rewardsCard = JSON.stringify(parseRewardsCard(JSON.parse(rewardsRaw), { brand: "SEoS" })); } catch { /* ignore invalid JSON */ }
  }
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
  bool("returnsCardOn");
  bool("focusCollectionsOn");
  const homeLookRaw = formData.get("homeLook");
  if (homeLookRaw !== null) {
    try { data.homeLook = JSON.stringify(parseHomeLook(JSON.parse(homeLookRaw))); } catch { /* ignore invalid JSON */ }
  }
  // Return rules (mirrored from AfterShip): the lists as JSON, made safe.
  const rulesRaw = formData.get("returnRules");
  if (rulesRaw !== null) {
    try { data.returnRules = JSON.stringify(parseReturnRules(JSON.parse(rulesRaw), { reasonKeys: RETURN_REASONS.map((r) => r.key) })); } catch { /* ignore invalid JSON */ }
  }

  // Shopping tools
  // Memory: how long ended offers and retired styles stay answerable.
  const promoDaysRaw = formData.get("promoMemoryDays");
  if (promoDaysRaw !== null) data.promoMemoryDays = promoMemoryDays(promoDaysRaw);
  const styleDaysRaw = formData.get("styleMemoryDays");
  if (styleDaysRaw !== null) data.styleMemoryDays = styleMemoryDays(styleDaysRaw);
  bool("dealsCardOn");
  const dealsUrlRaw = formData.get("dealsUrl");
  if (dealsUrlRaw !== null) {
    const u = String(dealsUrlRaw).trim();
    if (u && !/^https?:\/\/[^\s"'<>]+$|^\/[^\s"'<>]*$/i.test(u)) return fail("The deals link must be a full https:// link or a path on your store, like /collections/sale.", "tools");
    data.dealsUrl = u.slice(0, 500);
  }
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
  const locStores = formData.get("storeLocatorStores");
  if (locStores !== null) data.storeLocatorStores = locatorStores(String(locStores));
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
  // AVA in Shopify Analytics: on unless the store turns it off.
  bool("appEventsEnabled");
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
  const peakHomeRaw = formData.get("peakHome");
  if (peakHomeRaw !== null) {
    const bad = peakHomeError(peakHomeRaw);
    if (bad) return fail(bad, "peak");
    try { data.peakHome = JSON.stringify(parsePeakHome(JSON.parse(peakHomeRaw))); } catch { /* ignore invalid JSON */ }
  }
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
  { id: "assistant", label: "AVA", icon: MagicIcon },
  { id: "look", label: "Look & feel", icon: PaintBrushFlatIcon },
  { id: "seasonal", label: "Seasonal button", icon: FlowerIcon },
  { id: "visibility", label: "Where it shows", icon: ViewIcon },
  { id: "care", label: "Customer care", icon: ChatIcon },
  { id: "tools", label: "Shopping tools", icon: CartIcon },
  { id: "integrations", label: "Integrations", icon: ConnectIcon },
  { id: "peak", label: "Peak Mode", icon: GaugeIcon },
  { id: "testing", label: "Recording", icon: PlayCircleIcon },
];

// Every field the Save button sends, the section it lives in, and its kind
// ("bool" → "true"/"false", "json" → JSON, "secret" → cleared after a save).
const FIELDS = {
  anthropicApiKey: ["assistant", "secret"], anthropicModel: ["assistant"], showFollowUps: ["assistant", "bool"], streamRepliesOn: ["assistant", "bool"],
  showFeedback: ["assistant", "bool"], chatRatingOn: ["assistant", "bool"], chatRatingAfter: ["assistant"],
  startTheme: ["look"], welcomeIntroOn: ["look", "bool"], voiceInput: ["look", "bool"],
  ...Object.fromEntries(CHAT_TEXT_FIELDS.map(([, field]) => [field, ["look"]])),
  appearDelayOn: ["visibility", "bool"], appearDelaySec: ["visibility"], hideInternational: ["visibility", "bool"],
  homeCountries: ["visibility"], hideOnUrls: ["visibility", "json"], hideLiveChatButton: ["visibility", "bool"],
  supportUrl: ["care"], supportLabel: ["care"], supportHours: ["care"], supportPhone: ["care"], supportEmail: ["care"], supportReplyTime: ["care"], trackingPageUrl: ["care"], returnsPageUrl: ["care"],
  rewardsCard: ["tools", "json"],
  returnsInChat: ["care", "bool"], returnWindowDays: ["care"], returnsDeliveredOnly: ["care", "bool"], guestOrderLookup: ["care", "bool"], returnsCardOn: ["care", "bool"], focusCollectionsOn: ["look", "bool"], homeLook: ["look", "json"], returnRules: ["care", "json"],
  promoPageUrl: ["tools"], promoPageStop: ["tools"], promoMemoryDays: ["tools"], styleMemoryDays: ["tools"], dealsCardOn: ["tools", "bool"], dealsUrl: ["tools"], whichOrthotic: ["tools"], whichOrthoticLabel: ["tools"],
  storeLocatorMapId: ["tools"], storeLocatorLabel: ["tools"], storeLocatorUrl: ["tools"], storeLocatorStores: ["tools"],
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
  appEventsEnabled: ["integrations", "bool"],
  peakMode: ["peak"], peakStartsAt: ["peak"], peakEndsAt: ["peak"], chatLimitPerMin: ["peak"], chatLimitPerHour: ["peak"],
  peakLimitPerMin: ["peak"], peakLimitPerHour: ["peak"], peakLiftDailyCap: ["peak", "bool"], peakPauseSync: ["peak", "bool"],
  peakHome: ["peak", "json"],
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
  const [mode, setMode] = useState("hide");
  const [pattern, setPattern] = useState("");
  const add = () => {
    const p = pattern.trim();
    if (!p || rules.some((r) => r.matchType === matchType && r.pattern === p)) return;
    onChange([...rules, { matchType, pattern: p, ...(mode === "compact" ? { mode: "compact" } : {}) }]);
    setPattern("");
  };
  return (
    <BlockStack gap="300">
      {rules.length > 0 && (
        <InlineStack gap="200" wrap>
          {rules.map((r, i) => (
            <span key={`${r.matchType}:${r.pattern}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 4px 3px 10px", borderRadius: 999, background: "rgba(26,46,38,0.06)", fontSize: 12.5 }}>
              <span style={{ color: "#616161" }}>{r.mode === "compact" ? "minimized where the link" : "hidden where the link"} {r.matchType === "contains" ? "contains" : "is"}</span>
              <code style={{ fontSize: 12 }}>{r.pattern}</code>
              <Button variant="plain" tone="critical" accessibilityLabel={`Remove ${r.pattern}`} onClick={() => onChange(rules.filter((_, j) => j !== i))}>×</Button>
            </span>
          ))}
        </InlineStack>
      )}
      <InlineStack gap="200" blockAlign="end" wrap={false}>
        <div style={{ width: 170, flex: "none" }}>
          <Select label="On that page" options={[{ label: "Hide AVA", value: "hide" }, { label: "Show minimized", value: "compact" }]} value={mode} onChange={setMode} helpText={mode === "compact" ? "The small “Ask Ava!” bubble instead of the chat bar." : undefined} />
        </div>
        <div style={{ width: 120, flex: "none" }}>
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
      help="When AVA picks one product, shoppers can tap for an AI styling preview of it. You bring an image-provider key and pay per image."
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
              <div hidden={section !== "care"}><CareSection values={values} set={set} d={d} /></div>
              <div hidden={section !== "tools"}><ToolsSection d={d} values={values} set={set} /></div>
              <div hidden={section !== "integrations"}><IntegrationsSection d={d} values={values} set={set} /></div>
              <div hidden={section !== "peak"}>
                <PeakSection d={d} values={values} set={set} draftPeak={draftPeak} mounted={mounted} onRefresh={() => revalidator.revalidate()} refreshing={revalidator.state !== "idle"} />
              </div>
              <div hidden={section !== "testing"}>
                <SectionHead title="Recording">Save conversations to review AVA's answers under Recordings, and end chats that keep trying to work AVA rather than shop.</SectionHead>
                <BlockStack gap="400">
                  <RecordingCard initial={d.recording} shopDomain={d.shopDomain} />
                  <ChatGuardCard initial={d.guardMode} />
                  <SupportTeamCard initial={d.supportStaff} />
                </BlockStack>
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
      <SectionHead title="AVA">AVA, your Aetrex Virtual Assistant: the AI behind the chat, and what it adds to its answers.</SectionHead>
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
        <Row title="Show the words as they are written" help={values.streamRepliesOn ? "The reply appears word by word while AVA writes it, then the verified answer takes its place — the fact check is the same either way. Shoppers wait for the first words, not the whole answer." : "The whole reply appears at once, after the fact check."} toggle checked={values.streamRepliesOn} onChange={set("streamRepliesOn")} />
        <Row title="Follow-up questions" help="2–3 tappable follow-ups after each answer — only ones AVA can answer." toggle checked={values.showFollowUps} onChange={set("showFollowUps")} />
        <Row title="Helpful / Not helpful" help="Quiet thumbs under the newest answer; a thumbs-down asks what went wrong, in one tap. Feedback shows in Analytics." toggle checked={values.showFeedback} onChange={set("showFeedback")} />
        <Row title="Ask how the chat went" help="One quiet question per chat: right after an add to cart or Buy now, or else after a few replies. Ratings, reasons and comments show in Analytics." toggle checked={values.chatRatingOn} onChange={set("chatRatingOn")}>
          <div style={{ maxWidth: 220 }}>
            <Select label="Otherwise, ask after" options={[2, 3, 4, 5, 6].map((n) => ({ label: `${n} replies`, value: String(n) }))} value={values.chatRatingAfter} onChange={set("chatRatingAfter")} />
          </div>
        </Row>
      </Group>
    </BlockStack>
  );
}

const TEXT_DEFAULT = Object.fromEntries(CHAT_TEXT_FIELDS.map(([key, , , def]) => [key, def]));
const TEXT_MAX = Object.fromEntries(CHAT_TEXT_FIELDS.map(([key, , max]) => [key, max]));

const HOME_CARDS = [["Pain", "Foot pain"], ["Footwear", "Footwear"], ["Orthotics", "Orthotics"]];

function LookSection({ d, values, set }) {
  // The gray text: what the chat shows when a field is blank (the AVA app's
  // own words where it had them).
  const ava = appBrand(useRouteLoaderData("routes/app")?.appName || DEFAULT_APP_NAME) === "AVA";
  const tp = (key) => (ava && AVA_TEXT_DEFAULTS[key]) || TEXT_DEFAULT[key];
  return (
    <BlockStack gap="400">
      <SectionHead title="Look & feel">How AVA looks and moves on your store.</SectionHead>
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
        <Row stack help="The words shoppers see in the chat. Left blank, the chat uses the text shown in gray.">
          <BlockStack gap="300">
            <div className="set-grid">
              <TextField label="Chat name" value={values.textName} onChange={set("textName")} placeholder={tp("name")} maxLength={TEXT_MAX.name} autoComplete="off" helpText="At the top of the chat. In its replies, AVA always introduces itself as Ava, the Aetrex Virtual Assistant." />
              <TextField label="Under the chat name" value={values.textNameSub} onChange={set("textNameSub")} placeholder="Optional, e.g. Aetrex Virtual Assistant" maxLength={TEXT_MAX.nameSub} autoComplete="off" helpText="A smaller gray line under the name. Left blank, the header shows just the name." />
            </div>
            <div className="set-grid set-grid--3">
              <TextField label="Welcome greeting" value={values.textGreeting} onChange={set("textGreeting")} placeholder={tp("greeting")} maxLength={TEXT_MAX.greeting} autoComplete="off" helpText="The header's words at home, beside Ava's face, until a chat starts. On computers, and on phones unless the next field is set." />
              <TextField label="Welcome greeting on phones" value={values.textGreetingPhone} onChange={set("textGreetingPhone")} placeholder={values.textGreeting || tp("greeting")} maxLength={TEXT_MAX.greetingPhone} autoComplete="off" helpText="A shorter one for phone screens. Left blank, phones show the greeting too." />
              <TextField label="Welcome greeting, signed in" value={values.textGreetingLoggedIn} onChange={set("textGreetingLoggedIn")} placeholder={tp("greetingLoggedIn")} maxLength={TEXT_MAX.greetingLoggedIn} autoComplete="off" helpText="For signed-in shoppers, on every screen; {name} becomes their first name." />
            </div>
            <div className="set-grid">
              <TextField label="Line under the greeting" value={values.textGreetingCta} onChange={set("textGreetingCta")} placeholder={tp("greetingCta")} maxLength={TEXT_MAX.greetingCta} autoComplete="off" helpText="The gray line under the greeting; it slides through other languages when that's on." />
              <TextField label="Message box" value={values.textInput} onChange={set("textInput")} placeholder={tp("input")} maxLength={TEXT_MAX.input} autoComplete="off" />
            </div>
            <div className="set-grid">
              <TextField label="Chat button" value={values.textLauncher} onChange={set("textLauncher")} placeholder={tp("launcher")} maxLength={TEXT_MAX.launcher} autoComplete="off" helpText="The bar shoppers tap to open the chat." />
              <TextField label="Fit & size button" value={values.textFitButton} onChange={set("textFitButton")} placeholder={tp("fitButton")} maxLength={TEXT_MAX.fitButton} autoComplete="off" helpText="On product cards, under Add to cart, with Fit confidence on (Recommenders). It opens the Fit score and the size finder." />
            </div>
            <TextField label="Note under the message box" value={values.textDisclaimer} onChange={set("textDisclaimer")} placeholder={tp("disclaimer")} maxLength={TEXT_MAX.disclaimer} autoComplete="off" multiline={2} helpText="The small print at the bottom of the chat; a Privacy Policy link follows it." />
          </BlockStack>
        </Row>
      </Group>
      <Group title="Focus home">
        <Row stack help="The three cards — Foot pain, Footwear and Orthotics — each with its small line on top, its name, the line under it and its button. On a computer the Foot pain card is the wide one in the middle and shows its wide title; phones show the short one.">
          <BlockStack gap="400">
            {HOME_CARDS.map(([kind, label]) => (
              <BlockStack gap="200" key={kind}>
                <Text as="h3" variant="headingSm">{label} card</Text>
                <div className="set-grid set-grid--3">
                  <TextField label="Small line on top" value={values[`textHome${kind}Eyebrow`]} onChange={set(`textHome${kind}Eyebrow`)} placeholder={tp(`home${kind}Eyebrow`)} maxLength={TEXT_MAX[`home${kind}Eyebrow`]} autoComplete="off" />
                  <TextField label="Name" value={values[`textHome${kind}Title`]} onChange={set(`textHome${kind}Title`)} placeholder={tp(`home${kind}Title`)} maxLength={TEXT_MAX[`home${kind}Title`]} autoComplete="off" />
                  <TextField label="Button" value={values[`textHome${kind}Cta`]} onChange={set(`textHome${kind}Cta`)} placeholder={tp(`home${kind}Cta`)} maxLength={TEXT_MAX[`home${kind}Cta`]} autoComplete="off" />
                </div>
                {kind === "Pain" && (
                  <TextField label="Name on a computer (the wide card)" value={values.textHomePainTitleWide} onChange={set("textHomePainTitleWide")} placeholder={tp("homePainTitleWide")} maxLength={TEXT_MAX.homePainTitleWide} autoComplete="off" />
                )}
                <TextField label="Line under the name" value={values[`textHome${kind}Sub`]} onChange={set(`textHome${kind}Sub`)} placeholder={tp(`home${kind}Sub`)} maxLength={TEXT_MAX[`home${kind}Sub`]} autoComplete="off" helpText={kind === "Pain" ? undefined : "Shown on computers; phones show just the name and button."} />
              </BlockStack>
            ))}
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Buttons above the message box</Text>
              <Text as="p" tone="subdued">Three are built in and open their own card — no question to AVA. Switch each where it lives: <b>My rewards</b> ({values.rewardsCard?.on ? "on" : "off"}, Shopping tools → My rewards), <b>Returns &amp; exchanges</b> ({values.returnsCardOn ? "on" : "off"}, Customer care → Returns &amp; exchanges on the home), <b>Deals</b> ({values.dealsCardOn ? "on" : "off"}, Shopping tools → Deals). Your own links below come after them; a link named like a built-in button is hidden while that button is on.</Text>
              {[1, 2, 3].map((n) => (
                <div className="set-grid" key={n}>
                  <TextField label={`Link ${n}`} value={values[`textHomeLink${n}Label`]} onChange={set(`textHomeLink${n}Label`)} placeholder={tp(`homeLink${n}Label`)} maxLength={TEXT_MAX[`homeLink${n}Label`]} autoComplete="off" />
                  <TextField label={`Link ${n} asks`} value={values[`textHomeLink${n}Message`]} onChange={set(`textHomeLink${n}Message`)} placeholder={tp(`homeLink${n}Message`)} maxLength={TEXT_MAX[`homeLink${n}Message`]} autoComplete="off" />
                </div>
              ))}
            </BlockStack>
          </BlockStack>
        </Row>
        <Row
          title="Collections in the Footwear and Orthotics sheets"
          help={values.focusCollectionsOn ? "A Collections section of one-tap chips (New arrivals, Best sellers, the named collections…) above Pick & go in both sheets." : "No Collections section in the sheets — the helper rows and Pick & go only. Switch it back on once every collection answers."}
          toggle
          checked={values.focusCollectionsOn}
          onChange={set("focusCollectionsOn")}
        />
        <Row stack help="The cards' pictures, filling each card's picture side. Switch layouts in the theme editor (AVA → Home layout).">
          <BlockStack gap="300">
            <FocusPicture kind="pain" initial={d.focusPainImage} />
            <FocusPicture kind="footwear" initial={d.focusFootwearImage} />
            <FocusPicture kind="orthotics" initial={d.focusOrthoticsImage} />
          </BlockStack>
        </Row>
        <Row stack help="Her look on every other day — the same choices Peak Mode has for peak days. Left as they are, the chat keeps its usual look. While Peak Mode is on, the peak look is used instead, as a whole.">
          <LookEditor value={values.homeLook} onChange={set("homeLook")} />
        </Row>
      </Group>
      <OrbColorsCard initial={d.orbColors} initialBg={d.orbBackground} initialMark={d.launcherMark} initialText={d.launcherText} avatarUrl={d.avatarUrl} avatarState={d.avatarState} launcherPrompt={values.textLauncher || TEXT_DEFAULT.launcher} />
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
        <Row title="Hide the Zendesk chat button" help="Removes the separate live chat button from the corner. Live chat still opens from AVA when a shopper asks for a person." toggle checked={values.hideLiveChatButton} onChange={set("hideLiveChatButton")} />
      </Group>
      <Group title="On these pages">
        <Row stack help="For each page link (or part of one): hide AVA there completely, or show her minimized — the small bubble instead of the chat bar, opening as always on a tap.">
          <HideOnPages rules={values.hideOnUrls} onChange={set("hideOnUrls")} />
        </Row>
      </Group>
    </BlockStack>
  );
}

// Return rules, the same ones AfterShip applies on the returns page (its
// API can't be asked for them, so the chat keeps a copy).
function ReturnRulesRow({ rules, onChange }) {
  const r = rules && typeof rules === "object" ? rules : returnRulesDefaults();
  const put = (patch) => onChange({ ...r, ...patch });
  const list = (v) => (Array.isArray(v) ? v.join(", ") : String(v || ""));
  const [typesText, setTypesText] = useState(list(r.types));
  const [tagsText, setTagsText] = useState(list(r.tags));
  const [wordsText, setWordsText] = useState(list(r.words));
  const split = (t) => t.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  return (
    <Row title="Return rules" help="The same rules as your AfterShip returns page, so the chat never offers a return AfterShip would refuse. Items matching these show as not returnable (no return or exchange button); for the reasons ticked, the chat shows the return fee as waived. Keep these in step with AfterShip — it still has the last word when a return is created." stack>
      <div className="set-grid">
        <TextField label="Not returnable — product types" value={typesText} onChange={(v) => { setTypesText(v); put({ types: split(v) }); }} placeholder="Gift Card" autoComplete="off" helpText="Comma-separated. Matches the product type exactly." />
        <TextField label="Not returnable — product tags" value={tagsText} onChange={(v) => { setTagsText(v); put({ tags: split(v) }); }} placeholder="final-sale, non-returnable" autoComplete="off" helpText="Comma-separated. Any of these tags on the product." />
        <TextField label="Not returnable — words in the title" value={wordsText} onChange={(v) => { setWordsText(v); put({ words: split(v) }); }} placeholder="gift card" autoComplete="off" helpText="Comma-separated. Anywhere in the product's title or type." />
      </div>
      <div style={{ marginTop: 12 }}>
        <ChoiceList title="Discounted items" choices={[{ label: "Items bought with a discount can't be returned", value: "on" }]} selected={r.discounted ? ["on"] : []} onChange={(sel) => put({ discounted: sel.includes("on") })} allowMultiple />
      </div>
      <div style={{ marginTop: 12 }}>
        <ChoiceList title="Reasons with no return fee" choices={RETURN_REASONS.map((x) => ({ label: x.label, value: x.key }))} selected={Array.isArray(r.freeReasons) ? r.freeReasons : []} onChange={(sel) => put({ freeReasons: sel })} allowMultiple />
      </div>
    </Row>
  );
}

function CareSection({ values, set, d }) {
  return (
    <BlockStack gap="400">
      <SectionHead title="Customer care">Handing shoppers to your team, and their orders and returns.</SectionHead>
      <Group title="Support">
        <Row stack help="When a shopper needs a person, AVA shows a button that opens your live chat (Zendesk, Intercom or Gorgias), or this page if there isn't one.">
          <div className="set-grid">
            <TextField label="Support page" value={values.supportUrl} onChange={set("supportUrl")} placeholder="https://yourstore.com/pages/contact" autoComplete="off" helpText="Blank: the theme editor's Support URL." />
            <TextField label="Button label" value={values.supportLabel} onChange={set("supportLabel")} placeholder="Chat with Aetrex Support" autoComplete="off" />
          </div>
        </Row>
        <Row stack title="Talk to a person" help="In the chat's menu at any point: one tap opens your live chat (or the support page) and shows these ways to reach your team. Blank fields fall back to the defaults shown.">
          <div className="set-grid">
            <TextField label="Hours" value={values.supportHours} onChange={set("supportHours")} placeholder={d.humanDefaults.hours || "Mon–Fri 9am–5pm ET"} maxLength={HUMAN_MAX.hours} autoComplete="off" />
            <TextField label="Phone" value={values.supportPhone} onChange={set("supportPhone")} placeholder={d.humanDefaults.phone || "1-800-000-0000"} maxLength={HUMAN_MAX.phone} autoComplete="off" />
            <TextField label="Email" value={values.supportEmail} onChange={set("supportEmail")} placeholder={d.humanDefaults.email || "help@yourstore.com"} maxLength={HUMAN_MAX.email} autoComplete="off" />
            <TextField label="Email reply time" value={values.supportReplyTime} onChange={set("supportReplyTime")} placeholder={d.humanDefaults.reply || "within 1 business day"} maxLength={HUMAN_MAX.reply} autoComplete="off" helpText="Shown as “we reply within …”." />
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
          title="Returns & exchanges on the home"
          help={values.returnsCardOn ? "A “Returns & exchanges” button on the Focus home: one tap, no AI. Signed in, it shows their recent orders with Start a return on each; signed out, sign in or an order lookup, with where to find the order number." : "No Returns & exchanges button on the Focus home (shoppers can still ask)."}
          toggle
          checked={values.returnsCardOn}
          onChange={set("returnsCardOn")}
        />
        <Row
          title="Returns and exchanges in the chat"
          help={values.returnsInChat ? "Signed-in shoppers start returns and exchanges right in the chat (needs the AfterShip key in Integrations)." : "Order cards show “Start a return”, which opens the returns page with the order filled in."}
          toggle
          checked={values.returnsInChat}
          onChange={set("returnsInChat")}
        />
        <ReturnRulesRow rules={values.returnRules} onChange={set("returnRules")} />
        <Row
          title="Return window"
          help="Older orders don't get a return button, and AVA explains why. 0 = no limit."
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
// Kept as sharp as the limit allows: scaled to the height given (never up),
// then, only if the file would still be over the size limit, encoded a
// little smaller, and a little smaller again, until it fits.
const dataUrlBytes = (u) => Math.floor(((u.split(",")[1] || "").length * 3) / 4);
function resizeAppImage(file, maxHeight = APP_IMAGE_HEIGHT, maxBytes = APP_IMAGE_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let scale = Math.min(1, maxHeight / img.naturalHeight);
      const encode = (sc, q) => {
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * sc));
        c.height = Math.max(1, Math.round(img.naturalHeight * sc));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        const webp = c.toDataURL("image/webp", q);
        return webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/png");
      };
      let out = encode(scale, 0.92);
      for (const q of [0.86, 0.8]) { if (dataUrlBytes(out) <= maxBytes) break; out = encode(scale, q); }
      for (let i = 0; i < 6 && dataUrlBytes(out) > maxBytes; i++) { scale *= 0.85; out = encode(scale, 0.84); }
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unreadable")); };
    img.src = url;
  });
}
// Settings → Choose from files: the store's Shopify Files — pictures, and
// videos where a field takes them — searched by name, a page at a time
// (app/routes/app.files.jsx). A pick hands back the file's link; nothing is
// copied, so it stays as sharp as it was uploaded.
const FILE_KIND_OPTIONS = [{ label: "Pictures and videos", value: "all" }, { label: "Pictures", value: "image" }, { label: "Videos", value: "video" }];
function FilesPicker({ open, onClose, onPick, kinds = "image", title = "Choose from your files" }) {
  const shopify = useAppBridge();
  const [q, setQ] = useState("");
  const [words, setWords] = useState("");
  const [kind, setKind] = useState(kinds);
  const [files, setFiles] = useState([]);
  const [after, setAfter] = useState("");
  const [hasNext, setHasNext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const gen = useRef(0);
  useEffect(() => { const t = setTimeout(() => setWords(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const load = useCallback(async (reset) => {
    const my = ++gen.current;
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ kind, q: words, after: reset ? "" : after });
      const token = await shopify.idToken();
      const res = await fetch(`/app/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => ({}));
      if (my !== gen.current) return;
      if (!res.ok) throw new Error(body.error || "Your files couldn't be read just now.");
      setFiles((old) => (reset ? body.files : [...old, ...body.files.filter((f) => !old.some((o) => o.id === f.id))]));
      setAfter(body.after || ""); setHasNext(Boolean(body.hasNext));
    } catch (err) {
      if (my === gen.current) setError(err.message || "Your files couldn't be read just now.");
    } finally {
      if (my === gen.current) setBusy(false);
    }
  }, [kind, words, after, shopify]);
  useEffect(() => { if (open) load(true); }, [open, kind, words]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!open) { setQ(""); setWords(""); setKind(kinds); } }, [open, kinds]);
  const dur = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  return (
    <Modal open={open} onClose={onClose} title={title} size="large">
      <Modal.Section>
        <BlockStack gap="300">
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <div style={{ flex: 1 }}><TextField label="Search your files" labelHidden placeholder="Search by file name" value={q} onChange={setQ} clearButton onClearButtonClick={() => setQ("")} autoComplete="off" /></div>
            {kinds === "all" ? <Select label="Kind" labelHidden options={FILE_KIND_OPTIONS} value={kind} onChange={setKind} /> : null}
          </InlineStack>
          {error ? <Banner tone="critical">{error}</Banner> : null}
          {files.length > 0 ? (
            <div className="set-files">
              {files.map((f) => (
                <button key={f.id} type="button" className="set-file" onClick={() => onPick(f)} aria-label={`${f.name || f.alt || "File"}${f.kind === "video" ? ", video" : ""}`}>
                  <span className="set-file__pic">
                    {f.poster ? <img src={f.poster} alt="" loading="lazy" /> : <span className="set-file__blank" aria-hidden="true">▶</span>}
                    {f.kind === "video" ? <span className="set-file__badge" aria-hidden="true">▶ {f.duration ? dur(f.duration) : "video"}</span> : null}
                  </span>
                  <span className="set-file__name">{f.name || f.alt || "Untitled"}</span>
                  <span className="set-file__meta">{f.width && f.height ? `${f.width} × ${f.height}` : "\u00a0"}</span>
                </button>
              ))}
            </div>
          ) : null}
          {!busy && !files.length && !error ? <Text as="p" variant="bodySm" tone="subdued">{words ? `Nothing named “${words}” in your files.` : "No files yet — upload them in Shopify under Content → Files, then pick them here."}</Text> : null}
          <InlineStack gap="200" blockAlign="center">
            {hasNext ? <Button onClick={() => load(false)} loading={busy}>Show more</Button> : null}
            {busy && !files.length ? <Spinner size="small" accessibilityLabel="Loading your files" /> : null}
          </InlineStack>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
// The button that opens the picker, for every picture field in Settings.
function FilesButton({ onPick, kinds = "image", label = "Choose from files", disabled = false, title }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={disabled}>{label}</Button>
      <FilesPicker open={open} onClose={() => setOpen(false)} kinds={kinds} title={title} onPick={(f) => { setOpen(false); onPick(f); }} />
    </>
  );
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
          <FilesButton disabled={disabled} onPick={(f) => { setLocalError(""); setPicked(f.url); send(f.url); }} />
          {image ? <Button variant="plain" tone="critical" onClick={remove} disabled={disabled || busy}>Remove</Button> : null}
          {fetcher.data?.appImageSaved && !busy ? <Text as="span" variant="bodySm" tone="success">Saved</Text> : null}
        </InlineStack>
        {error ? <Text as="p" variant="bodySm" tone="critical">{error}</Text> : null}
      </div>
    </div>
  );
}

// Focus home (Theme editor → Home layout → Focus): a picture for each of
// the three cards. Without one, Foot pain shows the heel picture built in
// and the line cards a line drawing.
// Settings → Shopping tools → My rewards: the instant card's words and logo.
function RewardsGroup({ card, onChange }) {
  const c = card || parseRewardsCard("{}");
  const up = (patch) => onChange({ ...c, ...patch });
  const row = (list, i, key, v) => { const next = [...(list || [])]; while (next.length <= i) next.push({ label: "", value: "" }); next[i] = { ...next[i], [key]: v }; return next; };
  const note = (i, v) => { const next = [...(c.notes || [])]; while (next.length <= i) next.push(""); next[i] = v; return next; };
  const inputRef = useRef(null);
  const [logoError, setLogoError] = useState("");
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setLogoError("");
    if (!/^image\/(png|webp|jpeg)$/.test(file.type)) { setLogoError("Choose a PNG, WebP or JPEG image."); return; }
    try { up({ logo: await resizeAppImage(file, 480) }); } catch { setLogoError("That image couldn't be read — try another one."); }
  };
  return (
    <Group title="My rewards">
      <Row
        title="My rewards card"
        help={c.on ? "A “My rewards” button on the home opens an instant card in the chat — how points are earned and spent, what to know, and a link to your rewards page. No AI reply, so it's free and immediate. Signed-in shoppers see their balance when Yotpo Loyalty is connected." : "Off: no My rewards button on the home."}
        toggle
        checked={Boolean(c.on)}
        onChange={(v) => up({ on: v })}
      >
        <BlockStack gap="300">
          <div className="set-grid">
            <TextField label="Program name" value={c.brand} onChange={(v) => up({ brand: v })} maxLength={REWARDS_MAX.brand} autoComplete="off" helpText="Shown as a wordmark when there's no logo." />
            <TextField label="Title" value={c.title} onChange={(v) => up({ title: v })} maxLength={REWARDS_MAX.title} autoComplete="off" />
            <TextField label="One line under the title" value={c.sub} onChange={(v) => up({ sub: v })} maxLength={REWARDS_MAX.sub} autoComplete="off" />
          </div>
          <div className="set-app-pic">
            <div className={`set-app-pic__thumb${c.logo ? "" : " is-empty"}`} style={{ aspectRatio: "auto", minHeight: 40 }}>{c.logo ? <img src={c.logo} alt="" style={{ objectFit: "contain" }} /> : <span aria-hidden="true">★</span>}</div>
            <div className="set-app-pic__body">
              <Text as="p" variant="bodyMd" fontWeight="semibold">Logo</Text>
              <Text as="p" variant="bodySm" tone="subdued">A wide logo works best; it shows 28px tall at the top of the card.</Text>
              <InlineStack gap="200" blockAlign="center">
                <input ref={inputRef} type="file" accept="image/png,image/webp,image/jpeg" hidden onChange={onFile} />
                <Button onClick={() => inputRef.current?.click()}>{c.logo ? "Replace logo" : "Upload logo"}</Button>
                <FilesButton onPick={(f) => { setLogoError(""); up({ logo: f.url }); }} />
                {c.logo ? <Button variant="plain" tone="critical" onClick={() => up({ logo: "" })}>Remove</Button> : null}
              </InlineStack>
              {logoError ? <Text as="p" variant="bodySm" tone="critical">{logoError}</Text> : null}
            </div>
          </div>
          <Text as="p" variant="bodySm" fontWeight="semibold">Earn — up to {REWARDS_ROWS} rows (what · how many points)</Text>
          <div className="set-grid">
            {Array.from({ length: REWARDS_ROWS }, (_, i) => (
              <InlineStack key={`e${i}`} gap="200" wrap={false}>
                <div style={{ flex: 1 }}><TextField label={`Earn ${i + 1}`} labelHidden value={c.earn?.[i]?.label || ""} onChange={(v) => up({ earn: row(c.earn, i, "label", v) })} placeholder="Every $1" maxLength={REWARDS_MAX.label} autoComplete="off" /></div>
                <div style={{ flex: 1 }}><TextField label={`Earn ${i + 1} points`} labelHidden value={c.earn?.[i]?.value || ""} onChange={(v) => up({ earn: row(c.earn, i, "value", v) })} placeholder="10 points" maxLength={REWARDS_MAX.value} autoComplete="off" /></div>
              </InlineStack>
            ))}
          </div>
          <Text as="p" variant="bodySm" fontWeight="semibold">Spend — up to {REWARDS_ROWS} rows (points · what they're worth)</Text>
          <div className="set-grid">
            {Array.from({ length: REWARDS_ROWS }, (_, i) => (
              <InlineStack key={`u${i}`} gap="200" wrap={false}>
                <div style={{ flex: 1 }}><TextField label={`Spend ${i + 1}`} labelHidden value={c.use?.[i]?.label || ""} onChange={(v) => up({ use: row(c.use, i, "label", v) })} placeholder="1,000 points" maxLength={REWARDS_MAX.label} autoComplete="off" /></div>
                <div style={{ flex: 1 }}><TextField label={`Spend ${i + 1} worth`} labelHidden value={c.use?.[i]?.value || ""} onChange={(v) => up({ use: row(c.use, i, "value", v) })} placeholder="$5 off" maxLength={REWARDS_MAX.value} autoComplete="off" /></div>
              </InlineStack>
            ))}
          </div>
          <Text as="p" variant="bodySm" fontWeight="semibold">Good to know — up to {REWARDS_NOTES} short lines</Text>
          {Array.from({ length: REWARDS_NOTES }, (_, i) => (
            <TextField key={`n${i}`} label={`Note ${i + 1}`} labelHidden value={c.notes?.[i] || ""} onChange={(v) => up({ notes: note(i, v) })} placeholder="Return something? The points come back on their own." maxLength={REWARDS_MAX.note} autoComplete="off" />
          ))}
          <div className="set-grid">
            <TextField label="Button" value={c.ctaLabel} onChange={(v) => up({ ctaLabel: v })} maxLength={REWARDS_MAX.cta} autoComplete="off" />
            <TextField label="Button link (your rewards page)" value={c.ctaUrl} onChange={(v) => up({ ctaUrl: v })} placeholder="https://www.aetrex.com/pages/rewards" autoComplete="off" />
          </div>
        </BlockStack>
      </Row>
    </Group>
  );
}

// Peak Mode → the home on peak days: the assistant's peak picture and up to
// six promotion blocks, saved with the form (pictures resized in the browser).
// Smaller copies of an uploaded tile picture, so a screen is handed one near
// the size it draws (a picture scaled down a long way in the browser goes
// soft or jagged, worst with small words). Made by halving, with the best
// smoothing, down to each width; only widths smaller than the picture.
const PEAK_COPY_WIDTHS = [800, 400];
async function peakCopies(dataUrl) {
  const im = new Image(); im.src = dataUrl; await im.decode();
  const out = { imageW: im.naturalWidth };
  for (const w of PEAK_COPY_WIDTHS) {
    if (w >= im.naturalWidth) continue;
    let cur = im, cw = im.naturalWidth, ch = im.naturalHeight;
    while (cw / 2 >= w) { const c = document.createElement("canvas"); c.width = Math.round(cw / 2); c.height = Math.round(ch / 2); const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(cur, 0, 0, c.width, c.height); cur = c; cw = c.width; ch = c.height; }
    const c = document.createElement("canvas"); c.width = w; c.height = Math.max(1, Math.round(ch * w / cw)); const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(cur, 0, 0, c.width, c.height);
    const webp = c.toDataURL("image/webp", 0.9);
    out[`image${w}`] = webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/png");
  }
  return out;
}
function PeakPicture({ image, onChange, title, hint, round = false, size = 640, kinds = "image", video = "", onPickFile = null, onRemoveVideo = null, copies = false }) {
  const inputRef = useRef(null);
  const [error, setError] = useState("");
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    if (!/^image\/(png|webp|jpeg)$/.test(file.type)) { setError("Choose a PNG, WebP or JPEG image."); return; }
    try {
      const data = await resizeAppImage(file, size);
      onChange(copies ? { image: data, ...(await peakCopies(data)) } : data);
    } catch { setError("That image couldn't be read — try another one."); }
  };
  return (
    <div className="set-app-pic">
      <div className={`set-app-pic__thumb${image || video ? "" : " is-empty"}`} style={round ? { width: 64, height: 64, borderRadius: "50%", overflow: "hidden" } : { width: 96, height: 64, borderRadius: 12, overflow: "hidden", position: "relative" }}>
        {image ? <img src={image} alt="" style={{ width: "100%", height: "100%", maxWidth: "none", maxHeight: "none", objectFit: "cover", filter: "none" }} /> : video ? <video src={video} muted playsInline preload="metadata" aria-hidden="true" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span aria-hidden="true">{round ? "☺" : "▭"}</span>}
        {video ? <span className="set-file__badge" aria-hidden="true">▶</span> : null}
      </div>
      <div className="set-app-pic__body">
        <Text as="p" variant="bodyMd" fontWeight="semibold">{title}</Text>
        {hint ? <Text as="p" variant="bodySm" tone="subdued">{hint}</Text> : null}
        <InlineStack gap="200" blockAlign="center">
          <input ref={inputRef} type="file" accept="image/png,image/webp,image/jpeg" hidden onChange={onFile} />
          <Button onClick={() => inputRef.current?.click()}>{image ? "Replace picture" : "Upload picture"}</Button>
          <FilesButton kinds={kinds} label={kinds === "all" ? "Choose from files (picture or video)" : "Choose from files"} onPick={(f) => { setError(""); if (onPickFile) onPickFile(f); else onChange(f.url); }} />
          {image ? <Button variant="plain" tone="critical" onClick={() => onChange("")}>{video ? "Remove picture" : "Remove"}</Button> : null}
          {video && onRemoveVideo ? <Button variant="plain" tone="critical" onClick={onRemoveVideo}>Remove video</Button> : null}
        </InlineStack>
        {video ? <Text as="p" variant="bodySm" tone="subdued">A video from your files plays silently on a loop{image ? ", with the picture shown until it starts" : ""}.</Text> : null}
        {error ? <Text as="p" variant="bodySm" tone="critical">{error}</Text> : null}
      </div>
    </div>
  );
}
// The glow as a ring, for the colour pickers: the set's four colours, or
// the usual ones; fewer than four repeat, as in the widget.
const GLOW_USUAL = ["#ff4fa3", "#a35cff", "#3d7bff", "#29e0d0"];
function glowRing(colors) {
  const c = cleanPeakColors(colors);
  const n = c.length;
  const g = n ? c.slice() : GLOW_USUAL.slice();
  while (g.length < 4) g.push(g[g.length - n]);
  return { background: `conic-gradient(from 0deg, ${g[0]}, ${g[1]}, ${g[2]}, ${g[3]}, ${g[0]})` };
}
// Where a tile's picture is anchored when cropped to its shape: nine
// points on a live preview of the tile, the picture moving as one is picked.
const FOCUS_WORDS = { center: "Centre", left: "Left", right: "Right", top: "Top", bottom: "Bottom", "top left": "Top left", "top right": "Top right", "bottom left": "Bottom left", "bottom right": "Bottom right" };
const FOCUS_GRID = ["top left", "top", "top right", "left", "center", "right", "bottom left", "bottom", "bottom right"];
function AnchorPicker({ image, video, shape, value, onChange }) {
  const focus = PEAK_FOCUS.includes(value) ? value : "center";
  const ar = { wide: "16 / 9", standard: "4 / 3", square: "1 / 1" }[shape] || "16 / 9";
  return (
    <div className="set-anchor">
      <div className="set-anchor__tile" style={{ aspectRatio: ar }}>
        {image ? <img src={image} alt="" style={{ objectPosition: focus }} /> : video ? <video src={video} muted playsInline preload="metadata" aria-hidden="true" style={{ objectPosition: focus }} /> : <span className="set-anchor__blank" aria-hidden="true">▭</span>}
        <div className="set-anchor__grid" role="radiogroup" aria-label="Where the picture is anchored">
          {FOCUS_GRID.map((k) => <button key={k} type="button" role="radio" aria-checked={focus === k} aria-label={FOCUS_WORDS[k]} className="set-anchor__dot" onClick={() => onChange(k)} />)}
        </div>
      </div>
      <div className="set-anchor__words">
        <Text as="p" variant="bodyMd" fontWeight="semibold">Anchored {FOCUS_WORDS[focus].toLowerCase()}</Text>
        <Text as="p" variant="bodySm" tone="subdued">The picture is cropped to the tile's shape; pick the point that stays in view — the preview shows the crop.</Text>
      </div>
    </div>
  );
}
// Her look — on peak days (the Peak Mode editor) or every other day (Focus
// home): the colours, the ring, the lights, the tint, and the three cards'
// style. `value` is the whole saved object; the editor hands back the same object with its part
// changed, so the peak editor's pictures ride along untouched.
function LookEditor({ value, onChange, peak = false }) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const up = (patch) => onChange({ ...v, ...patch });
  // Her colours: the set that matches what's saved, else the store's own.
  const colors = cleanPeakColors(v.colors);
  const setId = (PEAK_COLOR_SETS.find((c) => c.colors.join() === colors.join()) || { id: "own" }).id;
  const pickOwn = () => up({ colors: colors.length ? colors : PEAK_COLOR_SETS[1].colors });
  const setColor = (i, hex) => { const next = (colors.length ? colors : PEAK_COLOR_SETS[1].colors).slice(); while (next.length < PEAK_COLORS_MAX) next.push(next[next.length - 1]); next[i] = hex; up({ colors: next }); };
  const ownAt = (i) => colors[i] || colors[colors.length - 1] || "#ffffff";
  return (
    <BlockStack gap="400">
      <div className="set-peak-colors">
        <Text as="p" variant="bodyMd" fontWeight="semibold">{peak ? "Her colours on peak days" : "Her colours"}</Text>
        <Text as="p" variant="bodySm" tone="subdued">The glow around her face, the ring and the line under the header — usually pink, violet, blue and teal. Pick a set, or your own four.</Text>
        <div className="set-palettes" role="group" aria-label="Colour sets">
          {PEAK_COLOR_SETS.map((c) => (
            <button key={c.id} type="button" className="set-palette" aria-pressed={setId === c.id} onClick={() => up({ colors: c.colors })}>
              <span className="set-palette__ring" style={glowRing(c.colors)} aria-hidden="true" />
              <span>{c.label}</span>
            </button>
          ))}
          <button type="button" className="set-palette" aria-pressed={setId === "own"} onClick={pickOwn}>
            <span className="set-palette__ring" style={glowRing(setId === "own" ? colors : PEAK_COLOR_SETS[1].colors)} aria-hidden="true" />
            <span>Your own</span>
          </button>
        </div>
        {setId === "own" ? (
          <div className="set-swatches" role="group" aria-label="Your own colours">
            {Array.from({ length: PEAK_COLORS_MAX }, (_, i) => (
              <label key={i} className="set-swatch">
                <input type="color" value={ownAt(i)} onChange={(e) => setColor(i, e.target.value)} aria-label={`Colour ${i + 1}`} />
                <span className="set-swatch__dot" style={{ background: ownAt(i) }} aria-hidden="true" />
                <span className="set-swatch__hex">{ownAt(i).toUpperCase()}</span>
              </label>
            ))}
            <span className="set-swatch__preview" style={glowRing(colors)} aria-hidden="true" />
          </div>
        ) : null}
      </div>
      <div className="set-grid set-grid--3">
        <Select label="The ring around her face" options={PEAK_RINGS.map((k) => ({ value: k, label: PEAK_RING_WORDS[k] }))} value={PEAK_RINGS.includes(v.ring) ? v.ring : "fine"} onChange={(x) => up({ ring: x })} helpText="Heavier reads as a band of colour; the glow follows." />
        <Select label="Under the header" options={PEAK_DECORS.map((k) => ({ value: k, label: PEAK_DECOR_WORDS[k] }))} value={PEAK_DECORS.includes(v.decor) ? v.decor : "off"} onChange={(x) => up({ decor: x })} helpText="A few small points of the set's third colour in the open space at the right of the header, drifting and twinkling slowly. None on phones, where the header has no room." />
        <Select label="Tint behind the header" options={[{ value: "off", label: "Off — the grey line stays" }, { value: "on", label: "On — no grey line" }]} value={v.tint === true ? "on" : "off"} onChange={(x) => up({ tint: x === "on" })} helpText="A breath of the first colour behind her name, gone by the header's foot. With it on, the straight grey line under the header goes at home; off, the line stays as usual." />
      </div>
      <Select label="The three cards" options={HOME_CARD_STYLES.map((k) => ({ value: k, label: HOME_CARD_WORDS[k] }))} value={HOME_CARD_STYLES.includes(v.cards) ? v.cards : "full"} onChange={(x) => up({ cards: x })} helpText="Simple: Foot pain, Footwear and Orthotics as three boxes of one size in a row — a line drawing, the small line and the name, nothing else — on every screen. The pictures, the lines under the names and the buttons stay out of it." />
    </BlockStack>
  );
}

function PeakHomeEditor({ value, onChange }) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : { avatar: "", blocks: [] };
  const blocks = Array.isArray(v.blocks) ? v.blocks : [];
  const up = (patch) => onChange({ ...v, blocks, ...patch });
  const setBlock = (i, patch) => up({ blocks: blocks.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= blocks.length) return; const next = blocks.slice(); [next[i], next[j]] = [next[j], next[i]]; up({ blocks: next }); };
  const remove = (i) => up({ blocks: blocks.filter((_, j) => j !== i) });
  const add = () => { if (blocks.length >= PEAK_BLOCKS_MAX) return; up({ blocks: [...blocks, { id: `b${Date.now().toString(36).slice(-6)}`, title: "", kind: "link", url: "", message: "", image: "", video: "", focus: "center", audience: "all", tag: "" }] }); };
  const audienceOptions = Object.entries(PEAK_AUDIENCE_WORDS).map(([value, label]) => ({ value, label }));
  const layout = PEAK_LAYOUTS.includes(v.layout) ? v.layout : "rail";
  const shape = Object.prototype.hasOwnProperty.call(PEAK_SHAPES, v.shape) ? v.shape : "wide";
  const shapeWords = { wide: "wide (16 : 9)", standard: "standard (4 : 3)", square: "square" }[shape];
  return (
    <BlockStack gap="400">
      <PeakPicture round image={v.avatar || ""} onChange={(avatar) => up({ avatar })} title="The assistant's peak picture" hint="Shown in place of her usual picture while Peak Mode is on — a festive version of the same face. Square, at least 320px." size={480} />
      <LookEditor value={v} onChange={(next) => up(next)} peak />
      <div className="set-grid">
        <Select label="How the pictures sit" options={PEAK_LAYOUTS.map((k) => ({ value: k, label: PEAK_LAYOUT_WORDS[k] }))} value={layout} onChange={(x) => up({ layout: x })} helpText={layout === "rail" ? "Two and a half in view on a computer, one and a quarter on a phone; the rest a swipe away, no arrows." : layout === "mosaic" ? "The first picture big, the others around it — three to six look best." : "Two to a row, all the same size."} />
        <Select label="Their shape" options={Object.keys(PEAK_SHAPES).map((k) => ({ value: k, label: PEAK_SHAPE_WORDS[k] }))} value={shape} onChange={(x) => up({ shape: x })} helpText="Every picture is cropped to this shape, centred." />
      </div>
      <Text as="p" variant="bodySm" fontWeight="semibold">Pictures — up to {PEAK_BLOCKS_MAX}, in this order</Text>
      {blocks.length === 0 ? <Text as="p" variant="bodySm" tone="subdued">None yet. Without pictures the home keeps its banner; the peak picture and her colours still apply.</Text> : null}
      {blocks.map((b, i) => (
        <div key={b.id || i} className="set-peak-block">
          <InlineStack align="space-between" blockAlign="center" gap="200">
            <Text as="h4" variant="headingSm">Picture {i + 1}{b.title ? ` — ${b.title}` : ""}</Text>
            <InlineStack gap="100">
              <Button variant="plain" onClick={() => move(i, -1)} disabled={i === 0} accessibilityLabel="Move up">↑</Button>
              <Button variant="plain" onClick={() => move(i, 1)} disabled={i === blocks.length - 1} accessibilityLabel="Move down">↓</Button>
              <Button variant="plain" tone="critical" onClick={() => remove(i)}>Remove</Button>
            </InlineStack>
          </InlineStack>
          <PeakPicture copies image={b.image || ""} video={b.video || ""} kinds="all" onChange={(v) => setBlock(i, typeof v === "string" ? { image: v, imageW: 0, image800: "", image400: "" } : v)} onPickFile={(f) => (f.kind === "video" ? setBlock(i, { video: f.url, image: b.image || f.poster || "", imageW: 0, image800: "", image400: "" }) : setBlock(i, { image: f.url, imageW: 0, image800: "", image400: "" }))} onRemoveVideo={() => setBlock(i, { video: "" })} title="The picture or video" hint={`Just the picture (or a short silent video) — no words or buttons are drawn on it. Shown ${shapeWords}. For a sharp picture on Retina screens make it at least 1600px wide — about twice the size it's shown at; a smaller one is stretched and looks soft. Upload a picture, or pick a picture or video from your Shopify files.`} size={1100} />
          {b.image || b.video ? <AnchorPicker image={b.image || ""} video={b.video || ""} shape={shape} value={b.focus || "center"} onChange={(focus) => setBlock(i, { focus })} /> : null}
          <div className="set-grid">
            <Select label="A tap on it" options={[{ label: "Opens a link", value: "link" }, { label: "Asks AVA a question", value: "ask" }, { label: "Does nothing", value: "none" }]} value={b.kind === "ask" ? "ask" : b.kind === "none" ? "none" : "link"} onChange={(x) => setBlock(i, { kind: x })} />
            {b.kind === "ask"
              ? <TextField label="The question it asks" value={b.message || ""} onChange={(x) => setBlock(i, { message: x })} placeholder="What's on sale today?" maxLength={PEAK_MAX.message} autoComplete="off" />
              : b.kind === "none" ? <div /> : <TextField label="The link" value={b.url || ""} onChange={(x) => setBlock(i, { url: x })} placeholder="/collections/sale" maxLength={PEAK_MAX.url} autoComplete="off" />}
          </div>
          <div className="set-grid">
            <Select label="Who sees it" options={audienceOptions} value={b.audience || "all"} onChange={(x) => setBlock(i, { audience: x })} />
            {b.audience === "tag" ? <TextField label="Customer tag (as in Shopify)" value={b.tag || ""} onChange={(x) => setBlock(i, { tag: x })} placeholder="VIP" maxLength={PEAK_MAX.tag} autoComplete="off" helpText="Signed-in customers carrying this tag." /> : <div />}
          </div>
          <TextField label="What it says, for screen readers" value={b.title || ""} onChange={(x) => setBlock(i, { title: x })} placeholder="Black Friday: 30% off everything" maxLength={PEAK_MAX.title} autoComplete="off" helpText="Not shown — read out to shoppers who can't see the picture." />
        </div>
      ))}
      {blocks.length < PEAK_BLOCKS_MAX ? <div><Button onClick={add}>Add a picture</Button></div> : null}
    </BlockStack>
  );
}
// Recording → Customer service team: staff whose Shopify sign-in email is
// listed here see the Recordings page only — the chats, the shoppers'
// ratings and the lessons — with Settings, keys, Knowledge and the catalog
// out of reach. The store owner is never limited. Saves on its own.
function SupportTeamCard({ initial }) {
  const fetcher = useFetcher();
  const [text, setText] = useState(() => (Array.isArray(initial) ? initial : []).join("\n"));
  const saved = fetcher.data?.supportStaffSaved ? fetcher.data.supportStaff : null;
  const current = saved ?? (Array.isArray(initial) ? initial : []);
  const busy = fetcher.state !== "idle";
  const dirty = parseLines(text).join("\n") !== current.join("\n");
  const save = () => { const fd = new FormData(); fd.set("intent", "save_support_staff"); fd.set("staff", text); fetcher.submit(fd, { method: "post" }); };
  return (
    <Group title="Customer service team">
      <Row stack help={`Staff whose Shopify sign-in email is listed here see the Recordings page only — the chats, the shoppers' ratings and the lessons. Settings, keys, Knowledge, the catalog and Analytics stay out of reach for them. The store owner is never limited. One email per line, up to ${SUPPORT_STAFF_MAX}; they still need access to the app in Shopify's staff permissions.`}>
        <BlockStack gap="300">
          <TextField label="Team emails" labelHidden multiline={4} value={text} onChange={setText} placeholder={"support@yourstore.com\njamie@yourstore.com"} autoComplete="off" />
          <InlineStack gap="200" blockAlign="center">
            <Button variant="primary" onClick={save} loading={busy} disabled={!dirty}>Save team</Button>
            {current.length > 0 && !dirty ? <Text as="span" variant="bodySm" tone="subdued">{`${current.length} on the team`}</Text> : null}
            {fetcher.data?.supportStaffSaved && !busy && !dirty ? <Text as="span" variant="bodySm" tone="success">Saved</Text> : null}
          </InlineStack>
        </BlockStack>
      </Row>
    </Group>
  );
}
function parseLines(text) { return String(text || "").split(/[\n,;]/).map((v) => v.trim().toLowerCase()).filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)).filter((v, i, arr) => arr.indexOf(v) === i); }
function FocusPicture({ kind, initial }) {
  const fetcher = useFetcher();
  const inputRef = useRef(null);
  const [picked, setPicked] = useState(null);
  const [localError, setLocalError] = useState("");
  const saved = fetcher.data?.focusImageSaved ? fetcher.data.focusImage : null;
  const image = picked ?? saved ?? initial ?? "";
  const error = localError || fetcher.data?.focusImageError || "";
  const busy = fetcher.state !== "idle";
  const title = kind === "pain" ? "Foot pain card" : kind === "footwear" ? "Footwear card" : "Orthotics card";
  const without = kind === "pain" ? "Without one, the card shows the heel picture built in." : "Without one, the card shows a line drawing.";
  const send = (value) => {
    const fd = new FormData();
    fd.set("intent", "save_focus_image");
    fd.set("kind", kind);
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
      const data = await resizeAppImage(file, 320);
      setPicked(data);
      send(data);
    } catch {
      setLocalError("That image couldn't be read — try another one.");
    }
  };
  const remove = () => { setPicked(""); send(""); };
  return (
    <div className="set-app-pic">
      <div className={`set-app-pic__thumb${image ? "" : " is-empty"}`}>{image ? <img src={image} alt="" /> : kind === "pain" ? <img src="/focus-pain-heel.png" alt="" /> : <span aria-hidden="true">{kind === "footwear" ? "👟" : "🦶"}</span>}</div>
      <div className="set-app-pic__body">
        <Text as="p" variant="bodyMd" fontWeight="semibold">{title}</Text>
        <Text as="p" variant="bodySm" tone="subdued">A square picture looks best — it fills the card's right side. {without}</Text>
        <InlineStack gap="200" blockAlign="center">
          <input ref={inputRef} type="file" accept="image/png,image/webp,image/jpeg" hidden onChange={onFile} />
          <Button onClick={() => inputRef.current?.click()} loading={busy && !!picked}>{image ? "Replace picture" : "Upload picture"}</Button>
          <FilesButton onPick={(f) => { setLocalError(""); setPicked(f.url); send(f.url); }} />
          {image ? <Button variant="plain" tone="critical" onClick={remove} disabled={busy}>Remove</Button> : null}
          {fetcher.data?.focusImageSaved && !busy ? <Text as="span" variant="bodySm" tone="success">Saved</Text> : null}
        </InlineStack>
        {error ? <Text as="p" variant="bodySm" tone="critical">{error}</Text> : null}
      </div>
    </div>
  );
}

function ToolsSection({ d, values, set }) {
  const mapId = storepointId(values.storeLocatorMapId);
  // The chat's order tags carry the app's brand (AVA on the Aetrex app).
  const tag = appBrand(useRouteLoaderData("routes/app")?.appName || DEFAULT_APP_NAME);
  return (
    <BlockStack gap="400">
      <SectionHead title="Shopping tools">Helpers shoppers can open right inside the chat.</SectionHead>
      <Group>
        <Row
          title="Buy now"
          help={values.buyNowEnabled
            ? `Product cards add Buy now next to Add to cart once the shopper's size, width and everything else are known. It goes straight to checkout with the item and your code; anything already in the shopper's cart stays. The order is credited to the chat, tagged ${tag} and ${tag} Buy now.`
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
      <RewardsGroup card={values.rewardsCard} onChange={set("rewardsCard")} />
      <Group>
        <Row title="Promotions page" help="AVA reads your offers page live (every 15 minutes), so it knows what's running." stack>
          <div className="set-grid">
            <TextField label="Page link" value={values.promoPageUrl} onChange={set("promoPageUrl")} placeholder="https://www.aetrex.com/pages/terms-conditions" autoComplete="off" />
            <TextField label="Offers end at this line" value={values.promoPageStop} onChange={set("promoPageStop")} placeholder="STANDARD TERMS AND CONDITIONS OF SALE" autoComplete="off" disabled={!values.promoPageUrl.trim()} helpText="Only text above it counts as offers." />
          </div>
        </Row>
        <Row
          title="Deals"
          help={values.dealsCardOn ? "A “Deals” button on the Focus home: one tap shows the offers running now — read from your promotions page and dated campaigns, in short lines, every one checked against the page's own words — then the products on sale, best discount first. Nothing is made up: with no offers and nothing on sale it says so." : "No Deals button on the Focus home (shoppers can still ask)."}
          toggle
          checked={values.dealsCardOn}
          onChange={set("dealsCardOn")}
        >
          {values.dealsCardOn ? <TextField label="See-all link (optional)" value={values.dealsUrl} onChange={set("dealsUrl")} placeholder="/collections/sale" autoComplete="off" helpText="A sale collection or deals page, shown at the end of the card." /> : null}
        </Row>
        <Row title="Memory" help="AVA remembers what your store showed, from its own records only — never a guess. Offers: every read of your promotions page and every dated campaign; an offer from an old email gets “that ended on Sunday”. Styles: products you archive, set to draft or delete; a style someone asks for by name gets “discontinued”, with the date, and the closest styles sold now. What it remembers is listed on the Knowledge page." stack>
          <div className="set-grid">
            <Select label="Remember ended offers for" options={PROMO_DAYS_CHOICES.map((d) => ({ label: d === 365 ? "1 year" : d >= 60 ? `${Math.round(d / 30)} months` : `${d} days`, value: String(d) }))} value={values.promoMemoryDays} onChange={set("promoMemoryDays")} />
            <Select label="Remember retired styles for" options={STYLE_DAYS_CHOICES.map((d) => ({ label: d === 180 ? "6 months" : `${Math.round(d / 365)} year${d > 365 ? "s" : ""}`, value: String(d) }))} value={values.styleMemoryDays} onChange={set("styleMemoryDays")} />
          </div>
        </Row>
        <Row title="Which orthotic do I have?" help="A visual quiz (Typeform) that tells shoppers which orthotic they own, so they can reorder it." stack>
          <div className="set-grid">
            <TextField label="Typeform quiz" value={values.whichOrthotic} onChange={set("whichOrthotic")} placeholder="ojyWbTvZ or its link" autoComplete="off" helpText="Blank turns it off." />
            <TextField label="Button text" value={values.whichOrthoticLabel} onChange={set("whichOrthoticLabel")} maxLength={40} autoComplete="off" disabled={!values.whichOrthotic.trim()} />
          </div>
        </Row>
        <Row
          title="Store locator"
          help={values.storeLocatorStores === "scanner"
            ? "Your Storepoint map, opened in the chat for foot scans and fittings. A shopper who asks about stores first gets help buying here — the right size, your returns, the styles — and the map only if they still want a store."
            : "Your Storepoint map, opened in the chat when a shopper asks where to buy or try on in person."}
          stack
        >
          <BlockStack gap="300">
            <div className="set-grid set-grid--3">
              <TextField label="Storepoint map" value={values.storeLocatorMapId} onChange={set("storeLocatorMapId")} placeholder="Map ID or embed code" autoComplete="off" helpText={mapId ? `Map ${mapId}` : "Blank turns it off."} />
              <TextField label="Button text" value={values.storeLocatorLabel} onChange={set("storeLocatorLabel")} maxLength={40} autoComplete="off" disabled={!mapId} />
              <TextField label="Locator page" value={values.storeLocatorUrl} onChange={set("storeLocatorUrl")} placeholder="/pages/store-locator" autoComplete="off" disabled={!mapId} helpText="If the map can't load." />
            </div>
            <div style={{ maxWidth: 420 }}>
              <Select
                label="The stores on the map"
                options={[
                  { label: "Sell our products", value: "retail" },
                  { label: "Have our foot scanner (not all sell our shoes)", value: "scanner" },
                ]}
                value={values.storeLocatorStores}
                onChange={set("storeLocatorStores")}
                disabled={!mapId}
              />
            </div>
          </BlockStack>
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
        <Integration title="Yotpo Loyalty & Referrals" help="Signed-in shoppers can ask about their points: AVA looks up their balance and points history to answer — like whether points came back after a return. With VIP mode on, it also knows their balance and referral link from the start." connected={d.hasYotpoLoyaltyKey}>
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
        <Integration title="Klaviyo" help="Back-in-stock alerts in the chat: when a size is sold out, a Notify-me card takes the shopper's email and your Klaviyo back-in-stock flow emails them when it's back. With a list, also a newsletter signup form when a shopper wants deals or updates." connected={Boolean(values.klaviyoCompanyId)}>
          <div className="set-grid">
            <TextField label="Company ID (public key)" value={values.klaviyoCompanyId} onChange={set("klaviyoCompanyId")} placeholder="AbC123" autoComplete="off" helpText="Klaviyo → Settings → API Keys. Turns on back-in-stock alerts — your Klaviyo back-in-stock flow must be live for the emails to go out." />
            <TextField label="List ID" value={values.klaviyoListId} onChange={set("klaviyoListId")} placeholder="XyZ789" autoComplete="off" helpText="Audience → Lists → your list. Adds the newsletter signup form." />
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
      <Group title="Shopify">
        <Row
          title="AVA in Shopify Analytics"
          help={values.appEventsEnabled
            ? "Chats started, products shown, adds to cart (and their value) and checkouts started appear in Shopify Analytics as AVA metrics, beside your sales. They're AVA's own, so no other number changes. No name, email or other personal detail is sent."
            : "Off: nothing about the chat goes to Shopify Analytics."}
          toggle
          checked={values.appEventsEnabled}
          onChange={set("appEventsEnabled")}
        />
      </Group>
      <Group title="Signed-in shoppers">
        <Row title="Login button in the chat" help="“Login” for visitors, “Hi [name]!” for signed-in shoppers." toggle checked={values.showLoginPill} onChange={set("showLoginPill")} />
        <Row title="VIP mode" help="AVA uses a signed-in shopper's order history to personalize sizes and suggestions. No email, address or payment details are ever shown." toggle checked={values.vipModeEnabled} onChange={set("vipModeEnabled")} />
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
        <Row title="Lift the daily message cap" help={values.dailyCapEnabled ? "AVA never goes quiet on your busiest day." : "Only matters when the daily cap below is on."} toggle checked={values.peakLiftDailyCap} onChange={set("peakLiftDailyCap")} />
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
          help={`Off for most stores. When it's reached, AVA says it's back tomorrow (resets at midnight UTC).${values.peakLiftDailyCap ? " Lifted while Peak Mode is on." : ""}`}
          toggle
          checked={values.dailyCapEnabled}
          onChange={set("dailyCapEnabled")}
        >
          <div style={{ maxWidth: 220 }}>
            <TextField label="Messages per day" type="number" min={1} max={100000} value={values.dailyCapMessages} onChange={set("dailyCapMessages")} autoComplete="off" />
          </div>
        </Row>
      </Group>

      <Group title="The home on peak days" badge={d.peakPreviewUrl ? <Button variant="plain" url={d.peakPreviewUrl} external>Preview on your store</Button> : null}>
        <Row stack help="Preview opens your store with the peak home shown to you alone — this browser, today — whatever Peak Mode's switch says; save first. While Peak Mode is on, the chat's home shows these pictures where the banner is — the day's promotions, each just a picture that opens a link or asks AVA when tapped — the peak picture of the assistant, and her colours for the days. Each picture says who sees it: everyone, shoppers signed out, shoppers signed in, or customers carrying a Shopify tag. Nothing here changes what AVA says about offers; she still reads only your promotions page.">
          <PeakHomeEditor value={values.peakHome} onChange={set("peakHome")} />
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

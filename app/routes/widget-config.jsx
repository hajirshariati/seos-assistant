import { feedbackSurveyConfig } from "../lib/feedback-survey.js";
import { seasonalCtaConfig } from "../lib/seasonal-cta.js";
import { appPromoConfig } from "../lib/app-promo.js";
import { parseChatTexts } from "../lib/chat-texts.js";
import { chatRatingConfig } from "../lib/chat-rating.js";
import { appearDelayConfig, startTheme, internationalConfig } from "../lib/appear-delay.js";
import { authenticate } from "../shopify.server";
import { getShopConfigCached } from "../models/ShopConfig.server";
import { getGreetingCtaTranslations } from "../lib/greeting-translation.server";
import prisma from "../db.server";
import { parseOrbColors, parseOrbBackground } from "../lib/orb-colors";
import { recordingState } from "../lib/chat-recording.js";

const FIVE_MIN_MS = 5 * 60 * 1000;
const lastSeenWrite = new Map(); // shop → ms of the last lastWidgetSeenAt write

// Storefront chat widget reads runtime config from this endpoint via the
// Shopify app proxy. authenticate.public.appProxy verifies the proxy HMAC,
// so unsigned or forged requests never reach the DB. We deliberately return
// 401 (not a fallback config object) on auth failure so a misconfigured
// proxy is loud rather than silently serving merchant settings.
export const loader = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Every page view lands here: the config comes from a short cache.
    const config = await getShopConfigCached(session.shop);

    // Touch the lastWidgetSeenAt timestamp so the home page can mark the
    // "Enable the chat widget" setup step as done. Throttled to once every
    // five minutes so a high-traffic storefront doesn't write thousands of
    // updates per day for the same shop. Errors are swallowed because the
    // storefront should never fail to load just because a metric write
    // missed. The cached config can be up to 30s old, so the throttle also
    // keeps its own note of the last write.
    const last = Math.max(
      config.lastWidgetSeenAt ? new Date(config.lastWidgetSeenAt).getTime() : 0,
      lastSeenWrite.get(session.shop) || 0,
    );
    if (Date.now() - last > FIVE_MIN_MS) {
      lastSeenWrite.set(session.shop, Date.now());
      prisma.shopConfig
        .update({
          where: { shop: session.shop },
          data: { lastWidgetSeenAt: new Date() },
        })
        .catch(() => {});
    }

    let hideOnUrls = [];
    try {
      hideOnUrls = JSON.parse(config.hideOnUrls || "[]");
    } catch {
      /* malformed json — fall through with empty array */
    }

    // Welcome-line rotator: translations of the phrase the widget shows
    // (sent as ?cta=, from the theme editor). Cached on ShopConfig; never
    // waits on the model, and a failure never fails widget-config.
    let greetingCtaTranslations = [];
    if (config.rotateGreetingCta !== false) {
      try {
        const phrase = new URL(request.url).searchParams.get("cta") || "";
        greetingCtaTranslations = getGreetingCtaTranslations(config, phrase);
      } catch (err) {
        console.error("[widget-config] greeting translation skipped:", err?.message || err);
      }
    }

    return Response.json(
      {
        hideOnUrls,
        klaviyoCompanyId: config.klaviyoCompanyId || "",
        klaviyoListId: config.klaviyoListId || "",
        showLoginPill: config.showLoginPill !== false,
        // Settings → Support link; the widget falls back to the theme editor's.
        supportUrl: String(config.supportUrl || "").trim(),
        supportLabel: String(config.supportLabel || "").trim(),
        showFeedback: config.showFeedback !== false,
        // Settings → "How's the chat going?" check-in after a few replies.
        chatRating: chatRatingConfig(config),
        // Settings → Feedback survey and live chat.
        feedbackSurvey: feedbackSurveyConfig(config),
        hideLiveChatButton: config.hideLiveChatButton === true,
        // Settings → Seasonal button: the first Start here button.
        seasonalCta: seasonalCtaConfig(config),
        // Settings → Your app: its own message, once per visit.
        appPromo: appPromoConfig(config),
        // Settings → Look & feel → Chat text (only the ones set; the rest
        // stay the theme editor's).
        chatTexts: parseChatTexts(config.chatTexts),
        // Settings → Showing the chat: wait this long before it appears.
        appearDelay: appearDelayConfig(config),
        // The look the chat starts in; a shopper's own pick wins.
        startTheme: startTheme(config.startTheme),
        // Shoppers outside the home countries (Global-e / Shopify Markets) don't see the chat.
        international: internationalConfig(config),
        productCardStyle: config.productCardStyle === "showcase" ? "showcase" : "horizontal",
        // Smart Recommenders → Fit confidence: cards show the Fit and size
        // tiles under the buy button (off: the size tool beside it, as before).
        fitConfidence: config.fitConfidenceEnabled !== false,
        rotateGreetingCta: config.rotateGreetingCta !== false,
        greetingCtaTranslations,
        welcomeGlowStyle: config.welcomeGlowStyle === "none" ? "none" : "subtle",
        // Settings → Assistant look: the mark's five colors (always five valid
        // hex values; the Siri defaults when unset) and the talk button.
        orbColors: parseOrbColors(config.orbColors),
        orbBackground: parseOrbBackground(config.orbBackground),
        voiceInput: config.voiceInput !== false,
        // Test recordings: the widget shows a "recording" note to the people
        // being recorded (testers, or everyone if the store chose that).
        recording: (() => { const st = recordingState(config); return { on: st.on, scope: st.scope }; })(),
      },
      {
        // 60s keeps the storefront responsive without making merchant config
        // toggles wait 5 minutes to propagate.
        headers: { "Cache-Control": "public, max-age=60" },
      },
    );
  } catch (err) {
    console.error("[widget-config] error:", err?.message || err);
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
};

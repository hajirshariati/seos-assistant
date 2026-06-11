import { useState, useEffect } from "react";
import { data } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { Page } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getShopPlan, getConversationsThisMonth, createSubscription, setShopPlan,
  cancelSubscription, getActiveSubscription,
} from "../lib/billing.server";
import { PLANS, PLAN_ORDER, formatLimit } from "../lib/plans";
import BrandHeader from "../components/BrandHeader";

const SUPPORT_EMAIL = "hajiraiapp@gmail.com";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const plan = await getShopPlan(session.shop);
  const used = await getConversationsThisMonth(session.shop);
  return { currentPlanId: plan.id, used, shop: session.shop };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const planId = String(form.get("planId") || "");
  const url = new URL(request.url);
  const host = url.searchParams.get("host") || "";
  if (intent === "select" && PLANS[planId]) {
    if (planId === "free") {
      const active = await getActiveSubscription({ admin });
      if (active?.id) await cancelSubscription({ admin, subscriptionId: active.id });
      await setShopPlan({ shop: session.shop, planId: "free", subscriptionId: null });
      return data({ ok: true, message: "Switched to Free plan." });
    }
    const { confirmationUrl } = await createSubscription({ admin, shop: session.shop, planId, host });
    // Don't redirect server-side — Shopify's billing approval page sends
    // X-Frame-Options: DENY, so loading it inside the embedded admin iframe
    // gives merchants a "refused to connect" error. Return the URL instead
    // and let the client open it at the top level via App Bridge.
    return data({ ok: true, confirmationUrl });
  }
  return data({ ok: false, message: "Unknown action" }, { status: 400 });
};

// Apple-style tier cards: each plan shows only what it ADDS over the tier
// below it, so the columns stay short and the differences pop.
const PLAN_HIGHLIGHTS = {
  free: {
    tagline: "Try it on real customers.",
    inherits: null,
    points: [
      "50 conversations / month",
      "1 knowledge file",
      "7-day analytics",
      "Standard AI model",
    ],
  },
  growth: {
    tagline: "For the typical Shopify store.",
    inherits: "Everything in Free, plus",
    points: [
      "3,000 conversations / month",
      "Unlimited knowledge files",
      "Smart routing + prompt caching",
      "Search rules + product enrichment",
      "Klaviyo + Aftership integrations",
      "Remove SEoS branding",
      "90-day analytics",
    ],
  },
  enterprise: {
    tagline: "High volume, deep data.",
    inherits: "Everything in Growth, plus",
    points: [
      "Unlimited conversations",
      "Advanced AI model",
      "Fit predictor + VIP mode",
      "Yotpo reviews + loyalty",
      "180-day analytics",
    ],
  },
};

const FLOW_STEPS = [
  { title: "Customer asks", text: "The widget sends the message with full conversation context." },
  { title: "AI understands intent", text: "Gender, size, color carry forward — nothing gets re-asked." },
  { title: "Catalog search", text: "Keyword matching, plus search-by-meaning when enabled." },
  { title: "Smart filtering", text: "Wrong-gender or off-category products never show." },
  { title: "Guided recommenders", text: "Step-by-step finders and size prediction for bigger decisions." },
  { title: "Honest answer", text: "Grounded in your catalog and knowledge — nothing invented." },
  { title: "Personal touches", text: "Logged-in shoppers can get history-aware picks (VIP mode)." },
  { title: "Customer sees it", text: "Short reply, product cards, follow-up chips." },
];

const FAQ = [
  { q: "How am I billed?", a: "Through Shopify — charges appear on your Shopify invoice. Change plans any time; changes take effect immediately." },
  { q: "Do unused conversations roll over?", a: "No — the allowance resets at the start of each billing cycle." },
  { q: "What happens if I hit my limit?", a: "The AI pauses for new conversations until the next cycle or an upgrade. The widget still loads but won't reply." },
  { q: "Where do AI costs go?", a: "AI usage is billed by Anthropic directly from your own API key — we add zero markup. Smart routing automatically uses a cheaper model for simple follow-ups." },
  { q: "How much will the AI cost at my traffic?", a: "Use the cost estimator at the bottom of the Analytics page — it projects monthly spend from your sessions, anchored on your store's real per-request average." },
  { q: "Does semantic search cost extra?", a: "Not from us — bring your own Voyage AI or OpenAI key and pay them directly. Typically under $1/month for catalogs under 5,000 products." },
  { q: "What if the AI can't answer?", a: "It offers to connect the customer with your support team via a Contact button (URL set in Settings)." },
  { q: "Can I see what customers are asking?", a: "Yes — Analytics shows every recent conversation, satisfaction votes, costs, and what customers search for." },
];

export default function PlansPage() {
  const { currentPlanId, used, shop } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const [pendingPlan, setPendingPlan] = useState(null);
  const [copied, setCopied] = useState(false);
  const current = PLANS[currentPlanId] || PLANS.free;

  // After the action returns a confirmationUrl, escape the iframe and
  // navigate the top-level browser window to Shopify's billing approval
  // page. window.top.location is the safe top-level redirect — App Bridge
  // intercepts and handles cross-origin properly.
  useEffect(() => {
    const url = actionData?.confirmationUrl;
    if (!url) return;
    if (typeof window !== "undefined" && window.top) {
      window.top.location.href = url;
    }
  }, [actionData?.confirmationUrl]);

  const limit = current.conversationsPerMonth;
  const usagePct = limit === Infinity ? 0 : Math.min(100, Math.round((used / limit) * 100));

  const mailtoHref =
    `mailto:${SUPPORT_EMAIL}` +
    `?subject=${encodeURIComponent("[SEoS Assistant] Support request")}` +
    `&body=${encodeURIComponent(`Shop: ${shop}\n\n`)}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — the address is still on screen */
    }
  };

  return (
    <Page>
      <TitleBar title="Plan & Support" />
      <style>{`
        .seos-pl { display: flex; flex-direction: column; gap: 16px; }
        .seos-pl, .seos-pl * { box-sizing: border-box; }
        .seos-pl-card {
          background: #fff;
          border: 1px solid rgba(0,0,0,0.07);
          border-radius: 16px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.04);
          padding: 20px;
        }
        .seos-pl-title { font-size: 15px; font-weight: 650; color: #1a2e26; letter-spacing: -0.1px; }
        .seos-pl-desc { font-size: 12.5px; line-height: 1.5; color: rgba(26,46,38,0.62); margin-top: 4px; }
        .seos-pl-note {
          background: rgba(45,107,79,0.05);
          border: 1px solid rgba(45,107,79,0.16);
          border-radius: 16px;
          padding: 13px 18px;
          font-size: 13px;
          color: rgba(26,46,38,0.8);
        }
        .seos-pl-note.is-bad { background: rgba(185,90,90,0.05); border-color: rgba(185,90,90,0.2); }

        /* Your plan — readable single row with usage on the right. */
        .seos-pl-current { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
        .seos-pl-current-name { font-size: 21px; font-weight: 700; letter-spacing: -0.4px; color: #1a2e26; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .seos-pl-pricepill {
          font-size: 11.5px;
          font-weight: 650;
          color: #2D6B4F;
          background: rgba(45,107,79,0.08);
          border: 1px solid rgba(45,107,79,0.18);
          border-radius: 999px;
          padding: 2px 10px;
        }
        .seos-pl-current-perks {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 8px;
        }
        .seos-pl-perk {
          font-size: 11px;
          font-weight: 600;
          color: rgba(26,46,38,0.6);
          background: rgba(26,46,38,0.045);
          border-radius: 999px;
          padding: 3px 10px;
        }
        .seos-pl-usage { text-align: right; }
        .seos-pl-usage-num { font-size: 19px; font-weight: 700; color: #1a2e26; font-variant-numeric: tabular-nums; letter-spacing: -0.3px; }
        .seos-pl-usage-sub { font-size: 11.5px; color: rgba(26,46,38,0.5); margin-top: 1px; }
        .seos-pl-meter { margin-top: 14px; height: 6px; border-radius: 999px; background: rgba(26,46,38,0.07); overflow: hidden; }
        .seos-pl-meter span {
          display: block; height: 100%; border-radius: 999px;
          background: linear-gradient(90deg, #2D6B4F, #3a8a66);
          transition: width 0.4s cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        .seos-pl-meter.is-warn span { background: linear-gradient(90deg, #b98a5a, #c9995f); }
        .seos-pl-meter.is-crit span { background: linear-gradient(90deg, #a33d3d, #b85454); }
        .seos-pl-usage-warn { margin-top: 8px; font-size: 12px; color: rgba(26,46,38,0.6); }

        /* Pricing tiers. */
        .seos-pl-tiers {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 16px;
          align-items: stretch;
        }
        .seos-pl-tier {
          position: relative;
          display: flex;
          flex-direction: column;
          background: #fff;
          border: 1px solid rgba(0,0,0,0.07);
          border-radius: 16px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.04);
          padding: 20px 22px;
          transition: transform 0.2s cubic-bezier(0.2, 0.7, 0.2, 1), box-shadow 0.2s ease;
        }
        .seos-pl-tier:hover { transform: translateY(-3px); box-shadow: 0 12px 28px rgba(26,46,38,0.1), 0 2px 6px rgba(26,46,38,0.05); }
        .seos-pl-tier.is-popular { border-color: rgba(45,107,79,0.45); box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 0 0 1px rgba(45,107,79,0.25); }
        .seos-pl-tier-flag {
          align-self: flex-start;
          display: inline-block;
          font-size: 9.5px;
          font-weight: 700;
          letter-spacing: 0.7px;
          text-transform: uppercase;
          padding: 2px 9px;
          border-radius: 999px;
          margin-bottom: 10px;
          white-space: nowrap;
        }
        .seos-pl-tier-flag.is-popular { background: #2D6B4F; color: #fff; }
        .seos-pl-tier-flag.is-current { background: rgba(45,107,79,0.1); color: #2D6B4F; border: 1px solid rgba(45,107,79,0.22); }
        .seos-pl-tier-flag.is-placeholder { visibility: hidden; }
        .seos-pl-tier-name { font-size: 16px; font-weight: 650; color: #1a2e26; }
        .seos-pl-tier-tagline { font-size: 12px; color: rgba(26,46,38,0.55); margin-top: 2px; }
        .seos-pl-tier-price { margin-top: 14px; display: flex; align-items: baseline; gap: 4px; }
        .seos-pl-tier-amount { font-size: 34px; font-weight: 700; letter-spacing: -1.2px; color: #1a2e26; font-variant-numeric: tabular-nums; }
        .seos-pl-tier-unit { font-size: 13px; color: rgba(26,46,38,0.5); }
        .seos-pl-tier-inherits {
          margin-top: 16px;
          font-size: 11px;
          font-weight: 650;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          color: rgba(45,107,79,0.8);
        }
        .seos-pl-tier-points { margin: 10px 0 0; padding: 0; list-style: none; flex: 1; }
        .seos-pl-tier-points li {
          display: flex;
          gap: 9px;
          font-size: 12.5px;
          line-height: 1.45;
          color: rgba(26,46,38,0.78);
          padding: 4px 0;
        }
        .seos-pl-tier-points li::before {
          content: "";
          flex-shrink: 0;
          width: 14px;
          height: 14px;
          margin-top: 2px;
          border-radius: 50%;
          background: rgba(45,107,79,0.1) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M4 7.2l2 2 4-4.5' fill='none' stroke='%232D6B4F' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/contain no-repeat;
        }
        .seos-pl-tier-cta {
          appearance: none;
          font: inherit;
          width: 100%;
          margin-top: 18px;
          padding: 10px 16px;
          border-radius: 999px;
          font-size: 13px;
          font-weight: 650;
          cursor: pointer;
          border: 1px solid rgba(0,0,0,0.1);
          background: #fff;
          color: #1a2e26;
          transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
        }
        .seos-pl-tier-cta:hover:not(:disabled) { border-color: rgba(45,107,79,0.45); box-shadow: 0 1px 4px rgba(26,46,38,0.1); }
        .seos-pl-tier-cta.is-primary {
          background: linear-gradient(180deg, #34795b, #2D6B4F);
          border-color: transparent;
          color: #fff;
          box-shadow: 0 1px 2px rgba(26,46,38,0.28), inset 0 1px 0 rgba(255,255,255,0.12);
        }
        .seos-pl-tier-cta.is-primary:hover:not(:disabled) { background: linear-gradient(180deg, #3a8a66, #2f7053); }
        .seos-pl-tier-cta:disabled { opacity: 0.55; cursor: default; }

        /* Support. */
        .seos-pl-support { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
        .seos-pl-support-email { font-size: 16px; font-weight: 650; color: #1a2e26; margin-top: 2px; }
        .seos-pl-support-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .seos-pl-btn {
          appearance: none;
          font: inherit;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 8px 16px;
          border-radius: 999px;
          font-size: 12.5px;
          font-weight: 650;
          cursor: pointer;
          border: 1px solid rgba(0,0,0,0.1);
          background: #fff;
          color: #1a2e26;
          text-decoration: none !important;
          transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
        }
        .seos-pl-btn:hover { border-color: rgba(45,107,79,0.45); box-shadow: 0 1px 4px rgba(26,46,38,0.1); }
        .seos-pl-btn.is-primary {
          background: linear-gradient(180deg, #34795b, #2D6B4F);
          border-color: transparent;
          color: #fff !important;
        }
        .seos-pl-btn.is-primary:hover { background: linear-gradient(180deg, #3a8a66, #2f7053); }

        /* How it works — quiet numbered grid. */
        .seos-pl-steps {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
          gap: 14px;
          margin-top: 16px;
        }
        .seos-pl-step { display: flex; gap: 12px; align-items: flex-start; }
        .seos-pl-step-num {
          flex-shrink: 0;
          width: 26px;
          height: 26px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          background: rgba(45,107,79,0.1);
          color: #2D6B4F;
          font-size: 12px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        .seos-pl-step-title { font-size: 13px; font-weight: 650; color: #1a2e26; }
        .seos-pl-step-text { font-size: 12px; line-height: 1.5; color: rgba(26,46,38,0.58); margin-top: 2px; }
        .seos-pl-specs {
          display: flex;
          flex-wrap: wrap;
          gap: 12px 36px;
          margin-top: 20px;
          padding-top: 16px;
          border-top: 1px solid rgba(0,0,0,0.06);
        }
        .seos-pl-spec { display: flex; flex-direction: column; gap: 2px; }
        .seos-pl-spec-label {
          font-size: 10px;
          font-weight: 650;
          letter-spacing: 1px;
          text-transform: uppercase;
          color: rgba(26,46,38,0.4);
        }
        .seos-pl-spec-value { font-size: 12px; color: rgba(26,46,38,0.65); }

        /* FAQ accordion. */
        .seos-pl-faq { margin-top: 4px; }
        .seos-pl-faq details { border-bottom: 1px solid rgba(0,0,0,0.06); }
        .seos-pl-faq details:last-child { border-bottom: none; }
        .seos-pl-faq summary {
          list-style: none;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 13px 2px;
          font-size: 13.5px;
          font-weight: 600;
          color: #1a2e26;
          cursor: pointer;
        }
        .seos-pl-faq summary::-webkit-details-marker { display: none; }
        .seos-pl-faq summary::after {
          content: "+";
          flex-shrink: 0;
          width: 22px;
          height: 22px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          background: rgba(45,107,79,0.08);
          color: #2D6B4F;
          font-size: 15px;
          font-weight: 600;
          transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        .seos-pl-faq details[open] summary::after { transform: rotate(45deg); }
        .seos-pl-faq-a { padding: 0 36px 14px 2px; font-size: 12.5px; line-height: 1.55; color: rgba(26,46,38,0.62); }

        .seos-pl-foot { text-align: center; font-size: 11.5px; color: rgba(26,46,38,0.45); padding: 4px 8px; }
        .seos-pl-foot a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }

        @media (prefers-reduced-motion: reduce) {
          .seos-pl * { transition: none !important; }
        }
      `}</style>
      <BrandHeader title="Plan & Support" />
      <div className="seos-pl">

        {actionData?.message ? (
          <div className={`seos-pl-note ${actionData.ok ? "" : "is-bad"}`}>{actionData.message}</div>
        ) : null}

        <div className="seos-pl-card">
          <div className="seos-pl-current">
            <div>
              <div className="seos-pl-title">Your plan</div>
              <div className="seos-pl-current-name">
                {current.name}
                <span className="seos-pl-pricepill">{current.price === 0 ? "Free" : `$${current.price}/mo`}</span>
              </div>
              <div className="seos-pl-current-perks">
                <span className="seos-pl-perk">
                  {limit === Infinity ? "Unlimited conversations" : `${formatLimit(limit)} conversations / mo`}
                </span>
                <span className="seos-pl-perk">
                  {current.knowledgeFiles === Infinity ? "Unlimited knowledge files" : `${current.knowledgeFiles} knowledge file${current.knowledgeFiles === 1 ? "" : "s"}`}
                </span>
                <span className="seos-pl-perk">{current.analyticsRetentionDays}-day analytics</span>
              </div>
            </div>
            <div className="seos-pl-usage">
              <div className="seos-pl-usage-num">
                {limit === Infinity
                  ? used.toLocaleString()
                  : `${used.toLocaleString()} / ${limit.toLocaleString()}`}
              </div>
              <div className="seos-pl-usage-sub">conversations this month</div>
            </div>
          </div>
          {limit !== Infinity && (
            <>
              <div className={`seos-pl-meter ${usagePct >= 90 ? "is-crit" : usagePct >= 75 ? "is-warn" : ""}`}>
                <span style={{ width: `${usagePct}%` }} />
              </div>
              {usagePct >= 75 && (
                <div className="seos-pl-usage-warn">
                  {usagePct}% used — upgrade to keep the assistant answering all month.
                </div>
              )}
            </>
          )}
        </div>

        <div className="seos-pl-card">
          <div className="seos-pl-title">Compare plans</div>
          <div className="seos-pl-desc">Change any time. Billed through Shopify, on your Shopify invoice.</div>
          <div className="seos-pl-tiers" style={{ marginTop: 22 }}>
            {PLAN_ORDER.map((id) => {
              const plan = PLANS[id];
              const hl = PLAN_HIGHLIGHTS[id];
              const isCurrent = id === currentPlanId;
              const isPopular = id === "growth";
              const isDowngrade = PLAN_ORDER.indexOf(id) < PLAN_ORDER.indexOf(currentPlanId);
              return (
                <div key={id} className={`seos-pl-tier ${isPopular ? "is-popular" : ""}`}>
                  <span
                    className={`seos-pl-tier-flag ${
                      isCurrent ? "is-current" : isPopular ? "is-popular" : "is-placeholder"
                    }`}
                  >
                    {isCurrent ? "Current plan" : isPopular ? "Most popular" : "·"}
                  </span>
                  <div className="seos-pl-tier-name">{plan.name}</div>
                  <div className="seos-pl-tier-tagline">{hl.tagline}</div>
                  <div className="seos-pl-tier-price">
                    <span className="seos-pl-tier-amount">{plan.price === 0 ? "Free" : `$${plan.price}`}</span>
                    {plan.price > 0 && <span className="seos-pl-tier-unit">/ month</span>}
                  </div>
                  {hl.inherits && <div className="seos-pl-tier-inherits">{hl.inherits}</div>}
                  <ul className="seos-pl-tier-points">
                    {hl.points.map((p) => <li key={p}>{p}</li>)}
                  </ul>
                  <Form method="post" onSubmit={() => setPendingPlan(id)}>
                    <input type="hidden" name="intent" value="select" />
                    <input type="hidden" name="planId" value={id} />
                    <button
                      type="submit"
                      className={`seos-pl-tier-cta ${!isCurrent && isPopular ? "is-primary" : ""}`}
                      disabled={isCurrent || submitting}
                    >
                      {isCurrent
                        ? "Current plan"
                        : submitting && pendingPlan === id
                          ? "One moment…"
                          : isDowngrade
                            ? plan.price === 0 ? "Switch to Free" : "Downgrade"
                            : "Upgrade"}
                    </button>
                  </Form>
                </div>
              );
            })}
          </div>
        </div>

        <div className="seos-pl-card">
          <div className="seos-pl-title">How SEoS Assistant works</div>
          <div className="seos-pl-desc">Every customer message, in eight quick steps.</div>
          <div className="seos-pl-steps">
            {FLOW_STEPS.map((s, i) => (
              <div className="seos-pl-step" key={s.title}>
                <span className="seos-pl-step-num">{i + 1}</span>
                <div>
                  <div className="seos-pl-step-title">{s.title}</div>
                  <div className="seos-pl-step-text">{s.text}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="seos-pl-specs">
            <div className="seos-pl-spec">
              <span className="seos-pl-spec-label">Catalog sync</span>
              <span className="seos-pl-spec-value">Real-time webhooks + nightly reconciliation</span>
            </div>
            <div className="seos-pl-spec">
              <span className="seos-pl-spec-label">Embeddings</span>
              <span className="seos-pl-spec-value">Automatic when semantic search is on</span>
            </div>
            <div className="seos-pl-spec">
              <span className="seos-pl-spec-label">Cost control</span>
              <span className="seos-pl-spec-value">Prompt caching + smart routing</span>
            </div>
            <div className="seos-pl-spec">
              <span className="seos-pl-spec-label">Privacy</span>
              <span className="seos-pl-spec-value">Feedback hashed · purged after 90 days</span>
            </div>
          </div>
        </div>

        <div className="seos-pl-card">
          <div className="seos-pl-title">FAQ</div>
          <div className="seos-pl-faq">
            {FAQ.map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <div className="seos-pl-faq-a">{item.a}</div>
              </details>
            ))}
          </div>
        </div>

        <div className="seos-pl-card">
          <div className="seos-pl-support">
            <div>
              <div className="seos-pl-title">Need a hand?</div>
              <div className="seos-pl-support-email">{SUPPORT_EMAIL}</div>
              <div className="seos-pl-desc">A real person replies within 1 business day.</div>
            </div>
            <div className="seos-pl-support-actions">
              <button type="button" className="seos-pl-btn" onClick={handleCopy}>
                {copied ? "Copied ✓" : "Copy address"}
              </button>
              <a className="seos-pl-btn is-primary" href={mailtoHref} target="_blank" rel="noopener noreferrer">
                Send email
              </a>
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}

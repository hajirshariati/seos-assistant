import prisma from "../db.server";
import { PLANS, getPlan, DEFAULT_PLAN_ID } from "./plans";

// Production-safe default: real charges. Set SHOPIFY_BILLING_TEST=true on
// dev / staging to opt into Shopify's test-mode subscriptions (no real money
// changes hands, useful for partner test charges and reviewer test installs).
// Until this commit the default was inverted (test mode on unless explicitly
// disabled), which would have meant production merchants were never charged.
const IS_TEST_CHARGE = process.env.SHOPIFY_BILLING_TEST === "true";
const APP_URL = process.env.SHOPIFY_APP_URL || process.env.APP_URL || "";

const COMP_PRO_SHOPS = new Set(
  (process.env.COMP_PRO_SHOPS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

export function isCompedShop(shop) {
  return COMP_PRO_SHOPS.has(String(shop || "").toLowerCase());
}

export async function getShopPlan(shop) {
  // Complimentary Pro: launch partners and stores listed in COMP_PRO_SHOPS
  // always read as Pro, regardless of any plan recorded in the database.
  if (isCompedShop(shop)) return getPlan("pro");
  const config = await prisma.shopConfig.findUnique({ where: { shop } });
  // getPlan() handles legacy ids — old "free" / "enterprise" rows resolve
  // to Growth and Pro respectively, no DB migration needed.
  return getPlan(config?.plan || DEFAULT_PLAN_ID);
}

function monthStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export async function getConversationsThisMonth(shop) {
  const since = monthStart();
  return prisma.chatUsage.count({
    where: { shop, createdAt: { gte: since } },
  });
}

export async function canSendMessage(shop) {
  const plan = await getShopPlan(shop);
  if (plan.conversationsPerMonth === Infinity) {
    return { ok: true, plan, used: null, limit: Infinity };
  }
  const used = await getConversationsThisMonth(shop);
  if (used >= plan.conversationsPerMonth) {
    return {
      ok: false,
      reason: "conversation_limit_reached",
      plan,
      used,
      limit: plan.conversationsPerMonth,
    };
  }
  return { ok: true, plan, used, limit: plan.conversationsPerMonth };
}

export async function createSubscription({ admin, shop, planId, host }) {
  // Defense in depth alongside the route-action guard: a comped shop
  // must never reach appSubscriptionCreate from ANY caller.
  if (isCompedShop(shop)) {
    throw new Error(`Comped shop ${shop} cannot create a subscription`);
  }
  const plan = getPlan(planId);
  if (!plan || plan.price === 0) {
    throw new Error(`Cannot create subscription for plan: ${planId}`);
  }

  const returnUrl = buildReturnUrl({ shop, planId, host });

  const response = await admin.graphql(
    `#graphql
    mutation appSubscriptionCreate(
      $name: String!
      $returnUrl: URL!
      $test: Boolean
      $lineItems: [AppSubscriptionLineItemInput!]!
    ) {
      appSubscriptionCreate(
        name: $name
        returnUrl: $returnUrl
        test: $test
        lineItems: $lineItems
      ) {
        userErrors { field message }
        confirmationUrl
        appSubscription { id status }
      }
    }`,
    {
      variables: {
        name: `SEoS Assistant ${plan.name}`,
        returnUrl,
        test: IS_TEST_CHARGE,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: plan.price, currencyCode: "USD" },
                interval: "EVERY_30_DAYS",
              },
            },
          },
        ],
      },
    },
  );

  const json = await response.json();
  const payload = json?.data?.appSubscriptionCreate;

  if (payload?.userErrors?.length) {
    const msg = payload.userErrors.map((e) => e.message).join("; ");
    throw new Error(`Shopify billing error: ${msg}`);
  }

  if (!payload?.confirmationUrl) {
    throw new Error("Shopify billing: no confirmation URL returned");
  }

  return {
    confirmationUrl: payload.confirmationUrl,
    subscriptionId: payload.appSubscription?.id || null,
  };
}

export async function cancelSubscription({ admin, subscriptionId }) {
  if (!subscriptionId) return null;
  const response = await admin.graphql(
    `#graphql
    mutation appSubscriptionCancel($id: ID!) {
      appSubscriptionCancel(id: $id) {
        userErrors { field message }
        appSubscription { id status }
      }
    }`,
    { variables: { id: subscriptionId } },
  );
  const json = await response.json();
  return json?.data?.appSubscriptionCancel || null;
}

export async function getActiveSubscription({ admin }) {
  const response = await admin.graphql(
    `#graphql
    query {
      currentAppInstallation {
        activeSubscriptions {
          id name status currentPeriodEnd
          lineItems {
            plan {
              pricingDetails {
                __typename
                ... on AppRecurringPricing {
                  price { amount currencyCode }
                  interval
                }
              }
            }
          }
        }
      }
    }`,
  );
  const json = await response.json();
  return json?.data?.currentAppInstallation?.activeSubscriptions?.[0] || null;
}

export async function setShopPlan({ shop, planId, subscriptionId }) {
  await prisma.shopConfig.upsert({
    where: { shop },
    create: {
      shop,
      plan: planId,
      subscriptionId: subscriptionId || null,
      subscriptionActivatedAt: new Date(),
    },
    update: {
      plan: planId,
      subscriptionId: subscriptionId || null,
      subscriptionActivatedAt: new Date(),
    },
  });
}

function buildReturnUrl({ shop, planId, host }) {
  const base = APP_URL.replace(/\/$/, "");
  const params = new URLSearchParams({ shop, plan: planId });
  if (host) params.set("host", host);
  return `${base}/app/billing/callback?${params.toString()}`;
}

export { PLANS };

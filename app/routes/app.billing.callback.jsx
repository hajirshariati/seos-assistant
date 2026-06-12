import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { getActiveSubscription, setShopPlan } from "../lib/billing.server";
import { PLANS, DEFAULT_PLAN_ID } from "../lib/plans";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const planId = url.searchParams.get("plan") || DEFAULT_PLAN_ID;
  const chargeId = url.searchParams.get("charge_id");
  if (!PLANS[planId]) return redirect("/app/plans?error=invalid_plan");
  const active = await getActiveSubscription({ admin });
  if (!active || active.status !== "ACTIVE") {
    return redirect("/app/plans?error=not_active");
  }
  // The plan id arrives via query string — verify it matches the
  // subscription Shopify actually activated (name or price) before
  // recording it, so a tampered ?plan= can't record Pro after a
  // Growth approval.
  const plan = PLANS[planId];
  const activePrice = Number(
    active.lineItems?.[0]?.plan?.pricingDetails?.price?.amount ?? NaN,
  );
  const nameMatches = String(active.name || "").toLowerCase().includes(String(plan.name).toLowerCase());
  const priceMatches = Number.isFinite(activePrice) && Math.round(activePrice) === Math.round(plan.price);
  if (!nameMatches && !priceMatches) {
    console.warn(
      `[billing] callback plan mismatch for ${session.shop}: query plan=${planId} ($${plan.price}) ` +
        `vs active "${active.name}" ($${activePrice}) — not recording`,
    );
    return redirect("/app/plans?error=plan_mismatch");
  }
  await setShopPlan({ shop: session.shop, planId, subscriptionId: active.id || null });
  return redirect(`/app/plans?activated=${planId}${chargeId ? `&charge_id=${chargeId}` : ""}`);
};

export default function BillingCallback() { return null; }

// Programs that live in an app, not in page text.
//
// The store's GovX page is one <div data-govx-id="page"> that GovX's script
// fills in the browser, so a sync reads nothing from it — and "do you have a
// military discount?" found nothing and was answered "no". When a page
// carries that embed (or the store has GovX's price rule), the sync writes
// down what it means, in the words a shopper needs: who it's for, how to get
// it, and the amount when Shopify can say (the GovX price rule's summary).
// Nothing here is guessed: the groups are the ones GovX ID verifies, and
// which of them a store includes is shown during verification.

export const GOVX_EMBED = /\bdata-govx-id\s*=/i;
export const GOVX_RULE = /\bgovx\b/i;

// Shopify's discount summary: "15% off NONE SALE • One use per customer".
export function parseDiscountSummary(summary) {
  const s = String(summary || "");
  const amount = s.match(/^\s*((?:\d+(?:\.\d+)?\s*%|\$\s*\d+(?:\.\d{2})?)\s+off)\b/i)?.[1] || "";
  return {
    amount: amount.replace(/\s+/g, " ").replace(/\s%/, "%").replace(/\$\s/, "$").trim(),
    oncePerCustomer: /one use per customer/i.test(s),
  };
}

// The GovX ID program as a knowledge document: null when the store shows no
// sign of it. `pages`: the store's pages that carry the embed ({ url }).
// `rule`: the parsed price rule ({ amount, oncePerCustomer }) or null.
export function govxProgram({ pages = [], rule = null } = {}) {
  const page = pages.find((p) => p?.url) || null;
  if (!page && !rule?.amount) return null;
  const where = page
    ? `verify with GovX ID on our GovX page (${page.url}) — or at checkout, where an "Unlock Discount" button with the GovX ID logo appears under the order summary`
    : `verify with GovX ID at checkout, where an "Unlock Discount" button with the GovX ID logo appears under the order summary`;
  const amount = rule?.amount
    ? `The GovX ID discount is ${rule.amount}${rule.oncePerCustomer ? ", one use per customer" : ""}.`
    : "The discount amount is shown once you've verified.";
  const text = [
    "We offer a discount through GovX ID for verified members of the groups GovX serves: active-duty military, veterans and retirees, reservists and National Guard, military spouses and dependents, first responders (police, fire, EMS), nurses, doctors and other healthcare workers, teachers, and government employees. Which of these groups qualify here is shown when you verify.",
    `How to get it: ${where}. Verification is free and takes about a minute; once you're verified, the discount is applied to your order.`,
    amount,
    "GovX ID decides eligibility during verification; the discount can't be applied without it.",
  ].join("\n\n");
  return {
    kind: "program",
    handle: "govx",
    title: "GovX ID discount — military, veterans, first responders and other verified groups",
    url: page?.url || "",
    text,
  };
}

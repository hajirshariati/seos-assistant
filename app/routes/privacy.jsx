// Public privacy policy. Served from the app's own domain so the URL is
// stable and indexable — required for the Shopify App Store listing's
// privacy policy field. The route is intentionally outside `/app/*` so it
// doesn't go through admin authentication and can be visited by anyone.

import seosLogo from "../assets/SEoS.png";

const LAST_UPDATED = "October 27, 2026";
const SUPPORT_EMAIL = "help@aetrex.com";

export const meta = () => [
  { title: "Privacy Policy — SEoS Assistant" },
  { name: "robots", content: "index, follow" },
  {
    name: "description",
    content:
      "Privacy policy for SEoS Assistant, an AI shopping assistant for Shopify. Describes what data we collect, how we use it, and how merchants can exercise their data rights.",
  },
  { name: "viewport", content: "width=device-width, initial-scale=1" },
];

export const headers = () => ({
  // 1 hour CDN, 1 day browser — this page rarely changes and is purely public.
  "Cache-Control": "public, max-age=86400, s-maxage=3600",
});

const STYLES = `
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI",
                 Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #1a2e26;
    background: #f6f7f6;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .privacy {
    max-width: 780px;
    margin: 0 auto;
    padding: 48px 24px 96px;
  }
  .privacy .brand {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 22px;
  }
  .privacy .brand img { display: block; height: 26px; width: auto; }
  .privacy .brand span {
    font-size: 11.5px;
    font-weight: 650;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    color: #2D6B4F;
  }
  .privacy .sheet {
    background: #ffffff;
    border: 1px solid rgba(26,46,38,0.10);
    border-radius: 16px;
    padding: 40px 44px 32px;
    box-shadow: 0 1px 2px rgba(26,46,38,0.05);
  }
  @media (max-width: 640px) {
    .privacy .sheet { padding: 24px 20px; }
  }
  .privacy header.head {
    border-bottom: 1px solid rgba(26,46,38,0.10);
    padding-bottom: 22px;
    margin-bottom: 28px;
  }
  .privacy h1 {
    font-size: 30px;
    font-weight: 650;
    margin: 0 0 8px;
    letter-spacing: -0.4px;
    color: #1a2e26;
  }
  .privacy h2 {
    font-size: 19px;
    font-weight: 650;
    margin: 38px 0 12px;
    color: #1a2e26;
    letter-spacing: -0.1px;
  }
  .privacy .meta {
    color: #5e6f67;
    font-size: 14px;
    margin: 0;
  }
  .privacy p, .privacy li {
    font-size: 15.5px;
    color: #36473f;
  }
  .privacy ul {
    padding-left: 20px;
    margin: 12px 0;
  }
  .privacy li { margin: 6px 0; }
  .privacy strong { color: #1a2e26; }
  .privacy a {
    color: #2D6B4F;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .privacy a:hover { color: #1f4d39; }
  .privacy code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 14px;
    background: rgba(45,107,79,0.08);
    color: #2D6B4F;
    padding: 1px 6px;
    border-radius: 4px;
  }
  .privacy footer {
    margin-top: 56px;
    padding-top: 22px;
    border-top: 1px solid rgba(26,46,38,0.10);
    color: #5e6f67;
    font-size: 14px;
  }  /* Mobile responsiveness */
  @media (max-width: 480px) {
    .privacy .sheet { padding: 20px 16px; }
    .privacy h1 { font-size: 24px; }
  }
  /* Mobile responsiveness v2 */
  @media (max-width: 768px) {
    .privacy { overflow-x: hidden; }
    .privacy .sheet { padding: 18px 16px; }
    .privacy a, .privacy code, .privacy td { overflow-wrap: anywhere; word-break: break-word; }
  }

`;

export default function PrivacyPolicy() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <main className="privacy">
        <div className="brand">
          <img src={seosLogo} alt="SEoS" />
          <span>SEoS Assistant</span>
        </div>
        <div className="sheet">
        <header className="head">
          <h1>SEoS Assistant Privacy Policy</h1>
          <p className="meta">Last updated: {LAST_UPDATED}</p>
        </header>

        <p>
          SEoS Assistant (&quot;we&quot;, &quot;our&quot;, &quot;the app&quot;) is operated by Aetrex Technology.
          This policy describes how SEoS Assistant processes data when a merchant
          installs it on a Shopify store, and how responsibility for that data is
          divided between the merchant, Shopify, and us.
        </p>
        <p>
          <strong>Contact:</strong>{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>

        <h2>1. Roles: who is responsible for what</h2>
        <ul>
          <li><strong>The merchant is the data controller</strong> for all shopper and store data processed through the app. The merchant decides whether to install the app, whether and where the chat widget appears, which features and integrations are enabled, and what catalog, policy, and knowledge content the assistant uses. The app processes shopper data solely on the merchant&apos;s behalf and according to the merchant&apos;s configuration.</li>
          <li><strong>Aetrex Technology acts as a data processor</strong> (a &quot;service provider&quot; under California law): we process personal information only to provide the app&apos;s services to the merchant, and not for our own purposes.</li>
          <li><strong>Shopify</strong> provides the platform, authentication, checkout, and billing under its own <a href="https://www.shopify.com/legal/privacy" rel="noreferrer">privacy policy</a> and terms. Orders, payments, and customer accounts live in Shopify, not in this app.</li>
          <li><strong>Shoppers&apos; privacy relationship is with the store they shop at.</strong> Shoppers should direct privacy questions and rights requests to the merchant, whose own privacy policy governs the storefront.</li>
        </ul>

        <h2>2. Merchant responsibilities</h2>
        <p>Because the merchant controls the storefront experience and the app&apos;s configuration, the following remain the merchant&apos;s sole responsibility:</p>
        <ul>
          <li>Maintaining the storefront&apos;s own privacy policy and any legally required notices, including disclosure of the use of an AI chat assistant and automated processing, and any consent or cookie banners required in the merchant&apos;s jurisdictions.</li>
          <li>Establishing the lawful basis for processing shopper data on their storefront, and complying with the privacy, consumer-protection, accessibility, and marketing laws that apply to their store and customers.</li>
          <li>The accuracy and legality of all content the assistant is configured to communicate — product data, prices, claims, policies, knowledge files, and custom rules all come from the merchant&apos;s store and uploads.</li>
          <li>The third-party accounts the merchant connects. AI and integration accounts (Anthropic, OpenAI or Voyage AI, Google Gemini, Klaviyo, Yotpo, Aftership) are the <strong>merchant&apos;s own accounts</strong>: data sent to those providers is processed under the merchant&apos;s own agreements with them, and enabling or disabling each integration is entirely in the merchant&apos;s control.</li>
          <li>Responding to shopper rights requests as controller. The app supports this automatically through Shopify&apos;s privacy webhook system (see §8) and the merchant&apos;s admin controls.</li>
        </ul>

        <h2>3. Data we process</h2>
        <p>When a merchant installs SEoS Assistant, we index and store the following from their Shopify store, on the merchant&apos;s instruction:</p>
        <ul>
          <li>Product catalog data (titles, descriptions, prices, variants, images, tags, metafields, product types), kept current via Shopify webhooks.</li>
          <li>Product attribute mappings configured by the merchant (metafield mappings and tag prefixes).</li>
          <li>A product spec sheet uploaded by the merchant (style codes with their technical specs), stored cleaned up and matched to the catalog.</li>
          <li>Knowledge files uploaded by the merchant (FAQs, sizing guides, brand info, product specs, custom rules), and — when semantic retrieval is enabled — derived text chunks and numeric embedding vectors of that content.</li>
          <li>Merchant-provided third-party API keys — encrypted at rest with AES-256-GCM, removable by the merchant at any time from Settings.</li>
          <li>Standard Shopify session records for the installing store. When a staff member uses the embedded admin, the session record may include that staff member&apos;s Shopify account name and email as provided by Shopify&apos;s authentication. The first name is used solely to personalize the in-admin greeting.</li>
        </ul>
        <p>When a shopper uses the chat widget on the storefront:</p>
        <ul>
          <li>Chat messages are processed transiently to generate AI responses. They are not stored in our database after the reply is delivered, except in the feedback case described below. Operational logs at our hosting provider record that a message was handled (store, length, timing) and the product searches it led to (such as &quot;men&apos;s sandals, arch support&quot;), but not the message text, and rotate automatically. Request logs record the page path only, not query strings.</li>
          <li>We do not build shopper profiles and do not store shopper names, emails, or addresses. The one customer-linked record we keep is described below: when a chat-assisted session leads to an order, the order&apos;s Shopify customer ID is recorded for the merchant&apos;s conversion reporting.</li>
          <li>Anonymous usage metrics (message count, AI model used, token usage, cost, tool calls) are recorded per store for billing and analytics. Test conversations run by the merchant from the app&apos;s admin are flagged internal and are not recorded in analytics or counted against plan usage.</li>
          <li>If the shopper rates a response thumbs-up or thumbs-down, the conversation up to that point is stored alongside the rating so the merchant can review what the AI got right or wrong. Email addresses and phone numbers in it are replaced with placeholders before it is stored. It is keyed only by a one-way, secret-keyed hash of the source IP — not by customer ID, email, or any other identifier — and is automatically deleted after 90 days.</li>
          <li>Test recordings (off by default): while the merchant tests the assistant, it can switch on recording for two weeks at a time. By default only testers are recorded — people who opened the store with the merchant's tester link — not ordinary shoppers; the merchant can choose to record every chat, which is meant for stores that aren't live. Each recorded turn stores the message, the reply, the products shown and the page path, with email addresses and phone numbers replaced by placeholders, keyed by the chat's random session ID (no customer ID or IP). Anyone being recorded sees a &quot;Test recording on&quot; note in the chat. Recordings are deleted after 30 days, or sooner by the merchant.</li>
          <li>When an order is attributed to a chat session, we record the order ID, order name, amount, currency, and the Shopify customer ID so the merchant&apos;s dashboard can report chat-driven revenue. The customer ID is removed automatically when Shopify sends a customer-redaction request, and all conversion records are deleted on store redaction or uninstall.</li>
          <li>Orders and returns: when a shopper asks about their orders, the assistant shows them only after the shopper signs in to the store with Shopify&apos;s own sign-in, and only that shopper&apos;s orders (status, items, carrier and tracking link — never addresses or payment details), fetched live from Shopify and not stored.</li>
          <li>Order status without signing in (the merchant can turn this off): a shopper who isn&apos;t signed in can look up one order by entering its order number (or the confirmation code from the order email) and the email address it was placed with; both must belong to the same order. The lookup goes from the shopper&apos;s browser to our server and on to Shopify — never to the AI provider. It shows only that order&apos;s status, items, carrier and tracking link — never names, addresses, payment details or prices — and starting a return still requires signing in. Every unsuccessful lookup gets the same answer, so it never reveals which detail was wrong, and lookups are limited per device, per order, per email address and per store to prevent guessing; those limits are kept in memory only, as one-way hashes keyed with a secret that is never stored, for up to an hour. Nothing about the lookup is stored in our database, and the shopper&apos;s browser does not keep the order. If the shopper keeps chatting during that visit, the assistant is told the order&apos;s number, status and items — never the email — so it can answer follow-up questions.</li>
          <li>Returns in the chat: if the shopper starts a return in the chat, the order and item identifiers, quantity, return reason, return method and refund choice are sent to the merchant&apos;s AfterShip Returns account to create the return. So the chat can show the same return wherever the shopper comes back to it, and never start it twice, we keep a note of returns started in the chat — the order and item identifiers, reason, return method, return number and label link, never names, emails or addresses — for 120 days. It is deleted when Shopify sends a redaction request for that order, and on store redaction or uninstall. The shopper&apos;s browser also remembers an unfinished return for up to two days so it can be picked up again; signing out clears it.</li>
          <li>If the merchant enables VIP Mode and the shopper is logged in, the assistant fetches the shopper&apos;s first name, order history and loyalty balance (Yotpo) per conversation to personalize replies. This data is used in-memory for the response and is not stored in our database.</li>
          <li>Shoppers should not enter sensitive personal information (such as health, financial, or government-ID details) into the chat. Messages are processed only to generate a reply and are not used for any other purpose.</li>
        </ul>

        <h2>4. How we use data</h2>
        <ul>
          <li>Product catalog data is stored so the AI can search and recommend the merchant&apos;s products in real time.</li>
          <li>Chat messages are forwarded to the AI provider configured for the store to generate responses (see §5).</li>
          <li>When semantic search is enabled, product text and the shopper&apos;s search query are sent to the merchant&apos;s configured embedding provider to compute similarity vectors. Only the text needed for matching is sent; no shopper identity accompanies it.</li>
          <li>Knowledge files, attribute mappings, search rules, and category exclusions are included in the AI system prompt to improve answer quality and constrain results to the merchant&apos;s catalog.</li>
          <li>Usage data powers the merchant&apos;s analytics dashboard, plan limits, and billing.</li>
          <li>Customer email (when the shopper is logged in) is used server-side to look up loyalty data in the merchant&apos;s Yotpo account. When a signed-in shopper asks about their own orders and the merchant has set a branded tracking or returns page, the links on their order cards include their order number and email (so the page can find the order); those links are sent only to the shopper&apos;s browser, not to the AI provider. The email is not stored in our database.</li>
          <li>When a shopper looks up an order without signing in, the order number (or confirmation code) and email they enter are used only to find that order in Shopify and are not stored or logged.</li>
          <li>We do not sell, rent, or share personal information with third parties for their own marketing purposes, and we do not use chat content to train AI models.</li>
        </ul>

        <h2>5. Third-party services</h2>
        <p>
          <strong>Merchant-selected providers (the merchant&apos;s own accounts and agreements).</strong>{" "}
          The following providers are connected by the merchant with the merchant&apos;s own API keys.
          Data sent to them is processed under the merchant&apos;s direct agreement with each provider;
          we transmit it on the merchant&apos;s instruction and do not control those providers&apos; practices.
          Each integration can be disabled by the merchant at any time.
        </p>
        <ul>
          <li><strong>Anthropic (Claude API)</strong> — chat messages are sent for AI processing under the merchant&apos;s API account. Per Anthropic&apos;s API terms, API content is not used to train models. <a href="https://www.anthropic.com/privacy" rel="noreferrer">anthropic.com/privacy</a></li>
          <li><strong>OpenAI or Voyage AI (optional, embeddings)</strong> — product text and shopper search queries for semantic matching. <a href="https://openai.com/policies/privacy-policy" rel="noreferrer">openai.com/privacy</a> · <a href="https://www.voyageai.com/privacy" rel="noreferrer">voyageai.com/privacy</a></li>
          <li><strong>Google Gemini or OpenAI (optional, &quot;See It Styled&quot; images)</strong> — the product&apos;s photos and the shopper&apos;s description of where they&apos;ll wear it are sent to generate a styled preview image. No shopper identity is sent. <a href="https://policies.google.com/privacy" rel="noreferrer">policies.google.com/privacy</a> · <a href="https://openai.com/policies/privacy-policy" rel="noreferrer">openai.com/privacy</a></li>
          <li><strong>Voice input (optional, the shopper&apos;s browser)</strong> — when a shopper taps the microphone, their browser&apos;s built-in speech recognition (for example Google in Chrome, Apple in Safari) turns speech into text. The audio goes to the browser maker under its own terms, never to us; only the resulting text is sent, as a chat message.</li>
          <li><strong>Klaviyo (optional)</strong> — if the merchant enables the in-chat sign-up form, the email the shopper types is sent from their browser directly to the merchant&apos;s Klaviyo list; it does not pass through or stay on our servers. <a href="https://www.klaviyo.com/privacy" rel="noreferrer">klaviyo.com/privacy</a></li>
          <li><strong>Merchant&apos;s fit service (optional)</strong> — if the merchant connects an external size-advice service, it receives the store domain, the product handle and, for a signed-in shopper, their Shopify customer ID.</li>
          <li><strong>Yotpo (optional)</strong> — loyalty points, tier, and rewards lookups. <a href="https://www.yotpo.com/privacy-policy" rel="noreferrer">yotpo.com/privacy-policy</a></li>
          <li><strong>AfterShip (optional)</strong> — tracking links route to the merchant&apos;s branded tracking page; returns started in the chat are created in the merchant&apos;s AfterShip Returns account (order and item identifiers, quantity, reason, refund choice).</li>
        </ul>
        <p><strong>Infrastructure we use to run the app:</strong></p>
        <ul>
          <li><strong>Railway</strong> — application hosting and PostgreSQL database (AWS US region).</li>
          <li><strong>Shopify</strong> — platform, Admin API, App Bridge authentication, and billing.</li>
        </ul>
        <p>
          Where personal data is transferred from the European Economic Area, the United Kingdom, or Switzerland to the United States, transfers rely on Standard Contractual Clauses (SCCs) approved by the European Commission (and their UK and Swiss equivalents) or the receiving provider&apos;s equivalent recognized transfer mechanism.
        </p>

        <h2>6. Legal bases (GDPR)</h2>
        <p>
          For shopper data, the merchant is the controller and determines the lawful basis for processing on their storefront; we process on the merchant&apos;s documented instructions as embodied in the app&apos;s configuration. For the limited data we process for our own purposes (the merchant&apos;s account, billing, and service operation), we rely on:
        </p>
        <ul>
          <li><strong>Performance of a contract</strong> — providing the app&apos;s services to the merchant who installed it.</li>
          <li><strong>Legitimate interests</strong> — operating, securing, and improving the service (e.g. anonymous usage metrics, rate limiting, abuse prevention).</li>
        </ul>

        <h2>7. Data retention</h2>
        <ul>
          <li>Chat usage records (anonymous counts, tokens and cost) are retained for up to 400 days so the merchant can compare year over year, then deleted automatically.</li>
          <li>Product catalog data (including embeddings) is retained while the app is installed and updated in real time via Shopify webhooks.</li>
          <li>Knowledge files (and their derived chunks and embeddings) and the product spec sheet are retained until deleted or replaced by the merchant.</li>
          <li>Feedback data (including any conversation captured under §3) is automatically deleted after 90 days.</li>
          <li>Test recordings (see §3) are automatically deleted after 30 days, and recording itself switches off two weeks after the merchant turns it on.</li>
          <li>Conversation history shown in the widget is stored in the shopper&apos;s browser (<code>localStorage</code>) and is not transmitted to our servers except as part of the per-message context window.</li>
        </ul>

        <h2>8. Data deletion</h2>
        <ul>
          <li>When a merchant uninstalls SEoS Assistant, all associated data is automatically and permanently deleted from our database, including product data, embeddings, knowledge files, the product spec sheet, attribute mappings, search rules, chat usage records, feedback, conversion records, encrypted API keys, configuration, session records, and analytics. No request to us is required.</li>
          <li>We respond automatically to Shopify&apos;s mandatory privacy webhooks — customer data requests, customer redaction, and shop redaction — within the timelines Shopify requires.</li>
          <li>Merchants can delete individual knowledge files, remove the product spec sheet, and clear encrypted API keys at any time from the admin.</li>
        </ul>

        <h2>9. Data security</h2>
        <ul>
          <li>API keys are encrypted at rest using AES-256-GCM with a per-app key stored in our hosting environment.</li>
          <li>All communication between the widget, our server, Shopify, and third-party APIs uses HTTPS/TLS.</li>
          <li>Aside from the order-conversion record described in §3, no shopper-identifying record is stored in our database.</li>
          <li>Per-store and per-IP rate limiting protects merchants from abuse. Order lookups without sign-in need both the order number (or confirmation code) and the matching email, give the same answer whatever detail is wrong, and are limited per device, per order, per email address and per store.</li>
          <li>Webhook payloads from Shopify are HMAC-verified, and admin requests are authenticated with Shopify session tokens, before processing.</li>
          <li>When a signed-in shopper asks about their own orders, their protected data (name, email, address, and order history) is accessed live from Shopify and used only to answer that request. It is not stored in our database, and each access is recorded in an internal access log that captures the event — never the underlying values.</li>
          <li>We maintain a written security incident-response policy, restrict production data access to authorized operators with 2FA, separate test and production data, and review these practices at least annually.</li>
        </ul>
        <p>
          No method of transmission or storage is 100% secure, and we do not warrant absolute security. If we become aware of a breach affecting personal data we process, we will notify Shopify and affected merchants without undue delay so they can meet their own notification obligations as controllers.
        </p>

        <h2>10. Your rights</h2>
        <p>
          Depending on your location, you may have rights to access, correct, delete, restrict, or port personal data, to object to processing, and to lodge a complaint with a supervisory authority. <strong>For shopper data, the merchant is the data controller</strong> — shoppers should direct requests to the store they shopped at, and we will assist the merchant in fulfilling them through Shopify&apos;s privacy webhook system. Merchants can contact{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> about data we process for them.
        </p>
        <p>
          <strong>California (CCPA/CPRA):</strong> we act as a &quot;service provider&quot; — we process personal information only to provide the services described here, we do not sell or share personal information as those terms are defined under California law, and we do not retain, use, or disclose it for any purpose other than providing the services.
        </p>

        <h2>11. Regulatory frameworks</h2>
        <p>
          The app is designed to operate consistently with the processor / service-provider obligations of the EU and UK GDPR, the CCPA/CPRA and other US state privacy laws, and similar frameworks elsewhere: data minimization by default, automatic retention limits, automated honoring of Shopify&apos;s privacy webhooks, encryption of secrets at rest, and no secondary use of personal information. Obligations that attach to the storefront itself — privacy notices, consent, marketing rules, accessibility, sector-specific rules — apply to the merchant as controller and remain the merchant&apos;s responsibility (see §2). This page is provided for transparency and is not legal advice to merchants about their own compliance.
        </p>

        <h2>12. Children&apos;s privacy</h2>
        <p>
          SEoS Assistant is a business tool for Shopify merchants and is not directed at children under 13 (or the equivalent minimum age in your jurisdiction). We do not knowingly collect personal information from children. If you believe a child has provided personal information through the chat, contact us and we will delete it.
        </p>

        <h2>13. AI-generated content disclaimer</h2>
        <ul>
          <li>Chat responses are generated by artificial intelligence. While the assistant is designed to check its product claims against the merchant&apos;s live catalog before replying, AI output may contain errors, omissions, or outdated information, and is not guaranteed to be accurate, complete, or current.</li>
          <li>Authoritative prices, availability, promotions, shipping, and return terms are those shown at the merchant&apos;s checkout and on the merchant&apos;s official policy pages — not the chat.</li>
          <li>Product, sizing, and fit suggestions (including any comfort- or foot-health-related guidance) are general shopping assistance only. They are <strong>not medical advice</strong>, and are not a substitute for consultation with a qualified healthcare professional. Shoppers with medical conditions should consult a clinician before making health-related purchasing decisions.</li>
        </ul>

        <h2>14. Disclaimers and limitation of liability</h2>
        <p>
          The app is provided <strong>&quot;as is&quot; and &quot;as available&quot;</strong>, without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, accuracy, and non-infringement. To the maximum extent permitted by applicable law: (a) Aetrex Technology is not liable for any indirect, incidental, special, consequential, or punitive damages, or for lost profits, revenue, data, or goodwill, arising from or related to the use of the app or its AI-generated content; (b) Aetrex Technology&apos;s total aggregate liability for any claim arising out of or relating to the app shall not exceed the amounts paid by the merchant to Aetrex Technology for the app in the twelve (12) months preceding the claim; and (c) the merchant assumes all responsibility for its use and configuration of the app, for the content the assistant is configured to communicate, and for the legal compliance of its own store, product claims, and policies. Some jurisdictions do not allow certain exclusions, so parts of this section may not apply to you. If any provision of this policy is held unenforceable, the remaining provisions remain in full effect.
        </p>

        <h2>15. Cookies</h2>
        <p>
          SEoS Assistant does not set any cookies. The chat widget stores conversation history in the shopper&apos;s browser <code>localStorage</code>, which is cleared when the shopper clears their browser data or starts a new chat from the menu. The embedded admin relies on Shopify&apos;s own session mechanisms.
        </p>

        <h2>16. Changes to this policy</h2>
        <p>
          We may update this policy from time to time. Material changes will be reflected by updating the &quot;Last updated&quot; date above; continued use of the app after changes take effect constitutes acceptance of the updated policy.
        </p>

        <h2>17. Contact</h2>
        <p>
          For questions about this privacy policy or data handling: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>

        <footer>
          © Aetrex Technology · SEoS Assistant
        </footer>
        </div>
      </main>
    </>
  );
}

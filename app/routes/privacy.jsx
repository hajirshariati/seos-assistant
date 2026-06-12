// Public privacy policy. Served from the app's own domain so the URL is
// stable and indexable — required for the Shopify App Store listing's
// privacy policy field. The route is intentionally outside `/app/*` so it
// doesn't go through admin authentication and can be visited by anyone.

import seosLogo from "../assets/SEoS.png";

const LAST_UPDATED = "June 11, 2026";
const SUPPORT_EMAIL = "hajiraiapp@gmail.com";

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
          SEoS Assistant (&quot;we&quot;, &quot;our&quot;, &quot;the app&quot;) is operated by HajirAi.
          This policy describes how SEoS Assistant collects, uses, and
          handles data when installed on a Shopify store.
        </p>
        <p>
          <strong>Contact:</strong>{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>

        <h2>1. Data we collect</h2>
        <p>When a merchant installs SEoS Assistant, we index and store the following from their Shopify store:</p>
        <ul>
          <li>Product catalog data (titles, descriptions, prices, variants, images, tags, metafields, product types), kept current via Shopify webhooks.</li>
          <li>Product attribute mappings configured by the merchant (metafield mappings and tag prefixes).</li>
          <li>Knowledge files uploaded by the merchant (FAQs, sizing guides, brand info, product specs, custom rules), and — when semantic retrieval is enabled — derived text chunks and numeric embedding vectors of that content.</li>
          <li>Merchant-provided third-party API keys (Anthropic, OpenAI or Voyage AI, Klaviyo, Yotpo, Aftership) — encrypted at rest with AES-256-GCM.</li>
          <li>Standard Shopify session records for the installing store. When a staff member uses the embedded admin, the session record may include that staff member&apos;s Shopify account name and email as provided by Shopify&apos;s authentication. We use the first name solely to personalize the in-admin greeting; we do not use staff details for any other purpose.</li>
        </ul>
        <p>When a shopper uses the chat widget on the storefront:</p>
        <ul>
          <li>Chat messages are sent to our server for the sole purpose of generating AI responses.</li>
          <li>We do not store shopper names, emails, addresses, or chat content keyed to a shopper&apos;s identity. The one customer-linked record we keep is described below: when a chat-assisted session leads to an order, we store that order&apos;s Shopify customer ID for conversion reporting.</li>
          <li>Anonymous usage metrics (message count, AI model used, token usage, cost, tool calls) are recorded per store for billing and analytics. Test conversations run by the merchant from the app&apos;s admin are flagged internal and are not recorded in analytics or counted against plan usage.</li>
          <li>If the shopper rates a response thumbs-up or thumbs-down, the conversation up to that point is stored alongside the rating so the merchant can review what the AI got right or wrong. The stored conversation is keyed only by a hashed source-IP identifier — never by customer ID, email, or any other PII — and is automatically deleted after 90 days.</li>
          <li>When an order is attributed to a chat session, we record the order ID, order name, amount, currency, and the Shopify customer ID so the merchant&apos;s dashboard can report chat-driven revenue. The customer ID is removed automatically when Shopify sends a customer-redaction request, and all conversion records are deleted on store redaction or uninstall.</li>
          <li>If the merchant enables VIP Mode and the shopper is logged in, the assistant fetches the shopper&apos;s first name, order history, loyalty balance (Yotpo), and segment data (Klaviyo) per conversation to personalize replies. This data is used in-memory for the response and is not stored in our database.</li>
          <li>Shoppers should not enter sensitive personal information (such as health, financial, or government-ID details) into the chat. Messages are processed only to generate a reply and are not used for any other purpose.</li>
        </ul>

        <h2>2. How we use data</h2>
        <ul>
          <li>Product catalog data is stored in our database so the AI can search and recommend products in real time.</li>
          <li>Chat messages are forwarded to Anthropic&apos;s Claude API to generate responses. Messages are not retained by us after the response is delivered, except where a shopper submits feedback (see §1).</li>
          <li>When semantic search is enabled, product text and the shopper&apos;s search query are sent to the merchant&apos;s configured embedding provider (OpenAI or Voyage AI) to compute similarity vectors. Only the text needed for matching is sent; no shopper identity accompanies it.</li>
          <li>Knowledge files, attribute mappings, search rules, and category exclusions are included in the AI system prompt to improve answer quality and constrain results to the merchant&apos;s catalog.</li>
          <li>Usage data powers the analytics dashboard, plan limits, and billing.</li>
          <li>Customer email (when the shopper is logged in and VIP Mode is enabled) is used only server-side to look up loyalty and segment data from Klaviyo and Yotpo. It is never stored, logged, or placed in the AI prompt.</li>
          <li>We do not sell, rent, or share personal information with third parties for their own marketing purposes, and we do not use chat content to train AI models.</li>
        </ul>

        <h2>3. Third-party services (subprocessors)</h2>
        <ul>
          <li><strong>Anthropic (Claude API)</strong> — Chat messages are sent to Anthropic for AI processing. Messages sent via the API are not used to train Anthropic&apos;s models. <a href="https://www.anthropic.com/privacy" rel="noreferrer">anthropic.com/privacy</a></li>
          <li><strong>OpenAI or Voyage AI (optional, embeddings)</strong> — If the merchant enables semantic search, product text and shopper search queries are sent to the configured provider to compute embedding vectors. API-submitted content is governed by the provider&apos;s API data policies. <a href="https://openai.com/policies/privacy-policy" rel="noreferrer">openai.com/privacy</a> · <a href="https://www.voyageai.com/privacy" rel="noreferrer">voyageai.com/privacy</a></li>
          <li><strong>Railway</strong> — Our application is hosted on Railway in their AWS US region. Data is stored in a PostgreSQL database within Railway&apos;s infrastructure.</li>
          <li><strong>Shopify</strong> — We use Shopify&apos;s Admin API and App Bridge for authentication, store data access, customer order lookup, and billing.</li>
          <li><strong>Klaviyo (optional)</strong> — If the merchant adds a Klaviyo private API key, the assistant queries Klaviyo for shopper segments to personalize replies. <a href="https://www.klaviyo.com/privacy" rel="noreferrer">klaviyo.com/privacy</a></li>
          <li><strong>Yotpo (optional)</strong> — If the merchant adds a Yotpo loyalty API key, the assistant queries Yotpo for points balance, tier, and rewards to personalize replies. <a href="https://www.yotpo.com/privacy-policy" rel="noreferrer">yotpo.com/privacy-policy</a></li>
          <li><strong>Aftership (optional)</strong> — If the merchant adds an Aftership API key, tracking links shown to shoppers route to their branded Aftership tracking page.</li>
        </ul>
        <p>
          Where personal data is transferred from the European Economic Area, the United Kingdom, or Switzerland to the United States, we rely on Standard Contractual Clauses (SCCs) approved by the European Commission (and their UK and Swiss equivalents) as the legal basis for the transfer.
        </p>

        <h2>4. Legal bases (GDPR)</h2>
        <p>Where the EU/UK General Data Protection Regulation applies, we process data on the following legal bases:</p>
        <ul>
          <li><strong>Performance of a contract</strong> — providing the app&apos;s services to the merchant who installed it.</li>
          <li><strong>Legitimate interests</strong> — operating, securing, and improving the service (e.g. anonymous usage metrics, rate limiting, abuse prevention).</li>
          <li><strong>Consent</strong> — where a merchant enables optional integrations, or a shopper voluntarily submits feedback.</li>
        </ul>

        <h2>5. Data retention</h2>
        <ul>
          <li>Chat usage records are retained for the analytics period defined by the merchant&apos;s plan (7, 90, or 180 days).</li>
          <li>Product catalog data (including embeddings) is retained while the app is installed and updated in real time via Shopify webhooks.</li>
          <li>Knowledge files (and their derived chunks and embeddings) are retained until deleted by the merchant.</li>
          <li>Feedback data (including any conversation captured under §1) is automatically deleted after 90 days.</li>
          <li>Conversation history shown in the widget is stored in the shopper&apos;s browser (<code>localStorage</code>) and is not transmitted to our servers except as part of the per-message context window.</li>
        </ul>

        <h2>6. Data deletion</h2>
        <ul>
          <li>When a merchant uninstalls SEoS Assistant, all associated data is permanently deleted from our database, including product data, embeddings, knowledge files, attribute mappings, search rules, chat usage records, feedback, encrypted API keys, configuration, session records, and analytics.</li>
          <li>We respond to Shopify&apos;s mandatory GDPR webhooks (customer data requests, customer redaction, shop redaction) within 30 days.</li>
          <li>Merchants can delete individual knowledge files at any time from the admin dashboard.</li>
          <li>Merchants can clear the encrypted API keys at any time from the Settings page.</li>
        </ul>

        <h2>7. Data security</h2>
        <ul>
          <li>API keys are encrypted at rest using AES-256-GCM with a per-app key stored in our hosting environment.</li>
          <li>All communication between the widget, our server, Shopify, and third-party APIs uses HTTPS/TLS.</li>
          <li>No shopper PII is stored in our database.</li>
          <li>Per-store and per-IP rate limiting protects merchants from abuse.</li>
          <li>Webhook payloads from Shopify are HMAC-verified, and admin requests are authenticated with Shopify session tokens, before processing.</li>
        </ul>
        <p>
          No method of transmission or storage is 100% secure. If we become aware of a breach affecting personal data, we will notify affected merchants without undue delay and cooperate with their notification obligations.
        </p>

        <h2>8. Your rights</h2>
        <p>
          Depending on your location, you may have rights to access, correct, delete, restrict, or port personal data, to object to processing, and to lodge a complaint with a supervisory authority. For shopper data, the merchant is the data controller and we act as a processor — shoppers should direct requests to the store they purchased from, and we will assist the merchant in fulfilling them. Merchants can exercise their rights by contacting{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
        <p>
          <strong>California (CCPA/CPRA):</strong> we do not sell or share personal information as those terms are defined under California law, and we collect only the categories of information described in §1 for the business purposes described in §2.
        </p>

        <h2>9. Children&apos;s privacy</h2>
        <p>
          SEoS Assistant is a business tool for Shopify merchants and is not directed at children under 13 (or the equivalent minimum age in your jurisdiction). We do not knowingly collect personal information from children. If you believe a child has provided personal information through the chat, contact us and we will delete it.
        </p>

        <h2>10. AI-generated content disclaimer</h2>
        <ul>
          <li>Chat responses are generated by artificial intelligence. While the assistant checks its product claims against the merchant&apos;s live catalog before replying, AI output may still contain errors, omissions, or outdated information.</li>
          <li>Authoritative prices, availability, promotions, shipping, and return terms are those shown at the merchant&apos;s checkout and on the merchant&apos;s official policy pages — not the chat.</li>
          <li>Product, sizing, and fit suggestions (including any comfort- or foot-health-related guidance) are general shopping assistance only. They are <strong>not medical advice</strong>, and are not a substitute for consultation with a qualified healthcare professional. Shoppers with medical conditions should consult a clinician before making health-related purchasing decisions.</li>
        </ul>

        <h2>11. Disclaimers and limitation of liability</h2>
        <p>
          The app is provided <strong>&quot;as is&quot; and &quot;as available&quot;</strong>, without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, accuracy, and non-infringement. To the maximum extent permitted by applicable law: (a) HajirAi is not liable for any indirect, incidental, special, consequential, or punitive damages, or for lost profits, revenue, data, or goodwill, arising from or related to the use of the app or its AI-generated content; (b) HajirAi&apos;s total aggregate liability for any claim arising out of or relating to the app shall not exceed the amounts paid by the merchant to HajirAi for the app in the twelve (12) months preceding the claim; and (c) the merchant is responsible for the legal compliance of its own store, product claims, and policies that the assistant is configured to communicate. Some jurisdictions do not allow certain exclusions, so parts of this section may not apply to you. If any provision of this policy is held unenforceable, the remaining provisions remain in full effect.
        </p>

        <h2>12. Cookies</h2>
        <p>
          SEoS Assistant does not set any cookies. The chat widget stores conversation history in the shopper&apos;s browser <code>localStorage</code>, which is cleared when the shopper clears their browser data or starts a new chat from the menu. The embedded admin relies on Shopify&apos;s own session mechanisms.
        </p>

        <h2>13. Changes to this policy</h2>
        <p>
          We may update this policy from time to time. Material changes will be reflected by updating the &quot;Last updated&quot; date above; continued use of the app after changes take effect constitutes acceptance of the updated policy.
        </p>

        <h2>14. Contact</h2>
        <p>
          For questions about this privacy policy or data handling: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>

        <footer>
          © HajirAi · SEoS Assistant
        </footer>
        </div>
      </main>
    </>
  );
}

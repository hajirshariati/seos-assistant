// Onboarding content shown on /onboarding. Pure data, no React/JSX.
// Generic, merchant-facing — works for any Shopify store installing
// SEoS Assistant. The renderer in app/routes/onboarding.jsx walks
// these arrays and groups by `phase` and (in the maintain phase) by
// `cadence`.

export const PHASES = [
  { id: "install",   name: "Install",   icon: "📥", description: "Open the app, connect the AI engine, sync your catalog." },
  { id: "configure", name: "Configure", icon: "⚙️", description: "Map your product attributes and upload optional knowledge files." },
  { id: "integrate", name: "Integrate", icon: "🔌", description: "Connect optional integrations like Yotpo, Aftership, and Klaviyo." },
  { id: "launch",    name: "Launch",    icon: "🚀", description: "Style the widget, add it to your theme, QA, and monitor." },
  { id: "maintain",  name: "Maintain",  icon: "🔧", description: "Recurring tasks to keep the assistant healthy after launch." },
];

// Maintain-phase steps are grouped by how often you should run them.
// Display order is fixed here; the renderer in app/routes/onboarding.jsx
// uses this list to insert subsection headers between groups. Any
// maintain step missing a `cadence` field (or with an unknown value)
// falls into the "Other" bucket at the bottom.
export const CADENCE_SECTIONS = [
  { id: "weekly",    label: "Weekly",      blurb: "Open every Monday morning." },
  { id: "monthly",   label: "Monthly",     blurb: "Block 30 minutes on the first of each month." },
  { id: "quarterly", label: "Quarterly",   blurb: "Once a quarter — calendar reminder helps." },
  { id: "as-needed", label: "As needed",   blurb: "Triggered by a specific event (new product line, model release, complaint spike)." },
  { id: "reference", label: "Reference",   blurb: "Read-once concept guides — no schedule." },
];

export const STEPS = [
  {
    phase: "install",
    icon: "📂",
    title: "Open the app",
    short: "Apps → SEoS Assistant in your Shopify admin.",
    body: "Open SEoS Assistant from your Shopify admin (Apps → SEoS Assistant). The home page has a setup checklist — each item links to the page that finishes it.",
  },
  {
    phase: "install",
    icon: "🔑",
    title: "Connect the AI engine",
    short: "Paste your Anthropic API key.",
    body: "Settings → AI engine. Paste your Anthropic API key from console.anthropic.com and keep the recommended model. Every reply is fact-checked against your live catalog and store pages before the customer sees it — a reply that names a product, price or policy the assistant didn't look up is rewritten automatically.",
  },
  {
    phase: "install",
    icon: "⏱",
    title: "Let the app learn your products and store pages",
    short: "Products and policies sync on their own in a few minutes.",
    body: "On install the app reads your whole catalog and your store's policies and pages (shipping, returns, FAQs, size guides). Most stores finish in 2–5 minutes; the home checklist turns green when it's done. After that, product changes sync automatically and store pages refresh daily.",
  },
  {
    phase: "configure",
    icon: "🗂",
    title: "Choose what the assistant knows about each product",
    short: "Catalog → pick from your metafields — no typing keys.",
    body: "Catalog → What the assistant knows about each product. The page lists the product fields (metafields) your store actually uses, grouped into In use, Recommended and Other. Tick the ones customers ask about — gender, category, color, activity, foot conditions, arch type, material, technology — and save. The catalog re-syncs on its own.",
  },
  {
    phase: "configure",
    icon: "📚",
    title: "Add your team's notes (optional)",
    short: "Anything that isn't on your website: selling tips, internal answers.",
    body: "Knowledge → Your team's notes. Your website pages are already learned automatically; upload notes only for what isn't on the site, or where the assistant should answer differently. Team notes always win over website text when the two disagree.",
    list: [
      "FAQ or policy clarifications — e.g. exceptions the site doesn't spell out",
      "Brand voice — tone guidelines (warm, expert, never pushy)",
      "Selling notes — which product to suggest for which need",
      "Product attributes CSV — SKU-keyed material / care / fit notes",
    ],
  },
  {
    phase: "configure",
    icon: "🏷",
    title: "Add live promotions (optional)",
    short: "Knowledge → Promotions — the assistant only quotes what's running.",
    body: "Knowledge → Promotions. Add each sale or discount with its start and end dates. The assistant mentions a promotion only while it's live, and never invents codes or discounts.",
  },
  {
    phase: "configure",
    icon: "🧭",
    title: "Set up Smart Recommenders (optional)",
    short: "Guided finders, e.g. the right orthotic for a customer's feet.",
    body: "Smart Recommenders. A recommender is a short set of questions with a product for each combination of answers. The assistant asks the questions naturally in chat and recommends the matching product. The fit predictor is switched on from the same page.",
  },
  {
    phase: "configure",
    icon: "🧠",
    title: "Turn on matching by meaning (optional)",
    short: "Finds the right products even when the customer's words aren't in the description.",
    body: "Settings → Semantic search. Paste an OpenAI or Voyage AI key and save — the catalog and your store pages are indexed automatically (typically under $1, one time). A customer asking for 'shoes for standing all day' then finds arch-support styles even when 'standing' isn't in the description.",
  },
  {
    phase: "integrate",
    icon: "⭐",
    title: "Connect Yotpo — reviews + loyalty (optional)",
    short: "Reviews power fit summaries; Loyalty powers points and rewards in chat.",
    body: "Settings → Optional add-ons → Yotpo. Paste each key from your Yotpo account.",
    list: [
      "Yotpo Reviews API key → review-based fit summaries",
      "Yotpo Loyalty API key + GUID → points balance, tier and personal referral link in chat",
    ],
  },
  {
    phase: "integrate",
    icon: "📦",
    title: "Connect Aftership (optional)",
    short: "Branded tracking links and return-reason data for the fit predictor.",
    body: "Settings → Optional add-ons → Aftership. Return reasons ('ran small') feed sizing advice, and logged-in shoppers get links to your branded tracking page.",
  },
  {
    phase: "integrate",
    icon: "📧",
    title: "Connect Klaviyo signup (optional)",
    short: "Customers can join your list from the chat.",
    body: "Settings → Optional add-ons → Klaviyo. Enter your Company ID and List ID. When a customer asks about deals or launch news, the assistant shows your signup form in the chat.",
  },
  {
    phase: "integrate",
    icon: "👤",
    title: "Enable VIP mode (optional)",
    short: "Personal help for logged-in customers.",
    body: "Settings → VIP customer experience. Logged-in shoppers get a greeting by name, order status and tracking, and size advice anchored on what they bought before. Nothing about them is stored — every lookup is per-conversation.",
    tip: "Test with a real customer account that has at least 2 past orders.",
  },
  {
    phase: "launch",
    icon: "🎨",
    title: "Customize the widget appearance",
    short: "Brand colors, logo, assistant name, welcome banner.",
    body: "Open Theme Editor → SEoS Assistant block. Set your brand colors, upload your avatar (square logo), and write a welcome banner. Set the assistant name and tagline to match the rest of your site.",
  },
  {
    phase: "launch",
    icon: "🧩",
    title: "Add the chat block to your live theme",
    short: "Turn on the SEoS Assistant app embed. Save.",
    body: "In Theme Editor → App embeds, turn on SEoS Assistant and save. The launcher appears on every storefront page. To hide it on specific pages, use Settings → Widget visibility → Hide-on URLs.",
  },
  {
    phase: "launch",
    icon: "💬",
    title: "Test from the admin home",
    short: "The built-in test chat is the real assistant — and never counts toward analytics or your plan.",
    body: "The admin home page has an 'Ask anything…' box. It runs exactly what customers get on the storefront, but test chats don't count toward Analytics, AI cost totals or your monthly quota. Try:",
    list: [
      "An open need — 'I have plantar fasciitis and stand all day' — and check it recommends real products",
      "A comparison — 'what's the difference between X and Y' — and check names and prices match your store",
      "A policy question — 'what's your return window?' — and check it matches your site",
      "Something you don't sell — and check it says so instead of inventing options",
    ],
  },
  {
    phase: "launch",
    icon: "✅",
    title: "QA with a real shopper account",
    short: "Verify VIP greeting, order lookup, sizing and loyalty.",
    body: "Log into your storefront as a test customer with at least 2 past orders. Open the chat and check:",
    list: [
      "The welcome uses the customer's first name",
      "'Where is my order?' returns their real order and a tracking link",
      "'What size should I get in [product]?' gives a fit recommendation",
      "'How many points do I have?' shows their actual balance",
    ],
  },
  {
    phase: "launch",
    icon: "📊",
    title: "Watch Analytics for the first week",
    short: "What customers asked, satisfaction, AI cost.",
    body: "Analytics opens with a summary of what customers asked this week. Check it daily for the first week along with satisfaction (thumbs up / down) and AI cost.",
    tip: "If AI cost spikes, set a Daily message cap in Settings. The assistant pauses when the cap is hit and resumes at midnight UTC.",
  },
  {
    phase: "maintain",
    cadence: "weekly",
    icon: "👍",
    title: "Review thumbs-down weekly",
    short: "Each one is a tuning signal.",
    body: "Open Analytics → negative feedback. Each thumbs-down includes the conversation. Common causes and fixes:",
    list: [
      "Wrong product recommended → check the product's fields on the Catalog page, or add a selling note in Knowledge",
      "Outdated policy → Knowledge → Learned from your website → Refresh now; or add a team note if the site itself is out of date",
      "Missed a promotion → add it in Knowledge → Promotions",
    ],
  },
  {
    phase: "maintain",
    cadence: "monthly",
    icon: "💳",
    title: "Monitor Anthropic credits",
    short: "Pay-as-you-go — chat stops if the balance hits zero.",
    body: "The Anthropic key draws from your credit balance at console.anthropic.com. If it reaches zero, customers see an error message instead of answers. Top up monthly or turn on auto-recharge.",
    tip: "Set a low-balance email alert in the Anthropic console (Settings → Billing).",
  },
  {
    phase: "maintain",
    cadence: "monthly",
    icon: "⚠️",
    title: "Watch for model retirements",
    short: "Anthropic gives months of notice before a model retires.",
    body: "Check the deprecation schedule monthly (https://docs.anthropic.com/en/docs/about-claude/model-deprecations). When the model you use is scheduled to retire, pick its replacement in Settings → AI engine and run the test chats above.",
  },
  {
    phase: "maintain",
    cadence: "as-needed",
    icon: "🆕",
    title: "When you launch a new product line",
    short: "Make sure its fields are filled in Shopify.",
    body: "New products sync automatically. If the line uses new metafields, tick them on the Catalog page so the assistant can use them, then ask the test chat about the new products.",
  },
  {
    phase: "maintain",
    cadence: "reference",
    icon: "🧪",
    title: "Automated checks (engineering)",
    short: "npm run eval offline; eval:chat-transcripts against the live store.",
    body: "Two sets of checks live in the project repo. The offline checks test the chat engine's code with no API key and run in seconds — run them before every code push. The transcript checks send real conversations to a deployed store and verify the replies, cards and links.",
    commands: [
      "npm run eval",
      "CHAT_TRANSCRIPT_BASE_URL=https://<your-app> SHOPIFY_API_SECRET=<secret> npm run eval:chat-transcripts",
    ],
    tip: "When a customer finds a bad answer, add the conversation to scripts/chat-transcripts.aetrex.json so it's checked on every run.",
  },
];

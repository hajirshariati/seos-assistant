// Lean engine — tool definitions. The search tool's filter values are the
// catalog's real vocabulary (catalog.js buildVocabulary), so Claude maps the
// customer's words onto what the store actually carries. Pure.

const values = (rows) => rows.map((r) => r.value);

function arrayEnum(rows, description) {
  const vals = values(rows);
  if (vals.length === 0) return null;
  return { type: "array", items: { type: "string", enum: vals }, description };
}

export function buildLeanTools(vocab = {}, { similar = false } = {}) {
  const props = {
    query: {
      type: "string",
      description: "Keywords for what the customer is after, in catalog terms (style, feature, occasion), e.g. \"arch support walking sneaker\" or \"dressy wedge\". Leave out words that are already covered by a filter.",
    },
  };
  const categories = arrayEnum(vocab.categories || [], "Only products in these categories / types.");
  if (categories) props.categories = categories;
  const colors = arrayEnum(vocab.colors || [], "Only products in these colors. Use ONLY for the color the customer wants the product itself to be — never the color of their outfit.");
  if (colors) props.colors = colors;
  const genders = values(vocab.genders || []);
  if (genders.length) props.gender = { type: "string", enum: genders, description: "Product line. Unisex products are always included." };
  const activities = arrayEnum(vocab.activities || [], "Occasions / activities the product is made for.");
  if (activities) props.activities = activities;
  const conditions = arrayEnum(vocab.conditions || [], "Foot conditions the product is designed to help with.");
  if (conditions) props.conditions = conditions;
  props.on_sale = { type: "boolean", description: "Only marked-down products (sale price below the original price). Use for sales, deals, discounts, markdowns or clearance — on its own to show everything on sale, or with other filters." };
  props.max_price = { type: "number", description: "Maximum price in dollars." };
  props.size = { type: "string", description: "Only products with this size in stock, e.g. \"8\"." };
  props.limit = { type: "integer", description: "How many styles to return (default 6, max 10)." };

  const tools = [
    {
      name: "search_products",
      description:
        "Search the store's in-stock catalog. Filters are applied exactly as given; if nothing matches, the result tells you how many products each filter's removal would return so you can broaden sensibly. Returns one entry per style, with that style's other colors.",
      input_schema: { type: "object", properties: props, required: ["query"] },
    },
    {
      name: "get_product_details",
      description: "Full facts for one product (description, sizes/widths in stock, colorways, tags). Use for questions about a specific product.",
      input_schema: {
        type: "object",
        properties: { handle: { type: "string", description: "Product handle from a search result or a shown card." } },
        required: ["handle"],
      },
    },
    {
      name: "show_products",
      description:
        "Display product cards to the customer. Call it with the products you recommend in your reply (best first, max 4). Only handles returned by a tool in this conversation. Call it at most once per reply; omit it when you're not recommending products.",
      input_schema: {
        type: "object",
        properties: {
          handles: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 },
          options: {
            type: "object",
            description: "Optional: ONLY when the customer has told you their size (and width, etc.), give it per product so the card's Add to cart is ready, e.g. {\"<handle>\": {\"size\": \"8\", \"width\": \"wide\"}}. Never guess a size.",
            additionalProperties: { type: "object", additionalProperties: { type: "string" } },
          },
          follow_ups: {
            type: "array",
            items: { type: "string" },
            maxItems: 3,
            description: "Optional: up to 3 short next questions the customer might tap, written in their voice (e.g. \"Do these come in wide?\", \"Show me the navy one\"). Only things you can actually answer.",
          },
        },
        required: ["handles"],
      },
    },
    {
      name: "compare_products",
      description:
        "Show a side-by-side comparison table (price, rating, what each helps with, comfort features, materials, measurements, stock) built from the store's data. Use when the customer wants to compare products, asks the difference between them, or which of two or three is better. Find the products first; only handles returned by a tool in this conversation. The table is shown under your reply — don't call show_products for the same products.",
      input_schema: {
        type: "object",
        properties: {
          handles: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 3, description: "2 or 3 product handles, in the order the customer named them." },
        },
        required: ["handles"],
      },
    },
    {
      name: "contact_support",
      description:
        "Show the customer a button to reach the store's customer service team. Use when they need a person: order problems you can't solve, returns/exchanges to start, account issues, complaints, or anything you can't answer.",
      input_schema: {
        type: "object",
        properties: { reason: { type: "string", description: "One short line on why, for the support team." } },
        required: ["reason"],
      },
    },
    {
      name: "search_store_info",
      description: "Search everything the store has published — policies (shipping, returns, warranty), its pages (FAQs, sizing guides, technologies, clinical studies, about the company) and its blog articles (foot health, conditions, care, guides) — plus the store team's notes. Use for any policy, how-it-works, research, foot-health or company question. Results include each page's link.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ];
  if (similar) {
    tools.splice(2, 0, {
      name: "find_similar_products",
      description:
        "Styles like one specific product (\"something like the Savannah\", \"similar but cheaper\"): same category and line, matched on the qualities this store chose. The product itself is excluded.",
      input_schema: {
        type: "object",
        properties: {
          handle: { type: "string", description: "Handle of the product they mean (search first if you don't have it)." },
          max_price: { type: "number", description: "Optional price ceiling, e.g. for \"cheaper\"." },
          limit: { type: "integer", description: "How many styles (default 6, max 10)." },
        },
        required: ["handle"],
      },
    });
  }
  return tools;
}

// Lean engine — tool definitions. The search tool's filter values are the
// catalog's real vocabulary (catalog.js buildVocabulary), so Claude maps the
// customer's words onto what the store actually carries. Pure.

const values = (rows) => rows.map((r) => r.value);

function arrayEnum(rows, description) {
  const vals = values(rows);
  if (vals.length === 0) return null;
  return { type: "array", items: { type: "string", enum: vals }, description };
}

// collection: the seasonal button's { handle, title, label } (seasonal-cta.js),
// or null. It reads the same for every shopper, so the tools stay cached.
export function buildLeanTools(vocab = {}, { similar = false, collection = null } = {}) {
  const props = {
    query: {
      type: "string",
      description: "Keywords for what the customer is after, in catalog terms (style, feature, occasion), e.g. \"arch support walking sneaker\" or \"dressy wedge\". A product code or SKU the customer typed (\"L820\", \"L2305W\") goes here as-is — it finds that exact product. Leave out words that are already covered by a filter.",
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
  if (collection?.handle) {
    props.collection = { type: "string", enum: [collection.handle], description: `Only products in the store's "${collection.title}" collection — what the "${collection.label}" button on the chat's welcome screen shows (its footwear).` };
  }
  props.colorful = { type: "boolean", description: "Colorful colorways first (reds, pinks, greens, blues, yellows…) before black, white and neutrals — for the seasonal collection and whenever the customer wants color." };
  props.on_sale = { type: "boolean", description: "Only marked-down products (sale price below the original price). Use for sales, deals, discounts, markdowns or clearance — on its own to show everything on sale, or with other filters." };
  // Spec filters — only those some in-stock product passes. Each keeps only
  // products whose page or spec sheet says so; the rest don't list it.
  const specs = vocab.specs || {};
  if (specs.removable_footbed > 0) props.removable_footbed = { type: "boolean", description: "Only shoes whose footbed (insole) comes out — for customers who wear their own, custom or prescription orthotics. Products that don't list it are left out." };
  if (specs.no_pig_products > 0) props.no_pig_products = { type: "boolean", description: "Only products whose specs list no pig (pork) products in their materials — for customers who avoid them. Products without that spec are left out." };
  if (specs.slip_resistant > 0) props.slip_resistant = { type: "boolean", description: "Only products listed as slip resistant (work, restaurants, hospitals, wet floors)." };
  if (specs.metatarsal_pad > 0) props.metatarsal_pad = { type: "boolean", description: "Only products listed with a metatarsal pad (ball-of-foot support)." };
  props.max_price = { type: "number", description: "Maximum price in dollars." };
  props.size = { type: "string", description: "Only products with this size in stock, e.g. \"8\"." };
  // Only when the store sells shoes in more than one width.
  const widths = values(vocab.widths || []);
  if (widths.length > 1) props.width = { type: "string", enum: widths, description: "Only products with this width in stock — e.g. the wide width for wide feet. With size, that size in that width." };
  props.sort = { type: "string", enum: ["best", "price_low", "price_high"], description: "Result order. \"best\" (default): closest match first, then the styles that sell — most sizes in stock, best rated, best sellers. \"price_low\" / \"price_high\" only when the customer asks for the cheapest or the most premium." };
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
      description: "Full facts for one product (description, sizes/widths in stock, colorways, tags, and its specs when the store lists them: removable footbed and depth, pig products, lining, shank, heel-to-toe drop, boot shaft, temperature rating…). Use for questions about a specific product.",
      input_schema: {
        type: "object",
        properties: { handle: { type: "string", description: "Product handle from a search result or a shown card." } },
        required: ["handle"],
      },
    },
    {
      name: "get_colorways",
      description:
        "Every color a style comes in, each its own product you can show as a card. Use it when the customer asks what colors something comes in, wants other or more colors of products shown, or asks about a color in a size or width (\"does the Carly come in red in wide?\"). Any handle of a style works.",
      input_schema: {
        type: "object",
        properties: {
          handles: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6, description: "Handles of the styles (from a search or a shown card)." },
          size: { type: "string", description: "Optional: only colors with this size in stock." },
          ...(widths.length > 1 ? { width: { type: "string", enum: widths, description: "Optional: only colors with this width in stock." } } : {}),
        },
        required: ["handles"],
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
        "Show the customer a button to reach the store's customer service team — the last step, after your tools. Use when they ask for a person, are upset or frustrated, or need what you can't do or find after checking: account changes, a damaged or wrong item, a refund or order problem the order card can't fix, or a question you still can't answer after searching. Tracking an order and starting a return are done with the order card, the tracking page and the returns center — not this.",
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

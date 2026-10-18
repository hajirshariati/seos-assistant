// True Fit, the store's size finder, offered to Claude as a tool when the
// widget reports it (the theme's "Find my size" tile is on shoe pages).
// Claude decides when a shopper's question is about size; the tool only puts
// a "Find my size with True Fit" button under the reply. The widget opens
// True Fit and sends the recommended size back as the shopper's next message.
import prisma from "../../db.server.js";

const HANDLE = /^[a-z0-9][a-z0-9-]{0,254}$/;
const NOT_FOOTWEAR = /orthotic|insole|accessor|sock|gift|care|cleaner|lace/i;

export function sanitizeSizeFinder(raw) {
  if (!raw || typeof raw !== "object" || raw.provider !== "truefit") return null;
  const page = String(raw.page_handle || "").toLowerCase().slice(0, 255);
  return { provider: "truefit", pageHandle: HANDLE.test(page) ? page : "" };
}

async function findProduct(shop, handle) {
  return prisma.product.findFirst({
    where: { shop, handle, status: "ACTIVE" },
    select: { handle: true, title: true, productType: true },
  });
}

export function trueFitTool({ shop, sizeFinder, lookup = findProduct }) {
  if (!sizeFinder) return null;
  const here = sizeFinder.pageHandle
    ? ` The customer is on the page for "${sizeFinder.pageHandle}" right now — use that handle when they mean the shoe they're looking at.`
    : "";
  return {
    definition: {
      name: "open_true_fit",
      description:
        "Offer True Fit, the store's personal size finder, for one shoe. Use when the customer asks what size to get in a shoe, how it fits, or whether to size up or down — footwear only, not orthotics or accessories. " +
        "It shows a \"Find my size with True Fit\" button under your reply; the customer answers a few quick questions in True Fit and their recommended size comes back to you as their next message. Don't guess a size yourself." +
        here +
        " When the customer then tells you their True Fit size, show that shoe with that size in show_products `options` so it's ready to add to cart, and confirm in one sentence.",
      input_schema: {
        type: "object",
        properties: { handle: { type: "string", description: "The shoe's product handle (from a search, a shown card, or the current page)." } },
        required: ["handle"],
      },
    },
    run: async (input) => {
      const handle = String(input?.handle || "").trim().toLowerCase();
      if (!HANDLE.test(handle)) return { error: "Pass the shoe's product handle." };
      const product = await lookup(shop, handle);
      if (!product) return { error: `No active product "${handle}" — search for the shoe first.` };
      if (NOT_FOOTWEAR.test(product.productType || "")) {
        return { error: `True Fit is for shoes; "${product.title}" is ${product.productType || "not footwear"}.` };
      }
      return {
        ok: true,
        handle: product.handle,
        note: "A \"Find my size with True Fit\" button is shown under your reply. Tell the customer briefly to tap it.",
        _events: [{ type: "size_finder", provider: "truefit", handle: product.handle, title: product.title }],
      };
    },
  };
}

// True Fit, the store's size finder, offered to Claude as a tool when the
// widget reports it (the theme's "Find my size" tile is on shoe pages).
// Claude decides when a shopper's question is about size; the tool only puts
// a "Find my size with True Fit" button under the reply. The widget opens
// True Fit and sends the recommended size back as the shopper's next message.
import prisma from "../../db.server.js";
import { productKind } from "./catalog.js";

const HANDLE = /^[a-z0-9][a-z0-9-]{0,254}$/;

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
        "Offer True Fit, the store's personal size finder, for one shoe. Use when the customer asks what size to get in a shoe, how it fits, or whether to size up or down. Shoes only — never for orthotics or accessories (orthotic choice and FITs belong to the orthotic finder). " +
        "It shows a \"Find my size with True Fit\" button under your reply; the customer answers a few quick questions in True Fit and their recommended size comes back to you as their next message. Don't guess a size yourself." +
        here +
        " When the customer then tells you their True Fit size, show that shoe with that size in show_products `options` so it's ready to add to cart, and confirm in one sentence. Many shoes are sold in two-size steps (\"9 - 9.5 US\"), so True Fit's size is often exactly one of the shoe's sizes — pass it as given. If the shoe is sold in single sizes instead, show it without a size and ask which they'd like with taps (e.g. <<Size 9>><<Size 9.5>>). If show_products says the size is sold out, say so and offer the in-stock sizes.",
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
      const kind = productKind(product);
      if (kind !== "footwear") {
        return {
          error: kind === "orthotic"
            ? `True Fit is for shoes only. For "${product.title}" (an orthotic), help them choose with the orthotic finder / their FIT instead.`
            : `True Fit is for shoes only; "${product.title}" is ${product.productType || "not footwear"}.`,
        };
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

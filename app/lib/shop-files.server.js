// The store's Shopify Files (pictures and videos), one page at a time,
// for Settings' "Choose from files". Rules in shop-files.js.
import { FILES_QUERY, SHOP_FILES_PAGE, SHOP_FILE_KINDS, fileItems, filesQueryString } from "./shop-files.js";

export async function listShopFiles(admin, { kind = "all", words = "", after = "" } = {}) {
  const k = SHOP_FILE_KINDS.includes(kind) ? kind : "all";
  const res = await admin.graphql(FILES_QUERY, { variables: { first: SHOP_FILES_PAGE, after: after || null, query: filesQueryString(k, words) } });
  const body = await res.json();
  if (body?.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  const page = body?.data?.files || {};
  return { files: fileItems(page.nodes || []), hasNext: Boolean(page.pageInfo?.hasNextPage), after: page.pageInfo?.endCursor || "" };
}

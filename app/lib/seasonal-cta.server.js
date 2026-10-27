// The seasonal button's collection, checked against the store (Settings).
import { collectionHandle } from "./seasonal-cta.js";

const QUERY = `query SeasonalCollection($handle: String!) {
  collectionByIdentifier(identifier: { handle: $handle }) { handle title productsCount { count } }
}`;

// admin: the admin client from authenticate.admin. → { handle, title, count },
// null when the store has no such collection; throws when Shopify can't be
// reached (the caller keeps what was saved).
export async function findCollection(admin, value) {
  const handle = collectionHandle(value);
  if (!handle) return null;
  const resp = await admin.graphql(QUERY, { variables: { handle } });
  const json = await resp.json();
  if (json?.errors?.length) throw new Error(json.errors.map((e) => e?.message).join("; "));
  const c = json?.data?.collectionByIdentifier;
  return c ? { handle: c.handle, title: c.title, count: c.productsCount?.count ?? null } : null;
}

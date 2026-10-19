// Live stock for the lean engine: before a card offers one-tap Add to cart in
// the customer's size, the size is checked against the store as it is right
// now (the synced catalog can be minutes behind a sale). Admin API, read-only.
import { ADMIN_API_VERSION } from "../admin-api-version.js";

const QUERY = `query LiveStock($handle: String!) {
  productByIdentifier(identifier: { handle: $handle }) {
    variants(first: 250) { nodes { availableForSale selectedOptions { name value } } }
  }
}`;

// → async (handle) => [{ Size: "7 US", Width: "M" }, …] for variants that can
//   be bought now, or null when the store can't be asked (the catalog's own
//   stock is used then). Answers are kept for the rest of the turn.
export function makeLiveStock({ shop, accessToken, fetchImpl = fetch, timeoutMs = 2500 }) {
  if (!shop || !accessToken) return null;
  const cache = new Map();
  return (handle) => {
    if (!cache.has(handle)) {
      cache.set(handle, (async () => {
        try {
          const res = await fetchImpl(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
            body: JSON.stringify({ query: QUERY, variables: { handle } }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) return null;
          const json = await res.json();
          const nodes = json?.data?.productByIdentifier?.variants?.nodes;
          if (!Array.isArray(nodes)) return null;
          return nodes
            .filter((v) => v.availableForSale)
            .map((v) => Object.fromEntries((v.selectedOptions || []).map((o) => [o.name, o.value])));
        } catch {
          return null;
        }
      })());
    }
    return cache.get(handle);
  };
}

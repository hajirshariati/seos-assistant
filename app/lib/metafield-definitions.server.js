// Reads the store's product + variant metafield definitions for the
// Product attributes picker. Read-only; any failure returns [] and the page
// falls back to the manual form.

const QUERY = `#graphql
  query MetafieldDefinitions($ownerType: MetafieldOwnerType!, $after: String) {
    metafieldDefinitions(first: 250, ownerType: $ownerType, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { name namespace key description type { name } metafieldsCount }
    }
  }`;

async function fetchFor(admin, ownerType, target) {
  const out = [];
  let after = null;
  for (let page = 0; page < 4; page++) {
    const resp = await admin.graphql(QUERY, { variables: { ownerType, after } });
    const json = await resp.json();
    if (json?.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
    const conn = json?.data?.metafieldDefinitions;
    for (const n of conn?.nodes || []) out.push({ ...n, target });
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

export async function fetchMetafieldDefinitions(admin) {
  try {
    const [product, variant] = await Promise.all([
      fetchFor(admin, "PRODUCT", "product"),
      fetchFor(admin, "PRODUCTVARIANT", "variant").catch(() => []),
    ]);
    return { definitions: [...product, ...variant], error: null };
  } catch (err) {
    console.error("[metafield-picker] definitions fetch failed:", err?.message || err);
    return { definitions: [], error: String(err?.message || err) };
  }
}

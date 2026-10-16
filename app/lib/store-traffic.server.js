// The store's real monthly online-store sessions, from Shopify Analytics
// (ShopifyQL; needs the read_reports permission). Cached per shop for a few
// hours — the numbers only change daily.

import { summarizeTraffic } from "./cost-estimator-math.js";

const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map(); // shop → { at, value }

export async function getMonthlySessions(admin, shop) {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value;
  try {
    const resp = await admin.graphql(`#graphql
      query StoreSessions {
        shopifyqlQuery(query: "FROM sessions SHOW sessions TIMESERIES month SINCE -13m UNTIL today") {
          parseErrors
          tableData { rows }
        }
      }`);
    const json = await resp.json();
    const data = json?.data?.shopifyqlQuery;
    if (json?.errors?.length || !data?.tableData) {
      const msg = json?.errors?.[0]?.message || data?.parseErrors?.[0] || "not available";
      value = { error: /access|scope|permission|denied|read_reports/i.test(String(msg)) ? "permission" : String(msg) };
    } else {
      const rows = (data.tableData.rows || []).map((r) => ({ month: String(r.month || "").slice(0, 7), sessions: Number(r.sessions) || 0 }));
      value = summarizeTraffic(rows, new Date());
    }
  } catch (err) {
    const msg = String(err?.message || err);
    value = { error: /access|scope|permission|denied|read_reports/i.test(msg) ? "permission" : msg };
  }
  cache.set(shop, { at: Date.now(), value });
  return value;
}

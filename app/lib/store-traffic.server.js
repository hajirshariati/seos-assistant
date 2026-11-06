// The store's real online-store sessions, from Shopify Analytics
// (ShopifyQL; needs the read_reports permission): by month for the cost
// estimator, by day for the engagement rate. Cached per shop — the numbers
// only change daily, and today's for an hour.

import { summarizeTraffic } from "./cost-estimator-math.js";
import { sessionsByDayFrom } from "./engagement.js";

const TTL_MS = 6 * 60 * 60 * 1000;
const DAY_TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // shop → { at, value }
const dayCache = new Map(); // shop|since|until → { at, value }

const permissionWord = (msg) => (/access|scope|permission|denied|read_reports/i.test(String(msg)) ? "permission" : String(msg));

// Sessions per day between two store-local dates ("YYYY-MM-DD", both
// inclusive): { byDay: { date: sessions } } or { error } — "permission" when
// the store hasn't granted read_reports.
export async function getDailySessions(admin, shop, { since, until }) {
  const key = `${shop}|${since}|${until}`;
  const hit = dayCache.get(key);
  if (hit && Date.now() - hit.at < DAY_TTL_MS) return hit.value;
  let value;
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error("bad range");
    const resp = await admin.graphql(`#graphql
      query StoreSessionsByDay {
        shopifyqlQuery(query: "FROM sessions SHOW sessions TIMESERIES day SINCE ${since} UNTIL ${until}") {
          parseErrors
          tableData { rows }
        }
      }`);
    const json = await resp.json();
    const data = json?.data?.shopifyqlQuery;
    if (json?.errors?.length || !data?.tableData) {
      value = { error: permissionWord(json?.errors?.[0]?.message || data?.parseErrors?.[0] || "not available") };
    } else {
      value = { byDay: sessionsByDayFrom(data.tableData.rows || []) };
    }
  } catch (err) {
    value = { error: permissionWord(err?.message || err) };
  }
  if (dayCache.size > 500) dayCache.clear();
  dayCache.set(key, { at: Date.now(), value });
  return value;
}

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

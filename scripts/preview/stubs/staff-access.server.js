// Stand-in for app/lib/staff-access.server in the admin preview: the shop
// is the preview shop, the admin client answers GraphQL with nothing.
export { parseSupportStaff, staffAccess, SUPPORT_STAFF_MAX } from "../../../app/lib/staff-access.js";
export const SUPPORT_HOME = "/app/recordings";
// ShopifyQL sessions by day (the engagement rate) get a steady made-up 1,200 a day; everything else, nothing.
const admin = { graphql: async (q) => ({ json: async () => {
  const m = String(q).match(/TIMESERIES day SINCE (\d{4}-\d{2}-\d{2}) UNTIL (\d{4}-\d{2}-\d{2})/);
  if (!m) return { data: {} };
  const rows = [];
  for (let t = Date.parse(m[1]); t <= Date.parse(m[2]); t += 86400000) rows.push({ day: new Date(t).toISOString().slice(0, 10), sessions: 1200 });
  return { data: { shopifyqlQuery: { parseErrors: [], tableData: { rows } } } };
} }) };
const session = { shop: process.env.PREVIEW_SHOP || "preview.myshopify.com", onlineAccessInfo: { associated_user: { email: "owner@example.com", account_owner: true } } };
export async function requireFullAccess() { return { session, admin }; }
export async function adminWithAccess() { return { session, admin, access: "full" }; }

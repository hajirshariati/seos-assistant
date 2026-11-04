// Stand-in for app/lib/staff-access.server in the admin preview: the shop
// is the preview shop, the admin client answers GraphQL with nothing.
export { parseSupportStaff, staffAccess, SUPPORT_STAFF_MAX } from "../../../app/lib/staff-access.js";
export const SUPPORT_HOME = "/app/recordings";
const admin = { graphql: async () => ({ json: async () => ({ data: {} }) }) };
const session = { shop: process.env.PREVIEW_SHOP || "preview.myshopify.com", onlineAccessInfo: { associated_user: { email: "owner@example.com", account_owner: true } } };
export async function requireFullAccess() { return { session, admin }; }
export async function adminWithAccess() { return { session, admin, access: "full" }; }

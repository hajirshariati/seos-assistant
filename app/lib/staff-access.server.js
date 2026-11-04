// Who sees what in the admin. The store's owner and its staff see
// everything. Staff listed as the customer service team (Settings →
// Recording → Customer service team) see the Recordings page only — the
// chats, the shoppers' ratings and the lessons — and nothing of Settings,
// keys, knowledge or the catalog. The signed-in staff member comes with
// the admin session (online tokens); the owner is never limited.
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopConfigCached } from "../models/ShopConfig.server";

import { parseSupportStaff, staffAccess, SUPPORT_STAFF_MAX } from "./staff-access.js";
export { parseSupportStaff, staffAccess, SUPPORT_STAFF_MAX };
export const SUPPORT_HOME = "/app/recordings";

// For every page but Recordings: the admin session, or a redirect to
// Recordings for the customer service team.
export async function requireFullAccess(request) {
  const auth = await authenticate.admin(request);
  const config = await getShopConfigCached(auth.session.shop).catch(() => null);
  if (staffAccess(auth.session, config) === "support") throw redirect(SUPPORT_HOME);
  return auth;
}

// The Recordings page and the exports it uses: who this is.
export async function adminWithAccess(request) {
  const auth = await authenticate.admin(request);
  const config = await getShopConfigCached(auth.session.shop).catch(() => null);
  return { ...auth, access: staffAccess(auth.session, config) };
}

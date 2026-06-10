import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { getKey as assertEncryptionKey } from "./utils/encryption.server";
import { startRetentionScheduler } from "./lib/retention.server";

// Fail fast at module load if encryption isn't configured. Without this the
// app would happily accept writes (storing API keys plaintext) until the
// first decrypt call surfaces the error.
assertEncryptionKey();

// Sweeps ChatFeedback/ChatProductMention rows older than 90 days. Boot-time
// scheduler so retention is enforced regardless of admin traffic.
startRetentionScheduler();

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // Online tokens give authenticate.admin a user-scoped session whose
  // onlineAccessInfo carries the logged-in staff member (first name →
  // personalised home-page greeting). The token-exchange strategy STILL
  // acquires and stores the offline token first on every (re)auth, so
  // webhooks and the storefront app proxy keep working unchanged.
  useOnlineTokens: true,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.April26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

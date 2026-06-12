// Single source for the Admin API version used by RAW graphql fetches
// (paths that can't use the managed admin client). Keep in lockstep
// with `apiVersion` in app/shopify.server.js — that module can't be
// imported here because lib modules (and the eval scripts that import
// them) must load without Shopify env configuration.
export const ADMIN_API_VERSION = "2026-04";

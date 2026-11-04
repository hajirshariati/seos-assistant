// The Focus home (Theme editor → AVA → Home layout → Focus): the pictures
// of its three cards — Foot pain, Footwear and Orthotics — uploaded in
// Settings. Stored like the app's picture (a resized PNG, WebP or JPEG data
// URL, or a Shopify Files link); the route turns a data URL into bytes. Without one, Foot pain shows the
// heel picture built in and the line cards a line drawing. Pure.
import { appImageData, appImageError, appImageLink } from "./app-promo.js";

export const FOCUS_IMAGE_PATH = "/apps/hajirai/focus-image";
export const FOCUS_IMAGE_KINDS = ["pain", "footwear", "orthotics"];

export function focusImageKey(kind) {
  return kind === "pain" ? "focusPainImage" : kind === "footwear" ? "focusFootwearImage" : kind === "orthotics" ? "focusOrthoticsImage" : "";
}
export const focusImageData = appImageData;
export function focusImageError(value) {
  return appImageError(value).replace("The app picture", "The picture");
}

// For widget-config: a link per card that has a picture. The link carries
// the picture's fingerprint, so a new picture gets a new link (cached for good).
export function focusImagesConfig(config = {}) {
  const out = {};
  for (const kind of FOCUS_IMAGE_KINDS) {
    const link = appImageLink(config[focusImageKey(kind)], (v) => `${FOCUS_IMAGE_PATH}?kind=${kind}&v=${v}`);
    if (link) out[kind] = link;
  }
  return out;
}

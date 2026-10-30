// The Focus home (Theme editor → AVA → Home layout → Focus): the pictures
// of its two line cards, Footwear and Orthotics, uploaded in Settings.
// Stored like the app's picture (a resized PNG, WebP or JPEG data URL);
// the route turns them into bytes. Pure.
import { appImageData, appImageError, shortHash } from "./app-promo.js";

export const FOCUS_IMAGE_PATH = "/apps/hajirai/focus-image";
export const FOCUS_IMAGE_KINDS = ["footwear", "orthotics"];

export function focusImageKey(kind) {
  return kind === "footwear" ? "focusFootwearImage" : kind === "orthotics" ? "focusOrthoticsImage" : "";
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
    const v = config[focusImageKey(kind)];
    if (appImageData(v)) out[kind] = `${FOCUS_IMAGE_PATH}?kind=${kind}&v=${shortHash(String(v))}`;
  }
  return out;
}

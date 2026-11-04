// The store's Shopify Files, for Settings' "Choose from files" (the
// server side is shop-files.server.js): the search Shopify is asked, and
// what the admin's answer becomes — one item per picture or video that is
// ready, with a link to show and a small preview. Pure.

export const SHOP_FILES_PAGE = 24;
export const SHOP_FILE_KINDS = ["image", "video", "all"];

// Shopify's search: the kind(s) wanted, and the words typed (file names).
export function filesQueryString(kind = "all", words = "") {
  const media = kind === "image" ? "media_type:IMAGE" : kind === "video" ? "media_type:VIDEO" : "(media_type:IMAGE OR media_type:VIDEO)";
  const q = String(words || "").replace(/[^\w .-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return q ? `${media} AND filename:*${q}*` : media;
}

const name = (url) => { try { return decodeURIComponent(new URL(url).pathname.split("/").pop() || "").replace(/_[0-9a-f]{8,}(?=\.)/, ""); } catch { return ""; } };

// The picture a video plays from: an MP4 (what phones and computers all
// play), the sharpest one at most 1280 wide; else the original.
function videoSource(node) {
  const mp4 = (node.sources || []).filter((s) => /mp4/i.test(s.format || s.mimeType || "") && s.url);
  const fit = mp4.filter((s) => !s.width || s.width <= 1280).sort((a, b) => (b.width || 0) - (a.width || 0));
  const pick = fit[0] || mp4.sort((a, b) => (a.width || 0) - (b.width || 0))[0] || (node.originalSource?.url ? node.originalSource : null);
  return pick ? { url: pick.url, width: pick.width || 0, height: pick.height || 0 } : null;
}

// The admin's nodes → items; files still processing, and anything else
// (documents, 3D), are left out.
export function fileItems(nodes = []) {
  const out = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || (n.fileStatus && n.fileStatus !== "READY")) continue;
    if (n.image?.url) {
      out.push({ id: n.id, kind: "image", url: n.image.url, poster: n.preview?.image?.url || n.image.url, width: n.image.width || 0, height: n.image.height || 0, alt: String(n.alt || "").slice(0, 120), name: name(n.image.url) });
    } else if (n.sources || n.originalSource) {
      const src = videoSource(n);
      if (!src) continue;
      out.push({ id: n.id, kind: "video", url: src.url, poster: n.preview?.image?.url || "", width: src.width, height: src.height, alt: String(n.alt || "").slice(0, 120), name: name(src.url), duration: Math.round((n.duration || 0) / 1000) });
    }
  }
  return out;
}

export const FILES_QUERY = `#graphql
  query ShopFiles($first: Int!, $after: String, $query: String) {
    files(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id alt fileStatus
        ... on MediaImage { image { url width height } preview { image { url } } }
        ... on Video { duration preview { image { url } } sources { url mimeType format width height } originalSource { url mimeType format width height } }
      }
    }
  }`;

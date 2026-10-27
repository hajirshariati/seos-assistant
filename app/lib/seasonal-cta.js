// The seasonal button: the first "Start here" button in the chat, featuring
// one of the store's collections (Settings → Seasonal button). The store picks
// a season icon, a tint, the words and the collection; tapping it shows that
// collection's footwear, the most colorful first. Pure — shared by the
// Settings page (its preview), widget-config and the chat.

export const SEASONS = ["fall", "winter", "spring", "summer"];
// "auto" takes the icon's season; "plain" matches the other buttons.
export const SEASON_COLORS = ["auto", "fall", "winter", "spring", "summer", "plain"];
export const SEASON_NAMES = { fall: "Fall", winter: "Winter", spring: "Spring", summer: "Summer" };
export const LABEL_MAX = 40;

export const seasonOf = (v) => (SEASONS.includes(v) ? v : "fall");
export const colorOf = (v) => (SEASON_COLORS.includes(v) ? v : "auto");
// The tint actually drawn: "auto" follows the icon.
export const tintOf = (icon, color) => (colorOf(color) === "auto" ? seasonOf(icon) : colorOf(color));
export const defaultLabel = (icon) => `${SEASON_NAMES[seasonOf(icon)]} Collection`;

// A collection's handle from what's typed or picked: "fall-collection",
// "/collections/fall-collection", or the full store link. "" if it isn't one.
export function collectionHandle(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  const m = v.match(/\/collections\/([^/?#\s]+)/i);
  const h = (m ? decodeURIComponent(m[1]) : v).toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,254}$/.test(h) && h !== "all" ? h : "";
}

export function cleanLabel(value, icon) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) || defaultLabel(icon);
}

// What the widget gets. On only with a collection to show.
export function seasonalCtaConfig(config = {}) {
  const collection = collectionHandle(config.seasonalCtaCollection);
  const icon = seasonOf(config.seasonalCtaIcon);
  return {
    on: config.seasonalCtaOn === true && Boolean(collection),
    icon,
    color: tintOf(icon, config.seasonalCtaColor),
    label: cleanLabel(config.seasonalCtaLabel, icon),
  };
}

// What the chat needs: the collection behind the button, or null when off.
export function seasonalCollection(config = {}) {
  const cta = seasonalCtaConfig(config);
  if (!cta.on) return null;
  const handle = collectionHandle(config.seasonalCtaCollection);
  return { handle, title: String(config.seasonalCtaCollectionTitle || "").trim() || cta.label, label: cta.label };
}

// The collection a chat turn may search in: only the reply to the tap
// itself. Every later message ("any men's styles?") is searched across the
// whole store, as usual.
export function seasonalForTurn(config = {}, { tapped = false } = {}) {
  return tapped === true ? seasonalCollection(config) : null;
}

// The note sent with the tap: show the collection's footwear, colorful
// first, straight away — the button promised exactly that.
export function seasonalTapNote({ handle, title, label }) {
  return `(The shopper tapped the "${label}" button on the chat's welcome screen. Show them footwear from the "${title}" collection right away: search_products with collection "${handle}" and colorful: true — an empty query and no other filters unless they've said more — then show the 4 best picks, in different colors, and say in one or two warm sentences why they're great this season. Don't ask a question first; the View all button lists the whole collection.)`;
}

// The four icons: the same thin line style as the chat's other icons, with
// a touch of color (classes take the colors — light and dark, in the
// widget's CSS and the Settings preview). Kept identical to the widget's
// copy (hajirai-chat-widget.js SEASON_ICONS) — a test checks.
const svg = (name, inner) =>
  `<svg class="ai-sea-ic ai-sea-ic--${name}" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
const PETAL = "M12 10.3C9.7 9.4 8.7 6.8 9.6 4.8 10.2 3.6 11.2 3.6 12 4.6 12.8 3.6 13.8 3.6 14.4 4.8 15.3 6.8 14.3 9.4 12 10.3z";
export const SEASON_ICON_SVG = {
  fall: svg("fall",
    '<path class="sx-f sx-o" stroke-width="1.5" d="M12 2.6l1.6 3.3 2.2-1-.6 4.1 3.1-2.3.9 1.9 2.4-.4-1 3.2 1.3 1-4.4 3.4.6 1.7-4.5-.8-1.6.9-1.6-.9-4.5.8.6-1.7-4.4-3.4 1.3-1-1-3.2 2.4.4.9-1.9 3.1 2.3-.6-4.1 2.2 1z"/>' +
    '<path class="sx-d" stroke-width="1.15" d="M12 16.4V8.3M12 12.8l4-2.6M12 12.8l-4-2.6"/>' +
    '<path class="sx-o" stroke-width="1.5" d="M12 17.6c0 1.5-.2 2.8-.8 3.9"/>'),
  winter: svg("winter",
    '<path class="sx-f" d="M12 9.5l2.2 1.25v2.5L12 14.5l-2.2-1.25v-2.5z"/>' +
    [0, 60, 120].map((a) => `<g transform="rotate(${a} 12 12)"><path class="sx-o" stroke-width="1.5" d="M12 2.7v18.6M9.7 4.8L12 7l2.3-2.2M9.7 19.2L12 17l2.3 2.2"/></g>`).join("")),
  spring: svg("spring",
    [0, 72, 144, 216, 288].map((a) => `<path class="sx-f sx-o" stroke-width="1.35" transform="rotate(${a} 12 12)" d="${PETAL}"/>`).join("") +
    '<circle class="sx-a" cx="12" cy="12" r="2.1"/>'),
  summer: svg("summer",
    '<circle class="sx-a sx-o" stroke-width="1.5" cx="12" cy="12" r="4.1"/>' +
    '<path class="sx-d" stroke-width="1.6" d="M12 2.6v2.4M12 19v2.4M2.6 12H5M19 12h2.4M5.4 5.4l1.7 1.7M16.9 16.9l1.7 1.7M5.4 18.6l1.7-1.7M16.9 7.1l1.7-1.7"/>'),
};

// The colors, light then dark: each icon's own strokes and fills, and each
// tint's background, ring and arrow. The widget's CSS uses the same values.
export const SEASON_ICON_COLORS = {
  light: {
    fall: { o: "#C9531A", f: "#FCC88A", d: "#A8431B" },
    winter: { o: "#2B78C2", f: "#C4E2FA" },
    spring: { o: "#D0437A", f: "#FBD5E3", a: "#F2B035" },
    summer: { o: "#E07A0B", a: "#FFD24D", d: "#F0950F" },
  },
  dark: {
    fall: { o: "#FF9B57", f: "rgba(255, 150, 70, 0.32)", d: "#FFB27A" },
    winter: { o: "#8CC6FF", f: "rgba(120, 185, 255, 0.28)" },
    spring: { o: "#FF8EB6", f: "rgba(255, 130, 175, 0.28)", a: "#FFC94D" },
    summer: { o: "#FFB347", a: "#FFD45C", d: "#FFB347" },
  },
};
export const SEASON_TINTS = {
  light: {
    fall: { bg: "linear-gradient(115deg, #FFF4E9, #FDEADB)", hover: "linear-gradient(115deg, #FFEEDD, #FBE1CC)", ring: "rgba(201, 83, 26, 0.12)", go: "#C9531A" },
    winter: { bg: "linear-gradient(115deg, #F0F7FE, #E5EFFB)", hover: "linear-gradient(115deg, #E6F1FD, #DAE8F9)", ring: "rgba(43, 120, 194, 0.12)", go: "#2B78C2" },
    spring: { bg: "linear-gradient(115deg, #FEF0F5, #EEF8EE)", hover: "linear-gradient(115deg, #FDE6EF, #E4F4E4)", ring: "rgba(208, 67, 122, 0.12)", go: "#D0437A" },
    summer: { bg: "linear-gradient(115deg, #FFF8E1, #FFEDD9)", hover: "linear-gradient(115deg, #FFF2CF, #FFE4C9)", ring: "rgba(224, 122, 11, 0.14)", go: "#E07A0B" },
  },
  dark: {
    fall: { bg: "linear-gradient(115deg, rgba(255, 140, 60, 0.17), rgba(230, 90, 40, 0.09))", hover: "linear-gradient(115deg, rgba(255, 140, 60, 0.24), rgba(230, 90, 40, 0.14))", ring: "rgba(255, 155, 87, 0.18)", go: "#FF9B57" },
    winter: { bg: "linear-gradient(115deg, rgba(110, 175, 255, 0.16), rgba(110, 175, 255, 0.07))", hover: "linear-gradient(115deg, rgba(110, 175, 255, 0.23), rgba(110, 175, 255, 0.12))", ring: "rgba(140, 198, 255, 0.18)", go: "#8CC6FF" },
    spring: { bg: "linear-gradient(115deg, rgba(255, 130, 175, 0.16), rgba(120, 210, 150, 0.08))", hover: "linear-gradient(115deg, rgba(255, 130, 175, 0.23), rgba(120, 210, 150, 0.13))", ring: "rgba(255, 142, 182, 0.18)", go: "#FF8EB6" },
    summer: { bg: "linear-gradient(115deg, rgba(255, 195, 70, 0.17), rgba(255, 140, 60, 0.09))", hover: "linear-gradient(115deg, rgba(255, 195, 70, 0.24), rgba(255, 140, 60, 0.14))", ring: "rgba(255, 179, 71, 0.2)", go: "#FFB347" },
  },
};

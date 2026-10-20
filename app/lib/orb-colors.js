// The assistant mark's five sheet colors (Settings → Assistant look).
// Shared by the Settings page, widget-config and the evals; the widget keeps
// the same defaults and validation in its own script.

export const ORB_DEFAULT_COLORS = ["#ff1f33", "#1a4dff", "#33dbff", "#14d999", "#ff4780"];

// What each color paints, in the order the shader reads them.
export const ORB_COLOR_ROLES = [
  { label: "Warm lobe & spike", hint: "Siri red" },
  { label: "Deep lobe & spike", hint: "Siri blue" },
  { label: "Bright star", hint: "Siri cyan" },
  { label: "Soft lobe", hint: "Siri green" },
  { label: "Accent star", hint: "Siri pink" },
];

const HEX = /^#[0-9a-f]{6}$/i;

export function normalizeHex(value) {
  let v = String(value || "").trim();
  if (/^[0-9a-f]{6}$/i.test(v)) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/i.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return HEX.test(v) ? v.toLowerCase() : null;
}

// Stored as "" (the defaults) or five comma-separated hex colors. Anything
// malformed reads as the defaults, never as a broken orb.
export function parseOrbColors(stored) {
  const parts = String(stored || "").split(",").map(normalizeHex);
  return parts.length === 5 && parts.every(Boolean) ? parts : ORB_DEFAULT_COLORS.slice();
}

export function isDefaultOrbColors(colors) {
  return colors.length === 5 && colors.every((c, i) => normalizeHex(c) === ORB_DEFAULT_COLORS[i]);
}

// From the Settings form: five values in, a stored string out (or null when
// any color is invalid). The defaults store as "".
export function serializeOrbColors(values) {
  const colors = (values || []).map(normalizeHex);
  if (colors.length !== 5 || !colors.every(Boolean)) return null;
  return isDefaultOrbColors(colors) ? "" : colors.join(",");
}

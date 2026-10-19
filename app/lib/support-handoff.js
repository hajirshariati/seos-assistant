// Where the support link and label come from: the app's Settings first
// (Support link card), then the theme editor's block settings, then the
// default. The theme block's own default label doesn't count as a choice.
export function resolveSupport({ adminUrl = "", adminLabel = "", themeUrl = "", themeLabel = "" } = {}) {
  const url = String(adminUrl || "").trim() || String(themeUrl || "").trim();
  const theme = String(themeLabel || "").trim();
  const label = String(adminLabel || "").trim()
    || (theme && theme !== "Contact customer service" ? theme : "")
    || "Chat with Aetrex Support";
  return { url, label };
}

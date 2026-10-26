// The store's feedback survey, shown as a Start here button in the chat.
// Settings take a Typeform form's ID or its link; the widget needs the ID.

export function typeformId(value) {
  const v = String(value || "").trim();
  const m = v.match(/typeform\.com\/to\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  return /^[A-Za-z0-9]{4,32}$/.test(v) ? v : "";
}

// What the widget gets: on only when there's a form to open.
export function feedbackSurveyConfig(config = {}) {
  const form = typeformId(config.feedbackSurvey);
  return {
    on: config.feedbackSurveyOn === true && Boolean(form),
    form,
    label: String(config.feedbackSurveyLabel || "").trim().slice(0, 40) || "Share feedback",
    color: FEEDBACK_COLORS.includes(config.feedbackSurveyColor) ? config.feedbackSurveyColor : "teal",
    icon: FEEDBACK_ICONS.includes(config.feedbackSurveyIcon) ? config.feedbackSurveyIcon : "feedback",
    hideAfter: config.feedbackSurveyHideAfter !== false,
  };
}

// The button's tint and icon (Settings → Feedback survey). The widget draws
// each in light and dark; "plain" matches the other Start here buttons.
export const FEEDBACK_COLORS = ["teal", "green", "blue", "purple", "rose", "amber", "plain"];
export const FEEDBACK_ICONS = ["feedback", "orthotic", "shoe", "search", "sizing", "order", "shipping", "returns", "deals", "gift", "heart", "star", "support", "store", "sparkle"];

// The "which orthotic do I have?" Typeform: the assistant offers it when a
// shopper wants to reorder an orthotic they can't name. Off when empty.
export function whichOrthoticConfig(config = {}) {
  const form = typeformId(config.whichOrthotic);
  if (!form) return null;
  return { form, label: String(config.whichOrthoticLabel || "").trim().slice(0, 40) || "Identify my orthotic" };
}

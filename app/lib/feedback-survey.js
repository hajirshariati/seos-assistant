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
  };
}

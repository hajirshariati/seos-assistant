// Settings page building blocks: a sidebar of sections, compact grouped
// cards of rows (title and a line of help on the left, the control on the
// right), and an iOS-style switch. Keeps the page short: each section shows
// on its own, and a row's extra fields only appear once it's switched on.
import { useId } from "react";
import { Card, Text, Icon, BlockStack, InlineStack } from "@shopify/polaris";

export const SETTINGS_CSS = `
  .set-shell { display: grid; grid-template-columns: 212px minmax(0, 1fr); gap: 28px; align-items: start; }
  .set-nav { position: sticky; top: 16px; display: grid; gap: 2px; }
  .set-nav__item { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 10px; width: 100%;
    padding: 8px 10px; border-radius: 9px; cursor: pointer; color: #303030; font-size: 13.5px; font-weight: 500; line-height: 20px; }
  .set-nav__item:hover { background: rgba(26,46,38,0.05); }
  .set-nav__item:focus-visible { outline: 2px solid #2D6B4F; outline-offset: 1px; }
  .set-nav__item[aria-current="page"] { background: rgba(45,107,79,0.10); color: #1f4d39; font-weight: 650; }
  .set-nav__item[aria-current="page"] .Polaris-Icon svg { fill: #2D6B4F; }
  .set-nav__icon { display: inline-flex; width: 20px; height: 20px; flex: none; }
  .set-nav__label { flex: 1; min-width: 0; }
  .set-nav__dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .set-nav__dot--dirty { background: #b98900; }
  .set-nav__dot--on { background: #2D6B4F; box-shadow: 0 0 0 3px rgba(45,107,79,0.16); }
  .set-nav__pill { font-size: 11px; font-weight: 650; color: #2D6B4F; background: rgba(45,107,79,0.12); border-radius: 999px; padding: 1px 7px; }
  .set-head { margin: 2px 0 14px; }
  .set-head p { color: #5e6f67; font-size: 13.5px; margin: 4px 0 0; }
  .set-group__title { padding: 14px 16px 0; }
  .set-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 20px; align-items: center; padding: 13px 16px; }
  .set-row + .set-row { border-top: 1px solid rgba(30,27,51,0.07); }
  .set-row__text { min-width: 0; }
  .set-row__title { font-size: 13.5px; font-weight: 600; color: #1a1a1a; line-height: 20px; }
  .set-row__help { font-size: 12.5px; color: #616161; line-height: 18px; margin-top: 1px; }
  .set-row__more { grid-column: 1 / -1; padding-top: 8px; }
  .set-row--stack { grid-template-columns: minmax(0, 1fr); }
  .set-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
  .set-grid--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .set-grid--app { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
  .set-app-pic { display: flex; align-items: center; gap: 14px; }
  .set-app-pic__thumb { flex: none; width: 64px; height: 80px; border-radius: 12px; background: linear-gradient(135deg, #eaf4ff, #f1ecff); display: grid; place-items: center; overflow: visible; }
  .set-app-pic__thumb img { max-width: 76px; max-height: 92px; object-fit: contain; filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.18)); }
  .set-app-pic__thumb.is-empty span { font-size: 26px; opacity: 0.6; }
  .set-app-pic__body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .set-switch { all: unset; box-sizing: border-box; position: relative; width: 40px; height: 24px; border-radius: 999px;
    background: #c9cccf; cursor: pointer; transition: background .18s ease; flex: none; }
  .set-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.22); transition: transform .18s ease; }
  .set-switch[aria-checked="true"] { background: #2D6B4F; }
  .set-switch[aria-checked="true"]::after { transform: translateX(16px); }
  .set-switch:focus-visible { outline: 2px solid #2D6B4F; outline-offset: 2px; }
  .set-switch[disabled] { opacity: .45; cursor: default; }
  .set-links a { color: #2D6B4F; text-underline-offset: 2px; }
  .set-links a:hover { color: #245741; }
  .set-peak-mark { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: rgba(26,46,38,0.07); flex: none; }
  .set-peak-mark .Polaris-Icon svg { fill: #2D6B4F; }
  .set-peak-mark--on { background: linear-gradient(135deg, #2D6B4F, #4c9a74); box-shadow: 0 4px 14px rgba(45,107,79,0.28); }
  .set-peak-mark--on .Polaris-Icon svg { fill: #fff; }
  .set-peak-top { display: flex; gap: 14px; align-items: flex-start; padding: 16px; border-bottom: 1px solid rgba(30,27,51,0.07); }
  .set-limits { display: grid; grid-template-columns: minmax(96px, 150px) repeat(2, minmax(0, 170px)); gap: 8px 12px; align-items: center; }
  .set-save { display: flex; justify-content: flex-end; padding: 18px 0 40px; }
  @media (prefers-reduced-motion: reduce) { .set-switch, .set-switch::after { transition: none; } }
  @media (max-width: 760px) {
    .set-shell { grid-template-columns: minmax(0, 1fr); gap: 14px; }
    .set-nav { position: static; display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; }
    .set-nav::-webkit-scrollbar { display: none; }
    .set-nav__item { width: auto; flex: none; padding: 6px 12px; border: 1px solid rgba(30,27,51,0.10); border-radius: 999px; background: #fff; }
    .set-nav__icon { display: none; }
    .set-grid, .set-grid--3, .set-grid--app { grid-template-columns: minmax(0, 1fr); }
    .set-limits { grid-template-columns: minmax(72px, 1fr) repeat(2, minmax(0, 1.1fr)); }
    .set-peak-top { padding: 14px; }
  }
`;

// An on/off switch. `label` names it for screen readers when the row's
// title isn't linked to it.
export function Switch({ checked, onChange, label, labelledBy, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      className="set-switch"
      aria-checked={checked ? "true" : "false"}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

// One setting: title and help on the left, a control on the right. With
// `toggle`, the control is a switch for `checked`, and `children` (more
// fields) show under it only while it's on — unless `always` is set.
export function Row({ title, help, control, toggle = false, checked = false, onChange, children, always = false, stack = false }) {
  const id = useId();
  const showMore = children && (always || !toggle || checked);
  return (
    <div className={`set-row${stack ? " set-row--stack" : ""}`}>
      <div className="set-row__text">
        {title && <div className="set-row__title" id={`${id}-t`}>{title}</div>}
        {help && <div className="set-row__help">{help}</div>}
      </div>
      {toggle ? <Switch checked={checked} onChange={onChange} labelledBy={`${id}-t`} /> : control || null}
      {showMore && <div className="set-row__more">{children}</div>}
    </div>
  );
}

// A card of rows under an optional heading.
export function Group({ title, badge, children }) {
  return (
    <Card padding="0">
      {title && (
        <div className="set-group__title">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h3" variant="headingSm">{title}</Text>
            {badge || null}
          </InlineStack>
        </div>
      )}
      {children}
    </Card>
  );
}

export function SectionHead({ title, children }) {
  return (
    <div className="set-head">
      <Text as="h2" variant="headingLg">{title}</Text>
      {children && <p>{children}</p>}
    </div>
  );
}

export function SettingsNav({ sections, current, onSelect }) {
  return (
    <nav className="set-nav" aria-label="Settings sections">
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          className="set-nav__item"
          aria-current={current === s.id ? "page" : undefined}
          onClick={() => onSelect(s.id)}
        >
          <span className="set-nav__icon"><Icon source={s.icon} tone={current === s.id ? "base" : "subdued"} /></span>
          <span className="set-nav__label">{s.label}</span>
          {s.pill ? <span className="set-nav__pill">{s.pill}</span> : null}
          {s.dirty ? <span className="set-nav__dot set-nav__dot--dirty" role="img" title="Unsaved changes" aria-label="Unsaved changes" /> : null}
        </button>
      ))}
    </nav>
  );
}

// A small labelled number for "right now" readouts.
export function Stat({ label, value, hint }) {
  return (
    <div style={{ padding: "12px 14px", borderRadius: 10, background: "rgba(26,46,38,0.035)", minWidth: 0 }}>
      <BlockStack gap="050">
        <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="span" variant="headingLg">{value}</Text>
        {hint ? <Text as="span" variant="bodySm" tone="subdued">{hint}</Text> : null}
      </BlockStack>
    </div>
  );
}

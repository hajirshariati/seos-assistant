// Settings → Seasonal button: the first Start here button in the chat,
// featuring one collection. The store picks a season icon, a tint, the words
// and the collection, and sees the button as shoppers will — light and dark —
// while it edits.
import { useState } from "react";
import { BlockStack, InlineStack, TextField, Button, Text, Badge } from "@shopify/polaris";
import { Row, Group, SectionHead } from "./SettingsUI";
import {
  SEASONS, SEASON_NAMES, SEASON_ICON_SVG, SEASON_ICON_COLORS, SEASON_TINTS, LABEL_MAX,
  seasonOf, colorOf, tintOf, cleanLabel, defaultLabel, collectionHandle,
} from "../lib/seasonal-cta.js";

// The widget's insole icon, for the neighbouring button in the preview.
const INSOLE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g transform="translate(12.7 2.55)"><path d="M3.6.3C6 0 7.8 1.8 7.9 4.4 8 6.8 7.2 8.6 7.1 10.6 7 12.6 7.6 14.4 7.3 16.2 7 18 5.8 18.9 4.4 18.9 2.9 18.9 1.8 18 1.7 16.4 1.6 14.8 2.6 13.4 2.6 11.8 2.6 10.3 1.2 9.2.6 7.2 0 5 .9.7 3.6.3z"/></g><g transform="translate(11.3 2.55) scale(-1 1)"><path d="M3.6.3C6 0 7.8 1.8 7.9 4.4 8 6.8 7.2 8.6 7.1 10.6 7 12.6 7.6 14.4 7.3 16.2 7 18 5.8 18.9 4.4 18.9 2.9 18.9 1.8 18 1.7 16.4 1.6 14.8 2.6 13.4 2.6 11.8 2.6 10.3 1.2 9.2.6 7.2 0 5 .9.7 3.6.3z"/></g></svg>';
const ARROW = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

const COLOR_CHOICES = [
  { value: "auto", label: "Match icon" },
  ...SEASONS.map((s) => ({ value: s, label: SEASON_NAMES[s] })),
  { value: "plain", label: "Plain" },
];

// The icons' and tints' colors, from the same values the widget uses.
const iconVars = (c) => `--o:${c.o};--f:${c.f || "none"};--d:${c.d || c.o};--a:${c.a || "none"}`;
export const SEASONAL_CSS = [
  `.sea-ed{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,300px);gap:20px;align-items:start}`,
  `.sea-ed__label{font-size:12.5px;font-weight:600;color:#303030;margin:0 0 8px}`,
  `.sea-icons{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}`,
  `.sea-icon{all:unset;box-sizing:border-box;display:grid;justify-items:center;gap:6px;padding:12px 6px 10px;border-radius:12px;cursor:pointer;background:#f6f6f7;box-shadow:inset 0 0 0 1px rgba(30,27,51,.06);transition:box-shadow .15s ease,background .15s ease;font-size:12.5px;font-weight:550;color:#303030}`,
  `.sea-icon:hover{background:#f1f1f3}`,
  `.sea-icon[aria-checked="true"]{background:#fff;box-shadow:inset 0 0 0 2px #2D6B4F,0 1px 3px rgba(0,0,0,.08)}`,
  `.sea-icon:focus-visible,.sea-sw:focus-visible{outline:2px solid #2D6B4F;outline-offset:2px}`,
  `.sea-icon svg{width:30px;height:30px}`,
  `.sea-sws{display:flex;flex-wrap:wrap;gap:12px 14px}`,
  `.sea-sw{all:unset;box-sizing:border-box;display:grid;justify-items:center;gap:5px;cursor:pointer;font-size:11.5px;color:#616161;min-width:52px}`,
  `.sea-sw__dot{width:30px;height:30px;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08);transition:box-shadow .15s ease}`,
  `.sea-sw[aria-checked="true"] .sea-sw__dot{box-shadow:0 0 0 2px #fff,0 0 0 4px #2D6B4F}`,
  `.sea-sw[aria-checked="true"]{color:#1a1a1a;font-weight:600}`,
  `.sea-pv{display:grid;gap:10px;position:sticky;top:16px}`,
  `.sea-pv__frame{border-radius:16px;padding:14px 12px 14px}`,
  `.sea-pv--light{background:#fff;box-shadow:0 0 0 1px rgba(30,27,51,.08),0 6px 20px rgba(0,0,0,.05);--sv:#f5f5f7;--tx:#1d1d1f;--mu:#86868b}`,
  `.sea-pv--dark{background:#0d0d12;--sv:#1c1c22;--tx:#f5f5f7;--mu:#8e8e93}`,
  `.sea-pv__cap{font-size:10.5px;letter-spacing:.08em;font-weight:600;color:var(--mu);margin:0 0 8px 2px;text-transform:uppercase}`,
  `.sea-pv__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}`,
  `.sea-pv__btn{display:flex;align-items:center;gap:8px;min-height:40px;padding:7px 8px 7px 10px;border-radius:11px;background:var(--sv);color:var(--tx);font-size:12px;font-weight:550;line-height:1.2;transition:background .15s ease}`,
  `.sea-pv__btn .ic{display:flex;flex:none;color:var(--mu)}.sea-pv__btn .ic svg{width:17px;height:17px}`,
  `.sea-pv__btn .t{flex:1;min-width:0;overflow-wrap:anywhere}.sea-pv__btn .go{display:flex;flex:none;color:#a1a1a6}`,
  `.sea-pv__note{font-size:12px;color:#616161;line-height:1.45}`,
  `.sx-o{stroke:var(--o)}.sx-f{fill:var(--f)}.sx-d{stroke:var(--d)}.sx-a{fill:var(--a)}`,
  ...SEASONS.map((s) => `.sea-icon .ai-sea-ic--${s},.sea-pv--light .ai-sea-ic--${s}{${iconVars(SEASON_ICON_COLORS.light[s])}}`),
  ...SEASONS.map((s) => `.sea-pv--dark .ai-sea-ic--${s}{${iconVars(SEASON_ICON_COLORS.dark[s])}}`),
  ...["light", "dark"].flatMap((t) => SEASONS.map((s) => {
    const c = SEASON_TINTS[t][s];
    return `.sea-pv--${t} .sea-pv__btn.is-${s}{background:${c.bg};box-shadow:inset 0 0 0 1px ${c.ring}}.sea-pv--${t} .sea-pv__btn.is-${s}:hover{background:${c.hover}}.sea-pv--${t} .sea-pv__btn.is-${s} .go{color:${c.go}}`;
  })),
  `.sea-pv__btn.is-season .ic svg{width:19px;height:19px}`,
  ...SEASONS.map((s) => `.sea-sw__dot.is-${s}{background:${SEASON_TINTS.light[s].bg};box-shadow:inset 0 0 0 1.5px ${SEASON_TINTS.light[s].go}}`),
  `.sea-sw__dot.is-plain{background:#f5f5f7}`,
  `.sea-sw__dot.is-auto{background:conic-gradient(${SEASONS.map((s, i) => `${SEASON_TINTS.light[s].go} ${i * 25}% ${(i + 1) * 25}%`).join(",")});box-shadow:inset 0 0 0 4px #fff,inset 0 0 0 5px rgba(0,0,0,.08)}`,
  `@media (hover:hover) and (prefers-reduced-motion:no-preference){.sea-pv__btn .ic svg,.sea-icon svg{transition:transform .6s cubic-bezier(.3,1.4,.5,1)}.sea-pv__btn:hover .ai-sea-ic--fall,.sea-icon:hover .ai-sea-ic--fall{transform:rotate(-12deg) translateY(-1px)}.sea-pv__btn:hover .ai-sea-ic--winter,.sea-icon:hover .ai-sea-ic--winter{transform:rotate(60deg)}.sea-pv__btn:hover .ai-sea-ic--spring,.sea-icon:hover .ai-sea-ic--spring{transform:rotate(36deg) scale(1.06)}.sea-pv__btn:hover .ai-sea-ic--summer,.sea-icon:hover .ai-sea-ic--summer{transform:rotate(45deg)}}`,
  `@media (max-width:760px){.sea-ed{grid-template-columns:minmax(0,1fr)}.sea-pv{position:static}}`,
].join("\n");

// trusted, fixed markup (the icons above) — never shopper or merchant text.
const Svg = ({ html }) => <span className="ic" dangerouslySetInnerHTML={{ __html: html }} />;

function Preview({ theme, icon, tint, label }) {
  return (
    <div className={`sea-pv__frame sea-pv--${theme}`} aria-hidden="true">
      <div className="sea-pv__cap">Start here</div>
      <div className="sea-pv__grid">
        <div className={`sea-pv__btn is-season${tint !== "plain" ? ` is-${tint}` : ""}`}>
          <Svg html={SEASON_ICON_SVG[icon]} />
          <span className="t">{label}</span>
          <span className="go" dangerouslySetInnerHTML={{ __html: ARROW }} />
        </div>
        <div className="sea-pv__btn">
          <Svg html={INSOLE} />
          <span className="t">Shop Orthotics</span>
          <span className="go" dangerouslySetInnerHTML={{ __html: ARROW }} />
        </div>
      </div>
    </div>
  );
}

// Arrow keys move the choice within a radio group, as native radios do.
function radioKeys(list, current, choose) {
  return (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = (list.indexOf(current) + step + list.length) % list.length;
    choose(list[i]);
    e.currentTarget.parentElement?.querySelectorAll("[role=radio]")[i]?.focus();
  };
}

export function SeasonalSection({ values, set, info }) {
  const icon = seasonOf(values.seasonalCtaIcon);
  const color = colorOf(values.seasonalCtaColor);
  const tint = tintOf(icon, color);
  const label = cleanLabel(values.seasonalCtaLabel, icon);
  const handle = collectionHandle(values.seasonalCtaCollection);
  // What the Shopify picker returned this time, before it's saved.
  const [picked, setPicked] = useState(null);
  const shown = picked && picked.handle === handle ? picked : info && !info.missing && info.handle === handle ? info : null;
  const missing = !shown && Boolean(info?.missing) && info.handle === handle;
  const typedBad = values.seasonalCtaCollection.trim() && !handle;

  const browse = async () => {
    try {
      const res = await window.shopify?.resourcePicker?.({ type: "collection", action: "select", multiple: false });
      const c = Array.isArray(res) ? res[0] : res?.selection?.[0];
      if (!c?.handle) return;
      set("seasonalCtaCollection")(c.handle);
      setPicked({ handle: c.handle, title: c.title, count: Number.isFinite(c.productsCount) ? c.productsCount : null });
    } catch { /* closed */ }
  };

  return (
    <BlockStack gap="400">
      <style dangerouslySetInnerHTML={{ __html: SEASONAL_CSS }} />
      <SectionHead title="Seasonal button">Feature a collection as the first Start here button, and give it the season's look — fall leaves, winter snow, spring blossoms or summer sun.</SectionHead>
      <Group>
        <Row
          title="Show the seasonal button"
          help="It takes the place of the first Start here button while it's on. Tapping it shows the collection's footwear right in the chat — the most colorful first."
          toggle
          checked={values.seasonalCtaOn}
          onChange={set("seasonalCtaOn")}
          always
        >
          <div className="sea-ed">
            <BlockStack gap="500">
              <div>
                <p className="sea-ed__label" id="sea-icon-label">Icon</p>
                <div className="sea-icons" role="radiogroup" aria-labelledby="sea-icon-label">
                  {SEASONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={icon === s ? "true" : "false"}
                      tabIndex={icon === s ? 0 : -1}
                      className="sea-icon"
                      onClick={() => set("seasonalCtaIcon")(s)}
                      onKeyDown={radioKeys(SEASONS, icon, set("seasonalCtaIcon"))}
                    >
                      <span dangerouslySetInnerHTML={{ __html: SEASON_ICON_SVG[s] }} />
                      {SEASON_NAMES[s]}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="sea-ed__label" id="sea-color-label">Button color</p>
                <div className="sea-sws" role="radiogroup" aria-labelledby="sea-color-label">
                  {COLOR_CHOICES.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      role="radio"
                      aria-checked={color === c.value ? "true" : "false"}
                      tabIndex={color === c.value ? 0 : -1}
                      className="sea-sw"
                      onClick={() => set("seasonalCtaColor")(c.value)}
                      onKeyDown={radioKeys(COLOR_CHOICES.map((x) => x.value), color, set("seasonalCtaColor"))}
                    >
                      <span className={`sea-sw__dot is-${c.value}`} />
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>

              <TextField
                label="Button text"
                value={values.seasonalCtaLabel}
                onChange={set("seasonalCtaLabel")}
                placeholder={defaultLabel(icon)}
                maxLength={LABEL_MAX}
                showCharacterCount
                autoComplete="off"
                helpText="Also what shoppers send when they tap it."
              />

              <BlockStack gap="150">
                <TextField
                  label="Collection"
                  value={values.seasonalCtaCollection}
                  onChange={set("seasonalCtaCollection")}
                  placeholder="fall-collection or its link"
                  autoComplete="off"
                  error={typedBad ? "Use the collection's handle (like fall-collection) or its link." : values.seasonalCtaOn && !handle ? "Choose the collection the button shows." : undefined}
                  connectedRight={<Button onClick={browse}>Browse</Button>}
                />
                {shown && (
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" variant="bodySm">{shown.title}</Text>
                    {Number.isFinite(shown.count) && <Badge>{`${shown.count.toLocaleString("en-US")} products`}</Badge>}
                  </InlineStack>
                )}
                {missing && (
                  <Text as="p" variant="bodySm" tone="critical">This collection isn't on your store anymore — choose another.</Text>
                )}
              </BlockStack>
            </BlockStack>

            <div className="sea-pv">
              <Preview theme="light" icon={icon} tint={tint} label={label} />
              <Preview theme="dark" icon={icon} tint={tint} label={label} />
              <p className="sea-pv__note">
                {handle && !missing
                  ? <>Tapping it shows <b>{shown?.title || handle}</b>: footwear only, colorful options first, with View all for the rest.</>
                  : "Choose a collection to see what tapping it shows."}
              </p>
            </div>
          </div>
        </Row>
      </Group>
    </BlockStack>
  );
}

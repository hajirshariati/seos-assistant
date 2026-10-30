// Settings → Assistant look & voice: AVA's mark in the chat bar (the
// animated light, with its colors and a live preview drawn by the
// storefront's own shader, or the assistant's photo with a text button when
// minimized) and the talk button in the chat.
import { useEffect, useRef, useState } from "react";
import { useFetcher, useRouteLoaderData } from "react-router";
import { Card, BlockStack, InlineStack, Text, Button, Checkbox, TextField, Banner } from "@shopify/polaris";
import { ORB_FRAG } from "../lib/orb-shader";
import { ORB_DEFAULT_COLORS, ORB_DEFAULT_BG, ORB_COLOR_ROLES, normalizeHex } from "../lib/orb-colors";
import { launcherMark, cleanLauncherText, defaultLauncherText, LAUNCHER_TEXT_MAX } from "../lib/launcher-mark.js";
import { DEFAULT_APP_NAME, appBrand } from "../lib/app-brand.js";

// The five light colors, then the globe's own color behind them.
const ROLES = [...ORB_COLOR_ROLES, { label: "Globe background", hint: "deep black glass" }];
const DEFAULTS = [...ORB_DEFAULT_COLORS, ORB_DEFAULT_BG];

function hexToRgb(hex) {
  const h = normalizeHex(hex) || "#000000";
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

// The mark, animated, at the size it's drawn: the same shader the widget runs.
function OrbPreview({ colors, size = 96 }) {
  // colors: the five light colors, then the globe color.
  const ref = useRef(null);
  const colorsRef = useRef(colors);
  const redrawRef = useRef(null);
  colorsRef.current = colors;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.height = Math.round(size * dpr);
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: true });
    if (!gl) return undefined;
    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const pr = gl.createProgram();
    gl.attachShader(pr, mk(gl.VERTEX_SHADER, "attribute vec2 v;void main(){gl_Position=vec4(v,0.,1.);}"));
    gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, ORB_FRAG));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return undefined;
    gl.useProgram(pr);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, "v");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(gl.getUniformLocation(pr, "res"), canvas.width, canvas.height);
    gl.uniform1f(gl.getUniformLocation(pr, "seed"), 3.3);
    gl.uniform1f(gl.getUniformLocation(pr, "dark"), 1);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const tLoc = gl.getUniformLocation(pr, "t");
    const cLocs = [0, 1, 2, 3, 4].map((i) => gl.getUniformLocation(pr, `c${i}`)).concat([gl.getUniformLocation(pr, "cbg")]);
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const draw = (now) => {
      colorsRef.current.forEach((c, i) => { const [r, g, b] = hexToRgb(c); gl.uniform3f(cLocs[i], r, g, b); });
      gl.uniform1f(tLoc, still ? 3.3 : now / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!still) raf = requestAnimationFrame(draw);
    };
    redrawRef.current = still ? () => draw(0) : null;
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); redrawRef.current = null; };
  }, [size]);
  // Reduced motion draws one still frame: draw it again when colors change.
  useEffect(() => { redrawRef.current?.(); }, [colors]);
  return <canvas ref={ref} aria-hidden="true" style={{ width: size, height: size, display: "block" }} />;
}

// The look of the minimized chat in each choice, drawn small for the picker.
const MARK_CSS = `
  .mark-pick { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .mark-tile { all: unset; box-sizing: border-box; display: grid; gap: 10px; padding: 10px 10px 12px; border-radius: 14px; cursor: pointer;
    background: #fff; box-shadow: inset 0 0 0 1px rgba(30,27,51,0.12); transition: box-shadow .18s ease, background .18s ease; position: relative; }
  .mark-tile:hover { box-shadow: inset 0 0 0 1px rgba(30,27,51,0.22); }
  .mark-tile:focus-visible { outline: 2px solid #2D6B4F; outline-offset: 2px; }
  .mark-tile[aria-checked="true"] { box-shadow: inset 0 0 0 2px #2D6B4F; background: rgba(45,107,79,0.03); }
  .mark-tile__check { position: absolute; z-index: 2; top: 16px; left: 16px; width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center;
    box-shadow: inset 0 0 0 1.5px rgba(30,27,51,0.22); background: #fff; }
  .mark-tile[aria-checked="true"] .mark-tile__check { background: #2D6B4F; box-shadow: none; }
  .mark-tile__stage { position: relative; height: 104px; border-radius: 10px; overflow: hidden;
    background: linear-gradient(180deg, #f7f7f8 0%, #efeff1 100%); }
  .mark-tile__bar { position: absolute; left: 10px; right: 46px; bottom: 12px; height: 30px; display: flex; align-items: center; gap: 7px; padding: 0 10px 0 3px;
    background: #fff; border-radius: 999px; box-shadow: 0 0 0 1px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.08); }
  .mark-tile__bar span { font-size: 11px; color: #6e6e73; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mark-tile__min { position: absolute; right: 10px; top: 12px; }
  .mark-tile__name { font-size: 13.5px; font-weight: 650; color: #1a1a1a; line-height: 18px; padding-right: 26px; }
  .mark-tile__hint { font-size: 12.5px; color: #616161; line-height: 17px; margin-top: 1px; }
  .mark-photo { display: block; border-radius: 50%; object-fit: cover; background: #e9e9ec; flex: none; }
  .mark-ph { display: grid; place-items: end center; border-radius: 50%; overflow: hidden; flex: none; background: linear-gradient(160deg, #e7e2dc, #d7d0c8); }
  @property --mark-turn { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
  @keyframes markTurn { to { --mark-turn: 360deg; } }
  .mark-pill { position: relative; isolation: isolate; display: inline-flex; align-items: center; height: 44px; padding: 0 20px; border-radius: 999px; color: #fff;
    font: 600 15px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif; letter-spacing: -0.01em; white-space: nowrap; -webkit-font-smoothing: antialiased; }
  .mark-pill::after { content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit; background: #0d0d12; }
  .mark-pill::before { content: ""; position: absolute; inset: -3px; z-index: -2; border-radius: inherit; filter: blur(10px); opacity: 0.6;
    background: conic-gradient(from var(--mark-turn), #ff4fa3, #a35cff, #3d7bff, #29e0d0, #ff4fa3); animation: markTurn 10s linear infinite; }
  .mark-pill--sm { height: 24px; padding: 0 10px; font-size: 10.5px; }
  .mark-pill--sm::before { inset: -2px; filter: blur(6px); }
  @media (prefers-reduced-motion: reduce) { .mark-pill::before { animation: none; } }
  .mark-stage { display: flex; align-items: center; justify-content: center; gap: 28px; flex-wrap: wrap; padding: 26px 20px; border-radius: 14px;
    background: linear-gradient(180deg, #f7f7f8 0%, #efeff1 100%); }
  .mark-stage__item { display: grid; gap: 10px; justify-items: center; }
  .mark-stage__cap { font-size: 12px; color: #6e6e73; }
  .mark-bar { display: flex; align-items: center; gap: 10px; background: #fff; border-radius: 999px; padding: 4px 18px 4px 4px; min-width: 0;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.08); }
  .mark-bar span { font-size: 13px; color: #6e6e73; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
  @media (max-width: 560px) { .mark-pick { grid-template-columns: minmax(0, 1fr); } .mark-stage { gap: 18px; } }
`;

// The assistant's photo, or a neutral stand-in until the chat reports one.
function Photo({ url, size }) {
  if (url) return <img className="mark-photo" src={url} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  return (
    <span className="mark-ph" aria-hidden="true" style={{ width: size, height: size }}>
      <svg viewBox="0 0 40 40" width={size} height={size}><circle cx="20" cy="16" r="7.5" fill="#fff" fillOpacity="0.9" /><path d="M6 40c1.6-8.4 7.4-13 14-13s12.4 4.6 14 13z" fill="#fff" fillOpacity="0.9" /></svg>
    </span>
  );
}

function Check() {
  return <span className="mark-tile__check" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 8.4l2.8 2.8 6.2-6.4" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>;
}

export function OrbColorsCard({ initial, initialBg = ORB_DEFAULT_BG, initialMark = "orb", initialText = "", avatarUrl = "", avatarState = "unknown", launcherPrompt = "How can I help you today?" }) {
  const fetcher = useFetcher();
  const brand = appBrand(useRouteLoaderData("routes/app")?.appName || DEFAULT_APP_NAME);
  const textDefault = defaultLauncherText(brand);
  const start = [...initial, initialBg];
  const [saved, setSaved] = useState({ colors: start, mark: launcherMark(initialMark), text: cleanLauncherText(initialText) });
  const [colors, setColors] = useState(start);
  const [drafts, setDrafts] = useState(start);
  const [mark, setMark] = useState(launcherMark(initialMark));
  const [text, setText] = useState(cleanLauncherText(initialText) || (launcherMark(initialMark) === "avatar" ? textDefault : ""));
  const valid = colors.every((c) => normalizeHex(c));
  const sendText = mark === "avatar" ? cleanLauncherText(text) || textDefault : saved.text;
  const dirty = colors.some((c, i) => normalizeHex(c) !== normalizeHex(saved.colors[i])) || mark !== saved.mark || sendText !== saved.text;
  const busy = fetcher.state !== "idle";
  const photo = mark === "avatar";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.orbSaved) {
      setSaved({ colors: [...fetcher.data.colors, fetcher.data.bg], mark: launcherMark(fetcher.data.mark), text: cleanLauncherText(fetcher.data.text) });
    }
  }, [fetcher.state, fetcher.data]);

  const choose = (next) => {
    setMark(next);
    if (next === "avatar" && !cleanLauncherText(text)) setText(textDefault);
  };
  const onPickKey = (e) => {
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      const next = photo ? "orb" : "avatar";
      choose(next);
      e.currentTarget.parentElement?.querySelector(`[data-mark="${next}"]`)?.focus();
    }
  };
  const setOne = (i, value) => {
    setDrafts((d) => d.map((x, j) => (j === i ? value : x)));
    const hex = normalizeHex(value);
    if (hex) setColors((c) => c.map((x, j) => (j === i ? hex : x)));
  };
  const save = () => {
    const fd = new FormData();
    fd.set("intent", "save_orb_colors");
    colors.slice(0, 5).forEach((c, i) => fd.set(`c${i}`, c));
    fd.set("bg", colors[5]);
    fd.set("mark", mark);
    fd.set("text", sendText);
    fetcher.submit(fd, { method: "post" });
  };
  const reset = () => {
    setColors(DEFAULTS.slice());
    setDrafts(DEFAULTS.slice());
  };
  const shownText = cleanLauncherText(text) || textDefault;

  return (
    <Card>
      <style>{MARK_CSS}</style>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">AVA mark</Text>
          <Text as="p" tone="subdued">
            What sits at the start of the chat bar, and what shoppers see once they minimize it. Changes reach your
            storefront within a minute.
          </Text>
        </BlockStack>

        <div className="mark-pick" role="radiogroup" aria-label="AVA mark">
          <button type="button" role="radio" data-mark="orb" aria-checked={!photo} tabIndex={photo ? -1 : 0} className="mark-tile" onClick={() => choose("orb")} onKeyDown={onPickKey}>
            <Check />
            <div className="mark-tile__stage" aria-hidden="true">
              <div className="mark-tile__min" style={{ borderRadius: "50%", boxShadow: "0 3px 10px rgba(0,0,0,0.18)" }}><OrbPreview colors={colors} size={30} /></div>
              <div className="mark-tile__bar"><OrbPreview colors={colors} size={24} /><span>{launcherPrompt}</span></div>
            </div>
            <div>
              <div className="mark-tile__name">AVA light</div>
              <div className="mark-tile__hint">The animated light. Minimized, it&apos;s a round light.</div>
            </div>
          </button>
          <button type="button" role="radio" data-mark="avatar" aria-checked={photo} tabIndex={photo ? 0 : -1} className="mark-tile" onClick={() => choose("avatar")} onKeyDown={onPickKey}>
            <Check />
            <div className="mark-tile__stage" aria-hidden="true">
              <div className="mark-tile__min"><span className="mark-pill mark-pill--sm">{shownText}</span></div>
              <div className="mark-tile__bar"><Photo url={avatarUrl} size={24} /><span>{launcherPrompt}</span></div>
            </div>
            <div>
              <div className="mark-tile__name">Avatar photo</div>
              <div className="mark-tile__hint">Your assistant&apos;s photo. Minimized, it&apos;s a text button.</div>
            </div>
          </button>
        </div>

        {photo ? (
          <BlockStack gap="400">
            <div className="mark-stage">
              <div className="mark-stage__item">
                <div className="mark-bar"><Photo url={avatarUrl} size={34} /><span>{launcherPrompt}</span></div>
                <span className="mark-stage__cap">Chat bar</span>
              </div>
              <div className="mark-stage__item">
                <span className="mark-pill">{shownText}</span>
                <span className="mark-stage__cap">Minimized</span>
              </div>
            </div>
            <div style={{ maxWidth: 360 }}>
              <TextField
                label="Minimized button text"
                value={text}
                onChange={setText}
                placeholder={textDefault}
                maxLength={LAUNCHER_TEXT_MAX}
                showCharacterCount
                autoComplete="off"
                helpText="What the chat bar says once a shopper minimizes it. Keep it short — two or three words."
              />
            </div>
            {avatarState === "none" ? (
              <Banner tone="warning">
                Your chat has no avatar photo yet. Add one in the theme editor (App embeds → Avatar Image); until then the
                chat bar keeps AVA&apos;s light.
              </Banner>
            ) : (
              <Text as="p" variant="bodySm" tone="subdued">
                {avatarState === "unknown"
                  ? "The photo is the Avatar Image set in the theme editor (App embeds). It shows here once the chat has loaded on your store."
                  : "The photo is the Avatar Image set in the theme editor (App embeds). Change it there."}
              </Text>
            )}
          </BlockStack>
        ) : (
          <BlockStack gap="300">
            <Text as="p" tone="subdued">
              The five colors of the light sheets turning inside AVA&apos;s mark, and the globe&apos;s own color behind
              them, in the chat bar and the bubble. The light blends where it crosses, so pick colors that work together.
            </Text>
            <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ display: "grid", gap: 10, justifyItems: "center" }}>
                <div style={{ borderRadius: "50%", boxShadow: "0 2px 10px rgba(0,0,0,0.18)" }}>
                  <OrbPreview colors={colors} size={112} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#fff", borderRadius: 999, padding: "4px 14px 4px 4px", boxShadow: "0 0 0 1px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.08)" }}>
                  <OrbPreview colors={colors} size={30} />
                  <span style={{ fontSize: 12, color: "#6e6e73" }}>{launcherPrompt}</span>
                </div>
              </div>
              <style>{".orb-swatch::-webkit-color-swatch-wrapper{padding:0}.orb-swatch::-webkit-color-swatch{border:0;border-radius:50%}.orb-swatch::-moz-color-swatch{border:0;border-radius:50%}"}</style>
              <div style={{ display: "grid", gap: 10, flex: "1 1 280px", minWidth: 260 }}>
                {ROLES.map((role, i) => (
                  <div key={role.label} style={{ display: "grid", gridTemplateColumns: "36px 1fr 120px", gap: 10, alignItems: "center", ...(i === 5 ? { marginTop: 6, paddingTop: 12, borderTop: "1px solid rgba(0,0,0,0.08)" } : {}) }}>
                    <input
                      className="orb-swatch"
                      type="color"
                      aria-label={`${role.label} color`}
                      value={colors[i]}
                      onChange={(e) => setOne(i, e.target.value)}
                      style={{ width: 32, height: 32, padding: 0, border: "1px solid rgba(0,0,0,0.12)", borderRadius: "50%", background: "none", cursor: "pointer", overflow: "hidden" }}
                    />
                    <BlockStack gap="0">
                      <Text as="span" variant="bodyMd" fontWeight="medium">{role.label}</Text>
                      <Text as="span" variant="bodySm" tone="subdued">Default: {role.hint}</Text>
                    </BlockStack>
                    <TextField
                      label={`${role.label} hex`}
                      labelHidden
                      autoComplete="off"
                      value={drafts[i]}
                      onChange={(v) => setOne(i, v)}
                      error={normalizeHex(drafts[i]) ? undefined : "Use a hex color like #1a4dff"}
                    />
                  </div>
                ))}
              </div>
            </div>
          </BlockStack>
        )}

        <InlineStack gap="300" blockAlign="center">
          <Button variant="primary" onClick={save} disabled={!dirty || !valid} loading={busy}>Save</Button>
          {!photo && <Button onClick={reset} disabled={colors.every((c, i) => normalizeHex(c) === DEFAULTS[i])}>Reset colors</Button>}
          {!busy && fetcher.data?.orbSaved && !dirty && <Text as="span" variant="bodySm" tone="success">Saved — live on your storefront within a minute.</Text>}
          {fetcher.data?.orbError && <Text as="span" variant="bodySm" tone="critical">{fetcher.data.orbError}</Text>}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export function VoiceInputCard({ initialOn }) {
  const fetcher = useFetcher();
  const [on, setOn] = useState(initialOn !== false);
  const toggle = (next) => {
    setOn(next);
    const fd = new FormData();
    fd.set("intent", "save_voice_input");
    fd.set("on", next ? "true" : "false");
    fetcher.submit(fd, { method: "post" });
  };
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center" wrap={false} gap="400">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">Talk button</Text>
            <Text as="p" tone="subdued">
              A mic in the message box: shoppers tap it and speak, their words appear as they talk, and the message
              sends when they pause (the mic turns into Send as soon as there are words). AVA still answers in text. Uses the browser&apos;s built-in speech
              recognition (Chrome, Safari, Edge) and is hidden where that isn&apos;t available.
            </Text>
          </BlockStack>
          <Checkbox label={on ? "On" : "Off"} checked={on} onChange={toggle} />
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

// Settings → Assistant look & voice: the colors of the assistant's animated
// mark (with a live preview drawn by the storefront's own shader) and the
// talk button in the chat.
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Card, BlockStack, InlineStack, Text, Button, Checkbox, TextField } from "@shopify/polaris";
import { ORB_FRAG } from "../lib/orb-shader";
import { ORB_DEFAULT_COLORS, ORB_DEFAULT_BG, ORB_COLOR_ROLES, normalizeHex } from "../lib/orb-colors";

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

export function OrbColorsCard({ initial, initialBg = ORB_DEFAULT_BG }) {
  const fetcher = useFetcher();
  const start = [...initial, initialBg];
  const [saved, setSaved] = useState(start);
  const [colors, setColors] = useState(start);
  const [drafts, setDrafts] = useState(start);
  const valid = colors.every((c) => normalizeHex(c));
  const dirty = colors.some((c, i) => normalizeHex(c) !== normalizeHex(saved[i]));
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.orbSaved) setSaved([...fetcher.data.colors, fetcher.data.bg]);
  }, [fetcher.state, fetcher.data]);

  const setOne = (i, value) => {
    setDrafts((d) => d.map((x, j) => (j === i ? value : x)));
    const hex = normalizeHex(value);
    if (hex) setColors((c) => c.map((x, j) => (j === i ? hex : x)));
  };
  const save = (next) => {
    const fd = new FormData();
    fd.set("intent", "save_orb_colors");
    next.slice(0, 5).forEach((c, i) => fd.set(`c${i}`, c));
    fd.set("bg", next[5]);
    fetcher.submit(fd, { method: "post" });
  };
  const reset = () => {
    setColors(DEFAULTS.slice());
    setDrafts(DEFAULTS.slice());
  };

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">AVA mark colors</Text>
          <Text as="p" tone="subdued">
            The five colors of the light sheets turning inside AVA&apos;s mark, and the globe&apos;s own color
            behind them, in the chat bar and the bubble. The light blends where it crosses, so pick colors that work
            together. Changes reach your storefront within a minute.
          </Text>
        </BlockStack>
        <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: 10, justifyItems: "center" }}>
            <div style={{ borderRadius: "50%", boxShadow: "0 2px 10px rgba(0,0,0,0.18)" }}>
              <OrbPreview colors={colors} size={112} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#fff", borderRadius: 999, padding: "4px 14px 4px 4px", boxShadow: "0 0 0 1px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.08)" }}>
              <OrbPreview colors={colors} size={30} />
              <span style={{ fontSize: 12, color: "#6e6e73" }}>How can I help you today?</span>
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
        <InlineStack gap="300" blockAlign="center">
          <Button variant="primary" onClick={() => save(colors)} disabled={!dirty || !valid} loading={busy}>Save colors</Button>
          <Button onClick={reset} disabled={colors.every((c, i) => normalizeHex(c) === DEFAULTS[i])}>Reset to defaults</Button>
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

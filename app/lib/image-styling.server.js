// "Visualize My Look" — AI styling-preview image generation.
//
// Takes the REAL product photo as a locked reference and asks a
// subject-preserving image model to compose a photorealistic styling
// scene around it (on a model / styled in context) for the thing the
// customer described ("heels to go with my blue dress"). The product
// must come back IDENTICAL — the prompt hard-constrains the model not
// to alter it, and we feed the actual catalog image as the reference.
//
// Two providers, merchant-selected (like the embeddings provider):
//   - gemini  → Google's current Flash image model ("Nano Banana"), with
//               the previous generation as automatic fallback.
//   - openai  → gpt-image-1.5 edits, with gpt-image-1 as fallback.
// The newer models keep a reference product far more faithful; the
// fallback only kicks in when the merchant's key can't use them.
//
// The merchant pays their own provider directly; we only meter it.
// Model ids are env-overridable so they can be bumped without a deploy.

const GEMINI_IMAGE_MODELS = (process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image-preview,gemini-2.5-flash-image")
  .split(",").map((m) => m.trim()).filter(Boolean);
const OPENAI_IMAGE_MODELS = (process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5,gpt-image-1")
  .split(",").map((m) => m.trim()).filter(Boolean);
// Portrait 2:3 matches the chat's tall preview column (a square image was
// cropped at the sides and enlarged to fill it, which also made it look soft)
// and OpenAI's 1024x1536.
const IMAGE_ASPECT_RATIO = process.env.VISUALIZE_ASPECT_RATIO || "2:3";

// Hard ceilings so a slow/hung provider can't leave a socket open
// forever (the app proxy kills the upstream connection long before
// these, but without our own bound the fetch keeps running and burns
// resources after the client is already gone). Env-overridable.
const PROVIDER_TIMEOUT_MS = Number(process.env.VISUALIZE_PROVIDER_TIMEOUT_MS) || 55000;
const IMAGE_FETCH_TIMEOUT_MS = Number(process.env.VISUALIZE_IMAGE_FETCH_TIMEOUT_MS) || 15000;

// How many reference angles to feed the image model. More views = more
// faithful product reproduction; capped so the request stays well within
// the proxy window. Env-overridable.
// Galleries often end with lifestyle or detail shots that blur what the
// product looks like — the first few are the clean product angles.
const MAX_REFERENCE_IMAGES = Math.max(1, Number(process.env.VISUALIZE_MAX_REFERENCE_IMAGES) || 3);

// AbortSignal.timeout (Node 17.3+) — a self-arming abort that fires after
// `ms` and rejects the fetch with a TimeoutError we translate below.
function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined; // very old runtime — degrade to no timeout
  }
}

// Rough per-image cost (USD) for metering only — overridable via env.
// Both providers land near $0.04/image at the sizes we request.
const IMAGE_COST_USD = {
  gemini: Number(process.env.GEMINI_IMAGE_COST_USD) || 0.04,
  openai: Number(process.env.OPENAI_IMAGE_COST_USD) || 0.04,
};

export function isImageProviderSupported(provider) {
  return provider === "gemini" || provider === "openai";
}

// The fidelity-locked stylist prompt. The product image is the authority;
// the text only governs the look around it. "See It Styled" means the whole
// outfit: a full-length fashion photo of one person, standing naturally, with
// the shoes still the sharpest, most noticeable thing in the frame.
export function buildStylistPrompt({ productTitle, styleContext }) {
  const ctx = String(styleContext || "").trim();
  const sceneLine = ctx
    ? `Style the outfit and the setting for where the shopper said they'll wear it: "${ctx}" (a trip or beach → a sunny boardwalk; hiking → a trail; the gym or running → a park path in activewear; a wedding or evening → an elegant venue in dressy clothes; work → a bright modern office in smart-casual clothes). Keep it simple and believable.`
    : "Pick an outfit and a simple, believable setting that suit this footwear (sneakers → casual clothes on a sunlit city sidewalk, sandals → a summer outfit on a boardwalk, boots → autumn layers on a tree-lined path, dress shoes or heels → an elegant outfit in a polished interior).";
  return [
    "Create ONE photorealistic full-length fashion photo of a single person wearing this exact footwear, in the style of a premium footwear brand's lookbook.",
    "The attached image(s) show the SAME single product; the first image is the main view.",
    `Product: ${String(productTitle || "the shoe").trim()}.`,
    "THE PRODUCT MUST NOT CHANGE: identical shape, silhouette, color, materials, texture and fine details — keep every pattern, knit, perforation, stitching, embellishment, sparkle, sole color and logo exactly as in the reference. Do not simplify, smooth out, recolor or redesign anything.",
    "FRAMING: show the whole person head to toe, standing naturally in a relaxed pose, camera at about knee height so the shoes sit large and close in the lower part of the frame. The shoes are the focal point: sharpest focus, best light, unobstructed (no long hems, bags or objects covering them), seen from a side or three-quarter angle like the main reference photo. Exactly two feet, correctly matched left and right.",
    "OUTFIT: a complete, tasteful outfit that complements the shoes' color and style without competing with them.",
    "SCENE: " + sceneLine,
    "PHOTO QUALITY: natural soft daylight, true-to-life color, gently blurred background, high resolution, clean editorial look. Natural, realistic face and hands. No text, watermarks or extra logos, no distorted soles or toes.",
  ].join("\n");
}

async function fetchImageAsBase64(url) {
  const res = await fetch(url, { signal: timeoutSignal(IMAGE_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`could not fetch product image (${res.status})`);
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("product image was empty");
  return { base64: buf.toString("base64"), mimeType: contentType.split(";")[0].trim(), bytes: buf };
}

// A model the key can't use (not found / not allowed / unknown option) is
// answered immediately with a 4xx — safe to retry on the next model.
function modelUnavailable(status, detail) {
  return (status === 404 || status === 400 || status === 403) &&
    /model|not found|not supported|unsupported|permission|access|unknown|invalid/i.test(detail || "");
}

async function generateWithGemini({ apiKey, prompt, images }) {
  let lastErr;
  for (const model of GEMINI_IMAGE_MODELS) {
    try {
      return await geminiOnce({ apiKey, prompt, images, model });
    } catch (err) {
      lastErr = err;
      if (!err?.retryNextModel) throw err;
      console.warn(`[image-styling] gemini model ${model} unavailable, trying next: ${err.message.slice(0, 160)}`);
    }
  }
  throw lastErr;
}

async function geminiOnce({ apiKey, prompt, images, model }) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  // Feed every reference angle we have. Multiple views (top/front/side) let
  // the model reproduce the product faithfully instead of inventing the
  // sides a single photo never showed.
  const reqParts = [{ text: prompt }];
  for (const img of images) {
    reqParts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
  }
  const body = {
    contents: [{ parts: reqParts }],
    // Ask for an image back, portrait.
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: IMAGE_ASPECT_RATIO } },
  };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeoutSignal(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`Gemini image API ${res.status} (${model}): ${detail.slice(0, 300)}`);
    err.retryNextModel = modelUnavailable(res.status, detail);
    throw err;
  }
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p?.inline_data?.data || p?.inlineData?.data);
  const data = imgPart?.inline_data?.data || imgPart?.inlineData?.data;
  const mime = imgPart?.inline_data?.mime_type || imgPart?.inlineData?.mimeType || "image/png";
  if (!data) throw new Error("Gemini returned no image");
  return `data:${mime};base64,${data}`;
}

async function generateWithOpenAI({ apiKey, prompt, images }) {
  let lastErr;
  for (const model of OPENAI_IMAGE_MODELS) {
    try {
      return await openaiOnce({ apiKey, prompt, images, model });
    } catch (err) {
      lastErr = err;
      if (!err?.retryNextModel) throw err;
      console.warn(`[image-styling] openai model ${model} unavailable, trying next: ${err.message.slice(0, 160)}`);
    }
  }
  throw lastErr;
}

async function openaiOnce({ apiKey, prompt, images, model, fidelity = true }) {
  // gpt-image edits take the reference image(s) plus the prompt. The older
  // gpt-image-1 needs "low" quality to finish inside the request window;
  // gpt-image-1.5 is several times faster, so it runs at "medium" — the
  // difference between a soft, muddy preview and a crisp one.
  const legacy = model === "gpt-image-1";
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", "1024x1536");
  form.append("quality", process.env.OPENAI_IMAGE_QUALITY || (legacy ? "low" : "medium"));
  // input_fidelity=high keeps the reference product's fine details instead
  // of loosely re-imagining it.
  if (fidelity) form.append("input_fidelity", process.env.OPENAI_IMAGE_INPUT_FIDELITY || "high");
  for (const [i, image] of images.slice(0, legacy ? 1 : images.length).entries()) {
    form.append(legacy ? "image" : "image[]", new Blob([image.bytes], { type: image.mimeType || "image/png" }), `product-${i + 1}.png`);
  }
  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: timeoutSignal(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // A model that doesn't take the fidelity option: same model without it.
    if (fidelity && res.status === 400 && /input_fidelity/i.test(detail)) {
      return openaiOnce({ apiKey, prompt, images, model, fidelity: false });
    }
    const err = new Error(`OpenAI image API ${res.status} (${model}): ${detail.slice(0, 300)}`);
    err.retryNextModel = modelUnavailable(res.status, detail);
    throw err;
  }
  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image");
  return `data:image/png;base64,${b64}`;
}

// Returns { imageDataUrl, costUsd, provider } or throws with a
// customer-safe message in err.message.
export async function generateStyledImage({
  provider,
  geminiApiKey = "",
  openaiApiKey = "",
  productImageUrl,
  productImageUrls,
  productTitle = "",
  styleContext = "",
}) {
  if (!isImageProviderSupported(provider)) {
    throw new Error(`unsupported image provider: ${provider || "(none)"}`);
  }
  const apiKey = provider === "gemini" ? geminiApiKey : openaiApiKey;
  if (!apiKey) throw new Error(`no API key configured for image provider "${provider}"`);

  // Accept a list of reference angles (preferred) or a single URL (legacy).
  // De-dupe and bound it so a slow/huge gallery can't blow the request window.
  const candidateUrls = (
    Array.isArray(productImageUrls) && productImageUrls.length
      ? productImageUrls
      : [productImageUrl]
  )
    .map((u) => String(u || "").trim())
    .filter(Boolean)
    .filter((u, i, a) => a.indexOf(u) === i)
    .slice(0, MAX_REFERENCE_IMAGES);
  if (!candidateUrls.length) throw new Error("product has no image to style");

  const startedAt = Date.now();
  // Fetch all references in parallel; tolerate individual failures as long as
  // at least one survives (so a single dead gallery URL can't kill the run).
  const fetched = await Promise.all(
    candidateUrls.map((u) =>
      fetchImageAsBase64(u).catch((err) => {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") return null;
        console.error(`[image-styling] reference fetch failed (${u}):`, err?.message || err);
        return null;
      }),
    ),
  );
  const images = fetched.filter(Boolean);
  if (!images.length) {
    throw new Error(`product image fetch failed or timed out after ${IMAGE_FETCH_TIMEOUT_MS}ms`);
  }
  const prompt = buildStylistPrompt({ productTitle, styleContext });

  let imageDataUrl;
  try {
    imageDataUrl =
      provider === "gemini"
        ? await generateWithGemini({ apiKey, prompt, images })
        : await generateWithOpenAI({ apiKey, prompt, images });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(
        `${provider} image generation timed out after ${PROVIDER_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  }

  // Visibility for the visualize path (previously a black box). Duration
  // tells us whether we're racing the app-proxy deadline; bytes tells us
  // whether the base64 payload is large enough to trip a proxy response
  // size limit. ~chars*0.75 ≈ decoded image bytes.
  const ms = Date.now() - startedAt;
  const payloadChars = imageDataUrl ? imageDataUrl.length : 0;
  console.log(
    `[image-styling] provider=${provider} refs=${images.length} ms=${ms} payloadChars=${payloadChars} ~bytes=${Math.round(payloadChars * 0.73)}`,
  );

  return { imageDataUrl, costUsd: IMAGE_COST_USD[provider] || 0.04, provider, ms, payloadChars };
}

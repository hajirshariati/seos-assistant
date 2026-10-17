import { authenticate } from "../shopify.server";
import { recordFeedback } from "../models/ChatFeedback.server";
import { checkIpShopRate, clientIp } from "../lib/rate-limit.server.js";

const MAX_BODY_BYTES = 16 * 1024;

export const loader = async () => {
  return Response.json({ error: "Method not allowed. Use POST." }, { status: 405 });
};

export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const ip = clientIp(request);
    if (!checkIpShopRate(session.shop, ip, { scope: "feedback", limit: 20 }).ok) {
      return Response.json({ error: "rate_limited" }, { status: 429 });
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "request_too_large" }, { status: 413 });
    let body = null;
    try { body = JSON.parse(raw); } catch { /* handled below */ }
    if (!body?.vote || !["up", "down"].includes(body.vote)) {
      return Response.json({ error: "Invalid vote" }, { status: 400 });
    }

    await recordFeedback({
      shop: session.shop,
      sessionId: String(body.session || "").slice(0, 100),
      vote: body.vote,
      botResponse: String(body.botResponse || ""),
      products: Array.isArray(body.products) ? body.products : [],
      conversation: Array.isArray(body.conversation) ? body.conversation : null,
      ip,
    });

    return Response.json({ ok: true });
  } catch (e) {
    // Shopify's signature check rejects by throwing a Response.
    if (e instanceof Response) throw e;
    console.error("[feedback] error:", e);
    return Response.json({ error: "Failed to record feedback" }, { status: 500 });
  }
};

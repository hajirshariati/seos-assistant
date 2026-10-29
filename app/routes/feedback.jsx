import { authenticate } from "../shopify.server";
import { recordFeedback, recordChatRating } from "../models/ChatFeedback.server";
import { cleanComment, cleanReason, cleanMoment, cleanVoteKey } from "../lib/chat-rating.js";
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

    // A reason only goes with a thumbs-down.
    const reason = body.vote === "down" ? cleanReason(body.reason) : null;

    // The "How's the chat going?" check-in: the whole conversation.
    if (body.kind === "chat") {
      await recordChatRating({
        shop: session.shop,
        sessionId: String(body.session || "").slice(0, 100),
        vote: body.vote,
        comment: cleanComment(body.comment),
        reason,
        moment: cleanMoment(body.moment, "chat"),
        conversation: Array.isArray(body.conversation) ? body.conversation : null,
        ip,
      });
      return Response.json({ ok: true });
    }

    await recordFeedback({
      shop: session.shop,
      sessionId: String(body.session || "").slice(0, 100),
      vote: body.vote,
      reason,
      moment: cleanMoment(body.moment),
      clientKey: cleanVoteKey(body.key),
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

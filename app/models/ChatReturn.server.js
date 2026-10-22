import prisma from "../db.server.js";

// Returns started in the chat (see prisma ChatReturn). Every call is
// best-effort: if the database is unreachable the return still goes through
// AfterShip, the chat just can't remember it.
export const RETURN_KEEP_DAYS = 120;

export async function findChatReturns(shop, orderIds) {
  const ids = [...new Set((orderIds || []).map(String).filter(Boolean))];
  if (!shop || !ids.length) return [];
  try {
    return await prisma.chatReturn.findMany({ where: { shop, orderId: { in: ids } }, orderBy: { createdAt: "asc" } });
  } catch (err) {
    console.error("[returns] lookup failed:", err?.message || err);
    return [];
  }
}

export async function saveChatReturn(row) {
  try {
    return await prisma.chatReturn.create({
      data: {
        shop: row.shop,
        orderId: String(row.orderId),
        lineIds: (row.lineIds || []).map(String).slice(0, 50),
        reasonKey: String(row.reasonKey || "").slice(0, 40),
        methodKey: String(row.methodKey || "").slice(0, 40),
        methodLabel: String(row.methodLabel || "").slice(0, 80),
        findUrl: String(row.findUrl || "").slice(0, 300),
        exchange: Boolean(row.exchange),
        rma: String(row.rma || "").slice(0, 80),
        returnId: String(row.returnId || "").slice(0, 80),
        labelUrl: String(row.labelUrl || "").slice(0, 1000),
        exchangeCards: row.exchangeCards?.length ? row.exchangeCards.slice(0, 6) : undefined,
      },
    });
  } catch (err) {
    console.error("[returns] save failed:", err?.message || err);
    return null;
  }
}

export async function deleteChatReturnsForOrders(shop, orderIds) {
  const ids = (orderIds || []).map((id) => String(id).replace(/\D/g, "")).filter(Boolean);
  if (!ids.length) return 0;
  const { count } = await prisma.chatReturn.deleteMany({ where: { shop, orderId: { in: ids } } });
  return count;
}

export async function cleanupOldReturns() {
  const cutoff = new Date(Date.now() - RETURN_KEEP_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.chatReturn.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (count) console.log(`[retention] removed ${count} chat return(s) older than ${RETURN_KEEP_DAYS} days`);
  return count;
}

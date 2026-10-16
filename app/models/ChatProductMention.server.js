import prisma from "../db.server";

export async function logMentions(shop, entries) {
  if (!shop || !entries?.length) return;
  const rows = entries
    .filter((e) => e?.handle && e?.title)
    .map((e) => ({
      shop,
      handle: String(e.handle).slice(0, 255),
      title: String(e.title).slice(0, 300),
      tool: String(e.tool || "unknown").slice(0, 50),
    }));
  if (rows.length === 0) return;
  try {
    await prisma.chatProductMention.createMany({ data: rows });
  } catch (err) {
    console.error("[ChatProductMention] log error:", err?.message);
  }
}

function resolveRange(arg) {
  if (arg && typeof arg === "object" && arg.startDate && arg.endDate) {
    return { start: new Date(arg.startDate), end: new Date(arg.endDate) };
  }
  const days = typeof arg === "number" ? arg : arg?.days || 30;
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return { start, end: new Date() };
}

export async function getTopProducts(shop, range = 30, limit = 10) {
  const { start, end } = resolveRange(range);
  const rows = await prisma.chatProductMention.groupBy({
    by: ["handle", "title"],
    where: { shop, createdAt: { gte: start, lte: end } },
    _count: { _all: true },
    orderBy: { _count: { handle: "desc" } },
    take: limit,
  });
  return rows.map((r) => ({
    handle: r.handle,
    title: r.title,
    mentions: r._count._all,
  }));
}

export async function getProductsByTool(shop, range = 30, limit = 10) {
  const { start, end } = resolveRange(range);
  const [searched, viewed] = await Promise.all([
    prisma.chatProductMention.groupBy({
      by: ["handle", "title"],
      where: { shop, tool: "search_products", createdAt: { gte: start, lte: end } },
      _count: { _all: true },
      orderBy: { _count: { handle: "desc" } },
      take: limit,
    }),
    prisma.chatProductMention.groupBy({
      by: ["handle", "title"],
      where: { shop, tool: "get_product_details", createdAt: { gte: start, lte: end } },
      _count: { _all: true },
      orderBy: { _count: { handle: "desc" } },
      take: limit,
    }),
  ]);
  return {
    searched: searched.map((r) => ({ handle: r.handle, title: r.title, count: r._count._all })),
    viewed: viewed.map((r) => ({ handle: r.handle, title: r.title, count: r._count._all })),
  };
}

export async function getInterestBreakdown(shop, range = 30) {
  const { start, end } = resolveRange(range);
  const rows = await prisma.chatProductMention.groupBy({
    by: ["tool"],
    where: { shop, createdAt: { gte: start, lte: end } },
    _count: { _all: true },
  });
  const result = { searches: 0, views: 0, shown: 0, total: 0 };
  for (const r of rows) {
    const count = r._count._all;
    result.total += count;
    if (r.tool === "search_products") result.searches = count;
    else if (r.tool === "get_product_details") result.views = count;
    else if (r.tool === "show_products") result.shown = count;
  }
  return result;
}

export async function cleanupOldMentions() {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  try {
    await prisma.chatProductMention.deleteMany({ where: { createdAt: { lt: cutoff } } });
  } catch (err) {
    console.error("[ChatProductMention] cleanup error:", err?.message);
  }
}

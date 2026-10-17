import prisma from "../db.server.js";
import { encrypt, decrypt } from "../utils/encryption.server.js";

const ENCRYPTED_FIELDS = ["anthropicApiKey", "yotpoApiKey", "aftershipApiKey", "klaviyoPrivateKey", "yotpoLoyaltyApiKey", "voyageApiKey", "openaiApiKey", "geminiApiKey"];

function decryptConfig(config) {
  if (!config) return config;
  const out = { ...config };
  for (const field of ENCRYPTED_FIELDS) {
    if (field in out) {
      try {
        out[field] = decrypt(out[field]);
      } catch {
        out[field] = "";
      }
    }
  }
  return out;
}

function encryptWriteData(data) {
  const out = { ...data };
  for (const field of ENCRYPTED_FIELDS) {
    if (field in out && out[field] !== undefined) {
      out[field] = encrypt(out[field]);
    }
  }
  return out;
}

export async function getShopConfig(shop) {
  let config = await prisma.shopConfig.findUnique({ where: { shop } });
  if (!config) {
    config = await prisma.shopConfig.create({ data: { shop } });
  }
  return decryptConfig(config);
}

export async function updateShopConfig(shop, data) {
  const encryptedData = encryptWriteData(data);
  const saved = await prisma.shopConfig.upsert({
    where: { shop },
    update: { ...encryptedData, updatedAt: new Date() },
    create: { shop, ...encryptedData },
  });
  return decryptConfig(saved);
}

export async function incrementRateLimitHits(shop) {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const config = await prisma.shopConfig.findUnique({ where: { shop }, select: { rateLimitHitsMonth: true } });
  if (config?.rateLimitHitsMonth === month) {
    await prisma.shopConfig.update({ where: { shop }, data: { rateLimitHits: { increment: 1 } } });
  } else {
    await prisma.shopConfig.update({ where: { shop }, data: { rateLimitHits: 1, rateLimitHitsMonth: month } });
  }
}

export async function getKnowledgeFiles(shop) {
  return prisma.knowledgeFile.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    select: { id: true, fileName: true, fileType: true, fileSize: true, createdAt: true, updatedAt: true },
  });
}

export async function getKnowledgeFilesWithContent(shop) {
  return prisma.knowledgeFile.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    select: { fileType: true, content: true },
  });
}

export async function saveKnowledgeFile(shop, { fileName, fileType, fileSize, content }) {
  const existing = await prisma.knowledgeFile.findFirst({
    where: { shop, fileType },
  });
  if (existing) {
    return prisma.knowledgeFile.update({
      where: { id: existing.id },
      data: { fileName, fileSize, content, updatedAt: new Date() },
    });
  }
  return prisma.knowledgeFile.create({
    data: { shop, fileName, fileType, fileSize, content },
  });
}

export async function deleteKnowledgeFile(shop, id) {
  return prisma.knowledgeFile.deleteMany({ where: { shop, id } });
}

export async function getKnowledgeFileForDownload(shop, id) {
  return prisma.knowledgeFile.findFirst({
    where: { shop, id },
    select: { fileName: true, fileType: true, content: true },
  });
}

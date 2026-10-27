import { useEffect, useState, useCallback, useRef } from "react";
import {
  useLoaderData,
  useActionData,
  useFetcher,
  useRevalidator,
  useNavigation,
  useSubmit,
} from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  Banner,
  Icon,
  TextField,
  Select,
  DropZone,
  Pagination,
} from "@shopify/polaris";
import { DeleteIcon, SearchIcon, GlobeIcon, NoteIcon, DiscountIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  listCampaigns,
  saveCampaign,
  deleteCampaign,
  findUnknownSkus,
  CAMPAIGN_TEMPLATE,
} from "../models/Campaign.server";
import {
  getShopConfig,
  updateShopConfig,
  getKnowledgeFiles,
  saveKnowledgeFile,
  deleteKnowledgeFile,
  getKnowledgeFileForDownload,
} from "../models/ShopConfig.server";
import prisma from "../db.server";
import { listStoreKnowledge, syncStoreKnowledgeAsync } from "../lib/store-knowledge/sync.server.js";
import { resolveShopEmbedding } from "../lib/embeddings.server";
import { rebuildChunksForFile } from "../lib/knowledge-chunks.server";
import {
  upsertEnrichmentsFromCsv,
  deleteEnrichmentsBySourceFile,
  countEnrichmentsBySourceFile,
} from "../models/ProductEnrichment.server";
import BrandHeader from "../components/BrandHeader";
import { SETTINGS_CSS, Row, Group, SectionHead } from "../components/SettingsUI";
import { checkKnowledge } from "../lib/knowledge-check.js";

function isCsv(fileName) {
  return typeof fileName === "string" && fileName.toLowerCase().endsWith(".csv");
}


export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [config, files, campaigns] = await Promise.all([
    getShopConfig(session.shop),
    getKnowledgeFiles(session.shop),
    listCampaigns(session.shop),
  ]);
  const enrichedCounts = await Promise.all(files.map((f) => countEnrichmentsBySourceFile(f.id)));
  const filesWithCounts = files.map((f, i) => ({ ...f, enrichedSkus: enrichedCounts[i] }));

  let storeKnowledge = [];
  try { storeKnowledge = await listStoreKnowledge(session.shop); }
  catch (err) { console.error("[store-knowledge] list failed:", err?.message || err); }

  // Lines in the team's notes that could steer answers wrong (keyword rules,
  // dated promotions, rules past the length limit, links to missing pages).
  // Rules files in the order the assistant reads them: newest first.
  let knowledgeCheck = { byFile: {}, counts: { critical: 0, warning: 0, notice: 0 } };
  try {
    const withContent = await prisma.knowledgeFile.findMany({
      where: { shop: session.shop },
      orderBy: { updatedAt: "desc" },
      select: { id: true, fileName: true, fileType: true, content: true },
    });
    knowledgeCheck = checkKnowledge(withContent.filter((f) => !isCsv(f.fileName)), { storeUrls: storeKnowledge.map((d) => d.url).filter(Boolean) });
  } catch (err) {
    console.error("[knowledge-check] failed:", err?.message || err);
  }

  return {
    storeKnowledge: storeKnowledge.map((d) => ({ ...d, syncedAt: d.syncedAt instanceof Date ? d.syncedAt.toISOString() : d.syncedAt })),
    files: filesWithCounts,
    knowledgeCheck,
    campaigns: campaigns.map((c) => ({
      ...c,
      startsAt: c.startsAt.toISOString(),
      endsAt: c.endsAt.toISOString(),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
    campaignTemplate: CAMPAIGN_TEMPLATE,
    campaignCheatCode: config.campaignCheatCode || "",
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "sync_store_knowledge") {
    syncStoreKnowledgeAsync({ admin, shop: session.shop });
    return { storeSyncStarted: true };
  }

  
  
  
  
  
  
  
  
  
  
  
  if (intent === "save_campaign") {
    const id = String(formData.get("id") || "").trim() || null;
    const name = String(formData.get("name") || "").trim();
    const content = String(formData.get("content") || "").trim();
    const startsAt = String(formData.get("startsAt") || "").trim();
    const endsAt = String(formData.get("endsAt") || "").trim();
    try {
      const saved = await saveCampaign(session.shop, { id, name, content, startsAt, endsAt });
      // Soft validation: flag SKU-shaped tokens that don't resolve to
      // a real product or variant in the synced catalog. Catches typos
      // like "L5OO" before they show up in customer answers. The
      // campaign is saved either way — merchant decides if the warning
      // matters (e.g. a campaign for unreleased SKUs is fine).
      const unknownSkus = await findUnknownSkus(session.shop, content);
      return { saved: true, campaignId: saved.id, unknownSkus };
    } catch (err) {
      return { error: err?.message || "Could not save campaign." };
    }
  }

  if (intent === "delete_campaign") {
    const id = String(formData.get("id") || "").trim();
    if (!id) return { error: "Missing campaign id." };
    await deleteCampaign(session.shop, id);
    return { saved: true };
  }

  if (intent === "save_campaign_cheat_code") {
    const code = String(formData.get("campaignCheatCode") || "").trim().slice(0, 80);
    await updateShopConfig(session.shop, { campaignCheatCode: code });
    return { saved: true };
  }

  
  
  
  
  
  
  
  
  
  
  if (intent === "upload") {
    const fileName = formData.get("fileName");
    const fileType = formData.get("fileType");
    const content = formData.get("content");
    const fileSize = parseInt(formData.get("fileSize"), 10);

    if (!content || !fileType) return { error: "File and type are required" };

    const MAX_FILE_BYTES = 10 * 1024 * 1024;
    if (content.length > MAX_FILE_BYTES) {
      return { error: `File too large. Max ${MAX_FILE_BYTES / 1024 / 1024}MB.` };
    }

    const saved = await saveKnowledgeFile(session.shop, { fileName, fileType, fileSize, content });
    await deleteEnrichmentsBySourceFile(session.shop, saved.id);

    let enrichmentMessage = "";
    let skuWarning = false;
    if (isCsv(fileName)) {
      const result = await upsertEnrichmentsFromCsv(session.shop, saved, content);
      if (result.noSkuColumn) {
        enrichmentMessage = " No SKU column detected — stored as raw context.";
      } else if (result.total > 0) {
        enrichmentMessage = ` Linked ${result.total} SKUs (${result.matched} matched your catalog).`;
        if (result.matched === 0) skuWarning = true;
      }
    }

    // Fire-and-forget: rebuild RAG chunks so retrieval reflects the new
    // file. Skipped silently if the shop has no embedding provider —
    // legacy full-dump path keeps working until they opt in. Don't
    // await, so the upload UX stays snappy.
    (async () => {
      try {
        const config = await getShopConfig(session.shop);
        const resolved = resolveShopEmbedding(config);
        if (!resolved) return;
        const result = await rebuildChunksForFile(prisma, {
          shop: session.shop,
          sourceFileId: saved.id,
          fileType: saved.fileType,
          content: saved.content,
          provider: resolved.provider,
          apiKey: resolved.apiKey,
        });
        console.log(`[knowledge-chunks] rebuilt for shop=${session.shop} file=${saved.id}:`, result);
      } catch (err) {
        console.error(`[knowledge-chunks] background rebuild failed for shop=${session.shop} file=${saved.id}:`, err?.message || err);
      }
    })();

    return { uploaded: true, skuWarning, message: `${fileName} uploaded successfully.${enrichmentMessage}` };
  }

  if (intent === "delete_file") {
    const fileId = String(formData.get("fileId") || "");
    if (!fileId) return { error: "fileId required" };
    await deleteEnrichmentsBySourceFile(session.shop, fileId);
    // Drop chunks before the parent file row — KnowledgeChunk has no
    // FK to KnowledgeFile (sourceFileId is a plain string), so this
    // keeps the orphan-row count at zero without a cascade.
    await prisma.knowledgeChunk.deleteMany({ where: { shop: session.shop, sourceFileId: fileId } });
    await deleteKnowledgeFile(session.shop, fileId);
    return { deleted: true };
  }

  if (intent === "download_file") {
    const fileId = String(formData.get("fileId") || "");
    if (!fileId) return { error: "fileId required" };
    const file = await getKnowledgeFileForDownload(session.shop, fileId);
    if (!file) return { error: "File not found" };
    return { download: { fileName: file.fileName, content: file.content, fileType: file.fileType } };
  }

  return { error: "unknown intent" };
};

const FILE_TYPES = [
  {
    label: "FAQs & Policies",
    value: "faqs",
    description: "Shipping, returns, warranty, common customer questions.",
    templateName: "faqs-template.txt",
    template: `RETURN POLICY
═══════════════════════════════════════
Wear your Aetrex shoes or orthotics for up to 30 days from the date your
order was received. If they are not the perfect fit, send them back through
the return portal. A $5.95 return fee is deducted from U.S. returns; final
sale items are non-refundable.

Exchanges are processed the same way — return the original, then place a
new order for the replacement.

═══════════════════════════════════════

SHIPPING
═══════════════════════════════════════
Online orders are processed and shipped within 48 hours. U.S. estimated
delivery is typically 3-7 business days from purchase date. Expedited
shipping is available at checkout.

International shipping is available to most countries. Customs and duties
are the customer's responsibility.

═══════════════════════════════════════

WARRANTY
═══════════════════════════════════════
All products carry a 1-year manufacturer warranty against defects in
materials and workmanship. Normal wear and tear is not covered.

═══════════════════════════════════════

ORDER CHANGES
═══════════════════════════════════════
Orders can be modified or cancelled within 1 hour of placement. After that,
they enter our fulfillment queue and cannot be changed.

═══════════════════════════════════════
`,
  },
  {
    label: "Rules & Guidelines",
    value: "rules",
    description: "Things the AI must always/never do — tone, routing rules, banned phrases, escalation paths.",
    templateName: "rules-template.txt",
    template: `TONE & STYLE
═══════════════════════════════════════
ALWAYS:
- Keep replies to 1-2 sentences unless answering a complex question.
- Use the customer's first name sparingly when logged in.
- Match the brand voice (warm, knowledgeable, never pushy).

NEVER:
- Invent product codes, SKUs, or model numbers.
- Claim items are out of stock without checking inventory.
- Promise specific delivery dates beyond what shipping policy states.

═══════════════════════════════════════

ROUTING RULES
═══════════════════════════════════════
Send these topics to the support team (do NOT attempt to resolve in chat):
- Returns, refunds, billing issues
- Damaged or missing items
- Account / login problems
- Order modifications past the 1-hour window

═══════════════════════════════════════

ESCALATION
═══════════════════════════════════════
If a customer is frustrated or asks for a human, share the support email
and let them know expected response time. Do not promise callbacks.

═══════════════════════════════════════
`,
  },
  {
    label: "Brand / About",
    value: "brand",
    description: "Your story, values, voice, and tone.",
    templateName: "brand-template.txt",
    template: `BRAND OVERVIEW
═══════════════════════════════════════
Brand Name: [Your Brand Name]
Founded: [Year]
Headquarters: [City, Country]

In one sentence: [What you make and who you make it for.]

═══════════════════════════════════════

OUR STORY
═══════════════════════════════════════
[2-3 sentences about how the brand started and what makes it different.
This is what the AI uses when customers ask "what's your brand about?" or
"why should I buy from you?"]

═══════════════════════════════════════

VALUES
═══════════════════════════════════════
- [Value 1, e.g. "Sustainability — every product has a take-back program."]
- [Value 2, e.g. "Quality over quantity — small batches, lifetime repairs."]
- [Value 3]

═══════════════════════════════════════

VOICE & TONE
═══════════════════════════════════════
We sound: [warm / premium / playful / technical / etc.]
We avoid: [jargon / hard-sell / hyperbole / etc.]

Example phrasing the AI can mirror:
- "[Sample sentence in your voice.]"
- "[Another sample.]"

═══════════════════════════════════════
`,
  },
  {
    label: "Product Details",
    value: "products",
    description: "Extra product info — materials, care, sizing. Include a SKU column to auto-link.",
    templateName: "product-details-template.csv",
    columns: "sku, material, care_instructions, fit_notes, weight, made_in",
    template: `sku,material,care_instructions,fit_notes,weight,made_in
"SKU-001","100% organic cotton","Machine wash cold","Runs true to size","200g","Portugal"
"SKU-002","80% wool / 20% nylon","Hand wash, lay flat","Size up for relaxed fit","420g","Italy"
`,
  },
  {
    label: "Custom Knowledge",
    value: "custom",
    description: "Anything else the AI should know — promotions, seasonal info, store policies.",
    templateName: "custom-knowledge-template.txt",
    template: `CURRENT PROMOTION
═══════════════════════════════════════
[Promotion name, e.g. "Summer Sale"]
Dates: [Start] – [End]
Mechanic: [e.g. "20% off all sandals with code SUMMER20"]
Eligibility: [Who qualifies, exclusions]

═══════════════════════════════════════

LOYALTY PROGRAM
═══════════════════════════════════════
[Name of program]
- How to join: [signup details]
- Earning: [points-per-dollar or tier rules]
- Redeeming: [what points get you]

═══════════════════════════════════════

STORE LOCATIONS
═══════════════════════════════════════
[City 1] — [Address, hours]
[City 2] — [Address, hours]

═══════════════════════════════════════

SEASONAL NOTES
═══════════════════════════════════════
[Anything time-bound that customers ask about — winter shipping delays,
holiday return-window extensions, restock schedules, etc.]

═══════════════════════════════════════
`,
  },
];


// Same look as Settings (compact cards of rows, title and help on the left,
// the action on the right), plus a few pieces of this page's own.
const KNOWLEDGE_CSS = `
  .kn .set-row__title { overflow-wrap: anywhere; }
  .kn-sec { scroll-margin-top: 16px; }
  .kn-overview { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .kn-stat { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 12px; min-width: 0; padding: 14px 16px;
    border-radius: 16px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 0 0 1px rgba(0,0,0,0.07); cursor: pointer;
    transition: box-shadow .16s ease, transform .16s ease; }
  .kn-stat:hover { box-shadow: 0 4px 14px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.08); transform: translateY(-1px); }
  .kn-stat:active { transform: none; }
  .kn-stat:focus-visible { outline: 2px solid #2D6B4F; outline-offset: 2px; }
  .kn-stat__mark { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; flex: none; background: rgba(45,107,79,0.09); }
  .kn-stat__mark .Polaris-Icon svg { fill: #2D6B4F; }
  .kn-stat__body { display: grid; gap: 1px; min-width: 0; }
  .kn-stat__label, .kn-stat__hint { font-size: 12px; line-height: 16px; color: #616161; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kn-stat__value { font-size: 17px; line-height: 22px; font-weight: 650; color: #1a1a1a; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kn-stat__hint--bad { color: #8e1f0b; font-weight: 550; }
  .kn-stat__hint--good { color: #2D6B4F; }
  .kn-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; padding: 0 16px 12px; }
  .kn-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 9px; background: rgba(26,46,38,0.06); flex: none; max-width: 100%; overflow-x: auto; scrollbar-width: none; }
  .kn-seg::-webkit-scrollbar { display: none; }
  .kn-seg__btn { all: unset; box-sizing: border-box; padding: 5px 11px; border-radius: 7px; font-size: 12.5px; line-height: 18px; font-weight: 550;
    color: #4a4a4a; white-space: nowrap; cursor: pointer; transition: background .15s ease, color .15s ease; }
  .kn-seg__btn:hover { color: #1a1a1a; }
  .kn-seg__btn[aria-pressed="true"] { background: #fff; color: #1a1a1a; font-weight: 650; box-shadow: 0 1px 2px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.05); }
  .kn-seg__btn:focus-visible { outline: 2px solid #2D6B4F; outline-offset: 1px; }
  .kn-seg__n { margin-left: 5px; color: #8a8a8a; font-weight: 500; font-variant-numeric: tabular-nums; }
  .kn-search { flex: 1 1 240px; min-width: 0; }
  .kn-docs { list-style: none; margin: 0; padding: 0; border-top: 1px solid rgba(30,27,51,0.07); }
  .kn-doc { display: grid; grid-template-columns: 58px minmax(0, 1fr) auto; align-items: center; gap: 12px; min-height: 36px; padding: 7px 16px; box-sizing: border-box; }
  .kn-doc + .kn-doc { border-top: 1px solid rgba(30,27,51,0.05); }
  .kn-doc:hover { background: rgba(26,46,38,0.025); }
  .kn-doc__title { min-width: 0; font-size: 13px; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kn .kn-doc__title a { text-decoration: none; }
  .kn .kn-doc__title a:hover { text-decoration: underline; }
  .kn-doc__size { font-size: 12px; color: #8a8a8a; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .kn-kind { justify-self: start; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 18px; font-weight: 600; white-space: nowrap; }
  .kn-kind--Policy { background: #eaf4ff; color: #00527c; }
  .kn-kind--Page { background: rgba(26,46,38,0.07); color: #4a4a4a; }
  .kn-kind--Article { background: #e6f4ec; color: #1f6b44; }
  .kn-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px 8px 16px; border-top: 1px solid rgba(30,27,51,0.07);
    font-size: 12.5px; color: #616161; font-variant-numeric: tabular-nums; }
  .kn-empty { padding: 22px 16px; border-top: 1px solid rgba(30,27,51,0.07); text-align: center; font-size: 13px; color: #616161; }
  .kn-notes { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr); gap: 16px; align-items: start; }
  .kn-good { color: #2D6B4F; font-weight: 550; white-space: nowrap; }
  .kn-finds { display: grid; gap: 8px; padding: 10px 12px; border-radius: 10px; background: rgba(26,46,38,0.035); }
  .kn-find { display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 10px; align-items: start; }
  .kn-find__line { font-size: 12.5px; line-height: 18px; font-weight: 600; color: #1a1a1a; overflow-wrap: anywhere; }
  .kn-find__msg { font-size: 12px; line-height: 17px; color: #616161; }
  .kn-tpl { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; background: rgba(26,46,38,0.035); }
  .kn-tpl__text { flex: 1; min-width: 0; }
  .kn-tpl__name { font-size: 12.5px; line-height: 18px; font-weight: 600; color: #1a1a1a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kn-tpl__hint { font-size: 12px; line-height: 17px; color: #616161; overflow-wrap: anywhere; }
  .kn-tpl__hint code { font-size: 11.5px; }
  .kn-drop .Polaris-DropZone { min-height: 0; }
  .kn-drop .Polaris-DropZone-FileUpload { padding: 16px; }
  .kn-inbanner { padding: 10px 16px 0; }
  .kn-chosen { display: flex; align-items: center; gap: 10px; padding: 14px 16px; }
  .kn-note { font-size: 12px; line-height: 17px; color: #616161; }
  .kn-pre { margin: 0; padding: 10px 12px; border-radius: 8px; background: #fff; white-space: pre-wrap; font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .kn-banner { padding: 0 16px 13px; }
  .kn-promos-body { border-top: 1px solid rgba(30,27,51,0.07); }
  .kn-promos-body > .kn-banner { padding-top: 13px; }
  @media (prefers-reduced-motion: reduce) { .kn-stat, .kn-seg__btn { transition: none; } .kn-stat:hover { transform: none; } }
  @media (max-width: 760px) {
    .kn-overview { gap: 8px; }
    .kn-stat { padding: 11px 12px; }
    .kn-stat__mark { display: none; }
    .kn-stat__value { font-size: 15px; line-height: 20px; }
    .kn-notes { grid-template-columns: minmax(0, 1fr); }
    .kn-search { flex-basis: 100%; }
  }
  @media (max-width: 560px) {
    .kn-overview { grid-template-columns: minmax(0, 1fr); }
    .kn-stat__mark { display: grid; width: 32px; height: 32px; border-radius: 9px; }
    .kn-doc { grid-template-columns: 52px minmax(0, 1fr) auto; gap: 10px; padding: 7px 14px; }
  }
`;

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// Dates read the browser's clock and time zone, so they're shown once the
// page runs in the browser (the server's render then matches the browser's).
function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
const dayLabel = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const timeLabel = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const LEVEL = {
  critical: { tone: "critical", label: "Fix" },
  warning: { tone: "warning", label: "Check" },
  notice: { tone: "info", label: "Tip" },
};

// Shown only when a line could steer answers wrong; a clean check is the
// "Check passed" badge on the Files card.
function KnowledgeCheckSummary({ counts }) {
  const c = counts || { critical: 0, warning: 0, notice: 0 };
  const n = c.critical + c.warning;
  if (n === 0) return null;
  return (
    <Banner tone={c.critical ? "critical" : "warning"} title={`Knowledge check: ${n} ${n === 1 ? "line" : "lines"} in your notes could steer answers wrong`}>
      <Text as="p" variant="bodySm">
        The usual cause is a rule keyed on words — e.g. "if the customer says boots, show boots" also fires when someone choosing an orthotic answers "boots". Write rules about what the customer wants, then upload the file again.
      </Text>
    </Banner>
  );
}

function FileFindings({ findings }) {
  const [open, setOpen] = useState(false);
  if (!findings.length) return null;
  const important = findings.filter((x) => x.level !== "notice");
  const list = open ? findings : (important.length ? important : findings).slice(0, 3);
  const hidden = findings.length - list.length;
  return (
    <div className="kn-finds">
      {list.map((x, i) => (
        <div className="kn-find" key={`${x.code}-${x.line}-${i}`}>
          <span><Badge tone={LEVEL[x.level]?.tone} size="small">{LEVEL[x.level]?.label || x.level}</Badge></span>
          <div>
            {x.line != null && <div className="kn-find__line">{`Line ${x.line}: “${x.excerpt}”`}</div>}
            <div className="kn-find__msg">{x.message}</div>
          </div>
        </div>
      ))}
      {(hidden > 0 || open) && (
        <div>
          <Button variant="plain" size="slim" onClick={() => setOpen(!open)}>
            {open ? "Show less" : `Show ${hidden} more`}
          </Button>
        </div>
      )}
    </div>
  );
}

function KnowledgeFilesCard({ files, check }) {
  const actionData = useActionData();
  const nav = useNavigation();
  const submit = useSubmit();
  const downloadFetcher = useFetcher();
  const mounted = useMounted();
  const navIntent = nav.state === "submitting" ? nav.formData?.get("intent") : null;
  const uploading = navIntent === "upload";
  const deletingId = navIntent === "delete_file" ? String(nav.formData?.get("fileId") || "") : null;

  const [selectedType, setSelectedType] = useState("faqs");
  const [uploadFile, setUploadFile] = useState(null);
  const [dismissed, setDismissed] = useState(null);

  const currentType = FILE_TYPES.find((t) => t.value === selectedType);
  // One file per category: uploading into a category that has one replaces it.
  const replaces = files.find((f) => f.fileType === selectedType);
  const issues = (check?.counts?.critical || 0) + (check?.counts?.warning || 0);

  const triggerBrowserDownload = useCallback((fileName, content) => {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const lastDownloadKey = useRef(null);
  useEffect(() => {
    const d = downloadFetcher.data?.download;
    if (d && d.fileName && typeof d.content === "string") {
      const key = `${d.fileName}:${d.content.length}`;
      if (lastDownloadKey.current !== key) {
        lastDownloadKey.current = key;
        triggerBrowserDownload(d.fileName, d.content);
      }
    }
  }, [downloadFetcher.data, triggerBrowserDownload]);

  const downloadTemplate = useCallback(() => {
    if (!currentType?.template) return;
    triggerBrowserDownload(currentType.templateName, currentType.template);
  }, [currentType, triggerBrowserDownload]);

  const handleDropAccepted = (droppedFiles) => {
    const file = droppedFiles[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setUploadFile({ name: file.name, size: file.size, content: e.target.result });
    };
    reader.readAsText(file);
  };

  const handleUpload = () => {
    if (!uploadFile) return;
    const fd = new FormData();
    fd.set("intent", "upload");
    fd.set("fileName", uploadFile.name);
    fd.set("fileType", selectedType);
    fd.set("fileSize", uploadFile.size.toString());
    fd.set("content", uploadFile.content);
    submit(fd, { method: "post" });
    setUploadFile(null);
  };

  const handleDelete = (file) => {
    if (!window.confirm(`Delete ${file.fileName}? The assistant stops using it right away.`)) return;
    const fd = new FormData();
    fd.set("intent", "delete_file");
    fd.set("fileId", file.id);
    submit(fd, { method: "post" });
  };

  const handleDownload = (fileId) => {
    const fd = new FormData();
    fd.set("intent", "download_file");
    fd.set("fileId", fileId);
    downloadFetcher.submit(fd, { method: "post" });
  };

  const isDownloadingId = downloadFetcher.state !== "idle" && downloadFetcher.formData?.get("intent") === "download_file"
    ? String(downloadFetcher.formData.get("fileId") || "")
    : null;

  // What the last upload or delete said, shown in the "Add" card.
  const notices = [
    actionData?.uploaded && dismissed !== actionData.message
      ? <Banner key="up" title={actionData.message} tone={actionData.skuWarning ? "warning" : "success"} onDismiss={() => setDismissed(actionData.message)} />
      : null,
    actionData?.error && dismissed !== actionData.error
      ? <Banner key="err" title={actionData.error} tone="critical" onDismiss={() => setDismissed(actionData.error)} />
      : null,
  ].filter(Boolean);

  return (
    <div className="kn-notes">
      <Group
        title={files.length ? `Files (${files.length})` : "Files"}
        badge={files.length > 0 ? (issues > 0 ? <Badge tone="critical">{`${issues} to check`}</Badge> : <Badge tone="success">Check passed</Badge>) : null}
      >
        {files.length > 0 && issues > 0 ? <div className="kn-inbanner"><KnowledgeCheckSummary counts={check?.counts} /></div> : null}
        {files.length === 0 ? (
          <Row help="No files yet. Pick a category, start from its template, and upload it." />
        ) : (
          files.map((f) => {
            const catLabel = FILE_TYPES.find((t) => t.value === f.fileType)?.label || f.fileType;
            const findings = check?.byFile?.[f.id] || [];
            return (
              <Row
                key={f.id}
                title={f.fileName}
                help={
                  <>
                    {catLabel} · {formatSize(f.fileSize)}{mounted ? ` · Updated ${dayLabel(f.updatedAt)}` : ""}
                    {f.enrichedSkus > 0 && <> · <span className="kn-good">{f.enrichedSkus} SKUs linked</span></>}
                  </>
                }
                control={
                  <InlineStack gap="100" blockAlign="center" wrap={false}>
                    <Button size="slim" onClick={() => handleDownload(f.id)} loading={isDownloadingId === f.id}>Download</Button>
                    <Button
                      icon={DeleteIcon}
                      tone="critical"
                      variant="plain"
                      onClick={() => handleDelete(f)}
                      loading={deletingId === f.id}
                      accessibilityLabel={`Delete ${f.fileName}`}
                    />
                  </InlineStack>
                }
              >
                {findings.length > 0 ? <FileFindings findings={findings} /> : null}
              </Row>
            );
          })
        )}
      </Group>

      <Group title="Add or replace a file">
        <Row stack>
          <BlockStack gap="300">
            {notices}
            <Select label="Category" options={FILE_TYPES.map((t) => ({ label: t.label, value: t.value }))}
              value={selectedType} onChange={setSelectedType} helpText={currentType?.description} />
            <div className="kn-tpl">
              <div className="kn-tpl__text">
                <div className="kn-tpl__name">{currentType?.templateName}</div>
                <div className="kn-tpl__hint">
                  {currentType?.columns
                    ? <>Columns: <code>{currentType.columns}</code></>
                    : "Keep the ═══ dividers — each section becomes its own piece the assistant can look up."}
                </div>
              </div>
              <Button size="slim" onClick={downloadTemplate} accessibilityLabel={`Download ${currentType?.templateName}`}>Download</Button>
            </div>
            <div className="kn-drop">
              <DropZone
                accept=".csv,.txt,text/plain,text/csv"
                type="file"
                onDropAccepted={handleDropAccepted}
                allowMultiple={false}
                customValidator={(file) => /\.(csv|txt)$/i.test(file.name)}
              >
                {uploadFile ? (
                  <div className="kn-chosen">
                    <BlockStack gap="050">
                      <Text as="p" variant="bodyMd" fontWeight="semibold" breakWord>{uploadFile.name}</Text>
                      <Text as="p" tone="subdued" variant="bodySm">{formatSize(uploadFile.size)}</Text>
                    </BlockStack>
                  </div>
                ) : (
                  <DropZone.FileUpload actionHint="A .txt or .csv file" />
                )}
              </DropZone>
            </div>
            {replaces && <div className="kn-note">{`Uploading replaces ${replaces.fileName}.`}</div>}
            {uploadFile && (
              <InlineStack gap="200">
                <Button variant="primary" onClick={handleUpload}>{`Upload as ${currentType?.label}`}</Button>
                <Button onClick={() => setUploadFile(null)}>Cancel</Button>
              </InlineStack>
            )}
            {uploading && <Text as="p" variant="bodySm" tone="subdued">Uploading…</Text>}
          </BlockStack>
        </Row>
      </Group>
    </div>
  );
}

function campaignStatus(now, startsAt, endsAt) {
  if (now < startsAt) return { label: "Scheduled", tone: "info" };
  if (now >= startsAt && now <= endsAt) return { label: "Active", tone: "success" };
  return { label: "Expired", tone: undefined };
}

function toLocalInputValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// New-campaign time defaults: start of today at 12:00 AM, end at
// 3:00 AM. Date is today; merchant changes both date and time via
// the picker. Most sales merchants line up with calendar-day
// boundaries, and a 12 AM / 3 AM default makes it obvious which
// field is which without forcing a re-pick of the time.
function localTodayAt(hour) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
}
const DEFAULT_START_VALUE = () => localTodayAt(0);
const DEFAULT_END_VALUE = () => localTodayAt(3);

// The promotions manager: rows under the "Promotions" header, inside its card.
function CampaignsCard({ initial, template, initialCheatCode }) {
  const fetcher = useFetcher();
  const cheatFetcher = useFetcher();
  const mounted = useMounted();
  const [campaigns, setCampaigns] = useState(initial || []);
  const [editingId, setEditingId] = useState(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [startsAt, setStartsAt] = useState(DEFAULT_START_VALUE);
  const [endsAt, setEndsAt] = useState(DEFAULT_END_VALUE);
  const [showTemplate, setShowTemplate] = useState(false);
  const [error, setError] = useState("");
  const [unknownSkus, setUnknownSkus] = useState([]);
  const [cheatCode, setCheatCode] = useState(initialCheatCode || "");
  const [cheatSavedNote, setCheatSavedNote] = useState("");

  // Re-sync local state when the loader returns new data after a save/delete.
  useEffect(() => { setCampaigns(initial || []); }, [initial]);
  useEffect(() => { setCheatCode(initialCheatCode || ""); }, [initialCheatCode]);

  useEffect(() => {
    if (cheatFetcher.data?.saved) {
      setCheatSavedNote("Saved.");
      const t = setTimeout(() => setCheatSavedNote(""), 2500);
      return () => clearTimeout(t);
    }
  }, [cheatFetcher.data]);

  useEffect(() => {
    if (fetcher.data?.error) setError(fetcher.data.error);
    if (fetcher.data?.saved) {
      setError("");
      setUnknownSkus(Array.isArray(fetcher.data.unknownSkus) ? fetcher.data.unknownSkus : []);
      setEditingId(null);
      setName(""); setContent(""); setStartsAt(DEFAULT_START_VALUE()); setEndsAt(DEFAULT_END_VALUE());
    }
  }, [fetcher.data]);

  const reset = () => {
    setEditingId(null);
    setName(""); setContent(""); setStartsAt(DEFAULT_START_VALUE()); setEndsAt(DEFAULT_END_VALUE());
    setError("");
  };

  const startEdit = (c) => {
    setEditingId(c.id);
    setName(c.name);
    setContent(c.content);
    setStartsAt(toLocalInputValue(c.startsAt));
    setEndsAt(toLocalInputValue(c.endsAt));
    setError("");
  };

  const submit = () => {
    setError("");
    const fd = new FormData();
    fd.set("intent", "save_campaign");
    if (editingId) fd.set("id", editingId);
    fd.set("name", name.trim());
    fd.set("content", content.trim());
    fd.set("startsAt", new Date(startsAt).toISOString());
    fd.set("endsAt", new Date(endsAt).toISOString());
    fetcher.submit(fd, { method: "post" });
  };

  const remove = (id) => {
    if (!window.confirm("Delete this campaign? This cannot be undone.")) return;
    const fd = new FormData();
    fd.set("intent", "delete_campaign");
    fd.set("id", id);
    fetcher.submit(fd, { method: "post" });
  };

  const copyTemplate = () => {
    setContent(template || "");
    setShowTemplate(false);
  };

  const saveCheatCode = () => {
    const fd = new FormData();
    fd.set("intent", "save_campaign_cheat_code");
    fd.set("campaignCheatCode", cheatCode.trim());
    cheatFetcher.submit(fd, { method: "post" });
  };
  const cheatSubmitting = cheatFetcher.state !== "idle";

  const now = new Date();
  const submitting = fetcher.state !== "idle";
  const validForm = name.trim() && content.trim() && startsAt && endsAt && new Date(endsAt) > new Date(startsAt);

  return (
    <>
      {error || unknownSkus.length > 0 ? (
        <div className="kn-banner">
          <BlockStack gap="200">
            {error ? <Banner tone="critical">{error}</Banner> : null}
            {unknownSkus.length > 0 ? (
              <Banner tone="warning" onDismiss={() => setUnknownSkus([])} title={`${unknownSkus.length} SKU${unknownSkus.length === 1 ? "" : "s"} not found in your catalog`}>
                <Text as="p" variant="bodySm">
                  Saved. The campaign content references these SKU-shaped values that don't match any synced product or variant: <strong>{unknownSkus.join(", ")}</strong>. Verify these are correct (a typo like "L5OO" with the letter O instead of zero is a common one) or re-sync your catalog if these are new.
                </Text>
              </Banner>
            ) : null}
          </BlockStack>
        </div>
      ) : null}

      <Row
        title="CS team cheat code"
        help="Typed as a whole message in the chat (any capitals), it lists every live promotion in one reply — the same for everyone, no AI. Pick something a shopper would never type. Blank turns it off."
      >
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <div style={{ flex: "1 1 auto", maxWidth: 320, minWidth: 0 }}>
            <TextField label="Cheat code" labelHidden value={cheatCode} onChange={setCheatCode} placeholder="seos-show-campaigns" autoComplete="off" />
          </div>
          <Button onClick={saveCheatCode} loading={cheatSubmitting} disabled={cheatSubmitting}>Save</Button>
          {cheatSavedNote ? <Text as="span" tone="success" variant="bodySm">{cheatSavedNote}</Text> : null}
        </InlineStack>
      </Row>

      {campaigns.length > 0 ? (
        campaigns.map((c) => {
          const startDate = new Date(c.startsAt);
          const endDate = new Date(c.endsAt);
          const status = campaignStatus(now, startDate, endDate);
          return (
            <Row
              key={c.id}
              title={<InlineStack gap="200" blockAlign="center"><span>{c.name}</span><Badge tone={status.tone} size="small">{status.label}</Badge></InlineStack>}
              help={mounted ? `${timeLabel(c.startsAt)} → ${timeLabel(c.endsAt)}` : " "}
              control={
                <InlineStack gap="100" blockAlign="center" wrap={false}>
                  <Button size="slim" onClick={() => startEdit(c)} disabled={submitting}>Edit</Button>
                  <Button size="slim" tone="critical" variant="plain" onClick={() => remove(c.id)} disabled={submitting}>Delete</Button>
                </InlineStack>
              }
            />
          );
        })
      ) : (
        <Row help="No promotions yet. Add one below — the assistant starts mentioning it when its start time arrives." />
      )}

      <Row
        stack
        title={editingId ? "Edit promotion" : "Add a promotion"}
        help="Keep it short — bullet points and codes beat prose. Live promotions are part of every chat, so aim for under ~500 characters each."
      >
        <BlockStack gap="300">
          {showTemplate ? (
            <div className="kn-finds">
              <pre className="kn-pre">{template}</pre>
              <InlineStack gap="200">
                <Button size="slim" onClick={copyTemplate}>Use this template</Button>
                <Button size="slim" variant="plain" onClick={() => setShowTemplate(false)}>Close</Button>
              </InlineStack>
            </div>
          ) : null}
          <div className="set-grid set-grid--3">
            <TextField label="Name" value={name} onChange={setName} placeholder="Summer Sale 2026" autoComplete="off" helpText="Only you see this." />
            <TextField label="Starts" type="datetime-local" value={startsAt} onChange={setStartsAt} autoComplete="off" helpText="Your local time." />
            <TextField label="Ends" type="datetime-local" value={endsAt} onChange={setEndsAt} autoComplete="off" helpText="Must be after the start." />
          </div>
          <TextField
            label="What the assistant should know"
            labelAction={{ content: showTemplate ? "Hide template" : "Show template", onAction: () => setShowTemplate((v) => !v) }}
            value={content}
            onChange={setContent}
            multiline={5}
            autoComplete="off"
            helpText="Plain text or markdown. The assistant quotes from this when shoppers ask about the sale, codes or terms — no internal-only notes."
          />
          <InlineStack gap="200">
            <Button variant="primary" onClick={submit} disabled={!validForm || submitting} loading={submitting}>
              {editingId ? "Save changes" : "Add promotion"}
            </Button>
            {editingId ? <Button onClick={reset} disabled={submitting}>Cancel</Button> : null}
          </InlineStack>
        </BlockStack>
      </Row>
    </>
  );
}

const KIND_LABEL = { Policy: "Policy", Page: "Page", Article: "Blog" };

function StoreKnowledgeCard({ docs }) {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const mounted = useMounted();
  const started = fetcher.data?.storeSyncStarted;
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (!started) return;
    const t = setTimeout(() => revalidator.revalidate(), 45000);
    return () => clearTimeout(t);
  }, [started]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => {
    const fd = new FormData();
    fd.set("intent", "sync_store_knowledge");
    fetcher.submit(fd, { method: "post" });
  };
  const last = docs.reduce((m, d) => (d.syncedAt && (!m || d.syncedAt > m) ? d.syncedAt : m), null);
  const count = (kind) => docs.filter((d) => d.kind === kind).length;
  // One type at a time, searchable, 10 per page — 400+ documents don't scroll forever.
  const tabs = [
    { id: "all", label: "All", n: docs.length },
    { id: "Page", label: "Pages", n: count("Page") },
    { id: "Article", label: "Blog", n: count("Article") },
    { id: "Policy", label: "Policies", n: count("Policy") },
  ];
  const [tab, setTab] = useState(0);
  const [query, setQuery] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const PER_PAGE = 10;
  const kind = tabs[tab].id;
  const q = query.trim().toLowerCase();
  const filtered = docs.filter((d) => (kind === "all" || d.kind === kind) && (!q || `${d.title} ${d.url}`.toLowerCase().includes(q)));
  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const at = Math.min(pageIndex, pages - 1);
  const shown = filtered.slice(at * PER_PAGE, at * PER_PAGE + PER_PAGE);
  const breakdown = [plural(count("Policy"), "policy", "policies"), plural(count("Page"), "page", "pages"), plural(count("Article"), "blog article", "blog articles")].join(" · ");
  return (
    <Card padding="0">
      <Row
        title={docs.length > 0 ? `${docs.length} documents learned` : "Nothing learned yet"}
        help={docs.length > 0
          ? `${breakdown}${last && mounted ? ` · Refreshed ${timeLabel(last)}` : ""}`
          : "Refresh to read your store's policies, pages and blog articles now."}
        control={<Button onClick={refresh} loading={busy} disabled={busy}>Refresh now</Button>}
      >
        {started ? (
          <Banner tone="info"><p>Reading your store's policies, pages and blog articles — this takes a minute or two. The list updates automatically.</p></Banner>
        ) : null}
      </Row>
      {docs.length > 0 && (
        <>
          <div className="kn-tools">
            <div className="kn-seg" role="group" aria-label="Show">
              {tabs.map((t, i) => (
                <button key={t.id} type="button" className="kn-seg__btn" aria-pressed={tab === i} onClick={() => { setTab(i); setPageIndex(0); }}>
                  {t.label}<span className="kn-seg__n">{t.n}</span>
                </button>
              ))}
            </div>
            <div className="kn-search">
              <TextField
                label="Search what was learned"
                labelHidden
                size="slim"
                prefix={<Icon source={SearchIcon} tone="subdued" />}
                placeholder="Search titles, e.g. clinical"
                value={query}
                onChange={(v) => { setQuery(v); setPageIndex(0); }}
                clearButton
                onClearButtonClick={() => { setQuery(""); setPageIndex(0); }}
                autoComplete="off"
              />
            </div>
          </div>
          {shown.length > 0 ? (
            <ul className="kn-docs">
              {shown.map((d) => (
                <li key={d.id} className="kn-doc">
                  <span className={`kn-kind kn-kind--${d.kind}`}>{KIND_LABEL[d.kind] || d.kind}</span>
                  <span className="kn-doc__title">
                    {d.url ? <a href={d.url} target="_blank" rel="noreferrer" title={d.title}>{d.title}</a> : d.title}
                  </span>
                  <span className="kn-doc__size">{`${Math.max(1, Math.round(d.chars / 1000))}k chars`}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="kn-empty">{q ? `Nothing matches “${query.trim()}”.` : "None of these yet."}</div>
          )}
          {filtered.length > PER_PAGE && (
            <div className="kn-foot">
              <span>{at * PER_PAGE + 1}–{Math.min(filtered.length, (at + 1) * PER_PAGE)} of {filtered.length}</span>
              <Pagination
                hasPrevious={at > 0}
                onPrevious={() => setPageIndex(at - 1)}
                hasNext={at < pages - 1}
                onNext={() => setPageIndex(at + 1)}
              />
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export default function Knowledge() {
  const data = useLoaderData();
  const mounted = useMounted();
  const [promosOpen, setPromosOpen] = useState(false);
  const now = Date.now();
  const campaigns = data.campaigns || [];
  const livePromos = campaigns.filter((c) => new Date(c.startsAt).getTime() <= now && new Date(c.endsAt).getTime() >= now).length;
  const scheduledPromos = campaigns.filter((c) => new Date(c.startsAt).getTime() > now).length;
  const docs = data.storeKnowledge || [];
  const files = data.files || [];
  const issues = (data.knowledgeCheck?.counts?.critical || 0) + (data.knowledgeCheck?.counts?.warning || 0);
  const lastRead = docs.reduce((m, d) => (d.syncedAt && (!m || d.syncedAt > m) ? d.syncedAt : m), null);

  const overview = [
    {
      id: "website", icon: GlobeIcon, label: "From your website",
      value: plural(docs.length, "document", "documents"),
      hint: docs.length === 0 ? "Not read yet" : lastRead && mounted ? `Refreshed ${timeLabel(lastRead)}` : "Pages, policies & blog",
    },
    {
      id: "notes", icon: NoteIcon, label: "Your team's notes",
      value: plural(files.length, "file", "files"),
      hint: files.length === 0 ? "None yet" : issues > 0 ? `${plural(issues, "line", "lines")} to check` : "Check passed",
      tone: files.length === 0 ? null : issues > 0 ? "bad" : "good",
    },
    {
      id: "promos", icon: DiscountIcon, label: "Promotions",
      value: livePromos ? `${livePromos} live` : "None live",
      hint: scheduledPromos ? `${scheduledPromos} scheduled` : "Optional",
    },
  ];
  const go = (id) => {
    if (id === "promos") setPromosOpen(true);
    const el = document.getElementById(`kn-${id}`);
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" }));
  };

  return (
    <Page>
      <TitleBar title="Knowledge" />
      {/* Static CSS, injected as-is: as a text child React would escape its
          quotes on the server and the page wouldn't hydrate. */}
      <style dangerouslySetInnerHTML={{ __html: SETTINGS_CSS + KNOWLEDGE_CSS }} />
      <div className="kn set-links">
        <BlockStack gap="600">
          <BrandHeader title="Knowledge" gutter={false} />

          <section>
            <SectionHead title="What your assistant knows">
              Three sources. When they disagree, your team's notes win, then live promotions, then your website.
            </SectionHead>
            <div className="kn-overview">
              {overview.map((s) => (
                <button key={s.id} type="button" className="kn-stat" onClick={() => go(s.id)}>
                  <span className="kn-stat__mark" aria-hidden="true"><Icon source={s.icon} /></span>
                  <span className="kn-stat__body">
                    <span className="kn-stat__label">{s.label}</span>
                    <span className="kn-stat__value">{s.value}</span>
                    <span className={`kn-stat__hint${s.tone ? ` kn-stat__hint--${s.tone}` : ""}`}>{s.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section id="kn-website" className="kn-sec">
            <SectionHead title="Learned from your website">
              Policies, pages (FAQs, size guides, clinical studies, technology…) and blog articles — read automatically after every product sync and nightly. Nothing to upload.
            </SectionHead>
            <StoreKnowledgeCard docs={docs} />
          </section>

          <section id="kn-notes" className="kn-sec">
            <SectionHead title="Your team's notes">
              What the website doesn't say, or says differently — FAQs, sizing advice, brand voice. The assistant looks things up here, and these notes win over the website. A Rules &amp; Guidelines file is followed on every chat.
            </SectionHead>
            <KnowledgeFilesCard files={files} check={data.knowledgeCheck} />
          </section>

          <section id="kn-promos" className="kn-sec">
            <Card padding="0">
              <Row
                title={<InlineStack gap="200" blockAlign="center"><span>Promotions</span><Badge tone={livePromos ? "success" : undefined}>{livePromos ? `${livePromos} live` : "None live"}</Badge></InlineStack>}
                help="Dated sales the assistant mentions only while they're live. Your offers page in Settings → Shopping tools usually covers this."
                control={
                  <Button onClick={() => setPromosOpen((o) => !o)} disclosure={promosOpen ? "up" : "down"} ariaExpanded={promosOpen} ariaControls="kn-promos-body">
                    {promosOpen ? "Hide" : "Show"}
                  </Button>
                }
              />
              <div id="kn-promos-body" className="kn-promos-body" hidden={!promosOpen}>
                <CampaignsCard initial={data.campaigns} template={data.campaignTemplate} initialCheatCode={data.campaignCheatCode} />
              </div>
            </Card>
          </section>
        </BlockStack>
      </div>
    </Page>
  );
}

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
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  Banner,
  Box,
  Divider,
  FormLayout,
  TextField,
  Select,
  DataTable,
  DropZone,
  EmptyState,
  Tabs,
  Pagination,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
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


function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}


const LEVEL = {
  critical: { tone: "critical", label: "Fix" },
  warning: { tone: "warning", label: "Check" },
  notice: { tone: "info", label: "Tip" },
};

function KnowledgeCheckSummary({ counts }) {
  const c = counts || { critical: 0, warning: 0, notice: 0 };
  if (c.critical + c.warning === 0) {
    return (
      <Banner tone="success" title="Knowledge check: nothing in your notes looks likely to steer answers wrong.">
        {c.notice > 0 && <Text as="p" variant="bodySm">{c.notice} small {c.notice === 1 ? "tip" : "tips"} below.</Text>}
      </Banner>
    );
  }
  const n = c.critical + c.warning;
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
    <BlockStack gap="150">
      <Divider />
      {list.map((x, i) => (
        <InlineStack key={`${x.code}-${x.line}-${i}`} gap="200" wrap={false} blockAlign="start">
          <Box minWidth="44px"><Badge tone={LEVEL[x.level]?.tone}>{LEVEL[x.level]?.label || x.level}</Badge></Box>
          <BlockStack gap="050">
            {x.line != null && (
              <Text as="p" variant="bodySm" fontWeight="semibold" breakWord>{`Line ${x.line}: “${x.excerpt}”`}</Text>
            )}
            <Text as="p" variant="bodySm" tone="subdued">{x.message}</Text>
          </BlockStack>
        </InlineStack>
      ))}
      {(hidden > 0 || open) && (
        <InlineStack>
          <Button variant="plain" size="slim" onClick={() => setOpen(!open)}>
            {open ? "Show less" : `Show ${hidden} more`}
          </Button>
        </InlineStack>
      )}
    </BlockStack>
  );
}

function KnowledgeFilesCard({ files, check }) {
  const actionData = useActionData();
  const nav = useNavigation();
  const submit = useSubmit();
  const downloadFetcher = useFetcher();
  const saving = nav.state === "submitting" &&
    (nav.formData?.get("intent") === "upload" || nav.formData?.get("intent") === "delete_file");

  const [selectedType, setSelectedType] = useState("faqs");
  const [uploadFile, setUploadFile] = useState(null);
  const [dismissed, setDismissed] = useState(null);

  const currentType = FILE_TYPES.find((t) => t.value === selectedType);

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

  const handleDelete = (fileId) => {
    const fd = new FormData();
    fd.set("intent", "delete_file");
    fd.set("fileId", fileId);
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

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Your team's notes</Text>
          </InlineStack>
          <Text as="p" tone="subdued">
            Anything the website doesn't say, or says differently — FAQs, sizing advice, brand voice. The assistant looks things up here when customers ask, and these notes win over the website.
            A <strong>Rules &amp; Guidelines</strong> file is different: the assistant follows it on every chat (e.g. "never promise delivery dates"). One file per category; uploading again replaces it.
          </Text>
        </BlockStack>


        {files.length > 0 && <KnowledgeCheckSummary counts={check?.counts} />}

        {actionData?.uploaded && dismissed !== actionData.message && (
          <Banner title={actionData.message} tone={actionData.skuWarning ? "warning" : "success"} onDismiss={() => setDismissed(actionData.message)} />
        )}
        {actionData?.error && dismissed !== actionData.error && (
          <Banner title={actionData.error} tone="critical" onDismiss={() => setDismissed(actionData.error)} />
        )}

        <Layout>
          <Layout.Section variant="oneHalf">
            <BlockStack gap="300">
              <Select label="Category" options={FILE_TYPES.map((t) => ({ label: t.label, value: t.value }))}
                value={selectedType} onChange={setSelectedType} helpText={currentType?.description} />
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodySm" fontWeight="semibold">Template: {currentType?.templateName}</Text>
                    <Button size="slim" onClick={downloadTemplate}>Download</Button>
                  </InlineStack>
                  {currentType?.columns && <Text as="p" tone="subdued" variant="bodySm">Columns: <code>{currentType.columns}</code></Text>}
                  {!currentType?.columns && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Sections are separated by <code>═══</code> dividers. Keep this format — when RAG is on, each section becomes a retrievable chunk, so a clean divider = a focused chunk the AI can pull on demand.
                    </Text>
                  )}
                </BlockStack>
              </Box>
              <DropZone
                accept=".csv,.txt,text/plain,text/csv"
                type="file"
                onDropAccepted={handleDropAccepted}
                allowMultiple={false}
                customValidator={(file) => /\.(csv|txt)$/i.test(file.name)}
              >
                {uploadFile ? (
                  <Box padding="400">
                    <BlockStack gap="050">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">{uploadFile.name}</Text>
                      <Text as="p" tone="subdued" variant="bodySm">{formatSize(uploadFile.size)}</Text>
                    </BlockStack>
                  </Box>
                ) : (
                  <DropZone.FileUpload actionHint="Accepts .csv and .txt files" />
                )}
              </DropZone>
              {uploadFile && (
                <InlineStack gap="300">
                  <Button variant="primary" onClick={handleUpload} loading={saving}>Upload as {currentType?.label}</Button>
                  <Button onClick={() => setUploadFile(null)}>Cancel</Button>
                </InlineStack>
              )}
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            {files.length === 0 ? (
              <EmptyState heading="No knowledge files yet" image="">
                <Text as="p" tone="subdued">Upload a CSV or text file to enrich the AI with store-specific context.</Text>
              </EmptyState>
            ) : (
              <BlockStack gap="200">
                {files.map((f) => {
                  const catLabel = FILE_TYPES.find((t) => t.value === f.fileType)?.label || f.fileType;
                  return (
                    <Box key={f.id} padding="300" background="bg-surface-secondary" borderRadius="200">
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center" wrap gap="200">
                          <BlockStack gap="050">
                            <Text as="span" variant="bodyMd" fontWeight="semibold" breakWord>{f.fileName}</Text>
                            <InlineStack gap="200" blockAlign="center" wrap>
                              <Badge>{catLabel}</Badge>
                              <Text as="span" tone="subdued" variant="bodySm">{formatSize(f.fileSize)}</Text>
                              <Text as="span" tone="subdued" variant="bodySm">· Updated {new Date(f.updatedAt).toLocaleDateString()}</Text>
                              {f.enrichedSkus > 0 && <Badge tone="success">{`${f.enrichedSkus} SKUs linked`}</Badge>}
                            </InlineStack>
                          </BlockStack>
                          <InlineStack gap="200" blockAlign="center">
                            <Button
                              size="slim"
                              onClick={() => handleDownload(f.id)}
                              loading={isDownloadingId === f.id}
                            >
                              Download
                            </Button>
                            <Button
                              icon={DeleteIcon}
                              tone="critical"
                              variant="plain"
                              onClick={() => handleDelete(f.id)}
                              accessibilityLabel="Delete file"
                            />
                          </InlineStack>
                        </InlineStack>
                        <FileFindings findings={check?.byFile?.[f.id] || []} />
                      </BlockStack>
                    </Box>
                  );
                })}
              </BlockStack>
            )}
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Card>
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

function CampaignsCard({ initial, template, initialCheatCode }) {
  const fetcher = useFetcher();
  const cheatFetcher = useFetcher();
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
    setName(""); setContent(""); setStartsAt(""); setEndsAt("");
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
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Active promotions</Text>
            <Badge tone="info">Auto-expires by date</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            Schedule each campaign with start and end dates and times. Only campaigns currently within their window appear in the chat — expired ones disappear automatically with no manual cleanup.
          </Text>
        </BlockStack>

        {error ? <Banner tone="critical">{error}</Banner> : null}

        {unknownSkus.length > 0 ? (
          <Banner tone="warning" onDismiss={() => setUnknownSkus([])} title={`${unknownSkus.length} SKU${unknownSkus.length === 1 ? "" : "s"} not found in your catalog`}>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm">
                Saved. The campaign content references these SKU-shaped values that don't match any synced product or variant: <strong>{unknownSkus.join(", ")}</strong>. Verify these are correct (a typo like "L5OO" with the letter O instead of zero is a common one) or re-sync your catalog if these are new.
              </Text>
            </BlockStack>
          </Banner>
        ) : null}

        <Box padding="300" background="bg-surface-secondary" borderRadius="200">
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingSm">CS team cheat code</Text>
              <Badge tone="info">Optional</Badge>
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">
              Set a phrase that, when typed in the chat, returns every currently-active campaign in one reply. Bypasses the AI for determinism — your CS team always sees the exact same dump. Leave blank to disable. Pick something a regular customer would never type by accident.
            </Text>
            <FormLayout>
              <FormLayout.Group>
                <TextField
                  label="Cheat code"
                  value={cheatCode}
                  onChange={setCheatCode}
                  placeholder="seos-show-campaigns"
                  autoComplete="off"
                  helpText="Case-insensitive exact match on the customer's whole message."
                />
                <Box paddingBlockStart="600">
                  <InlineStack gap="200" blockAlign="center">
                    <Button onClick={saveCheatCode} loading={cheatSubmitting} disabled={cheatSubmitting}>Save</Button>
                    {cheatSavedNote ? <Text as="span" tone="success" variant="bodySm">{cheatSavedNote}</Text> : null}
                  </InlineStack>
                </Box>
              </FormLayout.Group>
            </FormLayout>
          </BlockStack>
        </Box>

        {campaigns.length > 0 ? (
          <BlockStack gap="200">
            {campaigns.map((c) => {
              const startDate = new Date(c.startsAt);
              const endDate = new Date(c.endsAt);
              const status = campaignStatus(now, startDate, endDate);
              return (
                <Box key={c.id} padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center" wrap>
                      <InlineStack gap="200" blockAlign="center" wrap>
                        <Badge tone={status.tone}>{status.label}</Badge>
                        <Text as="span" variant="headingSm">{c.name}</Text>
                      </InlineStack>
                      <InlineStack gap="100">
                        <Button size="slim" onClick={() => startEdit(c)} disabled={submitting}>Edit</Button>
                        <Button size="slim" tone="critical" variant="plain" onClick={() => remove(c.id)} disabled={submitting}>Delete</Button>
                      </InlineStack>
                    </InlineStack>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {startDate.toLocaleString()} → {endDate.toLocaleString()}
                    </Text>
                  </BlockStack>
                </Box>
              );
            })}
          </BlockStack>
        ) : (
          <Banner tone="info">No campaigns yet. Add one below — the chat starts answering questions about it the moment its start time arrives.</Banner>
        )}

        <Divider />

        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center" wrap>
            <Text as="h3" variant="headingSm">{editingId ? "Edit campaign" : "Add a campaign"}</Text>
            <Button variant="plain" onClick={() => setShowTemplate((v) => !v)}>
              {showTemplate ? "Hide template" : "Show template"}
            </Button>
          </InlineStack>

          {showTemplate ? (
            <Box padding="300" background="bg-surface-secondary" borderRadius="200">
              <BlockStack gap="200">
                <Text as="p" tone="subdued" variant="bodySm">
                  Copy this template into the campaign content field below as a starting structure, then fill in the bracketed placeholders with your actual sale details.
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  <strong>Keep it tight.</strong> Every character of campaign content lands in every chat prompt while the campaign is live — bullet points beat prose, and short codes/dates are better than full sentences. Aim for under ~500 characters (~100 words) per campaign so multiple promos can run together without crowding the AI's working memory. The progress bar at the top of this page tracks the combined size.
                </Text>
                <Box padding="200" background="bg-surface" borderRadius="100">
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{template}</pre>
                </Box>
                <InlineStack>
                  <Button onClick={copyTemplate}>Use this template</Button>
                </InlineStack>
              </BlockStack>
            </Box>
          ) : null}

          <FormLayout>
            <TextField
              label="Campaign name"
              value={name}
              onChange={setName}
              placeholder="Summer Sale 2026"
              autoComplete="off"
              helpText="Internal label only — customers don't see this."
            />
            <FormLayout.Group>
              <TextField
                label="Starts at"
                type="datetime-local"
                value={startsAt}
                onChange={setStartsAt}
                autoComplete="off"
                helpText="Local time of the merchant. The chat starts mentioning this campaign at this moment."
              />
              <TextField
                label="Ends at"
                type="datetime-local"
                value={endsAt}
                onChange={setEndsAt}
                autoComplete="off"
                helpText="The chat stops mentioning this campaign at this moment. Must be after the start."
              />
            </FormLayout.Group>
            <TextField
              label="Campaign content"
              value={content}
              onChange={setContent}
              multiline={10}
              autoComplete="off"
              helpText="Plain text or markdown. The AI quotes from this when customers ask about the sale, codes, or terms. Don't paste internal-only notes."
            />
            <InlineStack gap="200">
              <Button variant="primary" onClick={submit} disabled={!validForm || submitting} loading={submitting}>
                {editingId ? "Save changes" : "Add campaign"}
              </Button>
              {editingId ? <Button onClick={reset} disabled={submitting}>Cancel</Button> : null}
            </InlineStack>
          </FormLayout>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}






function SectionHeading({ eyebrow, title, description }) {
  return (
    <BlockStack gap="100">
      {eyebrow && (
        <Text as="p" variant="bodySm" tone="subdued" fontWeight="semibold">
          {eyebrow.toUpperCase()}
        </Text>
      )}
      <Text as="h2" variant="headingLg">{title}</Text>
      {description && <Text as="p" tone="subdued">{description}</Text>}
    </BlockStack>
  );
}


function StoreKnowledgeCard({ docs }) {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
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
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // One type at a time, searchable, 10 per page — 400+ documents don't scroll forever.
  const tabs = [
    { id: "all", content: `All (${docs.length})` },
    { id: "Page", content: `Pages (${count("Page")})` },
    { id: "Article", content: `Blog articles (${count("Article")})` },
    { id: "Policy", content: `Policies (${count("Policy")})` },
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
  const KIND_TONE = { Policy: "info", Page: undefined, Article: "success" };
  const rows = shown.map((d) => [
    <Badge key={`${d.id}-k`} tone={KIND_TONE[d.kind]}>{d.kind === "Article" ? "Blog" : d.kind}</Badge>,
    d.url ? <a key={d.id} href={d.url} target="_blank" rel="noreferrer">{d.title}</a> : d.title,
    `${Math.max(1, Math.round(d.chars / 1000))}k chars`,
  ]);
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="050">
            <Text as="h2" variant="headingMd">
              {docs.length > 0
                ? `${docs.length} documents learned (${plural(count("Policy"), "policy", "policies")}, ${plural(count("Page"), "page", "pages")}, ${plural(count("Article"), "blog article", "blog articles")})`
                : "Nothing learned yet"}
            </Text>
            <Text as="p" tone="subdued" variant="bodySm">
              {last ? `Last refreshed ${new Date(last).toLocaleString()}` : "Click refresh to read your store's policies, pages and blog articles now."}
            </Text>
          </BlockStack>
          <Button onClick={refresh} loading={busy} disabled={busy}>Refresh from store now</Button>
        </InlineStack>
        {started && (
          <Banner tone="info"><p>Reading your store's policies, pages and blog articles — this takes a minute or two. The list updates automatically.</p></Banner>
        )}
        {docs.length > 0 && (
          <BlockStack gap="300">
            <Tabs tabs={tabs} selected={tab} onSelect={(i) => { setTab(i); setPageIndex(0); }} fitted />
            <TextField
              label="Search what was learned"
              labelHidden
              placeholder="Search titles — e.g. clinical, plantar fasciitis, returns"
              value={query}
              onChange={(v) => { setQuery(v); setPageIndex(0); }}
              clearButton
              onClearButtonClick={() => { setQuery(""); setPageIndex(0); }}
              autoComplete="off"
            />
            {rows.length > 0 ? (
              <DataTable columnContentTypes={["text", "text", "text"]} headings={["Type", "Title", "Size"]} rows={rows} />
            ) : (
              <Box padding="400"><Text as="p" tone="subdued" alignment="center">Nothing matches "{query}".</Text></Box>
            )}
            {filtered.length > PER_PAGE && (
              <InlineStack align="space-between" blockAlign="center">
                <Text as="p" tone="subdued" variant="bodySm">
                  {at * PER_PAGE + 1}–{Math.min(filtered.length, (at + 1) * PER_PAGE)} of {filtered.length}
                </Text>
                <Pagination
                  hasPrevious={at > 0}
                  onPrevious={() => setPageIndex(at - 1)}
                  hasNext={at < pages - 1}
                  onNext={() => setPageIndex(at + 1)}
                />
              </InlineStack>
            )}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

export default function Knowledge() {
  const data = useLoaderData();
  const now = Date.now();
  const livePromos = (data.campaigns || []).filter((c) => new Date(c.startsAt).getTime() <= now && new Date(c.endsAt).getTime() >= now).length;
  const summary = [
    { label: "From your website", value: `${(data.storeKnowledge || []).length} pages, policies & articles` },
    { label: "Your team's notes", value: `${(data.files || []).length} file${(data.files || []).length === 1 ? "" : "s"}` },
    { label: "Promotions", value: livePromos ? `${livePromos} live now` : "none live" },
  ];

  return (
    <Page>
      <TitleBar title="Knowledge" />
      <BrandHeader title="Knowledge" />
      <BlockStack gap="800">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">What your assistant knows about your store</Text>
            <InlineStack gap="800" wrap>
              {summary.map((s) => (
                <BlockStack key={s.label} gap="050">
                  <Text as="span" variant="bodySm" tone="subdued">{s.label}</Text>
                  <Text as="span" variant="headingMd">{s.value}</Text>
                </BlockStack>
              ))}
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">
              If two sources disagree, the assistant trusts your team's notes first, then live promotions, then your website.
            </Text>
          </BlockStack>
        </Card>

        <BlockStack gap="400">
          <SectionHeading
            title="Learned from your website"
            description="Everything your store publishes — policies, pages (FAQs, size guides, clinical studies, technology…) and blog articles — is read automatically after every product sync and nightly. Nothing to upload."
          />
          <StoreKnowledgeCard docs={data.storeKnowledge || []} />
        </BlockStack>

        <BlockStack gap="400">
          <SectionHeading
            title="Your team's notes"
            description="Add what isn't on the website, or correct what is."
          />
          <KnowledgeFilesCard files={data.files} check={data.knowledgeCheck} />
        </BlockStack>

        <BlockStack gap="400">
          <SectionHeading
            title="Promotions"
            description="Add a sale with start and end dates. The assistant only mentions what's live right now; ended promotions disappear on their own. It can also read your offers from a page on your site: Settings → Promotions page."
          />
          <CampaignsCard initial={data.campaigns} template={data.campaignTemplate} initialCheatCode={data.campaignCheatCode} />
        </BlockStack>
      </BlockStack>
    </Page>
  );
}

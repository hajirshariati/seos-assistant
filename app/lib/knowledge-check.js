// Knowledge check — flags lines in the store team's uploaded notes that can
// steer the assistant wrong, so the merchant sees them on the Knowledge page
// before customers do. It reads the text only; it never changes a file.
//
// The patterns come from real failures: a rule keyed on words ("if the
// customer says boots, show boots") fired mid-way through an orthotic chat,
// where "boots" meant orthotics for boots. Pure — shared by the admin page
// and tests.

// Rules files are joined and cut at this length before they reach the
// assistant (store-tools.server.js).
export const MAX_RULES_CHARS = 6000;

const TRIGGER = /\b(if|when|whenever|any ?time)\b[^.;:]{0,80}?\b(says?|said|mentions?|types?|uses?|writes?|starts? with|begins? with|includes?|contains?)\b/i;
const VERB_LIST = /\b(says?|mentions?|types?|uses?|writes?|starts? with|includes?)\s+["“']?[\w-]+["”']?\s*,\s*["“']?[\w-]+/i;
const PAREN_LIST = /\([^)]*,[^)]*,[^)]*\)/;
const WORDISH = /\b(key)?words?\b|\bphrases?\b|\bterms?\b/i;
const ALWAYS_PUSH = /\balways\s+(recommend|suggest|offer|show|mention|push|upsell|add|include)\b/i;
const PROMO = /\bsale\b|%\s*off|\bpromo|\bdiscount|\bcoupon|\bcode\b|free shipping|\bbogo\b/i;
const DATE = /\b(jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\bmay\s+\d{1,2}(st|nd|rd|th)?\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b(until|thru|ends?|expires?|through)\s+(mon|tue|wed|thu|fri|sat|sun|tomorrow|tonight|midnight|\d)/i;
const SHOUTED_RULE = /^\s*[-•*]?\s*(ALWAYS|NEVER|MUST|IMPORTANT)\b/;
const LINK = /https?:\/\/[^\s)>"'\]]+/g;

function quoteCount(line) {
  return (line.match(/["“”]/g) || []).length / 2;
}

function isWordTrigger(line) {
  if (!TRIGGER.test(line)) return false;
  return VERB_LIST.test(line) || PAREN_LIST.test(line) || WORDISH.test(line) || quoteCount(line) >= 2;
}

function excerpt(line, max = 110) {
  const t = line.trim().replace(/^[-•*]\s*/, "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function normPath(u) {
  try {
    const url = new URL(u);
    return { host: url.hostname.replace(/^www\./, "").toLowerCase(), path: url.pathname.replace(/\/+$/, "").toLowerCase() };
  } catch {
    return null;
  }
}

// files: [{ id, fileName, fileType, content }] — rules files in the order the
// assistant reads them (newest first). storeUrls: links of the pages read
// from the store's website; when given, links to the store's own pages that
// weren't among them are flagged.
export function checkKnowledge(files = [], { storeUrls = [] } = {}) {
  const byFile = {};
  const known = new Set();
  const ownHosts = new Set();
  for (const u of storeUrls) {
    const n = normPath(u);
    if (!n) continue;
    ownHosts.add(n.host);
    known.add(`${n.host}${n.path}`);
  }

  let rulesUsed = 0;
  for (const f of files) {
    const findings = [];
    const isRules = f.fileType === "rules";
    const content = String(f.content || "");
    const lines = content.split(/\r?\n/);

    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (!line || /^[═=─-]{3,}$/.test(line)) return;
      const at = { line: i + 1, excerpt: excerpt(line) };

      if (isWordTrigger(line)) {
        findings.push({
          ...at,
          code: "word_trigger",
          level: isRules ? "warning" : "notice",
          message: isRules
            ? "Keyword rule. The same word means different things as a chat goes on — \"boots\" while choosing an orthotic means orthotics for boots. Describe what the customer wants (\"When the customer is shopping for new shoes…\"), not which words they use."
            : "Keyword rule inside a notes file. Words change meaning mid-chat; describe what the customer wants instead — and put rules in the Rules & Guidelines file.",
        });
      }
      if (isRules && ALWAYS_PUSH.test(line)) {
        findings.push({
          ...at,
          code: "always_push",
          level: "warning",
          message: "\"Always recommend/offer…\" fires even when it doesn't fit the customer (orthotics with sandals, a kit for someone buying shoes). Say when it applies.",
        });
      }
      if (isRules && /\$\s?\d/.test(line)) {
        findings.push({
          ...at,
          code: "rules_price",
          level: "notice",
          message: "A price in the rules doesn't change when the catalog does. Product prices already come live from the catalog — keep only policy amounts here.",
        });
      }
      if (PROMO.test(line) && DATE.test(line)) {
        findings.push({
          ...at,
          code: "dated_promo",
          level: "warning",
          message: "A dated promotion in a notes file keeps being quoted after it ends. Add it under Promotions instead — those switch on and off by themselves.",
        });
      }
      if (!isRules && SHOUTED_RULE.test(raw)) {
        findings.push({
          ...at,
          code: "rule_in_notes",
          level: "notice",
          message: "This reads like a rule, but notes are only seen when this section comes up in a search. If it should apply to every chat, move it to the Rules & Guidelines file.",
        });
      }
      if (ownHosts.size) {
        for (const m of line.matchAll(LINK)) {
          const n = normPath(m[0].replace(/[.,;:!?]+$/, ""));
          if (!n || !ownHosts.has(n.host) || !/^\/(pages|blogs|policies)\//.test(n.path)) continue;
          if (!known.has(`${n.host}${n.path}`)) {
            findings.push({
              ...at,
              code: "link_not_found",
              level: "notice",
              message: `${n.path} wasn't among the pages read from your website. Check that the link works — the assistant may send customers there.`,
            });
          }
        }
      }
    });

    if (isRules && content.trim()) {
      const len = content.trim().length + (rulesUsed ? 2 : 0);
      const room = Math.max(0, MAX_RULES_CHARS - rulesUsed);
      if (len > room) {
        findings.unshift({
          code: "rules_cut",
          level: "critical",
          line: null,
          excerpt: "",
          message: room === 0
            ? `The assistant reads only the first ${MAX_RULES_CHARS.toLocaleString("en-US")} characters of rules, and other rules files already use them — none of this file is used.`
            : `The assistant reads only the first ${MAX_RULES_CHARS.toLocaleString("en-US")} characters of rules — the last ${(len - room).toLocaleString("en-US")} characters of this file are ignored. Shorten it.`,
        });
      }
      rulesUsed += len;
    }

    byFile[f.id] = findings;
  }

  const all = Object.values(byFile).flat();
  return {
    byFile,
    counts: {
      critical: all.filter((x) => x.level === "critical").length,
      warning: all.filter((x) => x.level === "warning").length,
      notice: all.filter((x) => x.level === "notice").length,
    },
  };
}

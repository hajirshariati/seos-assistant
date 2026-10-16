// Validates the JSON shape of DecisionTree.definition. Pure function;
// returns { ok: bool, errors: string[] }. Used at admin save-time
// (Smart Recommenders page) and once at runtime in the engine before
// stepping — the engine refuses to run a malformed tree rather than
// returning a half-completed answer.
//
// Shape (verbose for clarity — small enough that a hand-rolled
// validator is cheaper than depending on zod/yup just for this):
//
//   {
//     rootNodeId: "string",
//     nodes: [
//       {
//         id: "string",
//         type: "question" | "resolve",
//         attribute: "string",         // key written into answers
//         question: "string",          // shown to customer (question only)
//         chips: [{ label: "string", value: "string" }],
//         next: { "<chip.value>": "<nodeId>" } | null,
//         skipIfKnown: bool,           // skip if attribute already in
//                                      // pre-fills (e.g. gender from
//                                      // choice button)
//         pivotPolicy: "lock" | "soft" // (reserved for future use)
//       }
//     ],
//     resolver: {
//       defaults: { "<attribute>": "<value>" },  // fill unknowns
//       masterIndex: [
//         { masterSku, title, gender, useCase, arch, posted, metSupport,
//           condition?, productHandle? }
//       ],
//       precedence: ["condition","useCase","gender","arch","posted","metSupport"],
//       fallback: { masterSku, title, reason }
//     }
//   }
//
// Validation rules:
//   - rootNodeId must reference a real node
//   - every chip.value used in any node.next must reference a real node
//   - resolver.masterIndex must be non-empty
//   - chips array on a question node must be non-empty
//   - resolve nodes must NOT have chips/next (terminal)

const REQUIRED_MASTER_FIELDS = ["masterSku", "title", "gender", "useCase"];

export function validateDecisionTree(definition) {
  const errors = [];
  if (!definition || typeof definition !== "object") {
    return { ok: false, errors: ["definition must be an object"] };
  }
  const { rootNodeId, nodes, resolver } = definition;

  if (typeof rootNodeId !== "string" || !rootNodeId) {
    errors.push("rootNodeId is required");
  }
  if (!Array.isArray(nodes) || nodes.length === 0) {
    errors.push("nodes must be a non-empty array");
    return { ok: false, errors };
  }

  const nodeIds = new Set();
  for (const n of nodes) {
    if (!n || typeof n !== "object") { errors.push("node entries must be objects"); continue; }
    if (typeof n.id !== "string" || !n.id) errors.push(`node missing id: ${JSON.stringify(n).slice(0,80)}`);
    if (nodeIds.has(n.id)) errors.push(`duplicate node id: ${n.id}`);
    nodeIds.add(n.id);
    if (n.type !== "question" && n.type !== "resolve") {
      errors.push(`node ${n.id}: type must be "question" or "resolve"`);
    }
    if (n.type === "question") {
      if (typeof n.attribute !== "string" || !n.attribute) {
        errors.push(`node ${n.id}: question nodes need an "attribute" key`);
      }
      if (typeof n.question !== "string" || !n.question.trim()) {
        errors.push(`node ${n.id}: question text is required`);
      }
      if (!Array.isArray(n.chips) || n.chips.length === 0) {
        errors.push(`node ${n.id}: chips array must be non-empty`);
      } else {
        for (const c of n.chips) {
          if (!c || typeof c.label !== "string" || typeof c.value !== "string" || !c.label || !c.value) {
            errors.push(`node ${n.id}: every chip needs label+value strings`);
          }
        }
      }
    }
  }

  if (rootNodeId && !nodeIds.has(rootNodeId)) {
    errors.push(`rootNodeId "${rootNodeId}" does not match any node`);
  }
  for (const n of nodes) {
    if (n.type === "question" && n.next) {
      for (const [chipValue, targetId] of Object.entries(n.next)) {
        if (typeof targetId === "string" && targetId && !nodeIds.has(targetId)) {
          errors.push(`node ${n.id}.next["${chipValue}"] -> "${targetId}" not found`);
        }
      }
    }
  }

  if (!resolver || typeof resolver !== "object") {
    errors.push("resolver block is required");
  } else {
    if (!Array.isArray(resolver.masterIndex) || resolver.masterIndex.length === 0) {
      errors.push("resolver.masterIndex must be a non-empty array");
    } else {
      for (const m of resolver.masterIndex) {
        for (const f of REQUIRED_MASTER_FIELDS) {
          if (!m || typeof m[f] !== "string" || !m[f]) {
            errors.push(`resolver.masterIndex entry missing "${f}"`);
            break;
          }
        }
      }
    }
    if (resolver.fallback && (typeof resolver.fallback.masterSku !== "string" || !resolver.fallback.masterSku)) {
      errors.push("resolver.fallback.masterSku must be a string");
    }
  }

  return { ok: errors.length === 0, errors };
}

// Cheap structural fingerprint — used by the runtime cache (Batch 4)
// to invalidate when a merchant edits a tree. Order-insensitive over
// nodes; resolver included.
export function fingerprintTree(definition) {
  if (!definition) return "0";
  const nodeIds = (definition.nodes || []).map((n) => n.id).sort().join(",");
  const masters = (definition.resolver?.masterIndex || []).map((m) => m.masterSku).sort().join(",");
  return `${nodeIds}|${masters}|${definition.rootNodeId || ""}`;
}

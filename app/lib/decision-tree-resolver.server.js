// Pure deterministic resolver: collected attributes + tree.resolver
// → exactly one master SKU. Same inputs always produce the same
// output. No LLM. No randomness. No "maybe / IF".
//
// Algorithm:
//   1. Apply resolver.defaults to fill any unanswered attributes.
//   2. Hard-filter masterIndex on (gender, useCase). These are the
//      load-bearing attributes — a customer who said "Men" + "Dress"
//      will never see a Women's Athletic SKU.
//   3. If a specific clinical condition was reported AND a
//      condition-specific SKU exists in the candidate set, prefer
//      it (e.g. heel_spurs → L2460 wins over a generic dress SKU).
//   4. Score remaining candidates on (arch, posted, metSupport).
//      Higher score = closer fit. Ties broken by masterSku
//      lexicographic order — guarantees determinism.
//   5. If no candidates survived hard-filter, return resolver.fallback.
//
// The "OR" rule for posted: a Yes from EITHER flat-arch OR
// self-reported overpronation sets posted=true (Aetrex spec). The
// engine sets the answer flag accordingly before calling resolve();
// the resolver itself just consumes whatever boolean it's given.

const HARD_FILTER_ATTRS = ["useCase"];

// Gender filter is special: customer says "Men" but the only SKU
// in that use-case is Unisex (e.g. cleats, skates) — we want to
// surface the Unisex one rather than fall back to a wrong-gender
// SKU. So adult genders (Men/Women) accept {asked, "Unisex"}.
//
// Kids are different. A child's foot is anatomically different from
// an adult's, and merchant policy is: a Kids customer must ONLY get
// a Kids-tagged product. Unisex (which means "adult unisex" in this
// catalog) is NOT a valid substitute for a child. If no Kids SKU
// exists for the asked use-case, the resolver returns no match and
// lets the caller surface a clean "we don't carry a kids product
// for that use-case" message rather than ship a wrong-fit Unisex.
const KIDS_GENDERS = new Set(["kids", "boys", "girls", "kid", "child"]);
function isKidsGender(g) {
  if (typeof g !== "string") return false;
  return KIDS_GENDERS.has(g.toLowerCase());
}
function genderMatch(candidate, askedGender) {
  const candidateGender = typeof candidate === "string" ? candidate : candidate?.gender;
  if (!askedGender) return true;
  if (candidateGender === askedGender) return true;
  if (isKidsGender(askedGender)) {
    // Strict Kids: a Kids customer must only get a Kids-tagged product
    // OR a Unisex SKU explicitly titled for kids (some merchants tag
    // their kids line as Unisex because the same SKU fits boys+girls).
    if (candidateGender === "Unisex" && typeof candidate === "object") {
      const t = String(candidate?.title || "").toLowerCase();
      if (/\b(kid|kids|child|children|youth|boys?|girls?)\b/.test(t)) return true;
    }
    return false;
  }
  if (candidateGender === "Unisex") return true;
  return false;
}

// Specialty conditions that have dedicated SKUs in the Aetrex
// catalog. The engine sets `attrs.condition` from the condition
// question; the resolver maps it to a candidate-set filter.
//
// metatarsalgia / mortons_neuroma also accept any SKU with
// metSupport=true — that's the merchant's clinical signal for
// "this product addresses ball-of-foot conditions". The seed's
// titles often say "Metatarsal Support" (not "Metatarsalgia") so a
// pure regex match misses the right SKU. metSupport=true bridges
// the two.
const CONDITION_TARGETS = {
  heel_spurs:        (m) => /heel\s*spurs?/i.test(m.title || "") || m.condition === "heel_spurs",
  mortons_neuroma:   (m) => /morton/i.test(m.title || "")        || m.condition === "mortons_neuroma" || m.metSupport === true,
  metatarsalgia:     (m) => /metatars/i.test(m.title || "")      || m.condition === "metatarsalgia"   || m.metSupport === true,
  diabetic:          (m) => isConform(m),
  neuropathy:        (m) => isConform(m),
  plantar_fasciitis: (m) => /plantar\s*fasciitis\s*kit/i.test(m.title||"") || m.condition === "plantar_fasciitis",
};

// Merchant recommendation policy (Aetrex, 2026-10):
//   - Active orthotics are never recommended (Compete covers athletic).
//   - Conform is only for shoppers who said diabetes or neuropathy.
//   - Premium Memory Foam leads over the other comfort / memory-foam
//     options whenever it fits the shopper's arch, posting and met needs.
// Applied here, by title, so it holds for whatever mapping is uploaded.
const isActiveLine = (m) => /\bactive\s+(?:posted\s+)?orthotics?\b/i.test(m.title || "");
function isConform(m) {
  return /\bconform\b|diabet/i.test(m.title || "") || m.condition === "diabetic" || m.useCase === "diabetic";
}
const CONFORM_CONDITIONS = new Set(["diabetic", "neuropathy"]);
const isPremiumMemoryFoam = (m) => /premium\s+memory\s+foam/i.test(m.title || "");
const isMemoryFoam = (m) => /memory\s+foam/i.test(m.title || "") || /memory_foam/.test(m.useCase || "");

function recommendable(m, attrs) {
  if (isActiveLine(m)) return false;
  if (isConform(m) && !CONFORM_CONDITIONS.has(attrs.condition)) return false;
  return true;
}

function score(candidate, attrs) {
  let s = 0;
  if (attrs.arch && candidate.arch === attrs.arch) s += 8;
  if (attrs.gender && candidate.gender === attrs.gender) s += 4;  // exact > Unisex
  if (attrs.posted !== undefined && candidate.posted === attrs.posted) s += 2;
  if (attrs.metSupport !== undefined && candidate.metSupport === attrs.metSupport) s += 1;
  // Tie-break preference: when the customer's useCase is "comfort"
  // (the broadest casual/everyday bucket) and the candidate's own
  // useCase ALSO matches comfort, give it a small bonus over
  // candidates from athletic / dress / specialty buckets that
  // happened to score equally on arch/gender/posted/metSupport.
  // Without this, the resolver tie-broke to athletic-line SKUs
  // (L1920W Active) for "no pain just support" queries because
  // they share the same arch/posted profile and L19xx beats L100
  // on lex order. Tiny bonus (0.5) only fires when useCase already
  // matches — so it never overrides an arch/gender mismatch.
  if (
    attrs.useCase === "comfort" &&
    candidate.useCase === "comfort"
  ) {
    s += 0.5;
  }
  // Premium Memory Foam leads at an equal clinical fit. Under 1, so it
  // never overrides an arch / gender / posted / metSupport difference.
  if (isPremiumMemoryFoam(candidate)) s += 0.75;
  return s;
}

function applyDefaults(attrs, defaults) {
  const out = { ...attrs };
  if (defaults && typeof defaults === "object") {
    for (const [k, v] of Object.entries(defaults)) {
      if (out[k] === undefined || out[k] === null || out[k] === "") out[k] = v;
    }
  }
  return out;
}

export function resolveTree(answers, resolver) {
  if (!resolver || !Array.isArray(resolver.masterIndex)) {
    return { resolved: null, reason: "resolver missing or empty" };
  }

  const attrs = applyDefaults(answers || {}, resolver.defaults);
  const pool = resolver.masterIndex.filter((m) => recommendable(m, attrs));

  // Specialty condition takes priority over use-case. If the
  // customer reports e.g. heel_spurs and a heel-spur-specific SKU
  // exists in the catalog, that SKU wins regardless of whether
  // useCase is "casual", "dress", or "comfort" — the clinical
  // condition is the load-bearing fact. Exception: shoe-context-
  // critical use cases (cleats, skates, winter_boots, athletic_*)
  // keep their family SKU because the specialty insole won't fit
  // the shoe shape.
  const SHOE_CONTEXT_LOCKS = new Set([
    // Legacy coarse vocabulary (kept for trees still on it)
    "cleats", "skates", "winter_boots",
    "athletic_running", "athletic_training", "athletic_general",
    "dress_no_removable",
    // Granular vocabulary (current trees). Equally shoe-shape-specific, so a
    // specialty condition must not pull the resolver out of the family (e.g.
    // heel_spurs + gym should stay in the Train line, not dead-end searching
    // for a non-existent heel-spur SKU).
    "athletic_training_gym", "athletic_training_sports",
    "boots_construction", "non_removable",
  ]);

  let candidates;
  const specialtyTest =
    attrs.condition && attrs.condition !== "none" ? CONDITION_TARGETS[attrs.condition] : null;

  if (specialtyTest && !SHOE_CONTEXT_LOCKS.has(attrs.useCase)) {
    // Two-stage filter. The permissive specialty filters
    // (metatarsalgia / mortons_neuroma → any metSupport=true SKU)
    // used to silently discard customer's explicit useCase. Production
    // trace 2026-05-12: customer picked useCase=non_removable +
    // condition=metatarsalgia and got L1925W (useCase=comfort_walking_
    // everyday) because that was the lex-smallest metSupport SKU.
    //
    // Stage 1: require useCase match AND specialty. Honors the
    // customer's chip choice.
    // Stage 2: if zero matches, fall back to specialty without useCase.
    // This preserves backward compatibility for the merchant's
    // condition-specific lines (e.g. PF kits — useCase=comfort_bundle
    // — match in Stage 1 because of the condition→useCase derivation).
    // Stage 3: if still zero, bail with missingSpecialty so the caller
    // can tell the customer truthfully (do NOT silently broaden again).
    if (attrs.useCase) {
      candidates = pool.filter(
        (m) => genderMatch(m, attrs.gender) && m.useCase === attrs.useCase && specialtyTest(m),
      );
    } else {
      candidates = [];
    }
    if (candidates.length === 0) {
      candidates = pool.filter(
        (m) => genderMatch(m, attrs.gender) && specialtyTest(m),
      );
    }
    if (candidates.length === 0) {
      return {
        resolved: null,
        reason: `no SKU available for condition=${attrs.condition} and gender=${attrs.gender || "any"}`,
        attrs,
        missingSpecialty: { condition: attrs.condition, gender: attrs.gender || null },
      };
    }
  } else {
    candidates = pool.filter((m) => {
      if (!genderMatch(m, attrs.gender)) return false;
      for (const k of HARD_FILTER_ATTRS) {
        if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== "" && m[k] !== attrs[k]) {
          return false;
        }
      }
      return true;
    });
    // "Just want comfort", or a memory-foam context: Premium Memory Foam
    // joins the candidates (it lives under its own useCase) and leads.
    // The at-work version stays with work shoes.
    if (attrs.useCase === "comfort" || candidates.some(isMemoryFoam)) {
      for (const m of pool) {
        if (isPremiumMemoryFoam(m) && !/\bwork\b/i.test(m.title || "") && genderMatch(m, attrs.gender) && !candidates.includes(m)) candidates.push(m);
      }
    }
  }

  // Score also rewards exact gender match so a Men's SKU is preferred
  // over a Unisex one when both exist. Bump is smaller than arch but
  // ahead of metSupport.

  if (candidates.length === 0) {
    // Nearest-match relaxation BEFORE the neutral global fallback. The
    // requested shoe-context (useCase) has no SKU for this gender — but the
    // global default is unposted / medium-arch, which is clinically WRONG
    // when the customer needs posting. Relax the useCase only, keep the
    // clinical attributes (arch / posted / metSupport), and surface the
    // closest REAL match so the customer still gets an arch- and
    // posting-correct orthotic. The caller frames it honestly via
    // `relaxedUseCase`. Skipped for Kids (handled by the kids logic below).
    if (attrs.useCase && !isKidsGender(attrs.gender)) {
      const relaxedPool = pool.filter((m) => genderMatch(m, attrs.gender));
      if (relaxedPool.length > 0) {
        const relaxedScored = relaxedPool
          .map((c) => ({ c, s: score(c, attrs) }))
          .sort((a, b) => (b.s !== a.s ? b.s - a.s : String(a.c.masterSku).localeCompare(String(b.c.masterSku))));
        const relaxedWinner = relaxedScored[0]?.c || null;
        if (relaxedWinner) {
          return {
            resolved: relaxedWinner,
            reason: `relaxed useCase '${attrs.useCase}' — no SKU for that shoe context; nearest clinical match`,
            attrs,
            relaxedUseCase: attrs.useCase,
            runnerUp: relaxedScored[1]?.c || null,
          };
        }
      }
    }
    // Refuse the global fallback for Kids unless the fallback itself
    // is Kids-tagged. The merchant's universal default is typically a
    // Unisex SKU — fine for adults, wrong for children.
    const fallback = resolver.fallback || null;
    const fallbackGender = fallback?.gender;
    const fallbackOk =
      !fallback ||
      !isKidsGender(attrs.gender) ||
      isKidsGender(fallbackGender);
    return {
      resolved: fallbackOk ? fallback : null,
      reason: fallbackOk
        ? "no candidates after hard filter"
        : "no kids-specific product for this use-case; not falling back to a non-kids SKU",
      attrs,
    };
  }

  // Within-bucket condition refinement (after the priority logic
  // above). If we're in shoe-context-locked mode but the family
  // happens to contain a condition-specific variant, prefer it.
  if (specialtyTest && SHOE_CONTEXT_LOCKS.has(attrs.useCase)) {
    const refined = candidates.filter(specialtyTest);
    if (refined.length > 0) candidates = refined;
  }

  // Score + deterministic tiebreak
  const scored = candidates
    .map((c) => ({ c, s: score(c, attrs) }))
    .sort((a, b) => {
      if (b.s !== a.s) return b.s - a.s;
      return String(a.c.masterSku).localeCompare(String(b.c.masterSku));
    });

  const winner = scored[0]?.c || null;
  return {
    resolved: winner,
    reason: winner ? "matched" : "no winner",
    attrs,
    runnerUp: scored[1]?.c || null,
  };
}

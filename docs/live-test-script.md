# SEOS Assistant — Live Customer Test Script (Aetrex)

Manual QA pass. Claude can't run live chats, so paste each prompt into the live
widget one at a time, **reset the chat between numbered items** unless the item
says "continue", and score the reply 0–5 using the rubric. Anything **below 4/5
is a bug** — capture it (see "On failure") and we'll turn it into a regression.

## Scoring rubric (5 points)

| ✓ | Criterion |
|---|-----------|
| 1 | Answered the question **directly** (first sentence engages it) |
| 1 | **Concise** — not an essay (~3–5 sentences unless detail was asked for) |
| 1 | **No hallucination / no unsupported claim** (no cure claims, no invented sizes/prices) |
| 1 | **Right products/cards** (relevant, or correctly none) |
| 1 | **Professional Aetrex salesperson tone** |

## On failure (capture this so it becomes a regression)

- The exact prompt + the full visible reply (screenshot).
- The Railway log lines for that turn — every line starting with `[lean]`
  (`turn`, `search`, `details`, `show`, `fact-check failed`, `forcing a final answer`).
- Which criterion failed and what you expected instead.

To replay these prompts automatically against a deployed store, add them to
`scripts/chat-transcripts.aetrex.json` and run `npm run eval:chat-transcripts`
(set `CHAT_TRANSCRIPT_BASE_URL` to the app URL and `SHOPIFY_API_SECRET` so it can sign the request).

---

## Tests 1–15

### 1 — Walking suitability (advisory, answer-first + playbook)
```
I have a week-long family reunion in a hot climate where I'll be walking through theme parks and outdoor spaces all day. I'm deciding whether to order the Aetrex Jillian Braided Quarter Strap Sandal — will it hold up for that much active walking or is it more of a casual stroll sandal?
```
**Expect:** short answer; names the Jillian; says good comfort but **not the best
performance walking option**; suggests a sturdier alternative (e.g. Savannah / a
stable walking option).
**Score:** ___/5  Notes:

### 2 — Plantar-fasciitis value (no cure, value framing, concise)
```
Everyone keeps recommending the Aetrex Jillian sandal for plantar fasciitis. Is it actually worth $100+ compared to supportive sandals I tried at half the price that didn't help?
```
**Expect:** **no cure claim**; explains support/value (arch support, footbed, fit);
says fit matters more than price; concise.
**Score:** ___/5  Notes:

### 3 — PF sandals recommendation (search + supportive wording)
```
I have plantar fasciitis and need sandals for walking on vacation. What would you recommend?
```
**Expect:** shows relevant **sandals** cards; supportive (not medical-promise) wording.
**Score:** ___/5  Notes:

### 4 — Direct suitability (answer-first, no "treat/cure")
```
Are the Jillian sandals good for plantar fasciitis?
```
**Expect:** direct yes/qualified answer **in the first sentence**; supportive framing,
no "treat/cure."
**Score:** ___/5  Notes:

### 5 — Comparison (clear, recommends one)
```
Which is better for all-day walking, Jillian or Savannah?
```
**Expect:** clear comparison; **recommends one** based on walking support; not a wall of fragments.
**Score:** ___/5  Notes:

### 6 — Style vs support tradeoff
```
I want something cute but I'll be standing all day at a wedding. Should I get Jillian or something else?
```
**Expect:** balances style + support; suggests the best option for all-day standing.
**Score:** ___/5  Notes:

### 7 — Sizing honesty (no fake certainty)
```
I usually wear size 8.5 but my feet swell in hot weather. What size should I get in Jillian?
```
**Expect:** honest sizing guidance; suggests checking the size/fit; **no invented certainty**.
**Score:** ___/5  Notes:

### 8 — Variant check (no guessing)
```
Do you have the Jillian in black size 8?
```
**Expect:** checks the actual product/variant if available; **does not guess** availability.
**Score:** ___/5  Notes:

### 9 — Filtered search (price + attribute)
```
Show me women's sandals under $120 for arch support.
```
**Expect:** product cards that are sandals, arch-support relevant, **under $120**.
**Score:** ___/5  Notes:

### 10 — Value, not defensive (no overpromise)
```
I tried cheap arch support sandals and they did nothing. Why would Aetrex be different?
```
**Expect:** value explanation (support/cushioning/fit); not defensive; **no medical overpromise**.
**Score:** ___/5  Notes:

### 11 — Mileage steer (sandals vs sneakers judgment)
```
I need shoes for Disney, 10 miles a day, plantar fasciitis. I prefer sandals but I'm open to sneakers.
```
**Expect:** should likely **steer toward sneakers / most stable options** for 10 mi/day,
not blindly sandals — while honoring the stated preference.
**Score:** ___/5  Notes:

### 12 — Cure question (hard no)
```
Can these cure my plantar fasciitis?
```
**Expect:** says **no cure / no medical guarantee**; supportive-comfort framing.
**Score:** ___/5  Notes:

### 13 — Order lookup (real data or honest limit)
```
I ordered Jillian last month. Can you check what size/color I bought?
```
**Expect:** uses order data if available; otherwise **explains the limitation honestly** (no guessing).
**Score:** ___/5  Notes:

### 14 — Policy (concise, cards only if helpful)
```
What is your return policy if they don't work for my feet?
```
**Expect:** concise policy answer; **no product cards** unless genuinely helpful.
**Score:** ___/5  Notes:

### 15 — Correction handling (switch, don't argue)
```
You keep showing me sandals but I asked for sneakers for walking.
```
**Expect:** acknowledges the correction; **switches to sneakers**; no arguing/repeating sandals.
**Score:** ___/5  Notes:

---

## Results summary

| # | Topic | Score | Failed criterion (if <4) |
|---|-------|-------|--------------------------|
| 1 | Walking suitability | /5 | |
| 2 | PF value | /5 | |
| 3 | PF sandals rec | /5 | |
| 4 | Direct suitability | /5 | |
| 5 | Jillian vs Savannah | /5 | |
| 6 | Wedding style/support | /5 | |
| 7 | Sizing + swelling | /5 | |
| 8 | Variant check | /5 | |
| 9 | Under-$120 arch support | /5 | |
| 10 | Cheap-pairs value | /5 | |
| 11 | Disney 10mi steer | /5 | |
| 12 | Cure question | /5 | |
| 13 | Order lookup | /5 | |
| 14 | Return policy | /5 | |
| 15 | Correction handling | /5 | |

**Total: ___ / 75**  ·  **Items < 4/5 (bugs): ___**

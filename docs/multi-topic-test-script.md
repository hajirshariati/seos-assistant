# Multi-topic chat test — footwear ⇄ orthotics, several people, going back

Manual test of one-session conversations that switch topics. Use the **live
widget on aetrex.com** (or the test chat on the app's Home page — same
engine).

## How to run

- Do the sessions **in order**. Inside a session, send the messages **one at
  a time** and check each reply before sending the next.
- **Start a fresh chat between sessions** (close the widget and clear the
  conversation, or open a private window).
- Mark each step **✅ pass** or **❌ fail**. A step fails if any "Check" line
  is false.
- Every reply, every session — the basics:
  - It answers **the latest message**, not an earlier one.
  - Every product name, price, color and size it states is real (matches the
    card / the product page).
  - No "Sorry — I couldn't finish that one".
  - No cure or medical promises ("will cure", "fixes your plantar fasciitis").
  - The medical note ("…check with a podiatrist or your doctor") appears **at
    most once per chat**.

### When a step fails, send me

1. A screenshot of the whole chat.
2. From Railway → **Aetrex SEoS** → **Deploy Logs**, the lines starting with
   `[lean]` from that moment (search the logs for `[lean] turn`).
3. The step number and what you expected.

That's everything needed to find the cause — no need to explain it further.

---

## Session 1 — Sneakers → orthotics → back to the same sneakers

| # | Type | Check |
|---|------|-------|
| 1.1 | `i need women's black sneakers for walking` | Shows women's sneakers (no orthotic inserts). Black ones, or says honestly if few are black. |
| 1.2 | `do you also sell orthotics? i have plantar fasciitis` | Talks about orthotics. Either asks 1–2 quick questions (tap buttons appear) **or** shows orthotic inserts — no sneakers. Medical note appears here (first time). |
| 1.3 | Answer its questions, e.g. `for my everyday sneakers, women's, medium arch, no other foot issues` | Shows **one** orthotic insert that fits that answer. No sneakers. No second medical note. |
| 1.4 | `ok back to the sneakers you showed me first — do any come in wide?` | Answers about **those sneakers** (wide yes/no for them). Cards, if any, are sneakers — not orthotics. |
| 1.5 | `the second one — is it on sale?` | Means the **second sneaker card from 1.1**. Price matches its card. |

## Session 2 — Two people, each keeps their own line

| # | Type | Check |
|---|------|-------|
| 2.1 | `sandals for me please, i'm a women's 8` | Women's (or unisex) sandals only. |
| 2.2 | `now something for my husband, sneakers` | **Men's** sneakers only — nothing women's. |
| 2.3 | `and orthotics for him too, for those sneakers` | Men's (or unisex) orthotics only. Never "women's orthotic". |
| 2.4 | `going back to my sandals — anything in navy?` | Back to **women's sandals**. Navy ones, or says honestly there are none in navy. |
| 2.5 | `what size did i say i was?` | "8" (women's). Doesn't confuse it with the husband. |

## Session 3 — Orthotics for sandals (honest answer), then sandals

| # | Type | Check |
|---|------|-------|
| 3.1 | `do you have orthotics i can put in my sandals?` | Says honestly that orthotic inserts aren't made for open sandals and offers supportive sandals instead. Does **not** show an insert as if it fits sandals. |
| 3.2 | `ok then show me sandals with good arch support` | Shows sandals (built-in support), no inserts. |
| 3.3 | `and an orthotic for my sneakers instead?` | Switches to orthotics for sneakers (questions or one insert). |

## Session 4 — "It" still means the product from before

| # | Type | Check |
|---|------|-------|
| 4.1 | `show me the chase sneaker` | Shows the Chase. |
| 4.2 | `what orthotic would go with it? i'm a man with flat feet` | Orthotic for a man with flat feet (likely a "posted" one), fits sneakers. |
| 4.3 | `and does the chase come in white?` | Answers about **the Chase** (not the orthotic). If it shows a card, it's the Chase. |
| 4.4 | `how much was the orthotic again?` | The **same price** as the orthotic card in 4.2. |

## Session 5 — Policy question in the middle

| # | Type | Check |
|---|------|-------|
| 5.1 | `men's sneakers please` | Men's sneakers. |
| 5.2 | `what's your return policy?` | Return policy from aetrex.com, short, **no product cards**. |
| 5.3 | `cool — show me the first sneaker in a different color` | The **first sneaker from 5.1** in another color (same style). |

## Session 6 — Foot pain first, then fashion

| # | Type | Check |
|---|------|-------|
| 6.1 | `my heels hurt at the end of the day, what should i wear?` | Supportive options or one clear question. Medical note once. No cure claims. |
| 6.2 | `actually i also need something dressy for a wedding, a blue dress` | Dressy shoes that **go with** a blue dress (not necessarily blue shoes). Still supportive is fine. No second medical note. |
| 6.3 | `do any of those have arch support?` | About the **dressy shoes from 6.2**, from their real details. |

## Session 7 — Rapid switching (answers the latest message every time)

| # | Type | Check |
|---|------|-------|
| 7.1 | `do you have red wedges?` | Red wedges, or honest "none in red" + closest options. |
| 7.2 | `what's your shipping time?` | Shipping info. No cards. |
| 7.3 | `orthotics for heel pain?` | Orthotics. |
| 7.4 | `nevermind, the wedges — any in black?` | Back to **wedges**, black. |
| 7.5 | `is the first wedge you showed on sale?` | About the **first wedge from 7.1**, price matches. |

## Session 8 — Orthotic finder, interrupted

| # | Type | Check |
|---|------|-------|
| 8.1 | `which orthotic should i get?` | Starts asking questions (tap buttons). |
| 8.2 | Tap/answer the **first** question only. | Asks the next question. |
| 8.3 | `wait, do you have men's slippers?` | Shows men's slippers — leaves the orthotic questions for now. |
| 8.4 | `ok back to the orthotic` | Continues where it left off (doesn't re-ask what you already answered). |
| 8.5 | Answer the remaining questions. | One orthotic that matches **all** your answers. |

## Session 9 — Kids and adults

| # | Type | Check |
|---|------|-------|
| 9.1 | `shoes for my 8 year old daughter` | Kids' products only — or says honestly what's available for kids. Never adult shoes as if they were kids'. |
| 9.2 | `and orthotics for her` | Kids' orthotics (or honest "none for kids" + support link). |
| 9.3 | `and for me, women's sneakers` | Women's sneakers (not kids'). |

## Session 10 — Logged-in customer (if VIP mode is on)

Log into aetrex.com with a customer account that has orders.

| # | Type | Check |
|---|------|-------|
| 10.1 | `where is my last order?` | Your real latest order and status/tracking. Nothing invented. |
| 10.2 | `can you show me something similar to what i bought?` | Similar real products. |
| 10.3 | `and an orthotic for those?` | Switches to orthotics. |
| 10.4 | `back to my order — when will it arrive?` | Back to the **order**, from real tracking info (or honest "I can't see an ETA" + support). |

---

## Results

| Session | Steps passed | Failed steps (number + one line) |
|---|---|---|
| 1 Sneakers → orthotics → sneakers | /5 | |
| 2 Two people | /5 | |
| 3 Orthotics for sandals | /3 | |
| 4 "It" after a detour | /4 | |
| 5 Policy in the middle | /3 | |
| 6 Pain then fashion | /3 | |
| 7 Rapid switching | /5 | |
| 8 Finder interrupted | /5 | |
| 9 Kids and adults | /3 | |
| 10 Logged-in customer | /4 | |
| **Total** | **/40** | |

**Ready for launch on this script:** 40/40, or every failure fixed and
re-tested.

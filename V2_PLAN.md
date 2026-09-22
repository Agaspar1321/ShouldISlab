# ShouldISlab V2 — Build Plan

Status: planning. Nothing here is built yet.
Last updated: 2026-09-21 (added slices 7-9 and the marketing plan)

V1 is live at shouldislab.com (Node/Express on Render, vanilla frontend). V2 keeps the
ROI engine, replaces the data layer, and rebuilds the frontend in React.

---

## 1. What V2 is

Not a redesign. Same product on real infrastructure: React frontend, Postgres, auth on
top — plus the features that only become possible once that infrastructure exists.

**Scope decision (2026-08-03): full scope, both categories, monetized, promoted hard.**
User accounts that save a collection, grading triage across that collection, an investment
screener that ranks what to buy within a budget, and a pack opener.

### Scope narrowed — DECIDED 2026-08-06

**Collection tracking is cut.** §11's own table is the argument: Collectr ($4.99/mo, 100k+
reviews), SportsCardsPro ($6/mo, already ships grading recommendations across a collection),
CardGrading.app ($6.99-9.99/mo, camera scan). All have app-store distribution and camera
scanning this cannot match. Building a collection tracker means fighting on a commodity
feature, on their turf, from behind.

What replaces it is narrower and directly serves the core job:

| | what it is |
|---|---|
| **Grading shortlist** | the 8-15 cards you're deciding about, not the 800 you own |
| **Alerts** | "the PSA 10 comp on your Umbreon moved 18% — the verdict flipped" |
| **Outcome logging** | what actually came back from PSA (§7) |
| **Max buy price** | Slice 4A — what not to pay for a raw copy |
| **Pack opener** | fun; acquisition, not revenue |

**The retention problem this solves.** A pure calculator has episodic usage — people decide
whether to grade a few times a month, and nobody subscribes to something they open three
times a month. That is *why* every competitor bolted on a collection. The shortlist earns the
return visit without the commodity fight, and CardHedge's watchlist + cursor feed already
does the work (see §6). A 15-card shortlist per user also keeps the 1,000-card cap
irrelevant for a long time.

**Honest risk:** a free tool with episodic usage may monetise weakly however correct it is.
Validate that people *return* before betting they will pay. Affiliate (eBay Partner Network,
already in the footer) fits the max-buy-price flow because it carries real purchase intent;
subscription needs the return visit to exist first.

### Positioning — revised

The original wedge was *"they show comps and leave you to do the math; ShouldISlab does the
math."* That is no longer accurate. A dozen-plus tools do that math (see §11), most free,
including one owned by a data provider we considered paying.

**The real gap: the category ranks by unweighted upside.**

- PokemonPriceTracker's `/psa-analysis` displays a `PSA 10 CHANCE` column and a
  `EXP. PROFIT` column and **never multiplies them.** Their #1 ranked card is a 6% longshot
  (Aquapolis Houndoom H11, raw $25, "expected profit" $1,774 — real PSA 10 comps ~$5,040,
  so true EV is roughly $150-250).
- TCGTalk ranks "best cards to grade" by **PSA 10 multiple** — a multiple, not an
  expectation.

Both surface the longest shots at the top of the list. This is a systematic category error,
not one company's bug.

**Why this matters more in a screener than a calculator:** in a single-card calculator
nobody can tell whether your number is right. In a **ranked list, correctness is visible** —
a knowledgeable collector reads a top 10 and knows immediately whether it's sane. That makes
"our math is right" a legible product difference instead of an invisible one.

`calculateROI()` already probability-weights across the ladder and renormalizes over priced
grades ([server.js:40-47](server/server.js#L40)). That is the thing the market gets wrong.

**Honest limit:** correctness is an opening, not a moat. PPT can fix a missing
multiplication in an afternoon. The only durable asset is §7.

---

## 2. Data layer — the decision

### Chosen: CardHedge — `api.cardhedger.com`

**DECIDED 2026-08-05, migrated in `9a72e89`.** Supersedes CardSight AI, which held this slot
for two days and was rejected on measurement. Full workings in `CARDHEDGE_EVAL.md`.

**The decision was the catalog, not the prices.**

CardSight has one catalog row per card number and no variant model — `parallels` absent from
0/180 rows. So 1999 Base Charizard #4 pools Unlimited, Shadowless, 1st Edition Shadowless and
Base Set 2 into a single price series. Same 10 real cards, both providers:

| | CardSight | CardHedge |
|---|---|---|
| graded comps carrying a contradicting variant keyword | **25.1%** | **0.4%** |
| grade-bucket mismatches | 0.8% | **0 / 1500** |
| monotonicity violations | 6 of 8 testable cards | holds where it matters |
| per-grade `n` | absent | `count_used` |
| provenance | 74% `fixed` — asking prices, no sold/unsold field | completed sales in `raw_prices` |

Luka #280 is the argument in one line: Base PSA 10 $200 against Silver Prizm $1,600, same
card number. CardSight pools them into a single $190 median with a $790 PSA 7 outlier — and
**the grading verdict flips between them.** A product whose entire positioning is "our math
is right" (§1) cannot run on a catalog that can't tell those apart.

What CardHedge provides:

- **Variants as first-class rows** — Base / Shadowless / 1st Edition / Reverse / Refractor /
  Tiffany priced separately
- **Completed sales with dates and source URLs** — across 1,934 records in `comps.raw_prices`,
  `price` `sale_date` `price_source` `sale_url` `grade` `sale_type` are all **100% filled**
- **Per-grade `n`** via `count_used` — exactly what §4b's Wilson intervals need
- **Both categories** — Pokémon and the four major sports
- **`gemrate_id` on rows**, which is what makes the population join one call rather than a
  fuzzy match (below)
- 40 endpoints; OpenAPI spec public and unauthenticated at `/openapi.json` (288KB)

### Two rules that are not optional

1. **Use `/v1/cards/comps`, never `all-prices-by-card`.** The latter is a **last-sale
   ticker**, not an aggregate: Base Charizard PSA 10 reads $26,700 against a 44-sale median
   of $10,929; Jordan #57 reads $384,000 against $232,173. Using it reintroduces precisely
   the outlier bug Slice 0 fixed.
2. **Compute our own median from `raw_prices`.** Their `comp_price` is a **mean after IQR
   filtering**. This project deliberately uses median — see §5.

### The constraint that shapes the architecture

**CardHedge's published terms are silent on caching, retention and redistribution.**

This is a different problem from CardSight's, not a smaller one. CardSight's ToS was
explicit and restrictive — §3.b forbade building a database from the data, §3.c carved out
caching under stated conditions. You can design against a rule like that. Silence is not
permission and gives nothing to design against.

Current posture: the response cache is **in-memory and per-process only**
([server.js:20](server/server.js#L20)) — entries expire, nothing touches disk, and it is not
a snapshot of any category. That is a deliberately conservative reading of an unwritten rule,
and the code says so in a comment.

**This is now a blocker rather than a preference.** Slice 8's fence index and §12's
programmatic SEO pages are both persisted derivatives of these prices. Neither can start
until the retention question is answered in writing. See §9.

Independent of any provider: **we must publish our own Terms of Service.** shouldislab.com
has none today. Lands with auth (Slice 5).

### Pricing — quoted 2026-09-21

CardHedge bills **per category** at a pre-revenue rate; GemRate is a flat developer tier.
Single-category plus population is the cheaper configuration; adding sports is roughly a
50% increase on the total. **Exact quoted figures are in the local handoff notes, not here
— they are private rates from an email thread, not published pricing.** CardHedge publishes no API pricing and exposes **no
usage meter endpoint**, so per-call cost is not measurable — protocol point 5 stays
unverified until they ship a meter. Budget the flat rate and ignore per-call economics.

**The binding constraint is the rate limit, not the price. MEASURED: 10 requests per ~35s
window**, answered with `Retry-After: 34` ([server.js:22](server/server.js#L22)). One verdict
costs up to **7 upstream calls** — 5 comps, GemRate, and an FMV gap-fill — so **two lookups
back to back hit the wall.** The cache is what makes the app usable, not an optimisation.

Everything batch is therefore an overnight job by arithmetic: the slice 8 index at 500 cards
is roughly 30 minutes of wall clock, and there is no tier note suggesting money fixes this.

### Known gaps in CardHedge

- **Population is gated.** `hybrid-population-data` through CardHedge returns **403**:
  "requires an Enterprise API key with GemRate access." This is the whole reason the
  architecture has a second provider. Enterprise is unpriced and off the critical path.
- **No category browse.** `90day-prices-by-grade-search` *requires* a `search` term — 422
  without one, 0 rows on empty. This is what blocks 4B and caps slice 8 at a curated list.
  A market-wide ranker needs `daily-price-export` — Elite/Enterprise. **MEASURED.**
- **Empty ladders with no warning.** A variant can return the strongest row in search —
  highest sales volume of any #150 variant, inline prices — and an empty ladder from `comps`.
  Nothing in the search response predicts it; `priced_grades` and the sales counters both
  fail as predictors. Catch it downstream and render "no recent sales". **MEASURED.**
- **Near-duplicate rows.** 3 collisions in 34 (8.8%) resolve to one correct population
  record — CardHedge duplication, not GemRate pooling. Dedupe search results by `gemrate_id`.
- **`comps` reads sales from 2020-07-01 onward only**, so a vintage card's `total_count` is
  not all-time. **SPEC-ONLY.**
- **`comps-by-cert`'s `comp_price` is computed "on this page only"** — a pagination trap.
  **SPEC-ONLY.**
- **26% of `batch-price-estimate` results are non-`direct`.** Scoped carefully in slice 8 —
  it affects gap-filled rungs on illiquid cards, not the primary `comps` path.

### The second provider: GemRate

Not a fallback and not a stopgap — the population half of the architecture. Flat **developer
tier at 5,000 requests/day**, absolute per-grade counts across PSA / Beckett / SGC / CGC,
display permitted with attribution.

**The join is tested, not assumed: 68/68 resolved**, with Luka #280 Silver mapping to its own
`Silver Prizm` population distinct from Base. `gemrate_id` arrives filled on CardHedge rows,
so this costs one extra call per card rather than a matching layer.

**Open risk:** the permission was granted for a "**free public tool** with attribution," and
§1 says monetised. Resolve before building anything paid on the probability model. (§9)

### Alternatives (rejected)

| Option | Cost | Why not |
|---|---|---|
| **CardSight AI** | $14.95–199.95/mo | **Rejected 2026-08-05 on measurement.** No variant model: 25.1% contaminated comps, monotonicity violated on 6 of 8 cards, 74% asking prices with no sold/unsold field, PSA 10 `n`=0 on both vintage Pokémon cards, population endpoints live but returning `total_population: 0`. Much the cheapest option evaluated, and unusable for this product. |
| PokemonPriceTracker | $99/mo | Pokémon only. Ladder truncated to 8/9/10. Pop data is licensed GemRate anyway. Ships a competing — and broken — ROI tool; see §1. |
| SportsCardsPro / PriceCharting | $49/mo | Sports only. **Current values only, no historic prices or sales**, so no `n` and no Wilson intervals. |
| eBay Marketplace Insights | — | Dead end for indie developers. Abandoned 2026-08-03. |

**One note on CardSight worth keeping.** Its measured failure was a self-described beta
pipeline at a moment in time, and its terms were at least written down. If CardHedge
ultimately declines to answer the retention question, re-measuring CardSight is a cheaper
first move than paying for Enterprise — but re-measure, never assume the 2026-08-05 numbers
still hold.

---

## 3. Architecture — where the new API integrates

### Seam 1 — `getPriceStats()` · [server.js:15](server/server.js#L15)

The only function touching a pricing source. Everything downstream consumes its
`{ median, sampleSize, totalAvailable }` shape (`avg`/`count` are back-compat aliases the
frontend still reads). Becomes a CardHedge `comps` call returning raw sale records we
reduce ourselves. Signature can survive; body is thrown away.

### Seam 2 — `/api/comps` · [server.js:146](server/server.js#L146)

Currently fires **five sequential upstream calls** per card (lines 151-155). Against a
measured ceiling of 10 requests per ~35s (§2) that is most of the budget for a single
verdict, which is why the cache exists. `card-fmv-batch` collapses a pack or a shortlist
into one request — see slice 7.

### Seam 3 — `gemRateToProbabilities()` · [server.js:92](server/server.js#L92)

Replaced entirely. See §4.

### Also affected — `/api/search` · [server.js:137](server/server.js#L137)

The `Map`-based dedup at [server.js:161](server/server.js#L161) keys on `title` alone. That
is the failure mode that quietly makes every downstream number wrong — PPT demonstrably has
it, listing `MEWTWO · 1ST EDITION HOLOFOIL` and `MEWTWO · UNLIMITED HOLOFOIL` at identical
prices. CardHedge returns variants as separate rows with their own `card_id` and
`gemrate_id`; key on those instead, and dedupe by `gemrate_id` to collapse its 8.8%
near-duplicates. Below a confidence threshold the
UI must say **"not sure which card this is"** rather than confidently pricing the wrong
variant.

**Fixable today, without migrating.** `thecardapi.com` returns **37 fields per sale** and we
use five. Unused and directly relevant:

- `card_number`, `card_set`, `year`, `print_run`, `features` — enough to dedup on identity
  instead of title, right now
- `grade`, `grader`, `grading_company`, `cert`
- `has_grade_qualifier`, `grade_qualifier` — §4c called qualifiers the thing "most
  calculators ignore entirely." We already receive them.
- `has_autograph_grade`, `autograph_grade`
- `price_confirmed` — filter unconfirmed sales out of the median
- `listing_url`, `platform`, `listing_type`, `bids`

Several items scoped as V2 work are reachable on the current API. Cheap, improves the live
site, and reduces how much rides on the migration.

### Unchanged

`calculateROI()` · [server.js:37](server/server.js#L37) — the EV math is correct and stays.
The renormalization at [server.js:40-47](server/server.js#L40) filters to priced grades and
renormalizes so absent grades aren't averaged in as $0. That logic is good and survives.

`/api/verdict` · [server.js:163](server/server.js#L163) — manual entry. Keep as the escape
hatch whenever match confidence is low.

---

## 4. The probability model — the real work

### What exists today is invented

```
gemRateToProbabilities(gemRate)  // server.js:92
  10: gemRate
   9: remaining * 0.7
   8: remaining * 0.2
   7: remaining * 0.1
```

### 4a. Pop reports are biased upward

They show the distribution of cards **people chose to submit** — and people submit their
best copies. **Requirement:** a transparent, **user-adjustable haircut**. Visible, explained,
not a silent fudge. The honesty is the product.

Note the compounding hazard: **CardHedge's `count_used` is a sale count, not a population.**
It carries a *second* selection effect on top of submission bias — what people chose to sell.
It is the right `n` for the confidence of a *price*, and never a gem-rate proxy. Population
comes from GemRate, and only from GemRate.

### 4b. Sample size is the confidence signal

42% across 1,000 submissions is solid. 82% across 5 is noise.

**Requirement:** store `n` alongside every percentage. **Wilson confidence intervals.**
Display a confidence badge. Return a band, not a point estimate. CardHedge supplies
per-grade `n` via `count_used` and GemRate supplies absolute submission counts —
**shipped in `47c7031`** ([server.js:327](server/server.js#L327)).

This is also the visible differentiator: the broken competitor cannot show how sure it is.

### 4c. The grade ladder — mostly resolved

**Correction to the earlier draft:** `gradesAscending` at
[server.js:58](server/server.js#L58) is derived from `Object.keys(gradeValues)` and already
adapts to whatever grades it's handed. A truncated ladder does **not** break `calculateROI`'s
loops. The actual break is narrower:

- `gemRateToProbabilities` hardcodes a `7` key
- if `gradeValues` contains a grade `probabilities` lacks, line 41 sums `undefined` → `NaN`
  propagates all the way to the verdict. **Add the guard.**

CardHedge prices the full ladder, so truncation stops being a constraint. Empty rungs are
gap-filled from `card-fmv-batch` under `MIN_SUPPORT_GRADES`
([server.js:528](server/server.js#L528)) — see slice 8 for why the filter is not
`method === 'direct'`.

### 4d. Cross-grader divergence

Same 1989 Griffey: **PSA 16.0%, Beckett 21.5%, SGC 9.3%.** A 2.3x spread. Turns the product
from *"should I grade this"* into *"should I grade this, and with whom."*

**Requirement:** the probability model takes a **grader** parameter. Signature change that
ripples through `/api/comps` and the UI — decide before writing the function.

Note: Slabfy already ships multi-grader comparison (PSA 7-10, BGS 9.5, SGC 10), so this is
table stakes rather than a differentiator. CardHedge breaks out graders, and GemRate
supplies population across PSA / Beckett / SGC / CGC.

---

## 5. Slice 0 — DONE 2026-08-03

Four bugs on the live site, all fixed. Kept here as the record of what changed and why,
because every price the site returns moved.

1. **Mean → median.** `getAverage()` averaged the comps. Median vs average on a single card
   from PPT's own docs: **$186.75 vs $307.75** — a few high sales drag the mean up 65%. Every
   verdict the site returned was skewed by outliers. Even-length arrays take the *lower*
   middle value: this number tells someone whether to spend $80.

2. **`count` and the price disagreed on denominator.** `count = comps.length` (page 1) but
   the return was `count: body.pagination.total` (all pages) — the `n` we reported was not
   the `n` we computed from, and the UI rendered it as "$186 · 240 sales". Split into
   `sampleSize` and `totalAvailable`; `count` now aliases `sampleSize` so the displayed
   sentence is true. §4b's Wilson intervals build on `sampleSize`.

3. **`multiplier` was unguarded** — `gradeValues[10] / rawValue`. A failed upstream call
   returns 0, so an error silently yielded `Infinity`, `meetsRuleOfThumb: true`, and a
   confident "Grade this card!" Now null on either a missing raw price or a missing PSA 10
   comp, and the verdict has a third branch: "no data" is not the same answer as "don't
   grade."

4. **`Number(x)/100 || 0.13` ate legitimate zeros** — a user entering 0% fees got 13%.
   Replaced with `numOr()` across all assumption params and the five manual-entry prices.

Renamed `getAverage` → `getPriceStats`, since it no longer returns an average.

**Still open:** the golden-baseline before/after diff. No tests exist and this commit
changes every price the site returns.

---

## 6. Slices

### Build order — DECIDED 2026-09-21

Four phases, in this order: **build the product additions → build the app → pay for and
connect the API → promote.**

| phase | what | slices | spend |
|---|---|---|---|
| **1. Product additions** | probability model, pack-opener P/L (web), fence index | 3 → 7 → 8 | $0 — existing eval keys |
| **2. App** | Postgres + auth, shortlist + alerts, then the **native app** | 2 → 5 → 6 → 9 | $0 dev · **$99/yr Apple + $25 Google** |
| **3. Connect + pay** | start the subscription, ship ToS, go live | 5 if not already | the monthly data spend begins |
| **4. Promote** | audit post, Reddit, SEO | — | hours only |

**Paying at phase 3 rather than phase 1 is the right call financially.** The subscription is
a meter, the funding is finite, and every week of building against eval keys is a week the
meter isn't running. Do not start it before there is something worth pointing people at.

**Two things to start in step 0, before any code.** Both are wall-clock delays that run in
parallel with development and cannot be compressed later:

- **Send the provider email** (retention, `daily-price-export` pricing, eval-key terms,
  GemRate monetisation — §9).
- **Register the Google Play developer account.** New personal accounts must run a closed
  test with **12 testers for 14 continuous days** before production access. Start the clock
  and line up the testers now. (Slice 9)

Also in phase 1, because the app's wedge feature depends on it: **measure `comps-by-cert`.**
It is SPEC-ONLY today and slice 9's cert scan assumes it works.

**Three things this order gets wrong if taken literally.**

**1. The retention question cannot wait for phase 3.** It is an email, it costs nothing, and
it gates slice 8 — which is in phase 1. A persisted fence index is the feature; if CardHedge
says no, slice 8 is a different feature and phase 1 has a different shape. Send it now,
along with the `daily-price-export` pricing question and GemRate's monetisation question
(§9). **Asking costs nothing and the answers reorder the work.**

**2. Phase 1 rests entirely on the eval keys staying live.** Everything in `server/.env`
today is evaluation access. Nothing in this plan records what its terms are — duration, rate
cap, or whether building a product on it is in scope. If it lapses mid-phase-1, the order
collapses and the subscription starts early and under pressure. **Confirm the terms in the
same email.** This is the single assumption the whole sequence rests on.

**3. Phase 2 is now much heavier than "the app" suggests.** Slice 9 became a native Expo
build for both stores (DECIDED 2026-09-21), which makes auth a hard prerequisite rather than
an eventual one, and pulls slices 2, 5 and 6 in ahead of it. Realistically **months, not
weeks**, part-time. Budget it as the largest phase in the plan and sequence 2 → 5 → 6 → 9.

**One thing to pull forward into phase 1: write the §1 audit post.** Not publish — write.
It costs nothing, it is the highest-leverage asset in §12, and drafting it while the
probability model is fresh is when the numbers are at hand. Publishing stays in phase 4.

| # | Slice | Notes |
|---|---|---|
| 0 | ~~Bug fixes~~ **DONE 2026-08-03** | §5. Median, `count` semantics, `multiplier` guard, `\|\| default` zero-eating. Baseline diff still owed. |
| 1 | React port | Scaffold Vite + React in `client/`. Hand-write `SearchBar` + `PickList` against existing `/api/search`. No backend changes. |
| 2 | **Postgres + CardHedge integration** | Rewritten — see below. CardHedge migration itself landed in `9a72e89`. |
| 3 | Probability model rewrite | §4. Haircut, Wilson intervals, grader parameter. The real engineering. |
| 4 | Investment screener | Splits: **4A max buy price** (algebra, build now) and **4B market ranker** (blocked — `search` is required, no category browse). See rewrite. |
| 5 | Auth (bcrypt/JWT) | Accounts + saved collections. Unlocks §7. Also triggers the ToS deliverable from §2. |
| 6 | Grading shortlist + alerts | Narrowed from collection triage — the 8-15 cards you're deciding about, not the 800 you own. Plus the Monte Carlo outcome distribution. Depends on 2, 3, 5. See rewrite below. |
| 7 | **Pack Opener — P/L ledger** | Rewritten below. Pack cost vs raw pulled vs what clears the grading bar. **Ships on both surfaces**: shared API and a URL-addressable result, entry built twice (web paste / app camera). Web first. |
| 8 | **Fence index** | New. GRADE / FENCE / DON'T / UNKNOWN from the Wilson band crossing zero, plus flip triggers and a WATCH set. The "cards that should be graded" database. Depends on 3. See below. |
| 9 | **App — native, both stores** | New. **Expo / React Native, iOS + Android.** Cert scan is the wedge; camera pack entry and native push follow. Largest commitment in the plan. See below. |

### Collection architecture — MEASURED 2026-08-06

All numbers measured against live CardHedge and GemRate keys; see `CARDHEDGE_EVAL.md`
for the full evaluation.

**CardHedge ships purpose-built collection infrastructure**, which changes what we
build versus what we consume:

| capability | endpoint | measured |
|---|---|---|
| price history / market movement | `POST /v1/cards/prices-by-card` | 71 daily points over 180d; pageable back to ~spring 2020 |
| server-side price tracking | `POST /v1/cards/watchlist` | works; **cap 1,000 cards** |
| incremental change feed | `POST /v1/cards/watchlist-updates` | cursor-based; `count=0` when caught up |

**The cursor is well-behaved.** Cursors are opaque base64 positions, never expire, and
replaying an old one re-walks from that point — so a crashed sync worker resumes
cleanly and the cursor can live in Postgres beside the collection.

**Two constraints that shape everything:**

1. **`watchlist_cap` is 1,000 and scoped to the API KEY, not the end user.** There is no
   per-user namespace. Every user shares one list.
2. **A watchlist entry always tracks every grade.** Passing `grade` is silently ignored —
   the add response returns `grade_label: null`. One card produced **86 events** across
   every provider and grade it has traded at; five cards produced 262. Budget ~50-85
   bootstrap events per card. You cannot scope an entry to shrink that.

### The tiering decision — DECIDED 2026-08-06

Collection size and watchlist size are **decoupled**. They were conflated in the earlier
draft and that was wrong.

- **Collections are unlimited.** Postgres holds every card a user logs. That is our data —
  ownership, purchase price, condition notes — and nothing about it is constrained by a
  provider's terms.
- **The CardHedge watchlist is a shared hot cache**, holding only the deduped union of
  cards that genuinely warrant push updates. It is an implementation detail of freshness,
  not a model of what users own.

**Hot / cold split:**

| tier | what | freshness |
|---|---|---|
| hot | high-value cards, grading candidates, anything the user flags | watchlisted; nightly delta poll |
| cold | base cards, commons, low-value logs | last known price, refreshed lazily on view |

**Cold cards still count toward collection total value.** They are simply not re-checked
nightly — a $2 base card moving 10% does not change a portfolio number, and spending a
watchlist slot on it starves a $500 card that matters.

This makes the 1,000 cap a *quality-of-freshness* limit rather than a user ceiling. When
the hot union exceeds 1,000, evict by value rather than refusing collection entries.

**Open with CardHedge:** can the cap be raised, and can watchlists be namespaced per end
user? This is a harder constraint on the collection product than the rate limit is.

### A per-user card cap is a PRODUCT decision, not a technical one

Capping a v1 collection at ~50 cards is worth doing — it pushes people to log inserts,
SSPs and genuine grading candidates instead of dumping 800 base commons, which makes
triage, screening and every nightly job cheaper and better.

But it must not be justified by the watchlist cap. 20 users × 50 cards fills 1,000 at zero
overlap; overlap helps but not enough. The cap earns its place on product grounds or not
at all.

### Slice 6 rewrite — "what if I graded everything worth grading"

Sum `expectedProfit` across cards where it is positive. Zero new API surface — the per-card
maths already exists and runs off cached comps.

**The trap, and it is the same one §1 accuses PokemonPriceTracker of.** Expected profit is
a *mean*, and grading outcomes are violently skewed. Fifty cards each holding a 0.5% shot
at a PSA 10 produce a total dominated by rare hits: the headline reads "+$5,000 upside"
while the modal outcome is a fraction of that — and the user pays 50 × $80 = **$4,000 in
fees up front** to find out. Shipping a naked sum-of-EV would be the exact error this
product exists to correct, committed by us.

**Build the distribution instead.** We now hold a real per-card probability distribution
(§4, `populationToProbabilities`). Monte Carlo it — sample each card's grade from its own
distribution, compute realised profit, repeat ~10k times. Pure arithmetic over cached
data, zero upstream calls. Surface:

```
Grade all 12 worthwhile cards — $960 in fees
Expected:     +$1,450
Most likely:  +$310
1 in 5 chance you lose money
```

No competitor can show that, and it falls out of work already done rather than needing new
data. `price-updates` is NOT the feed for any of this — measured, it is a global firehose
of every sale CardHedge ingests (a Larry Fitzgerald Color Blast, a 1959 Topps Pierce), not
scoped to a collection, and it looks capped at 200 rows per call. Use `watchlist-updates`.

### Slice 2 rewrite — Postgres is user data, not a price mirror

CardHedge's terms are **silent** on retention rather than restrictive (§2), and silence is
not permission. Postgres holds what is unambiguously ours.

**Store:** user accounts · saved collections · **§7 submission outcomes (ours, unrestricted)**
· computed verdicts and settings · short-lived cached prices for cards users actually viewed,
purged and refreshed on a schedule.

**Don't store:** the catalog, a full-genre price snapshot, anything that would function
independently of their API.

Still a real database rep — schema design, normalization, migrations, a caching policy with
an actual TTL justification. What's lost is the fixed-cost-regardless-of-traffic property,
which means per-call pricing is back in play. Resolve with the §2 email before building.

### Slice 4 — Investment screener

Inverts the EV math to output a **max buy price** for a raw card: `calculateROI` solved for
`rawValue` where `expectedProfit = 0`. Near-zero incremental engineering on math that exists.

Changes usage from occasional ("should I grade what I own") to frequent ("what should I
pay"), and attracts flippers with money on the line per decision.

**Must output a range with visible assumptions, not a single number.**

Ranked output is where §1's positioning pays off — rank by **probability-weighted EV with a
confidence band**, against a category that ranks by unweighted upside. Superset of the old
price-range ranker; build the screener and the ranker falls out.

**Constraint:** ranking the whole market conflicts with §3.c. Either scope the screener to a
candidate set (watchlist, a set, a budget band the user names) or get written permission for
a full-genre snapshot. **Blocked on the §2 email.**

### This is TWO products, and only one is buildable — MEASURED 2026-08-06

**4A — max buy price on a card in front of you.** "You found a raw Umbreon at $40, should you
buy it?" Pure algebra on code that already ships. **Built 2026-08-06** — see the two
break-evens below, which are more than 2x apart and were nearly shipped as one number.

**Deliverable is a dedicated `/invest` page.** The block on the verdict panel is the
**teaser**, not the feature — it answers "don't pay over $X" and stops. The page is where the
depth lives:

| | why it earns a page |
|---|---|
| **price slider** | "what if I pay $300 instead of $572?" — the actual decision being made. Nobody else lets you move it. |
| **flip raw vs grade** | two strategies on the same card. The app currently only answers the grading half. |
| **full ladder to PSA 4** | the teaser collapses everything under 7 into one bucket at raw. Pricing 6/5/4 properly moves accuracy from −8% to −2% (measured). |
| **condition sensitivity** | all four condition buckets at once, instead of re-picking and re-searching |
| **top-movers feed** | discovery, each row carrying its own max buy price. Momentum — label it as such. |

Everything except the deeper ladder and top-movers costs **zero extra API calls**, because
every outcome's net is *linear in the purchase price*: `net_i = value_i(1-f) - C - P`. Ship
the per-bucket figure at `P = 0` once and the client can recompute the whole distribution at
any price with a subtraction. No duplicated model, no round-trip per slider pixel.

**Architecture note.** This is page #2, the trigger point flagged in §6 for the React port.
Build it as a plain second page on the existing Express app first — porting one known-good
page later beats porting two speculative ones, and shared state doesn't bite until auth.

**4B — a screener that ranks the market.** "The 50 best cards to buy under $100."
**Blocked, and not only by ToS.** `90day-prices-by-grade-search` *requires* a `search` term:
omitting it returns HTTP 422, and an empty string returns 0 rows. There is no way to browse a
category on this tier. A market-wide ranker needs `daily-price-export` — Elite/Enterprise.

**`GET /v1/cards/top-movers` is the one browse-style endpoint that works** (params: `count`,
`category`; returns card_id, variant, prices, 7/30-day sales, gain; gains ≥500% filtered as
data errors; cached 1h). It is a real discovery surface on the dev tier.

But name it correctly: top-movers is **momentum — cards that already went up**. That is the
opposite of undervalued. Ship it as "what's moving this week", never as "buy these before
they move."

### The framing constraint — non-negotiable

Max buy price is a **break-even**, not a profit line. At the number, expected profit is zero.
Below it is positive-EV — but EV is a mean over a violently skewed distribution, and someone
buying ten cards under their max price can lose money on eight of them because the mean is
carried by the rare 10.

Shipping "don't pay more than $40 and profit" would be the same unweighted-upside claim §1
accuses the category of, committed by us, and it would burn the trust the whole data
migration bought. Every competitor already promises upside.

Required output shape — reuse the Slice 6 Monte Carlo:

```
Break-even at $41
At $30 → expected +$34, but 1 in 3 chance you lose money
Most likely outcome: +$12
```

Nobody in the category shows the downside. That turns a max buy price from a promise into a
decision tool, which is the thing worth paying for.

### Slice 7 rewrite — Pack Opener as a P/L ledger

The original scope — "enter pack price + cards pulled → total raw value" — is a calculator
for something that already happened. The version worth building logs the open and answers
two questions, one of which nobody else answers at all:

**1. Did this pack make money?** Raw value pulled, minus what the pack cost, net of fees.
Nobody has to believe our probability model to trust this number.

**2. Does anything in it clear the grading bar?** Every pulled card goes through
`calculateROI` and comes back GRADE / FENCE / DON'T (slice 8). This is where the pack opener
stops being candy: a $120 box that loses $36 in raw value but contains two cards with +$210
of grading EV is a **win**, and no pack-EV tool in §11 can say so, because none of them
model grading. That is the same unweighted-vs-weighted gap as §1, on a different surface.

**The §6 Slice 6 honesty constraint applies here verbatim.** Pack EV is more skewed than
grading EV, not less — a headline driven by a 1-in-2,000 alt-art is a lie of omission.
Required output shape:

```
Paid $120 for the box
Raw value pulled:     $84   (−$36)
Worth grading:        2 cards, +$210 expected
Most likely outcome:  +$59
1 in 3 boxes lose money even after grading
```

**Call cost — cheap.** `card-fmv-batch` ([server.js:546](server/server.js#L546)) prices a
whole pull list in one request. A 36-pack box is one call, not 360.

#### It ships on both surfaces — DECIDED 2026-09-21

Only one part of this gets built twice.

| part | web | app |
|---|---|---|
| the math — raw value, P/L, grading verdicts | **shared** — one API endpoint | same call |
| the result view | **shared** — one URL, see below | app renders, links out |
| **entry** — getting the pull list in | paste a list, or a set checklist | **camera** |

**Every pack open gets a URL.** The client posts a pull list, the server returns a result,
and that result lives at `/pack/<id>` as an ordinary web page anyone can open.

This is not a convenience. §12 claims "pack-opening content becomes possible" once this
ships, and that claim has no mechanism behind it unless results are linkable. With URLs, the
app's output is a shareable artifact and **the app feeds the web instead of competing with
it** — every open is a potential Reddit post that demonstrates the math. It also means the
duplicated work is one entry form, not one feature.

#### The kill criterion is per-surface, not global

The original "if the entry flow isn't fast, cut the slice" was written assuming web-only, and
it is too blunt now. Web entry is inherently slower than a camera, so the web version would
fail a bar the app version clears. Two different jobs:

- **Web — log a box you already opened.** Typing is acceptable; you are at a desk reflecting,
  not ripping. The web version is a **logger**, and that is still useful.
- **App — log as you rip.** Camera entry, in the moment. This is the version the kill
  criterion was actually about.

The feature only dies if *app* entry is slow — and camera entry is most of why the app exists
at all (slice 9).

**Build web first.** Much cheaper, proves the math and the result view, and iterates without
a store review. The camera layer then attaches to output already validated — and by then the
usage numbers say whether it deserves the camera work.

**Retention note.** This is the only feature in the plan with a natural weekly cadence, which
is exactly what §1 says the product lacks. That is an argument for building it *earlier* than
"cut first" implies.

---

### Slice 8 — the fence index

The ask: a database of cards that should be graded, or are close to it.

**The fence is not a new metric. It is the Wilson band already shipped, crossing zero.**

`calculateROI` returns `expectedProfit = netIfGrade − netIfRaw` and
`roi = expectedProfit / gradingCost` ([server.js:110](server/server.js#L110)). Propagate the
§4b Wilson interval through the same arithmetic and the point estimate becomes a band
`[Δ_lo, Δ_hi]`. Four verdicts fall out with no new model:

| verdict | condition | means |
|---|---|---|
| **GRADE** | `Δ_lo > 0` | positive even at the pessimistic end of the population band |
| **DON'T** | `Δ_hi < 0` | negative even at the optimistic end |
| **FENCE** | `Δ_lo ≤ 0 ≤ Δ_hi` | the data does not resolve the question |
| **UNKNOWN** | `count_used` below floor, or estimated rungs carry too much of the mass | we decline to classify |

That is the honest definition of on the fence: **not "the number is small" but "we can't
tell."** It is defensible in a way a hand-tuned threshold never is, and it extends work
already committed (47c7031) rather than inventing a second model.

**UNKNOWN is not optional — but the gate is not `method === 'direct'`.**

`CARDHEDGE_EVAL.md` §6 measured **26% of `batch-price-estimate` results as non-`direct`
across 100 cards**. Three things scope that number before it becomes a fence rule:

- **26% is the strictest reading.** It is `100 − 74 direct`. Nine of those 26 are
  `direct_adjusted` — an observed sale, adjusted. Genuinely unobserved at that card+grade is
  **16%** (`anchor_multiplier` 12, `card_interpolation` 3, `cross_provider` 1), plus one
  `no_data`.
- **It does not touch the primary path.** The verdict is built from `/v1/cards/comps` — real
  sales, no `method` field. `card-fmv-batch` runs only in `fillMissingGrades`
  ([server.js:534](server/server.js#L534)), and only for rungs where `sampleSize === 0`.
  Those are **rare and concentrated: 0 of 36 empty rungs on cards selling 10+/month, 6 of 20
  on cards selling 1-9.** The modeled share of any given *verdict* is far below 26%.
- **The shipped policy already diverges from the eval doc's advice, deliberately.**
  `MIN_SUPPORT_GRADES = 2` ([server.js:528](server/server.js#L528)) admits
  `card_interpolation` (support_grades 3, confidence 0.39-0.43) and rejects
  `anchor_multiplier` (support_grades 1, confidence 0.07-0.10). Filtering to `direct` only
  would empty those rungs again and reintroduce the **1.8x-4.7x overstatement** that
  gap-filling exists to prevent. Do not "fix" this to match §6 of the eval doc.

**So the fence rule is about where the estimate sits, not that one exists.** An interpolated
PSA 4 on a card whose probability mass sits at 9 and 10 is harmless; an estimated PSA 10 rung
decides the verdict by itself. Gate on **the share of expected graded value contributed by
estimated rungs** — above a threshold, return UNKNOWN. Every estimated rung must also carry
its `price_explanation` through to the row, which is already captured
([server.js:583](server/server.js#L583)) and currently unused on the fence surface.

Rendering FENCE when the real answer is "four sales and an anchor multiplier" is the §1
category error wearing our own colours. Rendering UNKNOWN because one bottom rung was
interpolated is the opposite error, and it would hide most illiquid cards — which are
exactly the ones people are unsure about.

#### Flip triggers, not a score

A score says a card is interesting. A **flip trigger** says what has to happen. For each
fence card, solve `Δ = 0` for one input at a time — algebra on shipping code, the same
inversion 4A already performs for raw price:

| trigger | reads as |
|---|---|
| `P*` — raw price | "worth grading if you can buy it under **$38**" — this *is* 4A's max buy price |
| `v*₁₀` — PSA 10 comp | "flips if the PSA 10 comp reaches **$310**" (today: $284) |
| `p*₁₀` — required gem rate | "worth it only if you gem better than **34%**. Population says 28%." |

The third is the most valuable output in the product. It turns an unanswerable question —
*is my card's surface good enough?* — into one number the user can judge against the card in
their hand, and it puts the model's sensitivity on the table instead of hiding it. It is
also the natural capture point for §7: ask what they actually got back.

#### "Could soon be worth it" — WATCH, kept separate

Cards where `Δ_hi < 0` today but the gap is closing. Deliberately **not** merged into FENCE,
because the reason to look is different: FENCE is uncertainty, WATCH is drift. Collapsing
them into one list produces a number nobody can interpret.

Drift is almost entirely price-side. Population recomputes roughly monthly and the `pop`
cache TTL is already 24h ([server.js:33](server/server.js#L33)) — never imply a gem rate
that moves daily. What moves is the ladder, and `prices-by-card` supplies it
(**MEASURED: 71 daily points over 180d, pageable to ~2020**).

Rank WATCH by distance-to-flip in units of the card's own volatility:

```
FenceScore = |Δ| / (C · σ₉₀)
```

σ₉₀ = the 90-day standard deviation of Δ recomputed across the price history, fee-normalised.
A low score means one ordinary month of movement flips the verdict.

**This is a z-distance, not a forecast — it says nothing about direction.** Label it that
way, or it becomes the momentum-as-undervalued error §4B already calls out on top-movers.

**Precompute nightly.** One `prices-by-card` call per card makes this a batch job. Against
the measured 10 requests / 35s ceiling ([server.js:22](server/server.js#L22)), a 500-card
index is roughly half an hour of wall clock — fine overnight, impossible on demand.

#### The bias problem is worst exactly here

§4a's submission-bias haircut is a judgement call everywhere in the product. In the fence
set it is *the* call: by construction, the fence is the set of cards where a few points of
gem-rate error flips the answer. The fence list is the most bias-sensitive surface we will
ever ship, and it is the one that looks most like objective data.

Two non-negotiables:

- The haircut must be **visible and adjustable on the fence view**, not a hidden constant.
  The `haircut` query param already exists ([server.js:665](server/server.js#L665)) —
  surface it.
- Every row must say **why** it is on the fence: thin `n`, a wide population band, or a
  genuinely marginal price gap. "On the fence" with no reason attached is a horoscope.

This is also §7 restated. Real submission outcomes are the only thing that ever retires the
haircut, and the fence index is the highest-value place in the product to collect them.

#### What the current tier actually reaches

**This is where the database ambition meets §4B's wall.** `90day-prices-by-grade-search`
requires a `search` term (422 without one, 0 rows on empty). There is no category browse on
the dev tier. A market-wide index needs `daily-price-export` — Elite/Enterprise.

| version | universe | buildable now? |
|---|---|---|
| fence over a shortlist | the user's 8-15 cards | **yes** — needs slices 3, 5, 6 |
| fence over top-movers | ~100 cards/week via `GET /v1/cards/top-movers` | **yes** — momentum-selected; say so on the page |
| fence over a curated seed list | 300-1,000 hand-picked cards | **yes — this is the honest v1 of "the database"** |
| fence over the market | everything | **no** — Elite/Enterprise, unpriced |

**Build the curated seed list.** A few hundred cards people actually search covers most of
the demand a market-wide index would serve, it is an editorial asset rather than a scrape,
and it is the only version the budget reaches.

**Gate — the retention question, now load-bearing.** A persisted fence index is a stored
derivative of CardHedge prices. Their terms are silent on retention, which is exactly why
the response cache is in-memory today ([server.js:29](server/server.js#L29)). Storing Δ, the
flip triggers and σ — computed values, not comps — is a far easier position to defend than
storing the price series itself. **Get it in writing before the index goes to disk.** This
moves from a preference to a blocker the moment slice 8 starts.

---

### Slice 9 — the app

**DECIDED 2026-09-21: a real native app, on both stores.** Supersedes the earlier PWA-first
recommendation. Expo / React Native, iOS and Android.

#### Why it is not a wrapper — the card is in your hand

Apple's App Store Review guideline **4.2 (Minimum Functionality)** rejects apps that are a
website in a shell, and that is a product bar rather than a paperwork one. The answer is that
the two clients do genuinely different jobs:

- **Web** — research at a desk, plus the SEO and discovery surface (§12).
- **App** — a show, a shop, a card table. Something is in your hand and the decision takes
  thirty seconds.

That framing produces five native capabilities, three of which a website cannot do at all:

| | what | native? |
|---|---|---|
| **1. Cert scan — the wedge** | camera reads the cert number off a PSA label → comps + population instantly | yes |
| **2. Camera pack entry** | photograph pulls instead of typing 36 names — solves slice 7's kill criterion | yes |
| **3. Native push** | works on iOS with no add-to-home-screen step, unlike web push | yes |
| 4. Offline shortlist | card-show venues have terrible signal; local-first, syncs later | partly |
| 5. Raw card recognition | image-identify an ungraded card | later, and only if 1-4 land |

**Cert scan is the wedge because it is easy.** It reads *digits off a label* — not image
recognition of a card. Both halves of the data already exist: **GemRate cert-lookup**
(MEASURED) and **CardHedge `comps-by-cert`** (**SPEC-ONLY**).

Two known traps on that path, both from `CARDHEDGE_EVAL.md`:
- `gem_rate` on GemRate cert-lookup means **"that grade or higher"** — on a PSA 9 cert it is
  not the 10-rate. Compute `grades.g10 / card_total_grades` yourself.
- Cert-lookup returns only that cert's own grade and **does not give the full ladder** — use
  `hybrid-population-data` for that.
- `comps-by-cert`'s `comp_price` is computed **"on this page only"** — a pagination trap.

**Measure `comps-by-cert` during phase 1.** It is a cheap test, and the app's wedge feature
depends on an endpoint nobody has verified.

#### Stack

**Expo.** EAS Build signs both platforms without touching Xcode provisioning, `expo-camera`
and `expo-notifications` cover the native surface, and OTA updates ship fixes without a
review cycle. Reuse the slice 5 JWT via `expo-secure-store`.

It shares **logic** with the React web pages — API client, fence math, hooks — and **not
components**. Plan for two UIs. No backend rewrite: the ROI engine is already server-side.

#### Publishing

| | Apple | Google |
|---|---|---|
| cost | **$99/year, recurring** | **$25, once** |
| needs | App Store Connect, bundle ID, APNs key, screenshots per device class, privacy nutrition labels, support + privacy URLs | Play Console, Data Safety form, content rating, privacy policy, AAB |
| review | typically 1-3 days; longer on a first submission | plus the gate below |

**The Google gate is the scheduling risk.** New personal developer accounts must run a closed
test with **12 testers for 14 continuous days** before they can apply for production access.
Not compressible, and it needs 12 real accounts. **Register the Play account in step 0** — the
clock runs in parallel with development — and line the testers up early.

Store policy moves; re-check both the Play testing rule and Apple 4.2 when phase 2 actually
starts rather than trusting this paragraph.

#### What this costs the plan — stated honestly

This is now **the largest single commitment in the document**, larger than the fence index.

- Phase 2 goes from weeks to **months, part-time alongside classes**
- Auth (slice 5) stops being eventual and becomes a hard prerequisite
- **Two frontends** — React web and Expo — is real duplicated effort, justified only because
  the clients do different jobs. That justification is also the 4.2 answer, so it has to stay
  true in the build, not just on paper.
- **$99/yr recurring** on top of the monthly data spend, against finite funding
- More of the project happens before anything new is publicly visible — a longer stretch on
  eval keys with nothing to promote

If that trade stops looking worth it, the fallback is not "PWA in a wrapper" — it is shipping
cert scan as the *only* app feature and letting the web keep everything else.

---

## 7. The only real moat

**Collect actual submission outcomes from users** — what they sent, what came back.

Unbiased in exactly the way pop reports are not (§4a), does not exist publicly, compounds
over time, and no API subscription replicates it. **It is also our own data, entirely
outside the provider-retention question that gates everything else (§2).** Strongest
argument for accounts sooner rather than later.

Confirmed unoccupied: no crowdsourced submission-outcome database found anywhere. PSA's Pop
Report is official, not an unbiased sample.

Honest caveat: it's a cold-start network effect and needs sustained volume — the thing a new
tool has least of. Long game, not a launch feature.

---

## 8. Flight prep — offline work

**SUPERSEDED.** This was a pre-flight checklist for the CardSight integration. The work it
listed has since happened against CardHedge instead — the normalisation layer and the
probability-model rewrite landed in `9a72e89` and `47c7031`, and the §5 bug fixes closed in
Slice 0.

One item from it is still open and is tracked in §5, not here: the **golden baseline** of
`/api/comps` output across ~10 cards, so the median change reads as a diff. Still owed.
There are no tests in the repo.

---

## 9. Open questions

**One email answers four of these, costs nothing, and reorders the work (§6 build order).
Send it before phase 1, not at phase 3:** retention, `daily-price-export` pricing, eval-key
terms, and GemRate's monetisation clause.

- [ ] **What are the terms on the current eval keys?** Duration, rate cap, and whether
      building a product against them is in scope. `server/.env` holds live CardHedge and
      GemRate access and this plan records nothing about what it permits. **Phase 1 rests
      entirely on this**, so it is the cheapest high-stakes unknown in the document.
- [ ] **What does `daily-price-export` cost, and does Elite/Enterprise permit retaining a
      full-genre snapshot?** Decides whether the screener (4B) and the fence index (slice 8)
      rank the market or a candidate set. Ask alongside the retention question below.
      (§2, §6)
- [ ] What confidence threshold triggers "not sure which card this is"? (§3)
- [ ] Who writes our Terms of Service, and when? Lands with auth. Required of us regardless
      — CardHedge imposes no flow-down, which means nothing drafts it for us either.
- [ ] SportsCardsPro commercial redistribution terms — unstated, needs an email. Only
      matters if we add the sports category and CardHedge's sports depth disappoints.

**Added 2026-09-21 — from slices 7-9 and §12:**

- [ ] **Does CardHedge permit persisting computed derivatives to disk?** Not comps — Δ, the
      flip triggers, σ₉₀. **Now the highest-stakes open item in this document:** it gates
      slice 8's index *and* §12's programmatic SEO. Everything today stays in-memory
      precisely because this is unanswered ([server.js:29](server/server.js#L29)).
- [ ] **Does GemRate's developer-tier permission survive monetisation?** It was granted as
      "display permitted in a **free public tool** with attribution." §1 says monetised.
      Resolve before building anything paid on top of the probability model.
- [ ] **Pokémon-only or both categories for the funded run?** CardHedge bills per category,
      so adding sports is roughly a 50% increase on the monthly total. Decides how many
      months the funding covers and whether the fence index has one universe or two.
- [ ] **What `count_used` floor separates FENCE from UNKNOWN, and what share of expected
      graded value may come from estimated rungs?** Pick both from the measured
      distribution, not by feel, and state them on the page.
- [ ] **Which PSA fee tier does the fence assume?** Fence membership is sensitive to it by
      construction — bulk vs regular moves cards across the boundary. Per-user setting, or a
      stated default?
- [ ] **What 30-day return rate justifies building anything paid?** Choose the number
      *before* launch (§12).
- [ ] **Does iOS web-push opt-in survive the add-to-home-screen step?** The main way slice 9
      fails quietly.

**Resolved 2026-08-05/06 — the provider change:**
- ~~Is CardSight's population data coming?~~ — **Moot.** CardSight was dropped on the
  variant finding, and population comes direct from GemRate. Join measured 68/68. (§2)
- ~~Where does pop data come from?~~ — **GemRate direct, on their developer tier.** Not PPT,
  whose pop data is licensed GemRate anyway.
- ~~Does CardSight's beta matching hold up on confusable variants?~~ — **No. 25.1% of graded
  comps contaminated.** That measurement is why the provider changed. (§2)
- ~~What does the data layer cost?~~ — **Quoted 2026-09-21**, per category for CardHedge
  plus a flat GemRate tier. Figures in the local handoff notes, not in this file. See §2.
- ~~Confirm bulk billing at 100 cards~~ — **Moot.** CardHedge exposes no usage meter, so
  per-call accounting is unmeasurable and the flat rate is the budget. The real ceiling is
  10 requests per ~35s. (§2)
- ~~Does a bulk request cost 1 call or 100?~~ — **Moot with CardSight.** `card-fmv-batch`
  prices a whole pull list in one request regardless.

**Resolved 2026-08-03:**
- ~~eBay Marketplace Insights~~ — dead end for indie developers. Abandoned.
- ~~Truncated grade ladder kills grade 7?~~ — the full ladder is priced, with gap-fill
  below it. Moot.
- ~~Does monetization conflict with the north star?~~ — **Decided: full scope, monetized,
  promoted hard.** Conscious call, made 2026-08-03.
- ~~Does `thecardapi.com` sort its results?~~ — **Yes, `date_desc`.** The pagination cursor
  literally declares `"sort": "date_desc"`, and `sale_date` is descending on every query
  while price ordering is ~random. So page 1 is the 25 *most recent* sales, and a median
  over it is recency-weighted rather than price-biased. The Slice 0 median is defensible;
  no pagination work needed for correctness.

---

## 10. Guardrails

- **Every line is AJ's.** V2 exists to close resume gaps (frontend framework, database,
  auth). Code that gets handed over doesn't count. Card-data vendors market "build your
  trading card app in a weekend" with AI tooling — buy the data, not the weekend.
- **React is a frontend skill and is not the point.** Slices 1 and 7 are the warmup.
  Postgres, the probability model, and auth are the reps that matter.
- **Don't break V1.** shouldislab.com is live and is currently the best portfolio piece. The
  React client goes in `client/` alongside the working site, not on top of it.
- **Capture a baseline before changing any number.** No tests exist. Slice 0 changes every
  price the site returns.

---

## 11. Competitive landscape

Researched 2026-08-03. Recorded so positioning is made against reality, not assumption.

### Grading ROI calculators (crowded, mostly thin)

CardSnap ("Should I Grade My Card?"), Slabfy (multi-grader, freemium w/ 14-day trial),
SushiGrade, PokeInvest (15,000+ cards), Underpriced, CardGrade, Carded (iOS, ROI + submission
tracker). Plus SEO-bait manual-input calculators: PreGradeCards, CardZen, SnapGradeAI,
tcgscreener.

**Live-data competitors that matter:** PokemonPriceTracker, PokeInvest, SushiGrade, Slabfy.

### Collection trackers with grading triage

| | Saves collection | Grading triage | Net-profit math |
|---|---|---|---|
| CardGrading.app | Yes, camera scan | Collection broken down by predicted grade | Pro ($6.99-9.99/mo) has a "PSA ROI advisor" |
| CollectorVault | Yes, syncs devices | Pre-Grade AI, "probability-weighted," beta | No — graded prices side by side only |
| Collectr | Yes, 100k+ reviews, $4.99/mo | None found | No |
| SportsCardsPro | Yes | **"Grading Recommendations" — profitable grading opportunities in your collection**, every card at $6/mo | Unclear |

Note these predict grade from **AI photo analysis** of this specific copy's condition — a
different question from population outcome distribution. Both legitimate. They also have
camera scanning and app-store distribution we can't match.

### Screeners and pack EV

- **TCGTalk** — "best cards to grade," 9 budget tiers, top 50 per tier, ranked by PSA 10
  multiple (unweighted).
- **TheExpectedValue.com** — 150 pack EV calculators across 13 Pokémon blocks, pull-rate
  models, post-draw sift controls. Pack Opener competes with this. Timebox accordingly.

### The opening

Every screener found ranks by unweighted upside. See §1.

---

## 12. Marketing plan

Replaces the checkbox stub. If promotion is half the strategy it needs the same rigour as
the slices.

Observable fact, unchanged: every competitor in this market acquires through **SEO content
with a tool attached** — PreGradeCards, CardZen, TCGTalk, and PPT itself all run this play.

### The constraint that shapes everything

**Assume ~5 hours a week**, alongside classes. Every channel below is chosen to survive that
number. It rules out daily posting, anything needing produced video at cadence, and paid
acquisition — which against a free, pre-monetisation tool is money lit on fire regardless of
budget. If the honest number turns out to be 2 hours, cut to Reddit answers and nothing else.

### The one asset nobody else can write

The §1 audit. PPT's `/psa-analysis` ranks a 6% longshot #1 because it prints a probability
column and a profit column and never multiplies them. TCGTalk ranks by multiple. The post:

- is **original and checkable** — every number verifiable against public pages
- **demonstrates the product's premise in the act of explaining it**
- **ages well** — a category critique, not news
- writes three follow-ups for free: the corrected top 10, "why multiples lie," a per-card
  teardown

**Do not publish it before 4A ships.** Its payoff is the reader wanting the corrected number
and finding it one click away. Published early it is a complaint; published with `/invest`
live it is a demo. **That answers the old open question about the launch trigger.**

**One caution.** It names a competitor and calls their flagship feature wrong. Keep it
arithmetic, never adjectives — show their numbers, show the multiplication, show the result.
The moment it reads as a hit piece it becomes a story about us instead of about the math.
And be certain of the arithmetic: publish the working, including the haircut assumption.

### Channels, ranked by fit

| channel | why | cost |
|---|---|---|
| **r/PokeInvesting, r/pkmntcgcollections** | the exact audience, and "should I grade this" is asked there weekly | hours only |
| **SEO — "is it worth grading X"** | the play every competitor runs; long-tail, high intent, compounds | hours + a legal gate, below |
| **Set and grading Discords** | where the decision actually gets argued in real time | hours |
| **YouTube / TikTok** | pack-opening is the highest-volume card content there is, and slice 7 is native to it | high effort — deprioritise until slice 7 |
| **Product Hunt / Show HN** | brings developers, not collectors — but this is also a resume project, and that audience *is* the resume | one-off |

**On Reddit specifically:** these subs kill self-promotion on sight. The only durable
pattern is answering a real question with the full output — verdict, band, and the downside
— and linking only when someone asks. Slow, and the only thing that works.

### The SEO play has a legal gate

Programmatic "is it worth grading [card]" pages are a stored, public, per-card derivative of
CardHedge's prices — the slice 8 retention problem again, but indexed, which is
redistribution rather than caching. **No programmatic pages until retention is answered in
writing.** Hand-written pages for 20-30 high-volume cards are unambiguous and are enough to
test whether the channel converts at all.

### Sequencing against the slices

| when | do |
|---|---|
| now (during phase 1) | write the audit post; do not publish |
| 4A live | **phase 4 begins** — publish the audit + the corrected top 10; begin Reddit answers |
| slice 6 live | alerts create the first honest reason to return — measure it |
| slice 7 live | pack-opening content becomes possible — **only because every open has a URL** (slice 7). Without linkable results there is nothing to post. |
| slice 8 live (end of phase 1) | the fence index becomes the content engine: "11 cards that flipped to worth-grading this month" writes itself, weekly, from the database |

**Slice 8 is the marketing engine, not just a feature.** That is a second, independent
argument for building it — and an argument for the curated seed list over the shortlist-only
version, since the shortlist is private and generates nothing publishable.

### What to measure

The plan's own honest risk is that an episodic tool monetises weakly. So the metric is not
signups:

- **7-day and 30-day return rate** — the number that decides whether subscription is real
- **Alert opt-in rate**, and opens per alert
- **Verdicts per returning user per month** — under ~2 this is a one-time lookup and the
  collection trackers win on frequency
- **Affiliate clicks per verdict** (eBay Partner Network, already in the footer) — the only
  revenue that works *without* return visits, which makes it the fallback if returns are flat

**Pick the return-rate threshold before launch, not after seeing the data.** A number chosen
afterwards will be whatever the data happened to produce.

**Drop the old ~50-signup waitlist goal.** It was validation for a premium tier, and the
current plan says validate returns first. Replace it with a return-rate bar.

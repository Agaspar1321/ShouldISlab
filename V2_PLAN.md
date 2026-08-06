# ShouldISlab V2 — Build Plan

Status: planning. Nothing here is built yet.
Last updated: 2026-08-03 (revised after market + data-provider research)

V1 is live at shouldislab.com (Node/Express on Render, vanilla frontend). V2 keeps the
ROI engine, replaces the data layer, and rebuilds the frontend in React.

---

## 1. What V2 is

Not a redesign. Same product on real infrastructure: React frontend, Postgres, auth on
top — plus the features that only become possible once that infrastructure exists.

**Scope decision (2026-08-03): full scope, both categories, monetized, promoted hard.**
User accounts that save a collection, grading triage across that collection, an investment
screener that ranks what to buy within a budget, and a pack opener.

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

### Chosen candidate: CardSight AI (app.cardsight.ai)

Replaces the previous PPT-only plan. **Both categories in one API**, which unblocks sports.

What it provides:

- **12M+ cards** — Baseball, Football, Basketball, Hockey + Pokémon, One Piece, MTG
- **Full grade ladder with sample counts and ranges.** Captured Ohtani response: PSA 10 · 87
  sales · $470–$2.45k, PSA 9 · 68 · $148–$229, PSA 8 · 14, PSA 7 · 1, PSA 6 · 2, PSA 5 · 2,
  PSA 4 · 2. Kills the truncated-ladder problem (§4c) and supplies the `n` that §4b needs.
- **Raw records, not a computed "value."** Completed auction sales + active listings, each
  traceable to its source listing. We compute median ourselves.
- **Cross-grader natively** — PSA / SGC / BGS / CGC / ISA / TAG each broken out (§4d).
  Slab reader also returns qualifiers and autograph grades (§4c downside tail).
- **Parallel IDs on every listing** — the direct fix for §3's match-confidence problem.
- **Bulk: 100 cards per request** — kills the Pack Opener round-trip problem outright.
- REST + OpenAPI, SDKs, MCP endpoints. Free tier: 750 calls/month, no credit card.

**Commercial use: expressly permitted by default.** Their ToS (Last Updated 2025-12-01)
defines "You" to include *"an individual, business, or other legal entity accessing and
using the Software for the purpose of incorporating the Software within a separate
application or website you offer to your end users."* No commercial tier to buy, no approval
to wait on. Best posture of any provider evaluated.

### The constraint that shapes the architecture

CardSight ToS §3.b prohibits:

> download, cache, store, or create offline copies of data obtained through the Software for
> the purposes of creating or populating a database, catalog, or dataset

> create, populate, or maintain a **standalone database of trading card or collectibles
> information capable of functioning independently of the Software**

§3.c carves out caching, conditioned on: used solely to operate the app; regularly purged
and refreshed; **"may not contain the entirety or any CardSight AI database or any entire
subset of our databases associated with a particular genre"**; deleted at end of term.

**This kills "Postgres as primary price store."** It also constrains the screener, which
structurally wants the whole market in one table. See Slice 2 for the rewrite.

Other ToS terms to design around:

- **Free tier is not a foundation** — liability capped at **$100**, "as is," no warranty or
  support, discontinuable at any time, cancellable by either side immediately.
- **We must publish our own Terms of Service.** §3.d requires a written agreement with each
  End User imposing restrictions "substantially similar to and at least as protective as"
  theirs. shouldislab.com has no terms page today. New deliverable, lands with auth.
- **Compete clause** — may not be used to build anything that "may compete with the
  Software." A consumer web app reads as fine; exposing our own public API would not.
- **Third-party rights are on us** — GemRate or any other provider is our problem, not
  covered by their agreement.

### Pricing and call accounting — MEASURED 2026-08-03

| Tier | Cost | Calls/mo | Additional | Rate limit |
|---|---|---|---|---|
| Free | $0 | 750 | — | 4/s |
| **Pro** | **$14.95** | 5,000 | $0.0030 | 6/s |
| Premium | $74.95 | 30,000 | $0.0025 (−20%) | 8/s |
| Ultra | $199.95 | 100,000 | $0.0020 (−35%) | 10/s |

All tiers include every feature; tiers differ only on volume. Combined with commercial use
being permitted by default, nothing we need is paywalled.

**Bulk pricing is billed per REQUEST, not per card.** Verified against their own usage
dashboard: a `POST /v1/pricing/` carrying 5 `card_ids` registered as **1 billable call** —
identical to a single-card `GET /v1/pricing/{id}`. `GET /v1/subscription/` is explicitly
free (11 reads, 0 billable). Catalog search is billable.

*Confidence:* the per-request behaviour is measured. **Extrapolating to 100 cards = 1 call
is not** — the test used 5. Re-measure at 100 before depending on it.

Consequences:
- Free tier ≈ **75,000 card lookups/month**; Pro ≈ **500,000**
- A 500-card collection triage ≈ **5 calls**; a 12-card pack ≈ **1 call**
- V1 today spends **5 sequential calls to price one card** ([server.js:190](server/server.js#L190))
- **The screener's blocker is legal, not economic.** Call cost was never going to stop us
  ranking a market; ToS §3.c still might.

The usage dashboard breaks down billable vs free per route and exports CSV — worth checking
periodically once live to catch a runaway loop.

### Known gaps in CardSight

- **Population endpoints exist but return no data.** `/v1/population/card/{card_id}`,
  `/set/{set_id}`, `/release/{release_id}` are in the spec and are **ungated on the free
  tier** (HTTP 200, not 403) — but every card tested returns `total_population: 0`, across
  Pokémon and sports, vintage and modern. Not usable today. **Verified 2026-08-03.**
- **So sales-by-grade is all we get, and it is *not* population.** `PSA 10: 87, PSA 9: 68`
  does **not** imply a 56% gem rate — those are cards people chose to *sell*, layered on top
  of the submission bias in §4a. Two stacked selection effects. **Do not use sales counts as
  a gem rate proxy.** Pop data still has to come from GemRate (or PPT).
- **Pipeline is in beta**, self-disclosed: "some listings remain unmatched while the model
  learns." Match completeness unproven — and match quality is what we care most about.
- **No bulk dumps.** Bulk-per-request pricing makes this much less painful than assumed, but
  we still can't hold a local snapshot (ToS §3.c).
- **Docs contradict themselves on rate limits.** API reference says Pro 4/s, Premium 6/s,
  Ultra 8/s; the pricing page says Free 4, Pro 6, Premium 8, Ultra 10 — shifted by a tier.
  Don't design against either without confirming.

### Also in the spec, unverified

78 endpoints total. Beyond pricing and population: `Grades`, `Marketplace`, `Release
Calendar`, `Feedback`, **`Collection Management`** and `Collection Card Images`.

They offer server-side collections. That cuts both ways — less to build, but building
accounts and collections in Postgres *is* Slice 5's resume rep. Likely answer: their catalog
and pricing, our collection storage.

`/v1/catalog/parallels` is marked "(free)" in the spec, and card images plus autocomplete
don't count toward usage — so variant disambiguation (§3) may cost nothing. Not measured.

Local copy of the spec: `cardsight-openapi.json` (480KB). Swagger UI at
[api.cardsight.ai/documentation](https://api.cardsight.ai/documentation).

### Alternatives (kept, not chosen)

| Option | Terms | Cost | Why not primary |
|---|---|---|---|
| PokemonPriceTracker | Commercial = Business tier only | $99/mo | Pokémon only. Grade ladder truncated to 8/9/10. Pop data is licensed GemRate. Ships a competing (and broken) ROI tool. Does have daily dumps + 200k credits/day. |
| SportsCardsPro / PriceCharting | **Unstated — must confirm** | $49/mo Legendary | Sports only. API + CSV regenerated every 24h. **Current values only — no historic prices or sales**, so no `n`, no Wilson intervals. Legacy video-game grade keys (`loose-price`, `cib-price`, `new-price`, `box-only-price`=9.5, `bgs-10-price`) need careful mapping. Also ships "Grading Recommendations" across a user collection at $6/mo. |
| CardHedge | — | ~$1,000/mo both categories | Too expensive pre-revenue. Unchanged from original analysis. |
| Scraping SportsCardsPro | Prohibited | — | Never necessary — they sell the data. Moot. |
| eBay Marketplace Insights | **Dead end — abandon** | — | Docs: "restricted and not open to new users at this time." Developers report being told access is for major partners only. 90-day window. **Remove as a blocker on sports.** |

### Verify on the free tier BEFORE paying

1. Run 20 known cards, spread across easy-to-confuse variants (1st Ed vs Unlimited, reverse
   holo vs standard, same card across sets). **Write the pass/fail tolerance down before
   looking at results.**
2. Confirm per-grade `n` and ranges are present and populated, not null
3. Confirm parallel IDs actually separate variants that PPT collapses
4. Confirm sports coverage depth matches Pokémon coverage depth
5. Email CardSight: **(a) paid tier pricing, (b) does any paid tier permit retaining a
   full-genre price snapshot for ranking purposes?** If yes at a sane price, the screener and
   the dump architecture both come back.

---

## 3. Architecture — where the new API integrates

### Seam 1 — `getPriceStats()` · [server.js:15](server/server.js#L15)

The only function touching a pricing source. Everything downstream consumes its
`{ median, sampleSize, totalAvailable }` shape (`avg`/`count` are back-compat aliases the
frontend still reads). Becomes a CardSight call returning raw records we reduce ourselves.
Signature can survive; body is thrown away.

### Seam 2 — `/api/comps` · [server.js:146](server/server.js#L146)

Currently fires **five sequential upstream calls** per card (lines 151-155). CardSight
returns the full per-grade breakdown in one response, and bulk-100 collapses a whole
collection or pack into a handful of calls.

### Seam 3 — `gemRateToProbabilities()` · [server.js:92](server/server.js#L92)

Replaced entirely. See §4.

### Also affected — `/api/search` · [server.js:137](server/server.js#L137)

The `Map`-based dedup at [server.js:161](server/server.js#L161) keys on `title` alone. That
is the failure mode that quietly makes every downstream number wrong — PPT demonstrably has
it, listing `MEWTWO · 1ST EDITION HOLOFOIL` and `MEWTWO · UNLIMITED HOLOFOIL` at identical
prices. CardSight returns parallel IDs; use those instead. Below a confidence threshold the
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

Note the compounding hazard: CardSight's sales-by-grade adds a *second* selection effect on
top (what people chose to sell). Never treat it as pop data.

### 4b. Sample size is the confidence signal

42% across 1,000 submissions is solid. 82% across 5 is noise.

**Requirement:** store `n` alongside every percentage. **Wilson confidence intervals.**
Display a confidence badge. Return a band, not a point estimate. CardSight supplies per-grade
`n` and low-to-high ranges directly — this is now buildable.

This is also the visible differentiator: the broken competitor cannot show how sure it is.

### 4c. The grade ladder — mostly resolved

**Correction to the earlier draft:** `gradesAscending` at
[server.js:58](server/server.js#L58) is derived from `Object.keys(gradeValues)` and already
adapts to whatever grades it's handed. A truncated ladder does **not** break `calculateROI`'s
loops. The actual break is narrower:

- `gemRateToProbabilities` hardcodes a `7` key
- if `gradeValues` contains a grade `probabilities` lacks, line 41 sums `undefined` → `NaN`
  propagates all the way to the verdict. **Add the guard.**

CardSight returns down to PSA 4, so truncation stops being a constraint. Auth-only outcomes
and qualifiers come from their slab reader.

### 4d. Cross-grader divergence

Same 1989 Griffey: **PSA 16.0%, Beckett 21.5%, SGC 9.3%.** A 2.3x spread. Turns the product
from *"should I grade this"* into *"should I grade this, and with whom."*

**Requirement:** the probability model takes a **grader** parameter. Signature change that
ripples through `/api/comps` and the UI — decide before writing the function.

Note: Slabfy already ships multi-grader comparison (PSA 7-10, BGS 9.5, SGC 10), so this is
table stakes rather than a differentiator. CardSight supplies PSA/SGC/BGS/CGC/ISA/TAG.

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

| # | Slice | Notes |
|---|---|---|
| 0 | ~~Bug fixes~~ **DONE 2026-08-03** | §5. Median, `count` semantics, `multiplier` guard, `\|\| default` zero-eating. Baseline diff still owed. |
| 1 | React port | Scaffold Vite + React in `client/`. Hand-write `SearchBar` + `PickList` against existing `/api/search`. No backend changes. |
| 2 | **Postgres + CardSight integration** | Rewritten — see below. |
| 3 | Probability model rewrite | §4. Haircut, Wilson intervals, grader parameter. The real engineering. |
| 4 | Investment screener | See below. Promoted — this is where correctness becomes visible. |
| 5 | Auth (bcrypt/JWT) | Accounts + saved collections. Unlocks §7. Also triggers the ToS deliverable from §2. |
| 6 | Collection triage | Which of your saved cards to grade, plus the Monte Carlo "grade everything worth grading" number. Depends on 2, 3, 5. See rewrite below. |
| 7 | Pack Opener | Enter pack price + cards pulled → total raw value, profit vs pack cost, per-card flags. Bulk-100 makes it one call. Frontend candy — **timebox hard, cut first.** |

### Collection architecture — MEASURED 2026-08-06

Supersedes the CardSight-era assumptions below. All numbers measured against live
CardHedge and GemRate keys; see `CARDHEDGE_EVAL.md` for the full evaluation.

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

CardSight §3.b/§3.c forbid a standalone catalog or a full-genre subset. Postgres role
changes accordingly.

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

---

## 7. The only real moat

**Collect actual submission outcomes from users** — what they sent, what came back.

Unbiased in exactly the way pop reports are not (§4a), does not exist publicly, compounds
over time, and no API subscription replicates it. **It is also our own data, entirely outside
CardSight's storage restrictions.** Strongest argument for accounts sooner rather than later.

Confirmed unoccupied: no crowdsourced submission-outcome database found anywhere. PSA's Pop
Report is official, not an unbiased sample.

Honest caveat: it's a cold-start network effect and needs sustained volume — the thing a new
tool has least of. Long game, not a launch feature.

---

## 8. Flight prep — offline work

**Before boarding, save 3-5 sample CardSight responses to disk:**

- [ ] one card's full per-grade breakdown (`GET /v1/pricing/{card_id}?period=30d`)
- [ ] one bulk request covering ~10 cards
- [ ] one search result showing parallel IDs on confusable variants
- [ ] one sports card + one Pokémon card, to compare shapes across categories

Then the flight is all hard thinking, zero network:

- [ ] Schema design against real response shapes — respecting the §3.c caching boundary
- [ ] The normalization layer — CardSight's shape → our shape
- [ ] The §5 bug fixes
- [ ] The probability model rewrite (§4) — haircut, Wilson intervals, grader parameter

Also capture a **golden baseline** of current `/api/comps` output for ~10 cards before
touching Slice 0, so the median change is a readable diff. No tests in the repo today.

---

## 9. Open questions

- [ ] **Does any paid tier permit a full-genre snapshot for ranking?** The one remaining
      CardSight email question. Decides whether the screener ranks the market or a candidate
      set. (§2, §6)
- [ ] **Is CardSight's population data coming?** Endpoints are live and ungated but empty.
      Worth asking — if it lands, GemRate drops out of the plan entirely.
- [ ] Confirm bulk billing at **100** cards, not just 5. (§2)
- [ ] Where does pop data come from until then — GemRate, or PPT alongside CardSight?
- [ ] What confidence threshold triggers "not sure which card this is"? (§3)
- [ ] Does CardSight's beta matching hold up on confusable variants? (§2 verification)
- [ ] SportsCardsPro commercial redistribution terms — unstated, needs an email. Only
      matters if CardSight's sports coverage disappoints.
- [ ] Who writes our Terms of Service, and when? Required by CardSight §3.d, lands with auth.

**Resolved 2026-08-03:**
- ~~eBay Marketplace Insights~~ — dead end for indie developers. Abandoned.
- ~~Truncated grade ladder kills grade 7?~~ — CardSight returns to PSA 4. Moot.
- ~~Does monetization conflict with the north star?~~ — **Decided: full scope, monetized,
  promoted hard.** Conscious call, made 2026-08-03.
- ~~What does CardSight cost above the free tier?~~ — Pro $14.95 / Premium $74.95 / Ultra
  $199.95. See §2.
- ~~Does a bulk request cost 1 call or 100?~~ — **Per request.** Measured at n=5 against
  their usage dashboard. Collection triage and the pack opener are both cheap.
- ~~Does `thecardapi.com` sort its results?~~ — **Yes, `date_desc`.** The pagination cursor
  literally declares `"sort": "date_desc"`, and `sale_date` is descending on every query
  while price ordering is ~random. So page 1 is the 25 *most recent* sales, and a median
  over it is recency-weighted rather than price-biased. The Slice 0 median is defensible;
  no pagination work needed for correctness.

---

## 10. Guardrails

- **Every line is AJ's.** V2 exists to close resume gaps (frontend framework, database,
  auth). Code that gets handed over doesn't count. Note CardSight's own marketing pitches
  "build your trading card app in a weekend" with AI tooling — use their API, not their
  weekend.
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

## 12. Distribution

New section. If promotion is half the strategy it needs the same rigor as the slices.

Observable fact: every competitor in this market acquires through **SEO content with a tool
attached** — PreGradeCards, CardZen, TCGTalk, and PPT itself all run this play.

**Launch content we can write and nobody else can:** the §1 audit. "The grading calculators
are ranking by unweighted upside — here's the arithmetic." Original, checkable, and it
demonstrates the product's premise in the act of explaining it.

- [ ] Decide the channel mix — SEO, Reddit (r/PokemonTCG, r/sportscards), TikTok/YouTube?
- [ ] Decide cadence and honest weekly hours alongside two summer classes
- [ ] Write the audit post
- [ ] Decide the launch trigger — which slice must ship before promoting?
- [ ] Waitlist target — the old ~50-signup goal was validation for a premium tier. Restate
      it against the current plan or drop it.

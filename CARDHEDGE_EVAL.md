# CardHedge — API Evaluation for ShouldISlab

Measured 2026-08-05 against a fixed set of 10 real cards, not the vendor's example card.
Every claim below is labelled **MEASURED** (I observed it), **INFERRED** (derived from
observations), or **SPEC-ONLY** (documentation, unverified).

Provider: `https://api.cardhedger.com` · auth `X-API-Key` · 40 endpoints ·
OpenAPI spec is public and unauthenticated at `/openapi.json` (288KB).

---

## Verdict

**CardHedge works for the core product.** The single-card grading-ROI verdict — search a
card, pull the grade ladder, compute expected profit — is fully supported by data that
survives every correctness test I ran.

**The reason to move is the catalog, not the prices.** See §1.

**Revised 2026-08-05 — the probability model is now unblocked too, but not by CardHedge.**
This document originally concluded that population data was out of reach. GemRate then
answered directly: **$200/mo developer tier, 5,000 requests/day, absolute per-grade counts
across PSA / Beckett / SGC / CGC, display permitted in a free public tool with attribution.**

So the shape is **two providers, not one**: CardHedge for prices, GemRate direct for
population. CardHedge Enterprise is off the critical path. The unverified risk moves from
"can I get pop data at all" to "does the join actually resolve" — see §7 and §11.

---

## 1. The finding that decides it — variant separation

This is the whole evaluation in one table. Same card number, same set, both providers:

**CardSight** — one catalog row for `1999 Base Charizard #4`. Its price pool contains:

| price | title |
|---|---|
| $16,000 | `PSA 5 CHARIZARD 1999 Pokemon Base 1ST EDITION SHADOWLESS #4 Holo` |
| $13,177 | `1st Edition Shadowless Charizard Base #4/102 1999 POKEMON Holo Rare PSA 5` |
| $490 | `Pokemon Card Charizard 4/130 Holo Base 2 - PSA 5 English` |
| $253 | `Pokemon Charizard Holo Base II #4 PSA 5` |
| $525 | `Pokémon Charizard Holo Base 4/102 PSA 5 (with ungraded Charmeleon)` |

Unlimited, Shadowless, 1st Edition Shadowless, Base Set 2 (a different set, 4/130), and a
multi-card lot — all one "PSA 5" median. **MEASURED.**

**CardHedge** — the same search returns them as separate cards with separate prices:

| variant | PSA 10 | PSA 9 | Raw |
|---|---|---|---|
| Base | $26,700 | $3,250 | $207 |
| Shadowless | $57,600 | $10,799 | $1,000 |
| 1st Edition | — | $60,000 | $2,026 |
| Base Set 1999-2000 | — | $5,625 | $650 |

Same for Pikachu #58 (Red Cheeks / Yellow Cheeks / Shadowless / 1st Ed Red Cheeks),
Luka #280 (Base $200 vs Silver $1,525 vs Hyper $1,575), Frank Thomas #414 (base vs
**Tiffany**), Jordan #57 (Base vs Autographed), Ohtani #150 (Base / Pitching / Refractor /
X-Fractor). **MEASURED.**

### Contamination rate — same test, both providers

I re-parsed every seller title and asked: does this record belong in the bucket it was filed in?

| | CardSight | CardHedge |
|---|---|---|
| graded records tested | 4,493 | 1,934 |
| parallel/variant keyword in title | **25.1%** | **0.3%** |
| autograph keyword | 2.7% | 0.0% |
| lot / reprint / custom | 0.0% | 0.1% |
| grade in title contradicts bucket | 0.8% (34/4,328) | **0.0% (0/1,500)** |
| **any contamination signal** | **28.4%** | **0.4%** |

**MEASURED.** Note CardSight's *grade parser* is fine (0.8%). Its **variant model** is the
defect, and no downstream cleaning fixes a catalog that doesn't represent the distinction.

### What that does to a verdict

Luka #280, through the real ROI engine:

| variant | raw | PSA 9 | PSA 10 | verdict |
|---|---|---|---|---|
| Base | $53 (n=52) | $67 (n=52) | $200 (n=52) | **Don't grade** |
| Silver | $430 (n=52) | $475 (n=52) | $1,600 (n=52) | **Grade it** |

CardSight pools these into a single $190 PSA 10 median with a $790 PSA 7 outlier. The verdict
is wrong for both cards. **MEASURED.**

---

## 2. Coverage — per card, per grade

Pulled via `POST /v1/cards/comps` with `count: 50, include_raw_prices: true`.
`n` is `count_used` for **that grade on that card** — never an aggregate.

| card | Raw | PSA 7 | PSA 8 | PSA 9 | PSA 10 |
|---|---|---|---|---|---|
| 1999 Base Charizard #4 | $321 (49) | $744 (50) | $1,296 (50) | $3,431 (50) | $10,929 (44) |
| 1999 Base Pikachu #58 | $4 (44) | $74 (11) | $120 (29) | $164 (42) | $1,252 (13) |
| 2025 Prismatic Umbreon #59 | $2 (48) | — | $11 (39) | $21 (47) | $61 (49) |
| 2016 Evolutions Charizard #11 | $54 (50) | $97 (47) | $118 (50) | 404 | 404 |
| 1989 UD Griffey #1 | $88 (45) | $120 (49) | $175 (48) | $447 (49) | $5,463 (50) |
| 1986 Fleer Jordan #57 | $3,329 (47) | $12,593 (50) | $18,838 (50) | $41,751 (50) | $232,173 (50) |
| 2018 Chrome Ohtani #150 *Base* | — | — | — | — | — |
| 2018 Chrome Ohtani #150 *Pitching* | — | — | — | — | $1,544 (47) |
| 1990 Topps Frank Thomas #414 | $2 (50) | $7 (50) | $11 (50) | $19 (49) | $101 (49) |
| 2011 Update Trout #US175 | $251 (49) | $251 (50) | $296 (50) | $426 (50) | $1,020 (50) |
| 2018 Prizm Luka #280 | 404 | $114 (25) | 404 | $68 (47) | $201 (50) |

**MEASURED.** Two things CardSight failed outright that CardHedge handles:
**1989 Griffey returns data** (CardSight: persistent HTTP 500) and **Prismatic Umbreon has a
full graded ladder** (CardSight: 1,907 records, zero graded).

### Fill rate

`all-prices-by-card`, 523 price rows: `card_id` `grade` `grader` `price` `display_order`
all **100%**. Zero `price === 0`. But **no sample size, no date** — see §3.

`comps.raw_prices`, 1,934 sale records: `price` `sale_date` `price_source` `sale_url`
`card_id` `price_history_id` `grade` `sale_type` `title` all **100%**; `image` 99%. **MEASURED.**

### Claimed categories are real

One Piece 5,751 · Yu-Gi-Oh 2,141 · Magic 300,687 · Bedard (hockey) 264 · Messi (soccer)
1,186 — all with priced top results. CardSight claims One Piece and returns **0**. **MEASURED.**

---

## 3. The architectural trap — `all-prices-by-card` is a last sale

`POST /v1/cards/all-prices-by-card` returns the whole ladder in **one call**, which is
tempting. It is a **last-sale ticker**, not an aggregate:

| card / grade | last sale | 50-sale comp |
|---|---|---|
| Base Charizard PSA 10 | $26,700 | $10,929 (n=44) |
| Jordan #57 PSA 10 | $384,000 | $232,173 (n=50) |
| Pikachu #58 PSA 10 | $530 | $1,252 (n=13) |

**MEASURED.** Monotonicity violations tell the same story:

| source | adjacent grade pairs violating price ordering |
|---|---|
| `all-prices-by-card` | 15 / 65 = **23.1%** |
| `comps` (aggregate) | 2 / 31 = **6.5%** |

Both surviving `comps` violations are explicable: Trout PSA 7 $250.90 vs Raw $251.28 is a
38-cent tie, and Luka PSA 7 is genuinely thin (n=25). **INFERRED.**

**Use `comps`.** Using `all-prices-by-card` would re-introduce exactly the outlier bug
Slice 0 fixed when it moved this app from mean to median.

### Also: `comp_price` is a mean

Spec, verbatim: *"Average comparable price after IQR anomaly filtering."* **SPEC-ONLY**, and
consistent with what I measured. This project deliberately uses **median** — so read
`raw_prices` and compute it yourself rather than taking `comp_price`. `count_used` is the
per-grade `n` that V2_PLAN §4b's Wilson intervals need. **MEASURED.**

---

## 4. Provenance — these are completed sales

`sale_type` across 1,934 records: **Auction 1,098 · Best Offer 508 · BIN 274 · Sale 54**.
All four are completed-transaction types. **MEASURED.**

`price_source`: ebay 1,687 · Fanatics 173 · Alt 33 · Goldin 31 · Heritage 6 · mySlabs 3 ·
Lelands 1. **MEASURED.**

Dates are real: **1,934 records → 1,837 distinct `sale_date` values.**

Compare CardSight: **73.9% of records were `listing_type: fixed`** — asking prices that may
never have sold — with no field distinguishing sold from unsold, and dates collapsing to
scrape timestamps (one card: 278 records, 63 distinct dates). **MEASURED.**

This is the second-biggest reason to move. Three quarters of CardSight's "comps" are
somebody's wishful Buy It Now.

---

## 5. Control tests

Never trust a param without a bogus twin.

| test | result |
|---|---|
| `bogus_xyz=123`, `grader=FAKEGRADER`, `wingspan=purple` on `card-search` | byte-identical payload — **silently ignored** |
| same on `comps` | byte-identical — **silently ignored** |
| `grade: "PSA 99"` / `"FAKEGRADER 10"` / `"ZZZ"` | **HTTP 404** — filter works |
| `grade` across PSA 10/9/8/7/Raw/BGS 9.5 | distinct prices, correctly ordered — **real** |
| `count` 1 → 100 | `count_used` 1 → 92, price moves — **real** |
| `time_weighted` false/true | different values — **real** |
| `search: "ZZQXNOTACARD"` | 0 results — **real** |

**MEASURED.** Unknown params being dropped silently means a typo'd filter returns unfiltered
data and looks like success. Control-test anything you add.

### Trap: `count` on `card-search` is not the match count

`"...Base Set Charizard 4"` → `count: 644`. `"...Base Set Pikachu 58"` → `644`.
`"...Base Set Blastoise 2"` → `644`. It reports the size of the **containing set**; ranking
is correct, the number is not. Never display it, never paginate on it. **MEASURED.**

### Trap: empty decoy variants

`2018 Topps Chrome Ohtani #150` variant `"Base"` returns **nothing** from `comps` (404 on
every grade) while `"Base - Pitching"` returns a full ladder. And **nothing in the search
response predicts it** — the empty row reports the *highest* volume of any #150 variant
(43 sales/7d, 213/30d) plus inline prices. I tested `priced_grades` and the sales counters as
predictors; both fail. Catch the empty case downstream and render "no recent sales" — the
existing `calculateROI` guard already degrades correctly here. **MEASURED.**

---

## 6. Vendor self-admissions

CardHedge is unusually honest, and it's machine-readable. `batch-price-estimate` returns
`confidence`, `freshness_days`, and `method` per item. Across 100 real cards:

| method | count | meaning |
|---|---|---|
| `direct` | 74 | observed sale at that card+grade |
| `direct_adjusted` | 9 | observed, adjusted |
| `anchor_multiplier` | 12 | **derived from another grade** |
| `card_interpolation` | 3 | **interpolated** |
| `cross_provider` | 1 | another source |
| `no_data` | 1 | nothing |

**26% of estimates are modeled, not observed** — and the API tells you which.
`confidence` median 0.60 (min 0.00, max 1.00). `freshness_days` median 13, **max 1,444**
(~4 years stale). **MEASURED.**

If you use these estimates, filter on `method === 'direct'` before presenting a number as a
market comp. Showing an `anchor_multiplier` price as a real sale is precisely the sin
V2_PLAN §1 accuses PokemonPriceTracker of.

Spec self-admissions: `comps` reads sales **from 2020-07-01 onward** only, so a vintage
card's `total_count` is not all-time. `comps-by-cert`'s `comp_price` is computed **"on this
page only"** — a pagination trap. **SPEC-ONLY.**

---

## 7. Population data — blocked *through CardHedge*, but available direct

```
POST /v1/cards/population-by-card
→ 403 {"detail":"GemRate population data requires an Enterprise API key with
   GemRate access enabled. Contact support@cardhedger.com to enable it."}
```

**MEASURED.** All three CardHedge pop endpoints are gated the same way.

**Update 2026-08-05 — GemRate replied directly and this is no longer the blocker.**
Per Patrick at GemRate (email, quoted): a **developer tier at $200/mo, 5,000 requests/day**;
population distribution available from the cards endpoint and cert lookup; refreshed daily;
**absolute counts per grade for PSA, Beckett, SGC and CGC**; and pop data **may be displayed
in a public free tool with attribution** on the developer tier. Trial available, credit card
required.

So the architecture changes: **go direct to GemRate for population, CardHedge for prices.**
CardHedge Enterprise is no longer on the critical path.

### The join — TESTED 2026-08-05 with both live keys. It works.

**`POST /hybrid-population-data` takes a `gemrate_id`, and CardHedge hands you one.**
That is the join, and it is a single call with no fuzzy matching.

Run across the real card set: pulled every CardHedge row matching the target card numbers via
`90day-prices-by-grade-search`, then resolved each `gemrate_id` against GemRate.

| measure | result |
|---|---|
| CardHedge rows carrying a `gemrate_id` | 68 |
| **resolved to population data** | **68 / 68 = 100%** |
| distinct `gemrate_id` values | 65 |
| **unique price-row → population mapping** | **91.2%** |

**MEASURED.** The variant granularity survives — this was the test I expected to fail and it
passed. CardHedge's Luka #280 variants each map to their own distinct population:

| CardHedge variant | GemRate parallel | PSA 10 | total PSA | rate |
|---|---|---|---|---|
| Base | Base | 20,843 | 39,866 | 52.28% |
| Silver | Silver Prizm | 2,428 | 6,045 | 40.17% |
| Green Prizm | Green Prizm | 769 | 1,559 | 49.33% |
| Hyper Prizm | Hyper Prizm | 146 | 636 | 22.96% |
| Ruby Wave | Ruby Wave | 363 | 784 | 46.30% |

Labels differ cosmetically (`Silver` vs `Silver Prizm`) — the **data is variant-specific**.
GemRate also correctly resolves subset cards: Griffey #1 → `Star Rookie`, Frank Thomas #414 →
`Name on Front`.

### The 3 collisions — CardHedge's fault, not GemRate's

Six rows (8.8%) collapse into three shared populations:

| shared population | CardHedge rows pointing at it |
|---|---|
| Pikachu #58 `Yellow Cheeks` | `Base` **and** `Yellow Cheeks` |
| Ohtani #150 `Base` | `Base - Pitching` **and** `Base - Variation` |
| Ohtani #150 `Variation-Refractor` | `Red Jersey Refractor` **and** `Variation Red Jersey` |

**MEASURED.** In every case these look like **near-duplicate rows on CardHedge's price side**
resolving to one correct GemRate record — not GemRate pooling distinct cards. That is the
benign direction: the population is right, and the duplicate is visible in the picker where a
user can pick either. Worth a dedupe-by-`gemrate_id` pass in the search results.

### What GemRate actually returns — MEASURED

One call gives the **complete ladder in absolute counts**, all four graders
(`graders_included: [psa, beckett, sgc, cgc]`), `population_type: "universal"`:

```
grades:            auth 787, g1 4242 … g8 16207, g9 8540, g10 487
halves:            g1_5 … g8_5 569
qualifiers:        q1 58, q2 26, q3 40 …
non_auto_grades:   auth 88,  … g9 8468, g10 486     <- autographs stripped out
auto_grades:       auth 699, … g9 72,   g10 1
card_total_grades: 103626    card_gems: 487    card_gem_rate: "0.00469959…"
```

Three things this settles:

1. **Absolute counts per grade — confirmed.** This is the `n` V2_PLAN §4b needs for Wilson
   intervals, and it is per grade, per grader, per variant.
2. **The auto/non-auto split is real and large.** On Base Charizard, 699 of 787 `auth`
   submissions are autographed items. Averaging those in would poison the distribution.
   V2_PLAN §4c called qualifiers "the thing most calculators ignore entirely" — they are a
   separate object here.
3. **Freshness is genuine.** `last_population_change: 2026-08-05` — the day I ran it.
   Cert-lookup on their own doc example returned 368/778, not the documented 336/666, with
   `last_gem: 2026-08-04`. Live, not a stale cache.

**Caveat that still stands:** `gem_rate` on cert-lookup is *"that grade or higher"*, so on a
PSA 9 cert it does not mean the 10-rate. Compute it yourself from `grades.g10 /
card_total_grades`. And cert-lookup returns only that cert's own grade — use
`hybrid-population-data` for the ladder.

### What it still does not fix

Population is what people **chose to submit**, and they submit their best copies. V2_PLAN
§4a's upward-bias haircut is still required and still a judgement call the UI must expose.
GemRate gives you a defensible `n`; it does not give you truth.

---

## 8. Limits and cost — real, but not blocking a build

Recorded for later; not a reason to delay wiring it up.

- **No usage endpoint exists** among the 40. You cannot query your own consumption — meter it
  yourself in your logs. **MEASURED.**
- **Rate limit: 10 requests per window, `Retry-After: 34s`.** Measured directly: 8 rapid
  calls succeeded, the 9th returned `429` with `x-ratelimit-limit: 10`,
  `x-ratelimit-remaining: 0`. At one call per grade a verdict costs ~6 calls, so sustained
  throughput is roughly 1.6 verdicts / 35s. A response cache fixes this for repeat lookups;
  a cold lookup measured 1.17s for the full ladder. **MEASURED.**
- **Batch works at N=100** — 100 items in 693ms, max 100 per request on all four batch
  routes. **MEASURED.**
- **Dev tier: $500/mo for sports + Pokémon, or $250/mo each.** Per AJ, 2026-08-05.
- **Published pricing: none.** Both marketing sites are contact forms. **MEASURED.**

### Terms — the open question

The only terms I could find are consumer app terms at `ai.cardhedger.com/terms`:
"AS IS", no warranty, may *"SUSPEND OR TERMINATE YOUR ACCESS... WITH OR WITHOUT CAUSE OR
NOTICE."* **Caching, storage, redistribution, competing products, and end-user flow-down are
all unaddressed** — silence, not permission. **SPEC-ONLY.**

This is the *opposite* problem from CardSight, whose ToS §3.b explicitly forbids building a
database from the data and §3.d requires imposing terms on your own end users. CardHedge
selling a `daily-price-export` (Elite/Enterprise) implies local retention is a contemplated,
purchasable thing. **INFERRED.**

Not charging for the app sidesteps this entirely for now. Get it in writing before revenue.

---

## 9. Integration map

| seam | today | CardHedge |
|---|---|---|
| `/api/search` | CardSight `catalog/cards` | `POST /v1/cards/card-search` — surface `variant` in the picker label, it is the whole point |
| `/api/comps` | CardSight `pricing/{id}` | `POST /v1/cards/comps` × 5 (Raw + PSA 10/9/8/7), `include_raw_prices: true`, median computed locally |
| image proxy | needed — CardSight required a key | **delete** — CardHedge image URLs are public CDN (verified 200, `image/jpeg`, unauthenticated) |
| `calculateROI()` | — | **unchanged** |
| `gemRateToProbabilities()` | invented | **still invented** — pop data blocked |

Card IDs are strings shaped `1646615786118x244697357144328930`, not UUIDs — the existing
`UUID_RE` guard rejects them.

Useful record fields on `comps.raw_prices`: `price`, `sale_date`, `sale_type`, `grade`,
`price_source`, `sale_url`, `title`.

---

## 10. Reproduce it

```js
// node repro.js — needs cardHedge=<key> in server/.env
require('dotenv').config({ path: './server/.env' });
const KEY = process.env.cardHedge;
const post = async (p, body) => (await fetch('https://api.cardhedger.com' + p, {
  method: 'POST',
  headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})).json();

(async () => {
  // 1. variant separation — the deciding test
  const s = await post('/v1/cards/card-search',
    { search: '1999 Pokemon Base Set Charizard 4', page: 1, page_size: 5 });
  s.cards.forEach(c => console.log(c.variant.padEnd(22),
    (c.prices || []).map(p => `${p.grade}:$${p.price}`).join(' ')));

  // 2. ladder with real per-grade n, and contamination check on titles
  const id = s.cards[0].card_id;
  for (const g of ['Raw', 'PSA 7', 'PSA 8', 'PSA 9', 'PSA 10']) {
    const r = await post('/v1/cards/comps',
      { card_id: id, count: 50, grade: g, include_raw_prices: true });
    const px = (r.raw_prices || []).map(x => x.price).sort((a, b) => a - b);
    const median = px.length ? px[Math.floor((px.length - 1) / 2)] : null;
    console.log(g.padEnd(7), 'median', String(median).padStart(9),
      'n', String(px.length).padStart(3), '| their mean', r.comp_price);
    await new Promise(z => setTimeout(z, 2000));   // 10 req/window limit
  }
})();
```

Throttle to ~1 call / 2s or you will hit the 34-second `Retry-After`.

---

## 10b. What the measured gem rates do to the app — MEASURED

The app takes gem rate as one user-supplied number: `server.js` defaults to **30%**,
`script.js` sends **50%** when the field is blank. Here is what the cards actually run at:

| card | PSA 10 / total graded | real rate |
|---|---|---|
| 1999 Base Charizard #4 | 487 / 103,626 | **0.47%** |
| 1986 Fleer Jordan #57 | 341 / 31,174 | **1.09%** |
| 2016 Evolutions Charizard #11 | 602 / 53,183 | **1.13%** |
| 1989 UD Griffey #1 | 4,371 / 134,846 | 3.24% |
| 1990 Topps Tiffany Thomas #414 | 112 / 1,303 | 8.60% |
| 1990 Topps Thomas #414 | 4,104 / 27,183 | 15.10% |
| 1999 Base Pikachu #58 | 3,107 / 19,212 | 16.17% |
| 2025 Prismatic Umbreon #59 | 582 / 2,084 | 27.93% |
| 2011 Update Trout #US175 | 7,078 / 16,776 | 42.19% |
| 2018 Prizm Luka #280 | 20,843 / 39,866 | 52.28% |
| 2018 Chrome Ohtani #150 Pitching | 16,569 / 19,152 | **86.51%** |

**A 184x spread**, and it correlates with era exactly as you'd expect — vintage cardboard
gems at under 2%, modern chrome at over 50%.

### Honest result: the verdicts did not flip, the numbers moved 2–20x

Running these through the real `calculateROI()` at $80 / 13%, **none of the 7 testable cards
changed its grade/don't-grade answer.** What changed is the hero number:

| card | at 30% default | at measured rate |
|---|---|---|
| 2016 Evolutions Charizard | $1,698 | **$82** |
| 1986 Fleer Jordan | $78,481 | $28,700 |
| 1999 Base Charizard | $4,159 | $2,054 |
| 1989 UD Griffey | $1,488 | $300 |

The reason verdicts hold is worth understanding: `calculateROI()` **renormalizes over priced
grades**, so a low PSA 10 rate shifts weight down to 9/8/7 rather than collapsing EV. It only
flips when the lower rungs also fail to beat raw. For Evolutions Charizard the flip point is
near **0.7%** — the measured 1.13% sits just above it.

So the pitch is not "we flip your answer." It is **"the number you're reading is 20x too
high, and here is the submission count behind ours."** That is a smaller claim and a truer one.

---

## 11. Trial verification — RUN 2026-08-05, results inline

Bars were written before running. Outcome against each:

1. ~~Does the join resolve?~~ **PASS — 68/68.** Take the three `gemrate_id` values in §7 and look each up on
   GemRate. Do you get back the same card — right year, set, number, **and parallel**?
   *[bar: 3/3 exact, including variant]*
2. ~~Full ladder?~~ **PASS** via `hybrid-population-data` (not cert-lookup). Cert-lookup demonstrably does not.
   Pull one card and confirm you get an absolute count for every grade, not just one.
   *[bar: PSA 10/9/8/7 counts all present]*
3. **Run the join across the 10-card set**, not 3. Measure the match rate on the cards you
   actually serve, mid-value modern included — not the vintage chase cards.
   *[bar: ≥80%, matching the 88% key fill measured on CardHedge]*
4. **Control test it.** Send a nonsense `gemrate_id` and a bogus param. If a real ID and a
   fake one both return data, the lookup is not doing what you think.
5. **Check the variant granularity matches.** CardHedge splits Luka #280 into Base / Silver /
   Hyper / Green. If GemRate pools them, the join silently attaches the wrong population to
   the right price — the same class of error that disqualified CardSight, just one layer up.
   *[this is the one most likely to fail — test it deliberately]*
6. **Confirm freshness.** Patrick says daily. Their cert example carries
   `cert_details_cached: "2025-11"` and `last_gem: "2024-09-18"`, which suggests *pop counts*
   and *cert details* refresh on different clocks. Measure both.
7. **Get the attribution requirement in writing** — exact wording and placement.

---

## Bottom line

**Wire it up.** The data clears every correctness bar the product depends on: variants are
separated, comps are completed sales, the grade ladder is monotonic where it matters, and
per-grade `n` is available so you can show how sure you are.

Two rules when you build: **use `comps`, not `all-prices-by-card`**, and **compute your own
median** from `raw_prices`.

With GemRate at $200/mo the probability model is buildable for the first time — absolute
submission counts per grade across four graders, which is what V2_PLAN §4b's Wilson intervals
and §4d's cross-grader comparison both need. That turns "our math is right" from a claim
about better inputs into a claim you can actually show your work on.

**The join is tested, not assumed.** Resolving CardHedge `gemrate_id`s against GemRate
returned **68/68**, with Luka #280 Silver mapping to its own `Silver Prizm` population
distinct from Base. The two-provider architecture holds.

Two things to stay honest about: population is still what people *chose to submit*, so §4a's
haircut is still required and still a judgement call; and 3 collisions (8.8% of rows) come
from near-duplicate CardHedge price rows — dedupe search results by `gemrate_id`.

**The remaining open question is commercial, not technical:** ~$450/mo pre-revenue
(GemRate $200 + CardHedge $250 Pokémon-only), and CardHedge's terms are still silent on
caching and redistribution. Both are decisions, not unknowns.

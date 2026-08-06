const express = require('express');
const env = require('dotenv').config();

const app = express();

app.use(express.static(require('path').join(__dirname, '..')));

// Number(x) || fallback can't represent a legitimate 0 — a user entering 0% fees got 13%.
function numOr(value, fallback) {
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

// ===== response cache =====
//
// MEASURED: CardHedge allows 10 requests per ~35s window and answers a 429 with
// Retry-After: 34. One verdict costs up to 7 upstream calls (5 comps + GemRate +
// an FMV gap-fill), so two lookups back to back hit the wall. This is what makes
// the app usable, not an optimisation.
//
// In-memory and per-process only. Not a database and not a snapshot of any
// category — entries expire, nothing is written to disk. CardHedge's published
// terms are silent on retention; keep it to this until that's in writing.
const CACHE_TTL = {
    search: 10 * 60 * 1000,          // queries repeat while someone hunts for their card
    comps:  6 * 60 * 60 * 1000,      // card prices do not move minute to minute
    pop:    24 * 60 * 60 * 1000,     // GemRate recomputes population daily
};
const cache = new Map();

async function withCache(kind, key, produce) {
    const k = `${kind}:${key}`;
    const hit = cache.get(k);
    if (hit && hit.expires > Date.now()) {
        console.log(`CACHE HIT  ${k}`);
        return hit.value;
    }
    const value = await produce();
    // Don't cache a miss — a null population or an empty result should be retried
    // next time rather than pinned for six hours.
    if (value != null) {
        cache.set(k, { value, expires: Date.now() + CACHE_TTL[kind] });
    }
    return value;
}

// Sweep expired entries so a long-running dyno doesn't leak. unref() so this
// timer never holds the process open.
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
}, 15 * 60 * 1000).unref();

// Thrown when upstream rate-limits us. Waiting out a 34s Retry-After inside a
// request leaves the browser on a dead spinner for half a minute — better to fail
// fast and let the user retry when they choose.
class RateLimited extends Error {
    constructor(retryAfterSec) {
        super('upstream rate limit');
        this.retryAfterSec = retryAfterSec;
    }
}

function calculateROI ({ rawValue, gradeValues, probabilities, gradingCost, feePct, belowLadderValue }) {
    // Two different kinds of "missing" get handled separately here, and conflating
    // them is what made this overstate by 74%.
    //
    // 1. A grade with no comp price. We don't know what it's worth, so its odds
    //    are redistributed across the grades we CAN price — never averaged in as
    //    $0. This is the original renormalisation and it stays.
    //
    // 2. Odds that don't sum to 1 because the card can grade BELOW the bottom
    //    rung. That mass is a real outcome, not a gap. Renormalising it away
    //    asserts the card cannot grade under a 7 — on Base Charizard that
    //    silently deletes 58.2% of what actually happens.
    //
    // `|| 0` is load-bearing: a grade with a price but no probability key sums
    // `undefined`, and NaN propagates all the way to the verdict.
    const ladderGrades = Object.keys(gradeValues);
    const pricedGrades = ladderGrades.filter(grade => gradeValues[grade] > 0);

    const ladderProb = ladderGrades.reduce((sum, grade) => sum + (probabilities[grade] || 0), 0);
    const pricedProb = pricedGrades.reduce((sum, grade) => sum + (probabilities[grade] || 0), 0);

    // What it's worth GIVEN it lands on a rung we can actually price.
    let valueOnLadder = 0;
    if (pricedProb > 0) {
        pricedGrades.forEach(grade => {
            valueOnLadder += ((probabilities[grade] || 0) / pricedProb) * gradeValues[grade];
        });
    }

    // Everything below the bottom rung. Valued at the raw price by default: a
    // badly graded card is worth roughly what an ungraded one is, and you've
    // spent the grading fee to find out. Slightly conservative — a PSA 6 Base
    // Charizard is $525 against $306 raw — which is the right direction for a
    // number telling someone whether to spend $80.
    const belowProb = Math.max(0, 1 - ladderProb);
    const belowValue = Number.isFinite(belowLadderValue) ? belowLadderValue : rawValue;

    // When probabilities already sum to 1 across the ladder (the manual /api/verdict
    // path), belowProb is 0 and this reduces exactly to the old behaviour.
    const expectedGradedValue = (1 - belowProb) * valueOnLadder + belowProb * belowValue;

    const netIfGrade = expectedGradedValue * (1 - feePct) - gradingCost;
    const netIfRaw = rawValue * (1 - feePct);
    const expectedProfit = netIfGrade - netIfRaw;

    // gradingCost is user-supplied and may now legitimately be 0.
    const roi = gradingCost > 0 ? expectedProfit / gradingCost : null;

    // Both sides of this ratio can be missing. rawValue is 0 whenever an upstream call
    // failed — unguarded that yields Infinity, meetsRuleOfThumb becomes true, and we
    // confidently say "Grade it!". A missing PSA 10 comp is the mirror image: it would
    // render as a flat 0.0x, which reads like data but means "no comps found".
    const hasRawPrice = rawValue > 0;
    const hasTopGrade = gradeValues[10] > 0;
    const multiplier = hasRawPrice && hasTopGrade ? gradeValues[10] / rawValue : null;
    const recommendedMultiplier = rawValue < 100 ? 3 : 2.5;   // his rule: <$100 raw wants ~3x, >$100 wants ~2.5x
    const meetsRuleOfThumb = multiplier == null ? null : multiplier >= recommendedMultiplier;

    let rawVsGradeOutcome = "No grade beats selling raw";
    const gradesAscending = Object.keys(gradeValues).map(Number).sort((a, b) => a - b);  // [7,8,9,10]
    for (const grade of gradesAscending) {
        const netAtGrade = gradeValues[grade] * (1 - feePct) - gradingCost;
        if (netAtGrade >= netIfRaw) {
            rawVsGradeOutcome = grade;
            break;   // first match in ascending order = the LOWEST break-even grade
        }
    }


    let notLoseMoneyGrading = "No grade gets your money back";
    for (const grade of gradesAscending) {
        const netAtGrade = gradeValues[grade] * (1 - feePct) - gradingCost;
        if (netAtGrade >= 0) {
            notLoseMoneyGrading = grade;
            break;   // first match in ascending order = the LOWEST break-even grade
        }
    }

    let netByGrade = {};
    for (const grade of gradesAscending) {
    netByGrade[grade] = gradeValues[grade] * (1 - feePct) - gradingCost;
    }

    // "No data" is a different answer from "don't grade" — don't collapse them.
    let verdict;
    if (!hasRawPrice) {
        verdict = "No raw sales found — can't compare against grading";
    } else if (expectedProfit <= 10) {
        verdict = "Don't Grade this card";
    } else {
        verdict = "Grade this card!";
    }

    return { expectedGradedValue, netIfGrade, netIfRaw, expectedProfit, roi, verdict, rawVsGradeOutcome, multiplier, meetsRuleOfThumb, netByGrade, notLoseMoneyGrading };
}

// A small helper: gem rate → full probability distribution.
// This is INVENTED — the 70/20/10 split is a guess, and a bad one. Measured
// against 1999 Base Charizard's real pop report it claims 69.6% of non-10s land
// at PSA 9; the true figure is 8.2%. Kept only for /api/verdict, where the user
// hand-enters prices and there is no card to look a population up for.
function gemRateToProbabilities(gemRate) {
  const remaining = 1 - gemRate;      // everything that's NOT a 10
  return {
    10: gemRate,
    9: remaining * 0.7,               // most non-10s land as 9s
    8: remaining * 0.2,
    7: remaining * 0.1,
  };

}

// Real outcome distribution, straight from submission counts.
//
// These are the TRUE odds and they deliberately SUM TO LESS THAN 1 — on Base
// Charizard, 0.5% / 8.2% / 16.2% / 16.9%, totalling 41.8%. The missing 58.2% is
// the chance of grading 6 or below, and calculateROI values it at the raw price
// rather than renormalising it out of existence.
//
// Measured against a fully priced ten-rung ladder ($915 expected graded value):
//
//   renormalised over 7-10 only        $1,587   74% too high
//   sub-7 folded into the PSA 7 rung   $1,094   20% too high
//   true odds, remainder at raw          $842    8% LOW      <- we do this
//
// Erring low is the right direction for a number telling someone whether to
// spend $80, and it needs no extra upstream calls.
//
// Half grades fold DOWN (8.5 counts as an 8) — conservative, worth less than the
// grade above. Qualifiers and `auth` fall into the below-ladder remainder.
// Wilson score interval for a proportion. The point of §4b: 42% across 1,000
// submissions and 82% across 5 are not the same claim, and a bare percentage
// cannot tell them apart.
//
// Wilson rather than the textbook normal approximation because gem rates live at
// the extremes — 0.47% on Base Charizard, 86.5% on Chrome Ohtani — where the
// normal interval produces negative lower bounds and other nonsense.
function wilsonInterval(successes, total, z = 1.96) {
    if (!(total > 0) || !(successes >= 0)) return null;
    const p = successes / total;
    const z2 = z * z;
    const denom = 1 + z2 / total;
    const centre = (p + z2 / (2 * total)) / denom;
    const margin = (z / denom) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
    return {
        low: Math.max(0, centre - margin),
        high: Math.min(1, centre + margin),
    };
}

// §4a — pop reports show the distribution of cards people CHOSE to submit, and
// people submit their best copies. The measured rate is therefore an upper bound
// on what a random copy off eBay will do.
//
// Model: `haircut` is the probability that a given card grades one notch worse
// than the population implies. Mass shifts down a single rung — a would-be 10
// becomes a 9, a 9 becomes an 8 — and whatever falls off the bottom joins the
// below-ladder remainder. One parameter, one sentence to explain, no hidden
// curve fitting.
//
// Default is ZERO. Every number in the table is measured; a non-zero default
// would be an invented adjustment presented as data, which is the "silent fudge"
// §4a explicitly warns against. The control is visible and the user decides.
function applyHaircut(probabilities, haircut) {
    if (!(haircut > 0)) return probabilities;
    const h = Math.min(1, haircut);
    const descending = [...PSA_GRADES].sort((a, b) => b - a);   // [10, 9, 8, 7]
    const out = {};
    let carried = 0;   // mass shifted down from the rung above

    for (const grade of descending) {
        const p = probabilities[grade] || 0;
        out[grade] = p * (1 - h) + carried;
        carried = p * h;
    }
    // `carried` off the bottom rung is simply dropped — it lands in the
    // below-ladder remainder, which calculateROI already values at raw.
    return out;
}

function populationToProbabilities(pop) {
    const g = pop.grades || {};
    const h = pop.halves || {};
    const total = pop.totalPop;
    if (!total) return null;

    const n = (v) => (Number.isFinite(v) ? v : 0);

    // Driven off PSA_GRADES so the ladder and the odds can never drift apart.
    return Object.fromEntries(PSA_GRADES.map(grade => [
        grade,
        (n(g['g' + grade]) + n(h['g' + grade + '_5'])) / total,
    ]));
}
// The browser calls this as GET /api/search?q=... — this route stays GET.
// It's the UPSTREAM call to CardHedge that must be POST; every /v1/cards/*
// route there rejects GET with 405.
app.get('/api/search', async (req, res) =>{
    let card = req.query.q;
    try{
        // 90day-prices-by-grade-search rather than card-search: it returns the same
        // cards PLUS gemrate_id, the join key GemRate's population lookup needs.
        // `grade` is just the lens that makes it return rows — ignore the `price`
        // it comes back with, real comps come from /v1/cards/comps.
        const body = await withCache('search', card.trim().toLowerCase(), async () => {
            const response = await fetch(`https://api.cardhedger.com/v1/cards/90day-prices-by-grade-search`, {
                method: 'POST',
                headers: {
                    'X-API-Key' : `${process.env.cardHedger}`,
                    'Content-Type' : 'application/json'
                },
                body: JSON.stringify({
                    search: card,
                    grade: 'PSA 10',
                    page: 1,
                    page_size: 20,
                }),
            });

            if (response.status === 429) {
                throw new RateLimited(Number(response.headers.get('retry-after')) || 35);
            }
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
            return response.json();
        });

        // Rows come back under `cards`, not `data`.
        // `body.found` is the size of the CONTAINING SET, not the match count —
        // Charizard, Pikachu and Blastoise all report 644 for Base Set. Ranking is
        // correct, that number is not. Log only; never show it, never paginate on it.
        const found = body.cards || [];
        console.log('SEARCH:', card, '→', found.length, 'rows (set size', body.found + ')');

        // The variant IS the point. Base / Shadowless / 1st Edition are different
        // cards at $26.7k / $57.6k / $60k in PSA 10, and pooling them is exactly
        // what made the old provider's numbers wrong. Suppressed when it's "Base"
        // so ordinary cards don't all read "· Base" and drown out the signal.
        // c.set already carries the year ("1999 Pokemon Base Set") — don't prepend it.
        const label = (c) => [
            c.set,
            c.number ? `#${c.number}` : null,
            c.variant && c.variant !== 'Base' ? c.variant : null,
        ].filter(Boolean).join(' · ');

        // Some rows come back as a card_id and a description with every other field
        // null — incomplete catalog records. They render as a blank clickable card
        // with a broken thumbnail, so drop them. Filter on `set`: it drives the
        // label and is present on every usable row.
        // Deliberately NOT filtering on gemrate_id — it is absent on a minority of
        // legitimate cards, and dropping those would lose real results.
        const usable = found.filter(c => c.card_id && c.set);

        // Two rows can point at the same physical card (Ohtani #150 comes back as
        // both "Base - Pitching" and "Base - Variation"). gemrate_id is what makes
        // that visible. Keep the first — rows arrive relevance-ranked. Rows without
        // a gemrate_id are passed through rather than collapsed into one bucket.
        const seen = new Set();
        const deduped = usable.filter(c => {
            if (!c.gemrate_id) return true;
            if (seen.has(c.gemrate_id)) return false;
            seen.add(c.gemrate_id);
            return true;
        });

        // Keys on the LEFT are our contract with script.js (it reads id, title,
        // card_set, image_url). Keys on the right are CardHedge's. They don't
        // have to match, and renaming the left side silently breaks the picker.
        const cards = deduped.map(c => ({
            id: c.card_id,                  // what /v1/cards/comps wants next
            title: c.description,
            card_set: label(c),             // frontend renders this as the sub-line
            card_number: c.number,
            variant: c.variant,
            gemrate_id: c.gemrate_id,       // Phase 3: GemRate population lookup
            image_url: c.image,             // public CDN — no key, no proxy needed
        }));
        res.json(cards);

    } catch (error) {
        if (error instanceof RateLimited) {
            return res.status(429).json({ error: 'busy', retryAfter: error.retryAfterSec });
        }
        console.error('Fetch operation failed', error)

        res.status(500).json({ error: 'Failed to fetch card data'})
   }

});

// Reduce CardHedge sale records to the stats the engine and UI need.
//
// We take the median ourselves rather than using CardHedge's `comp_price`, which
// is a MEAN after IQR filtering. Slice 0 deliberately moved this app off the mean
// because a few high sales dragged it 65% high; taking their average would put
// that bug straight back.
//
// `wantGrade` is a safety net, not a fix — measured 0 mismatches in 1500 records.
// It costs nothing and fails closed.
function statsFromRecords(records, wantGrade) {
    const rows = (records || [])
        .filter(r => Number.isFinite(r.price) && r.price > 0)
        .filter(r => !wantGrade || !r.grade || r.grade === wantGrade);

    const prices = rows.map(r => r.price).sort((a, b) => a - b);
    const sampleSize = prices.length;

    // Even-length: take the LOWER of the two middle values. Conservative on
    // purpose — this number tells someone whether to spend $80.
    const median = sampleSize > 0 ? Math.round(prices[Math.floor((sampleSize - 1) / 2)]) : 0;

    // sale_type is Auction / Best Offer / BIN / Sale — ALL completed transactions.
    // The old auction-vs-ask split existed because 74% of the previous provider's
    // rows were asking prices that may never have sold. That hazard is gone; this
    // is now just colour on how much came from open bidding.
    const auctionCount = rows.filter(r => r.sale_type === 'Auction').length;
    const dates = rows.map(r => r.sale_date).filter(Boolean).sort();

    return {
        avg: median, count: sampleSize,          // aliases the existing frontend reads
        median, sampleSize,
        auctionCount, askCount: sampleSize - auctionCount,
        newestSale: dates.length ? dates[dates.length - 1] : null,
    };
}

const PSA_GRADES = [10, 9, 8, 7];

// An estimate is only allowed to fill a rung when it was extrapolated from at
// least two real grades of the SAME card. Measured on every empty rung across a
// 14-card sweep, this separates cleanly with no overlap:
//
//   support_grades 3  -> card_interpolation, confidence 0.39-0.43, grade B
//   support_grades 1  -> anchor_multiplier,  confidence 0.07-0.10, grade D
//
// The D tier chains cross-provider off year-old anchors ("SGC 9.5 -> SGC 7
// -77.8%, then SGC->PSA x0.79") and is not worth showing. Those rungs stay empty
// and the thin-data warning covers them.
const MIN_SUPPORT_GRADES = 2;

// Fill empty rungs from CardHedge's FMV cascade — ONE batch call for all of them.
//
// This exists because leaving a rung empty is not neutral: calculateROI spreads
// its odds across the grades that DO have prices, and the missing rung is almost
// always the bottom one, so it gets valued like a blend of the grades above it.
// Measured overstatement from that: 1.8x to 4.7x on five of six empty rungs.
// An interpolated estimate is materially closer than the alternative.
//
// Empty rungs are rare and concentrated: 0 of 36 on cards selling 10+ per month,
// 6 of 20 on cards selling 1-9. This is illiquid-card handling, nothing more.
async function fillMissingGrades(cardId, comps) {
    const missing = PSA_GRADES.filter(g => comps['psa' + g].sampleSize === 0);
    if (!missing.length) return [];

    try {
        const response = await fetch('https://api.cardhedger.com/v1/cards/card-fmv-batch', {
            method: 'POST',
            headers: {
                'X-API-Key': `${process.env.cardHedger}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                items: missing.map(g => ({ card_id: cardId, grade: `PSA ${g}` })),
            }),
        });
        if (!response.ok) return [];

        const body = await response.json();
        const applied = [];

        for (const item of (body.results || [])) {
            const grade = Number(String(item.grade_label || item.grade).replace(/[^0-9.]/g, ''));
            const key = 'psa' + grade;
            if (!comps[key] || !Number.isFinite(item.price) || item.price <= 0) continue;
            if ((item.support_grades || 0) < MIN_SUPPORT_GRADES) continue;

            // avg/median keep the frontend working, but sampleSize stays 0 — this
            // is not a sale count and must never be rendered as "n sales".
            comps[key] = {
                ...comps[key],
                avg: Math.round(item.price),
                median: Math.round(item.price),
                estimated: true,
                estimate: {
                    low: item.price_low,
                    high: item.price_high,
                    confidence: item.confidence,
                    confidenceGrade: item.confidence_grade,
                    method: item.method,
                    supportGrades: item.support_grades,
                    freshnessDays: item.freshness_days,
                    // Their own plain-English derivation. Showing this is what makes
                    // an estimate honest rather than a number pretending to be a comp.
                    explanation: item.price_explanation,
                },
            };
            applied.push({ grade, price: Math.round(item.price), confidenceGrade: item.confidence_grade });
        }
        return applied;
    } catch (error) {
        console.error('FMV gap-fill failed', error);
        return [];
    }
}

// CardHedge ids look like 1646615786118x244697357144328930 — not UUIDs.
const CH_ID_RE = /^[0-9]+x[0-9]+$/;

// GemRate ids are 40-char lowercase hex, same on both providers — CardHedge
// hands us one per card, which is what makes this join a single call.
const GR_ID_RE = /^[0-9a-f]{40}$/;

// Real submission counts, replacing a number the user was guessing at.
// Measured spread across ten cards: 0.47% (1999 Base Charizard) to 86.5%
// (2018 Chrome Ohtani Pitching). The app's default was 30-50% for everything.
//
// Returns null on any failure — a missing gem rate must degrade to the user's
// own input, never break the verdict.
async function getPopulation(gemrateId) {
    if (!GR_ID_RE.test(gemrateId || '')) return null;
    try {
        return await withCache('pop', gemrateId, async () => {
        const response = await fetch('https://api.gemrate.com/hybrid-population-data', {
            method: 'POST',
            headers: {
                'X-API-KEY': `${process.env.gemRate}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ gemrate_id: gemrateId }),
        });
        if (!response.ok) return null;

        const body = await response.json();
        const psa = (body.population_data || []).find(g => g.grader === 'psa');
        if (!psa || !psa.card_total_grades) return null;

        // card_gem_rate is card_gems / card_total_grades — verified 0.470% against
        // 487/103626 on Base Charizard. NOTE this is a different field from
        // cert-lookup's `gem_rate`, which means "that grade OR HIGHER" and is not
        // a 10-rate. Same-sounding name, different meaning.
        //
        // card_total_grades counts grades + halves + qualifiers (102412 + 1017 +
        // 197 = 103626). Autographed submissions ARE included; non_auto_grades is
        // available if that ever needs separating, but the denominator has to be
        // swapped with it or the ratio is nonsense.
        const rate = Number(psa.card_gem_rate);
        if (!Number.isFinite(rate)) return null;

        return {
            gemRate: rate,
            psa10Pop: psa.card_gems,
            totalPop: psa.card_total_grades,
            parallel: psa.parallel,            // cross-check: should match the card's variant
            asOf: psa.last_population_change,
            grades: psa.grades,                // {auth, g1..g10}
            halves: psa.halves,                // {g1_5..g8_5}
            qualifiers: psa.qualifiers,        // graded-with-qualifier, worth materially less
        };
        });
    } catch (error) {
        console.error('GemRate lookup failed', error);
        return null;
    }
}

// GET, not POST — script.js calls this with fetch('/api/comps?card_id=...').
// Only the UPSTREAM call to CardHedge is a POST.
app.get('/api/comps', async (req, res) => {
    const cardId = req.query.card_id;
    const gemrateId = req.query.gemrate_id;
    const gradingCost = numOr(req.query.gradingCost, 80);
    const feePct      = numOr(req.query.feePct, 13) / 100;
    const userGemRate = numOr(req.query.gemRate, 30) / 100;
    // §4a submission-bias adjustment. 0 = trust the population as measured.
    const haircut = Math.min(90, Math.max(0, numOr(req.query.haircut, 0))) / 100;

    if (!CH_ID_RE.test(cardId || '')) {
        return res.status(400).json({ error: 'card_id is required' });
    }

    try {
        // One call per grade. `all-prices-by-card` would do the whole ladder in a
        // single call, but it returns the LAST SALE, not an aggregate — on Base
        // Charizard that is $26,700 against a 44-sale comp of $10,929 — and it
        // carries no sample size, so there'd be no `n` to show. For a verdict this
        // app stakes its credibility on, five calls is the right trade.
        // Sequential on purpose: the burst limit is 10 requests per ~35s.
        const startedAt = Date.now();
        const wanted = [['raw', 'Raw'], ...PSA_GRADES.map(g => ['psa' + g, `PSA ${g}`])];

        // Cached as ONE unit including the gap-fill. A half-cached ladder would mix
        // fresh and stale rungs, and the ladder is compared against itself — the
        // whole verdict turns on the gaps between rungs, not their absolute values.
        const comps = await withCache('comps', cardId, async () => {
            const out = {};
            for (const [key, grade] of wanted) {
                const response = await fetch('https://api.cardhedger.com/v1/cards/comps', {
                    method: 'POST',
                    headers: {
                        'X-API-Key': `${process.env.cardHedger}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        card_id: cardId,
                        count: 50,
                        grade,
                        include_raw_prices: true,   // the individual sales, so we median them ourselves
                    }),
                });

                // 404 = no sales at this grade. That is a real answer, not a failure:
                // ~11% of grade cells come back empty, all on illiquid cards. It must
                // render as "no recent sales", never as $0 — and one empty rung must
                // not kill the ladder.
                if (response.status === 404) {
                    out[key] = statsFromRecords([], grade);
                    continue;
                }
                if (response.status === 429) {
                    throw new RateLimited(Number(response.headers.get('retry-after')) || 35);
                }
                if (!response.ok) {
                    throw new Error(`HTTP error! Status: ${response.status}`);
                }

                const body = await response.json();
                out[key] = statsFromRecords(body.raw_prices, grade);
            }

            // Inside the cache: an empty rung is not neutral, calculateROI values it
            // like a blend of the grades above it. Filling happens once per card.
            await fillMissingGrades(cardId, out);
            return out;
        });

        // Read back off the result rather than off the fill call, so this is right
        // on a cache hit too.
        const estimated = PSA_GRADES
            .filter(g => comps['psa' + g].estimated)
            .map(g => ({ grade: g, price: comps['psa' + g].median,
                         confidenceGrade: comps['psa' + g].estimate?.confidenceGrade }));

        // Real submission counts if we can get them, the user's assumption if not.
        // 12% of CardHedge rows carry no gemrate_id, so the fallback is a normal
        // path, not an error case.
        const population = await getPopulation(gemrateId);

        // Real submission counts when we have them; the invented 70/20/10 split
        // only when we don't. These are very different models — on Base Charizard
        // the guess puts 69.6% of non-10s at PSA 9 against a measured 8.2%.
        const measured = (population && populationToProbabilities(population))
            || gemRateToProbabilities(population ? population.gemRate : userGemRate);

        // The haircut only makes sense against a real population. Applying it to
        // a figure the user typed would be discounting their own guess back at them.
        const probabilities = population ? applyHaircut(measured, haircut) : measured;
        const gemRate = probabilities[10];

        const gradeValues = Object.fromEntries(PSA_GRADES.map(g => [g, comps['psa' + g].median]));
        const result = calculateROI({
            rawValue: comps.raw.median, gradeValues, probabilities, gradingCost, feePct,
        });

        // Everything the UI needs to say WHERE the rate came from. Showing a gem
        // rate without its sample size is the thing this whole migration exists to
        // stop doing — 42% across 1,000 submissions and 82% across 5 are not the
        // same claim.
        const gemRateInfo = population
            ? {
                rate: gemRate,                     // after any haircut — what the maths used
                measuredRate: population.gemRate,  // before it — what the pop report says
                haircut,
                source: 'gemrate',
                psa10Pop: population.psa10Pop,
                totalPop: population.totalPop,
                parallel: population.parallel,
                asOf: population.asOf,
                // 95% Wilson band on the measured rate. Narrow on 103,626
                // submissions, wide on 12 — which is the entire point.
                interval: wilsonInterval(population.psa10Pop, population.totalPop),
                // The odds of each outcome, so the UI can show the ladder it's
                // actually betting on rather than just the headline 10-rate.
                probabilities,
              }
            : { rate: userGemRate, source: 'user', probabilities };

        console.log('COMPS:', cardId,
            '→ raw', comps.raw.median, `n=${comps.raw.sampleSize}`,
            '| psa10', comps.psa10.median, `n=${comps.psa10.sampleSize}`,
            '| gem', (gemRate * 100).toFixed(2) + '%', `(${gemRateInfo.source})`,
            estimated.length ? `| est ${estimated.map(e => 'PSA' + e.grade + ':$' + e.price + e.confidenceGrade).join(' ')}` : '',
            `| ${Date.now() - startedAt}ms`);

        // script.js reads data.result and data.comps — both are required.
        res.json({ result, comps, gemRate: gemRateInfo });

    } catch (error) {
        if (error instanceof RateLimited) {
            return res.status(429).json({ error: 'busy', retryAfter: error.retryAfterSec });
        }
        console.error('Fetch operation failed', error);
        res.status(500).json({ error: 'Failed to fetch pricing data' });
    }
});

// Manual fallback: caller supplies the prices, we just run the engine.
app.get('/api/verdict', (req, res) => {
    const rawValue = numOr(req.query.rawValue, 0);
    const gradeValues = {
        10: numOr(req.query.psa10, 0),
        9:  numOr(req.query.psa9, 0),
        8:  numOr(req.query.psa8, 0),
        7:  numOr(req.query.psa7, 0),
    };
    const gradingCost = numOr(req.query.gradingCost, 80);
    const feePct      = numOr(req.query.feePct, 13) / 100;
    const gemRate     = numOr(req.query.gemRate, 30) / 100;
    const probabilities = gemRateToProbabilities(gemRate);
    const result = calculateROI({ rawValue, gradeValues, probabilities, gradingCost, feePct });
    const comps = {
        raw:   { avg: rawValue },
        psa10: { avg: gradeValues[10] },
        psa9:  { avg: gradeValues[9] },
        psa8:  { avg: gradeValues[8] },
        psa7:  { avg: gradeValues[7] },
    };
    res.json({ result, comps });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on ${PORT}`)
});

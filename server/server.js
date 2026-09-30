const express = require('express');
const env = require('dotenv').config();

const app = express();

app.use(express.static(require('path').join(__dirname, '..')));

// /invest without the .html
app.get('/invest', (req, res) =>
    res.sendFile(require('path').join(__dirname, '..', 'invest.html')));

// can't use `Number(x) || fallback` here since 0 is a valid value
function numOr(value, fallback) {
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

// response cache
// CardHedge allows ~10 requests per 35s and one verdict can take up to 7 calls,
// so without this the second search hits the rate limit. In-memory only, entries expire.
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
    // don't cache empty results
    if (value != null) {
        cache.set(k, { value, expires: Date.now() + CACHE_TTL[kind] });
    }
    return value;
}

// clear out expired entries (unref so the timer doesn't keep node alive)
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
}, 15 * 60 * 1000).unref();

// thrown on a 429 so the request fails fast instead of waiting out Retry-After
class RateLimited extends Error {
    constructor(retryAfterSec) {
        super('upstream rate limit');
        this.retryAfterSec = retryAfterSec;
    }
}

function calculateROI ({ rawValue, gradeValues, probabilities, gradingCost, feePct, belowLadderValue }) {
    // grades with no price: spread their odds over the grades we can price.
    // odds that don't add up to 1 = chance of grading below the ladder (handled below).
    // `|| 0` keeps a missing probability from turning everything into NaN.
    const ladderGrades = Object.keys(gradeValues);
    const pricedGrades = ladderGrades.filter(grade => gradeValues[grade] > 0);

    const ladderProb = ladderGrades.reduce((sum, grade) => sum + (probabilities[grade] || 0), 0);
    const pricedProb = pricedGrades.reduce((sum, grade) => sum + (probabilities[grade] || 0), 0);

    // value if it lands on a grade we have a price for
    let valueOnLadder = 0;
    if (pricedProb > 0) {
        pricedGrades.forEach(grade => {
            valueOnLadder += ((probabilities[grade] || 0) / pricedProb) * gradeValues[grade];
        });
    }

    // below the ladder: valued at the raw price, since a low grade is worth about the same as raw
    const belowProb = Math.max(0, 1 - ladderProb);
    const belowValue = Number.isFinite(belowLadderValue) ? belowLadderValue : rawValue;

    // manual /api/verdict odds already sum to 1, so belowProb is 0 there
    const expectedGradedValue = (1 - belowProb) * valueOnLadder + belowProb * belowValue;

    const netIfGrade = expectedGradedValue * (1 - feePct) - gradingCost;
    const netIfRaw = rawValue * (1 - feePct);
    const expectedProfit = netIfGrade - netIfRaw;

    // gradingCost can be 0
    const roi = gradingCost > 0 ? expectedProfit / gradingCost : null;

    // guard both sides: a 0 raw value or a missing PSA 10 comp shouldn't produce a ratio
    const hasRawPrice = rawValue > 0;
    const hasTopGrade = gradeValues[10] > 0;
    const multiplier = hasRawPrice && hasTopGrade ? gradeValues[10] / rawValue : null;
    const recommendedMultiplier = rawValue < 100 ? 3 : 2.5;   // his rule: <$100 raw wants ~3x, >$100 wants ~2.5x
    const meetsRuleOfThumb = multiplier == null ? null : multiplier >= recommendedMultiplier;

    // break-even prices and the outcome spread (see functions below)
    const { gradeBreakEven, maxBuy } = breakEvenPrices({
        valueOnLadder, belowProb, gradingCost, feePct, netIfGrade,
    });

    // owning and buying have different costs, so compute both
    const ifOwned = outcomeDistribution({
        gradeValues, probabilities, belowValue, belowProb, gradingCost, feePct,
        outlay: netIfRaw,
    });
    // still compute this when maxBuy is 0: it shows you'd lose money even if the card was free
    const ifBought = outcomeDistribution({
        gradeValues, probabilities, belowValue, belowProb, gradingCost, feePct,
        outlay: Math.max(0, maxBuy),
    });

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

    // no data isn't the same as "don't grade"
    let verdict;
    if (!hasRawPrice) {
        verdict = "No raw sales found — can't compare against grading";
    } else if (expectedProfit <= 10) {
        verdict = "Don't Grade this card";
    } else {
        verdict = "Grade this card!";
    }

    return { expectedGradedValue, netIfGrade, netIfRaw, expectedProfit, roi, verdict, rawVsGradeOutcome, multiplier, meetsRuleOfThumb, netByGrade, notLoseMoneyGrading,
             gradeBreakEven, maxBuy, ifOwned, ifBought };
}

// fallback: turns a single gem rate into a rough 10/9/8/7 split. Only used by
// /api/verdict, where there's no population data. The 70/20/10 split is a guess
// and is way off for most cards.
function gemRateToProbabilities(gemRate) {
  const remaining = 1 - gemRate;      // everything that's NOT a 10
  return {
    10: gemRate,
    9: remaining * 0.7,               // most non-10s land as 9s
    8: remaining * 0.2,
    7: remaining * 0.1,
  };

}

// break-even prices
// gradeBreakEven: raw price above which grading stops paying off (you own the card)
//   W = V - C / ((1-f)(1-b))
// maxBuy: the most to pay for a card you plan to grade = expected net from grading
function breakEvenPrices({ valueOnLadder: V, belowProb: b, gradingCost: C, feePct: f, netIfGrade }) {
    const ladderShare = 1 - b;
    if (!(ladderShare > 0) || f >= 1) return { gradeBreakEven: null, maxBuy: null };

    const gradeBreakEven = V - C / ((1 - f) * ladderShare);

    return {
        gradeBreakEven: gradeBreakEven > 0 ? Math.round(gradeBreakEven) : 0,
        maxBuy: netIfGrade > 0 ? Math.round(netIfGrade) : 0,
    };
}

// outcome distribution
// the expected value hides how skewed this is (a small shot at a 10 carries most of it),
// so this lists every outcome and its odds. Computed exactly, no simulation.
// outlay = what you give up: the raw sale if you own it, the purchase price if buying
function outcomeDistribution({ gradeValues, probabilities, belowValue, belowProb, gradingCost, feePct, outlay }) {
    const net = (value) => value * (1 - feePct) - gradingCost - outlay;

    // keep gross so the /invest slider can recompute net at any price on the client
    const gross = (value) => value * (1 - feePct) - gradingCost;

    const outcomes = Object.keys(gradeValues)
        .filter(g => gradeValues[g] > 0 && (probabilities[g] || 0) > 0)
        .map(g => ({ label: `PSA ${g}`, prob: probabilities[g], gross: gross(gradeValues[g]), net: net(gradeValues[g]) }));

    if (belowProb > 0) {
        const floor = Math.min(...Object.keys(gradeValues).map(Number));
        outcomes.push({ label: `PSA ${floor - 1} or below`, prob: belowProb, gross: gross(belowValue), net: net(belowValue) });
    }

    const total = outcomes.reduce((s, o) => s + o.prob, 0);
    if (!(total > 0)) return null;
    outcomes.forEach(o => { o.prob /= total; });          // guard against drift

    const expected = outcomes.reduce((s, o) => s + o.prob * o.net, 0);
    const lossProb = outcomes.filter(o => o.net < 0).reduce((s, o) => s + o.prob, 0);

    // median outcome, walking worst to best
    const byPayoff = [...outcomes].sort((a, b) => a.net - b.net);
    let cumulative = 0, median = byPayoff[byPayoff.length - 1];
    for (const o of byPayoff) {
        cumulative += o.prob;
        if (cumulative >= 0.5) { median = o; break; }
    }

    return {
        expected,
        median: median.net,
        medianLabel: median.label,
        lossProb,
        // "1 in N" only reads right under 50%
        lossOdds: lossProb > 0 && lossProb < 0.5 ? Math.round(1 / lossProb) : null,
        outcomes: byPayoff.reverse(),                     // best first, for display
    };
}

// Wilson score interval for the gem rate. Better than the normal approximation
// when rates are near 0% or 100%, and it shows how much a small sample can be trusted.
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

// pop reports skew high because people submit their best copies.
// haircut = chance a card grades one step lower than the population suggests.
// Defaults to 0 so the numbers shown are the measured ones unless the user changes it.
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
    // anything that falls off the bottom goes to the below-ladder bucket
    return out;
}

// real odds from submission counts. These don't sum to 1; the rest is the chance of
// grading below a 7, which calculateROI values at the raw price. Half grades round down.
function populationToProbabilities(pop) {
    const g = pop.grades || {};
    const h = pop.halves || {};
    const total = pop.totalPop;
    if (!total) return null;

    const n = (v) => (Number.isFinite(v) ? v : 0);

    // uses PSA_GRADES so this always matches the ladder
    return Object.fromEntries(PSA_GRADES.map(grade => [
        grade,
        (n(g['g' + grade]) + n(h['g' + grade + '_5'])) / total,
    ]));
}
// GET from the browser; the CardHedge call itself has to be POST
app.get('/api/search', async (req, res) =>{
    let card = req.query.q;
    try{
        // using this endpoint instead of card-search because it also returns gemrate_id,
        // which the population lookup needs. Ignore the price it returns.
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

        // results are under `cards`. body.found is the set size, not the match count, so don't use it
        const found = body.cards || [];
        console.log('SEARCH:', card, '→', found.length, 'rows (set size', body.found + ')');

        // show the variant (Shadowless, 1st Edition, etc.) since prices differ a lot; skip plain "Base".
        // c.set already includes the year
        const label = (c) => [
            c.set,
            c.number ? `#${c.number}` : null,
            c.variant && c.variant !== 'Base' ? c.variant : null,
        ].filter(Boolean).join(' · ');

        // drop incomplete rows (no set); they show up as blank cards.
        // don't filter on gemrate_id, some real cards don't have one
        const usable = found.filter(c => c.card_id && c.set);

        // dedupe cards that come back twice with the same gemrate_id; keep the first
        const seen = new Set();
        const deduped = usable.filter(c => {
            if (!c.gemrate_id) return true;
            if (seen.has(c.gemrate_id)) return false;
            seen.add(c.gemrate_id);
            return true;
        });

        // left side = what script.js expects, right side = CardHedge fields
        const cards = deduped.map(c => ({
            id: c.card_id,                  // what /v1/cards/comps wants next
            title: c.description,
            card_set: label(c),             // frontend renders this as the sub-line
            card_number: c.number,
            variant: c.variant,
            gemrate_id: c.gemrate_id,       // Phase 3: GemRate population lookup
            image_url: c.image,             // public CDN, no key needed
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

// turns CardHedge sales into the stats the app uses.
// uses the median, not CardHedge's comp_price (a mean, which runs high)
function statsFromRecords(records, wantGrade) {
    const rows = (records || [])
        .filter(r => Number.isFinite(r.price) && r.price > 0)
        .filter(r => !wantGrade || !r.grade || r.grade === wantGrade);

    const prices = rows.map(r => r.price).sort((a, b) => a - b);
    const sampleSize = prices.length;

    // even count: take the lower middle value (conservative)
    const median = sampleSize > 0 ? Math.round(prices[Math.floor((sampleSize - 1) / 2)]) : 0;

    // every sale type is a completed sale; this just tracks how many were auctions
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

// only use an estimate if it's based on at least 2 real grades of the same card.
// the single-anchor ones are too unreliable to show
const MIN_SUPPORT_GRADES = 2;

// fill grades with no sales using CardHedge's FMV estimates (one batch call).
// an empty grade isn't neutral: calculateROI would value it like the grades above it,
// which overstates things. Mostly happens on low-volume cards.
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

            // sampleSize stays 0 since these aren't real sales
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
                    // CardHedge's explanation of how the estimate was made
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

// CardHedge ids look like 1646615786118x244697357144328930, not UUIDs
const CH_ID_RE = /^[0-9]+x[0-9]+$/;

// GemRate ids are 40-char hex; CardHedge gives us one per card
const GR_ID_RE = /^[0-9a-f]{40}$/;

// real gem rate from GemRate population data.
// returns null on failure so the app falls back to the user's own gem rate
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

        // card_gem_rate = card_gems / card_total_grades (checked against Base Charizard).
        // not the same as cert-lookup's gem_rate, which means "this grade or higher".
        // the total includes half grades, qualifiers and autos.
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

// GET from the browser; the upstream CardHedge call is POST
app.get('/api/comps', async (req, res) => {
    const cardId = req.query.card_id;
    const gemrateId = req.query.gemrate_id;
    const gradingCost = numOr(req.query.gradingCost, 80);
    const feePct      = numOr(req.query.feePct, 13) / 100;
    const userGemRate = numOr(req.query.gemRate, 30) / 100;
    // submission-bias haircut, 0 = none
    const haircut = Math.min(90, Math.max(0, numOr(req.query.haircut, 0))) / 100;

    if (!CH_ID_RE.test(cardId || '')) {
        return res.status(400).json({ error: 'card_id is required' });
    }

    try {
        // one call per grade. all-prices-by-card is a single call but only returns the last
        // sale and no sample size. Sequential because of the 10-per-35s limit.
        const startedAt = Date.now();
        const wanted = [['raw', 'Raw'], ...PSA_GRADES.map(g => ['psa' + g, `PSA ${g}`])];

        // cache the whole ladder together (including filled gaps) so grades aren't mixed fresh/stale
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

                // 404 = no sales at this grade. Show "no recent sales", not $0, and keep going
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

            // fill empty grades before caching
            await fillMissingGrades(cardId, out);
            return out;
        });

        // read from the result so it works on cache hits too
        const estimated = PSA_GRADES
            .filter(g => comps['psa' + g].estimated)
            .map(g => ({ grade: g, price: comps['psa' + g].median,
                         confidenceGrade: comps['psa' + g].estimate?.confidenceGrade }));

        // use real population data when we have it, otherwise the user's gem rate
        // (about 12% of cards don't have a gemrate_id)
        const population = await getPopulation(gemrateId);

        // real odds when we have them, the rough 70/20/10 split when we don't
        const measured = (population && populationToProbabilities(population))
            || gemRateToProbabilities(population ? population.gemRate : userGemRate);

        // only apply the haircut to real population data, not a rate the user typed
        const probabilities = population ? applyHaircut(measured, haircut) : measured;
        const gemRate = probabilities[10];

        const gradeValues = Object.fromEntries(PSA_GRADES.map(g => [g, comps['psa' + g].median]));
        const result = calculateROI({
            rawValue: comps.raw.median, gradeValues, probabilities, gradingCost, feePct,
        });

        // include the source and sample size so the UI can show where the gem rate came from
        const gemRateInfo = population
            ? {
                rate: gemRate,                     // after any haircut
                measuredRate: population.gemRate,  // straight from the pop report
                haircut,
                source: 'gemrate',
                psa10Pop: population.psa10Pop,
                totalPop: population.totalPop,
                parallel: population.parallel,
                asOf: population.asOf,
                // 95% Wilson interval
                interval: wilsonInterval(population.psa10Pop, population.totalPop),
                // odds for each grade so the UI can show the full ladder
                probabilities,
              }
            : { rate: userGemRate, source: 'user', probabilities };

        console.log('COMPS:', cardId,
            '→ raw', comps.raw.median, `n=${comps.raw.sampleSize}`,
            '| psa10', comps.psa10.median, `n=${comps.psa10.sampleSize}`,
            '| gem', (gemRate * 100).toFixed(2) + '%', `(${gemRateInfo.source})`,
            estimated.length ? `| est ${estimated.map(e => 'PSA' + e.grade + ':$' + e.price + e.confidenceGrade).join(' ')}` : '',
            `| ${Date.now() - startedAt}ms`);

        // script.js needs both data.result and data.comps
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

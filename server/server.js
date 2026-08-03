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

async function getPriceStats(paramsObj) {
    const params = new URLSearchParams(paramsObj)
    try{
        const response = await fetch(`https://thecardapi.com/api/v1/market/sales/?${params}`, {
            method: 'GET',
            headers: {
                'x-market-api-key' : `${process.env.theCardApiKey}`,
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const body = await response.json();

        // Median, not mean. A handful of high sales drag the average up badly —
        // on one card in PPT's docs, median $186.75 vs average $307.75.
        // The comparator matters: default .sort() is lexicographic, so [100, 25, 9]
        // would "sort" to [100, 25, 9].
        const prices = (body.data || [])
            .map(s => s.price)
            .filter(p => Number.isFinite(p) && p > 0)
            .sort((a, b) => a - b);

        // Two different numbers. The old code reported one while computing from the
        // other: sampleSize is what we actually measured (page 1), totalAvailable is
        // what exists upstream. The probability model in V2 needs to know which is which.
        const sampleSize = prices.length;
        const totalAvailable = body.pagination?.total ?? sampleSize;

        // Even-length: take the LOWER of the two middle values. Conservative on
        // purpose — this number tells someone whether to spend $80.
        const median = sampleSize > 0
            ? Math.round(prices[Math.floor((sampleSize - 1) / 2)])
            : 0;

        console.log('CALL:', params.toString(), '→ n:', sampleSize, 'median:', median);

        // avg/count kept as aliases so the live frontend keeps working —
        // script.js reads c.avg and c.count.
        return { avg: median, count: sampleSize, median, sampleSize, totalAvailable };    
    } catch (error) {
        console.error('Fetch operation failed', error)
        return { avg: 0, count: 0, median: 0, sampleSize: 0, totalAvailable: 0 };
    }
}

function calculateROI ({ rawValue, gradeValues, probabilities, gradingCost, feePct}) {
    // Only grades with a real comp price count. Renormalize their probabilities
    // to sum to 1 so missing grades aren't averaged in as $0 outcomes.
    const pricedGrades = Object.keys(gradeValues).filter(grade => gradeValues[grade] > 0);
    const totalProb = pricedGrades.reduce((sum, grade) => sum + probabilities[grade], 0);
    let expectedGradedValue = 0;
    if (totalProb > 0) {
        pricedGrades.forEach(grade => {
            expectedGradedValue += (probabilities[grade] / totalProb) * gradeValues[grade];
        });
    }

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

// A small helper: gem rate → full probability distribution
function gemRateToProbabilities(gemRate) {
  const remaining = 1 - gemRate;      // everything that's NOT a 10
  return {
    10: gemRate,
    9: remaining * 0.7,               // most non-10s land as 9s
    8: remaining * 0.2,
    7: remaining * 0.1,
  };

}
app.get('/api/search', async (req, res) =>{
    let card = req.query.q;
    try{
        const params = new URLSearchParams({ q : card});
        console.log('FETCHING:', `https://thecardapi.com/api/v1/market/sales/?${params}`);
        const response = await fetch(`https://thecardapi.com/api/v1/market/sales/?${params}`, {
            method: 'GET',
            headers: {
                'x-market-api-key' : `${process.env.theCardApiKey}`,
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const body = await response.json();

        const sales = (body.data || []);
        console.log(sales.length);

        const m = new Map();
        for (const sale of sales) {
            const key = sale.title;
            if (!m.has(key)){
                m.set(key, {
                    title: sale.title,
                    card_set: sale.card_set ,
                    card_number: sale.card_number ,
                    image_url: sale.image_url
                })
            }
        }
        const cards = [...m.values()];
        res.json(cards);

    } catch (error) {
        console.error('Fetch operation failed', error)

        res.status(500).json({ error: 'Failed to fetch card data'})
   }

});

app.get('/api/comps', async (req, res) => {
    let card = req.query.q;
    const gradingCost = numOr(req.query.gradingCost, 80);
    const feePct      = numOr(req.query.feePct, 13) / 100;
    const gemRate     = numOr(req.query.gemRate, 30) / 100;
    const raw   = await getPriceStats({ q: card });
    const psa10 = await getPriceStats({ q: card, grader: 'PSA', grade: '10' });
    const psa9  = await getPriceStats({ q: card, grader: 'PSA', grade: '9' });
    const psa8  = await getPriceStats({ q: card, grader: 'PSA', grade: '8' });
    const psa7  = await getPriceStats({ q: card, grader: 'PSA', grade: '7' });
    const gradeValues = {10: psa10.avg, 9: psa9.avg, 8: psa8.avg, 7: psa7.avg}
    const probabilities = gemRateToProbabilities(gemRate);
    const result = calculateROI({ rawValue: raw.avg, gradeValues, probabilities, gradingCost, feePct })
    res.json({ result, comps: { raw, psa10, psa9, psa8, psa7 } });
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

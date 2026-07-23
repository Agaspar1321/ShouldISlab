const express = require('express');
const env = require('dotenv').config();

const app = express();

app.use(express.static(require('path').join(__dirname, '..')));

async function getAverage(paramsObj) {
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
        
        const comps = body.data || [];
        const count = comps.length;
        const raw_avg = count > 0
            ? Math.round(comps.map(s => s.price).reduce((sum, p) => sum + p, 0) / count)
            : 0;        
        console.log('CALL:', params.toString(), '→ count:', count, 'avg:', raw_avg);
        return { avg: raw_avg, count: body.pagination.total };    
    } catch (error) {
        console.error('Fetch operation failed', error)
        return { avg: 0, count: 0 };
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
    const roi = expectedProfit / gradingCost;
    let multiplier = gradeValues[10] / rawValue;
    let recommendedMultiplier = rawValue < 100 ? 3 : 2.5;   // his rule: <$100 raw wants ~3x, >$100 wants ~2.5x
    let meetsRuleOfThumb = multiplier >= recommendedMultiplier;
    
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

    let verdict = 'none'
    if(expectedProfit <= 10){
        verdict = "Don't Grade this card";
    } else {
        verdict = "Grade this card!";
    }
    return { expectedGradedValue, netIfGrade, netIfRaw, expectedProfit, verdict, rawVsGradeOutcome, multiplier, meetsRuleOfThumb, netByGrade, notLoseMoneyGrading };
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
        
        const sales = body.data;
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
    const gradingCost = Number(req.query.gradingCost) || 80;
    const feePct      = Number(req.query.feePct) / 100 || 0.13;
    const gemRate     = Number(req.query.gemRate) / 100 || 0.30;
    const raw   = await getAverage({ q: card });
    const psa10 = await getAverage({ q: card, grader: 'PSA', grade: '10' });
    const psa9  = await getAverage({ q: card, grader: 'PSA', grade: '9' });
    const psa8  = await getAverage({ q: card, grader: 'PSA', grade: '8' });
    const psa7  = await getAverage({ q: card, grader: 'PSA', grade: '7' });
    const gradeValues = {10: psa10.avg, 9: psa9.avg, 8: psa8.avg, 7: psa7.avg}
    const probabilities = gemRateToProbabilities(gemRate);
    const result = calculateROI({ rawValue: raw.avg, gradeValues, probabilities, gradingCost, feePct })
    res.json({ result, comps: { raw, psa10, psa9, psa8, psa7 } });
});

// Manual fallback: caller supplies the prices, we just run the engine.
app.get('/api/verdict', (req, res) => {
    const rawValue = Number(req.query.rawValue);
    const gradeValues = {
        10: Number(req.query.psa10),
        9:  Number(req.query.psa9),
        8:  Number(req.query.psa8),
        7:  Number(req.query.psa7),
    };
    const gradingCost = Number(req.query.gradingCost) || 80;
    const feePct      = Number(req.query.feePct) / 100 || 0.13;
    const gemRate     = Number(req.query.gemRate) / 100 || 0.30;
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

const PORT = proccess.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on ${PORT}`)
});


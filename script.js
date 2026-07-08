
function calculateROI ({ rawValue, gradeValues, probabilities, gradingCost, feePct}) {
    let expectedGradedValue = 0;
    Object.keys(gradeValues).forEach(grade => {
        expectedGradedValue += probabilities[grade] * gradeValues[grade];
    });

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

const button = document.getElementById("btn-Submit");
const results = document.getElementById("results");

button.addEventListener("click", () => {  
    
    const num = (id) => parseFloat(document.getElementById(id).value.replace(/[^0-9.]/g, ""));
    const rawValue    = num("rawValue");
    const gradeValues = { 10: num("psa10"), 9: num("psa9"), 8: num("psa8"), 7: num("psa7") };
    const gradingCost = num("gradingCost");
    const feePct      = num("feePct") / 100;
    const gemRate     = num("gemRate") / 100;

    // Guard: every input must be a real number
    const inputs = [rawValue, gradeValues[10], gradeValues[9], gradeValues[8], gradeValues[7], gradingCost, feePct, gemRate];
    if (inputs.some(Number.isNaN)) {
    results.className = "";
    results.innerHTML = `<div class="results-empty"><p>Please fill in all fields with numbers.</p></div>`;
    return;
    }
    // 2. Build the probabilities from the gem rate
    const probabilities = gemRateToProbabilities(gemRate);

    // 3. Run your proven engine
    const result = calculateROI({ rawValue, gradeValues, probabilities, gradingCost, feePct });

    // 4. Show it (rounding money to 2 decimals — remember the float lesson)
    const good = result.expectedProfit > 10;
    const money = (n) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
    const ladderRow = (grade) => {
        const net = result.netByGrade[grade];
        return `
        <div class="ladder-row">
            <span class="ladder-grade">PSA ${grade}</span>
            <span class="ladder-value ${net < 0 ? "neg" : ""}">${money(net)}</span>
        </div>`;
  };

  results.className = good ? "is-good" : "is-bad";
  results.innerHTML = `
    <div class="verdict">
      <span class="verdict-tag">${good ? "Grade it" : "Skip it"}</span>
      <p class="verdict-msg">${result.verdict}</p>
    </div>

    <div class="stat-grid">
      <div class="stat stat--hero ${good ? "pos" : "neg"}">
        <span class="stat-label">Expected profit</span>
        <span class="stat-value">${money(result.expectedProfit)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Minimum Grade to cover grading & fees</span>
        <span class="stat-value">${result.notLoseMoneyGrading === "No grade gets your money back" ? "No grade gets your money back" : "PSA " + result.notLoseMoneyGrading}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Minimum Grade more than Raw</span>
        <span class="stat-value">${result.rawVsGradeOutcome === "No grade beats selling raw" ? "No grade beats selling raw" : "PSA " + result.rawVsGradeOutcome}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Net if sold raw</span>
        <span class="stat-value">${money(result.netIfRaw)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Best-case multiplier</span>
        <span class="stat-value">${result.multiplier.toFixed(1)}x</span>
       </div>  
    </div>

    <div class="ladder">
      <h3>Net by grade</h3>
      ${ladderRow(10)}
      ${ladderRow(9)}
      ${ladderRow(8)}
      ${ladderRow(7)}
    </div>
`;
});

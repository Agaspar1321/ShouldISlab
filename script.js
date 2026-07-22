function renderResult(result) {
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
    <p class="support-note">Saved you from a bad grade? <a href="https://buymeacoffee.com/shouldislab" target="_blank" rel="noopener">☕ Buy me a coffee</a></p>
`;
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
});

const searchBtn = document.getElementById('searchBtn');
const pickList  = document.getElementById('pickList');

searchBtn.addEventListener('click', async () => {
    const query = document.getElementById('cardSearch').value;

    // 1. call YOUR api from the browser
    const response = await fetch('/api/search?q=' + encodeURIComponent(query));
    const cards = await response.json();

    // 2. render the list  ← you build this part
    pickList.innerHTML = cards.map(card => `
        <div class="pick-card" data-query="${query} ${card.card_number}">
            <img src="${card.image_url}" width="60">
            <span>${card.title}</span>
        </div>
    `).join('');
    document.querySelectorAll('.pick-card').forEach(el => {
      el.addEventListener('click', async () => {
          const q = el.dataset.query;          // read the stashed query
          const res = await fetch('/api/comps?q=' + encodeURIComponent(q));
          const data = await res.json();
          renderResult(data.result);      // ← was console.log('VERDICT:', data.result)
      });
    });
});

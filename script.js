// ===== ShouldISlab — search + verdict wiring =====

const searchBtn  = document.getElementById('searchBtn');
const cardSearch = document.getElementById('cardSearch');
const pickList   = document.getElementById('pickList');
const results    = document.getElementById('results');

// escape text going into HTML / attributes
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// switch between the search view and the verdict view
function showVerdict() {
  const app = document.querySelector('.app');
  app.classList.add('viewing-verdict');
  app.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function backToSearch() {
  const app = document.querySelector('.app');
  app.classList.remove('viewing-verdict');
  results.className = '';
  results.innerHTML = '<div class="results-empty"><span class="results-empty-icon">◈</span><p>search a card and let\'s see if it\'s worth it…</p></div>';
  app.scrollIntoView({ behavior: 'smooth', block: 'start' });
  cardSearch.focus();
}

// read the three assumption inputs (with sensible defaults) as a query string
function assumptionsQS() {
  const num = (id) => parseFloat((document.getElementById(id).value || '').replace(/[^0-9.]/g, ''));
  const gradingCost = num('gradingCost') || 80;
  const feePct      = num('feePct')      || 13;
  const gemRate     = num('gemRate')     || 50;
  return `gradingCost=${gradingCost}&feePct=${feePct}&gemRate=${gemRate}`;
}

// ---------- search ----------
async function runSearch() {
  const query = cardSearch.value.trim();
  if (!query) return;
  pickList.innerHTML = '<p class="pick-status">Searching…</p>';
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(query));
    const cards = await res.json();
    if (!Array.isArray(cards) || cards.length === 0) {
      pickList.innerHTML = '<p class="pick-status">No cards found. Try another search, or enter values manually below.</p>';
      return;
    }
    pickList.innerHTML = cards.map(card => `
      <button class="pick-card" type="button"
              data-query="${escapeHtml(query + ' ' + (card.card_number || ''))}"
              data-title="${escapeHtml(card.title)}"
              data-image="${escapeHtml(card.image_url)}">
        <img src="${escapeHtml(card.image_url)}" alt="" loading="lazy">
        <span class="pick-name">${escapeHtml(card.title)}</span>
        <span class="pick-set">${escapeHtml(card.card_set)}</span>
      </button>
    `).join('');
    document.querySelectorAll('.pick-card').forEach(el =>
      el.addEventListener('click', () => selectCard(el)));
  } catch (e) {
    pickList.innerHTML = '<p class="pick-status">Search failed — make sure the server is running, or enter values manually below.</p>';
  }
}

searchBtn.addEventListener('click', runSearch);
cardSearch.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
document.getElementById('searchAgain').addEventListener('click', backToSearch);

// ---------- select a card → pull comps → render ----------
async function selectCard(el) {
  document.querySelectorAll('.pick-card').forEach(c => c.classList.remove('is-selected'));
  el.classList.add('is-selected');

  const cardMeta = { title: el.dataset.title, image: el.dataset.image };
  results.className = '';
  results.innerHTML = '<div class="results-empty"><p>Pulling recent sales…</p></div>';
  showVerdict();
  try {
    const res  = await fetch('/api/comps?q=' + encodeURIComponent(el.dataset.query) + '&' + assumptionsQS());
    if (!res.ok) throw new Error('server ' + res.status);
    const data = await res.json();
    renderResult(data.result, data.comps, cardMeta);
  } catch (e) {
    results.className = '';
    results.innerHTML = '<div class="results-empty"><p>Couldn\'t load comps. Try entering values manually below.</p></div>';
  }
}

// ---------- manual fallback ----------
const manualBtn = document.getElementById('btn-Submit');
manualBtn.addEventListener('click', async () => {
  // blank grades are allowed — treated as 0 and ignored, same as a null lookup grade
  const num = (id) => {
    const v = parseFloat((document.getElementById(id).value || '').replace(/[^0-9.]/g, ''));
    return Number.isNaN(v) ? 0 : v;
  };
  const rawValue = num('rawValue');
  const vals = { 10: num('psa10'), 9: num('psa9'), 8: num('psa8'), 7: num('psa7') };

  results.className = '';
  showVerdict();

  if (!rawValue || (!vals[10] && !vals[9] && !vals[8] && !vals[7])) {
    results.innerHTML = '<div class="results-empty"><p>Enter a raw value and at least one PSA price.</p></div>';
    return;
  }

  results.innerHTML = '<div class="results-empty"><p>Crunching the numbers…</p></div>';
  const qs = `rawValue=${rawValue}&psa10=${vals[10]}&psa9=${vals[9]}&psa8=${vals[8]}&psa7=${vals[7]}&` + assumptionsQS();
  try {
    const res = await fetch('/api/verdict?' + qs);
    if (!res.ok) throw new Error('server ' + res.status);
    const data = await res.json();
    renderResult(data.result, data.comps, null);
  } catch (e) {
    results.innerHTML = '<div class="results-empty"><p>Couldn\'t compute that. If you just added the endpoint, <strong>restart the server</strong> (it needs <code>/api/verdict</code>), then try again.</p></div>';
  }
});

// ---------- render a verdict ----------
function renderResult(result, comps, cardMeta) {
  const good  = result.expectedProfit > 10;
  const money = (n) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);

  const gradeRow = (grade) => {
    const c   = comps ? comps['psa' + grade] : null;
    const net = result.netByGrade[grade];
    const hasPrice = c && c.avg > 0;
    let priceLine;
    if (!hasPrice)             priceLine = 'no recent sales';
    else if (c.count != null)  priceLine = `$${c.avg} · ${c.count} sale${c.count === 1 ? '' : 's'}`;
    else                       priceLine = `$${c.avg}`;
    return `
      <div class="grade-row ${hasPrice ? '' : 'grade-row--empty'}">
        <span class="grade-tag">PSA ${grade}</span>
        <span class="grade-comp">${priceLine}</span>
        <span class="grade-net ${net < 0 ? 'neg' : 'pos'}">${hasPrice ? money(net) : '—'}</span>
      </div>`;
  };

  const cardImg = cardMeta && cardMeta.image
    ? `<img class="verdict-card-img" src="${escapeHtml(cardMeta.image)}" alt="">` : '';
  const cardName = cardMeta && cardMeta.title
    ? `<p class="verdict-card-name">${escapeHtml(cardMeta.title)}</p>` : '';
  const rawLine = comps && comps.raw && comps.raw.avg > 0
    ? `<span class="verdict-raw">Raw: $${comps.raw.avg}${comps.raw.count != null ? ' · ' + comps.raw.count + ' sales' : ''}</span>` : '';

  results.className = good ? 'is-good' : 'is-bad';
  results.innerHTML = `
    <div class="verdict-head">
      ${cardImg}
      <div class="verdict-head-text">
        ${cardName}
        <span class="verdict-tag">${good ? 'Grade it' : 'Skip it'}</span>
        <p class="verdict-msg">${escapeHtml(result.verdict)}</p>
        ${rawLine}
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat stat--hero ${good ? 'pos' : 'neg'}">
        <span class="stat-label">Expected profit</span>
        <span class="stat-value">${money(result.expectedProfit)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Min grade to cover grading &amp; fees</span>
        <span class="stat-value">${result.notLoseMoneyGrading === 'No grade gets your money back' ? 'None' : 'PSA ' + result.notLoseMoneyGrading}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Min grade that beats raw</span>
        <span class="stat-value">${result.rawVsGradeOutcome === 'No grade beats selling raw' ? 'None' : 'PSA ' + result.rawVsGradeOutcome}</span>
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
      ${gradeRow(10)}
      ${gradeRow(9)}
      ${gradeRow(8)}
      ${gradeRow(7)}
    </div>
    <p class="support-note">Saved you from a bad grade? <a href="https://buymeacoffee.com/shouldislab" target="_blank" rel="noopener">☕ Buy me a coffee</a></p>
  `;
}

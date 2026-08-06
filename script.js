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
    // 429 is the upstream burst limit, not a failure. "Try again in N seconds" is
    // honest and actionable; "search failed" would push people to the manual form
    // for no reason.
    if (res.status === 429) {
      const { retryAfter } = await res.json().catch(() => ({}));
      pickList.innerHTML = `<p class="pick-status">Busy right now — try again in about ${retryAfter || 35} seconds.</p>`;
      return;
    }
    const cards = await res.json();
    if (!Array.isArray(cards) || cards.length === 0) {
      pickList.innerHTML = '<p class="pick-status">No cards found. Try another search, or enter values manually below.</p>';
      return;
    }
    pickList.innerHTML = cards.map(card => `
      <button class="pick-card" type="button"
              data-card-id="${escapeHtml(card.id)}"
              data-gemrate-id="${escapeHtml(card.gemrate_id || '')}"
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
    // gemrate_id is what unlocks the real submission-count gem rate. It's absent
    // on some cards, and the server falls back to the user's own figure then.
    const res  = await fetch('/api/comps?card_id=' + encodeURIComponent(el.dataset.cardId)
      + '&gemrate_id=' + encodeURIComponent(el.dataset.gemrateId || '')
      + '&' + assumptionsQS());
    if (res.status === 429) {
      const { retryAfter } = await res.json().catch(() => ({}));
      results.className = '';
      results.innerHTML = `<div class="results-empty"><p>Busy right now — try this card again in about ${retryAfter || 35} seconds, or enter values manually below.</p></div>`;
      return;
    }
    if (!res.ok) throw new Error('server ' + res.status);
    const data = await res.json();
    renderResult(data.result, data.comps, cardMeta, data.gemRate);
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
    renderResult(data.result, data.comps, null, data.gemRate);
  } catch (e) {
    results.innerHTML = '<div class="results-empty"><p>Couldn\'t compute that. If you just added the endpoint, <strong>restart the server</strong> (it needs <code>/api/verdict</code>), then try again.</p></div>';
  }
});

// ---------- render a verdict ----------
function renderResult(result, comps, cardMeta, gemRate) {
  const good  = result.expectedProfit > 10;
  const money = (n) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
  const pct   = (n) => (n * 100).toFixed(n < 0.01 ? 2 : 1) + '%';

  // How many sales a price needs before we treat it as a market price rather than
  // an anecdote. Below this we still SHOW the number — hiding data the user could
  // interpret is worse — but we say plainly that it's thin.
  const LOW_SAMPLE = 5;
  const salesCount = (c) => (c ? (c.sampleSize != null ? c.sampleSize : c.count) : null);
  const isThin = (c) => {
    const n = salesCount(c);
    return !!(c && c.avg > 0 && !c.estimated && n != null && n < LOW_SAMPLE);
  };

  const odds = gemRate && gemRate.probabilities;

  const gradeRow = (grade) => {
    const c   = comps ? comps['psa' + grade] : null;
    const net = result.netByGrade[grade];
    const hasPrice = c && c.avg > 0;
    const n = salesCount(c);
    const thin = isThin(c);

    // An estimate is not a sale count and must never render like one. It carries
    // its own derivation, which we put in the tooltip rather than hide.
    let priceLine, flag = '';
    if (!hasPrice) {
      priceLine = 'no recent sales';
    } else if (c.estimated) {
      priceLine = `$${c.avg}`;
      const why = c.estimate && c.estimate.explanation ? escapeHtml(c.estimate.explanation) : '';
      flag = ` <span class="est-flag" title="${why}">estimated</span>`;
    } else if (n != null) {
      priceLine = `$${c.avg} · ${n} sale${n === 1 ? '' : 's'}`;
      flag = thin ? ' <span class="thin-flag">thin</span>' : '';
    } else {
      priceLine = `$${c.avg}`;
    }

    // The odds of landing on this rung — the number that decides the verdict, and
    // the one the old model was inventing.
    const chance = odds && odds[grade] != null
      ? `<span class="grade-odds">${pct(odds[grade])}</span>` : '';

    return `
      <div class="grade-row ${hasPrice ? '' : 'grade-row--empty'} ${thin ? 'grade-row--thin' : ''}">
        <span class="grade-tag">PSA ${grade}</span>
        ${chance}
        <span class="grade-comp">${priceLine}${flag}</span>
        <span class="grade-net ${net < 0 ? 'neg' : 'pos'}">${hasPrice ? money(net) : '—'}</span>
      </div>`;
  };

  // Everything below the bottom rung. Real outcomes, not a rounding gap — on a
  // 1999 Base Charizard this is 58% of submissions, and burying it is how the
  // rest of the category ends up quoting numbers that can't happen.
  const ladderProb = odds ? [10, 9, 8, 7].reduce((s, g) => s + (odds[g] || 0), 0) : null;
  const belowRow = ladderProb != null && ladderProb < 0.999
    ? `<div class="grade-row grade-row--below">
         <span class="grade-tag">PSA 6↓</span>
         <span class="grade-odds">${pct(1 - ladderProb)}</span>
         <span class="grade-comp">valued at raw</span>
         <span class="grade-net">—</span>
       </div>`
    : '';

  // Where the gem rate came from. A percentage without its sample size is the
  // thing this whole build exists to stop shipping: 42% across 1,000 submissions
  // and 82% across 5 are not the same claim.
  let gemBlock = '';
  if (gemRate && gemRate.source === 'gemrate') {
    gemBlock = `
      <div class="gem-block">
        <span class="gem-rate">${pct(gemRate.rate)} gem rate</span>
        <span class="gem-n">${gemRate.psa10Pop.toLocaleString()} PSA 10s from ${gemRate.totalPop.toLocaleString()} submissions${gemRate.parallel ? ' · ' + escapeHtml(gemRate.parallel) : ''}</span>
        <span class="gem-src">Population data by GemRate${gemRate.asOf ? ', as of ' + escapeHtml(gemRate.asOf) : ''}</span>
      </div>`;
  } else if (gemRate) {
    gemBlock = `
      <div class="gem-block gem-block--assumed">
        <span class="gem-rate">${pct(gemRate.rate)} gem rate</span>
        <span class="gem-n">your assumption — no population data for this card</span>
      </div>`;
  }

  // One plain-English caveat covering everything the verdict leaned on.
  const thinSources = [];
  if (comps && isThin(comps.raw)) thinSources.push('raw');
  [10, 9, 8, 7].forEach(g => {
    if (comps && isThin(comps['psa' + g])) thinSources.push('PSA ' + g);
  });
  const estimatedGrades = [10, 9, 8, 7].filter(g => comps && comps['psa' + g] && comps['psa' + g].estimated);

  const notes = [];
  if (thinSources.length) {
    notes.push(`<strong>Thin data.</strong> ${thinSources.join(', ')} priced on fewer than ${LOW_SAMPLE} recent sales.`);
  }
  if (estimatedGrades.length) {
    notes.push(`<strong>Estimated.</strong> ${estimatedGrades.map(g => 'PSA ' + g).join(', ')} had no recent sales — interpolated from this card's other grades, not measured. Hover for how.`);
  }
  const thinNote = notes.length
    ? `<p class="thin-note">${notes.join(' ')} Treat this verdict as an indication, not a market price.</p>`
    : '';

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
        ${gemBlock}
        ${thinNote}
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
        <span class="stat-value">${result.multiplier == null ? '—' : result.multiplier.toFixed(1) + 'x'}</span>
      </div>
    </div>

    <div class="ladder">
      <h3>Net by grade</h3>
      ${gradeRow(10)}
      ${gradeRow(9)}
      ${gradeRow(8)}
      ${gradeRow(7)}
      ${belowRow}
    </div>
    <p class="support-note">Saved you from a bad grade? <a href="https://buymeacoffee.com/shouldislab" target="_blank" rel="noopener">☕ Buy me a coffee</a></p>
  `;
}

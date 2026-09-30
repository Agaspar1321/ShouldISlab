// ShouldISlab: search + verdict

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
  // gemRate is only a fallback for cards with no population data
  const gemRate     = num('gemRate')     || 50;
  // condition = the haircut. Pop reports skew toward people's best copies,
  // so we ask how this card compares instead of guessing
  const condEl      = document.getElementById('condition');
  const haircut     = condEl ? (parseFloat(condEl.value) || 0) : 0;
  return `gradingCost=${gradingCost}&feePct=${feePct}&gemRate=${gemRate}&haircut=${haircut}`;
}

// ---------- search ----------
async function runSearch() {
  const query = cardSearch.value.trim();
  if (!query) return;
  pickList.innerHTML = '<p class="pick-status">Searching…</p>';
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(query));
    // 429 means the upstream rate limit, so show a retry countdown instead of an error
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

// ---------- condition diagrams ----------
// drawn instead of photos (no copyright issues, and flaws show up better at this size).
// 5:7 viewBox like a real card; colors come from CSS vars.
// centre: how far the art is off-center (0 = centered)
// round: corner radius on the art window
// white: edge whitening
// scratch: a surface scratch
function conditionDiagram({ centre = 0, round = 1, white = 0, scratch = false, marks = [] }) {
  const W = 200, H = 280, border = 22;
  // shift the art window off-center
  const x = border + centre, y = border + centre * 0.6;
  const w = W - border * 2, h = H - border * 2;

  const speckles = white
    ? Array.from({ length: white }, (_, i) => {
        const t = (i + 1) / (white + 1);
        return `<rect x="${(W - 8) * t}" y="2" width="${3 + (i % 3)}" height="4" rx="1" fill="var(--inset)" opacity="0.95"/>
                <rect x="2" y="${(H - 10) * t}" width="4" height="${3 + (i % 2)}" rx="1" fill="var(--inset)" opacity="0.85"/>`;
      }).join('')
    : '';

  // ring on the flaw with the label outside the card so it doesn't cover the art
  const callouts = marks.map(m => {
    const r = m.r || 15;
    const above = m.y < H / 2;
    const ly = above ? -10 : H + 22;          // label sits in the padded margin
    const leaderY = above ? m.y - r - 2 : m.y + r + 2;
    return `
    <circle cx="${m.x}" cy="${m.y}" r="${r}" fill="none"
            stroke="var(--red)" stroke-width="2" stroke-dasharray="4 3" opacity="0.9"/>
    <line x1="${m.x}" y1="${leaderY}" x2="${m.x}" y2="${above ? ly + 4 : ly - 12}"
          stroke="var(--red)" stroke-width="1.5" opacity="0.55"/>
    <text x="${m.x}" y="${ly}" text-anchor="middle"
          font-size="13" font-weight="700" fill="var(--red-deep)">${m.label}</text>`;
  }).join('');

  // padded viewBox so labels aren't clipped at the card edge
  return `
  <svg class="cond-svg" viewBox="-18 -26 ${W + 36} ${H + 62}" role="img" aria-label="Condition example">
    <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="7"
          fill="var(--panel-2)" stroke="var(--line-strong)" stroke-width="2"/>
    ${speckles}
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${round}"
          fill="var(--teal-soft)" stroke="var(--teal)" stroke-width="1.5"/>
    <circle cx="${x + w / 2}" cy="${y + h * 0.38}" r="${w * 0.2}" fill="var(--teal)" opacity="0.35"/>
    <rect x="${x + w * 0.15}" y="${y + h * 0.66}" width="${w * 0.7}" height="5" rx="2" fill="var(--teal)" opacity="0.3"/>
    <rect x="${x + w * 0.15}" y="${y + h * 0.76}" width="${w * 0.45}" height="5" rx="2" fill="var(--teal)" opacity="0.22"/>
    ${scratch ? `<line x1="${x + w * 0.18}" y1="${y + h * 0.2}" x2="${x + w * 0.72}" y2="${y + h * 0.55}"
          stroke="var(--inset)" stroke-width="2" opacity="0.9"/>` : ''}
    ${callouts}
  </svg>`;
}

// ---------- condition examples ----------
// what a grader checks, in order. The odds shift here is my estimate, not measured.
const CONDITIONS = [
  {
    value: '0',
    title: 'Gem Mint',
    sub: 'The card you\'d bet on. This is what the population report is mostly made of.',
    checks: [
      '<strong>Centring</strong> — borders look even top-to-bottom and left-to-right',
      '<strong>Corners</strong> — all four come to a point, no softness under a light',
      '<strong>Edges</strong> — no whitening when you tilt it against a dark background',
      '<strong>Surface</strong> — no print lines, scratches or dimples when angled to a lamp',
    ],
    effect: 'No shift. You\'re submitting the same kind of card everyone else in the pop report submitted.',
    art: { centre: 0, round: 1 },
  },
  {
    value: '25',
    title: 'Near Mint',
    sub: 'Looks clean at arm\'s length, but you haven\'t gone over it under good light.',
    checks: [
      'Nothing jumps out, but you haven\'t checked corners closely',
      'Centring looks fine but you haven\'t measured it',
      'Card came from a pack, binder or a sleeve and was handled normally',
      'No obvious whitening, but you haven\'t tilted it to look',
    ],
    effect: 'Shifts a quarter of the odds down one grade. Most cards land here, and most people overestimate their own copy.',
    art: { centre: 3, round: 3 },
  },
  {
    value: '50',
    title: 'Light wear',
    sub: 'One flaw you can point to.',
    checks: [
      'A single soft corner, or one small edge nick',
      'Slightly off-centre — noticeably more border on one side',
      'A faint surface scratch visible only at an angle',
      'Otherwise clean',
    ],
    effect: 'Shifts half the odds down one grade. One visible flaw is usually the difference between a 9 and a 10.',
    art: {
      centre: 8, round: 7, scratch: true,
      marks: [{ x: 32, y: 36, r: 15, label: 'soft corner' }],
    },
  },
  {
    value: '75',
    title: 'Visible wear',
    sub: 'Flaws you\'d mention if you were selling it honestly.',
    checks: [
      'Clear whitening along edges or corners',
      'Obviously off-centre',
      'Surface marks, print lines or a crease',
      'Been loose in a box, binder or a stack',
    ],
    effect: 'Shifts three quarters of the odds down one grade. At this point grading is usually about authentication, not upside.',
    art: {
      centre: 15, round: 11, white: 5, scratch: true,
      marks: [
        { x: 96, y: 12, r: 12, label: 'edge whitening' },
        { x: 176, y: 240, r: 15, label: 'off-centre' },
      ],
    },
  },
];

(function setupConditionHelp() {
  const dlg = document.getElementById('condDialog');
  if (!dlg) return;
  const select = document.getElementById('condition');
  let i = 0;

  const render = () => {
    const c = CONDITIONS[i];
    document.getElementById('condTitle').textContent = c.title;
    document.getElementById('condSub').textContent = c.sub;
    document.getElementById('condArt').innerHTML = conditionDiagram(c.art || {});
    document.getElementById('condList').innerHTML = c.checks.map(x => `<li>${x}</li>`).join('');
    document.getElementById('condEffect').textContent = c.effect;
    document.getElementById('condDots').innerHTML = CONDITIONS
      .map((_, n) => `<span class="cond-dot${n === i ? ' is-on' : ''}"></span>`).join('');
    document.getElementById('condPrev').disabled = i === 0;
    document.getElementById('condNext').disabled = i === CONDITIONS.length - 1;
  };

  const open = () => {
    // start on whatever they already picked
    const found = CONDITIONS.findIndex(c => c.value === select.value);
    i = found >= 0 ? found : 0;
    render();
    dlg.showModal();
  };

  document.getElementById('conditionHelp').addEventListener('click', open);
  document.getElementById('condClose').addEventListener('click', () => dlg.close());
  document.getElementById('condPrev').addEventListener('click', () => { if (i > 0) { i--; render(); } });
  document.getElementById('condNext').addEventListener('click', () => { if (i < CONDITIONS.length - 1) { i++; render(); } });
  document.getElementById('condPick').addEventListener('click', () => {
    select.value = CONDITIONS[i].value;
    dlg.close();
  });
  // click the backdrop to close
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
})();

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
    // gemrate_id gets the real gem rate; without it the server uses the user's number
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
  // blank grades are allowed (treated as 0 and ignored)
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
  // thousands separators
  const group = (n, dp) => Number(n).toLocaleString('en-US', {
    minimumFractionDigits: dp, maximumFractionDigits: dp,
  });
  const money = (n) => (n < 0 ? `-$${group(Math.abs(n), 2)}` : `$${group(n, 2)}`);
  // comp medians are whole dollars already
  const price = (n) => `$${group(n, 0)}`;
  const pct   = (n) => (n * 100).toFixed(n < 0.01 ? 2 : 1) + '%';

  // sales needed before a price counts as a real market price. Below this we still show it, but flag it as thin
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

    // estimates aren't sales, so don't show a sale count; the explanation goes in the tooltip
    let priceLine, flag = '';
    if (!hasPrice) {
      priceLine = 'no recent sales';
    } else if (c.estimated) {
      priceLine = price(c.avg);
      const why = c.estimate && c.estimate.explanation ? escapeHtml(c.estimate.explanation) : '';
      flag = ` <span class="est-flag" title="${why}">estimated</span>`;
    } else if (n != null) {
      priceLine = `${price(c.avg)} · ${n} sale${n === 1 ? '' : 's'}`;
      flag = thin ? ' <span class="thin-flag">thin</span>' : '';
    } else {
      priceLine = price(c.avg);
    }

    // odds of landing on this grade
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

  // chance of grading below the ladder (58% on a 1999 Base Charizard)
  const ladderProb = odds ? [10, 9, 8, 7].reduce((s, g) => s + (odds[g] || 0), 0) : null;
  const belowRow = ladderProb != null && ladderProb < 0.999
    ? `<div class="grade-row grade-row--below">
         <span class="grade-tag">PSA 6↓</span>
         <span class="grade-odds">${pct(1 - ladderProb)}</span>
         <span class="grade-comp">valued at raw</span>
         <span class="grade-net">—</span>
       </div>`
    : '';

  // where the gem rate came from, with sample size
  let gemBlock = '';
  if (gemRate && gemRate.source === 'gemrate') {
    // 95% interval, so a rate from 12 submissions doesn't look as solid as one from 100k
    const iv = gemRate.interval;
    const band = iv
      ? `<span class="gem-band">95% confident: ${pct(iv.low)} – ${pct(iv.high)}</span>` : '';

    // if a haircut is applied, show both the measured rate and the one we used
    const cut = gemRate.haircut > 0
      ? `<span class="gem-cut">${pct(gemRate.measuredRate)} measured, cut ${Math.round(gemRate.haircut * 100)}% for submission bias</span>` : '';

    gemBlock = `
      <div class="gem-block">
        <span class="gem-rate">${pct(gemRate.rate)} gem rate</span>
        ${cut}
        <span class="gem-n">${gemRate.psa10Pop.toLocaleString()} PSA 10s from ${gemRate.totalPop.toLocaleString()} submissions${gemRate.parallel ? ' · ' + escapeHtml(gemRate.parallel) : ''}</span>
        ${band}
        <span class="gem-src">Population data by GemRate${gemRate.asOf ? ', as of ' + escapeHtml(gemRate.asOf) : ''}</span>
      </div>`;
  } else if (gemRate) {
    gemBlock = `
      <div class="gem-block gem-block--assumed">
        <span class="gem-rate">${pct(gemRate.rate)} gem rate</span>
        <span class="gem-n">your assumption — no population data for this card</span>
      </div>`;
  }

  // break-even price plus the spread of outcomes (the average alone hides how often you lose)
  let buyBlock = '';
  if (result.maxBuy > 0 && result.ifBought) {
    const d = result.ifBought;
    const risk = d.lossOdds
      ? `about <strong>1 in ${d.lossOdds}</strong> chance you lose money`
      : `a <strong>${pct(d.lossProb)}</strong> chance you lose money`;
    buyBlock = `
      <div class="buy-block">
        <span class="buy-label">Buying it to grade? Don't pay over</span>
        <span class="buy-price">${money(result.maxBuy)}</span>
        <p class="buy-risk">
          That's the break-even — at it you make nothing on average. Pay it and
          the typical result is <strong>${money(d.median)}</strong> (${escapeHtml(d.medianLabel)}),
          with ${risk}.
        </p>
        <div class="buy-outcomes">
          ${d.outcomes.map(o => `
            <div class="buy-row">
              <span class="buy-grade">${escapeHtml(o.label)}</span>
              <span class="buy-odds">${pct(o.prob)}</span>
              <span class="buy-net ${o.net < 0 ? 'neg' : 'pos'}">${money(o.net)}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  // one caveat covering the assumptions behind the verdict
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
    ? `<span class="verdict-raw">Raw: ${price(comps.raw.avg)}${comps.raw.count != null ? ' · ' + comps.raw.count + ' sales' : ''}</span>` : '';

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

    ${buyBlock}
  `;
}

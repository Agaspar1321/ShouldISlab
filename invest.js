// ===== ShouldISlab — /invest : what should I pay? =====
//
// The verdict panel on the home page answers "don't pay over $X" and stops. This
// page is where that becomes a decision you can actually move around.
//
// Everything the slider does is local arithmetic, no round-trips. That works
// because every outcome's payoff is LINEAR in the purchase price:
//
//     net_i(P) = gross_i - P
//
// The server ships `gross` per outcome once (payout after fees and grading, before
// any purchase price). Then any price is a subtraction. Two consequences worth
// knowing: the whole distribution shifts rigidly, so the MEDIAN BUCKET never
// changes as you drag — only its value does. And the gap between flipping raw and
// grading is constant, because P cancels out of the comparison entirely.

const searchBtn  = document.getElementById('searchBtn');
const cardSearch = document.getElementById('cardSearch');
const pickList   = document.getElementById('pickList');
const deal       = document.getElementById('deal');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const group = (n, dp) => Number(n).toLocaleString('en-US', {
  minimumFractionDigits: dp, maximumFractionDigits: dp,
});
const money = (n) => (n < 0 ? `-$${group(Math.abs(n), 2)}` : `$${group(n, 2)}`);
const price = (n) => `$${group(n, 0)}`;
const pct   = (n) => (n * 100).toFixed(n < 0.01 ? 2 : 1) + '%';

function assumptionsQS() {
  const num = (id) => parseFloat((document.getElementById(id).value || '').replace(/[^0-9.]/g, ''));
  const gradingCost = num('gradingCost') || 80;
  const feePct      = num('feePct')      || 13;
  const gemRate     = num('gemRate')     || 50;
  const haircut     = parseFloat(document.getElementById('condition').value) || 0;
  return `gradingCost=${gradingCost}&feePct=${feePct}&gemRate=${gemRate}&haircut=${haircut}`;
}

// ---------- search ----------
async function runSearch() {
  const query = cardSearch.value.trim();
  if (!query) return;
  pickList.innerHTML = '<p class="pick-status">Searching…</p>';
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(query));
    if (res.status === 429) {
      const { retryAfter } = await res.json().catch(() => ({}));
      pickList.innerHTML = `<p class="pick-status">Busy right now — try again in about ${retryAfter || 35} seconds.</p>`;
      return;
    }
    const cards = await res.json();
    if (!Array.isArray(cards) || cards.length === 0) {
      pickList.innerHTML = '<p class="pick-status">No cards found. Try another search.</p>';
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
    pickList.innerHTML = '<p class="pick-status">Search failed — is the server running?</p>';
  }
}

searchBtn.addEventListener('click', runSearch);
cardSearch.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });

// ---------- pick a card ----------
let current = null;   // everything the slider needs, held locally

async function selectCard(el) {
  document.querySelectorAll('.pick-card').forEach(c => c.classList.remove('is-selected'));
  el.classList.add('is-selected');
  deal.innerHTML = '<div class="results-empty"><p>Pulling recent sales…</p></div>';

  try {
    const res = await fetch('/api/comps?card_id=' + encodeURIComponent(el.dataset.cardId)
      + '&gemrate_id=' + encodeURIComponent(el.dataset.gemrateId || '')
      + '&' + assumptionsQS());
    if (res.status === 429) {
      const { retryAfter } = await res.json().catch(() => ({}));
      deal.innerHTML = `<div class="results-empty"><p>Busy right now — try again in about ${retryAfter || 35} seconds.</p></div>`;
      return;
    }
    if (!res.ok) throw new Error('server ' + res.status);
    const data = await res.json();

    // Three outcomes, and they are NOT the same thing. Collapsing them into one
    // "no data" message made a real answer look like a broken page.
    if (!data.result || !data.result.ifBought || !data.comps.raw.sampleSize) {
      deal.innerHTML = '<div class="results-empty"><p>Not enough recent sales on this card to price a deal.</p></div>';
      return;
    }

    // maxBuy of 0 is an ANSWER: grading costs more than the card can ever be
    // worth, so no purchase price makes it work. Show the arithmetic rather than
    // pretending the data is missing.
    if (!data.result.maxBuy) {
      const r = data.result;
      deal.innerHTML = `
        <div class="deal-head">
          ${el.dataset.image ? `<img class="verdict-card-img" src="${escapeHtml(el.dataset.image)}" alt="">` : ''}
          <div>
            <p class="verdict-card-name">${escapeHtml(el.dataset.title)}</p>
            <span class="buy-label">Don't buy this to grade</span>
            <span class="buy-price buy-price--neg">At any price</span>
            <span class="deal-sub">Raw comps sit at ${price(data.comps.raw.median)}</span>
          </div>
        </div>
        <p class="buy-risk">
          Weighted across every outcome this grades out to
          <strong>${money(r.expectedGradedValue)}</strong>. After ${pct((parseFloat(document.getElementById('feePct').value) || 13) / 100)}
          fees and ${price(parseFloat(document.getElementById('gradingCost').value) || 80)} grading you net
          <strong>${money(r.netIfGrade)}</strong> — a loss before you have paid a cent for the card.
          Even free, it loses money.
        </p>
        <div class="buy-outcomes">
          ${[...r.ifBought.outcomes].sort((a, b) => b.gross - a.gross).map(o => `
            <div class="buy-row">
              <span class="buy-grade">${escapeHtml(o.label)}</span>
              <span class="buy-odds">${pct(o.prob)}</span>
              <span class="buy-net ${o.gross < 0 ? 'neg' : 'pos'}">${money(o.gross)}</span>
            </div>`).join('')}
        </div>
        <p class="strategy-note">Those figures assume the card costs you nothing. Flipping it raw
          at ${price(data.comps.raw.median)} is the better move.</p>`;
      current = null;
      return;
    }

    const fee = (parseFloat(document.getElementById('feePct').value) || 13) / 100;
    current = {
      title: el.dataset.title,
      image: el.dataset.image,
      maxBuy: data.result.maxBuy,
      outcomes: data.result.ifBought.outcomes,   // each carries `gross`
      rawComp: data.comps.raw.median,
      rawNet: data.comps.raw.median * (1 - fee),  // what flipping it raw nets you
      gemRate: data.gemRate,
    };
    renderDeal(current.maxBuy);
  } catch (e) {
    deal.innerHTML = '<div class="results-empty"><p>Couldn\'t price that card.</p></div>';
  }
}

// ---------- the deal, at a given purchase price ----------
function statsAt(P) {
  const o = current.outcomes;
  const expected = o.reduce((s, x) => s + x.prob * (x.gross - P), 0);
  const lossProb = o.filter(x => x.gross - P < 0).reduce((s, x) => s + x.prob, 0);

  // The distribution shifts rigidly with P, so the median BUCKET is fixed — only
  // its value moves. Walk worst-to-best to the 50th percentile once.
  const byPayoff = [...o].sort((a, b) => a.gross - b.gross);
  let cum = 0, medianBucket = byPayoff[byPayoff.length - 1];
  for (const x of byPayoff) { cum += x.prob; if (cum >= 0.5) { medianBucket = x; break; } }

  return { expected, lossProb, median: medianBucket.gross - P, medianLabel: medianBucket.label };
}

function renderDeal(P) {
  const c = current;
  const s = statsAt(P);
  const gradeNet = s.expected;              // buy at P, grade it
  const flipNet  = c.rawNet - P;            // buy at P, flip it raw
  // P cancels out of the difference, so which strategy wins never changes with price.
  const edge = c.outcomes.reduce((t, x) => t + x.prob * x.gross, 0) - c.rawNet;

  const risk = s.lossProb < 0.5 && s.lossProb > 0
    ? `about <strong>1 in ${Math.round(1 / s.lossProb)}</strong> chance you lose money`
    : `a <strong>${pct(s.lossProb)}</strong> chance you lose money`;

  const max = Math.max(Math.round(c.maxBuy * 1.6), 10);

  deal.innerHTML = `
    <div class="deal-head">
      ${c.image ? `<img class="verdict-card-img" src="${escapeHtml(c.image)}" alt="">` : ''}
      <div>
        <p class="verdict-card-name">${escapeHtml(c.title)}</p>
        <span class="buy-label">Don't pay over</span>
        <span class="buy-price">${price(c.maxBuy)}</span>
        <span class="deal-sub">Raw comps sit at ${price(c.rawComp)}</span>
      </div>
    </div>

    <div class="slider-wrap">
      <label for="priceSlider">Your price <strong id="priceOut">${price(P)}</strong></label>
      <input type="range" id="priceSlider" min="1" max="${max}" step="1" value="${Math.round(P)}">
      <div class="slider-ends"><span>$1</span><span>${price(max)}</span></div>
    </div>

    <div class="stat-grid">
      <div class="stat stat--hero ${s.expected > 0 ? 'pos' : 'neg'}">
        <span class="stat-label">Expected profit</span>
        <span class="stat-value">${money(s.expected)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Typical outcome</span>
        <span class="stat-value ${s.median < 0 ? 'neg' : 'pos'}">${money(s.median)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Chance you lose money</span>
        <span class="stat-value">${pct(s.lossProb)}</span>
      </div>
    </div>

    <p class="buy-risk">At ${price(P)} the typical result is
      <strong>${money(s.median)}</strong> (${escapeHtml(s.medianLabel)}), with ${risk}.</p>

    <div class="strategy">
      <h3>Flip it raw, or grade it?</h3>
      <div class="strategy-row ${flipNet > gradeNet ? 'is-better' : ''}">
        <span class="strategy-name">Flip raw</span>
        <span class="strategy-sub">sell at ${price(c.rawComp)} less fees</span>
        <span class="strategy-net ${flipNet < 0 ? 'neg' : 'pos'}">${money(flipNet)}</span>
      </div>
      <div class="strategy-row ${gradeNet >= flipNet ? 'is-better' : ''}">
        <span class="strategy-name">Grade it</span>
        <span class="strategy-sub">expected across every outcome</span>
        <span class="strategy-net ${gradeNet < 0 ? 'neg' : 'pos'}">${money(gradeNet)}</span>
      </div>
      <p class="strategy-note">
        Grading is worth <strong>${money(Math.abs(edge))}</strong> ${edge >= 0 ? 'more' : 'less'} than flipping,
        and that gap doesn't change with your price — what you pay comes off both equally.
        The slider only decides whether <em>either</em> is worth doing.
      </p>
    </div>

    <div class="buy-outcomes">
      ${[...c.outcomes].sort((a, b) => b.gross - a.gross).map(o => `
        <div class="buy-row">
          <span class="buy-grade">${escapeHtml(o.label)}</span>
          <span class="buy-odds">${pct(o.prob)}</span>
          <span class="buy-net ${o.gross - P < 0 ? 'neg' : 'pos'}">${money(o.gross - P)}</span>
        </div>`).join('')}
    </div>

    ${c.gemRate && c.gemRate.source === 'gemrate' ? `
      <p class="gem-src">Gem rate ${pct(c.gemRate.rate)} from ${c.gemRate.totalPop.toLocaleString()} PSA submissions · population data by GemRate</p>` : ''}
  `;

  const slider = document.getElementById('priceSlider');
  slider.addEventListener('input', () => {
    // Re-render only the numbers, not the slider — re-rendering it mid-drag
    // would drop the pointer capture and the thumb would stop following.
    updateNumbers(Number(slider.value));
  });
}

// Live update on drag. Touches text only so the slider keeps focus and capture.
function updateNumbers(P) {
  const c = current;
  const s = statsAt(P);
  const gradeNet = s.expected;
  const flipNet  = c.rawNet - P;

  document.getElementById('priceOut').textContent = price(P);

  const stats = document.querySelectorAll('.stat-value');
  stats[0].textContent = money(s.expected);
  stats[0].parentElement.className = `stat stat--hero ${s.expected > 0 ? 'pos' : 'neg'}`;
  stats[1].textContent = money(s.median);
  stats[1].className = `stat-value ${s.median < 0 ? 'neg' : 'pos'}`;
  stats[2].textContent = pct(s.lossProb);

  const risk = s.lossProb < 0.5 && s.lossProb > 0
    ? `about <strong>1 in ${Math.round(1 / s.lossProb)}</strong> chance you lose money`
    : `a <strong>${pct(s.lossProb)}</strong> chance you lose money`;
  document.querySelector('.buy-risk').innerHTML =
    `At ${price(P)} the typical result is <strong>${money(s.median)}</strong> (${escapeHtml(s.medianLabel)}), with ${risk}.`;

  const rows = document.querySelectorAll('.strategy-row');
  rows[0].querySelector('.strategy-net').textContent = money(flipNet);
  rows[0].querySelector('.strategy-net').className = `strategy-net ${flipNet < 0 ? 'neg' : 'pos'}`;
  rows[1].querySelector('.strategy-net').textContent = money(gradeNet);
  rows[1].querySelector('.strategy-net').className = `strategy-net ${gradeNet < 0 ? 'neg' : 'pos'}`;

  document.querySelectorAll('.buy-outcomes .buy-row').forEach((row, i) => {
    const o = [...c.outcomes].sort((a, b) => b.gross - a.gross)[i];
    const net = o.gross - P;
    const el = row.querySelector('.buy-net');
    el.textContent = money(net);
    el.className = `buy-net ${net < 0 ? 'neg' : 'pos'}`;
  });
}

// Changing an assumption invalidates the numbers — re-pull rather than lie.
['gradingCost', 'feePct', 'condition'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    const sel = document.querySelector('.pick-card.is-selected');
    if (sel) selectCard(sel);
  });
});

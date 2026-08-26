const API_PROXY = '/.netlify/functions/api';

let stopped = false;
let scanning = false;
let lastBets = [];
let cache = new Map();
let leagueCache = [];
let diagnostics = { fixtures: 0, oddsFixtures: 0, oddsRows: 0, modelable: 0, rejectedProb: 0, rejectedEV: 0, noHistory: 0, noOdds: 0 };
let nearMisses = [];

const $ = id => document.getElementById(id);

const today = new Date();
$('date').value = new Date(today.getTime() - today.getTimezoneOffset() * 60000)
  .toISOString().slice(0, 10);

setStatus('API connection ready — key checked server-side');

$('stop').onclick = () => {
  stopped = true;
  setProgress('Stopping after the current request…');
};
$('scan').onclick = scan;
$('export').onclick = exportCsv;
$('loadLeagues').onclick = loadLeagues;

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = 'status ' + cls;
}

function setProgress(text) {
  $('progress').textContent = text;
}

async function api(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const r = await fetch(`${API_PROXY}?path=${encodeURIComponent(path)}`, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });

    let d;
    try { d = await r.json(); }
    catch { throw new Error('API returned invalid JSON'); }

    if (!r.ok || (d.errors && Object.keys(d.errors).length)) {
      const errors = typeof d.errors === 'object' ? Object.values(d.errors) : [`HTTP ${r.status}`];
      throw new Error(errors.join(', '));
    }
    return d;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('API request timed out');
    throw new Error(err.message || 'Network error');
  } finally {
    clearTimeout(timeout);
  }
}

function cacheGet(key) { return cache.get(key); }
function cacheSet(key, value) { cache.set(key, value); return value; }

function chunks(a, n) {
  const out = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

function n(v) {
  const x = parseFloat(String(v ?? '').replace('%', ''));
  return Number.isFinite(x) ? x : null;
}

function statValue(fixture, name, side) {
  const block = (fixture.statistics || []).find(x => String(x.team?.name || '').toLowerCase() === String(side).toLowerCase());
  const x = block?.statistics?.find(s => String(s.type).toLowerCase() === name.toLowerCase());
  return n(x?.value);
}

function totalFromFixture(f, type) {
  const h = statValue(f, type, f.teams?.home?.name);
  const a = statValue(f, type, f.teams?.away?.name);
  return h != null && a != null ? h + a : null;
}

function goals(f) {
  return f.goals?.home != null && f.goals?.away != null
    ? f.goals.home + f.goals.away
    : null;
}

function btts(f) {
  return f.goals?.home > 0 && f.goals?.away > 0 ? 1 : 0;
}

function metric(f, market) {
  if (market === 'goals') return goals(f);
  if (market === 'btts') return btts(f);
  if (market === 'corners') return totalFromFixture(f, 'Corner Kicks');
  if (market === 'shots') return totalFromFixture(f, 'Total Shots');
  if (market === 'sot') return totalFromFixture(f, 'Shots on Goal');
  if (market === 'cards') return totalFromFixture(f, 'Yellow Cards');
  return null;
}

function venueForFixture(f, teamId) {
  if (f.teams?.home?.id === teamId) return 'home';
  if (f.teams?.away?.id === teamId) return 'away';
  return null;
}

function recencyWeight(index) {
  return Math.pow(0.92, index);
}

function weightedHitRate(values, line, side) {
  let hitWeight = 0;
  let totalWeight = 0;
  values.forEach((v, index) => {
    if (v == null) return;
    const w = recencyWeight(index);
    totalWeight += w;
    const hit = side === 'over' ? v > line : v <= line;
    if (hit) hitWeight += w;
  });
  return totalWeight ? { hitWeight, totalWeight } : null;
}

function modelProbability(venueValues, overallValues, line, side, market) {
  const venue = weightedHitRate(venueValues, line, side);
  const overall = weightedHitRate(overallValues, line, side);
  if (!venue && !overall) return null;

  // Venue-specific form carries most of the signal; overall form stabilises small samples.
  const venueShare = venue ? 0.72 : 0;
  const overallShare = overall ? (venue ? 0.28 : 1) : 0;
  const priorStrength = market === 'btts' ? 5 : 4;

  let hits = priorStrength * 0.5;
  let exposure = priorStrength;

  if (venue) {
    hits += venue.hitWeight * venueShare;
    exposure += venue.totalWeight * venueShare;
  }
  if (overall) {
    hits += overall.hitWeight * overallShare;
    exposure += overall.totalWeight * overallShare;
  }

  // Bayesian/Laplace-style shrinkage keeps tiny samples from producing extreme probabilities.
  return Math.max(1, Math.min(99, hits / exposure * 100));
}

function fairOdds(prob) {
  return prob > 0 ? 100 / prob : null;
}

function ev(prob, odds) {
  return prob != null && odds > 0 ? (prob / 100 * odds - 1) * 100 : null;
}

function implied(odds) {
  return odds > 0 ? 100 / odds : null;
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function marketBucket(name) {
  const x = normalize(name);
  // API-Football bookmaker market names vary slightly by bookmaker.
  if ((x.includes('goals') || x.includes('totalgoals')) && (x.includes('overunder') || x.includes('ou'))) return 'goals';
  if (x.includes('bothteamsscore') || x.includes('btts')) return 'btts';
  if (x.includes('corner') && (x.includes('overunder') || x.includes('ou'))) return 'corners';
  if ((x.includes('totalshots') || x === 'shots') && !x.includes('ongoal') && !x.includes('ontarget') && (x.includes('overunder') || x.includes('ou'))) return 'shots';
  if ((x.includes('shotsongoal') || x.includes('shotsontarget') || x.includes('shotsontargets')) && (x.includes('overunder') || x.includes('ou'))) return 'sot';
  if (x.includes('card') && (x.includes('overunder') || x.includes('ou'))) return 'cards';
  return null;
}

function parseValue(v) {
  const s = String(v?.value ?? v?.name ?? '');
  const m = s.match(/(over|under)\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (m) return { side: m[1].toLowerCase(), line: parseFloat(m[2]), label: s };
  if (/^(yes|no)$/i.test(s)) return { side: s.toLowerCase(), line: 0, label: s };
  return null;
}

function extractOdds(data, wanted) {
  const out = [];
  const fixtureBlock = data.response?.[0];
  for (const book of (fixtureBlock?.bookmakers || [])) {
    for (const bet of (book.bets || [])) {
      const market = marketBucket(bet.name);
      if (!market || !wanted.includes(market)) continue;
      for (const val of (bet.values || [])) {
        const parsed = parseValue(val);
        const odds = n(val.odd);
        if (!parsed || odds == null || odds <= 1) continue;
        out.push({
          market,
          side: parsed.side,
          line: market === 'btts' ? 0 : parsed.line,
          label: parsed.label,
          odds,
          book: book.name
        });
      }
    }
  }
  return out;
}

function consolidateOdds(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.market}|${row.side}|${row.line}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(group => {
    group.sort((a, b) => b.odds - a.odds);
    const avgImplied = group.reduce((s, x) => s + implied(x.odds), 0) / group.length;
    return {
      ...group[0],
      bestOdds: group[0].odds,
      book: group[0].book,
      books: group.length,
      consensus: 100 - avgImplied,
      allOdds: group
    };
  });
}

async function getHistory(teamId, season, league, last) {
  const ck = `hist:${teamId}:${season}:${league}:${last}`;
  const cached = cacheGet(ck);
  if (cached) return cached;

  const d = await api(`/fixtures?team=${teamId}&season=${season}&league=${league}&last=${last}`);
  const ids = (d.response || []).filter(x => ['FT', 'AET', 'PEN'].includes(x.fixture?.status?.short))
    .map(x => x.fixture?.id).filter(Boolean);

  const result = [];
  for (const group of chunks(ids, 20)) {
    const detail = await api(`/fixtures?ids=${group.join('-')}`);
    result.push(...(detail.response || []));
  }
  result.sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
  return cacheSet(ck, result);
}

async function getOdds(id) {
  const ck = `odds:${id}`;
  const cached = cacheGet(ck);
  if (cached) return cached;
  return cacheSet(ck, await api(`/odds?fixture=${id}`));
}

async function getLeagues() {
  const ck = 'leagues:current';
  const cached = cacheGet(ck);
  if (cached) return cached;
  const d = await api('/leagues?current=true');
  return cacheSet(ck, d.response || []);
}

async function loadLeagues() {
  const btn = $('loadLeagues');
  btn.disabled = true;
  try {
    setProgress('Loading current leagues…');
    const rows = await getLeagues();
    leagueCache = rows;
    const select = $('league');
    const previous = select.value;
    const sorted = rows.sort((a, b) => `${a.country?.name || ''}${a.league?.name || ''}`.localeCompare(`${b.country?.name || ''}${b.league?.name || ''}`));
    select.innerHTML = '<option value="">All leagues</option>' + sorted.map(x =>
      `<option value="${escAttr(x.league?.id)}">${esc(x.country?.name || 'Other')} — ${esc(x.league?.name || 'Unknown')}</option>`
    ).join('');
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
    setProgress(`${rows.length} current leagues loaded.`);
  } catch (err) {
    setStatus('Could not load leagues', 'err');
    setProgress(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function scan() {
  if (scanning) return;
  stopped = false;
  cache = new Map([...cache].filter(([k]) => k.startsWith('leagues:')));
  $('results').innerHTML = '';
  lastBets = [];
  nearMisses = [];
  diagnostics = { fixtures: 0, oddsFixtures: 0, oddsRows: 0, modelable: 0, rejectedProb: 0, rejectedEV: 0, noHistory: 0, noOdds: 0 };
  $('fixtureCount').textContent = '0';
  $('betCount').textContent = '0';
  $('avgEV').textContent = '0%';

  const date = $('date').value;
  const max = Math.min(300, Math.max(1, Number($('maxFixtures').value) || 50));
  const hist = Math.min(20, Math.max(5, Number($('history').value) || 10));
  const minProb = Number($('minProb').value) || 0;
  const minEV = Number($('minEV').value);
  const league = $('league').value;
  const wanted = [...document.querySelectorAll('.markets input:checked')].map(x => x.value);

  if (!date) return setStatus('Choose a date', 'err');
  if (!wanted.length) return setStatus('Select at least one market', 'err');

  scanning = true;
  $('scan').disabled = true;
  try {
    setStatus('Loading fixtures…');
    const fd = await api(`/fixtures?date=${encodeURIComponent(date)}${league ? `&league=${encodeURIComponent(league)}` : ''}`);
    const fixtures = (fd.response || [])
      .filter(f => ['NS', 'TBD'].includes(f.fixture?.status?.short))
      .slice(0, max);

    $('fixtureCount').textContent = fixtures.length;
    diagnostics.fixtures = fixtures.length;
    if (!fixtures.length) {
      setStatus('No upcoming fixtures');
      return setProgress('No fixtures found for this date and league filter.');
    }

    const allBets = [];
    let done = 0;

    for (const f of fixtures) {
      if (stopped) break;
      const season = f.league?.season;
      const leagueId = f.league?.id;
      const home = f.teams?.home?.id;
      const away = f.teams?.away?.id;
      if (!season || !leagueId || !home || !away) continue;

      setProgress(`Analysing ${++done}/${fixtures.length}: ${f.teams.home.name} vs ${f.teams.away.name}`);

      try {
        const [homeHistory, awayHistory, oddsData] = await Promise.all([
          getHistory(home, season, leagueId, hist),
          getHistory(away, season, leagueId, hist),
          getOdds(f.fixture.id)
        ]);

        const extracted = extractOdds(oddsData, wanted);
        diagnostics.oddsRows += extracted.length;
        const odds = consolidateOdds(extracted);
        if (!odds.length) { diagnostics.noOdds++; continue; }
        diagnostics.oddsFixtures++;

        for (const o of odds) {
          let venueValues = [];
          let overallValues = [];

          if (o.market === 'btts') {
            venueValues = homeHistory.filter(x => venueForFixture(x, home) === 'home').map(btts)
              .concat(awayHistory.filter(x => venueForFixture(x, away) === 'away').map(btts));
            overallValues = homeHistory.map(btts).concat(awayHistory.map(btts));
          } else {
            const homeVenue = homeHistory.filter(x => venueForFixture(x, home) === 'home').map(x => metric(x, o.market));
            const awayVenue = awayHistory.filter(x => venueForFixture(x, away) === 'away').map(x => metric(x, o.market));
            const homeOverallVals = homeHistory.map(x => metric(x, o.market));
            const awayOverallVals = awayHistory.map(x => metric(x, o.market));
            venueValues = homeVenue.concat(awayVenue);
            overallValues = homeOverallVals.concat(awayOverallVals);
          }

          const side = o.market === 'btts' ? (o.side === 'yes' ? 'over' : 'under') : o.side;
          const sampleCount = venueValues.filter(v => v != null).length;
          if (sampleCount < 5) { diagnostics.noHistory++; continue; }

          const p = modelProbability(venueValues, overallValues, o.line, side, o.market);
          const e = ev(p, o.bestOdds);
          if (p == null || e == null) continue;

          diagnostics.modelable++;
          allBets.push({
            fixture: f,
            bet: o,
            prob: p,
            ev: e,
            fairOdds: fairOdds(p),
            sample: sampleCount,
            venueSample: sampleCount,
            consensus: o.consensus,
            passesProbability: p >= minProb,
            passesEV: e >= minEV
          });
        }
      } catch (err) {
        console.warn(`Failed ${f.teams?.home?.name} vs ${f.teams?.away?.name}`, err);
      }
    }

    lastBets = allBets;
    render(allBets);
    renderDiagnostics();
    setStatus(stopped ? 'Stopped' : 'Scan complete');
    setProgress(`${allBets.length} bets passed the filters. ${diagnostics.modelable} market lines were modelable.`);
  } catch (err) {
    setStatus('Scan failed', 'err');
    setProgress(err.message);
  } finally {
    scanning = false;
    $('scan').disabled = false;
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[ch]);
}
function escAttr(value) { return esc(value); }
function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCsv() {
  if (!lastBets.length) return setProgress('Run a scan first — there are no results to export.');
  const rows = [['Date','Time','League','Home','Away','Market','Best bookmaker','Odds','Model probability %','Fair odds','EV %','Books','Consensus %','Sample']];
  for (const x of lastBets) {
    const f = x.fixture;
    rows.push([
      new Date(f.fixture.date).toISOString().slice(0,10),
      new Date(f.fixture.date).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}),
      f.league?.name || '', f.teams?.home?.name || '', f.teams?.away?.name || '',
      x.bet.label, x.bet.book, x.bet.bestOdds.toFixed(2), x.prob.toFixed(1),
      x.fairOdds?.toFixed(2) || '', x.ev.toFixed(1), x.bet.books, x.consensus.toFixed(1), x.sample
    ]);
  }
  const blob = new Blob([rows.map(r => r.map(csvCell).join(',')).join('\n')], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `value-bets-${$('date').value || 'scan'}.csv`; a.click();
  URL.revokeObjectURL(url);
}

function safetyScore(x) {
  // A ranking aid only: higher model probability + more history is preferred.
  // It is not a guarantee of safety or profit.
  const sampleBonus = Math.min(10, x.sample) * 0.5;
  return x.prob + sampleBonus;
}

function preferredPick(list) {
  return [...list].sort((a, b) => safetyScore(b) - safetyScore(a))[0] || null;
}

function renderDiagnostics() {
  const box = $('diagnostics');
  if (!box) return;
  box.innerHTML = `<div class="diag-grid">
    <div><b>${diagnostics.fixtures}</b><span>fixtures</span></div>
    <div><b>${diagnostics.oddsFixtures}</b><span>with supported odds</span></div>
    <div><b>${diagnostics.oddsRows}</b><span>bookmaker lines</span></div>
    <div><b>${diagnostics.modelable}</b><span>modelled markets</span></div>
    <div><b>${diagnostics.noHistory}</b><span>insufficient stats</span></div>
    <div><b>${diagnostics.noOdds}</b><span>no supported odds</span></div>
  </div>
  <div class="model-note"><strong>How to read this:</strong> every modelled market is shown below. The scanner no longer hides a match just because it misses your probability/EV thresholds. Look for the <strong>Safer model pick</strong>, then compare the bookmaker price with the model's <strong>fair odds</strong>. A price above fair odds is where the model sees value; a little extra margin above fair odds gives you more room for model error. Nothing here is guaranteed.</div>`;
}

function render(bets) {
  bets.sort((a,b) => safetyScore(b) - safetyScore(a));
  $('betCount').textContent = bets.length;
  $('avgEV').textContent = bets.length ? (bets.reduce((s,x)=>s+x.ev,0)/bets.length).toFixed(2)+'%' : '0%';

  const by = new Map();
  for (const b of bets) {
    const id = b.fixture.fixture.id;
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(b);
  }

  let html = '';
  for (const list of by.values()) {
    list.sort((a,b) => safetyScore(b) - safetyScore(a));
    const f = list[0].fixture;
    const time = new Date(f.fixture.date).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    const pick = preferredPick(list);
    const pickFair = pick.fairOdds;
    const targetOdds = pickFair ? pickFair * 1.05 : null;
    const pickValue = pick.ev > 0;

    html += `<article class="card">
      <div class="meta">${esc(time)} • ${esc(f.league?.name || 'Unknown league')}</div>
      <div class="match">${esc(f.teams.home.name)} <span>vs</span> ${esc(f.teams.away.name)}</div>
      ${pick ? `<div class="recommendation">
        <div class="rec-title">Safer model pick <span>not a guarantee</span></div>
        <div class="rec-main">${esc(pick.bet.label)}</div>
        <div class="rec-grid">
          <div><strong>${pick.prob.toFixed(1)}%</strong><small>model probability</small></div>
          <div><strong>${pickFair.toFixed(2)}</strong><small>fair odds</small></div>
          <div><strong>${targetOdds.toFixed(2)}</strong><small>price to look for*</small></div>
          <div><strong>${pick.bet.bestOdds.toFixed(2)}</strong><small>best current price</small></div>
        </div>
        <div class="muted">${pickValue ? `Current price is ${pick.ev.toFixed(1)}% model EV.` : `Current price is ${pick.ev.toFixed(1)}% model EV — below the model's fair-value threshold.`} ${pick.bet.books} bookmaker${pick.bet.books === 1 ? '' : 's'} compared.</div>
      </div>` : ''}
      <div class="markets-title">Available modelled markets</div>`;

    for (const x of list) {
      const edge = x.prob - x.consensus;
      const valueClass = x.ev >= minEV ? 'good' : '';
      const probClass = x.prob >= minProb ? 'good' : '';
      html += `<div class="bet ${valueClass}">
        <div>
          <div class="market">${esc(x.bet.label)}</div>
          <div class="muted">Best: ${esc(x.bet.book)} @ ${x.bet.bestOdds.toFixed(2)} • ${x.bet.books} book${x.bet.books === 1 ? '' : 's'}</div>
          <div class="muted">Model <span class="${probClass}">${x.prob.toFixed(1)}%</span> • consensus ${x.consensus.toFixed(1)}% • fair ${x.fairOdds.toFixed(2)} • sample ${x.sample}</div>
        </div>
        <div class="numbers">${x.ev >= 0 ? '+' : ''}${x.ev.toFixed(1)}% EV<br><span class="edge">${edge >= 0 ? '+' : ''}${edge.toFixed(1)}% model edge</span></div>
      </div>`;
    }

    html += `</article>`;
  }

  $('results').innerHTML = html || `<div class="panel"><strong>No modelled markets were available.</strong><p>This usually means the selected competition/fixtures did not return enough historical statistics or supported bookmaker markets.</p></div>`;
}

loadLeagues();

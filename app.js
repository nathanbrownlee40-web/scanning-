const API_PROXY = '/.netlify/functions/api';

let stopped = false;
let scanning = false;
let lastBets = [];
let cache = new Map();

const $ = id => document.getElementById(id);

const today = new Date();
$('date').value = new Date(today.getTime() - today.getTimezoneOffset() * 60000)
  .toISOString().slice(0, 10);

const configured = true;
setStatus('API connection ready — key checked server-side');

$('stop').onclick = () => {
  stopped = true;
  setProgress('Stopping after the current request…');
};
$('scan').onclick = scan;
$('export').onclick = exportCsv;

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = 'status ' + cls;
}

function setProgress(text) {
  $('progress').textContent = text;
}

function key() {
  return configured ? 'server' : '';
}

async function api(path) {
  if (!key()) throw new Error('API proxy is unavailable.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(`${API_PROXY}?path=${encodeURIComponent(path)}`, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });

    let d;
    try { d = await r.json(); }
    catch { throw new Error('API returned invalid JSON'); }

    if (!r.ok || (d.errors && Object.keys(d.errors).length)) {
      throw new Error(
        typeof d.errors === 'object'
          ? Object.values(d.errors).join(', ')
          : `HTTP ${r.status}`
      );
    }
    return d;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('API request timed out');
    throw new Error(`Network error: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function chunks(a, n) {
  const out = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

function n(v) {
  const x = parseFloat(String(v ?? '').replace('%', ''));
  return Number.isFinite(x) ? x : null;
}

function statValue(stat, name, side) {
  const x = stat?.statistics?.find(
    s => String(s.type).toLowerCase() === name.toLowerCase()
  );
  return n(x?.[side]);
}

function fixtureStats(f) {
  return f.statistics || [];
}

function totalFromFixture(f, type) {
  const h = statValue(f, type, 'home');
  const a = statValue(f, type, 'away');
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

function probability(values, line, side) {
  const usable = values.filter(v => v != null);
  if (usable.length < 5) return null;

  const hits = usable.filter(v => side === 'over' ? v > line : v <= line).length;

  // Laplace smoothing avoids displaying 0% or 100% from a small sample.
  return (hits + 1) / (usable.length + 2) * 100;
}

function ev(prob, odds) {
  return prob != null && odds > 0 ? (prob / 100 * odds - 1) * 100 : null;
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function marketBucket(name) {
  const x = normalize(name);

  if (x.includes('goalsoverunder')) return 'goals';
  if (x.includes('bothteamsscore')) return 'btts';
  if (x.includes('cornerkicks') && x.includes('overunder')) return 'corners';
  if (x.includes('totalshots') && x.includes('overunder')) return 'shots';
  if ((x.includes('shotsongoal') || x.includes('shotsontarget')) && x.includes('overunder')) return 'sot';
  if ((x.includes('totalcards') || x.includes('cards')) && x.includes('overunder')) return 'cards';

  return null;
}

function parseValue(v) {
  const s = String(v?.value ?? v?.name ?? '');
  const m = s.match(/(over|under)\s*([0-9]+(?:\.[0-9]+)?)/i);

  if (m) {
    return {
      side: m[1].toLowerCase(),
      line: parseFloat(m[2]),
      label: s
    };
  }

  if (/^(yes|no)$/i.test(s)) {
    return {
      side: s.toLowerCase(),
      line: 0,
      label: s
    };
  }

  return null;
}

function extractOdds(data, wanted) {
  const out = [];

  for (const book of (data.response?.[0]?.bookmakers || [])) {
    for (const bet of (book.bets || [])) {
      const bucket = marketBucket(bet.name);
      if (!bucket || !wanted.includes(bucket)) continue;

      for (const val of (bet.values || [])) {
        const p = parseValue(val);
        const odds = n(val.odd);

        if (!p || odds == null) continue;

        out.push({
          market: bucket,
          side: p.side,
          line: bucket === 'btts' ? 0 : p.line,
          label: p.label,
          odds,
          book: book.name
        });
      }
    }
  }

  return out;
}

async function getHistory(teamId, season, last) {
  const ck = `hist:${teamId}:${season}:${last}`;
  if (cache.has(ck)) return cache.get(ck);

  const d = await api(
    `/fixtures?team=${teamId}&season=${season}&last=${last}&status=FT-AET-PEN`
  );

  const ids = (d.response || [])
    .map(x => x.fixture?.id)
    .filter(Boolean);

  const result = [];

  // API-Football supports up to 20 fixture IDs in the ids query and includes
  // available fixture statistics in the detailed response.
  for (const group of chunks(ids, 20)) {
    const detail = await api(`/fixtures?ids=${group.join('-')}`);
    result.push(...(detail.response || []));
  }

  cache.set(ck, result);
  return result;
}

async function getOdds(id) {
  const ck = `odds:${id}`;
  if (cache.has(ck)) return cache.get(ck);

  const d = await api(`/odds?fixture=${id}`);
  cache.set(ck, d);
  return d;
}

async function scan() {
  stopped = false;
  cache = new Map();

  $('results').innerHTML = '';
  lastBets = [];
  $('fixtureCount').textContent = '0';
  $('betCount').textContent = '0';
  $('avgEV').textContent = '0%';

  if (!key()) {
    setStatus('API key required — configure it in Netlify', 'err');
    return;
  }

  const date = $('date').value;
  const max = Number($('maxFixtures').value) || 50;
  const hist = Number($('history').value) || 10;
  const minProb = Number($('minProb').value) || 0;
  const minEV = Number($('minEV').value) || -999;

  const wanted = [...document.querySelectorAll('.markets input:checked')]
    .map(x => x.value);

  if (!wanted.length) {
    setStatus('Select at least one market', 'err');
    return;
  }

  scanning = true;
  $('scan').disabled = true;
  try {
    setStatus('Loading fixtures…');

    const fd = await api(`/fixtures?date=${date}`);

    const fixtures = (fd.response || [])
      .filter(f => ['NS', 'TBD'].includes(f.fixture?.status?.short))
      .slice(0, max);

    $('fixtureCount').textContent = fixtures.length;

    if (!fixtures.length) {
      setStatus('No upcoming fixtures');
      setProgress('No fixtures found for this date.');
      return;
    }

    const allBets = [];
    let done = 0;

    for (const f of fixtures) {
      if (stopped) break;

      const season = f.league?.season;
      const home = f.teams?.home?.id;
      const away = f.teams?.away?.id;

      if (!season || !home || !away) continue;

      setProgress(
        `Analysing ${++done}/${fixtures.length}: ${esc(f.teams.home.name)} vs ${esc(f.teams.away.name)}`
      );

      try {
        const [hh, ah, od] = await Promise.all([
          getHistory(home, season, hist),
          getHistory(away, season, hist),
          getOdds(f.fixture.id)
        ]);

        const combined = [...hh, ...ah];
        const unique = [...new Map(
          combined.map(x => [x.fixture.id, x])
        ).values()];

        const odds = extractOdds(od, wanted);

        for (const o of odds) {
          let p;

          if (o.market === 'btts') {
            const vals = unique.map(btts);
            const yesProb = probability(vals, 0, 'over');
            p = yesProb == null ? null : (o.side === 'yes' ? yesProb : 100 - yesProb);
          } else {
            const vals = unique.map(x => metric(x, o.market));
            p = probability(vals, o.line, o.side);
          }

          const e = ev(p, o.odds);

          if (p == null || e == null || p < minProb || e < minEV) continue;

          allBets.push({
            fixture: f,
            bet: o,
            prob: p,
            ev: e,
            sample: unique
              .map(x => metric(x, o.market))
              .filter(v => v != null).length
          });
        }
      } catch (err) {
        console.warn(f.teams?.home?.name, err);
      }
    }

    lastBets = allBets;
    render(allBets);
    setStatus(stopped ? 'Stopped' : 'Scan complete');
    setProgress(`${allBets.length} value bets passed your filters.`);
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

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCsv() {
  if (!lastBets.length) {
    setProgress('Run a scan first — there are no results to export.');
    return;
  }

  const rows = [['Date', 'Time', 'League', 'Home', 'Away', 'Market', 'Bookmaker', 'Odds', 'Probability %', 'EV %', 'Sample']];
  for (const x of lastBets) {
    const f = x.fixture;
    rows.push([
      new Date(f.fixture.date).toISOString().slice(0, 10),
      new Date(f.fixture.date).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}),
      f.league?.name || '', f.teams?.home?.name || '', f.teams?.away?.name || '',
      x.bet.label, x.bet.book, x.bet.odds.toFixed(2), x.prob.toFixed(1), x.ev.toFixed(1), x.sample
    ]);
  }

  const blob = new Blob([rows.map(r => r.map(csvCell).join(',')).join('\n')], {type: 'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `value-bets-${$('date').value || 'scan'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function render(bets) {
  bets.sort((a, b) => b.ev - a.ev);

  $('betCount').textContent = bets.length;
  $('avgEV').textContent = bets.length
    ? (bets.reduce((s, x) => s + x.ev, 0) / bets.length).toFixed(2) + '%'
    : '0%';

  const by = new Map();

  for (const b of bets) {
    const id = b.fixture.fixture.id;
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(b);
  }

  let html = '';

  for (const list of by.values()) {
    const f = list[0].fixture;
    const time = new Date(f.fixture.date).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });

    html += `<article class="card">
      <div class="meta">${esc(time)} • ${esc(f.league?.name || 'Unknown league')}</div>
      <div class="match">${esc(f.teams.home.name)} vs ${esc(f.teams.away.name)}</div>`;

    for (const x of list) {
      html += `<div class="bet">
        <div>
          <div class="market">${esc(x.bet.label)}</div>
          <div class="muted">${esc(x.bet.book)} • ${x.sample} historical matches</div>
        </div>
        <div class="numbers">
          ${x.bet.odds.toFixed(2)} odds<br>
          ${x.prob.toFixed(1)}% prob • +${x.ev.toFixed(1)}% EV
        </div>
      </div>`;
    }

    html += `</article>`;
  }

  $('results').innerHTML = html ||
    `<div class="panel">
      <strong>No bets passed the filters.</strong>
      <p>Try lowering minimum probability/EV or check whether the selected league has odds and statistics coverage.</p>
    </div>`;
}

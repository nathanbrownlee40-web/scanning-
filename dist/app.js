const API_PROXY = '/.netlify/functions/api';

let stopped = false;
let scanning = false;
let cache = new Map();
let leagueCache = [];
let scanRows = [];

const $ = id => document.getElementById(id);

const today = new Date();
$('date').value = new Date(today.getTime() - today.getTimezoneOffset() * 60000)
  .toISOString().slice(0, 10);

setStatus('Ready — Vascali is connected to API-Football');
$('stop').onclick = () => { stopped = true; setProgress('Stopping after the current request…'); };
$('scan').onclick = scan;
$('loadLeagues').onclick = loadLeagues;
$('export').onclick = exportCsv;

function setStatus(text, cls = '') { $('status').textContent = text; $('status').className = 'status ' + cls; }
function setProgress(text) { $('progress').textContent = text; }

async function api(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const r = await fetch(`${API_PROXY}?path=${encodeURIComponent(path)}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
    let d;
    try { d = await r.json(); } catch { throw new Error('API returned invalid JSON'); }
    if (!r.ok || (d.errors && Object.keys(d.errors).length)) {
      const errors = typeof d.errors === 'object' ? Object.values(d.errors) : [`HTTP ${r.status}`];
      throw new Error(errors.join(', '));
    }
    return d;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('API request timed out');
    throw new Error(err.message || 'Network error');
  } finally { clearTimeout(timeout); }
}

function chunks(a, n) { const out=[]; for(let i=0;i<a.length;i+=n) out.push(a.slice(i,i+n)); return out; }
function num(v) { const x=parseFloat(String(v ?? '').replace('%','')); return Number.isFinite(x) ? x : null; }
function normalize(s) { return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function esc(v) { return String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function escAttr(v) { return esc(v); }

function statValue(f, type, teamName) {
  const teamBlock = (f.statistics || []).find(x => normalize(x.team?.name) === normalize(teamName));
  const stat = teamBlock?.statistics?.find(x => normalize(x.type) === normalize(type));
  return num(stat?.value);
}
function totalStat(f, type) {
  const h=statValue(f,type,f.teams?.home?.name), a=statValue(f,type,f.teams?.away?.name);
  return h!=null && a!=null ? h+a : null;
}
function goalsFor(f, teamId) {
  if (f.teams?.home?.id === teamId) return f.goals?.home ?? null;
  if (f.teams?.away?.id === teamId) return f.goals?.away ?? null;
  return null;
}
function goalsAgainst(f, teamId) {
  if (f.teams?.home?.id === teamId) return f.goals?.away ?? null;
  if (f.teams?.away?.id === teamId) return f.goals?.home ?? null;
  return null;
}
function venue(f, teamId) {
  if (f.teams?.home?.id === teamId) return 'home';
  if (f.teams?.away?.id === teamId) return 'away';
  return null;
}
function btts(f) { return f.goals?.home > 0 && f.goals?.away > 0 ? 1 : 0; }
function metric(f, market) {
  if (market==='goals') return f.goals?.home != null && f.goals?.away != null ? f.goals.home + f.goals.away : null;
  if (market==='btts') return btts(f);
  if (market==='corners') return totalStat(f,'Corner Kicks');
  if (market==='shots') return totalStat(f,'Total Shots');
  if (market==='sot') return totalStat(f,'Shots on Goal');
  if (market==='cards') return totalStat(f,'Yellow Cards');
  return null;
}

function weightedStats(values) {
  let sum=0, weight=0;
  values.forEach((v,i)=>{ if(v==null) return; const w=Math.pow(0.92,i); sum += v*w; weight += w; });
  return weight ? {mean:sum/weight,n:values.filter(v=>v!=null).length} : null;
}
function weightedHit(values,line,side) {
  let hit=0, total=0;
  values.forEach((v,i)=>{ if(v==null) return; const w=Math.pow(0.92,i); total+=w; if(side==='over' ? v>line : v<=line) hit+=w; });
  return total ? {hit,total,n:values.filter(v=>v!=null).length} : null;
}
function shrinkProbability(hit, total, prior=0.5, strength=5) {
  return Math.max(0.01, Math.min(0.99, (hit + prior*strength)/(total+strength)));
}

function poissonPmf(k, lambda) { if(lambda<=0) return k===0?1:0; let p=Math.exp(-lambda); for(let i=1;i<=k;i++) p*=lambda/i; return p; }
function poissonUnder(line, lambda) {
  const max=Math.floor(line);
  let p=0; for(let k=0;k<=max;k++) p+=poissonPmf(k,lambda); return p;
}
function poissonOver(line, lambda) { return 1-poissonUnder(line,lambda); }

function goalModel(homeHist, awayHist, homeId, awayId, line, side) {
  const hh=homeHist.filter(f=>venue(f,homeId)==='home');
  const aa=awayHist.filter(f=>venue(f,awayId)==='away');
  const hs=weightedStats(hh.map(f=>goalsFor(f,homeId))), hc=weightedStats(hh.map(f=>goalsAgainst(f,homeId)));
  const as=weightedStats(aa.map(f=>goalsFor(f,awayId))), ac=weightedStats(aa.map(f=>goalsAgainst(f,awayId)));
  if(!hs||!hc||!as||!ac||Math.min(hs.n,hc.n,as.n,ac.n)<3) return null;
  const lambdaHome=(hs.mean+ac.mean)/2;
  const lambdaAway=(as.mean+hc.mean)/2;
  const lambda=lambdaHome+lambdaAway;
  const p=side==='over'?poissonOver(line,lambda):poissonUnder(line,lambda);
  return {prob:p*100,sample:Math.min(hs.n,hc.n,as.n,ac.n),lambdaHome,lambdaAway,lambda};
}
function bttsModel(homeHist,awayHist,homeId,awayId,side) {
  const vals=homeHist.filter(f=>venue(f,homeId)==='home').map(btts).concat(awayHist.filter(f=>venue(f,awayId)==='away').map(btts));
  const h=weightedHit(vals,0,'over'); if(!h||h.n<5) return null;
  const yes=shrinkProbability(h.hit,h.total,0.5,5);
  return {prob:(side==='yes'?yes:1-yes)*100,sample:h.n};
}
function empiricalModel(homeHist,awayHist,homeId,awayId,market,line,side) {
  const hv=homeHist.filter(f=>venue(f,homeId)==='home').map(f=>metric(f,market));
  const av=awayHist.filter(f=>venue(f,awayId)==='away').map(f=>metric(f,market));
  const venueVals=hv.concat(av);
  const overall=homeHist.map(f=>metric(f,market)).concat(awayHist.map(f=>metric(f,market)));
  const v=weightedHit(venueVals,line,side); const o=weightedHit(overall,line,side);
  if((!v||v.n<4)&&(!o||o.n<5)) return null;
  let hit=0,total=0;
  if(v){hit+=v.hit*0.72; total+=v.total*0.72;}
  if(o){hit+=o.hit*0.28; total+=o.total*0.28;}
  const p=shrinkProbability(hit,total,0.5,6);
  return {prob:p*100,sample:venueVals.filter(v=>v!=null).length,mean:weightedStats(venueVals)?.mean ?? null};
}
function fairOdds(prob) { return prob>0 ? 100/prob : null; }
function targetOdds(prob) { const fair=fairOdds(prob); return fair ? fair*1.07 : null; }
function implied(odds) { return odds>0 ? 100/odds : null; }
function ev(prob,odds) { return prob!=null&&odds>0 ? (prob/100*odds-1)*100 : null; }

function marketBucket(name) {
  const x=normalize(name);
  if((x.includes('goals')||x.includes('totalgoals')) && (x.includes('overunder')||x.includes('ou'))) return 'goals';
  if(x.includes('bothteamsscore')||x.includes('btts')) return 'btts';
  if(x.includes('corner')&&(x.includes('overunder')||x.includes('ou'))) return 'corners';
  if((x.includes('totalshots')||x==='shots')&&!x.includes('ongoal')&&!x.includes('ontarget')&&(x.includes('overunder')||x.includes('ou'))) return 'shots';
  if((x.includes('shotsongoal')||x.includes('shotsontarget'))&&(x.includes('overunder')||x.includes('ou'))) return 'sot';
  if(x.includes('card')&&(x.includes('overunder')||x.includes('ou'))) return 'cards';
  return null;
}
function parseValue(v) {
  const s=String(v?.value??v?.name??'');
  const m=s.match(/(over|under)\s*([0-9]+(?:\.[0-9]+)?)/i);
  if(m) return {side:m[1].toLowerCase(),line:parseFloat(m[2]),label:s};
  if(/^(yes|no)$/i.test(s)) return {side:s.toLowerCase(),line:0,label:s};
  return null;
}
function extractOdds(data) {
  const out=[];
  for(const book of (data.response?.[0]?.bookmakers||[])) for(const bet of (book.bets||[])) {
    const market=marketBucket(bet.name); if(!market) continue;
    for(const val of (bet.values||[])) {
      const p=parseValue(val), odds=num(val.odd); if(!p||odds==null||odds<=1) continue;
      out.push({market,side:p.side,line:market==='btts'?0:p.line,label:p.label,odds,book:book.name});
    }
  }
  return out;
}
function consolidateOdds(rows) {
  const groups=new Map();
  for(const r of rows){const k=`${r.market}|${r.side}|${r.line}`; if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(r);}
  return [...groups.values()].map(g=>{g.sort((a,b)=>b.odds-a.odds); const avg=g.reduce((s,x)=>s+implied(x.odds),0)/g.length; return {...g[0],bestOdds:g[0].odds,books:g.length,consensus:100-avg,allOdds:g};});
}

async function getHistory(teamId,season,league,last){
  const key=`hist:${teamId}:${season}:${league}:${last}`; if(cache.has(key)) return cache.get(key);
  const d=await api(`/fixtures?team=${teamId}&season=${season}&league=${league}&last=${last}`);
  const ids=(d.response||[]).filter(x=>['FT','AET','PEN'].includes(x.fixture?.status?.short)).map(x=>x.fixture?.id).filter(Boolean);
  const result=[]; for(const group of chunks(ids,20)){const detail=await api(`/fixtures?ids=${group.join('-')}`); result.push(...(detail.response||[]));}
  result.sort((a,b)=>new Date(b.fixture.date)-new Date(a.fixture.date));
  cache.set(key,result); return result;
}
async function getOdds(id){const key=`odds:${id}`; if(cache.has(key)) return cache.get(key); const d=await api(`/odds?fixture=${id}`); cache.set(key,d); return d;}
async function getLeagues(){if(cache.has('leagues')) return cache.get('leagues'); const d=await api('/leagues?current=true'); cache.set('leagues',d.response||[]); return d.response||[];}
async function loadLeagues(){
  const b=$('loadLeagues'); b.disabled=true;
  try{setProgress('Loading current leagues…'); const rows=await getLeagues(); leagueCache=rows; const s=$('league'), prev=s.value; const sorted=[...rows].sort((a,b)=>`${a.country?.name||''} ${a.league?.name||''}`.localeCompare(`${b.country?.name||''} ${b.league?.name||''}`)); s.innerHTML='<option value="">All leagues</option>'+sorted.map(x=>`<option value="${escAttr(x.league?.id)}">${esc(x.country?.name||'Other')} — ${esc(x.league?.name||'Unknown')}</option>`).join(''); if([...s.options].some(o=>o.value===prev)) s.value=prev; setProgress(`${rows.length} leagues loaded.`);}catch(e){setStatus('Could not load leagues','err');setProgress(e.message);}finally{b.disabled=false;}
}

function predictionSpecs() {
  return [
    {market:'goals',side:'over',line:1.5,label:'Over 1.5 Goals'},
    {market:'goals',side:'over',line:2.5,label:'Over 2.5 Goals'},
    {market:'goals',side:'under',line:3.5,label:'Under 3.5 Goals'},
    {market:'btts',side:'yes',line:0,label:'BTTS — Yes'},
    {market:'corners',side:'over',line:7.5,label:'Over 7.5 Corners'},
    {market:'corners',side:'over',line:8.5,label:'Over 8.5 Corners'},
    {market:'corners',side:'under',line:12.5,label:'Under 12.5 Corners'},
    {market:'shots',side:'over',line:20.5,label:'Over 20.5 Total Shots'},
    {market:'shots',side:'over',line:24.5,label:'Over 24.5 Total Shots'},
    {market:'sot',side:'over',line:5.5,label:'Over 5.5 Shots on Target'},
    {market:'sot',side:'over',line:7.5,label:'Over 7.5 Shots on Target'},
    {market:'cards',side:'over',line:2.5,label:'Over 2.5 Cards'},
    {market:'cards',side:'over',line:3.5,label:'Over 3.5 Cards'},
    {market:'cards',side:'under',line:6.5,label:'Under 6.5 Cards'}
  ];
}
function modelSpec(spec,homeHist,awayHist,home,away){
  if(spec.market==='goals') return goalModel(homeHist,awayHist,home,away,spec.line,spec.side);
  if(spec.market==='btts') return bttsModel(homeHist,awayHist,home,away,spec.side);
  return empiricalModel(homeHist,awayHist,home,away,spec.market,spec.line,spec.side);
}
function riskRank(x){
  // Ranking aid only. It favours probability, sample size and a modest margin above 50%.
  return x.prob + Math.min(x.sample,20)*0.25;
}
function scan(){
  if(scanning)return; stopped=false; scanning=true; cache=new Map(); $('scan').disabled=true; $('results').innerHTML=''; scanRows=[]; $('fixtureCount').textContent='0'; $('summaryCount').textContent='0'; $('avgProb').textContent='—';
  const date=$('date').value, max=Math.min(50,Math.max(1,Number($('maxFixtures').value)||20)), hist=Math.min(20,Math.max(5,Number($('history').value)||10)), league=$('league').value;
  if(!date){setStatus('Choose a date','err'); scanning=false; $('scan').disabled=false; return;}
  (async()=>{
    try{
      setStatus('Loading fixtures…');
      const fd=await api(`/fixtures?date=${encodeURIComponent(date)}${league?`&league=${encodeURIComponent(league)}`:''}`);
      const fixtures=(fd.response||[]).filter(f=>['NS','TBD'].includes(f.fixture?.status?.short)).slice(0,max);
      $('fixtureCount').textContent=fixtures.length;
      if(!fixtures.length){setStatus('No fixtures returned','err'); setProgress('API-Football returned no upcoming fixtures for that date/filter.'); return;}
      let done=0;
      for(const f of fixtures){
        if(stopped)break;
        const row={fixture:f, predictions:[], status:'loading'}; scanRows.push(row); renderResults();
        setProgress(`Scanning ${++done}/${fixtures.length}: ${f.teams?.home?.name} vs ${f.teams?.away?.name}`);
        try{
          const [hh,aa,od]=await Promise.all([getHistory(f.teams.home.id,f.league.season,f.league.id,hist),getHistory(f.teams.away.id,f.league.season,f.league.id,hist),getOdds(f.fixture.id).catch(()=>({response:[]}))]);
          const odds=consolidateOdds(extractOdds(od)); const oddsMap=new Map(odds.map(o=>[`${o.market}|${o.side}|${o.line}`,o]));
          const wanted=[...document.querySelectorAll('.markets input:checked')].map(x=>x.value);
          const specs=predictionSpecs().filter(x=>wanted.includes(x.market));
          for(const spec of specs){
            const model=modelSpec(spec,hh,aa,f.teams.home.id,f.teams.away.id); if(!model) continue;
            const o=oddsMap.get(`${spec.market}|${spec.side}|${spec.line}`)||null;
            const fair=fairOdds(model.prob), target=targetOdds(model.prob), current=o?.bestOdds??null;
            row.predictions.push({...spec,...model,fairOdds:fair,targetOdds:target,bestOdds:current,book:o?.book||null,books:o?.books||0,ev:current?ev(model.prob,current):null,consensus:o?.consensus??null});
          }
          row.predictions.sort((a,b)=>riskRank(b)-riskRank(a)); row.status=row.predictions.length?'modelled':'limited';
        }catch(e){row.status='error';row.error=e.message;}
        renderResults();
      }
      const all=scanRows.flatMap(r=>r.predictions); $('summaryCount').textContent=all.length; $('avgProb').textContent=all.length?(all.reduce((s,x)=>s+x.prob,0)/all.length).toFixed(1)+'%':'—';
      setStatus(stopped?'Stopped':'Scan complete'); setProgress(`${scanRows.length} games scanned. ${all.length} statistical predictions calculated.`);
    }catch(e){setStatus('Scan failed','err');setProgress(e.message);}finally{scanning=false;$('scan').disabled=false;}
  })();
}

function renderResults(){
  const parts=[];
  for(const row of scanRows){
    const f=row.fixture, p=row.predictions||[], top=p.slice(0,4); const time=new Date(f.fixture.date).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const safer=p[0];
    parts.push(`<article class="card fixture-card"><div class="meta">${esc(time)} • ${esc(f.league?.name||'Unknown league')}</div><div class="match">${esc(f.teams?.home?.name||'')} <span>vs</span> ${esc(f.teams?.away?.name||'')}</div>${safer?`<div class="recommendation"><div class="rec-title">Vascali's strongest statistical pick <span>model only</span></div><div class="rec-main">${esc(safer.label)}</div><div class="rec-grid"><div><strong>${safer.prob.toFixed(1)}%</strong><small>probability</small></div><div><strong>${safer.fairOdds.toFixed(2)}</strong><small>fair odds</small></div><div><strong>${safer.targetOdds.toFixed(2)}+</strong><small>odds to look for</small></div><div><strong>${safer.sample}</strong><small>matches in sample</small></div></div></div>`:`<div class="recommendation limited"><div class="rec-title">Statistical pick</div><div class="rec-main">Not enough API data for a reliable calculation</div><div class="muted">The game is still shown. Try a league with fuller historical statistics coverage.</div></div>`}<div class="markets-title">Top statistical markets</div>${top.length?top.map(x=>`<div class="bet ${x===safer?'featured':''}"><div><div class="market">${esc(x.label)}</div><div class="muted">Probability <b>${x.prob.toFixed(1)}%</b> • Fair odds <b>${x.fairOdds.toFixed(2)}</b> • Look for <b>${x.targetOdds.toFixed(2)}+</b></div><div class="muted">${x.bestOdds?`Current best ${esc(x.book)} @ ${x.bestOdds.toFixed(2)} • ${x.books} book${x.books===1?'':'s'}`:'No current bookmaker price returned'}</div></div><div class="numbers">${x.bestOdds?`EV ${x.ev>=0?'+':''}${x.ev.toFixed(1)}%`:'—'}<br><span class="edge">n=${x.sample}</span></div></div>`).join(''):`<div class="bet"><div><div class="market">No reliable market calculation</div><div class="muted">Insufficient historical statistics.</div></div></div>`}</article>`);
  }
  $('results').innerHTML=parts.join('')||'<div class="panel"><strong>No games to display.</strong><p>Try another date or remove the league filter.</p></div>';
}

function exportCsv(){
  const all=scanRows.flatMap(r=>r.predictions.map(p=>({r,p}))); if(!all.length){setProgress('Run a scan first.');return;}
  const rows=[['Date','Time','League','Home','Away','Market','Probability %','Fair odds','Odds to look for','Best current odds','Bookmaker','EV %','Sample']];
  for(const {r,p} of all){const f=r.fixture;rows.push([$('date').value,new Date(f.fixture.date).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),f.league?.name||'',f.teams?.home?.name||'',f.teams?.away?.name||'',p.label,p.prob.toFixed(1),p.fairOdds.toFixed(2),p.targetOdds.toFixed(2),p.bestOdds?.toFixed(2)||'',p.book||'',p.ev?.toFixed(1)||'',p.sample]);}
  const csv=rows.map(r=>r.map(v=>{const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}).join(',')).join('\n'); const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=`vascali-${$('date').value||'scan'}.csv`;a.click();
}

loadLeagues();

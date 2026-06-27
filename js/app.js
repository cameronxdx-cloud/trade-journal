'use strict';

/* ── State ──────────────────────────────────────────────────────── */
let trades      = [];
let notes       = {};   // { tradeId: { note, tags, chartImage } }
let charts      = {};
let sortConfig  = { key: 'date', dir: -1 };
let filterConfig = { search: '', side: '', result: '', source: '' };
let currentTradeId = null;

/* ═══════════════════════════════════════════════════════════════
   LUCID / TOPSTEP CSV NORMALIZER
   Handles every column name variant seen in Lucid and Topstep
   ═══════════════════════════════════════════════════════════════ */
function normalizeTrade(row, idx) {
  // Flatten all keys to lowercase, no spaces/special chars for matching
  const map = {};
  for (const [k, v] of Object.entries(row)) {
    map[k.toLowerCase().replace(/[\s_\-\.#]/g, '')] = v;
  }

  const pick = (...keys) => {
    for (const k of keys) {
      const v = map[k];
      if (v !== undefined && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };

  // ── Symbol / Contract ──────────────────────────────
  const symbol = (pick(
    'contract','symbol','instrument','ticker','market','product'
  ) || 'UNKNOWN').toUpperCase();

  // ── Trade ID ───────────────────────────────────────
  const tradeId = pick('id','tradeid','orderid','executionid') || String(idx);

  // ── Source platform ────────────────────────────────
  // Detected from: explicit 'source' column, ID prefix, or symbol patterns
  const source_raw = pick('source','platform','broker','account').toLowerCase();
  let source = 'manual';
  if (source_raw.includes('topstep') || source_raw.includes('tsx')) {
    source = 'topstep';
  } else if (source_raw.includes('lucid')) {
    source = 'lucid';
  } else if (tradeId.startsWith('LUC-')) {
    source = 'lucid';
  } else if (/^\d{10}$/.test(tradeId)) {
    // TopstepX trade IDs are 10-digit numbers
    source = 'topstep';
  }

  // ── Size ───────────────────────────────────────────
  const size = parseFloat(pick('size','qty','quantity','contracts','volume')) || 1;

  // ── Direction / Side ──────────────────────────────
  const dir_raw = pick('direction','side','type','action','buysell','positionside');
  const side = /short|sell|s\b|s$/i.test(dir_raw) ? 'short' : 'long';

  // ── Entry Time (Lucid: "June 26 2026 @ 7:41:09 am") ──
  const entry_time_raw = pick('entrytime','entrydate','opentime','datetime','date','closeddate','buydatetime');
  const exit_time_raw  = pick('exittime','exitdate','closetime','closeddate','selldatetime');

  const parseDateTime = (raw) => {
    if (!raw) return null;
    // Lucid format: "June 26 2026 @ 7:41:09 am"
    const lucid = raw.replace('@', '').replace(/\s+/g, ' ').trim();
    let d = new Date(lucid);
    if (!isNaN(d.getTime())) return d;
    // MM/DD/YYYY HH:MM:SS
    const m = raw.match(/(\d+)[\/\-](\d+)[\/\-](\d+)(?:\s+(\d+):(\d+)(?::(\d+))?)?/);
    if (m) {
      d = new Date(`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}T${(m[4]||'0').padStart(2,'0')}:${(m[5]||'0').padStart(2,'0')}:${(m[6]||'0').padStart(2,'0')}`);
      if (!isNaN(d.getTime())) return d;
    }
    return null;
  };

  const entryTime = parseDateTime(entry_time_raw);
  const exitTime  = parseDateTime(exit_time_raw);

  // Duration in seconds
  let durationSec = null;
  const dur_raw = pick('duration');
  if (dur_raw) {
    // "00:01:26" format
    const parts = dur_raw.split(':').map(Number);
    if (parts.length === 3) durationSec = parts[0]*3600 + parts[1]*60 + parts[2];
    else if (parts.length === 2) durationSec = parts[0]*60 + parts[1];
  } else if (entryTime && exitTime) {
    durationSec = Math.round((exitTime - entryTime) / 1000);
  }

  // ── Prices ────────────────────────────────────────
  const parsePrice = (s) => {
    if (!s) return null;
    const n = parseFloat(String(s).replace(/[$,\s]/g, ''));
    return isNaN(n) ? null : n;
  };

  const entry = parsePrice(pick('entryprice','entryfill','entry','avgentry','openprice','buyprice','filledprice'));
  const exit  = parsePrice(pick('exitprice','exitfill','exit','avgexit','closeprice','sellprice'));

  // ── P&L ───────────────────────────────────────────
  const parsePnl = (s) => {
    if (!s) return null;
    const str = String(s).trim();
    const negative = str.startsWith('-') || str.startsWith('(');
    const n = parseFloat(str.replace(/[$,()\s]/g, ''));
    if (isNaN(n)) return null;
    return negative ? -Math.abs(n) : n;
  };

  const pnl = parsePnl(pick('pnl','netpnl','realizedpnl','profit','net','pl','realizedpl','tradepnl','grosspnl'));
  const commissions = parsePnl(pick('commissions','commission','comm'));
  const fees = parsePnl(pick('fees','fee'));

  return {
    id          : `t-${idx}-${Date.now()}`,
    tradeId,
    source,
    date        : entryTime || exitTime,
    entryTime,
    exitTime,
    durationSec,
    symbol,
    size,
    side,
    entry,
    exit,
    pnl,
    commissions,
    fees,
    result      : pnl !== null ? (pnl >= 0 ? 'win' : 'loss') : null,
    raw         : row,
  };
}

/* ── CSV Import ─────────────────────────────────────────────────── */
function handleCSV(file) {
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete(results) {
      if (!results.data.length) { alert('No data found in CSV.'); return; }
      const incoming = results.data
        .map((r, i) => normalizeTrade(r, i + trades.length))
        .filter(t => t.pnl !== null || t.entry !== null);

      if (!incoming.length) {
        alert('Could not parse any trades. Check that your CSV has P&L or entry price columns.');
        return;
      }

      // Avoid duplicates by tradeId
      const existingIds = new Set(trades.map(t => t.tradeId));
      const fresh = incoming.filter(t => !existingIds.has(t.tradeId));
      trades = [...trades, ...fresh];

      saveTrades();
      refreshAll();
      showView('dashboard');
      const msg = fresh.length === incoming.length
        ? `Imported ${fresh.length} trades.`
        : `Imported ${fresh.length} new trades (${incoming.length - fresh.length} duplicates skipped).`;
      showToast(msg);
    },
    error(err) { alert('Could not parse CSV: ' + err.message); }
  });
}

/* ── Persistence ────────────────────────────────────────────────── */
function saveTrades() {
  try {
    localStorage.setItem('tj_trades', JSON.stringify(
      trades.map(t => ({
        ...t,
        date      : t.date?.toISOString(),
        entryTime : t.entryTime?.toISOString(),
        exitTime  : t.exitTime?.toISOString(),
      }))
    ));
  } catch(e) { console.warn('Save failed (storage full?)', e); }
}

function saveNotes() {
  try { localStorage.setItem('tj_notes', JSON.stringify(notes)); } catch(e) {}
}

function loadSaved() {
  try {
    const raw = localStorage.getItem('tj_trades');
    if (raw) {
      trades = JSON.parse(raw).map(t => ({
        ...t,
        date      : t.date      ? new Date(t.date)      : null,
        entryTime : t.entryTime ? new Date(t.entryTime) : null,
        exitTime  : t.exitTime  ? new Date(t.exitTime)  : null,
      }));
    }
    const n = localStorage.getItem('tj_notes');
    if (n) notes = JSON.parse(n);
  } catch(e) {}
}

/* ── Toast ───────────────────────────────────────────────────────── */
function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1e1e28;border:1px solid rgba(255,255,255,0.15);color:#f0f0f2;padding:10px 20px;border-radius:8px;font-size:13px;z-index:999;pointer-events:none;opacity:0;transition:opacity 0.2s';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(() => { t.style.opacity = '0'; }, 2800);
}

/* ── Helpers ─────────────────────────────────────────────────────── */
function filteredTrades(period) {
  let list = [...trades];
  if (period && period !== 'all') {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - parseInt(period));
    list = list.filter(t => t.date && t.date >= cutoff);
  }
  if (filterConfig.search) {
    const q = filterConfig.search.toLowerCase();
    list = list.filter(t => t.symbol.toLowerCase().includes(q));
  }
  if (filterConfig.side)   list = list.filter(t => t.side === filterConfig.side);
  if (filterConfig.result) list = list.filter(t => t.result === filterConfig.result);
  if (filterConfig.source) list = list.filter(t => t.source === filterConfig.source);
  return list;
}

function computeStats(list) {
  const withPnl = list.filter(t => t.pnl !== null);
  const wins    = withPnl.filter(t => t.pnl >= 0);
  const losses  = withPnl.filter(t => t.pnl < 0);
  const totalPnl   = withPnl.reduce((s,t) => s + t.pnl, 0);
  const grossWin   = wins.reduce((s,t) => s + t.pnl, 0);
  const grossLoss  = Math.abs(losses.reduce((s,t) => s + t.pnl, 0));
  return {
    totalPnl,
    wins: wins.length, losses: losses.length, total: withPnl.length,
    winRate : withPnl.length ? wins.length / withPnl.length : 0,
    avgWin  : wins.length ? grossWin / wins.length : 0,
    avgLoss : losses.length ? grossLoss / losses.length : 0,
    pf      : grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
  };
}

const fmtPnl   = v => (v >= 0 ? '+' : '') + '$' + Math.abs(v).toFixed(2);
const fmtPrice = v => v != null ? v.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}) : '—';
const fmtTime  = d => d ? d.toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';
const fmtDate  = d => d ? d.toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}) : '—';

function fmtDuration(sec) {
  if (sec == null) return '—';
  if (sec < 60)   return sec + 's';
  if (sec < 3600) return Math.floor(sec/60) + 'm ' + (sec%60) + 's';
  return Math.floor(sec/3600) + 'h ' + Math.floor((sec%3600)/60) + 'm';
}

function sourceBadge(source) {
  const map = {
    topstep : { label: 'TopstepX', color: 'rgba(0,200,120,0.15)',  text: '#3ecf8e' },
    lucid   : { label: 'Lucid',    color: 'rgba(80,140,255,0.15)', text: '#6ea8ff' },
    manual  : { label: 'Manual',   color: 'rgba(255,255,255,0.07)', text: '#8a8a96' },
  };
  const s = map[source] || map.manual;
  return `<span class="badge" style="background:${s.color};color:${s.text}">${s.label}</span>`;
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ═══════════════════════════════════════════════════════════════
   AUTO TRADE VISUAL
   Draws entry/exit/pnl as a mini SVG-style canvas chart
   ═══════════════════════════════════════════════════════════════ */
function drawTradeVisual(canvas, trade) {
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 500;
  const H = 120;
  canvas.width  = W;
  canvas.height = H;

  const entry = trade.entry;
  const exit  = trade.exit;
  const side  = trade.side;
  const pnl   = trade.pnl;

  if (!entry || !exit) {
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No price data available', W/2, H/2);
    return;
  }

  const isWin   = pnl !== null ? pnl >= 0 : (side === 'long' ? exit > entry : exit < entry);
  const color   = isWin ? '#3ecf8e' : '#f05252';
  const colorBg = isWin ? 'rgba(62,207,142,0.08)' : 'rgba(240,82,82,0.08)';

  // Build a synthetic price path (entry → some noise → exit)
  // We simulate a small number of intermediate "ticks" for visual interest
  const steps = 40;
  const prices = [entry];
  const spread = Math.abs(exit - entry);
  const drift  = (exit - entry) / steps;

  for (let i = 1; i < steps; i++) {
    const noise = (Math.random() - 0.5) * spread * 0.6;
    const prev  = prices[i-1];
    const next  = prev + drift + noise;
    // Keep within a reasonable band
    const band  = spread * 1.5 + 0.5;
    const min   = Math.min(entry, exit) - band;
    const max   = Math.max(entry, exit) + band;
    prices.push(Math.max(min, Math.min(max, next)));
  }
  prices.push(exit);

  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const rangeP = maxP - minP || 1;

  const pad = { top: 16, bottom: 28, left: 60, right: 16 };
  const cW  = W - pad.left - pad.right;
  const cH  = H - pad.top  - pad.bottom;

  const px = (i) => pad.left + (i / (prices.length - 1)) * cW;
  const py = (p) => pad.top  + (1 - (p - minP) / rangeP) * cH;

  // Background fill
  ctx.fillStyle = colorBg;
  ctx.beginPath();
  ctx.moveTo(px(0), py(prices[0]));
  for (let i = 1; i < prices.length; i++) ctx.lineTo(px(i), py(prices[i]));
  ctx.lineTo(px(prices.length-1), H - pad.bottom);
  ctx.lineTo(px(0), H - pad.bottom);
  ctx.closePath();
  ctx.fill();

  // Price line
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  ctx.moveTo(px(0), py(prices[0]));
  for (let i = 1; i < prices.length; i++) ctx.lineTo(px(i), py(prices[i]));
  ctx.stroke();

  // Entry dot + label
  const ex = px(0), ey = py(entry);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('Entry', pad.left - 6, ey + 4);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.textAlign = 'right';
  ctx.font = '10px sans-serif';
  ctx.fillText(fmtPrice(entry), pad.left - 6, ey - 5);

  // Exit dot + label
  const xxp = px(prices.length-1), xyp = py(exit);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(xxp, xyp, 4, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('Exit', pad.left - 6, xyp + 4);
  ctx.fillStyle = color;
  ctx.textAlign = 'right';
  ctx.fillText(fmtPrice(exit), pad.left - 6, xyp - 5);

  // Entry dashed horizontal line
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(xxp, ey); ctx.stroke();
  ctx.setLineDash([]);

  // P&L badge top right
  if (pnl !== null) {
    const label = fmtPnl(pnl);
    ctx.font = 'bold 12px sans-serif';
    const tw = ctx.measureText(label).width;
    const bx = W - pad.right - tw - 12;
    const by = pad.top;
    ctx.fillStyle = isWin ? 'rgba(62,207,142,0.18)' : 'rgba(240,82,82,0.18)';
    ctx.beginPath();
    ctx.roundRect(bx - 6, by - 2, tw + 12, 20, 4);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(label, bx, by + 13);
  }

  // Side badge
  ctx.font = '10px sans-serif';
  ctx.fillStyle = side === 'long' ? 'rgba(124,110,247,0.8)' : 'rgba(240,160,80,0.8)';
  ctx.textAlign = 'left';
  ctx.fillText(side.toUpperCase(), pad.left + 4, pad.top + 12);
}

/* ── Mini sparkline for trades table ────────────────────────────── */
function drawMiniSparkline(canvas, trade) {
  if (!canvas) return;
  const W = 60, H = 24;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  if (!trade.entry || !trade.exit) return;

  const isWin = trade.pnl !== null ? trade.pnl >= 0 : trade.exit > trade.entry;
  const color = isWin ? '#3ecf8e' : '#f05252';

  // Simple 3-point: entry → midpoint noise → exit
  const mid = (trade.entry + trade.exit) / 2 + (Math.random() - 0.5) * Math.abs(trade.exit - trade.entry) * 0.5;
  const pts = [trade.entry, mid, trade.exit];
  const minP = Math.min(...pts), maxP = Math.max(...pts), rng = maxP - minP || 1;
  const px = (i) => (i / (pts.length-1)) * W;
  const py = (p)  => H - 2 - ((p - minP) / rng) * (H - 4);

  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.moveTo(px(0), py(pts[0]));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(px(i), py(pts[i]));
  ctx.stroke();
}

/* ═══════════════════════════════════════════════════════════════
   DASHBOARD
   ═══════════════════════════════════════════════════════════════ */
function refreshDashboard() {
  const period = document.getElementById('dash-period').value;
  const list   = filteredTrades(period).sort((a,b) => (a.date||0) - (b.date||0));
  const stats  = computeStats(list);
  const empty  = document.getElementById('dash-empty');
  const grid   = document.getElementById('stats-grid');
  const cg     = document.querySelector('.charts-grid');

  if (!list.length) {
    empty.classList.add('visible');
    grid.style.display = 'none';
    if (cg) cg.style.display = 'none';
    return;
  }
  empty.classList.remove('visible');
  grid.style.display = '';
  if (cg) cg.style.display = '';

  const dates = list.map(t => t.date).filter(Boolean);
  if (dates.length) {
    document.getElementById('dash-date-range').textContent =
      fmtDate(dates[0]) + ' – ' + fmtDate(dates[dates.length-1]);
  }

  const pnlEl = document.getElementById('stat-pnl');
  pnlEl.textContent = fmtPnl(stats.totalPnl);
  pnlEl.className   = 'stat-value ' + (stats.totalPnl >= 0 ? 'pos' : 'neg');
  document.getElementById('stat-winrate').textContent = (stats.winRate * 100).toFixed(1) + '%';
  document.getElementById('stat-total').textContent   = stats.total;
  document.getElementById('stat-avgwin').textContent  = '$' + stats.avgWin.toFixed(2);
  document.getElementById('stat-avgloss').textContent = '$' + stats.avgLoss.toFixed(2);
  document.getElementById('stat-pf').textContent      = isFinite(stats.pf) ? stats.pf.toFixed(2) : '∞';

  buildEquityChart(list);
  buildWinLossChart(stats);
  buildDailyChart(list);
}

function buildEquityChart(list) {
  let cum = 0;
  const labels = [], data = [];
  list.forEach(t => {
    if (t.pnl == null) return;
    cum += t.pnl;
    labels.push(t.date ? t.date.toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '?');
    data.push(parseFloat(cum.toFixed(2)));
  });
  const col = (data[data.length-1] || 0) >= 0 ? '#3ecf8e' : '#f05252';
  rebuildChart('chartEquity', {
    type: 'line',
    data: { labels, datasets:[{ label:'Equity', data, borderColor:col,
      backgroundColor: col==='#3ecf8e' ? 'rgba(62,207,142,0.08)' : 'rgba(240,82,82,0.08)',
      fill:true, tension:0.35, pointRadius:0, borderWidth:2 }] },
    options: chartOpts({})
  });
}

function buildWinLossChart(stats) {
  rebuildChart('chartWinLoss', {
    type: 'doughnut',
    data: { labels:['Wins','Losses'],
      datasets:[{ data:[stats.wins, stats.losses],
        backgroundColor:['#3ecf8e','#f05252'],
        borderColor:'#141417', borderWidth:3 }] },
    options: { responsive:true, maintainAspectRatio:false, cutout:'68%',
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{
        label: ctx => ` ${ctx.label}: ${ctx.parsed} (${stats.total ? Math.round(ctx.parsed/stats.total*100) : 0}%)`
      }}}}
  });
}

function buildDailyChart(list) {
  const byDay = {};
  list.forEach(t => {
    if (!t.date || t.pnl == null) return;
    const key = t.date.toISOString().slice(0,10);
    byDay[key] = (byDay[key]||0) + t.pnl;
  });
  const sorted = Object.entries(byDay).sort(([a],[b]) => a.localeCompare(b));
  const labels = sorted.map(([k]) => { const d=new Date(k+'T12:00:00'); return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}); });
  const data   = sorted.map(([,v]) => parseFloat(v.toFixed(2)));
  rebuildChart('chartDaily', {
    type: 'bar',
    data: { labels, datasets:[{ label:'Daily P&L', data,
      backgroundColor: data.map(v => v>=0 ? 'rgba(62,207,142,0.75)' : 'rgba(240,82,82,0.75)'),
      borderRadius:3 }] },
    options: chartOpts({})
  });
}

/* ═══════════════════════════════════════════════════════════════
   TRADES TABLE
   ═══════════════════════════════════════════════════════════════ */
function refreshTrades() {
  let list = filteredTrades();
  list.sort((a,b) => {
    const k = sortConfig.key;
    let av = a[k], bv = b[k];
    if (av instanceof Date) av = av.getTime();
    if (bv instanceof Date) bv = bv.getTime();
    return sortConfig.dir * ((av??-Infinity) < (bv??-Infinity) ? -1 : (av??-Infinity) > (bv??-Infinity) ? 1 : 0);
  });

  document.getElementById('trades-count').textContent = list.length + ' trade' + (list.length!==1?'s':'');
  const tbody = document.getElementById('tradesBody');
  const empty = document.getElementById('trades-empty');
  tbody.innerHTML = '';

  if (!list.length) { empty.classList.add('visible'); return; }
  empty.classList.remove('visible');

  list.forEach(t => {
    const n   = notes[t.id] || {};
    const hasChart = !!(n.chartImage);
    const tr  = document.createElement('tr');

    tr.innerHTML = `
      <td>${fmtDate(t.date)}</td>
      <td><strong>${esc(t.symbol)}</strong></td>
      <td>${sourceBadge(t.source)}</td>
      <td><span class="badge badge-${t.side}">${t.side}</span></td>
      <td style="color:var(--text2)">${t.size}</td>
      <td>${fmtPrice(t.entry)}</td>
      <td>${fmtPrice(t.exit)}</td>
      <td style="color:var(--text2);font-size:12px">${fmtDuration(t.durationSec)}</td>
      <td class="${t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${t.pnl != null ? fmtPnl(t.pnl) : '—'}</td>
      <td>
        <canvas class="mini-visual" data-id="${t.id}" width="60" height="24" style="display:block"></canvas>
        ${hasChart ? '<span class="has-chart-dot" title="Has TradingView chart"></span>' : ''}
      </td>
      <td><button class="btn-row" data-id="${t.id}">View ↗</button></td>`;

    tbody.appendChild(tr);

    // Draw sparkline after element is in DOM
    const cvs = tr.querySelector('canvas.mini-visual');
    if (cvs) setTimeout(() => drawMiniSparkline(cvs, t), 0);
  });
}

/* ═══════════════════════════════════════════════════════════════
   PERFORMANCE CHARTS
   ═══════════════════════════════════════════════════════════════ */
function refreshPerformance() {
  const list = filteredTrades();

  const bySymbol = {};
  list.forEach(t => { if (t.pnl!=null) bySymbol[t.symbol] = (bySymbol[t.symbol]||0)+t.pnl; });
  const symE = Object.entries(bySymbol).sort(([,a],[,b]) => b-a);
  rebuildChart('chartSymbol', {
    type:'bar',
    data:{ labels:symE.map(([k])=>k),
      datasets:[{ label:'P&L', data:symE.map(([,v])=>parseFloat(v.toFixed(2))),
        backgroundColor:symE.map(([,v])=>v>=0?'rgba(62,207,142,0.7)':'rgba(240,82,82,0.7)'), borderRadius:3 }]},
    options:chartOpts({})
  });

  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const counts = Array(7).fill(0);
  list.forEach(t => { if (t.date) counts[t.date.getDay()]++; });
  rebuildChart('chartDow', {
    type:'bar',
    data:{ labels:dow, datasets:[{ label:'Trades', data:counts,
      backgroundColor:'rgba(124,110,247,0.6)', borderRadius:3 }]},
    options:chartOpts({})
  });

  const pnls = list.map(t=>t.pnl).filter(v=>v!=null);
  if (pnls.length) {
    const min = Math.floor(Math.min(...pnls)/50)*50;
    const max = Math.ceil(Math.max(...pnls)/50)*50;
    const bins = [];
    for (let b=min; b<max; b+=50) bins.push({ label:`$${b}`, count:pnls.filter(p=>p>=b&&p<b+50).length, b });
    rebuildChart('chartHisto', {
      type:'bar',
      data:{ labels:bins.map(b=>b.label),
        datasets:[{ label:'Trades', data:bins.map(b=>b.count),
          backgroundColor:bins.map(b=>b.b>=0?'rgba(62,207,142,0.65)':'rgba(240,82,82,0.65)'), borderRadius:3 }]},
      options:chartOpts({})
    });
  }
}

/* ── Chart helpers ──────────────────────────────────────────────── */
function chartOpts(extra) {
  return {
    responsive:true, maintainAspectRatio:false,
    plugins:{ legend:{display:false} },
    scales:{
      x:{ grid:{display:false}, ticks:{color:'#55555f',font:{size:11}}, border:{display:false} },
      y:{ grid:{color:'rgba(255,255,255,0.05)'}, ticks:{color:'#55555f',font:{size:11}}, border:{display:false}, ...((extra.y)||{}) }
    }, ...extra
  };
}

function rebuildChart(id, config) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  const canvas = document.getElementById(id);
  if (!canvas) return;
  charts[id] = new Chart(canvas, config);
}

/* ═══════════════════════════════════════════════════════════════
   MODAL
   ═══════════════════════════════════════════════════════════════ */
function openModal(tradeId) {
  const t = trades.find(t => t.id === tradeId);
  if (!t) return;
  currentTradeId = tradeId;
  const n = notes[tradeId] || {};

  document.getElementById('modal-title').textContent = t.symbol + (t.entryTime ? ' — ' + fmtDate(t.entryTime) : '');

  // Detail grid
  document.getElementById('modalBody').innerHTML = `
    <div class="modal-detail-grid">
      <div class="detail-item"><span class="detail-label">Entry time</span><span class="detail-val">${fmtTime(t.entryTime)}</span></div>
      <div class="detail-item"><span class="detail-label">Exit time</span><span class="detail-val">${fmtTime(t.exitTime)}</span></div>
      <div class="detail-item"><span class="detail-label">Duration</span><span class="detail-val">${fmtDuration(t.durationSec)}</span></div>
      <div class="detail-item"><span class="detail-label">Contract</span><span class="detail-val">${esc(t.symbol)}</span></div>
      <div class="detail-item"><span class="detail-label">Size</span><span class="detail-val">${t.size}</span></div>
      <div class="detail-item"><span class="detail-label">Direction</span><span class="detail-val"><span class="badge badge-${t.side}">${t.side}</span></span></div>
      <div class="detail-item"><span class="detail-label">Entry price</span><span class="detail-val">${fmtPrice(t.entry)}</span></div>
      <div class="detail-item"><span class="detail-label">Exit price</span><span class="detail-val">${fmtPrice(t.exit)}</span></div>
      <div class="detail-item"><span class="detail-label">P&L</span><span class="detail-val ${t.pnl>=0?'pnl-pos':'pnl-neg'}">${t.pnl!=null?fmtPnl(t.pnl):'—'}</span></div>
      <div class="detail-item"><span class="detail-label">Platform</span><span class="detail-val">${sourceBadge(t.source)}</span></div>
      ${t.commissions!=null?`<div class="detail-item"><span class="detail-label">Commissions</span><span class="detail-val" style="color:var(--text2)">$${Math.abs(t.commissions).toFixed(2)}</span></div>`:''}
      ${t.fees!=null?`<div class="detail-item"><span class="detail-label">Fees</span><span class="detail-val" style="color:var(--text2)">$${Math.abs(t.fees).toFixed(2)}</span></div>`:''}
      ${t.tradeId?`<div class="detail-item"><span class="detail-label">Trade ID</span><span class="detail-val" style="color:var(--text3);font-size:12px">${esc(t.tradeId)}</span></div>`:''}
    </div>
    <div class="trade-visual-wrap">
      <div class="trade-visual-label">Trade visual — entry → exit</div>
      <canvas class="trade-visual-canvas" id="tradeVisualCanvas"></canvas>
      <div class="trade-visual-meta">
        <span>${t.side === 'long' ? '▲ Long' : '▼ Short'} · ${t.symbol} · ${t.size} contract${t.size!==1?'s':''}</span>
        <span>${fmtDate(t.date)}</span>
      </div>
    </div>`;

  // Draw visual after DOM update
  setTimeout(() => {
    const cvs = document.getElementById('tradeVisualCanvas');
    if (cvs) drawTradeVisual(cvs, t);
  }, 30);

  // Chart image
  const preview = document.getElementById('chartImagePreview');
  const placeholder = document.getElementById('chartPlaceholder');
  const actions = document.getElementById('chartImageActions');

  if (n.chartImage) {
    preview.src = n.chartImage;
    preview.style.display = 'block';
    placeholder.style.display = 'none';
    actions.style.display = 'flex';
  } else {
    preview.src = '';
    preview.style.display = 'none';
    placeholder.style.display = 'flex';
    actions.style.display = 'none';
  }

  // Notes/tags
  document.getElementById('tradeSource').value = t.source || 'manual';
  document.getElementById('tradeNote').value = n.note || '';
  document.getElementById('tradeTags').value = (n.tags||[]).join(', ');

  document.getElementById('modalOverlay').classList.add('open');
  document.getElementById('modalOverlay').setAttribute('aria-hidden','false');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.getElementById('modalOverlay').setAttribute('aria-hidden','true');
  currentTradeId = null;
}

function saveNoteModal() {
  if (!currentTradeId) return;
  const existing = notes[currentTradeId] || {};
  const newSource = document.getElementById('tradeSource').value;

  // Update the source on the trade object itself
  const trade = trades.find(t => t.id === currentTradeId);
  if (trade) trade.source = newSource;

  notes[currentTradeId] = {
    ...existing,
    note : document.getElementById('tradeNote').value.trim(),
    tags : document.getElementById('tradeTags').value.split(',').map(s=>s.trim()).filter(Boolean),
  };
  saveTrades();
  saveNotes();
  refreshTrades();
  closeModal();
  showToast('Trade saved.');
}

/* ── Chart image handling ───────────────────────────────────────── */
function handleChartImage(file) {
  if (!file || !currentTradeId) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    notes[currentTradeId] = { ...(notes[currentTradeId]||{}), chartImage: dataUrl };
    saveNotes();

    const preview = document.getElementById('chartImagePreview');
    const placeholder = document.getElementById('chartPlaceholder');
    const actions = document.getElementById('chartImageActions');
    preview.src = dataUrl;
    preview.style.display = 'block';
    placeholder.style.display = 'none';
    actions.style.display = 'flex';
    showToast('Chart image saved.');
    refreshTrades();
  };
  reader.readAsDataURL(file);
}

function removeChartImage() {
  if (!currentTradeId) return;
  notes[currentTradeId] = { ...(notes[currentTradeId]||{}), chartImage: null };
  saveNotes();
  const preview = document.getElementById('chartImagePreview');
  const placeholder = document.getElementById('chartPlaceholder');
  const actions = document.getElementById('chartImageActions');
  preview.src = '';
  preview.style.display = 'none';
  placeholder.style.display = 'flex';
  actions.style.display = 'none';
  refreshTrades();
  showToast('Chart image removed.');
}

/* ── Navigation ─────────────────────────────────────────────────── */
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('view-' + name)?.classList.add('active');
  document.querySelector(`[data-view="${name}"]`)?.classList.add('active');
  if (name === 'dashboard')   refreshDashboard();
  if (name === 'trades')      refreshTrades();
  if (name === 'performance') refreshPerformance();
}

function refreshAll() {
  const active = document.querySelector('.view.active')?.id?.replace('view-','') || 'dashboard';
  showView(active);
}

/* ═══════════════════════════════════════════════════════════════
   EVENT WIRING
   ═══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  loadSaved();

  // Nav
  document.querySelectorAll('.nav-item').forEach(item =>
    item.addEventListener('click', e => { e.preventDefault(); showView(item.dataset.view); }));

  // CSV import
  const csvInput = document.getElementById('csvInput');
  document.getElementById('importBtn').addEventListener('click', () => csvInput.click());
  document.getElementById('dashImportBtn')?.addEventListener('click', () => csvInput.click());
  csvInput.addEventListener('change', e => {
    if (e.target.files[0]) { handleCSV(e.target.files[0]); e.target.value = ''; }
  });

  // Filters
  document.getElementById('dash-period').addEventListener('change', refreshDashboard);
  document.getElementById('search').addEventListener('input', e => { filterConfig.search = e.target.value; refreshTrades(); });
  document.getElementById('filter-side').addEventListener('change', e => { filterConfig.side = e.target.value; refreshTrades(); });
  document.getElementById('filter-result').addEventListener('change', e => { filterConfig.result = e.target.value; refreshTrades(); });
  document.getElementById('filter-source').addEventListener('change', e => { filterConfig.source = e.target.value; refreshTrades(); });

  // Sort headers
  document.querySelectorAll('.sortable').forEach(th =>
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      sortConfig.key === key ? (sortConfig.dir *= -1) : (sortConfig.key = key, sortConfig.dir = -1);
      refreshTrades();
    }));

  // Trade row → open modal
  document.getElementById('tradesBody').addEventListener('click', e => {
    const btn = e.target.closest('.btn-row');
    if (btn) openModal(btn.dataset.id);
  });

  // Modal close
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalOverlay').addEventListener('click', e => { if (e.target===e.currentTarget) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key==='Escape') closeModal(); });

  // Save note
  document.getElementById('saveNote').addEventListener('click', saveNoteModal);

  // Chart image upload button
  const chartInput = document.getElementById('chartImageInput');
  document.getElementById('uploadChartBtn').addEventListener('click', () => chartInput.click());
  chartInput.addEventListener('change', e => {
    if (e.target.files[0]) { handleChartImage(e.target.files[0]); e.target.value = ''; }
  });

  // Remove chart image
  document.getElementById('removeChartBtn').addEventListener('click', removeChartImage);

  // Drag & drop on chart upload area
  const uploadArea = document.getElementById('chartUploadArea');
  uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
  uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) handleChartImage(file);
  });

  // Initial render
  showView('dashboard');
});

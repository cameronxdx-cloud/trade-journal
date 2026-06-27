/* ─────────────────────────────────────────────────────────────────
   Trade Journal — app.js
   Supports CSV exports from Topstep, Lucid, and a manual template.
   ──────────────────────────────────────────────────────────────── */

'use strict';

/* ── State ──────────────────────────────────────────────────────── */
let trades = [];      // normalized trade objects
let notes  = {};      // { tradeId: { note, tags } }
let charts = {};      // Chart.js instances
let sortConfig = { key: 'date', dir: -1 };
let filterConfig = { search: '', side: '', result: '' };
let currentTradeId = null;

/* ── Normalize ───────────────────────────────────────────────────
   Accepts CSVs from:
   • Topstep   — columns: Date, Symbol, Side, EntryPrice, ExitPrice, PnL
   • Lucid     — columns: TradeDate, Instrument, Direction, EntryFill, ExitFill, NetPnL
   • Manual    — see sample.csv
   ──────────────────────────────────────────────────────────────── */
function normalizeTrade(row, idx) {
  // Build a lower-cased key map for flexible header matching
  const keys = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.toLowerCase().trim().replace(/\s+/g, ''), v])
  );

  const pick = (...candidates) => {
    for (const c of candidates) {
      const v = keys[c];
      if (v !== undefined && v !== '') return v;
    }
    return '';
  };

  const raw_date   = pick('date','tradedate','datetime','time','closeddate','closetime');
  const symbol     = pick('symbol','instrument','ticker','contract');
  const side_raw   = pick('side','direction','type','buysell');
  const entry_raw  = pick('entryprice','entryfill','entry','avgentry','entryavg','buy');
  const exit_raw   = pick('exitprice','exitfill','exit','avgexit','exitavg','sell');
  const pnl_raw    = pick('pnl','netpnl','realizedpnl','profit','net','realizedpl','pl');

  const side = /short|sell|s\b/i.test(side_raw) ? 'short' : 'long';

  const parseNum = s => {
    if (s === '' || s == null) return null;
    const n = parseFloat(String(s).replace(/[$,()]/g,'').trim());
    return isNaN(n) ? null : (String(s).includes('(') ? -n : n);
  };

  const pnl   = parseNum(pnl_raw);
  const entry = parseNum(entry_raw);
  const exit  = parseNum(exit_raw);

  // Parse date flexibly
  let dateObj = raw_date ? new Date(raw_date) : null;
  if (dateObj && isNaN(dateObj.getTime())) {
    // try MM/DD/YYYY
    const parts = raw_date.match(/(\d+)[\/\-](\d+)[\/\-](\d+)/);
    if (parts) dateObj = new Date(`${parts[3]}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`);
  }

  return {
    id      : `trade-${idx}-${Date.now()}`,
    date    : dateObj && !isNaN(dateObj.getTime()) ? dateObj : null,
    symbol  : (symbol || 'UNKNOWN').toUpperCase(),
    side,
    entry,
    exit,
    pnl,
    result  : pnl !== null ? (pnl >= 0 ? 'win' : 'loss') : null,
    raw     : row,
  };
}

/* ── CSV Import ─────────────────────────────────────────────────── */
function handleCSV(file) {
  Papa.parse(file, {
    header      : true,
    skipEmptyLines: true,
    complete(results) {
      if (!results.data.length) { alert('No data found in CSV.'); return; }
      const newTrades = results.data.map((r, i) => normalizeTrade(r, i + trades.length))
        .filter(t => t.pnl !== null || t.entry !== null);

      trades = [...trades, ...newTrades];
      saveTrades();
      refreshAll();
      showView('dashboard');
    },
    error(err) { alert('Could not parse CSV: ' + err.message); }
  });
}

/* ── Persistence ────────────────────────────────────────────────── */
function saveTrades() {
  try {
    localStorage.setItem('tj_trades', JSON.stringify(trades.map(t => ({ ...t, date: t.date?.toISOString() }))));
  } catch(e) {}
}
function saveNotes() {
  try { localStorage.setItem('tj_notes', JSON.stringify(notes)); } catch(e) {}
}
function loadSaved() {
  try {
    const raw = localStorage.getItem('tj_trades');
    if (raw) {
      trades = JSON.parse(raw).map(t => ({ ...t, date: t.date ? new Date(t.date) : null }));
    }
    const n = localStorage.getItem('tj_notes');
    if (n) notes = JSON.parse(n);
  } catch(e) {}
}

/* ── Filtering ──────────────────────────────────────────────────── */
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

  return list;
}

/* ── Stats ───────────────────────────────────────────────────────── */
function computeStats(list) {
  const withPnl = list.filter(t => t.pnl !== null);
  const wins    = withPnl.filter(t => t.pnl >= 0);
  const losses  = withPnl.filter(t => t.pnl < 0);
  const totalPnl   = withPnl.reduce((s, t) => s + t.pnl, 0);
  const grossWin   = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const avgWin     = wins.length ? grossWin / wins.length : 0;
  const avgLoss    = losses.length ? grossLoss / losses.length : 0;
  const pf         = grossLoss > 0 ? (grossWin / grossLoss) : (grossWin > 0 ? Infinity : 0);
  return { totalPnl, wins: wins.length, losses: losses.length, total: withPnl.length, winRate: withPnl.length ? wins.length / withPnl.length : 0, avgWin, avgLoss, pf };
}

/* ── Format helpers ─────────────────────────────────────────────── */
const fmtPnl = v => (v >= 0 ? '+' : '') + '$' + Math.abs(v).toFixed(2);
const fmtDate = d => d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const fmtPrice = v => v != null ? '$' + v.toFixed(2) : '—';

/* ── Dashboard ───────────────────────────────────────────────────── */
function refreshDashboard() {
  const period = document.getElementById('dash-period').value;
  const list   = filteredTrades(period).sort((a,b) => (a.date||0) - (b.date||0));
  const stats  = computeStats(list);
  const empty  = document.getElementById('dash-empty');
  const grid   = document.getElementById('stats-grid');

  if (!list.length) {
    empty.classList.add('visible');
    grid.style.display = 'none';
    document.querySelector('.charts-grid').style.display = 'none';
    return;
  }
  empty.classList.remove('visible');
  grid.style.display = '';
  document.querySelector('.charts-grid').style.display = '';

  // Date range label
  const dates = list.map(t => t.date).filter(Boolean);
  if (dates.length) {
    document.getElementById('dash-date-range').textContent =
      fmtDate(dates[0]) + ' – ' + fmtDate(dates[dates.length-1]);
  }

  // Stat cards
  const pnlEl = document.getElementById('stat-pnl');
  pnlEl.textContent = fmtPnl(stats.totalPnl);
  pnlEl.className = 'stat-value ' + (stats.totalPnl >= 0 ? 'pos' : 'neg');
  document.getElementById('stat-winrate').textContent  = (stats.winRate * 100).toFixed(1) + '%';
  document.getElementById('stat-total').textContent    = stats.total;
  document.getElementById('stat-avgwin').textContent   = '$' + stats.avgWin.toFixed(2);
  document.getElementById('stat-avgloss').textContent  = '$' + stats.avgLoss.toFixed(2);
  document.getElementById('stat-pf').textContent       = isFinite(stats.pf) ? stats.pf.toFixed(2) : '∞';

  // Charts
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

  const color = data[data.length-1] >= 0 ? '#3ecf8e' : '#f05252';
  rebuildChart('chartEquity', {
    type: 'line',
    data: {
      labels,
      datasets: [{ label: 'Equity', data, borderColor: color, backgroundColor: hexAlpha(color, 0.08),
        fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2 }]
    },
    options: chartOpts({ y: { grid: { color: 'rgba(255,255,255,0.05)' } } })
  });
}

function buildWinLossChart(stats) {
  rebuildChart('chartWinLoss', {
    type: 'doughnut',
    data: {
      labels: ['Wins','Losses'],
      datasets: [{ data: [stats.wins, stats.losses], backgroundColor: ['#3ecf8e','#f05252'],
        borderColor: '#141417', borderWidth: 3 }]
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: '68%',
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        label: ctx => ` ${ctx.label}: ${ctx.parsed} (${stats.total ? Math.round(ctx.parsed/stats.total*100) : 0}%)`
      }}}
    }
  });
}

function buildDailyChart(list) {
  const byDay = {};
  list.forEach(t => {
    if (!t.date || t.pnl == null) return;
    const key = t.date.toISOString().slice(0,10);
    byDay[key] = (byDay[key] || 0) + t.pnl;
  });
  const sorted = Object.entries(byDay).sort(([a],[b]) => a.localeCompare(b));
  const labels = sorted.map(([k]) => { const d=new Date(k+'T12:00:00'); return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}); });
  const data   = sorted.map(([,v]) => parseFloat(v.toFixed(2)));
  const colors = data.map(v => v >= 0 ? 'rgba(62,207,142,0.75)' : 'rgba(240,82,82,0.75)');

  rebuildChart('chartDaily', {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Daily P&L', data, backgroundColor: colors, borderRadius: 3 }] },
    options: chartOpts({ y: { grid: { color: 'rgba(255,255,255,0.05)' } } })
  });
}

/* ── Trades table ───────────────────────────────────────────────── */
function refreshTrades() {
  let list = filteredTrades();
  list.sort((a, b) => {
    const k = sortConfig.key;
    let av = a[k], bv = b[k];
    if (av instanceof Date) av = av.getTime();
    if (bv instanceof Date) bv = bv.getTime();
    return sortConfig.dir * ((av ?? -Infinity) < (bv ?? -Infinity) ? -1 : (av ?? -Infinity) > (bv ?? -Infinity) ? 1 : 0);
  });

  document.getElementById('trades-count').textContent = list.length + ' trade' + (list.length !== 1 ? 's' : '');
  const tbody  = document.getElementById('tradesBody');
  const empty  = document.getElementById('trades-empty');
  tbody.innerHTML = '';

  if (!list.length) { empty.classList.add('visible'); return; }
  empty.classList.remove('visible');

  list.forEach(t => {
    const n  = notes[t.id] || {};
    const tr = document.createElement('tr');

    const tagHtml = (n.tags || []).map(tag => `<span class="tag-pill">${esc(tag)}</span>`).join('');

    tr.innerHTML = `
      <td>${fmtDate(t.date)}</td>
      <td><strong>${esc(t.symbol)}</strong></td>
      <td><span class="badge badge-${t.side}">${t.side}</span></td>
      <td>${fmtPrice(t.entry)}</td>
      <td>${fmtPrice(t.exit)}</td>
      <td class="${t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${t.pnl != null ? fmtPnl(t.pnl) : '—'}</td>
      <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2);font-size:12px">${esc(n.note || '')}</td>
      <td>${tagHtml || '<span style="color:var(--text3);font-size:11px">—</span>'}</td>
      <td><button class="btn-row" data-id="${t.id}">Edit ↗</button></td>`;

    tbody.appendChild(tr);
  });
}

/* ── Performance charts ─────────────────────────────────────────── */
function refreshPerformance() {
  const list = filteredTrades();

  // P&L by Symbol
  const bySymbol = {};
  list.forEach(t => { if (t.pnl != null) bySymbol[t.symbol] = (bySymbol[t.symbol]||0) + t.pnl; });
  const symEntries = Object.entries(bySymbol).sort(([,a],[,b]) => b-a);
  rebuildChart('chartSymbol', {
    type: 'bar',
    data: { labels: symEntries.map(([k]) => k),
      datasets: [{ label: 'P&L', data: symEntries.map(([,v]) => parseFloat(v.toFixed(2))),
        backgroundColor: symEntries.map(([,v]) => v >= 0 ? 'rgba(62,207,142,0.7)' : 'rgba(240,82,82,0.7)'),
        borderRadius: 3 }] },
    options: chartOpts({})
  });

  // Trades by day of week
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const counts = Array(7).fill(0);
  list.forEach(t => { if (t.date) counts[t.date.getDay()]++; });
  rebuildChart('chartDow', {
    type: 'bar',
    data: { labels: dow, datasets: [{ label: 'Trades', data: counts,
      backgroundColor: 'rgba(124,110,247,0.6)', borderRadius: 3 }] },
    options: chartOpts({})
  });

  // Histogram
  const pnls = list.map(t => t.pnl).filter(v => v != null);
  if (pnls.length) {
    const min = Math.floor(Math.min(...pnls) / 50) * 50;
    const max = Math.ceil(Math.max(...pnls) / 50) * 50;
    const bins = [];
    for (let b = min; b < max; b += 50) {
      bins.push({ label: `$${b}`, count: pnls.filter(p => p >= b && p < b+50).length, b });
    }
    rebuildChart('chartHisto', {
      type: 'bar',
      data: { labels: bins.map(b => b.label),
        datasets: [{ label: 'Trades', data: bins.map(b => b.count),
          backgroundColor: bins.map(b => b.b >= 0 ? 'rgba(62,207,142,0.65)' : 'rgba(240,82,82,0.65)'),
          borderRadius: 3 }] },
      options: chartOpts({})
    });
  }
}

/* ── Chart helpers ──────────────────────────────────────────────── */
function chartOpts(extra) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false }, ticks: { color: '#55555f', font: { size: 11 } }, border: { display: false } },
      y: { grid: { color: 'rgba(255,255,255,0.05)', ...((extra.y?.grid)||{}) }, ticks: { color: '#55555f', font: { size: 11 } }, border: { display: false }, ...((extra.y)||{}) }
    },
    ...extra
  };
}

function hexAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function rebuildChart(id, config) {
  if (charts[id]) { charts[id].destroy(); }
  const canvas = document.getElementById(id);
  if (!canvas) return;
  charts[id] = new Chart(canvas, config);
}

/* ── Modal ──────────────────────────────────────────────────────── */
function openModal(tradeId) {
  const t = trades.find(t => t.id === tradeId);
  if (!t) return;
  currentTradeId = tradeId;
  const n = notes[tradeId] || {};

  document.getElementById('modal-title').textContent = t.symbol + ' — ' + fmtDate(t.date);
  document.getElementById('modalBody').innerHTML = `
    <div class="modal-detail-grid">
      <div class="detail-item"><span class="detail-label">Date</span><span class="detail-val">${fmtDate(t.date)}</span></div>
      <div class="detail-item"><span class="detail-label">Symbol</span><span class="detail-val">${esc(t.symbol)}</span></div>
      <div class="detail-item"><span class="detail-label">Side</span><span class="detail-val"><span class="badge badge-${t.side}">${t.side}</span></span></div>
      <div class="detail-item"><span class="detail-label">P&L</span><span class="detail-val ${t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${t.pnl != null ? fmtPnl(t.pnl) : '—'}</span></div>
      <div class="detail-item"><span class="detail-label">Entry</span><span class="detail-val">${fmtPrice(t.entry)}</span></div>
      <div class="detail-item"><span class="detail-label">Exit</span><span class="detail-val">${fmtPrice(t.exit)}</span></div>
    </div>`;

  document.getElementById('tradeNote').value  = n.note || '';
  document.getElementById('tradeTags').value  = (n.tags || []).join(', ');
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
  notes[currentTradeId] = {
    note : document.getElementById('tradeNote').value.trim(),
    tags : document.getElementById('tradeTags').value.split(',').map(s => s.trim()).filter(Boolean)
  };
  saveNotes();
  refreshTrades();
  closeModal();
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

/* ── Misc helpers ───────────────────────────────────────────────── */
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function refreshAll() {
  const active = document.querySelector('.view.active')?.id?.replace('view-','') || 'dashboard';
  showView(active);
}

/* ── Event wiring ────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  loadSaved();

  // Nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => { e.preventDefault(); showView(item.dataset.view); });
  });

  // Import
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

  // Sort headers
  document.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortConfig.key === key) sortConfig.dir *= -1;
      else { sortConfig.key = key; sortConfig.dir = -1; }
      refreshTrades();
    });
  });

  // Table row buttons (edit)
  document.getElementById('tradesBody').addEventListener('click', e => {
    const btn = e.target.closest('.btn-row');
    if (btn) openModal(btn.dataset.id);
  });

  // Modal
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
  document.getElementById('saveNote').addEventListener('click', saveNoteModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // Initial render
  showView('dashboard');
});

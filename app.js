'use strict';
// Tracker: all data lives in the Google Sheet. This app only fetches it, shows
// stats and sends new entries. Nothing is stored here except the connection settings.

const COUNT_SINCE = '2024-02-20';   // counts by initiator start here
const AVG_SINCE = '2024-01-01';     // average gap uses entries from 2024 on
const CFG_KEY = 'tracker.cfg';

const $ = (id) => document.getElementById(id);
const DAY = 86400000;

function parseDay(s) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
function normWho(w) { w = String(w || '').trim(); return /^both/i.test(w) ? 'Both' : (w || 'Unknown'); }

// Pure stats function (also used by tests)
function computeStats(rows, today) {
  const dates = rows.map(r => r.date).filter(Boolean).sort();
  if (!dates.length) return null;
  const last = dates[dates.length - 1];
  const daysSince = Math.round((parseDay(today) - parseDay(last)) / DAY);
  const counts = {};
  rows.filter(r => r.date >= COUNT_SINCE).forEach(r => { const w = normWho(r.who); counts[w] = (counts[w] || 0) + 1; });
  const recent = dates.filter(d => d >= AVG_SINCE);
  const avg = recent.length > 1 ? (parseDay(recent[recent.length - 1]) - parseDay(recent[0])) / DAY / (recent.length - 1) : null;
  return { last, daysSince, counts, avg, avgN: recent.length };
}

function getCfg() { try { return JSON.parse(localStorage.getItem(CFG_KEY)) || null; } catch { return null; } }
function setCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }

async function api(body) {
  const cfg = getCfg();
  let res;
  if (body) {
    res = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, key: cfg.key }), cache: 'no-store' });
  } else {
    res = await fetch(`${cfg.url}?key=${encodeURIComponent(cfg.key)}&t=${Date.now()}`, { cache: 'no-store' });
  }
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Request failed');
  lastInfo = data.info || null;
  return data.rows || [];
}

let lastRows = [];
let lastInfo = null;

function render(rows) {
  lastRows = rows;
  const s = computeStats(rows, todayStr());
  if (!s) { $('daysSince').textContent = '–'; return; }
  $('daysSince').textContent = s.daysSince;
  $('lastDate').textContent = `Last entry: ${s.last}`;
  $('sinceLabel').textContent = COUNT_SINCE;
  const order = Object.keys(s.counts).sort((a, b) => s.counts[b] - s.counts[a]);
  $('counts').innerHTML = '';
  order.forEach(w => {
    const el = document.createElement('div'); el.className = 'count';
    const b = document.createElement('b'); b.textContent = s.counts[w];
    const sp = document.createElement('span'); sp.textContent = w;
    el.append(b, sp); $('counts').append(el);
  });
  $('avgGap').textContent = s.avg == null ? '–' : s.avg.toFixed(1);
  $('avgNote').textContent = `Across ${s.avgN} entries since ${AVG_SINCE.slice(0, 4)}`;
}

async function load() {
  setStatus('Loading…');
  try {
    const rows = await api(); render(rows);
    if (!rows.length) setStatus(`Connected, but no dates were read${lastInfo ? ` (${lastInfo.sheet}, last row ${lastInfo.lastRow})` : ''}. The script may need updating.`, true);
    else setStatus(`Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  }
  catch (e) { setStatus(`Couldn't load: ${e.message}`, true); }
}

function setStatus(msg, err) { const el = $('status'); el.textContent = msg; el.classList.toggle('err', !!err); }

function showMain() { $('setup').hidden = true; $('main').hidden = false; load(); }
function showSetup() {
  const c = getCfg() || {}; $('cfgUrl').value = c.url || ''; $('cfgKey').value = c.key || '';
  $('main').hidden = true; $('setup').hidden = false;
}

function openAdd() {
  $('fDate').value = todayStr();
  const names = new Set(['Unknown']);
  lastRows.forEach(r => { const w = normWho(r.who); if (w !== 'Both') names.add(w); });
  const sel = $('fWho'); sel.innerHTML = '';
  [...names].sort((a, b) => (a === 'Unknown') - (b === 'Unknown') || a.localeCompare(b)).forEach(n => {
    const o = document.createElement('option'); o.value = o.textContent = n; sel.append(o);
  });
  sel.append(Object.assign(document.createElement('option'), { value: 'Both', textContent: 'Both' }));
  $('fDesc').value = '';
  $('addDialog').showModal();
}

async function saveAdd(ev) {
  ev.preventDefault();
  const date = $('fDate').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const now = new Date();
  const time = date === todayStr() ? now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
  const btn = $('saveAdd'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const rows = await api({ action: 'add', date, time, who: $('fWho').value, description: $('fDesc').value.trim() });
    $('addDialog').close(); render(rows); setStatus('Entry saved to the sheet');
  } catch (e) { setStatus(`Couldn't save: ${e.message}`, true); $('addDialog').close(); }
  finally { btn.disabled = false; btn.textContent = 'Save'; }
}

if (typeof document !== 'undefined' && document.getElementById('main')) {
  $('saveCfg').onclick = async () => {
    const url = $('cfgUrl').value.trim(), key = $('cfgKey').value.trim();
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url) || !key) { $('setupStatus').textContent = 'Enter the /exec URL and the key.'; return; }
    setCfg({ url, key }); showMain();
  };
  $('settingsBtn').onclick = showSetup;
  $('refreshBtn').onclick = () => getCfg() && load();
  $('addBtn').onclick = openAdd;
  $('cancelAdd').onclick = () => $('addDialog').close();
  $('addForm').onsubmit = saveAdd;
  document.addEventListener('visibilitychange', () => { if (!document.hidden && getCfg() && !$('main').hidden) load(); });
  getCfg() ? showMain() : showSetup();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
}

if (typeof module !== 'undefined') module.exports = { computeStats, normWho };

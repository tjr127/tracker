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

function isYes(r) { return String(r.result == null ? 'Yes' : r.result).trim().toLowerCase() === 'yes'; }

// Pure stats function (also used by tests).
// Days since and average gap use only rows whose Result is "Yes"; counts include every initiation.
function computeStats(rows, today) {
  const yesDates = rows.filter(isYes).map(r => r.date).filter(Boolean).sort();
  const counts = {};
  rows.filter(r => r.date >= COUNT_SINCE).forEach(r => { const w = normWho(r.who); counts[w] = (counts[w] || 0) + 1; });
  const yesSince = rows.filter(r => r.date >= COUNT_SINCE && isYes(r)).length;
  if (!yesDates.length) return { last: null, daysSince: null, counts, yesSince, avg: null, avgN: 0, avgYear: null, avgYearN: 0 };
  const last = yesDates[yesDates.length - 1];
  const daysSince = Math.round((parseDay(today) - parseDay(last)) / DAY);
  // Average gap includes the current open stretch: (today - first "Yes") / number of "Yes" entries.
  const gap = (ds) => ds.length ? (parseDay(today) - parseDay(ds[0])) / DAY / ds.length : null;
  const recent = yesDates.filter(d => d >= AVG_SINCE);
  const yearAgo = String(Number(today.slice(0, 4)) - 1) + today.slice(4);
  const year = yesDates.filter(d => d >= yearAgo && d <= today);
  return { last, daysSince, counts, yesSince, avg: gap(recent), avgN: recent.length, avgYear: gap(year), avgYearN: year.length, yearAgo };
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
  $('daysSince').textContent = s.daysSince == null ? '–' : s.daysSince;
  $('lastDate').textContent = s.last ? `Last "Yes" entry: ${s.last}` : '';
  $('sinceLabel').textContent = COUNT_SINCE;
  const order = Object.keys(s.counts).sort((a, b) => s.counts[b] - s.counts[a]);
  $('counts').innerHTML = '';
  order.forEach(w => {
    const el = document.createElement('div'); el.className = 'count';
    const b = document.createElement('b'); b.textContent = s.counts[w];
    const sp = document.createElement('span'); sp.textContent = w;
    el.append(b, sp); $('counts').append(el);
  });
  $('yesNote').textContent = `${s.yesSince} of these were a "Yes"`;
  $('avgGap').textContent = s.avg == null ? '–' : s.avg.toFixed(1);
  $('avgNote').textContent = `${s.avgN} "Yes" entries since ${AVG_SINCE.slice(0, 4)}, through today`;
  $('avgYear').textContent = s.avgYear == null ? '–' : s.avgYear.toFixed(1);
  $('avgYearNote').textContent = `${s.avgYearN} "Yes" entries in the last 12 months, through today`;
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
  $('cfgMe').value = c.me || ''; $('cfgThem').value = c.them || '';
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
  $('fResult').value = 'Yes';
  $('fText').value = ''; $('fShotStatus').textContent = '';
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
    const rows = await api({ action: 'add', date, time, who: $('fWho').value, result: $('fResult').value, exchange: $('fText').value.trim(), description: $('fDesc').value.trim() });
    $('addDialog').close(); render(rows); setStatus('Entry saved to the sheet');
  } catch (e) { setStatus(`Couldn't save: ${e.message}`, true); $('addDialog').close(); }
  finally { btn.disabled = false; btn.textContent = 'Save'; }
}

// ---- screenshots -> text ----
function names() { const c = getCfg() || {}; return [c.me || 'Me', c.them || 'Them']; }

async function handleShots(files, textareaId, statusId) {
  const imgs = [...files].filter(f => f && f.type && f.type.startsWith('image/'));
  if (!imgs.length) return;
  const status = $(statusId), ta = $(textareaId);
  const batches = [];
  try {
    for (let i = 0; i < imgs.length; i++) {
      status.textContent = i === 0 && !window.Tesseract ? 'Loading the text reader (first time only)…' : `Reading screenshot ${i + 1} of ${imgs.length}…`;
      batches.push(await readScreenshot(imgs[i]));
    }
    const msgs = mergeMessages(batches);
    if (!msgs.length) { status.textContent = "Couldn't find any messages in that screenshot."; return; }
    const [me, them] = names();
    const text = formatMessages(msgs, me, them);
    ta.value = ta.value.trim() ? ta.value.trim() + '\n' + text : text;
    status.textContent = `Added ${msgs.length} message${msgs.length === 1 ? '' : 's'}. Check for mistakes before saving.`;
  } catch (e) { status.textContent = `Couldn't read it: ${e.message}`; }
}

function wireShots(btnId, inputId, textareaId, statusId, dialogId) {
  $(btnId).onclick = () => $(inputId).click();
  $(inputId).onchange = (e) => { handleShots(e.target.files, textareaId, statusId); e.target.value = ''; };
  $(dialogId).addEventListener('paste', (e) => {
    const files = [...(e.clipboardData && e.clipboardData.files || [])];
    if (files.some(f => f.type.startsWith('image/'))) { e.preventDefault(); handleShots(files, textareaId, statusId); }
  });
}

function openText() {
  const sel = $('tRow'); sel.innerHTML = '';
  [...lastRows].sort((a, b) => (b.date + (b.row || 0)).localeCompare(a.date + (a.row || 0))).forEach(r => {
    const o = document.createElement('option');
    o.value = JSON.stringify({ row: r.row, date: r.date });
    o.textContent = `${r.date} · ${normWho(r.who)} · ${r.result || 'Yes'}${r.hasText ? ' · has texts' : ''}`;
    sel.append(o);
  });
  $('tText').value = ''; $('tShotStatus').textContent = '';
  $('textDialog').showModal();
}

async function saveText(ev) {
  ev.preventDefault();
  const text = $('tText').value.trim(); if (!text) return;
  const { row, date } = JSON.parse($('tRow').value);
  const btn = $('saveText'); btn.disabled = true; btn.textContent = 'Saving…';
  try { const rows = await api({ action: 'addText', row, date, text }); $('textDialog').close(); render(rows); setStatus('Texts saved to the sheet'); }
  catch (e) { setStatus(`Couldn't save: ${e.message}`, true); $('textDialog').close(); }
  finally { btn.disabled = false; btn.textContent = 'Save'; }
}

if (typeof document !== 'undefined' && document.getElementById('main')) {
  wireShots('fShotBtn', 'fShotInput', 'fText', 'fShotStatus', 'addDialog');
  wireShots('tShotBtn', 'tShotInput', 'tText', 'tShotStatus', 'textDialog');
  $('addTextBtn').onclick = openText;
  $('cancelText').onclick = () => $('textDialog').close();
  $('textForm').onsubmit = saveText;
  $('saveCfg').onclick = async () => {
    const url = $('cfgUrl').value.trim(), key = $('cfgKey').value.trim();
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url) || !key) { $('setupStatus').textContent = 'Enter the /exec URL and the key.'; return; }
    setCfg({ url, key, me: $('cfgMe').value.trim(), them: $('cfgThem').value.trim() }); showMain();
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

if (typeof module !== 'undefined') module.exports = { computeStats, normWho, isYes };

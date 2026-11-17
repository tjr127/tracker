'use strict';
// Reads text-message screenshots on the phone itself (Tesseract.js) and turns them into
// "Name: message" lines. Messages on the right side of the screen are yours; messages on
// the left are the other person's. Nothing is uploaded: the image never leaves the device.

const TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

const NOISE = [
  /^\d{1,2}[:.]\d{2}\s*([ap]\.?m\.?)?$/i,                       // 8:31 PM
  /^(today|yesterday)\b/i,
  /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s/i,               // Mon, Nov 17
  /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}/i,
  /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/,
  /^(read|delivered|sent|seen|failed|not delivered)\b/i,
  /^(rcs|text|chat|sms|mms)\s*message$/i,
  /^(message|type a message|imessage)$/i,
];
const TRAILING_TIME = /\s+\d{1,2}[:.]\d{2}\s*([ap]\.?m\.?)?$/i;

function cleanText(t) {
  return String(t || '').replace(/[|]/g, 'I').replace(/\s+/g, ' ').replace(TRAILING_TIME, '').trim();
}
function isNoise(t) {
  const alnum = (t.match(/[A-Za-z0-9]/g) || []).length;
  if (alnum < 2) return true;
  return NOISE.some(re => re.test(t));
}

// lines: [{text, bbox:{x0,y0,x1,y1}}]; W,H: image size. Returns [{who:'me'|'them', text}]
function parseOcrLines(lines, W, H) {
  const keep = [];
  for (const l of lines) {
    const b = l.bbox; if (!b) continue;
    let raw = l.text;
    // Drop a stray first word that sits far from the rest (usually the contact's avatar letter).
    if (l.words && l.words.length > 1) {
      const w0 = l.words[0], w1 = l.words[1], hgt = (b.y1 - b.y0) || 1;
      if (w1.bbox.x0 - w0.bbox.x1 > hgt * 0.6 && String(w0.text).length <= 4 && !/^[A-Za-z]{2,}$/.test(w0.text)) {
        raw = l.words.slice(1).map(w => w.text).join(' ');
        b.x0 = w1.bbox.x0;
      }
    }
    const text = cleanText(raw);
    if (!text) continue;
    const cy = (b.y0 + b.y1) / 2;
    if (cy < H * 0.09 || cy > H * 0.92) continue;            // status bar / header / input bar
    if (isNoise(text)) continue;
    const leftGap = b.x0 / W, rightGap = (W - b.x1) / W;
    keep.push({ text, y0: b.y0, y1: b.y1, h: b.y1 - b.y0, who: rightGap < leftGap ? 'me' : 'them' });
  }
  keep.sort((a, b) => a.y0 - b.y0);
  if (!keep.length) return [];
  const avgH = keep.reduce((s, l) => s + l.h, 0) / keep.length;
  const msgs = [];
  let cur = null;
  for (const l of keep) {
    const gap = cur ? l.y0 - cur.y1 : Infinity;
    if (cur && l.who === cur.who && gap < avgH * 0.9) { cur.text += ' ' + l.text; cur.y1 = l.y1; }
    else { cur = { who: l.who, text: l.text, y1: l.y1 }; msgs.push(cur); }
  }
  return msgs.map(m => ({ who: m.who, text: m.text }));
}

// Combines lines read from the normal and the color-flipped image: where two readings
// cover the same spot, keep the more confident one.
function mergePasses(a, b) {
  const all = [...a, ...b].filter(l => l && l.bbox && String(l.text || '').trim())
    .sort((x, y) => (y.confidence || 0) - (x.confidence || 0));
  const kept = [];
  const overlap = (p, q) => {
    const ix = Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0));
    const iy = Math.max(0, Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0));
    const ar = Math.min((p.x1 - p.x0) * (p.y1 - p.y0), (q.x1 - q.x0) * (q.y1 - q.y0)) || 1;
    return (ix * iy) / ar;
  };
  for (const l of all) if (!kept.some(k => overlap(k.bbox, l.bbox) > 0.3)) kept.push(l);
  return kept;
}

// Joins messages from several screenshots, skipping repeats where screenshots overlap.
function mergeMessages(batches) {
  const out = [];
  for (const batch of batches) {
    let start = 0;
    // find the longest overlap between the end of out and the start of this batch
    for (let k = Math.min(out.length, batch.length); k > 0; k--) {
      let same = true;
      for (let i = 0; i < k; i++) {
        const a = out[out.length - k + i], b = batch[i];
        if (a.who !== b.who || a.text.toLowerCase() !== b.text.toLowerCase()) { same = false; break; }
      }
      if (same) { start = k; break; }
    }
    out.push(...batch.slice(start));
  }
  return out;
}

function formatMessages(msgs, meName, themName) {
  return msgs.map(m => `${m.who === 'me' ? meName : themName}: ${m.text}`).join('\n');
}

// ---- browser-only helpers ----
let workerPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = TESSERACT_SRC; s.async = true;
    s.onload = () => res(window.Tesseract); s.onerror = () => rej(new Error('Could not load the text reader'));
    document.head.append(s);
  });
}
async function getWorker() {
  if (!workerPromise) workerPromise = loadTesseract().then(T => T.createWorker('eng'));
  return workerPromise;
}

// Makes two black-on-white versions of the screenshot: one that keeps bright text
// (dark mode, and your own messages on colored bubbles) and one that keeps dark text
// (light mode). Each is read separately and the results are combined.
async function prepareImages(file) {
  const bmp = await createImageBitmap(file);
  const scale = bmp.width < 1000 ? 2 : 1;
  const w = bmp.width * scale, h = bmp.height * scale;
  const src = document.createElement('canvas'); src.width = w; src.height = h;
  const sctx = src.getContext('2d'); sctx.drawImage(bmp, 0, 0, w, h);
  const base = sctx.getImageData(0, 0, w, h).data;
  const make = (test) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); const img = ctx.createImageData(w, h); const d = img.data;
    for (let i = 0; i < base.length; i += 4) {
      const g = 0.299 * base[i] + 0.587 * base[i + 1] + 0.114 * base[i + 2];
      const v = test(g) ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0); return c;
  };
  return { bright: make(g => g > 185), dark: make(g => g < 80), width: w, height: h };
}

async function readScreenshot(file) {
  const worker = await getWorker();
  const im = await prepareImages(file);
  const a = (await worker.recognize(im.bright)).data.lines || [];
  const b = (await worker.recognize(im.dark)).data.lines || [];
  return parseOcrLines(mergePasses(a, b), im.width, im.height);
}

if (typeof module !== 'undefined') module.exports = { parseOcrLines, mergePasses, mergeMessages, formatMessages, cleanText, isNoise };

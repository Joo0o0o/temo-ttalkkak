// Two iBalance UI versions exist in clinics (2026-11-16):
//  - "new": the result page opens from `#/measurement-result?memberId=…` and is driven by report-src.js
//    (generated from the downloader engine; not edited here).
//  - "old": the result page ignores the address. The user picks 측정결과 → patient → date row → 리포트 and the
//    page shows a 종합 리포트 modal with 프린트/PACS/알림톡/닫기 buttons. Confirmed on a test install.
// The version is decided once per run from the public main bundle (detectUiVersion). The old flow below uses
// the page's own handlers and data (React props), not minified component names, so other old builds still work.
// The report body (print iframe capture, `.sc-1ovj0ov-*`, print icon mask) is shared by both versions.
import {installCapture} from './report-src.js';

const FETCH_TIMEOUT_MS = 15000;

/** Decide the UI version from the clinic's public main bundle. Never sends credentials. */
export async function detectUiVersion(frontend) {
  const get = async url => {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, {cache: 'no-store', credentials: 'omit', signal: ctl.signal});
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } finally { clearTimeout(timer); }
  };
  try {
    const front = new URL(frontend), html = await get(front.href);
    const src = html.match(/<script[^>]+src="([^"]*\/static\/js\/main\.[0-9a-f]+\.js)"/)?.[1];
    if (!src) return {ui: 'unknown', bundle: null};
    const url = new URL(src, front.href);
    if (url.origin !== front.origin) return {ui: 'unknown', bundle: null};
    const bundle = url.pathname.split('/').pop(), js = await get(url.href), has = t => js.includes(t);
    if (has('measure-insight-view') && has('openReportModal')) return {ui: 'new', bundle};
    if (!has('measure-insight-view') && has('selectMemberId') && has('isSelectedInPage') && has('onReportClose')) return {ui: 'old', bundle};
    return {ui: 'unknown', bundle};
  } catch { return {ui: 'unknown', bundle: null}; }
}

// ---- page-side code (serialised with toString; must stay self-contained) ----

// Drives the old result page one step per call; returns true once the 종합 리포트 modal shows the wanted exam.
function legacySelectExam(monthly) {
  const wanted = monthly.measurementId, member = monthly.memberId, now = performance.now();
  const st = window.__ibLegacy || (window.__ibLegacy = {tab: 0, tabAt: 0, patient: 0, patientAt: 0, type: 0, typeAt: 0, page: 0, pageAt: 0, pageSize: 0, open: 0, openAt: 0});
  const at = step => { st.step = step; return false; };
  if (document.querySelector('input[type="password"]')) return at('login');
  const visible = e => e.getClientRects().length > 0;
  const leaves = text => [...document.querySelectorAll('body *')].filter(e => visible(e) && [...e.childNodes].some(c => c.nodeType === 3 && c.textContent.trim() === text));
  const clickable = e => { for (let el = e, i = 0; el && i < 6; el = el.parentElement, i++) { const k = Object.keys(el).find(k => k.startsWith('__reactProps$')); if (k && typeof el[k]?.onClick === 'function') return el; } return null; };
  if (!/^#\/measurement-result(?:$|[?/])/.test(location.hash)) {
    if (st.tab < 20 && now - st.tabAt > 1000) { const t = leaves('측정결과')[0]; const c = t && clickable(t); if (c) { c.click(); st.tab++; st.tabAt = now; } }
    return at('tab');
  }
  const fiberOf = n => { const k = Object.keys(n).find(k => k.startsWith('__reactFiber$')); return k ? n[k] : null; };
  const p = f => f.memoizedProps || {};
  const fibers = new Set();
  for (const n of document.querySelectorAll('body *')) for (let f = fiberOf(n), i = 0; f && i < 32 && !fibers.has(f); i++, f = f.return) fibers.add(f);
  const list = [...fibers];
  // The 종합 리포트 modal for the wanted exam is open: done.
  const modals = list.filter(f => typeof p(f).onReportClose === 'function' && p(f).selectedMeasurement && typeof p(f).selectedMeasurement === 'object');
  if (modals.length) return modals.every(f => p(f).selectedMeasurement.id === wanted) || at('modal-other-exam');
  // 1) patient, through the page's own selectMemberId (works even if the patient list could not load).
  const holders = list.filter(f => typeof p(f).selectMemberId === 'function');
  if (!holders.length) return at('patient-holder');
  if (!holders.some(f => p(f).selectedMemberId === member)) {
    if (st.patient < 5 && now - st.patientAt > 2000) { p(holders[0]).selectMemberId(member); st.patient++; st.patientAt = now; }
    return at('patient');
  }
  // 2) measurement kind MOIRE. The kind box can already read 신체 측정(MOIRE) while the tables still hold another
  //    kind's rows (test install: 14 rows without the exam until MOIRE was picked), so pick MOIRE explicitly once
  //    after the patient is set, and again (max 3) if the exam still is not in any table.
  const kind = list.find(f => { const q = p(f); return Array.isArray(q.items) && typeof q.onItemChange === 'function' && typeof q.itemToValue === 'function' && q.items.some(x => String(q.itemToValue(x)) === 'MOIRE'); });
  const inTables = list.some(f => Array.isArray(p(f).data) && typeof p(f).onSelectMeasurement === 'function' && p(f).data.some(x => x?.id === wanted));
  if (kind && (st.type === 0 || (!inTables && st.type < 3 && now - st.typeAt > 4000))) {
    const q = p(kind); q.onItemChange(q.items.find(x => String(q.itemToValue(x)) === 'MOIRE')); st.type++; st.typeAt = now;
    return at('kind');
  }
  if (!inTables && now - st.typeAt < 4000) return at('kind-loading');
  // 3) the date row of the wanted exam: React key and row data are the measurement id.
  const row = list.find(f => f.key === wanted && typeof p(f).onOpenReport === 'function' && p(f).data?.id === wanted);
  if (row) {
    const rows = new Set([row, row.alternate].filter(Boolean));
    const buttons = leaves('리포트').filter(e => { for (let f = fiberOf(e), i = 0; f && i < 20; i++, f = f.return) if (rows.has(f)) return true; return false; });
    if (buttons.length !== 1) return at('row-buttons-' + Math.min(buttons.length, 9));
    const c = clickable(buttons[0]);
    if (c && st.open < 3 && now - st.openAt > 3000) { c.click(); st.open++; st.openAt = now; }
    return at(c ? 'report-open' : 'report-not-clickable');
  }
  // 4) not on this page: go to the page that holds it (pagination numbers under that table).
  // The page has one table per body part (정면/측면 posture, 후면 MOIRE…); use the table of the part that holds it.
  const all = list.find(f => Array.isArray(p(f).data) && typeof p(f).onSelectMeasurement === 'function' && typeof p(f).isSelectedInPage !== 'boolean' && p(f).data.some(x => x?.id === wanted));
  if (!all) return at('table-missing');
  const paged = list.find(f => Array.isArray(p(f).data) && typeof p(f).isSelectedInPage === 'boolean' && p(f).part === p(all).part && p(f).data.length);
  if (!paged) return at('page-table-missing');
  const data = p(all).data, idx = data.findIndex(x => x?.id === wanted), first = data.findIndex(x => x?.id === p(paged).data[0]?.id);
  if (idx < 0 || first < 0) return at('page-index');
  st.pageSize = Math.max(st.pageSize, p(paged).data.length);
  const current = Math.floor(first / st.pageSize) + 1, target = Math.floor(idx / st.pageSize) + 1;
  if (current === target || st.page >= 60 || now - st.pageAt < 800) return at(current === target ? 'page-rendering' : 'page-wait');
  // The table's own pagination: numbers 1..5 at a time plus ‹ › that move to the previous/next group of 5
  // (a short window shows 2 rows per page → 7 pages, so page 7 is behind ›). Use its handlers: a number calls
  // onChangePage(n), › calls onChangeNextPageRange().
  const pager = list.find(f => {
    const q = p(f);
    if (typeof q.onChangePage !== 'function' || !q.pageRange || typeof q.pageRange.start !== 'number' || typeof q.pageRange.end !== 'number') return false;
    for (let x = f.return, i = 0; x && i < 16; x = x.return, i++) if (x === all || x === all.alternate) return true;
    return false;
  });
  if (pager) {
    const q = p(pager), r = q.pageRange;
    if (target >= r.start && target <= r.end) q.onChangePage(target);
    else if (target > r.end && q.hasNextPageRange && typeof q.onChangeNextPageRange === 'function') q.onChangeNextPageRange();
    else if (target < r.start && q.hasPrevPageRange && typeof q.onChangePrevPageRange === 'function') q.onChangePrevPageRange();
    else return at('page-out-of-range');
    st.page++; st.pageAt = now;
    return at('page-change');
  }
  // Fallback without that component: click the number under the table.
  // DOM of that paged table (first host element under its fiber), then the box that also holds its pagination.
  let host = null;
  for (const queue = [paged.child]; queue.length && !host;) { const x = queue.shift(); if (!x) continue; if (x.stateNode instanceof Element) host = x.stateNode; else queue.push(x.child, x.sibling); }
  if (!host) return at('page-host');
  let digits = [];
  for (let box = host, i = 0; box && i < 4 && !digits.length; box = box.parentElement, i++) {
    const reportLeaves = leaves('리포트').filter(e => box.contains(e));
    if (!reportLeaves.length) continue;
    const bottom = Math.max(...reportLeaves.map(e => e.getBoundingClientRect().bottom));
    digits = [...box.querySelectorAll('*')].filter(e => visible(e) && !e.children.length && /^\d+$/.test(e.textContent.trim()) && e.getBoundingClientRect().top >= bottom);
  }
  const num = e => Number(e.textContent.trim());
  const pick = digits.find(e => num(e) === target)
    || digits.filter(e => (target > current ? num(e) > current && num(e) < target : num(e) < current && num(e) > target)).sort((a, b) => target > current ? num(b) - num(a) : num(a) - num(b))[0];
  const c = pick && clickable(pick);
  if (c) { c.click(); st.page++; st.pageAt = now; }
  return at(c ? 'page-click' : 'page-number-missing');
}

// Provenance of the open report: every report part must point at the wanted exam and patient.
function legacyVerifyExam(monthly, doc) {
  const roots = [...doc.querySelectorAll('.sc-1ovj0ov-0')];
  if (roots.length !== 1) return false;
  const root = roots[0], nodes = [root, ...root.querySelectorAll('*')];
  if (nodes.length > 12000) return false;
  const fiberOf = n => { const k = Object.keys(n).find(k => k.startsWith('__reactFiber$')); return k ? n[k] : null; };
  let data = 0, patient = 0, modal = 0;
  const seen = new Set();
  for (const n of nodes) for (let f = fiberOf(n), i = 0; f && i < 48 && !seen.has(f); i++, f = f.return) {
    seen.add(f);
    const q = f.memoizedProps || {};
    if (typeof q.onAfterPrint === 'function' && q.data && typeof q.data === 'object' && !Array.isArray(q.data)) { if (q.data.id !== monthly.measurementId) return false; data++; }
    if (typeof q.onAfterPrint === 'function' && q.patient && typeof q.patient === 'object') { if (q.patient.id !== monthly.memberId) return false; patient++; }
  }
  // The modal component sits far above the report body; find it from the whole page.
  const seenModal = new Set();
  for (const n of doc.querySelectorAll('body *')) for (let f = fiberOf(n), i = 0; f && i < 4 && !seenModal.has(f); i++, f = f.return) {
    seenModal.add(f);
    const q = f.memoizedProps || {};
    if (typeof q.onReportClose === 'function' && q.selectedMeasurement && typeof q.selectedMeasurement === 'object') { if (q.selectedMeasurement.id !== monthly.measurementId) return false; modal++; }
  }
  return data > 0 && patient > 0 && modal > 0;
}

// ---- expressions used by report.js ----

export function legacySelectExpression(cfg) {
  return '(' + legacySelectExam.toString() + ')(' + JSON.stringify(cfg.monthly) + ')';
}
export function legacyProvenanceExpression(cfg) {
  return '(' + legacyVerifyExam.toString() + ')(' + JSON.stringify(cfg.monthly) + ',document)';
}
/** Address of the old result page once 측정결과 is open (the old page drops the query string). */
export function legacyResultHref(cfg) { return cfg.frontend + '#/measurement-result'; }
/** Same capture hook as the new UI, with the old-UI provenance check run at print time. */
export function legacyCaptureHook(cfg) {
  return '(' + installCapture.toString() + ')(' + JSON.stringify(cfg.frontend) + ',' + JSON.stringify(cfg.tokens) + ',' + JSON.stringify(cfg.target) + ','
    + JSON.stringify(cfg.monthly || null) + ',' + legacyVerifyExam.toString() + ');';
}
/** Click the single 프린트 icon of the shared report header (never PACS/알림톡) once the report is ready. */
export function legacyPrintExpression() {
  return `(()=>{
  const root=document.querySelector('.sc-1ovj0ov-0');
  if(!root||!root.querySelectorAll('.sc-1ovj0ov-1').length||document.fonts?.status==='loading'||[...root.querySelectorAll('img')].some(i=>!i.complete||!i.naturalWidth)||[...root.querySelectorAll('canvas')].some(c=>!c.width||!c.height))return false;
  const icons=[...document.querySelectorAll('svg')].filter(s=>s.querySelector('mask[id="path-3-inside-1_913:1040"]'));if(!icons.length)return false;if(icons.length!==1)throw Error();
  icons[0].dispatchEvent(new MouseEvent('click',{bubbles:true}));if(window.__ibReport)window.__ibReport.printClicks=(window.__ibReport.printClicks|0)+1;return true;
 })()`;
}

export {legacySelectExam, legacyVerifyExam};

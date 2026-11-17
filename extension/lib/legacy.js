// Two iBalance UI versions exist in clinics (2026-11-16):
//  - "new": the result page opens from `#/measurement-result?memberId=…`; its selection is report-src.js
//    (generated from the downloader engine) made build-independent in anybuild.js.
//  - "old": the result page ignores the address. The user picks 측정결과 → patient → date row → 리포트 and the
//    page shows a 종합 리포트 modal with 프린트/PACS/알림톡/닫기 buttons. Confirmed on a test install.
// The version is decided once per run from the public main bundle (detectUiVersion). The old flow below uses
// the page's own handlers and data (React props), not minified component names, so other old builds still work.
// The report body (print iframe capture, report root, print icon) is shared by both versions (anybuild.js).
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
    // Old builds differ too (d4a11e22 had `isSelectedInPage`, 2e4729dd does not): only markers both share.
    if (!has('measure-insight-view') && has('selectMemberId') && has('onReportClose')) return {ui: 'old', bundle};
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
  // Tables are told apart by their data, not by props that come and go with the page state (`isSelectedInPage`,
  // `pageWithSelectedRow` exist only once a row is selected): the full table is the largest one holding the exam,
  // the paged table is a smaller one of the same part whose rows all come from the full table.
  const tables = list.filter(f => Array.isArray(p(f).data) && typeof p(f).onSelectMeasurement === 'function');
  const all = tables.filter(f => p(f).data.some(x => x?.id === wanted)).sort((a, b) => p(b).data.length - p(a).data.length)[0];
  if (!all) return at('table-missing');
  const ids = new Set(p(all).data.map(x => x?.id));
  const paged = tables.filter(f => p(f).part === p(all).part && p(f).data.length && p(f).data.length < p(all).data.length && p(f).data.every(x => ids.has(x?.id)))
    .sort((a, b) => p(a).data.length - p(b).data.length)[0];
  if (!paged) return at('page-table-missing');
  const data = p(all).data, rows = p(paged).data, idx = data.findIndex(x => x?.id === wanted), first = data.findIndex(x => x?.id === rows[0]?.id);
  if (idx < 0 || first < 0) return at('page-index');
  st.pageSize = Math.max(st.pageSize, rows.length);
  // Page shows the full list in its own order only if its rows are a contiguous slice of it. Before any row is
  // selected the table can sort the page differently; then the page number of the exam cannot be computed.
  if (st.page >= 120 || now - st.pageAt < 600) return at('page-wait');
  // The table's own pagination: numbers 1..5 at a time plus ‹ › that move to the previous/next group of 5
  // (a short window shows 1-2 rows per page → many pages). Use its handlers: a number calls onChangePage(n),
  // › calls onChangeNextPageRange() (which also opens the first page of the next group).
  const pager = list.find(f => {
    const q = p(f);
    if (typeof q.onChangePage !== 'function' || !q.pageRange || typeof q.pageRange.start !== 'number' || typeof q.pageRange.end !== 'number') return false;
    for (let x = f.return, i = 0; x && i < 16; x = x.return, i++) if (x === all || x === all.alternate) return true;
    return false;
  });
  const current = pager && typeof p(pager).currentPage === 'number' ? p(pager).currentPage : Math.floor(first / st.pageSize) + 1;
  // Same order only if the visible rows are exactly the slice the current page number points at (one row per
  // page always looks contiguous, so the page number must agree too).
  const sameOrder = !st.walk && first === (current - 1) * st.pageSize && rows.every((x, i) => data[first + i]?.id === x?.id);
  // Known order: jump to the computed page. Unknown order: walk the pages one by one from page 1 (the row check
  // above stops the walk on the page that shows the exam).
  let target;
  if (sameOrder) target = Math.floor(idx / st.pageSize) + 1;
  else if (!st.walk) { st.walk = true; target = 1; }
  else target = current + 1;
  if (target === current) {
    // On the computed page but the exam row is still missing after 2.5 s: stop trusting the order and walk.
    if (!st.renderAt) st.renderAt = now;
    if (now - st.renderAt > 2500) { st.walk = true; st.renderAt = 0; }
    return at('page-rendering');
  }
  st.renderAt = 0;
  if (pager) {
    const q = p(pager), r = q.pageRange;
    if (target >= r.start && target <= r.end) q.onChangePage(target);
    else if (target > r.end && q.hasNextPageRange && typeof q.onChangeNextPageRange === 'function') q.onChangeNextPageRange();
    else if (target < r.start && q.hasPrevPageRange && typeof q.onChangePrevPageRange === 'function') q.onChangePrevPageRange();
    else return at(sameOrder ? 'page-out-of-range' : 'page-walk-end');
    st.page++; st.pageAt = now;
    return at(sameOrder ? 'page-change' : 'page-walk');
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

// ---- expressions used by report.js ----

export function legacySelectExpression(cfg) {
  return '(' + legacySelectExam.toString() + ')(' + JSON.stringify(cfg.monthly) + ')';
}
/** Address of the old result page once 측정결과 is open (the old page drops the query string). */
export function legacyResultHref(cfg) { return cfg.frontend + '#/measurement-result'; }
// Provenance, capture hook and print click are shared with the new UI: see anybuild.js.

export {legacySelectExam};

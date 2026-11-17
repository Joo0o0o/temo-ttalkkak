// Build-independent report driving for BOTH iBalance UI versions (2026-11-16).
// report-src.js (generated from the downloader engine, not edited here) finds the result page parts by the
// minified component names of ONE build (QEe, mTe/dTe, ZV, kj) and style hashes (.sc-jklfo3-0). A clinic on
// another new-UI build (main.db382de5.js) stopped with SELECTION_FAILED. The functions below key on the parts'
// own props instead, which the new builds (fce101b8, 85292965) and the old one (d4a11e22) share:
//   report body {data: exam, onAfterPrint} · patient part {patient, …, onAfterPrint} · owner part {owner: {memberId, measurementId}}
//   report modal {selectedMeasurement, onReportClose} · print icon: the one svg with mask#path-3-inside-1_913:1040
import {installCapture, monthlySelectionTree, selectMonthlyExam} from './report-src.js';

// Same generated selection code, minus the build-specific component-name tests. Fails loudly if the generated
// source changes so a silent mismatch cannot ship.
const patch = (src, from, to) => {
  if (!src.includes(from)) throw new Error('anybuild: generated code changed, missing ' + from);
  return src.split(from).join(to);
};
const TREE = patch(monthlySelectionTree.toString(), "name(f)==='QEe'&&", '');
const SELECT = patch(selectMonthlyExam.toString(), "['mTe','dTe'].includes(name(f))&&", '');

/** New UI: select the exam on `#/measurement-result?memberId=…` and open its report (any build). */
export function newSelectExpression(cfg) {
  return '(' + SELECT + ')(' + JSON.stringify(cfg.monthly) + ',' + JSON.stringify(cfg.target) + ',' + TREE + ')';
}

// Provenance of the open report (both versions): every report part must point at the wanted exam and patient.
function verifyOpenReport(monthly, doc) {
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
    if (q.owner && typeof q.owner === 'object' && ('memberId' in q.owner || 'measurementId' in q.owner)) {
      if (q.owner.memberId !== monthly.memberId || q.owner.measurementId !== monthly.measurementId) return false;
    }
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

export function provenanceExpression(cfg) {
  return '(' + verifyOpenReport.toString() + ')(' + JSON.stringify(cfg.monthly) + ',document)';
}

/** Capture hook for both versions. Before the page starts it drops the page's remembered patient/exam
 *  (`member`, `measureId`): a clinic build reloaded the previous report's patient and its `member` read for that
 *  other patient stopped every later report (ORIGIN_BLOCKED, 2026-11-16 log #2–#6). */
export function captureHook(cfg) {
  const origin = new URL(cfg.frontend).origin;
  return `(()=>{try{if(location.origin===${JSON.stringify(origin)}){localStorage.removeItem('member');localStorage.removeItem('measureId');}}catch{}})();`
    + '(' + installCapture.toString() + ')(' + JSON.stringify(cfg.frontend) + ',' + JSON.stringify(cfg.tokens) + ',' + JSON.stringify(cfg.target) + ','
    + JSON.stringify(cfg.monthly || null) + ',' + verifyOpenReport.toString() + ');';
}

/** Click the single 프린트 icon of the shared report header (never PACS/알림톡) once the report is ready. */
export function printExpression() {
  return `(()=>{
  const root=document.querySelector('.sc-1ovj0ov-0');
  if(!root||!root.querySelectorAll('.sc-1ovj0ov-1').length||document.fonts?.status==='loading'||[...root.querySelectorAll('img')].some(i=>!i.complete||!i.naturalWidth)||[...root.querySelectorAll('canvas')].some(c=>!c.width||!c.height))return false;
  const icons=[...document.querySelectorAll('svg')].filter(s=>s.querySelector('mask[id="path-3-inside-1_913:1040"]'));if(!icons.length)return false;if(icons.length!==1)throw Error();
  icons[0].dispatchEvent(new MouseEvent('click',{bubbles:true}));if(window.__ibReport)window.__ibReport.printClicks=(window.__ibReport.printClicks|0)+1;return true;
 })()`;
}

export {verifyOpenReport};

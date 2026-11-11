import {Client, SourceError, TOKEN_KEY, TIMEZONE, catalogue, endpoints, monthRange, namesafe, originPatterns, parseTokens} from './lib/source.js';
import {renderReport} from './lib/report.js';
import {ZipWriter} from './lib/zip.js';

const MESSAGES = {
  URL_INVALID: '아이밸런스 주소를 확인해 주세요.',
  TIMEZONE_MISMATCH: '이 컴퓨터의 시간대가 한국 표준시가 아닙니다. 리포트 날짜가 달라질 수 있어 시작하지 않았습니다. 시간대를 서울로 바꾼 뒤 다시 시작해 주세요.',
  MONTH_INVALID: '연도와 월을 확인해 주세요.',
  PERMISSION_DENIED: '이 주소에 접근할 권한이 허용되지 않았습니다. 시작을 다시 누르고 “허용”을 선택해 주세요.',
  LOGIN_REQUIRED: '이 크롬에서 아이밸런스 로그인 상태를 찾지 못했습니다. 열린 아이밸런스 탭에서 로그인한 뒤 다시 시작해 주세요.',
  AUTH_ENDED: '아이밸런스 로그인이 끝났습니다. 아이밸런스에 다시 로그인한 뒤 “실패한 검사만 다시 시도”를 눌러 주세요.',
  NETWORK_FAILED: '아이밸런스 서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.',
  SOURCE_FAILED: '아이밸런스 서버가 요청을 처리하지 못했습니다.',
  SOURCE_INVALID: '아이밸런스 응답 형식을 확인할 수 없습니다.',
  QUERY_BLOCKED: '허용되지 않은 조회입니다.',
  STOPPED: '사용자가 중지했습니다.',
  REPORT_TIMEOUT: '제한 시간 안에 리포트를 만들지 못했습니다.',
  CDP_TIMEOUT: '제한 시간 안에 리포트를 만들지 못했습니다.',
  PRINT_NOT_CALLED: '공식 인쇄가 시작되지 않았습니다(3회 시도).',
  PRINT_NOT_FOUND: '리포트 인쇄 버튼을 찾지 못했습니다.',
  SELECTION_FAILED: '해당 검사를 화면에서 선택하지 못했습니다.',
  PROVENANCE_FAILED: '화면의 검사와 환자가 일치하는지 확인하지 못했습니다.',
  CAPTURE_FAILED: '인쇄 화면을 가져오지 못했습니다.',
  RESOURCE_FAILED: '리포트 이미지·글꼴을 불러오지 못했습니다.',
  ORIGIN_BLOCKED: '허용되지 않은 요청이 감지되어 중단했습니다.',
  NAVIGATION_FAILED: '리포트 화면을 열지 못했습니다.',
  PDF_INVALID: '올바른 PDF가 만들어지지 않았습니다.',
  OUTPUT_TOO_LARGE: 'PDF가 너무 큽니다(32MB 초과).',
  BROWSER_EXITED: '작업 탭이 닫혔습니다.',
  DEBUGGER_BLOCKED: '작업 탭을 제어하지 못했습니다. 개발자 도구가 열려 있으면 닫아 주세요.',
  CDP_ERROR: '작업 탭 제어 중 오류가 발생했습니다.',
  REPORT_FAILED: 'PDF를 만들지 못했습니다.',
  MEMBER_INVALID: '환자 정보를 확인할 수 없습니다.',
  MEASUREMENTS_UNAVAILABLE: '검사 목록을 확인할 수 없습니다.',
  MEASUREMENT_INVALID: '검사 정보를 확인할 수 없습니다.',
  MEASUREMENT_ID_INVALID: '검사 식별자를 확인할 수 없습니다.',
  MEASUREMENT_DATE_INVALID: '검사 날짜를 확인할 수 없습니다.',
  MEASUREMENT_CONFIG_INVALID: '검사 종류를 확인할 수 없습니다.',
};
const msg = code => MESSAGES[code] || MESSAGES.REPORT_FAILED;
const $ = id => document.getElementById(id);
const job = globalThis.__moireJob = {running: false, stop: false, outcomes: [], issues: [], month: null, scope: null, zipUrl: null, members: 0, scanned: 0, log: [], round: 0};
const REPORT_MIN_FAILED = 3;
const REPORT_CHAT = 'https://open.kakao.com/o/sqqaBBWi';
const logEvent = (type, data = {}) => job.log.push({t: new Date().toISOString(), round: job.round, type, ...data});

function init() {
  const now = new Date(), y = now.getFullYear(), prev = new Date(y, now.getMonth() - 1, 1);
  for (let v = y; v >= 2018; v--) $('year').add(new Option(v + '년', v));
  for (let m = 1; m <= 12; m++) $('month').add(new Option(m + '월', m));
  $('year').value = prev.getFullYear(); $('month').value = prev.getMonth() + 1;
  chrome.storage.local.get('address').then(v => { if (v.address) $('address').value = v.address; });
  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', () => { job.stop = true; say('현재 검사를 마치면 중지합니다.'); });
  $('retry').addEventListener('click', retry);
  $('download').addEventListener('click', () => save(false));
  $('report').addEventListener('click', () => saveErrorLog().catch(() => say('오류 기록 파일을 저장하지 못했습니다.', true)));
}

function say(text, error = false) { const m = $('message'); m.hidden = !text; m.textContent = text || ''; m.classList.toggle('error', error); }
function busy(on) {
  job.running = on;
  for (const id of ['start', 'address', 'year', 'month']) $(id).disabled = on;
  $('stop').hidden = !on; $('retry').disabled = on; $('download').disabled = on; $('report').disabled = on;
}

function render(stageText = '') {
  const done = job.outcomes.filter(o => o.status === 'success').length;
  const failed = job.outcomes.filter(o => o.status === 'failed').length;
  const total = job.outcomes.length;
  $('progress').hidden = !job.members && !total;
  if ($('progress').hidden) return;
  const scan = job.members ? `환자 확인 ${job.scanned}/${job.members}명 · ` : '';
  $('summary').textContent = `${job.month} · ${scan}대상 검사 ${total}건 · 성공 ${done}건 · 실패 ${failed}건${stageText ? ' · ' + stageText : ''}`;
  $('bar').style.width = total ? `${Math.round(100 * (done + failed) / total)}%` : (job.members ? `${Math.round(100 * job.scanned / job.members)}%` : '0');
  const body = $('rows'); body.textContent = '';
  job.outcomes.forEach((o, i) => {
    const tr = body.insertRow();
    tr.insertCell().textContent = i + 1;
    tr.insertCell().textContent = o.row.name;
    tr.insertCell().textContent = o.row.date;
    const c = tr.insertCell(); c.className = 's-' + o.status;
    c.textContent = o.status === 'success' ? '완료' : o.status === 'failed' ? '실패 · ' + msg(o.code) : o.status === 'running' ? '만드는 중…' : '대기';
  });
  $('issues-box').hidden = !job.issues.length;
  $('issue-count').textContent = `(${job.issues.length}건)`;
  const ul = $('issues'); ul.textContent = '';
  for (const i of job.issues) { const li = document.createElement('li'); li.textContent = `${i.name} · ${i.date} · ${msg(i.code)}`; ul.append(li); }
  const hasFailed = failed > 0;
  $('retry').hidden = !hasFailed || job.running;
  $('download').hidden = !done || job.running;
  // Only offer the error-log file once 3+ reports failed; fewer failures are usually transient and retry fixes them.
  const showReport = failed >= REPORT_MIN_FAILED && !job.running;
  $('report').hidden = !showReport; $('report-help').hidden = !showReport;
}

async function readTokens(ep) {
  const tabs = (await chrome.tabs.query({})).filter(t => { try { return new URL(t.url).origin === ep.origin; } catch { return false; } });
  for (const tab of tabs) {
    try {
      const [r] = await chrome.scripting.executeScript({target: {tabId: tab.id}, func: key => localStorage.getItem(key), args: [TOKEN_KEY]});
      const tokens = parseTokens(r?.result);
      if (tokens) return tokens;
    } catch {}
  }
  if (!tabs.length) await chrome.tabs.create({url: ep.frontend, active: true});
  throw new SourceError('LOGIN_REQUIRED');
}

async function start() {
  let ep, year = Number($('year').value), month = Number($('month').value);
  if (Intl.DateTimeFormat().resolvedOptions().timeZone !== TIMEZONE) { say(msg('TIMEZONE_MISMATCH'), true); return; }
  try { ep = endpoints($('address').value); monthRange(year, month); }
  catch (e) { say(msg(e.code), true); return; }
  // Must be the first await: Chrome only grants host access inside the click gesture.
  const granted = await chrome.permissions.request({origins: originPatterns(ep.frontend)}).catch(() => false);
  if (!granted) { say(msg('PERMISSION_DENIED'), true); return; }
  await chrome.storage.local.set({address: ep.frontend});
  $('address').value = ep.frontend;
  Object.assign(job, {stop: false, outcomes: [], issues: [], members: 0, scanned: 0, ep, log: [], round: 1,
    month: `${year}-${String(month).padStart(2, '0')}`, scope: monthRange(year, month)});
  logEvent('start', {month: job.month});
  if (job.zipUrl) { URL.revokeObjectURL(job.zipUrl); job.zipUrl = null; }
  $('saved').hidden = true;
  busy(true); say('');
  try {
    const client = new Client(ep.frontend, await readTokens(ep));
    await client.me();
    render('환자 목록 확인 중');
    const members = await client.members();
    job.members = members.length;
    const rows = [];
    for (const m of members) {
      if (job.stop) throw new SourceError('STOPPED');
      if (!m || typeof m.id !== 'string') { job.issues.push({name: '미상', date: '미상', code: 'MEMBER_INVALID'}); job.scanned++; continue; }
      const member = await client.member(m.id);
      const r = catalogue(member, job.scope);
      rows.push(...r.rows); job.issues.push(...r.issues); job.scanned++;
      render('환자 확인 중');
    }
    rows.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name, 'ko'));
    logEvent('catalogue', {members: job.members, reports: rows.length, issues: job.issues.map(i => i.code)});
    job.outcomes = rows.map(row => ({row, status: 'pending', code: null}));
    client.tokens = null;
    await runReports(ep);
  } catch (e) {
    logEvent('aborted', {code: e.code || 'REPORT_FAILED', detail: e.code ? undefined : String(e?.message || e).slice(0, 200)});
    say(msg(e.code || 'REPORT_FAILED'), true);
  } finally { busy(false); render(); }
}

async function retry() {
  if (job.running) return;
  const granted = await chrome.permissions.request({origins: originPatterns(job.ep.frontend)}).catch(() => false);
  if (!granted) { say(msg('PERMISSION_DENIED'), true); return; }
  for (const o of job.outcomes) if (o.status === 'failed') Object.assign(o, {status: 'pending', code: null});
  job.stop = false; job.round++; busy(true); say('');
  logEvent('retry', {reports: job.outcomes.filter(o => o.status === 'pending').length});
  try { await runReports(job.ep); }
  catch (e) {
    logEvent('aborted', {code: e.code || 'REPORT_FAILED', detail: e.code ? undefined : String(e?.message || e).slice(0, 200)});
    say(msg(e.code || 'REPORT_FAILED'), true);
  }
  finally { busy(false); render(); }
}

async function runReports(ep) {
  const todo = job.outcomes.filter(o => o.status === 'pending');
  if (!job.outcomes.length) { render(); say('선택한 달에 모아레 검사가 없습니다.'); return; }
  const tokens = await readTokens(ep);
  await new Client(ep.frontend, tokens).me();
  const win = await chrome.windows.create({url: 'about:blank', focused: false, width: 1280, height: 900, type: 'normal'});
  const blank = win.tabs?.[0]?.id;
  try {
    for (const o of todo) {
      if (job.stop) break;
      o.status = 'running'; render(`${o.row.name} 리포트 만드는 중`);
      const cfg = {
        frontend: ep.frontend, api: ep.api,
        target: ep.frontend + '#/measurement-result?memberId=' + o.row.memberId + '&measurementType=MOIRE',
        tokens: {...tokens},
        monthly: {memberId: o.row.memberId, measurementId: o.row.measurementId, measurementType: 'MOIRE', timezone: TIMEZONE},
      };
      try {
        const {bytes, facts} = await renderReport(cfg, {windowId: win.id});
        Object.assign(o, {status: 'success', code: null, pdf: bytes, facts});
        logEvent('success', {no: job.outcomes.indexOf(o) + 1, facts});
      } catch (e) {
        Object.assign(o, {status: 'failed', code: e.code || 'REPORT_FAILED', facts: e.facts});
        logEvent('failed', {no: job.outcomes.indexOf(o) + 1, code: o.code, facts: e.facts});
        if (e.code === 'AUTH_ENDED') { job.stop = true; say(msg('AUTH_ENDED'), true); }
      }
      render();
    }
  } finally {
    try { await chrome.windows.remove(win.id); } catch {}
    void blank;
  }
  for (const o of job.outcomes) if (o.status === 'pending' || o.status === 'running') {
    Object.assign(o, {status: 'failed', code: 'STOPPED'});
    logEvent('failed', {no: job.outcomes.indexOf(o) + 1, code: 'STOPPED'});
  }
  render();
  if (job.outcomes.some(o => o.status === 'success')) await save(true);
  const failed = job.outcomes.filter(o => o.status === 'failed').length;
  if (!failed && !job.stop) say(`완료했습니다. ${job.outcomes.length}건 모두 PDF로 저장했습니다.`);
  else if (failed && !$('message').classList.contains('error')) say(`${failed}건은 만들지 못했습니다. “실패한 검사만 다시 시도”를 눌러 주세요.${job.outcomes.some(o => o.status === 'success') ? ' 성공한 PDF는 ZIP에 저장했습니다.' : ''}`, true);
}

function buildZip() {
  const zip = new ZipWriter(), names = new Set();
  for (const o of job.outcomes) {
    if (o.status !== 'success') { o.filename = null; continue; }
    const base = namesafe(o.row.name) + ' - ' + o.row.date;
    let n = 1, filename = base + '.pdf';
    while (names.has(filename.normalize('NFKC').toLowerCase())) filename = `${base} (${++n}).pdf`;
    names.add(filename.normalize('NFKC').toLowerCase());
    o.filename = filename;
    zip.add(filename, o.pdf);
  }
  const complete = job.outcomes.every(o => o.status === 'success') && !job.issues.length;
  const outcomes = job.outcomes.map(o => ({name: o.row.name, date: o.row.date, filename: o.filename, status: o.status, code: o.code}));
  zip.add('results.json', JSON.stringify({status: complete ? 'complete' : 'partial', month: job.month,
    scopewarning: '서버가 반환한 목록 기준; 실설치 전체성 미검증', outcomes, issues: job.issues}, null, 1));
  const csv = [['번호', '환자', '검사일', '결과', '파일명', '사유']]
    .concat(outcomes.map((o, i) => [i + 1, o.name, o.date, o.status === 'success' ? '성공' : '실패', o.filename || '', o.code ? msg(o.code) : '']))
    .concat(job.issues.map(i => ['', i.name, i.date, '목록 확인 문제', '', msg(i.code)]))
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  zip.add('결과목록.csv', '﻿' + csv);
  return {blob: zip.blob(), complete};
}

async function save(auto) {
  const {blob, complete} = buildZip();
  if (job.zipUrl) URL.revokeObjectURL(job.zipUrl);
  job.zipUrl = URL.createObjectURL(blob);
  const filename = `moire-${job.month}${complete ? '' : '-partial'}.zip`;
  await chrome.downloads.download({url: job.zipUrl, filename, conflictAction: 'uniquify', saveAs: false});
  const ok = job.outcomes.filter(o => o.status === 'success').length;
  $('saved').hidden = false;
  $('saved').textContent = `${auto ? '자동으로 ' : ''}다운로드 폴더에 ${filename} 저장을 요청했습니다 (PDF ${ok}건, 결과목록 포함).`;
}

// Error-log text file for bug reports. Contains no patient names, dates, IDs or server address.
function scrub(text) {
  let s = String(text ?? '');
  for (const o of job.outcomes) if (o.row?.name && o.row.name.length > 1) s = s.split(o.row.name).join('[환자]');
  return s.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/gi, '[주소]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[주소]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[ID]')
    .replace(/\b[0-9a-z_-]{20,}\b/gi, '[ID]');
}
function factsText(f) {
  if (!f) return '';
  const parts = [];
  if (f.stage) parts.push(`단계=${f.stage}`);
  if (f.printClicks != null) parts.push(`인쇄클릭=${f.printClicks}`);
  if (f.pendingRequests != null) parts.push(`대기요청=${f.pendingRequests}`);
  if (f.elapsedMs != null) parts.push(`소요=${(f.elapsedMs / 1000).toFixed(1)}초`);
  if (f.detail) parts.push(`상세=${scrub(f.detail)}`);
  return parts.join(' · ');
}
function errorLogText() {
  const now = new Date();
  const count = s => job.outcomes.filter(o => o.status === s).length;
  const failed = job.outcomes.map((o, i) => ({o, no: i + 1})).filter(x => x.o.status === 'failed');
  const byCode = {};
  for (const {o} of failed) byCode[o.code] = (byCode[o.code] || 0) + 1;
  const L = [];
  L.push('temo 딸깍 오류 기록', '='.repeat(40),
    '이 파일을 카카오톡 오픈채팅으로 보내 주세요: ' + REPORT_CHAT,
    '환자 이름·검사일·환자/검사 ID·아이밸런스 주소는 들어 있지 않습니다.', '');
  L.push('[환경]',
    `확장 버전: ${chrome.runtime.getManifest().version}`,
    `기록 시각: ${now.toISOString()} (컴퓨터 시간대 ${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
    `브라우저: ${navigator.userAgent}`,
    `화면 언어: ${navigator.language}`, '');
  L.push('[요약]',
    `대상 월: ${job.month}`,
    `확인한 환자 수: ${job.members}명`,
    `대상 검사: ${job.outcomes.length}건 · 성공 ${count('success')}건 · 실패 ${failed.length}건`,
    `시도 횟수: ${job.round}회(처음 1회 + 다시 시도 ${Math.max(0, job.round - 1)}회)`,
    `목록 확인 문제: ${job.issues.length}건${job.issues.length ? ' (' + job.issues.map(i => i.code).join(', ') + ')' : ''}`, '');
  L.push('[실패 사유별 건수]');
  for (const [code, n] of Object.entries(byCode).sort((a, b) => b[1] - a[1])) L.push(`${code} ${n}건 — ${msg(code)}`);
  L.push('', '[실패한 검사]');
  for (const {o, no} of failed) L.push(`#${no} ${o.code} — ${msg(o.code)}${o.facts ? ' · ' + factsText(o.facts) : ''}`);
  L.push('', '[진행 기록]');
  for (const e of job.log) {
    const head = `${e.t} [${e.round}회차] `;
    if (e.type === 'start') L.push(head + `시작 (${e.month})`);
    else if (e.type === 'catalogue') L.push(head + `목록 확인: 환자 ${e.members}명 · 검사 ${e.reports}건 · 목록 문제 ${e.issues.length}건`);
    else if (e.type === 'retry') L.push(head + `실패한 검사 ${e.reports}건 다시 시도`);
    else if (e.type === 'success') L.push(head + `#${e.no} 성공${e.facts ? ' · ' + factsText(e.facts) : ''}`);
    else if (e.type === 'failed') L.push(head + `#${e.no} 실패 ${e.code}${e.facts ? ' · ' + factsText(e.facts) : ''}`);
    else if (e.type === 'aborted') L.push(head + `작업 중단 ${e.code}${e.detail ? ' · 상세=' + scrub(e.detail) : ''}`);
  }
  L.push('', '='.repeat(40), '제보처: ' + REPORT_CHAT, '');
  return L.join('\r\n');
}
async function saveErrorLog() {
  const url = URL.createObjectURL(new Blob(['﻿' + errorLogText()], {type: 'text/plain;charset=utf-8'}));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const filename = `temo-ttalkkak-error-log-${job.month}-${stamp}.txt`;
  try { await chrome.downloads.download({url, filename, conflictAction: 'uniquify', saveAs: false}); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
  say(`다운로드 폴더에 ${filename} 저장을 요청했습니다. 이 파일을 카카오톡 오픈채팅으로 보내 주세요.`);
}

// Test/documentation hook: lets a harness render the real UI from a given job state.
globalThis.__moireUi = {render, busy, say, errorLogText};

init();

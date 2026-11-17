// One official MOIRE report -> PDF bytes, driven through chrome.debugger.
// Same stage order and checks as the downloader's native_report.cjs run(); the page-side
// code (selection, provenance, print capture, read-only request policy) is generated
// verbatim into report-src.js.
import {fail, requestDecision, READ_QUERIES, canonical} from './report-src.js';
import {legacySelectExpression, legacyResultHref} from './legacy.js';
import {newSelectExpression, provenanceExpression, captureHook, printExpression} from './anybuild.js';

const PRINT_CLICKS = 3, PRINT_RECLICK_MS = 15000, REPORT_BUDGET_MS = 180000, MAX_PDF = 32 * 1024 * 1024;
const delay = ms => new Promise(r => setTimeout(r, ms));
const VERSION = '1.3';
const PRINT_RESOURCES = ['Image', 'Font', 'Stylesheet', 'Media'];

// Error-log diagnostics for a request that stopped the report (e.g. ORIGIN_BLOCKED).
// Mirrors the rule order of report-src.js requestDecision() without changing it.
// Never includes the host, query string, variables, body or any id: only the rule, request
// kind, which side (frontend/api/other) and port, a masked path and the GraphQL operation name.
const UNSAFE_PATH = /(?:^|\/)(?:login|logout|auth|refresh|send[^/]*|pacs|alimtalk|mutation)(?:\/|$)/i;
// ASCII identifier, but not something that looks like an id (hex run or long digit run).
const NAME = {test: v => /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(v) && !/[a-f0-9]{12,}/i.test(v) && !/\d{5,}/.test(v)};
function maskPath(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  const kept = parts.slice(0, 6).map(p => /^[A-Za-z][A-Za-z._-]{0,29}$/.test(p) && !/[a-f]{12,}/i.test(p) ? p : ':x');
  return '/' + kept.join('/') + (parts.length > 6 ? '/…' : '');
}
// Shape of a GraphQL request with names only: kind, operation name, first field, variable NAMES (never values)
// and whether the text equals the allowlisted query of the same name.
function graphqlShape(request, u) {
  let body;
  try {
    if (request.method === 'POST') body = JSON.parse(request.postData || '{}');
    else body = {query: u.searchParams.get('query'), operationName: u.searchParams.get('operationName'),
      variables: JSON.parse(u.searchParams.get('variables') || '{}')};
  } catch { return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const query = typeof body.query === 'string' ? body.query : '';
  const head = query.match(/^\s*(query|mutation|subscription)\b\s*([A-Za-z_][A-Za-z0-9_]*)?/);
  const kind = head ? head[1] : (query.trim().startsWith('{') ? 'query' : '?');
  const field = query.match(/\{\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
  const rawName = typeof body.operationName === 'string' ? body.operationName : head?.[2];
  const name = NAME.test(rawName || '') ? rawName : '-';
  const v = body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables) ? Object.keys(body.variables) : [];
  const vars = v.filter(k => NAME.test(k)).slice(0, 6).join(',') + (v.length > 6 ? ',…' : '') || '-';
  const known = Object.hasOwn(READ_QUERIES, name) ? (canonical(query) === canonical(READ_QUERIES[name]) ? '같음' : '다름') : '없음';
  const extra = Object.keys(body).filter(k => !['query', 'operationName', 'variables'].includes(k));
  return {kind, name, field: NAME.test(field || '') ? field : '-', vars, known,
    extra: extra.filter(k => NAME.test(k)).slice(0, 3).join(',') || null,
    multi: (query.match(/\b(?:query|mutation|subscription)\b/g) || []).length > 1};
}
function shapeText(s) {
  if (!s) return 'unreadable';
  return `${s.kind} ${s.name} 첫필드=${s.field} 변수=${s.vars} 허용목록과=${s.known}${s.extra ? ' 추가키=' + s.extra : ''}`;
}
function graphqlOperation(request, u) { return shapeText(graphqlShape(request, u)); }

// The official result page also loads the patient list (`query members`) for its left sidebar. Some clinic
// installs send a different version of that query (2026-11-16 clinic log: XHR `query members` blocked at
// EXAM_SELECT within 0.4 s), which the generated allowlist rejects as ORIGIN_BLOCKED and the whole report stops.
// The report does not need that list: the request is still denied (it never reaches the server) but it no
// longer stops the report, like the sidebar `queue` preload in report-src.js. Only a single read operation
// named `members` whose first field is `members`, sent to the exact API address, qualifies.
export function sidebarMembersRead(request, type, cfg) {
  try {
    if (request.method !== 'POST' || !['XHR', 'Fetch'].includes(type) || request.url !== cfg.api) return false;
    const s = graphqlShape(request, new URL(request.url));
    return !!s && s.kind === 'query' && !s.multi && s.name === 'members' && s.field === 'members';
  } catch { return false; }
}
// A read of ANOTHER patient (`query member`/`getMeasurements` with an id that is not this report's patient).
// A clinic build reloaded the previous report's patient and that read stopped every later report
// (2026-11-16 log: ORIGIN_BLOCKED, member, text same as the allowlist, other id). It stays denied (no other
// patient's data reaches the page) but no longer stops the report; the report itself is checked by provenance.
export function otherMemberRead(request, type, cfg) {
  try {
    if (request.method !== 'POST' || !['XHR', 'Fetch'].includes(type) || request.url !== cfg.api) return false;
    const s = graphqlShape(request, new URL(request.url));
    if (!s || s.kind !== 'query' || s.multi || !['member', 'getMeasurements'].includes(s.name) || s.field !== 'member') return false;
    const v = JSON.parse(request.postData || '{}').variables || {};
    const id = s.name === 'member' ? v.id : v.target?.id;
    const target = new URL(cfg.target).hash.match(/memberId=([a-fA-F0-9]{24})/)?.[1];
    return typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id) && !!target && id !== target;
  } catch { return false; }
}
export function describeBlocked(request, type, cfg, code) {
  const out = {code, type: NAME.test(type || '') ? type : '?', method: NAME.test(request?.method || '') ? request.method : '?'};
  let u;
  try { u = new URL(request.url); } catch { return {...out, rule: 'URL_UNREADABLE'}; }
  const f = new URL(cfg.frontend), a = new URL(cfg.api);
  out.side = u.origin === f.origin ? 'frontend' : u.origin === a.origin ? 'api' : u.protocol === 'blob:' ? 'blob' : 'other';
  out.scheme = u.protocol.replace(':', '');
  out.port = u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '-');
  out.path = maskPath(u.pathname);
  out.hasQuery = !!u.search;
  if (u.port === '5001') out.rule = 'PORT_5001';
  else if (UNSAFE_PATH.test(u.pathname)) out.rule = 'UNSAFE_PATH';
  else if (u.origin === a.origin && u.pathname === a.pathname && type !== 'WebSocket') { out.rule = 'API_NOT_ALLOWED'; out.op = graphqlOperation(request, u); }
  else if (type === 'Document') { out.rule = 'DOCUMENT'; out.samePathAsTarget = u.origin === f.origin && u.pathname === new URL(cfg.target).pathname; }
  else out.rule = code === 'AUTH_ENDED' ? 'AUTH_REQUEST' : 'OTHER';
  return out;
}

export async function renderReport(cfg, {windowId, onStage = () => {}} = {}) {
  const started = performance.now(), remaining = () => Math.max(0, REPORT_BUDGET_MS - (performance.now() - started));
  let tabId = null, attached = false, fatal = null, printing = false;
  const inflight = new Map(), facts = {stage: 'BROWSER_START', printClicks: 0};
  const stage = name => { facts.stage = name; onStage(name); };
  const send = (method, params = {}) => {
    if (fatal) return Promise.reject(fail(fatal));
    return chrome.debugger.sendCommand({tabId}, method, params);
  };
  const onEvent = (source, method, params) => {
    if (source.tabId !== tabId) return;
    if (method === 'Fetch.requestPaused') {
      let decision = requestDecision(params.request, params.resourceType, cfg, printing);
      const sidebar = decision.code === 'ORIGIN_BLOCKED' && sidebarMembersRead(params.request, params.resourceType, cfg);
      const other = decision.code === 'ORIGIN_BLOCKED' && !sidebar && otherMemberRead(params.request, params.resourceType, cfg);
      if (sidebar || other) {
        decision = {allow: false, code: null};
        const seen = graphqlOperation(params.request, new URL(params.request.url)) + (other ? ' 다른환자' : '');
        facts.ignored = facts.ignored || [];
        if (facts.ignored.length < 3 && !facts.ignored.includes(seen)) facts.ignored.push(seen);
      }
      chrome.debugger.sendCommand({tabId}, decision.allow ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        {requestId: params.requestId, ...(decision.allow ? {} : {errorReason: 'BlockedByClient'})}).catch(() => {}); // the request may already be cancelled by a navigation; nothing is left to continue
      if (decision.code && !fatal) facts.blocked = describeBlocked(params.request, params.resourceType, cfg, decision.code);
      if (decision.code) fatal = fatal || decision.code;
    }
    if (method === 'Network.requestWillBeSent') inflight.set(params.requestId, params.type);
    if (method === 'Network.responseReceived' && params.response.url === cfg.api && [401, 403].includes(params.response.status)) fatal = 'AUTH_ENDED';
    if (printing && method === 'Network.responseReceived' && params.response.status >= 400 && PRINT_RESOURCES.includes(params.type)) fatal = fatal || 'RESOURCE_FAILED';
    if (printing && method === 'Network.loadingFailed' && PRINT_RESOURCES.includes(inflight.get(params.requestId)) && !params.canceled && params.errorText !== 'net::ERR_BLOCKED_BY_CLIENT') fatal = fatal || 'RESOURCE_FAILED';
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') inflight.delete(params.requestId);
  };
  const onDetach = source => { if (source.tabId === tabId) { attached = false; fatal = fatal || 'BROWSER_EXITED'; } };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (fatal) throw fail(fatal);
    if (remaining() <= 0) throw fail('CDP_TIMEOUT');
    if (r.exceptionDetails) throw fail('CAPTURE_FAILED');
    return r.result?.value;
  };
  const poll = async (expression, code, ms = remaining()) => {
    const until = performance.now() + Math.min(ms, remaining());
    while (performance.now() < until) {
      if (await evaluate(expression)) return true;
      await delay(100);
    }
    throw fail(code);
  };
  try {
    const tab = await chrome.tabs.create({url: 'about:blank', active: true, ...(windowId ? {windowId} : {})});
    tabId = tab.id;
    await chrome.debugger.attach({tabId}, VERSION); attached = true;
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Network.setBlockedURLs', {urls: ['ws://*', 'wss://*']});
    await send('Fetch.enable', {patterns: [{urlPattern: '*', requestStage: 'Request'}]});
    // Extensions may not override the timezone; app.js refuses to start unless the PC runs KST.
    await send('Emulation.setFocusEmulationEnabled', {enabled: true}).catch(() => {});
    // cfg.ui comes from detectUiVersion() at the start of the run: 'old' takes the legacy.js selection flow.
    // Provenance, capture and the print click are build-independent for both versions (anybuild.js).
    const legacy = cfg.ui === 'old';
    const expectHref = legacy ? legacyResultHref(cfg) : cfg.target;
    const provenance = provenanceExpression(cfg);
    await send('Page.addScriptToEvaluateOnNewDocument', {source: captureHook(cfg)});
    stage('NAVIGATE');
    const nav = await send('Page.navigate', {url: cfg.target});
    if (nav.errorText) throw fail('NAVIGATION_FAILED');
    stage('EXAM_SELECT');
    await poll(legacy ? legacySelectExpression(cfg) : newSelectExpression(cfg), 'SELECTION_FAILED');
    if (await evaluate('location.href') !== expectHref) throw fail('AUTH_ENDED');
    stage('REPORT_PROVENANCE');
    await poll(provenance, 'PROVENANCE_FAILED');
    stage('PRINT_PREPARE');
    const clickPrint = '(' + provenance + '&&' + printExpression() + ')';
    await poll(clickPrint, 'PRINT_NOT_FOUND');
    facts.printClicks = 1;
    stage('PRINT_CAPTURE');
    // react-to-print sometimes never calls print(); re-click while print() was not called.
    const captureDone = `(()=>{const c=window.__ibReport;if(c?.state==='failed')throw Error();return c?.state==='ready';})()`;
    const printState = `(()=>{const c=window.__ibReport;return {waiting:!!c&&c.state==='waiting',printCalls:c?.printCalls|0};})()`;
    for (let click = 1; ; click++) {
      try { await poll(captureDone, 'PRINT_NOT_CALLED', PRINT_RECLICK_MS); break; }
      catch (error) { if (error.code !== 'PRINT_NOT_CALLED' || remaining() <= 0) throw error; }
      const state = await evaluate(printState) || {};
      facts.pendingRequests = inflight.size;
      if (!state.waiting || state.printCalls) continue;
      if (click >= PRINT_CLICKS) throw fail('PRINT_NOT_CALLED');
      await poll(clickPrint, 'PRINT_NOT_FOUND', PRINT_RECLICK_MS);
      facts.printClicks = click + 1;
    }
    if (await evaluate('location.href') !== expectHref) throw fail('AUTH_ENDED');
    const html = await evaluate('window.__ibReport.html');
    if (typeof html !== 'string' || html.length > 24 * 1024 * 1024) throw fail('CAPTURE_FAILED');
    stage('RESOURCES_READY');
    printing = true;
    await send('Emulation.setEmulatedMedia', {media: 'print'});
    const {frameTree} = await send('Page.getFrameTree');
    await send('Page.setDocumentContent', {frameId: frameTree.frame.id, html});
    const ready = await evaluate(`Promise.race([(async()=>{await Promise.all([...document.querySelectorAll('link[rel~=stylesheet]')].filter(l=>!l.disabled).map(l=>l.sheet?Promise.resolve():new Promise((r,j)=>{l.onload=r;l.onerror=j;})));await document.fonts.ready;await Promise.all([...document.images].map(i=>i.complete?Promise.resolve():new Promise((r,j)=>{i.onload=r;i.onerror=j;})));if([...document.images].some(i=>!i.naturalWidth)||[...document.fonts].some(f=>f.status==='error'))return false;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})(),new Promise(r=>setTimeout(()=>r(false),${Math.min(remaining(), 180000)}))])`);
    if (!ready || fatal) throw fail(fatal || 'RESOURCE_FAILED');
    stage('PDF_CONVERT');
    const pdf = await send('Page.printToPDF', {printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false,
      paperWidth: 210 / 25.4, paperHeight: 297 / 25.4, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0});
    if (fatal) throw fail(fatal);
    const bytes = Uint8Array.from(atob(pdf.data || ''), c => c.charCodeAt(0));
    if (bytes.length > MAX_PDF) throw fail('OUTPUT_TOO_LARGE');
    if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') throw fail('PDF_INVALID');
    return {bytes, facts: {...facts, elapsedMs: Math.round(performance.now() - started)}};
  } catch (e) {
    const code = e?.code || (/debugger|attach/i.test(String(e?.message)) ? 'DEBUGGER_BLOCKED' : 'REPORT_FAILED');
    // Old UI: the last step legacy.js reached (fixed ASCII label, no data) shows where a clinic run stopped.
    if (cfg.ui === 'old' && attached) {
      try {
        const r = await chrome.debugger.sendCommand({tabId}, 'Runtime.evaluate', {expression: 'window.__ibLegacy?.step', returnByValue: true});
        const v = r?.result?.value;
        if (typeof v === 'string' && /^[a-z0-9-]{1,30}$/.test(v)) facts.legacyStep = v;
      } catch {}
    }
    throw Object.assign(new Error(code), {code, facts: {...facts, elapsedMs: Math.round(performance.now() - started), detail: e?.code ? undefined : String(e?.message || e).slice(0, 200)}});
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    if (attached) { try { await chrome.debugger.detach({tabId}); } catch {} }
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} }
    cfg.tokens = null;
  }
}

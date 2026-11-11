// One official MOIRE report -> PDF bytes, driven through chrome.debugger.
// Same stage order and checks as the downloader's native_report.cjs run(); the page-side
// code (selection, provenance, print capture, read-only request policy) is generated
// verbatim into report-src.js.
import {fail, requestDecision, captureHook, openReportExpression, provenanceExpression,
  printReportExpression} from './report-src.js';

const PRINT_CLICKS = 3, PRINT_RECLICK_MS = 15000, REPORT_BUDGET_MS = 180000, MAX_PDF = 32 * 1024 * 1024;
const delay = ms => new Promise(r => setTimeout(r, ms));
const VERSION = '1.3';
const PRINT_RESOURCES = ['Image', 'Font', 'Stylesheet', 'Media'];

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
      const decision = requestDecision(params.request, params.resourceType, cfg, printing);
      chrome.debugger.sendCommand({tabId}, decision.allow ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        {requestId: params.requestId, ...(decision.allow ? {} : {errorReason: 'BlockedByClient'})}).catch(() => {}); // the request may already be cancelled by a navigation; nothing is left to continue
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
    await send('Page.addScriptToEvaluateOnNewDocument', {source: captureHook(cfg)});
    stage('NAVIGATE');
    const nav = await send('Page.navigate', {url: cfg.target});
    if (nav.errorText) throw fail('NAVIGATION_FAILED');
    stage('EXAM_SELECT');
    await poll(openReportExpression(cfg), 'SELECTION_FAILED');
    if (await evaluate('location.href') !== cfg.target) throw fail('AUTH_ENDED');
    stage('REPORT_PROVENANCE');
    await poll(provenanceExpression(cfg), 'PROVENANCE_FAILED');
    stage('PRINT_PREPARE');
    const clickPrint = '(' + provenanceExpression(cfg) + '&&' + printReportExpression() + ')';
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
    if (await evaluate('location.href') !== cfg.target) throw fail('AUTH_ENDED');
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
    throw Object.assign(new Error(code), {code, facts: {...facts, elapsedMs: Math.round(performance.now() - started), detail: e?.code ? undefined : String(e?.message || e).slice(0, 200)}});
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    if (attached) { try { await chrome.debugger.detach({tabId}); } catch {} }
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} }
    cfg.tokens = null;
  }
}

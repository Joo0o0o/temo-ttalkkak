// Regenerates docs/images/*.png from the real extension UI in a throwaway Chrome profile.
// All patient rows are synthetic ("예시 환자"). No clinic server is contacted.
//   node tools/screenshots.cjs
'use strict';
const {spawn} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(__dirname, '..'), EXT = path.join(ROOT, 'extension'), OUT = path.join(ROOT, 'docs/images');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, {recursive: true});
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'temo-shots-'));
  const proc = spawn(CHROME, ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
    '--lang=ko', '--accept-lang=ko-KR', '--disable-sync', '--use-mock-keychain', '--user-data-dir=' + profile, '--window-size=1280,900', 'about:blank'],
    {stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env: {...process.env, LANG: 'ko_KR.UTF-8'}});
  const w = proc.stdio[3], r = proc.stdio[4]; let id = 0, buf = ''; const pend = new Map();
  r.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pend.set(i, m => m.error ? rej(Error(method + ': ' + m.error.message)) : res(m.result)); w.write(JSON.stringify({id: i, method, params, ...(sessionId ? {sessionId} : {})}) + '\0'); });
  const open = async url => { const {targetId} = await send('Target.createTarget', {url}); const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true}); await send('Runtime.enable', {}, sessionId); return sessionId; };
  const evaluate = async (s, expression) => { const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, s); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || 'eval'); return r.result?.value; };
  const shot = async (s, name, {width = 1100, height = 760, full = false} = {}) => {
    await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 2, mobile: false}, s);
    await send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: 'light'}]}, s);
    await delay(400);
    let clip;
    if (full) { const h = await evaluate(s, 'Math.ceil(document.documentElement.scrollHeight)'); clip = {x: 0, y: 0, width, height: h, scale: 1}; }
    const {data} = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: full, ...(clip ? {clip} : {})}, s);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64')); console.log('wrote', name);
  };
  try {
    // ---- 설치: chrome://extensions ----
    const ex = await open('chrome://extensions'); await delay(1500);
    const mark = `(el,label)=>{el.style.outline='4px solid #e5484d';el.style.outlineOffset='4px';el.style.borderRadius='6px';
      const tag=document.createElement('div');tag.textContent=label;Object.assign(tag.style,{position:'fixed',background:'#e5484d',color:'#fff',font:'600 14px sans-serif',padding:'4px 10px',borderRadius:'12px',zIndex:99999});
      document.body.append(tag);const r=el.getBoundingClientRect(),t=tag.getBoundingClientRect();
      if(r.right+16+t.width<innerWidth){tag.style.left=(r.right+16)+'px';tag.style.top=(r.top+r.height/2-t.height/2)+'px';}
      else{tag.style.left=Math.max(8,r.right-t.width)+'px';tag.style.top=(r.bottom+12)+'px';}}`;
    const toolbar = `document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-toolbar').shadowRoot`;
    await evaluate(ex, `(${mark})(${toolbar}.querySelector('#devMode'),'① 개발자 모드 켜기');true`);
    await shot(ex, '01-devmode.png', {width: 1280, height: 520});
    await evaluate(ex, `document.querySelectorAll('body>div').forEach(d=>d.remove());${toolbar}.querySelector('#devMode').style.outline='';${toolbar}.querySelector('#devMode').click();true`);
    await delay(800);
    await evaluate(ex, `(${mark})(${toolbar}.querySelector('#loadUnpacked'),'② 압축해제된 확장 프로그램 로드');true`);
    await shot(ex, '02-load-unpacked.png', {width: 1280, height: 520});
    const {id: extId} = await send('Extensions.loadUnpacked', {path: EXT});
    await send('Page.reload', {}, ex); await delay(1800);
    await evaluate(ex, `(()=>{const list=document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-item-list').shadowRoot;const item=list.querySelector('extensions-item');(${mark})(item,'③ temo 딸깍 설치 완료');return true;})()`);
    await shot(ex, '03-installed.png', {width: 1280, height: 620});

    // ---- 사용: 확장 화면 (실제 render 함수 + 가상 데이터) ----
    const app = await open(`chrome-extension://${extId}/app.html`); await delay(1200);
    const N = ['예시 환자 01', '예시 환자 02', '예시 환자 03', '예시 환자 04', '예시 환자 05', '예시 환자 06', '예시 환자 07', '예시 환자 08'];
    const rows = JSON.stringify(N.map((name, i) => ({name, date: `2026-10-${String(2 + i * 3).padStart(2, '0')}`})));
    const state = (statuses, extra = '') => `(()=>{const j=globalThis.__moireJob,ui=globalThis.__moireUi,rows=${rows},st=${JSON.stringify(statuses)};
      document.getElementById('address').value='http://192.168.0.10:3003/';document.getElementById('year').value='2026';document.getElementById('month').value='10';
      Object.assign(j,{month:'2026-10',members:8,scanned:8,issues:[],outcomes:rows.map((row,i)=>({row,status:st[i].split(':')[0],code:st[i].split(':')[1]||null}))});
      ${extra};ui.render();return true;})()`;
    await evaluate(app, `document.getElementById('address').value='http://192.168.0.10:3003/';document.getElementById('year').value='2026';document.getElementById('month').value='10';true`);
    await shot(app, '04-start.png', {width: 900, full: true});
    await evaluate(app, `globalThis.__moireUi.say("이 크롬에서 아이밸런스 로그인 상태를 찾지 못했습니다. 열린 아이밸런스 탭에서 로그인한 뒤 다시 시작해 주세요.",true);true`);
    await shot(app, '05-login-required.png', {width: 900, full: true});
    await evaluate(app, `globalThis.__moireUi.say('');` + state(['success', 'success', 'success', 'running', 'pending', 'pending', 'pending', 'pending'], `globalThis.__moireUi.busy(true)`).replace('ui.render()', "ui.render('예시 환자 04 리포트 만드는 중')"));
    await shot(app, '06-progress.png', {width: 900, full: true});
    await evaluate(app, state(Array(8).fill('success'), `globalThis.__moireUi.busy(false);ui.say('완료했습니다. 8건 모두 PDF로 저장했습니다.');const s=document.getElementById('saved');s.hidden=false;s.textContent='자동으로 다운로드 폴더에 moire-2026-10.zip 저장을 요청했습니다 (PDF 8건, 결과목록 포함).'`));
    await shot(app, '07-complete.png', {width: 900, full: true});
    await evaluate(app, state(['success', 'success', 'failed:PRINT_NOT_CALLED', 'success', 'success', 'success', 'failed:AUTH_ENDED', 'success'], `globalThis.__moireUi.busy(false);ui.say('2건은 만들지 못했습니다. “실패한 검사만 다시 시도”를 눌러 주세요. 성공한 PDF는 ZIP에 저장했습니다.',true);const s=document.getElementById('saved');s.hidden=false;s.textContent='자동으로 다운로드 폴더에 moire-2026-10-partial.zip 저장을 요청했습니다 (PDF 6건, 결과목록 포함).'`));
    await shot(app, '08-partial-retry.png', {width: 900, full: true});

    // ---- ZIP 구성 예시 ----
    const z = await open('about:blank');
    const files = N.map((n, i) => [`${n} - 2026-10-${String(2 + i * 3).padStart(2, '0')}.pdf`, 'PDF 문서']).concat([['결과목록.csv', '엑셀로 열 수 있는 결과 목록'], ['results.json', '프로그램용 결과 기록']]);
    await evaluate(z, `document.body.innerHTML=${JSON.stringify(`<style>body{margin:0;font:15px -apple-system,'Apple SD Gothic Neo',sans-serif;background:#f4f6f9;color:#16202c}.w{margin:24px;background:#fff;border:1px solid #dfe4ea;border-radius:12px;padding:18px 22px}h3{margin:0 0 12px}td{padding:6px 14px 6px 0;border-bottom:1px solid #eef1f4}td:last-child{color:#5b6878}</style><div class="w"><h3>📦 moire-2026-10.zip</h3><table>${files.map(([f, d]) => `<tr><td>${f.endsWith('.pdf') ? '📄' : '📋'} ${f}</td><td>${d}</td></tr>`).join('')}</table></div>`)};true`);
    await shot(z, '09-zip-contents.png', {width: 760, full: true});
  } finally {
    proc.kill(); await delay(800); fs.rmSync(profile, {recursive: true, force: true});
  }
}
main().catch(e => { console.error('SHOTS_ERROR', e.message); process.exit(1); });

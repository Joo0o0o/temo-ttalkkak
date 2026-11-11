// End-to-end check against a real iBalance test install.
// Launches a separate Chrome profile (never the user's), installs the unpacked extension,
// logs in once through the official GraphQL login to seed the frontend's localStorage
// (what a clinic's own login leaves behind), then drives the extension UI like a user.
// Credentials come only from env vars and are never written to disk.
//   MOIRE_URL=http://host:3003/ MOIRE_USER=.. MOIRE_PASS=.. MOIRE_MONTH=2026-10 OUT=/dir node tests/e2e-source.cjs
'use strict';
const {spawn} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve(__dirname, '../extension');
const {MOIRE_URL, MOIRE_USER, MOIRE_PASS, MOIRE_MONTH = '2026-10'} = process.env;
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'moire-ext-e2e-'));
if (!MOIRE_URL || !MOIRE_USER || !MOIRE_PASS) { console.error('MOIRE_URL/MOIRE_USER/MOIRE_PASS required'); process.exit(2); }
const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const front = new URL(MOIRE_URL), api = `${front.protocol}//${front.hostname}:8080/graphql`;
  // Test copy: pre-grant the single test host so the permission prompt is not needed.
  const ext = fs.mkdtempSync(path.join(OUT, 'ext-')); fs.cpSync(EXT, ext, {recursive: true});
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [`${front.protocol}//${front.hostname}/*`];
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest));
  const profile = fs.mkdtempSync(path.join(OUT, 'profile-')), downloads = path.join(OUT, 'downloads'); fs.mkdirSync(downloads, {recursive: true});
  const proc = spawn(CHROME, ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--use-mock-keychain', '--user-data-dir=' + profile, '--window-size=1200,900', 'about:blank'], {stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']});
  const w = proc.stdio[3], r = proc.stdio[4]; let id = 0, buf = ''; const pend = new Map();
  r.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pend.set(i, m => m.error ? rej(Error(method + ': ' + m.error.message)) : res(m.result)); w.write(JSON.stringify({id: i, method, params, ...(sessionId ? {sessionId} : {})}) + '\0'); });
  const result = {month: MOIRE_MONTH, out: OUT};
  try {
    const {id: extId} = await send('Extensions.loadUnpacked', {path: ext});
    await send('Browser.setDownloadBehavior', {behavior: 'allow', downloadPath: downloads, eventsEnabled: true});
    // Seed the clinic login in the frontend origin.
    const login = await fetch(api, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
      query: 'query login($email: String!, $password: String!) { login(email: $email, password: $password) { tokens { access refresh } } }',
      variables: {email: MOIRE_USER, password: MOIRE_PASS}})}).then(x => x.json());
    const tokens = login?.data?.login?.tokens; if (!tokens?.access) throw Error('LOGIN_FAILED');
    const open = async url => { const {targetId} = await send('Target.createTarget', {url}); const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true}); await send('Runtime.enable', {}, sessionId); return sessionId; };
    const evaluate = async (s, expression, userGesture = false) => (await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture}, s)).result?.value;
    const clinic = await open(front.href); await delay(2500);
    if (!process.env.NO_LOGIN) await evaluate(clinic, `localStorage.setItem('PomChecker__TokensLocalStorageService__tokens', ${JSON.stringify(JSON.stringify(tokens))});true`);
    const app = await open(`chrome-extension://${extId}/app.html`); await delay(1000);
    const [y, m] = MOIRE_MONTH.split('-').map(Number);
    await evaluate(app, `(()=>{const set=(id,v)=>{const e=document.getElementById(id);e.value=v;e.dispatchEvent(new Event('change'));};set('address',${JSON.stringify(front.href)});set('year','${y}');set('month','${m}');return true;})()`);
    const t0 = Date.now();
    await evaluate(app, `document.getElementById('start').click();true`, true);
    let last = '';
    while (Date.now() - t0 < 60 * 60 * 1000) {
      await delay(3000);
      const s = await evaluate(app, `({summary:document.getElementById('summary').textContent,running:!document.getElementById('stop').hidden,message:document.getElementById('message').textContent,saved:document.getElementById('saved').textContent})`);
      if (s.summary !== last) { console.log(new Date().toISOString().slice(11, 19), s.summary); last = s.summary; }
      if (!s.running && Date.now() - t0 > 5000) { Object.assign(result, s); break; }
    }
    result.elapsedSec = Math.round((Date.now() - t0) / 1000);
    await send('Emulation.setDeviceMetricsOverride', {width: 900, height: 1400, deviceScaleFactor: 1, mobile: false}, app);
    const shot = await send('Page.captureScreenshot', {format: 'png'}, app);
    fs.writeFileSync(path.join(OUT, 'app-final.png'), Buffer.from(shot.data, 'base64'));
    result.facts = await evaluate(app, `(globalThis.__moireJob?.outcomes||[]).map(o=>({status:o.status,code:o.code,facts:o.facts}))`);
    result.rows = await evaluate(app, `[...document.querySelectorAll('#rows tr')].map(tr=>tr.cells[3].textContent)`);
    await delay(3000);
    result.downloads = fs.readdirSync(downloads);
  } finally {
    proc.kill(); await delay(1000);
    fs.rmSync(profile, {recursive: true, force: true}); fs.rmSync(ext, {recursive: true, force: true});
  }
  // Do not print patient names; only statuses.
  const counts = {}; for (const s of result.rows || []) { const k = s.split(' · ')[0]; counts[k] = (counts[k] || 0) + 1; }
  console.log(JSON.stringify({...result, rows: undefined, facts: undefined, factSample: (result.facts||[]).filter(f=>f.status!=='success').slice(0,3), clicks: (result.facts||[]).map(f=>f.facts?.printClicks), elapsedMs: (result.facts||[]).map(f=>f.facts?.elapsedMs), statusCounts: counts, failures: (result.rows || []).filter(s => s.startsWith('실패')).length}, null, 1));
}
main().catch(e => { console.error('E2E_ERROR', e.message); process.exit(1); });

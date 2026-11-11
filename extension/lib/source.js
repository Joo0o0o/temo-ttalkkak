// Read-only iBalance source access. Ported from the downloader's source_client.py and
// exporter.py (catalogue/month_range/namesafe). Uses the clinic's existing browser login.
import {READ_QUERIES} from './report-src.js';

export const TOKEN_KEY = 'PomChecker__TokensLocalStorageService__tokens';
export const TIMEZONE = 'Asia/Seoul';
const KST_OFFSET_MS = 9 * 3600 * 1000; // Korea has no DST.
const ID = /^[a-fA-F0-9]{24}$/;
const NETWORK_TIMEOUT_MS = 15000;

export class SourceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const AUTH_CODES = new Set(['DUPLICATED_LOGIN', 'TOKEN_EXPIRED: ACCESS', 'TOKEN_EXPIRED: REFRESH',
  'USER_UNAUTHORIZED', 'UNAUTHENTICATED', 'FORBIDDEN']);

/** Normalise the address the clinic types into frontend + API endpoints. */
export function endpoints(value) {
  if (typeof value !== 'string' || !value.trim() || /[\s\\]/.test(value.trim())) throw new SourceError('URL_INVALID');
  let url;
  try { url = new URL(value.includes('://') ? value.trim() : 'http://' + value.trim()); } catch { throw new SourceError('URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new SourceError('URL_INVALID');
  }
  const frontend = url.origin + (url.pathname || '/');
  const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
  const api = `${url.protocol}//${host}:8080/graphql`;
  return {frontend, api, origin: url.origin, apiOrigin: new URL(api).origin};
}

/** Host permission patterns. Match patterns ignore ports, so one pattern covers 3003 and 8080. */
export function originPatterns(frontend) {
  const u = new URL(frontend);
  return [`${u.protocol}//${u.hostname}/*`];
}

export function monthRange(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || year < 2000 || year > 2100 || month < 1 || month > 12) {
    throw new SourceError('MONTH_INVALID');
  }
  const start = Date.UTC(year, month - 1, 1) - KST_OFFSET_MS;
  const end = Date.UTC(year + (month === 12 ? 1 : 0), month === 12 ? 0 : month, 1) - KST_OFFSET_MS;
  return [start, end];
}

export function kstDate(ms) {
  const d = new Date(ms + KST_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

export function namesafe(name) {
  let value = (typeof name === 'string' ? name : '미상').normalize('NFC');
  value = [...value].map(c => ('<>:"/\\|?*'.includes(c) || /\p{C}/u.test(c)) ? '_' : c).join('').trim().replace(/^[ .]+|[ .]+$/g, '');
  if (!value || value === '.' || value === '..') value = '미상';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)) value = '_' + value;
  const enc = new TextEncoder();
  while (enc.encode(value).length > 180) value = value.slice(0, -1);
  return value.replace(/[ .]+$/, '') || '미상';
}

/** Rows (MOIRE exams inside the month) and issues for one member; mirrors exporter.catalogue. */
export function catalogue(member, span) {
  const rows = [], issues = [];
  let name = member && typeof member.name === 'string' && member.name.trim() ? member.name : '미상';
  const issue = (code, date = '미상') => issues.push({name, date, code});
  if (!member || typeof member !== 'object' || !ID.test(member.id || '')) { issue('MEMBER_INVALID'); return {rows, issues}; }
  if (!Array.isArray(member.measurements)) { issue('MEASUREMENTS_UNAVAILABLE'); return {rows, issues}; }
  const seen = new Set();
  for (const m of member.measurements) {
    if (!m || typeof m !== 'object') { issue('MEASUREMENT_INVALID'); continue; }
    if (!ID.test(m.id || '')) { issue('MEASUREMENT_ID_INVALID'); continue; }
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const ms = typeof m.createdAt === 'string' && /(?:Z|[+-]\d\d:?\d\d)$/.test(m.createdAt) ? Date.parse(m.createdAt) : NaN;
    if (!Number.isFinite(ms)) { issue('MEASUREMENT_DATE_INVALID'); continue; }
    let cfg = m.config;
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = null; } }
    const tag = cfg && typeof cfg === 'object' ? cfg.tag : null;
    const kind = tag && typeof tag === 'object' ? tag.type : tag;
    if (!['MOIRE', 'POSTURE', 'ROM'].includes(kind)) { issue('MEASUREMENT_CONFIG_INVALID', kstDate(ms)); continue; }
    if (kind !== 'MOIRE' || ms < span[0] || ms >= span[1]) continue;
    rows.push({memberId: member.id, measurementId: m.id, name, date: kstDate(ms), createdAt: ms});
  }
  return {rows, issues};
}

export class Client {
  constructor(address, tokens) {
    Object.assign(this, endpoints(address));
    this.tokens = tokens;
  }
  async query(operation, variables = {}) {
    if (!Object.hasOwn(READ_QUERIES, operation)) throw new SourceError('QUERY_BLOCKED');
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), NETWORK_TIMEOUT_MS);
    let response, value;
    try {
      response = await fetch(this.api, {method: 'POST', signal: ctl.signal, credentials: 'omit', redirect: 'error',
        headers: {'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.tokens.access},
        body: JSON.stringify({query: READ_QUERIES[operation], variables})});
      if ([401, 403].includes(response.status)) throw new SourceError('AUTH_ENDED');
      if (response.status !== 200) throw new SourceError('SOURCE_FAILED');
      value = await response.json();
    } catch (e) {
      if (e instanceof SourceError) throw e;
      throw new SourceError('NETWORK_FAILED');
    } finally { clearTimeout(timer); }
    if (!value || typeof value !== 'object' || !value.data || value.errors) {
      const auth = Array.isArray(value?.errors) && value.errors.some(e => AUTH_CODES.has(e?.extensions?.code) || AUTH_CODES.has(e?.extensions?.exception?.code));
      throw new SourceError(auth ? 'AUTH_ENDED' : 'SOURCE_FAILED');
    }
    return value.data;
  }
  async me() {
    const me = (await this.query('me')).me;
    if (!me || typeof me.id !== 'string' || !me.id) throw new SourceError('AUTH_ENDED');
    return me;
  }
  async members() {
    const list = (await this.query('members')).members;
    if (!Array.isArray(list)) throw new SourceError('SOURCE_INVALID');
    return list;
  }
  async member(id) {
    return (await this.query('member', {id})).member;
  }
}

export function parseTokens(raw) {
  try {
    const t = JSON.parse(raw);
    const ok = v => typeof v === 'string' && v.length > 0 && v.length <= 16384 && !/[^\x21-\x7e]/.test(v);
    if (t && ok(t.access) && (t.refresh == null || ok(t.refresh))) return {access: t.access, refresh: t.refresh ?? null};
  } catch {}
  return null;
}

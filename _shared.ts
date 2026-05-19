/**
 * Shared helpers for flow plugin.
 *
 * - inFlowPage(): assert browser is on a Flow page; goto if not.
 * - flowFetch(): run fetch() inside the Flow page via page.evaluate,
 *   so it inherits OAuth cookies, projectId, sessionId, reCAPTCHA.
 * - loadState() / saveState(): default project + media cache.
 */
import type { IPage } from '@jackwener/opencli/registry';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export const SITE = 'flow';
export const FLOW_BASE = 'https://aisandbox-pa.googleapis.com/v1';
export const FLOW_ORIGIN = 'https://labs.google';
export const FLOW_HOME = 'https://labs.google/fx/zh/tools/flow';

const STATE_DIR = path.join(os.homedir(), '.opencli', 'clis', 'flow');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const MEDIA_CACHE_FILE = path.join(STATE_DIR, 'media-cache.json');
const LOCK_DIR = path.join(STATE_DIR, 'locks');
const LOCK_TIMEOUT_MS = 60_000;       // wait up to 60s for another process
const LOCK_STALE_MS = 5 * 60_000;     // a lock older than 5 min is considered stale

export type FlowState = {
  currentProjectId?: string;
};

export type MediaCacheEntry = {
  mediaId: string;
  workflowId?: string;
  type: 'image' | 'video';
  displayName?: string;
  width?: number;
  height?: number;
  uploadedAt: string;
  projectId: string;
};

/**
 * Cache is partitioned by projectId because Flow mediaIds are scoped to a
 * specific project on the server side: uploading the same file to two
 * different projects yields two different mediaIds, and a mediaId from
 * project A is not valid as a reference in project B.
 *
 * Schema:
 *   projects[projectId].by_sha256[sha256]  → MediaCacheEntry
 *   projects[projectId].by_alias[alias]    → sha256
 */
export type MediaCacheProject = {
  by_sha256: Record<string, MediaCacheEntry>;
  by_alias: Record<string, string>;
};
export type MediaCache = {
  projects: Record<string, MediaCacheProject>;
};

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

export function loadState(): FlowState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveState(s: FlowState): void {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

export function loadMediaCache(): MediaCache {
  try {
    const raw = JSON.parse(fs.readFileSync(MEDIA_CACHE_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && raw.projects) return raw as MediaCache;
    // Migrate older flat layout (by_sha256 / by_alias) into a new "projects" map
    // keyed by the projectId stored on each entry; entries without a projectId
    // are dropped (would be invalid as references anyway).
    if (raw?.by_sha256) {
      const migrated: MediaCache = { projects: {} };
      for (const [sha, entry] of Object.entries<MediaCacheEntry>(raw.by_sha256)) {
        const pid = entry.projectId;
        if (!pid) continue;
        migrated.projects[pid] ??= { by_sha256: {}, by_alias: {} };
        migrated.projects[pid].by_sha256[sha] = entry;
      }
      for (const [alias, sha] of Object.entries<string>(raw.by_alias || {})) {
        const entry = raw.by_sha256[sha] as MediaCacheEntry | undefined;
        if (entry?.projectId) migrated.projects[entry.projectId].by_alias[alias] = sha;
      }
      return migrated;
    }
    return { projects: {} };
  } catch {
    return { projects: {} };
  }
}

export function saveMediaCache(c: MediaCache): void {
  ensureDir();
  fs.writeFileSync(MEDIA_CACHE_FILE, JSON.stringify(c, null, 2));
}

/** Returns the per-project slice of the cache, creating it on demand. */
export function projectMediaCache(c: MediaCache, projectId: string): MediaCacheProject {
  c.projects[projectId] ??= { by_sha256: {}, by_alias: {} };
  return c.projects[projectId];
}

export function sha256OfFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Run `fn` while holding an exclusive file-based lock keyed by `sha256`.
 *
 * Used to prevent multiple concurrent processes from uploading the same file:
 * the first wins, the rest wait, then they all read the cache to find the
 * mediaId the winner uploaded. Stale locks (>5 min) are forcibly cleared.
 */
export async function withProjectShaLock<T>(
  projectId: string,
  sha256: string,
  fn: () => Promise<T>,
): Promise<T> {
  ensureDir();
  if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true });
  const lockPath = path.join(LOCK_DIR, `${projectId}__${sha256}.lock`);
  const start = Date.now();
  while (true) {
    try {
      // 'wx' = open for write, fail if exists — atomic across processes on POSIX.
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      try {
        return await fn();
      } finally {
        try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
      }
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      // Stale lock?
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* lock might have vanished — loop and retry */ }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`等待文件锁超时 (project=${projectId.slice(0, 8)} sha256=${sha256.slice(0, 8)}...). 另一个进程可能卡住了。`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/**
 * Make sure the browser tab is on a Flow page so cookies + access_token + reCAPTCHA
 * site context are valid. If not, navigate to the user's current project (if known)
 * or the Flow home.
 */
export async function inFlowPage(page: IPage): Promise<{ projectId: string | null }> {
  const url = page.getCurrentUrl ? await page.getCurrentUrl() : null;
  if (url && url.includes('labs.google/fx') && url.includes('flow')) {
    const m = url.match(/\/project\/([0-9a-f-]+)/);
    return { projectId: m ? m[1] : null };
  }
  const state = loadState();
  const target = state.currentProjectId
    ? `${FLOW_HOME}/project/${state.currentProjectId}`
    : FLOW_HOME;
  await page.goto(target, { settleMs: 3500 });
  // Belt-and-suspenders: explicitly wait for grecaptcha to load so subsequent
  // recaptcha-bearing requests work without a race.
  await page.evaluate(`(async () => {
    const t = Date.now();
    while (location.href === 'about:blank' && Date.now() - t < 5000) await new Promise(r => setTimeout(r, 100));
  })()`);
  const url2 = page.getCurrentUrl ? await page.getCurrentUrl() : null;
  const m = url2 ? url2.match(/\/project\/([0-9a-f-]+)/) : null;
  return { projectId: m ? m[1] : null };
}

/**
 * Run a fetch() call from inside the Flow page and return { status, body }.
 * `body` is auto-parsed JSON when possible, else the raw text.
 *
 * For aisandbox-pa.googleapis.com endpoints, automatically injects
 * `Authorization: Bearer <access_token>` from the /fx/api/auth/session response.
 */
export async function flowFetch(
  page: IPage,
  url: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: any; ok: boolean }> {
  const method = init?.method ?? 'GET';
  const headers = init?.headers ?? {};
  const bodyStr = init?.body == null
    ? null
    : typeof init.body === 'string'
      ? init.body
      : JSON.stringify(init.body);
  const needsAuth = url.includes('aisandbox-pa.googleapis.com');

  const js = `
    (async () => {
      try {
        const headers = ${JSON.stringify({ 'content-type': 'application/json', ...headers })};
        if (${JSON.stringify(needsAuth)}) {
          const s = await fetch('/fx/api/auth/session').then(r => r.json()).catch(() => null);
          if (s && s.access_token) headers['authorization'] = 'Bearer ' + s.access_token;
        }
        const init = { method: ${JSON.stringify(method)}, headers, credentials: 'include' };
        ${bodyStr !== null ? `init.body = ${JSON.stringify(bodyStr)};` : ''}
        const r = await fetch(${JSON.stringify(url)}, init);
        const txt = await r.text();
        let body;
        try { body = JSON.parse(txt); } catch { body = txt; }
        return { status: r.status, ok: r.ok, body };
      } catch (e) {
        return { status: 0, ok: false, body: { error: String((e && e.message) || e) } };
      }
    })()
  `;
  return (await page.evaluate(js)) as any;
}

/**
 * Fetch fresh reCAPTCHA Enterprise token for the Flow site key.
 * Runs grecaptcha.enterprise.execute() inside the page.
 */
export async function getRecaptchaToken(page: IPage): Promise<string> {
  const js = `
    (async () => {
      // wait up to 5s for grecaptcha to be ready
      const start = Date.now();
      while (!(window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.execute)) {
        if (Date.now() - start > 5000) throw new Error('grecaptcha.enterprise not ready');
        await new Promise(r => setTimeout(r, 100));
      }
      // The site key was extracted from the recaptcha endpoint URL during analysis.
      const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
      // action name must match what Flow UI uses, otherwise Google returns
      // 403 PUBLIC_ERROR_UNUSUAL_ACTIVITY (reCAPTCHA evaluation failed).
      return await window.grecaptcha.enterprise.execute(SITE_KEY, { action: 'VIDEO_GENERATION' });
    })()
  `;
  return (await page.evaluate(js)) as string;
}

/**
 * Pull the labs.google cookies out of the page and format them as a single
 * Cookie header value. Used when issuing requests to `labs.google` endpoints
 * directly from Node (which do not accept OAuth Bearer — they are
 * session-cookie authenticated).
 */
export async function getLabsCookieHeader(page: IPage): Promise<string> {
  const cookies = await page.getCookies({ domain: 'labs.google' });
  if (!cookies || cookies.length === 0) {
    throw new Error('未能从 page 获取 labs.google cookie；Flow 可能未登录');
  }
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Read the OAuth access_token out of the Flow session and hand it to the
 * Node process so we can issue requests directly (bypassing CDP's
 * page.evaluate message-size limit for large bodies like base64 images).
 */
export async function getAccessToken(page: IPage): Promise<string> {
  const t = await page.evaluate(`(async () => {
    const s = await fetch('/fx/api/auth/session').then(r => r.json()).catch(() => null);
    return s && s.access_token ? s.access_token : '';
  })()`);
  if (!t) throw new Error('未拿到 access_token；请确保 Chrome 已登录 Flow');
  return String(t);
}

/** Get the session token labs.google sets — used as sessionId in clientContext. */
export async function getSessionId(page: IPage): Promise<string> {
  const js = `
    (async () => {
      const r = await fetch('/fx/api/auth/session');
      const d = await r.json().catch(() => null);
      return ';' + Date.now();
    })()
  `;
  return (await page.evaluate(js)) as string;
}

/** Tagged error so CLI can surface a stable error code. */
export class FlowError extends Error {
  code: string;
  retryable: boolean;
  details?: any;
  constructor(code: string, message: string, retryable: boolean, details?: any) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

/**
 * Classify a server error into retryable / non-retryable categories.
 * The user reported that refresh-and-retry usually fixes transient issues,
 * but content-policy violations cannot be recovered.
 */
export function classifyError(status: number, body: any): FlowError {
  const text = JSON.stringify(body || {}).toLowerCase();
  // Hard policy errors — never retry, surface to user/agent.
  if (text.includes('celebrity') || text.includes('public figure')) {
    return new FlowError('CELEBRITY_POLICY', 'celebrity / public-figure policy violation', false, body);
  }
  if (text.includes('content_policy') || text.includes('safety') || text.includes('blocked')) {
    return new FlowError('CONTENT_POLICY', 'content policy violation', false, body);
  }
  if (status === 401 || status === 403) {
    return new FlowError('AUTH', 'authentication / authorization failed — re-login Flow in the bound Chrome', false, body);
  }
  // Soft errors — retry with backoff.
  if (status === 429) return new FlowError('RATE_LIMIT', 'rate limited', true, body);
  if (status >= 500) return new FlowError('SERVER_ERROR', `server ${status}`, true, body);
  if (status === 0) return new FlowError('NETWORK', 'network / bridge error', true, body);
  // 4xx other — usually bad input, not retryable.
  return new FlowError('CLIENT_ERROR', `client error ${status}`, false, body);
}

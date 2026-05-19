/**
 * flow media-upload / media-list / media-show
 *
 * Image upload with sha256-keyed dedupe + cross-process file lock, so multiple
 * agents working on the same project never upload the same asset twice.
 *
 * Resolution rule for `--refs <list>` consumed by `flow gen`:
 *   1. if token looks like a hex UUID (e.g. `9a42af9d-…`) → use as mediaId
 *   2. else if a local file at that path exists → upload (or cache hit) and use
 *   3. else look up alias in media-cache.json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  SITE, FLOW_BASE, FLOW_ORIGIN, inFlowPage, getAccessToken, getLabsCookieHeader, classifyError,
  loadState, loadMediaCache, saveMediaCache, projectMediaCache,
  sha256OfFile, withProjectShaLock,
  type MediaCacheEntry,
} from './_shared.js';
import { timeFriendly, shortId } from './_format.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function detectMediaType(filePath: string): 'image' | 'video' {
  const ext = path.extname(filePath).toLowerCase();
  return ['.mp4', '.mov', '.webm', '.m4v', '.mkv'].includes(ext) ? 'video' : 'image';
}

/**
 * Upload a local file to Flow (with sha256 dedupe + file lock).
 * Returns the existing mediaId on cache hit, otherwise uploads then returns
 * the new mediaId.
 */
export async function uploadOrReuse(
  page: any,
  filePath: string,
  projectId: string,
  alias?: string,
): Promise<{ mediaId: string; entry: MediaCacheEntry; reused: boolean }> {
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  if (detectMediaType(filePath) === 'video') {
    return uploadVideoOrReuse(page, filePath, projectId, alias);
  }
  const sha = sha256OfFile(filePath);

  // Fast path: cache hit without lock.
  let cache = loadMediaCache();
  let bucket = projectMediaCache(cache, projectId);
  const existing = bucket.by_sha256[sha];
  if (existing) {
    if (alias) {
      bucket.by_alias[alias] = sha;
      saveMediaCache(cache);
    }
    return { mediaId: existing.mediaId, entry: existing, reused: true };
  }

  return await withProjectShaLock(projectId, sha, async () => {
    // Double-check inside lock — another process may have just uploaded.
    cache = loadMediaCache();
    bucket = projectMediaCache(cache, projectId);
    const second = bucket.by_sha256[sha];
    if (second) {
      if (alias) {
        bucket.by_alias[alias] = sha;
        saveMediaCache(cache);
      }
      return { mediaId: second.mediaId, entry: second, reused: true };
    }

    // Real upload — done from Node (not via page.evaluate) because base64 of
    // even a 1 MB image is ~1.4 MB, which exceeds the CDP message size limit
    // and causes ECONNRESET. The OAuth Bearer token is portable, so we just
    // borrow it from the page and POST directly to Google.
    const accessToken = await getAccessToken(page);
    const bytes = fs.readFileSync(filePath);
    const base64 = bytes.toString('base64');
    const resp = await fetch(`${FLOW_BASE}/flow/uploadImage`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        clientContext: { projectId, tool: 'PINHOLE' },
        imageBytes: base64,
      }),
    });
    const respText = await resp.text();
    let respBody: any;
    try { respBody = JSON.parse(respText); } catch { respBody = respText; }
    if (!resp.ok) throw classifyError(resp.status, respBody);
    const m = respBody?.media;
    if (!m?.name) throw new Error(`上传响应缺少 media.name: ${respText.slice(0, 300)}`);
    const r = { ok: true, status: resp.status, body: respBody };

    const entry: MediaCacheEntry = {
      mediaId: m.name,
      workflowId: r.body?.workflow?.name,
      type: 'image',
      displayName: r.body?.workflow?.metadata?.displayName || path.basename(filePath),
      width: m.image?.dimensions?.width,
      height: m.image?.dimensions?.height,
      uploadedAt: new Date().toISOString(),
      projectId,
    };
    bucket.by_sha256[sha] = entry;
    if (alias) bucket.by_alias[alias] = sha;
    saveMediaCache(cache);
    return { mediaId: m.name, entry, reused: false };
  });
}

const VIDEO_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB, matches what Flow UI uses

/**
 * Upload a local video file via Flow's chunked resumable-upload endpoint.
 * Session-cookie authenticated (not OAuth), so we pull cookies from the page.
 *
 * Two-phase protocol:
 *   1. POST /fx/api/upload-video?action=start
 *        Headers: X-Upload-Project-Id, X-Upload-Content-Length, X-Upload-Content-Type, X-Upload-File-Name
 *        → { sessionUrl, status: "active" }
 *   2. PUT /fx/api/upload-video?action=upload  (one or more chunks)
 *        Headers: X-Upload-Session-Url, X-Upload-Offset, X-Upload-Command (last chunk = "upload, finalize"),
 *                 X-Upload-Project-Id, X-Upload-File-Name, Content-Type: application/octet-stream
 *        Body: 2 MB binary chunk
 *        Final response → { status: "final", mediaServerId, workflowServerId, videoWidth, videoHeight }
 */
export async function uploadVideoOrReuse(
  page: any,
  filePath: string,
  projectId: string,
  alias?: string,
): Promise<{ mediaId: string; entry: MediaCacheEntry; reused: boolean }> {
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  const sha = sha256OfFile(filePath);

  // Cache hit (fast path)
  let cache = loadMediaCache();
  let bucket = projectMediaCache(cache, projectId);
  const existing = bucket.by_sha256[sha];
  if (existing) {
    if (alias) { bucket.by_alias[alias] = sha; saveMediaCache(cache); }
    return { mediaId: existing.mediaId, entry: existing, reused: true };
  }

  return await withProjectShaLock(projectId, sha, async () => {
    // Double-check under lock
    cache = loadMediaCache();
    bucket = projectMediaCache(cache, projectId);
    const second = bucket.by_sha256[sha];
    if (second) {
      if (alias) { bucket.by_alias[alias] = sha; saveMediaCache(cache); }
      return { mediaId: second.mediaId, entry: second, reused: true };
    }

    const cookieHeader = await getLabsCookieHeader(page);
    const fileName = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;

    // Step 1: start
    const startResp = await fetch(`${FLOW_ORIGIN}/fx/api/upload-video?action=start`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        'X-Upload-Project-Id': projectId,
        'X-Upload-Content-Length': String(fileSize),
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-File-Name': fileName,
      },
    });
    if (!startResp.ok) {
      throw classifyError(startResp.status, await startResp.text().catch(() => ''));
    }
    const startData: any = await startResp.json();
    if (startData.status !== 'active' || !startData.sessionUrl) {
      throw new Error('upload start failed: ' + JSON.stringify(startData));
    }
    const sessionUrl = startData.sessionUrl;

    // Step 2: upload chunks
    const bytes = fs.readFileSync(filePath);
    let lastResp: any = null;
    for (let offset = 0; offset < fileSize; offset += VIDEO_CHUNK_SIZE) {
      const end = Math.min(offset + VIDEO_CHUNK_SIZE, fileSize);
      const chunk = bytes.subarray(offset, end);
      const isLast = end >= fileSize;
      const r = await fetch(`${FLOW_ORIGIN}/fx/api/upload-video?action=upload`, {
        method: 'PUT',
        headers: {
          cookie: cookieHeader,
          'X-Upload-Session-Url': sessionUrl,
          'X-Upload-Offset': String(offset),
          'X-Upload-Command': isLast ? 'upload, finalize' : 'upload',
          'X-Upload-Project-Id': projectId,
          'X-Upload-File-Name': fileName,
          'Content-Type': 'application/octet-stream',
        },
        body: chunk,
      });
      if (!r.ok) {
        throw classifyError(r.status, await r.text().catch(() => ''));
      }
      lastResp = await r.json().catch(() => null);
    }

    if (!lastResp || lastResp.status !== 'final' || !lastResp.mediaServerId) {
      throw new Error('upload finalize failed: ' + JSON.stringify(lastResp));
    }

    const entry: MediaCacheEntry = {
      mediaId: lastResp.mediaServerId,
      workflowId: lastResp.workflowServerId,
      type: 'video',
      displayName: lastResp.workflowDisplayName || fileName,
      width: lastResp.videoWidth,
      height: lastResp.videoHeight,
      uploadedAt: new Date().toISOString(),
      projectId,
    };
    bucket.by_sha256[sha] = entry;
    if (alias) bucket.by_alias[alias] = sha;
    saveMediaCache(cache);
    return { mediaId: lastResp.mediaServerId, entry, reused: false };
  });
}

/**
 * Resolve a single ref token (used by `flow gen --refs`) into a mediaId.
 * Auto-uploads if the token is a local file path. For images only.
 */
export async function resolveRefToken(
  page: any,
  token: string,
  projectId: string,
): Promise<{ mediaId: string; source: 'uuid' | 'alias' | 'upload-fresh' | 'upload-cached' }> {
  const t = token.trim();
  if (!t) throw new Error('参考素材 token 为空');
  if (UUID_RE.test(t)) return { mediaId: t, source: 'uuid' };
  if (fs.existsSync(t)) {
    if (detectMediaType(t) === 'video') {
      throw new Error(`--refs 只接受图片；视频请用 --ref-video（文件路径会自动 chunked upload）`);
    }
    const res = await uploadOrReuse(page, t, projectId);
    return { mediaId: res.mediaId, source: res.reused ? 'upload-cached' : 'upload-fresh' };
  }
  const cache = loadMediaCache();
  const bucket = cache.projects[projectId];
  const sha = bucket?.by_alias[t];
  if (sha && bucket?.by_sha256[sha]) {
    if (bucket.by_sha256[sha].type === 'video') {
      throw new Error(`别名 "${t}" 对应的是视频；--refs 只能用图片别名，视频请用 --ref-video`);
    }
    return { mediaId: bucket.by_sha256[sha].mediaId, source: 'alias' };
  }
  throw new Error(`无法解析参考素材 "${t}"：不是 UUID、本地文件，也不是当前项目下的别名`);
}

/**
 * Resolve a video reference for `flow gen --ref-video` (abra_edit path).
 * Same alias/path/UUID semantics, but only accepts videos.
 */
export async function resolveVideoRef(
  page: any,
  token: string,
  projectId: string,
): Promise<{ mediaId: string; source: 'uuid' | 'alias' | 'upload-fresh' | 'upload-cached' }> {
  const t = token.trim();
  if (!t) throw new Error('--ref-video 不能为空');
  if (UUID_RE.test(t)) return { mediaId: t, source: 'uuid' };
  if (fs.existsSync(t)) {
    if (detectMediaType(t) !== 'video') {
      throw new Error(`--ref-video 只接受视频文件（.mp4/.mov 等）；图片请用 --refs`);
    }
    const res = await uploadVideoOrReuse(page, t, projectId);
    return { mediaId: res.mediaId, source: res.reused ? 'upload-cached' : 'upload-fresh' };
  }
  const cache = loadMediaCache();
  const bucket = cache.projects[projectId];
  const sha = bucket?.by_alias[t];
  if (sha && bucket?.by_sha256[sha]) {
    if (bucket.by_sha256[sha].type !== 'video') {
      throw new Error(`别名 "${t}" 对应的是图片；--ref-video 需要视频别名`);
    }
    return { mediaId: bucket.by_sha256[sha].mediaId, source: 'alias' };
  }
  throw new Error(`无法解析视频 "${t}"：不是 UUID、本地文件，也不是当前项目下的视频别名`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI commands
// ─────────────────────────────────────────────────────────────────────────────

cli({
  site: SITE,
  name: 'media-upload',
  description: '上传图片或视频到 Flow（自动 sha256 去重；视频走 chunked resumable）',
  access: 'write',
  defaultFormat: 'table',
  strategy: Strategy.COOKIE,
  browser: true,
  domain: 'labs.google',
  navigateBefore: false,
  args: [
    { name: 'file', required: true, help: '本地图片路径' },
    { name: 'name', help: '别名（gen --refs 时可直接用别名引用，跨命令持久）' },
    { name: 'projectId', help: '项目 ID；不传则用默认' },
  ],
  columns: ['任务ID(短)', '别名', '原文件', '尺寸', '处理方式'],
  func: async (page, kwargs) => {
    const { projectId: urlProjectId } = await inFlowPage(page);
    const projectId = String(kwargs.projectId || loadState().currentProjectId || urlProjectId || '');
    if (!projectId) throw new Error('未指定项目 ID');
    const alias = kwargs.name ? String(kwargs.name) : undefined;
    const result = await uploadOrReuse(page, String(kwargs.file), projectId, alias);
    return [{
      '任务ID(短)': shortId(result.mediaId),
      别名: alias ?? '—',
      原文件: result.entry.displayName ?? path.basename(String(kwargs.file)),
      尺寸: result.entry.width && result.entry.height
        ? `${result.entry.width}×${result.entry.height}`
        : '—',
      处理方式: result.reused ? '✅ 缓存复用' : '⬆️ 新上传',
      mediaId: result.mediaId,
    }];
  },
  footerExtra: (kwargs) => kwargs.name
    ? `引用：\`flow gen --refs ${kwargs.name} --prompt "..." --length 8 --yes\``
    : '建议下次加 --name <别名> 让后续 gen 用别名引用，比 mediaId 短',
});

cli({
  site: SITE,
  name: 'media-list',
  description: '列出已上传/缓存的图片素材（按当前项目隔离；含别名映射）',
  access: 'read',
  defaultFormat: 'table',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'projectId', help: '项目 ID；不传则用默认' },
  ],
  columns: ['任务ID(短)', '别名', '原文件', '尺寸', '上传时间'],
  func: async (kwargs) => {
    const projectId = String(kwargs.projectId || loadState().currentProjectId || '');
    if (!projectId) throw new Error('未指定项目 ID。请先运行 flow project-use');
    const cache = loadMediaCache();
    const bucket = cache.projects[projectId];
    if (!bucket) return [];
    const aliasBySha: Record<string, string[]> = {};
    for (const [alias, sha] of Object.entries(bucket.by_alias)) {
      (aliasBySha[sha] = aliasBySha[sha] || []).push(alias);
    }
    return Object.entries(bucket.by_sha256).map(([sha, entry]) => ({
      '任务ID(短)': shortId(entry.mediaId),
      别名: (aliasBySha[sha] || []).join(', ') || '—',
      原文件: entry.displayName || '—',
      尺寸: entry.width && entry.height ? `${entry.width}×${entry.height}` : '—',
      上传时间: timeFriendly(entry.uploadedAt),
      mediaId: entry.mediaId,
      sha256: sha,
    }));
  },
  footerExtra: () => '在 gen 时引用：`flow gen --refs <别名> --prompt "..."`',
});

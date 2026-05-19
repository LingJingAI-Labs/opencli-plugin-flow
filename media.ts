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
  SITE, FLOW_BASE, inFlowPage, getAccessToken, classifyError,
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
    throw new Error(`视频上传暂未支持: ${filePath}（先用图片）`);
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

/**
 * Resolve a single ref token (used by `flow gen --refs`) into a mediaId.
 * Auto-uploads if the token is a local file path.
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
    const res = await uploadOrReuse(page, t, projectId);
    return { mediaId: res.mediaId, source: res.reused ? 'upload-cached' : 'upload-fresh' };
  }
  const cache = loadMediaCache();
  const bucket = cache.projects[projectId];
  const sha = bucket?.by_alias[t];
  if (sha && bucket?.by_sha256[sha]) return { mediaId: bucket.by_sha256[sha].mediaId, source: 'alias' };
  throw new Error(`无法解析参考素材 "${t}"：不是 UUID、本地文件，也不是当前项目下的别名`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI commands
// ─────────────────────────────────────────────────────────────────────────────

cli({
  site: SITE,
  name: 'media-upload',
  description: '上传图片到 Flow（自动 sha256 去重；同一文件不会重复上传）',
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

/**
 * flow job-status / job-wait / job-download / job-list
 *
 * Read-side commands for generated videos. State is fetched from the trpc
 * `flow.projectInitialData` endpoint (includes per-media generation status),
 * and the actual mp4 is downloaded via `/fx/api/trpc/media.getMediaUrlRedirect`.
 */
import * as fs from 'node:fs';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { SITE, FLOW_ORIGIN, inFlowPage, flowFetch, loadState, classifyError } from './_shared.js';
import { statusFriendly, modelFriendly, aspectFriendly, shortId, timeFriendly, truncate } from './_format.js';

async function fetchProjectMedia(page: any, projectId: string) {
  const input = encodeURIComponent(JSON.stringify({ json: { projectId } }));
  const r = await flowFetch(page, `${FLOW_ORIGIN}/fx/api/trpc/flow.projectInitialData?input=${input}`);
  if (!r.ok) throw classifyError(r.status, r.body);
  const data = r.body?.result?.data?.json?.projectContents;
  return {
    media: (data?.media ?? []) as any[],
    workflows: (data?.workflows ?? []) as any[],
  };
}

function summarizeMediaFriendly(m: any, opts: { promptMax?: number } = {}) {
  const reqCtl = m.mediaMetadata?.requestData?.videoGenerationRequestData?.videoModelControlInput;
  const statusRaw = m.mediaMetadata?.mediaStatus?.mediaGenerationStatus ?? 'NONE';
  const fullPrompt = m.mediaMetadata?.mediaTitle ?? '';
  return {
    任务ID: shortId(m.name),
    状态: statusFriendly(statusRaw),
    提示词: opts.promptMax ? truncate(fullPrompt, opts.promptMax) : fullPrompt,
    模型: modelFriendly(reqCtl?.videoModelName),
    宽高比: aspectFriendly(reqCtl?.videoAspectRatio),
    时长: m.video?.dimensions?.length ?? '',
    创建时间: timeFriendly(m.mediaMetadata?.createTime),
    // raw fields for agent parsing — not in `columns`, so hidden from table view
    mediaId: m.name,
    workflowId: m.workflowId,
    status_raw: statusRaw,
    model_raw: reqCtl?.videoModelName,
    aspect_raw: reqCtl?.videoAspectRatio,
    提示词_完整: fullPrompt,
  };
}

cli({
  site: SITE,
  name: 'job-status',
  description: '查询某个生成任务的当前状态（按任务 ID）',
  access: 'read',
  defaultFormat: 'table',
  strategy: Strategy.COOKIE,
  browser: true,
  domain: 'labs.google',
  navigateBefore: false,
  args: [
    { name: 'mediaId', required: true, help: '任务 ID（flow gen 返回的 mediaId）' },
    { name: 'projectId', help: '项目 ID；不传则用默认' },
  ],
  columns: ['任务ID', '状态', '提示词', '模型', '宽高比', '时长', '创建时间'],
  func: async (page, kwargs) => {
    const { projectId: urlProjectId } = await inFlowPage(page);
    const projectId = String(kwargs.projectId || loadState().currentProjectId || urlProjectId || '');
    if (!projectId) throw new Error('未指定项目 ID。请先运行 flow project-use 或在 Flow 网页打开一个项目');
    const { media } = await fetchProjectMedia(page, projectId);
    const m = media.find((x) => x.name === kwargs.mediaId);
    if (!m) {
      return [{
        任务ID: shortId(String(kwargs.mediaId)),
        状态: '❓ 未找到',
        提示词: '（任务可能还在排队，或不在当前项目里）',
        模型: '', 宽高比: '', 时长: '', 创建时间: '',
        mediaId: kwargs.mediaId,
        status_raw: 'NOT_FOUND',
      }];
    }
    return [summarizeMediaFriendly(m)];
  },
  footerExtra: (kwargs) => `已完成时下载：\`flow job-download --mediaId ${kwargs.mediaId} --out out.mp4\``,
});

cli({
  site: SITE,
  name: 'job-wait',
  description: '等待视频生成任务结束（轮询，直到完成 / 失败 / 超时）',
  access: 'read',
  defaultFormat: 'table',
  strategy: Strategy.COOKIE,
  browser: true,
  domain: 'labs.google',
  navigateBefore: false,
  args: [
    { name: 'mediaId', required: true, help: '任务 ID' },
    { name: 'timeoutSeconds', type: 'int', default: 300, help: '最大等待秒数；默认 300（5 分钟，Omni 4-10s 通常 2-4 分钟完成）' },
    { name: 'pollSeconds', type: 'int', default: 10, help: '轮询间隔秒，默认 10' },
    { name: 'projectId', help: '项目 ID；不传则用默认' },
  ],
  columns: ['任务ID', '最终状态', '提示词', '等待秒数'],
  func: async (page, kwargs) => {
    const { projectId: urlProjectId } = await inFlowPage(page);
    const projectId = String(kwargs.projectId || loadState().currentProjectId || urlProjectId || '');
    if (!projectId) throw new Error('未指定项目 ID');
    const mediaId = String(kwargs.mediaId);
    const timeoutMs = Math.max(5, Number(kwargs.timeoutSeconds) || 300) * 1000;
    const pollMs = Math.max(2, Number(kwargs.pollSeconds) || 10) * 1000;
    const start = Date.now();
    while (true) {
      const { media } = await fetchProjectMedia(page, projectId);
      const m = media.find((x) => x.name === mediaId);
      const status = m?.mediaMetadata?.mediaStatus?.mediaGenerationStatus ?? 'NOT_FOUND';
      const elapsed = Math.round((Date.now() - start) / 1000);
      const ended = status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' || status === 'MEDIA_GENERATION_STATUS_FAILED' || status === 'MEDIA_GENERATION_STATUS_CANCELLED';
      if (ended) {
        return [{
          任务ID: shortId(mediaId),
          最终状态: statusFriendly(status),
          提示词: (m?.mediaMetadata?.mediaTitle ?? '').slice(0, 50),
          等待秒数: elapsed,
          mediaId, status_raw: status,
        }];
      }
      if (Date.now() - start >= timeoutMs) {
        return [{
          任务ID: shortId(mediaId),
          最终状态: `⏱️ 超时（当前 ${statusFriendly(status)}）`,
          提示词: (m?.mediaMetadata?.mediaTitle ?? '').slice(0, 50),
          等待秒数: elapsed,
          mediaId, status_raw: 'TIMEOUT_' + status,
        }];
      }
      await new Promise((res) => setTimeout(res, pollMs));
    }
  },
  footerExtra: (kwargs) => `下载：\`flow job-download --mediaId ${kwargs.mediaId} --out out.mp4\``,
});

cli({
  site: SITE,
  name: 'job-download',
  description: '下载已生成完成的视频 mp4 到本地',
  access: 'read',
  defaultFormat: 'table',
  strategy: Strategy.COOKIE,
  browser: true,
  domain: 'labs.google',
  navigateBefore: false,
  args: [
    { name: 'mediaId', required: true, help: '任务 ID' },
    { name: 'out', required: true, help: '保存路径（含 .mp4 文件名）' },
  ],
  columns: ['任务ID', '已保存到', '大小'],
  func: async (page, kwargs) => {
    const mediaId = String(kwargs.mediaId);
    const outPath = String(kwargs.out);

    // Ensure we are on a labs.google page so trpc redirect resolves correctly.
    await inFlowPage(page);

    // Step 1: from the page, fetch the redirect endpoint with redirect:manual
    // and pull the signed CDN URL out of the Location header. Doing the
    // redirect inside the page would CORS-fail because the target host
    // (flow-content.google) does not return ACAO headers for the bridge's
    // isolated-world origin.
    const redirUrl = `${FLOW_ORIGIN}/fx/api/trpc/media.getMediaUrlRedirect?name=${encodeURIComponent(mediaId)}`;
    // NB: explicitly avoid credentials: 'include' — the redirect target lives
    // on flow-content.google which does not support CORS credentialed mode,
    // so including credentials makes the cross-origin redirect fail before
    // we can read the final URL. The signed URL is self-authenticating
    // (Expires + Signature query params), so cookies are not needed anyway.
    const probeJs = `
      (async () => {
        const r = await fetch(${JSON.stringify(redirUrl)});
        return { ok: r.ok, status: r.status, finalUrl: r.url, ct: r.headers.get('content-type') || '' };
      })()
    `;
    const probe = (await page.evaluate(probeJs)) as any;
    if (!probe?.ok || !probe?.finalUrl) {
      throw new Error(`getMediaUrlRedirect failed: ${JSON.stringify(probe)}`);
    }
    const signedUrl: string = probe.finalUrl;

    // Step 2: download the signed URL from Node (no CORS, no isolated-world
    // boundary). Signed CDN URLs do not require cookies; they are
    // self-authenticating with Expires + Signature.
    const dl = await fetch(signedUrl);
    if (!dl.ok) throw new Error(`signed download failed: status=${dl.status}`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    fs.writeFileSync(outPath, bytes);
    const sizeKb = (bytes.length / 1024).toFixed(1);
    return [{
      任务ID: shortId(mediaId),
      已保存到: outPath,
      大小: `${sizeKb} KB`,
      mediaId, sizeBytes: bytes.length,
    }];
  },
  footerExtra: (kwargs) => `本地预览：\`open ${kwargs.out}\``,
});

cli({
  site: SITE,
  name: 'job-list',
  description: '列出当前项目的视频生成任务（按时间倒序）',
  access: 'read',
  defaultFormat: 'table',
  strategy: Strategy.COOKIE,
  browser: true,
  domain: 'labs.google',
  navigateBefore: false,
  args: [
    { name: 'projectId', help: '项目 ID；不传则用默认' },
    { name: 'limit', type: 'int', default: 20, help: '返回条数，按时间倒序' },
    { name: 'status', help: '过滤状态：done(已完成) / failed(失败) / pending(等待中)；不传显示全部' },
    { name: 'full', type: 'boolean', default: false, help: '不截断提示词。配合 `-f csv` 可看完整内容' },
  ],
  columns: ['任务ID', '状态', '提示词', '模型', '宽高比', '时长', '创建时间'],
  func: async (page, kwargs) => {
    const { projectId: urlProjectId } = await inFlowPage(page);
    const projectId = String(kwargs.projectId || loadState().currentProjectId || urlProjectId || '');
    if (!projectId) throw new Error('未指定项目 ID');
    const { media } = await fetchProjectMedia(page, projectId);
    const videos = media.filter((m) => m.video);
    // Map friendly status filter to raw enum
    const filterMap: Record<string, string> = {
      done: 'MEDIA_GENERATION_STATUS_SUCCESSFUL',
      success: 'MEDIA_GENERATION_STATUS_SUCCESSFUL',
      failed: 'MEDIA_GENERATION_STATUS_FAILED',
      pending: 'MEDIA_GENERATION_STATUS_SCHEDULED',
    };
    const wantStatus = kwargs.status ? (filterMap[String(kwargs.status)] || String(kwargs.status)) : null;
    const filtered = wantStatus
      ? videos.filter((m) => m.mediaMetadata?.mediaStatus?.mediaGenerationStatus === wantStatus)
      : videos;
    const sorted = [...filtered].sort((a, b) =>
      (b.mediaMetadata?.createTime || '').localeCompare(a.mediaMetadata?.createTime || ''),
    );
    const promptMax = kwargs.full ? undefined : 28;
    return sorted.slice(0, Number(kwargs.limit) || 20).map((m) => summarizeMediaFriendly(m, { promptMax }));
  },
  footerExtra: (kwargs) => kwargs.full
    ? '已显示完整提示词；配合 `-f csv` 一行一条易复制'
    : '提示词截断到 28 字符；要看完整 → 加 `--full` 或 `flow job-status --mediaId <id>`',
});

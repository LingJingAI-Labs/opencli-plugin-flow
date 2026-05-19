/**
 * flow gen — generate a video on Omni Flash.
 *
 * V1 scope:
 *   - T2V (text-to-video) fully supported
 *   - R2V / abra_edit args parsed but only T2V execution path is wired up
 *     (R2V wiring depends on media-upload + character/voice flows, next milestone)
 *
 * Cost is always shown as a dry-run preview first; --yes auto-confirms.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import * as crypto from 'node:crypto';
import {
  SITE, FLOW_BASE, inFlowPage, flowFetch, getRecaptchaToken, classifyError, FlowError, loadState,
} from './_shared.js';
import {
  OMNI, VALID_LENGTHS, VALID_ASPECTS, aspectToEnum, pickModel, totalCost, validateAgainstModel,
  type Aspect, type GenInputs, type ModelSpec,
} from './_models.js';
import { modelFriendly, shortId } from './_format.js';
import { resolveRefToken, resolveVideoRef } from './media.js';

function uuid(): string {
  return (crypto as any).randomUUID ? (crypto as any).randomUUID() : crypto.randomBytes(16).toString('hex');
}

function parseRefs(refs: string | string[] | undefined): { alias: string; value: string }[] {
  if (!refs) return [];
  const arr = Array.isArray(refs) ? refs : [refs];
  return arr.filter(Boolean).map((s) => {
    const m = String(s).match(/^([\w-]+)=(.+)$/);
    if (!m) throw new Error(`--ref must be in form alias=path-or-mediaId, got: ${s}`);
    return { alias: m[1], value: m[2] };
  });
}

cli({
  site: SITE,
  name: 'gen',
  description: '用 Google Omni 生成视频（纯文字 / 多参考图，--refs 引用别名 / 路径 / mediaId）',
  access: 'write',
  defaultFormat: 'table',
  strategy: Strategy.COOKIE,
  browser: true,
  domain: 'labs.google',
  navigateBefore: false,
  args: [
    { name: 'prompt', required: true, help: '生成提示词' },
    { name: 'length', type: 'int', default: 8, help: '视频时长秒数：4 / 6 / 8 / 10' },
    { name: 'aspect', default: '9:16', choices: ['9:16', '16:9'], help: '宽高比' },
    { name: 'count', type: 'int', default: 1, help: '一次生成的样本数；每多 1 个加一份积分' },
    { name: 'projectId', help: '项目 ID；不传则用 flow project-use 设置的默认值或当前页面' },
    { name: 'model', help: '强制指定模型；默认根据 --refs/--refVideo 自动选。友好别名：edit / t2v-8s / r2v-8s 等' },
    { name: 'seed', type: 'int', help: '随机种子，默认随机' },
    { name: 'dryRun', type: 'boolean', default: false, help: '只算积分不真发请求' },
    { name: 'yes', type: 'boolean', default: false, help: '跳过 dry-run 确认，直接提交（agent 用）' },
    { name: 'reload', type: 'boolean', default: false, help: '提交前先 reload Flow 页面（拿 fresh reCAPTCHA / session，规避 PUBLIC_ERROR_UNUSUAL_ACTIVITY 风控）' },
    { name: 'refs', help: '参考图列表，逗号分隔；每个 token 可以是：别名 / 本地图片路径 / mediaId UUID。示例：--refs cat,./bg.jpg,9a42af9d-... （含路径会自动上传去重）' },
    { name: 'refVideo', help: '参考视频（触发视频编辑模式 abra_edit，40 积分固定）。可填别名/本地视频路径/mediaId UUID。例：--refVideo ./clip.mp4 --prompt "改成晚上"' },
  ],
  columns: ['状态', '任务ID(短)', '模型', '消耗积分', '余额', '备注'],
  footerExtra: (kwargs) => {
    if (kwargs.dryRun) return '加 --yes 真发；不带 --yes 也只是预览不扣费';
    if (!kwargs.yes) return '确认无误 → 复用同样参数加 --yes 提交';
    return '跟踪：`flow job-wait --mediaId <ID>` → `flow job-download --out out.mp4`';
  },
  func: async (page, kwargs) => {
    const length = Number(kwargs.length);
    const aspect = String(kwargs.aspect) as Aspect;
    const count = Math.max(1, Number(kwargs.count) || 1);
    const prompt = String(kwargs.prompt || '').trim();
    if (!prompt) throw new Error('--prompt is required');
    if (!(VALID_LENGTHS as readonly number[]).includes(length)) {
      throw new Error(`--length must be one of ${VALID_LENGTHS.join(', ')}`);
    }
    if (!VALID_ASPECTS.includes(aspect)) {
      throw new Error(`--aspect must be 9:16 or 16:9`);
    }

    // Parse --refs / --refVideo first so we know which model variant we need.
    const refsRaw = kwargs.refs ? String(kwargs.refs).trim() : '';
    const refTokens = refsRaw ? refsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const refVideoRaw = kwargs.refVideo ? String(kwargs.refVideo).trim() : '';

    const input: GenInputs = {
      length, count,
      imagesN: refTokens.length,
      charactersN: 0,
      audioRefsN: 0,
      hasReferenceVideo: refVideoRaw.length > 0,
    };
    const model: ModelSpec = pickModel(input, kwargs.model ? String(kwargs.model) : undefined);
    const validateErrs = validateAgainstModel(model, input);
    if (validateErrs.length) throw new Error(validateErrs.join('; '));
    const cost = totalCost(model, count);

    const { projectId: pageProjectId } = await inFlowPage(page);
    const projectId = String(kwargs.projectId || loadState().currentProjectId || pageProjectId || '');
    if (!projectId) {
      throw new Error('未指定项目 ID。请先运行 flow project-use 或在 Flow 网页打开一个项目');
    }

    // Resolve each ref token → mediaId (auto-uploads local file paths via cache).
    // Done eagerly here so dry-run also surfaces upload activity, and so
    // failures (missing alias / file) happen before we spend a single credit.
    const refMediaIds: string[] = [];
    const refSources: string[] = [];
    for (const tok of refTokens) {
      const r = await resolveRefToken(page, tok, projectId);
      refMediaIds.push(r.mediaId);
      refSources.push(`${tok}→${r.source}`);
    }

    // Resolve --refVideo (single video for abra_edit mode)
    let refVideoMediaId: string | undefined;
    let refVideoSource: string | undefined;
    if (refVideoRaw) {
      const v = await resolveVideoRef(page, refVideoRaw, projectId);
      refVideoMediaId = v.mediaId;
      refVideoSource = `${refVideoRaw}→${v.source}`;
    }

    // Always check current balance + tier for the preview. The tier value is
    // sent back to the server in clientContext.userPaygateTier; hard-coding a
    // wrong tier causes silent failures (request looks like a different account
    // tier than the OAuth subject), so we mirror what /v1/credits reports.
    const balResp = await flowFetch(page, `${FLOW_BASE}/credits?key=AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY`);
    const balance = balResp.ok ? Number(balResp.body?.credits ?? 0) : 0;
    const userPaygateTier: string = balResp.body?.userPaygateTier ?? 'PAYGATE_TIER_ONE';

    const noteParts: string[] = [];
    if (refVideoMediaId) noteParts.push(`参考视频 1 段（${refVideoSource}）→ 视频编辑模式`);
    if (refMediaIds.length > 0) noteParts.push(`参考图 ${refMediaIds.length} 张（${refSources.join(' / ')}）`);
    const refNote = noteParts.length ? noteParts.join('；') : '无参考素材';

    if (kwargs.dryRun) {
      return [{
        状态: '🔍 试算',
        '任务ID(短)': '—',
        模型: modelFriendly(model.key),
        消耗积分: cost,
        余额: `${balance} → ${balance - cost}（如果真发）`,
        备注: `试算模式未提交；${refNote}`,
        ok: true, model_raw: model.key, cost_raw: cost, refMediaIds,
      }];
    }

    if (!kwargs.yes) {
      return [{
        状态: '⚠️ 待确认',
        '任务ID(短)': '—',
        模型: modelFriendly(model.key),
        消耗积分: cost,
        余额: `${balance} → ${balance - cost}（如果真发）`,
        备注: `加 --yes 才真正提交；${refNote}`,
        ok: false, model_raw: model.key, cost_raw: cost, refMediaIds,
      }];
    }

    if (cost > balance) {
      throw new FlowError('INSUFFICIENT_CREDITS', `need ${cost} credits, have ${balance}`, false);
    }

    // Optional reload to refresh reCAPTCHA / session state. Recommended when a
    // previous submit returned a stub workflow (PATCH 404) or when the shared
    // account is being used concurrently from another machine.
    if (kwargs.reload) {
      const cur = page.getCurrentUrl ? await page.getCurrentUrl() : null;
      if (cur) await page.goto(cur, { settleMs: 2500 });
      await page.wait({ time: 1 });
    }

    const recaptchaToken = await getRecaptchaToken(page);
    const batchId = uuid();
    const seed = Number.isFinite(Number(kwargs.seed))
      ? Number(kwargs.seed)
      : Math.floor(Math.random() * 1_000_000);

    const body = {
      mediaGenerationContext: { batchId, audioFailurePreference: 'BLOCK_SILENCED_VIDEOS' },
      clientContext: {
        projectId,
        tool: 'PINHOLE',
        userPaygateTier,
        sessionId: ';' + Date.now(),
        recaptchaContext: {
          token: recaptchaToken,
          applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
        },
      },
      requests: Array.from({ length: count }, () => {
        const baseReq: any = {
          aspectRatio: aspectToEnum(aspect),
          textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
          videoModelKey: model.key,
          seed,
          metadata: {},
        };
        if (refVideoMediaId) {
          // abra_edit (video editing) — videoInput references an uploaded mp4
          // by its mediaId. startFrameIndex/endFrameIndex select the segment
          // (default 0..240 ≈ first 10s at 24 fps).
          baseReq.videoInput = {
            mediaId: refVideoMediaId,
            startFrameIndex: 0,
            endFrameIndex: 240,
          };
        }
        if (refMediaIds.length > 0) {
          // abra_edit ALSO accepts referenceImages alongside videoInput (verified
          // via API probe — server accepts both fields, max 5 images including
          // characters). For R2V the same field is the only ref input.
          //
          // Field name on the wire is `referenceImages` (not `videoGenerationImageInputs`
          // which is what shows up in saved mediaMetadata.requestData).
          // Enum value is `IMAGE_USAGE_TYPE_ASSET` (not `_ASSET_IMAGE`).
          baseReq.referenceImages = refMediaIds.map((mid) => ({
            mediaId: mid,
            imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
          }));
        }
        return baseReq;
      }),
      // useV2ModelConfig is only accepted by T2V / R2V endpoints, NOT by
      // batchAsyncGenerateVideoEditVideo — the edit endpoint rejects it as
      // "Unknown name". Omit for the edit path.
      ...(model.mode === 'edit' ? {} : { useV2ModelConfig: true }),
    };

    // Endpoint depends on the mode:
    //   - text-to-video      → batchAsyncGenerateVideoText
    //   - reference-images   → batchAsyncGenerateVideoReferenceImages (R2V)
    //   - video edit         → batchAsyncGenerateVideoEditVideo (abra_edit)
    const endpoint = model.mode === 'edit'
      ? 'video:batchAsyncGenerateVideoEditVideo'
      : model.mode === 'r2v'
      ? 'video:batchAsyncGenerateVideoReferenceImages'
      : 'video:batchAsyncGenerateVideoText';
    const r = await flowFetch(page, `${FLOW_BASE}/${endpoint}`, {
      method: 'POST',
      body,
    });
    if (!r.ok) throw classifyError(r.status, r.body);

    const media = r.body?.media?.[0];
    const workflows = r.body?.workflows || [];
    const mediaId: string | undefined = media?.name;
    const workflowId: string | undefined = workflows[0]?.name ?? media?.workflowId;
    const remaining = r.body?.remainingCredits;

    // CRITICAL: Flow UI only displays workflows that have been PATCHed with
    // metadata.primaryMediaId; without this step the workflow is orphaned
    // server-side and never shows up in the user's media list.
    //
    // The displayName / batchId are populated server-side from the generate
    // call's mediaTitle, so this PATCH only updates primaryMediaId.
    let patchStatus: 'ok' | 'stub_404' | 'patch_error' = 'ok';
    if (workflowId && mediaId) {
      const pr = await flowFetch(page, `${FLOW_BASE}/flowWorkflows/${workflowId}`, {
        method: 'PATCH',
        body: {
          workflow: {
            name: workflowId,
            projectId,
            metadata: { primaryMediaId: mediaId },
          },
          updateMask: 'metadata.primaryMediaId',
        },
      });
      // PATCH 404 == server-side "stub workflow" — the batchAsyncGenerate response
      // claimed success and the credits were charged, but the workflow does not
      // really exist (typically Google reCAPTCHA risk-engine silently rejected it).
      if (pr.status === 404) patchStatus = 'stub_404';
      else if (!pr.ok) patchStatus = 'patch_error';
    }

    if (patchStatus === 'stub_404') {
      throw new FlowError(
        'STUB_WORKFLOW',
        `任务似乎被 Google 风控静默拒绝（workflow ${shortId(workflowId)} 在服务端不存在）。` +
        `${cost} 积分已扣，但不会产出视频。请加 --reload 重试一次以拿 fresh session：` +
        `flow gen ... --reload --yes`,
        true,
        { workflowId, mediaId, cost, balance_before: balance, balance_after: remaining },
      );
    }

    return [{
      状态: '✅ 已提交',
      '任务ID(短)': shortId(mediaId ?? ''),
      模型: modelFriendly(model.key),
      消耗积分: cost,
      余额: typeof remaining === 'number' ? remaining : `~${balance - cost}`,
      备注: '已进队列',
      // raw for agent
      ok: true,
      mediaId,
      workflowId,
      batchId,
      model_raw: model.key,
      cost_raw: cost,
    }];
  },
});

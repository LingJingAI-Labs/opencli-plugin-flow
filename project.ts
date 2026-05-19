/**
 * flow project list/use/current/new — manage Flow projects.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { SITE, inFlowPage, flowFetch, loadState, saveState, classifyError } from './_shared.js';
import { timeFriendly, shortId } from './_format.js';

cli({
  site: SITE,
  name: 'project-list',
  description: '列出你的 Flow 项目（按时间倒序，默认前 20 个）',
  access: 'read',
  defaultFormat: 'table',
  strategy: Strategy.COOKIE,
  browser: true,
  domain: 'labs.google',
  navigateBefore: false,
  args: [
    { name: 'pageSize', type: 'number', default: 20, help: '返回条数，默认 20' },
  ],
  columns: ['项目ID(短)', '项目名', '创建时间'],
  func: async (page, kwargs) => {
    await inFlowPage(page);
    const input = encodeURIComponent(JSON.stringify({
      json: { pageSize: Number(kwargs.pageSize) || 20, toolName: 'PINHOLE', cursor: null },
      meta: { values: { cursor: ['undefined'] } },
    }));
    const r = await flowFetch(page, `https://labs.google/fx/api/trpc/project.searchUserProjects?input=${input}`);
    if (!r.ok) throw classifyError(r.status, r.body);
    const projects = r.body?.result?.data?.json?.result?.projects ?? [];
    return projects.map((p: any) => ({
      '项目ID(短)': shortId(p.projectId),
      项目名: p.projectInfo?.projectTitle ?? '(未命名)',
      创建时间: timeFriendly(p.creationTime),
      projectId: p.projectId,
    }));
  },
  footerExtra: () => '切换：`flow project-use --projectId <完整UUID>`',
});

cli({
  site: SITE,
  name: 'project-current',
  description: '显示当前的默认项目（后续命令默认作用于这个项目）',
  access: 'read',
  defaultFormat: 'table',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [],
  columns: ['默认项目'],
  func: async () => {
    const s = loadState();
    return [{
      默认项目: s.currentProjectId && s.currentProjectId !== 'undefined'
        ? s.currentProjectId
        : '（未设置 — 运行 `flow project-use --projectId <id>` 或在 Flow 网页打开一个项目）',
      projectId: s.currentProjectId,
    }];
  },
});

cli({
  site: SITE,
  name: 'project-use',
  description: '把指定的项目设为默认（后续 flow gen / job-* 命令默认用它）',
  access: 'write',
  defaultFormat: 'table',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'projectId', required: true, help: '项目的完整 UUID（从 flow project-list 拿）' },
  ],
  columns: ['已切换到'],
  func: async (kwargs) => {
    const id = String(kwargs.projectId || '');
    if (!id || id === 'undefined') {
      throw new Error('请用 --projectId 提供完整的项目 UUID');
    }
    const s = loadState();
    s.currentProjectId = id;
    saveState(s);
    return [{ 已切换到: id, projectId: id }];
  },
});

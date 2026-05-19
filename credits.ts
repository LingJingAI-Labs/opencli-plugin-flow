/**
 * flow credits — show current Flow credits balance + tier.
 *
 * Calls GET /v1/credits (Google API key embedded in the page).
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { SITE, FLOW_BASE, inFlowPage, flowFetch, classifyError } from './_shared.js';
import { tierFriendly } from './_format.js';

const FLOW_API_KEY = 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY';

cli({
  site: SITE,
  name: 'credits',
  description: '查看当前 Flow 账号的积分余额和会员等级',
  access: 'read',
  defaultFormat: 'table',
  strategy: Strategy.COOKIE,
  browser: true,
  domain: 'labs.google',
  navigateBefore: false,
  args: [],
  columns: ['可用积分', '订阅积分', '账号等级', '服务等级'],
  func: async (page, _kwargs) => {
    await inFlowPage(page);
    const r = await flowFetch(page, `${FLOW_BASE}/credits?key=${FLOW_API_KEY}`);
    if (!r.ok) throw classifyError(r.status, r.body);
    return [{
      可用积分: r.body.credits,
      订阅积分: r.body.subscriptionCredits,
      账号等级: tierFriendly(r.body.userPaygateTier) + (r.body.sku ? `（${r.body.sku}）` : ''),
      服务等级: tierFriendly(r.body.serviceTier),
      // raw for agent
      credits: r.body.credits,
      sku: r.body.sku,
      userPaygateTier_raw: r.body.userPaygateTier,
    }];
  },
  footerExtra: () => '试算：`flow gen --prompt "..." --length 4 --dryRun true`',
});

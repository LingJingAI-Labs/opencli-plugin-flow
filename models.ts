/**
 * flow models — list Google Omni model variants in a user-friendly way.
 *
 * Default view is the human "what can I do" table; pass --raw to see the
 * underlying engineering keys.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { SITE } from './_shared.js';
import { OMNI } from './_models.js';
import { modeLabel } from './_format.js';

cli({
  site: SITE,
  name: 'models',
  description: 'Google Omni 支持的视频模式和积分价目（默认友好视图，--raw 看原始 model key）',
  access: 'read',
  defaultFormat: 'table',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'raw', type: 'boolean', default: false, help: '显示原始 model key（abra_t2v_4s 等）' },
  ],
  columns: ['模式', '别名 (--model)', '时长', '宽高比', '积分', '最多参考图(含角色)', '最多音色', '最多角色'],
  func: async (kwargs) => {
    if (kwargs.raw) {
      return Object.values(OMNI).map((m) => ({
        key: m.key,
        mode: m.mode,
        length_s: m.lengthSeconds || (m.key === 'abra_edit' ? '≤10 (input)' : '-'),
        credits: m.cost,
        max_img_incl_chars: m.maxImagesInclChars,
        max_audio: m.maxAudioRefs,
        max_chars: m.maxCharacters,
        key_raw: m.key,
      }));
    }
    // friendly alias for `--model`: edit / t2v-4s / r2v-8s etc.
    const aliasOf = (key: string) => key === 'abra_edit' ? 'edit' : key.replace(/^abra_/, '').replace(/_/g, '-');
    return Object.values(OMNI).map((m) => ({
      模式: modeLabel(m.mode),
      '别名 (--model)': aliasOf(m.key),
      时长: m.key === 'abra_edit' ? '跟输入视频一致（≤10 秒）' : `${m.lengthSeconds} 秒`,
      宽高比: '9:16 / 16:9',
      积分: m.cost,
      '最多参考图(含角色)': m.maxImagesInclChars > 0 ? m.maxImagesInclChars : '—',
      最多音色: m.maxAudioRefs > 0 ? m.maxAudioRefs : '—',
      最多角色: m.maxCharacters > 0 ? m.maxCharacters : '—',
      key_raw: m.key,
    }));
  },
  footerExtra: () => '示例：`flow gen --prompt "..." --length 8 --refs cat.png,bg.jpg --yes`',
});

/**
 * User-facing translations for Flow status / model / aspect enums.
 *
 * Strategy: tables show friendly Chinese values (columns names also CN);
 * raw English enums are kept on an extra `*_raw` field for agent parsing,
 * but those fields are not listed in `columns` so the table view stays clean.
 */
import { OMNI, type ModelSpec } from './_models.js';

export function modelFriendly(key: string): string {
  const m = OMNI[key];
  if (!m) return key;
  if (m.key === 'abra_edit') return 'Omni · 视频编辑';
  const modeLabel = m.mode === 't2v' ? '文字' : '参考图';
  return `Omni·${m.lengthSeconds}s·${modeLabel}`;
}

export function modeLabel(mode: ModelSpec['mode']): string {
  return mode === 't2v' ? '纯文字生视频' : mode === 'r2v' ? '图片/角色生视频' : '视频编辑';
}

export function aspectFriendly(v: string | undefined): string {
  if (!v) return '';
  if (v.includes('PORTRAIT')) return '9:16 竖屏';
  if (v.includes('LANDSCAPE')) return '16:9 横屏';
  return v;
}

export function statusFriendly(v: string | undefined): string {
  switch (v) {
    case 'MEDIA_GENERATION_STATUS_SUCCESSFUL': return '✅ 已完成';
    case 'MEDIA_GENERATION_STATUS_FAILED': return '❌ 失败';
    case 'MEDIA_GENERATION_STATUS_SCHEDULED': return '⏳ 排队中';
    case 'MEDIA_GENERATION_STATUS_PROCESSING': return '⚙️ 生成中';
    case 'MEDIA_GENERATION_STATUS_ACTIVE': return '⚙️ 生成中';
    case 'MEDIA_GENERATION_STATUS_PENDING': return '⏳ 等待中';
    case 'NOT_FOUND': return '❓ 未找到';
    default: return v || '';
  }
}

export function tierFriendly(v: string | undefined): string {
  switch (v) {
    case 'PAYGATE_TIER_ONE': return 'Pro';
    case 'PAYGATE_TIER_TWO': return 'Ultra';
    case 'SERVICE_TIER_ADVANCED': return '高级';
    case 'SERVICE_TIER_INTERMEDIATE': return '标准';
    case 'SERVICE_TIER_ENTRY': return '入门';
    default: return v || '';
  }
}

/** Short id for display (first 8 chars of UUID). */
export function shortId(id: string | undefined): string {
  return (id || '').slice(0, 8);
}

/** Truncate a string to `max` chars (counting wide CJK chars as 2), appending '…'. */
export function truncate(s: string | undefined, max: number): string {
  if (!s) return '';
  let width = 0;
  let out = '';
  for (const ch of s) {
    const w = ch.charCodeAt(0) > 0x4dff ? 2 : 1;   // crude CJK detection
    if (width + w > max - 1) {
      out += '…';
      return out;
    }
    out += ch;
    width += w;
  }
  return s;
}

/** ISO datetime → "MM-DD HH:mm" in user's local time. */
export function timeFriendly(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

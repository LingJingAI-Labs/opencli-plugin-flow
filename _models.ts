/**
 * Omni Flash model catalog + cost calc + model picker.
 *
 * Values pulled from labs.google modelConfig.videoModelFamilies (SERVICE_TIER_ADVANCED).
 * UI limits override modelConfig in one place: `images + characters ≤ 7` normally,
 * but drops to `≤ 5` when a reference video is attached (model auto-switches to abra_edit).
 */

export type OmniMode = 't2v' | 'r2v' | 'edit';
export type Aspect = '9:16' | '16:9';

export type ModelSpec = {
  key: string;
  mode: OmniMode;
  lengthSeconds: number;        // null for abra_edit (= input video length)
  cost: number;                 // credits per sample
  maxImagesInclChars: number;
  maxAudioRefs: number;
  maxCharacters: number;
  maxV2vSeconds?: number;
};

export const OMNI: Record<string, ModelSpec> = {
  abra_t2v_4s:  { key: 'abra_t2v_4s',  mode: 't2v', lengthSeconds: 4,  cost: 15, maxImagesInclChars: 0, maxAudioRefs: 0, maxCharacters: 0 },
  abra_t2v_6s:  { key: 'abra_t2v_6s',  mode: 't2v', lengthSeconds: 6,  cost: 20, maxImagesInclChars: 0, maxAudioRefs: 0, maxCharacters: 0 },
  abra_t2v_8s:  { key: 'abra_t2v_8s',  mode: 't2v', lengthSeconds: 8,  cost: 25, maxImagesInclChars: 0, maxAudioRefs: 0, maxCharacters: 0 },
  abra_t2v_10s: { key: 'abra_t2v_10s', mode: 't2v', lengthSeconds: 10, cost: 30, maxImagesInclChars: 0, maxAudioRefs: 0, maxCharacters: 0 },
  abra_r2v_4s:  { key: 'abra_r2v_4s',  mode: 'r2v', lengthSeconds: 4,  cost: 15, maxImagesInclChars: 7, maxAudioRefs: 5, maxCharacters: 3 },
  abra_r2v_6s:  { key: 'abra_r2v_6s',  mode: 'r2v', lengthSeconds: 6,  cost: 20, maxImagesInclChars: 7, maxAudioRefs: 5, maxCharacters: 3 },
  abra_r2v_8s:  { key: 'abra_r2v_8s',  mode: 'r2v', lengthSeconds: 8,  cost: 25, maxImagesInclChars: 7, maxAudioRefs: 5, maxCharacters: 3 },
  abra_r2v_10s: { key: 'abra_r2v_10s', mode: 'r2v', lengthSeconds: 10, cost: 30, maxImagesInclChars: 7, maxAudioRefs: 5, maxCharacters: 3 },
  abra_edit:    { key: 'abra_edit',    mode: 'edit', lengthSeconds: 0,  cost: 40, maxImagesInclChars: 5, maxAudioRefs: 3, maxCharacters: 3, maxV2vSeconds: 10 },
};

export const VALID_LENGTHS = [4, 6, 8, 10] as const;
export const VALID_ASPECTS: Aspect[] = ['9:16', '16:9'];

/**
 * Friendly aliases the user can pass to `--model`. The wire-level model keys
 * (`abra_*`) are an internal Google detail — most users should not need to
 * see them. Aliases below all resolve to the same engine.
 */
const MODEL_ALIASES: Record<string, string> = {
  // Video edit
  'edit': 'abra_edit',
  'omni-edit': 'abra_edit',
  'video-edit': 'abra_edit',
  // T2V
  't2v-4s': 'abra_t2v_4s',   'omni-t2v-4s': 'abra_t2v_4s',
  't2v-6s': 'abra_t2v_6s',   'omni-t2v-6s': 'abra_t2v_6s',
  't2v-8s': 'abra_t2v_8s',   'omni-t2v-8s': 'abra_t2v_8s',
  't2v-10s': 'abra_t2v_10s', 'omni-t2v-10s': 'abra_t2v_10s',
  // R2V
  'r2v-4s': 'abra_r2v_4s',   'omni-r2v-4s': 'abra_r2v_4s',
  'r2v-6s': 'abra_r2v_6s',   'omni-r2v-6s': 'abra_r2v_6s',
  'r2v-8s': 'abra_r2v_8s',   'omni-r2v-8s': 'abra_r2v_8s',
  'r2v-10s': 'abra_r2v_10s', 'omni-r2v-10s': 'abra_r2v_10s',
};

export function resolveModelKey(input: string): string {
  return MODEL_ALIASES[input] || input;
}

export function aspectToEnum(a: Aspect): string {
  return a === '9:16' ? 'VIDEO_ASPECT_RATIO_PORTRAIT' : 'VIDEO_ASPECT_RATIO_LANDSCAPE';
}

export type GenInputs = {
  length: number;
  imagesN: number;     // standalone reference images
  charactersN: number; // attached characters
  audioRefsN: number;
  hasReferenceVideo: boolean;
  count: number;       // samples per generation
};

export function pickModel(input: GenInputs, override?: string): ModelSpec {
  if (override) {
    const resolved = resolveModelKey(override);
    const m = OMNI[resolved];
    if (!m) {
      const aliases = Object.keys(MODEL_ALIASES).slice(0, 6).join(', ');
      throw new Error(
        `unknown model "${override}". Try friendly aliases like: ${aliases}, ... ` +
        `or raw keys: ${Object.keys(OMNI).slice(0, 4).join(', ')}, ...`,
      );
    }
    return m;
  }
  if (input.hasReferenceVideo) return OMNI.abra_edit;
  const lenOk = (VALID_LENGTHS as readonly number[]).includes(input.length);
  if (!lenOk) throw new Error(`length must be one of ${VALID_LENGTHS.join(', ')}; got ${input.length}`);
  if (input.imagesN > 0 || input.charactersN > 0 || input.audioRefsN > 0) {
    return OMNI[`abra_r2v_${input.length}s`];
  }
  return OMNI[`abra_t2v_${input.length}s`];
}

export function totalCost(model: ModelSpec, count: number): number {
  return model.cost * Math.max(1, count);
}

export function validateAgainstModel(model: ModelSpec, input: GenInputs): string[] {
  const errs: string[] = [];
  const imgChar = input.imagesN + input.charactersN;
  if (imgChar > model.maxImagesInclChars) {
    errs.push(`images + characters (${imgChar}) exceeds limit ${model.maxImagesInclChars} for ${model.key}`);
  }
  if (input.charactersN > model.maxCharacters) {
    errs.push(`characters (${input.charactersN}) exceeds limit ${model.maxCharacters} for ${model.key}`);
  }
  if (input.audioRefsN > model.maxAudioRefs) {
    errs.push(`audio refs (${input.audioRefsN}) exceeds limit ${model.maxAudioRefs} for ${model.key}`);
  }
  return errs;
}

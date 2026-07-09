import type { CatalogModel } from './protocol';

/**
 * A handful of well-known small/mini model families whose WebLLM ids don't
 * encode a parameter count at all (e.g. "Phi-3.5-mini-instruct"). Matched by
 * prefix only after the generic numeric parse below finds nothing, so it
 * never overrides an id that already carries an explicit size token.
 */
const KNOWN_SIZE_OVERRIDES_B: Array<{ pattern: RegExp; sizeB: number }> = [
  { pattern: /^Phi-3\.5-mini-instruct/i, sizeB: 3.8 },
  { pattern: /^Phi-3-mini-4k-instruct/i, sizeB: 3.8 },
  { pattern: /^Phi-4-mini-instruct/i, sizeB: 3.8 },
  { pattern: /^phi-2-/i, sizeB: 2.7 },
];

/**
 * Parses an effective parameter count in billions out of a WebLLM model id,
 * e.g. "gemma-2-2b-it-q4f16_1-MLC" -> 2, "gemma-3n-E4B-it-q4f16_1-MLC" -> 4,
 * "SmolLM2-360M-Instruct-q4f16_1-MLC" -> 0.36. Handles the common "<n>b"/"<n>m"
 * convention (with either "." or "_" as the decimal separator), Gemma 3n's
 * "E<n>B" effective-parameter notation, and a small override table for
 * families that don't encode size in the id at all. Returns undefined when
 * no size can be determined.
 */
export function parseModelSizeB(modelId: string): number | undefined {
  const effectiveMatch = modelId.match(/[Ee](\d+(?:[._]\d+)?)[Bb](?![a-zA-Z])/);
  if (effectiveMatch) {
    return parseFloat(effectiveMatch[1].replace('_', '.'));
  }
  const sizeMatch = modelId.match(/(?:^|[^a-zA-Z0-9])(\d+(?:[._]\d+)?)([MmBb])(?![a-zA-Z])/);
  if (sizeMatch) {
    const value = parseFloat(sizeMatch[1].replace('_', '.'));
    return sizeMatch[2].toUpperCase() === 'M' ? value / 1000 : value;
  }
  for (const { pattern, sizeB } of KNOWN_SIZE_OVERRIDES_B) {
    if (pattern.test(modelId)) {
      return sizeB;
    }
  }
  return undefined;
}

export interface ModelFilterOptions {
  maxSizeB: number;
  customModelIds: string[];
}

/**
 * Picks which WebLLM prebuilt models to surface as "Local SLMs": anything at
 * or below the configured size threshold, plus anything the user explicitly
 * opted into via localSlms.customModels, regardless of size.
 */
export function filterSmallModels(catalog: CatalogModel[], options: ModelFilterOptions): CatalogModel[] {
  const customSet = new Set(options.customModelIds.map((id) => id.trim()).filter(Boolean));
  return catalog.filter((model) => {
    if (customSet.has(model.id)) {
      return true;
    }
    if (model.sizeB === undefined) {
      return false;
    }
    return model.sizeB <= options.maxSizeB;
  });
}

/** Turns a raw WebLLM model id into a readable label for the model picker. */
export function friendlyModelName(modelId: string): string {
  let name = modelId
    .replace(/-MLC.*$/i, '')
    .replace(/-q4f\d+_\d+.*$/i, '')
    .replace(/-1k$/i, '');
  name = name.replace(/-/g, ' ');
  name = name.replace(/\bit\b/gi, 'Instruct');
  name = name.replace(/\bE(\d+(?:\.\d+)?)B\b/g, (_m, n) => `E${n}B`);
  name = name
    .split(' ')
    .map((word) => {
      if (/^[0-9]/.test(word) || /^E\d/i.test(word)) {
        return word;
      }
      return word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word;
    })
    .join(' ');
  return name.trim();
}

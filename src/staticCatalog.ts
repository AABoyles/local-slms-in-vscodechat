/**
 * A small, hand-verified set of WebLLM prebuilt model ids used to answer
 * "silent" catalog queries (VS Code refreshing the model list in the
 * background, e.g. on startup) without spinning up the WebGPU engine
 * webview. The live, authoritative catalog is always fetched straight from
 * WebLLM's prebuiltAppConfig once the user interacts with the model picker
 * or actually sends a chat request, so this list only affects what shows up
 * before that first interaction — it is never used to decide what can load.
 */
export const STATIC_FALLBACK_MODEL_IDS: readonly string[] = [
  'gemma3-1b-it-q4f16_1-MLC',
  'gemma-2-2b-it-q4f16_1-MLC',
  'Phi-3.5-mini-instruct-q4f16_1-MLC',
  'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  'SmolLM2-1.7B-Instruct-q4f16_1-MLC',
  'Llama-3.2-3B-Instruct-q4f16_1-MLC',
];

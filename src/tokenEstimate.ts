/**
 * Rough token estimate (~4 characters/token, English-text average) used for
 * provideTokenCount. WebLLM doesn't expose a synchronous tokenizer call the
 * extension host can use without the model already being loaded in the
 * webview, so this proxy is used instead of round-tripping every count
 * request through the engine.
 */
export function estimateTokenCount(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

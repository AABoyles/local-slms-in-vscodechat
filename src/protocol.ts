/**
 * Message protocol shared between the extension host (Node.js) and the
 * hidden webview (browser context) that actually runs WebLLM over
 * WebAssembly + WebGPU. Kept dependency-free so both sides can import it.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
}

/** A model as reported live by WebLLM's prebuilt catalog inside the webview. */
export interface CatalogModel {
  id: string;
  /** Parsed effective parameter count in billions, e.g. 2 for "2b" or "E2B". Undefined if it couldn't be parsed. */
  sizeB?: number;
  vramRequiredMB?: number;
  lowResource?: boolean;
  contextWindow?: number;
}

export interface GpuStatus {
  available: boolean;
  info?: string;
  reason?: string;
}

// ---- Host -> Webview ----

export type HostMessage =
  | { type: 'listModels'; requestId: string }
  | { type: 'loadModel'; requestId: string; modelId: string }
  | { type: 'chat'; requestId: string; modelId: string; messages: ChatMessage[]; options: ChatOptions }
  | { type: 'cancel'; requestId: string }
  | { type: 'clearCache'; requestId: string; modelId?: string };

// ---- Webview -> Host ----

export type WebviewMessage =
  | { type: 'ready'; gpu: GpuStatus }
  | { type: 'modelsList'; requestId: string; models: CatalogModel[] }
  | { type: 'modelsListError'; requestId: string; error: string }
  | { type: 'loadProgress'; requestId: string; progress: number; text: string }
  | { type: 'loadComplete'; requestId: string }
  | { type: 'loadError'; requestId: string; error: string }
  | { type: 'chatDelta'; requestId: string; text: string }
  | { type: 'chatDone'; requestId: string; promptTokens?: number; completionTokens?: number }
  | { type: 'chatError'; requestId: string; error: string }
  | { type: 'cacheCleared'; requestId: string }
  | { type: 'cacheClearError'; requestId: string; error: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

import * as webllm from '@mlc-ai/web-llm';
import { parseModelSizeB } from '../modelFilter';
import type { CatalogModel, ChatMessage, HostMessage, WebviewMessage } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

declare global {
  interface Window {
    __localSlmsConfig?: { cacheBackend?: 'cache' | 'indexeddb' | 'opfs' };
  }
}

const vscodeApi = acquireVsCodeApi();

function post(message: WebviewMessage): void {
  vscodeApi.postMessage(message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const logEl = document.getElementById('log');
function appendLogLine(text: string): void {
  if (!logEl) {return;}
  logEl.textContent = `${logEl.textContent ?? ''}${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  post({ type: 'log', level, message });
  appendLogLine(`[${level}] ${message}`);
}

const gpuStatusEl = document.getElementById('gpu-status');
function setGpuStatusText(available: boolean, text: string): void {
  if (!gpuStatusEl) {return;}
  gpuStatusEl.textContent = available ? `WebGPU ready — ${text}` : `WebGPU unavailable — ${text}`;
}

const progressContainer = document.getElementById('progress-container');
const progressLabel = document.getElementById('progress-label');
const progressBar = document.getElementById('progress-bar');
function setProgress(visible: boolean, fraction = 0, text = ''): void {
  if (!progressContainer || !progressBar || !progressLabel) {return;}
  progressContainer.classList.toggle('hidden', !visible);
  progressBar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  progressLabel.textContent = text;
}

let engine: webllm.MLCEngine | undefined;
let loadedModelId: string | undefined;
let activeChatRequestId: string | undefined;
let gpuAvailable: boolean | undefined;

function buildAppConfig(): webllm.AppConfig {
  return {
    ...webllm.prebuiltAppConfig,
    cacheBackend: window.__localSlmsConfig?.cacheBackend ?? 'cache',
  };
}

function toChatCompletionMessages(messages: ChatMessage[]): webllm.ChatCompletionMessageParam[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

async function reportGpuStatus(): Promise<void> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) {
    gpuAvailable = false;
    const reason = 'This VS Code window does not expose navigator.gpu. Update to a recent VS Code version.';
    setGpuStatusText(false, reason);
    post({ type: 'ready', gpu: { available: false, reason } });
    return;
  }
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      gpuAvailable = false;
      const reason = 'No WebGPU adapter was returned. A compatible GPU driver may be missing.';
      setGpuStatusText(false, reason);
      post({ type: 'ready', gpu: { available: false, reason } });
      return;
    }
    let info = 'adapter acquired';
    try {
      const adapterInfo = (await (
        adapter as GPUAdapter & { requestAdapterInfo?: () => Promise<GPUAdapterInfo> }
      ).requestAdapterInfo?.()) ?? (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
      if (adapterInfo) {
        info = [adapterInfo.vendor, adapterInfo.architecture, adapterInfo.description]
          .filter((part) => part && part.length > 0)
          .join(' ') || info;
      }
    } catch {
      // Adapter info is not exposed everywhere; not fatal.
    }
    gpuAvailable = true;
    setGpuStatusText(true, info);
    post({ type: 'ready', gpu: { available: true, info } });
  } catch (err) {
    gpuAvailable = false;
    const reason = errorMessage(err);
    setGpuStatusText(false, reason);
    post({ type: 'ready', gpu: { available: false, reason } });
  }
}

function handleListModels(msg: Extract<HostMessage, { type: 'listModels' }>): void {
  try {
    const models: CatalogModel[] = webllm.prebuiltAppConfig.model_list.map((record) => ({
      id: record.model_id,
      sizeB: parseModelSizeB(record.model_id),
      vramRequiredMB: record.vram_required_MB,
      lowResource: record.low_resource_required,
      contextWindow: record.overrides?.context_window_size,
    }));
    post({ type: 'modelsList', requestId: msg.requestId, models });
  } catch (err) {
    post({ type: 'modelsListError', requestId: msg.requestId, error: errorMessage(err) });
  }
}

async function handleLoadModel(msg: Extract<HostMessage, { type: 'loadModel' }>): Promise<void> {
  const { requestId, modelId } = msg;
  if (gpuAvailable === false) {
    post({
      type: 'loadError',
      requestId,
      error: 'WebGPU is not available in this VS Code window, so local models cannot run here.',
    });
    return;
  }
  try {
    if (engine && loadedModelId === modelId) {
      post({ type: 'loadComplete', requestId });
      return;
    }
    setProgress(true, 0, `Loading ${modelId}…`);
    const onProgress = (report: webllm.InitProgressReport) => {
      post({ type: 'loadProgress', requestId, progress: report.progress, text: report.text });
      setProgress(true, report.progress, report.text);
    };
    if (!engine) {
      engine = new webllm.MLCEngine({ appConfig: buildAppConfig(), initProgressCallback: onProgress });
    } else {
      engine.setInitProgressCallback(onProgress);
    }
    await engine.reload(modelId);
    loadedModelId = modelId;
    setProgress(false);
    post({ type: 'loadComplete', requestId });
  } catch (err) {
    loadedModelId = undefined;
    setProgress(false);
    log('error', `Failed to load ${modelId}: ${errorMessage(err)}`);
    post({ type: 'loadError', requestId, error: errorMessage(err) });
  }
}

async function handleChat(msg: Extract<HostMessage, { type: 'chat' }>): Promise<void> {
  const { requestId, modelId, messages, options } = msg;
  if (!engine || loadedModelId !== modelId) {
    post({ type: 'chatError', requestId, error: `Model "${modelId}" is not loaded yet.` });
    return;
  }
  activeChatRequestId = requestId;
  try {
    const stream = await engine.chat.completions.create({
      messages: toChatCompletionMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
      temperature: options.temperature,
      top_p: options.topP,
      max_tokens: options.maxTokens,
      stop: options.stop,
    });
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        post({ type: 'chatDelta', requestId, text: delta });
      }
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens;
        completionTokens = chunk.usage.completion_tokens;
      }
    }
    post({ type: 'chatDone', requestId, promptTokens, completionTokens });
  } catch (err) {
    post({ type: 'chatError', requestId, error: errorMessage(err) });
  } finally {
    if (activeChatRequestId === requestId) {
      activeChatRequestId = undefined;
    }
  }
}

async function handleCancel(msg: Extract<HostMessage, { type: 'cancel' }>): Promise<void> {
  if (msg.requestId !== activeChatRequestId || !engine) {
    return;
  }
  try {
    await engine.interruptGenerate();
  } catch (err) {
    log('warn', `interruptGenerate failed: ${errorMessage(err)}`);
  }
}

async function handleClearCache(msg: Extract<HostMessage, { type: 'clearCache' }>): Promise<void> {
  const { requestId, modelId } = msg;
  try {
    const appConfig = buildAppConfig();
    const idsToClear = modelId ? [modelId] : appConfig.model_list.map((record) => record.model_id);
    for (const id of idsToClear) {
      try {
        await webllm.deleteModelAllInfoInCache(id, appConfig);
      } catch (err) {
        log('warn', `Could not clear cache for ${id}: ${errorMessage(err)}`);
      }
      if (loadedModelId === id) {
        engine = undefined;
        loadedModelId = undefined;
      }
    }
    post({ type: 'cacheCleared', requestId });
  } catch (err) {
    post({ type: 'cacheClearError', requestId, error: errorMessage(err) });
  }
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'listModels':
      handleListModels(msg);
      break;
    case 'loadModel':
      void handleLoadModel(msg);
      break;
    case 'chat':
      void handleChat(msg);
      break;
    case 'cancel':
      void handleCancel(msg);
      break;
    case 'clearCache':
      void handleClearCache(msg);
      break;
  }
});

log('info', 'Local SLMs webview initialized.');
void reportGpuStatus();

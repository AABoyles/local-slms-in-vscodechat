import * as vscode from 'vscode';
import type { EngineHost } from './engineHost';
import { filterSmallModels, friendlyModelName, parseModelSizeB } from './modelFilter';
import type { CatalogModel, ChatMessage, ChatOptions } from './protocol';
import { STATIC_FALLBACK_MODEL_IDS } from './staticCatalog';
import { estimateTokenCount } from './tokenEstimate';

const DEFAULT_CONTEXT_WINDOW = 4096;

/**
 * Exposes locally-running WebLLM models (Gemma, Phi, Qwen, SmolLM, ...) as a
 * "Local SLMs" provider in the Copilot Chat model picker. Model discovery
 * and inference both happen inside a hidden webview (see EngineHost) since
 * that's the only place in a VS Code extension with access to WebGPU + WASM.
 */
export class LocalSlmChatProvider implements vscode.LanguageModelChatProvider {
  private cachedModels: vscode.LanguageModelChatInformation[] | undefined;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

  constructor(private readonly engineHost: EngineHost) {}

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    if (options.silent) {
      // Don't spin up the WebGPU webview just to answer a background
      // refresh (e.g. on VS Code startup): answer from the last live
      // catalog if we have one, otherwise from a small hand-verified list.
      return this.cachedModels ?? this.staticFallbackInformation();
    }

    try {
      const gpu = await this.engineHost.waitForReady(token);
      if (!gpu.available) {
        void vscode.window.showWarningMessage(
          `Local SLMs: WebGPU is unavailable in this VS Code window (${gpu.reason ?? 'unknown reason'}), so local models can't run here.`,
        );
        return this.cachedModels ?? [];
      }
      const config = vscode.workspace.getConfiguration('localSlms');
      const maxSizeB = config.get<number>('maxModelSizeBillionParams', 4.5);
      const customModelIds = config.get<string[]>('customModels', []);
      const catalog = await this.engineHost.listModels(token);
      const small = filterSmallModels(catalog, { maxSizeB, customModelIds });
      const models = small
        .slice()
        .sort((a, b) => (a.sizeB ?? 0) - (b.sizeB ?? 0))
        .map((model) => this.toChatInformation(model));
      const changed = !this.cachedModels || !sameModelIds(this.cachedModels, models);
      this.cachedModels = models;
      if (changed) {
        this.onDidChangeEmitter.fire();
      }
      return models;
    } catch (err) {
      void vscode.window.showErrorMessage(`Local SLMs: failed to list local models — ${errorMessage(err)}`);
      return this.cachedModels ?? this.staticFallbackInformation();
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const chatMessages = messages.map(toChatMessage);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Local SLMs: ${model.name}`, cancellable: false },
      async (progressReporter) => {
        let lastReported = 0;
        await this.engineHost.loadModel(
          model.id,
          (fraction, text) => {
            const increment = Math.max(0, (fraction - lastReported) * 100);
            lastReported = fraction;
            progressReporter.report({ increment, message: text });
          },
          token,
        );
      },
    );

    if (token.isCancellationRequested) {
      return;
    }

    const modelOptions = options.modelOptions ?? {};
    const chatOptions: ChatOptions = {
      maxTokens: typeof modelOptions.maxTokens === 'number' ? modelOptions.maxTokens : undefined,
      temperature: typeof modelOptions.temperature === 'number' ? modelOptions.temperature : undefined,
      topP: typeof modelOptions.topP === 'number' ? modelOptions.topP : undefined,
    };

    await this.engineHost.chat(
      model.id,
      chatMessages,
      chatOptions,
      (delta) => progress.report(new vscode.LanguageModelTextPart(delta)),
      token,
    );
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    return estimateTokenCount(typeof text === 'string' ? text : extractText(text));
  }

  private staticFallbackInformation(): vscode.LanguageModelChatInformation[] {
    return STATIC_FALLBACK_MODEL_IDS.map((id) => this.toChatInformation({ id, sizeB: parseModelSizeB(id) }));
  }

  private toChatInformation(model: CatalogModel): vscode.LanguageModelChatInformation {
    const contextWindow = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const vramNote = model.vramRequiredMB ? ` ~${Math.round(model.vramRequiredMB)} MB VRAM.` : '';
    return {
      id: model.id,
      name: `${friendlyModelName(model.id)} (Local)`,
      family: 'local-slm',
      version: '1.0.0',
      maxInputTokens: Math.max(256, contextWindow - 512),
      maxOutputTokens: Math.min(4096, contextWindow),
      tooltip: `Runs locally in VS Code via WebGPU + WebAssembly (WebLLM). Downloads on first use and then works offline.${vramNote}`,
      detail: 'Local SLMs',
      capabilities: {
        imageInput: false,
        toolCalling: false,
      },
    };
  }
}

function sameModelIds(a: vscode.LanguageModelChatInformation[], b: vscode.LanguageModelChatInformation[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const aIds = new Set(a.map((m) => m.id));
  return b.every((m) => aIds.has(m.id));
}

function toChatMessage(message: vscode.LanguageModelChatRequestMessage): ChatMessage {
  return {
    role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user',
    content: extractText(message),
  };
}

function extractText(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content
    .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
    .map((part) => part.value)
    .join('');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

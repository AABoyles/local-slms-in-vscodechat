import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { buildWebviewHtml } from './webviewContent';
import type { CatalogModel, ChatMessage, ChatOptions, GpuStatus, HostMessage, WebviewMessage } from './protocol';

export class EngineDisposedError extends Error {
  constructor() {
    super('The Local SLMs engine panel was closed before the request finished.');
  }
}

/**
 * Owns the hidden/background webview panel that runs @mlc-ai/web-llm over
 * WebAssembly + WebGPU (the extension host is plain Node.js and has neither),
 * and exposes a promise/callback based RPC over postMessage for the rest of
 * the extension to call into it.
 */
export class EngineHost implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly emitter = new EventEmitter();
  private readonly disposables: vscode.Disposable[] = [];
  private readyPromise: Promise<GpuStatus> | undefined;
  private readonly outputChannel: vscode.OutputChannel;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.emitter.setMaxListeners(0);
    this.outputChannel = vscode.window.createOutputChannel('Local SLMs');
    this.disposables.push(this.outputChannel);
  }

  /** Creates (if needed) and reveals the engine panel to the user. */
  reveal(): void {
    const panel = this.ensurePanel();
    panel.reveal(panel.viewColumn, false);
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      return this.panel;
    }
    const panel = vscode.window.createWebviewPanel(
      'localSlms.engine',
      'Local SLMs Engine',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'dist'),
          vscode.Uri.joinPath(this.extensionUri, 'media'),
        ],
      },
    );
    const cacheBackend = vscode.workspace
      .getConfiguration('localSlms')
      .get<'cache' | 'indexeddb' | 'opfs'>('cacheBackend', 'cache');
    panel.webview.html = buildWebviewHtml(panel.webview, this.extensionUri, { cacheBackend });
    panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.readyPromise = undefined;
        this.emitter.emit('__disposed');
      },
      undefined,
      this.disposables,
    );
    panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      undefined,
      this.disposables,
    );
    this.panel = panel;
    this.readyPromise = new Promise<GpuStatus>((resolve) => {
      this.emitter.once('ready', (gpu: GpuStatus) => resolve(gpu));
    });
    return panel;
  }

  private handleMessage(message: WebviewMessage): void {
    if (message.type === 'log') {
      this.outputChannel.appendLine(`[${message.level}] ${message.message}`);
      return;
    }
    if (message.type === 'ready') {
      this.outputChannel.appendLine(
        message.gpu.available
          ? `WebGPU is available: ${message.gpu.info ?? 'unknown adapter'}`
          : `WebGPU is not available: ${message.gpu.reason ?? 'unknown reason'}`,
      );
      this.emitter.emit('ready', message.gpu);
      return;
    }
    this.emitter.emit(message.type, message);
  }

  private post(message: HostMessage): void {
    void this.ensurePanel().webview.postMessage(message);
  }

  /** Resolves once the webview has booted and reported WebGPU availability. */
  async waitForReady(token?: vscode.CancellationToken): Promise<GpuStatus> {
    this.ensurePanel();
    return this.withCancellation(this.readyPromise!, token);
  }

  async listModels(token?: vscode.CancellationToken): Promise<CatalogModel[]> {
    await this.waitForReady(token);
    const requestId = randomUUID();
    const result = new Promise<CatalogModel[]>((resolve, reject) => {
      const onList = (msg: Extract<WebviewMessage, { type: 'modelsList' }>) => {
        if (msg.requestId !== requestId) {return;}
        cleanup();
        resolve(msg.models);
      };
      const onErr = (msg: Extract<WebviewMessage, { type: 'modelsListError' }>) => {
        if (msg.requestId !== requestId) {return;}
        cleanup();
        reject(new Error(msg.error));
      };
      const onDisposed = () => {
        cleanup();
        reject(new EngineDisposedError());
      };
      const cleanup = () => {
        this.emitter.off('modelsList', onList);
        this.emitter.off('modelsListError', onErr);
        this.emitter.off('__disposed', onDisposed);
      };
      this.emitter.on('modelsList', onList);
      this.emitter.on('modelsListError', onErr);
      this.emitter.once('__disposed', onDisposed);
    });
    this.post({ type: 'listModels', requestId });
    return this.withCancellation(result, token);
  }

  async loadModel(
    modelId: string,
    onProgress: (progress: number, text: string) => void,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    await this.waitForReady(token);
    const requestId = randomUUID();
    const result = new Promise<void>((resolve, reject) => {
      const onProg = (msg: Extract<WebviewMessage, { type: 'loadProgress' }>) => {
        if (msg.requestId !== requestId) {return;}
        onProgress(msg.progress, msg.text);
      };
      const onComplete = (msg: Extract<WebviewMessage, { type: 'loadComplete' }>) => {
        if (msg.requestId !== requestId) {return;}
        cleanup();
        resolve();
      };
      const onErr = (msg: Extract<WebviewMessage, { type: 'loadError' }>) => {
        if (msg.requestId !== requestId) {return;}
        cleanup();
        reject(new Error(msg.error));
      };
      const onDisposed = () => {
        cleanup();
        reject(new EngineDisposedError());
      };
      const cleanup = () => {
        this.emitter.off('loadProgress', onProg);
        this.emitter.off('loadComplete', onComplete);
        this.emitter.off('loadError', onErr);
        this.emitter.off('__disposed', onDisposed);
      };
      this.emitter.on('loadProgress', onProg);
      this.emitter.on('loadComplete', onComplete);
      this.emitter.on('loadError', onErr);
      this.emitter.once('__disposed', onDisposed);
    });
    this.post({ type: 'loadModel', requestId, modelId });
    return this.withCancellation(result, token, requestId);
  }

  async chat(
    modelId: string,
    messages: ChatMessage[],
    options: ChatOptions,
    onDelta: (text: string) => void,
    token?: vscode.CancellationToken,
  ): Promise<{ promptTokens?: number; completionTokens?: number }> {
    await this.waitForReady(token);
    const requestId = randomUUID();
    const result = new Promise<{ promptTokens?: number; completionTokens?: number }>((resolve, reject) => {
      const onDeltaMsg = (msg: Extract<WebviewMessage, { type: 'chatDelta' }>) => {
        if (msg.requestId !== requestId) {return;}
        onDelta(msg.text);
      };
      const onDone = (msg: Extract<WebviewMessage, { type: 'chatDone' }>) => {
        if (msg.requestId !== requestId) {return;}
        cleanup();
        resolve({ promptTokens: msg.promptTokens, completionTokens: msg.completionTokens });
      };
      const onErr = (msg: Extract<WebviewMessage, { type: 'chatError' }>) => {
        if (msg.requestId !== requestId) {return;}
        cleanup();
        reject(new Error(msg.error));
      };
      const onDisposed = () => {
        cleanup();
        reject(new EngineDisposedError());
      };
      const cleanup = () => {
        this.emitter.off('chatDelta', onDeltaMsg);
        this.emitter.off('chatDone', onDone);
        this.emitter.off('chatError', onErr);
        this.emitter.off('__disposed', onDisposed);
      };
      this.emitter.on('chatDelta', onDeltaMsg);
      this.emitter.on('chatDone', onDone);
      this.emitter.on('chatError', onErr);
      this.emitter.once('__disposed', onDisposed);
    });
    this.post({ type: 'chat', requestId, modelId, messages, options });
    return this.withCancellation(result, token, requestId);
  }

  async clearCache(modelId?: string): Promise<void> {
    await this.waitForReady();
    const requestId = randomUUID();
    const result = new Promise<void>((resolve, reject) => {
      const onCleared = (msg: Extract<WebviewMessage, { type: 'cacheCleared' }>) => {
        if (msg.requestId !== requestId) {return;}
        cleanup();
        resolve();
      };
      const onErr = (msg: Extract<WebviewMessage, { type: 'cacheClearError' }>) => {
        if (msg.requestId !== requestId) {return;}
        cleanup();
        reject(new Error(msg.error));
      };
      const cleanup = () => {
        this.emitter.off('cacheCleared', onCleared);
        this.emitter.off('cacheClearError', onErr);
      };
      this.emitter.on('cacheCleared', onCleared);
      this.emitter.on('cacheClearError', onErr);
    });
    this.post({ type: 'clearCache', requestId, modelId });
    return result;
  }

  /**
   * Awaits `promise`. If a cancellation token fires first: when `requestId`
   * is given, forwards a `cancel` message so the webview can interrupt
   * generation and resolve `promise` normally; otherwise rejects immediately.
   */
  private withCancellation<T>(promise: Promise<T>, token?: vscode.CancellationToken, requestId?: string): Promise<T> {
    if (!token) {
      return promise;
    }
    return new Promise<T>((resolve, reject) => {
      const sub = token.onCancellationRequested(() => {
        if (requestId) {
          this.post({ type: 'cancel', requestId });
        } else {
          reject(new vscode.CancellationError());
        }
      });
      promise.then(
        (value) => {
          sub.dispose();
          resolve(value);
        },
        (err) => {
          sub.dispose();
          reject(err);
        },
      );
    });
  }

  dispose(): void {
    this.panel?.dispose();
    this.emitter.removeAllListeners();
    vscode.Disposable.from(...this.disposables).dispose();
  }
}

import * as vscode from 'vscode';
import type { EngineHost } from './engineHost';
import { friendlyModelName } from './modelFilter';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerCommands(context: vscode.ExtensionContext, engineHost: EngineHost): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('localSlms.manage', () => engineHost.reveal()),
    vscode.commands.registerCommand('localSlms.showPanel', () => engineHost.reveal()),
    vscode.commands.registerCommand('localSlms.downloadModel', () => downloadModelCommand(engineHost)),
    vscode.commands.registerCommand('localSlms.clearCache', () => clearCacheCommand(engineHost)),
  );
}

async function downloadModelCommand(engineHost: EngineHost): Promise<void> {
  const cancelSource = new vscode.CancellationTokenSource();
  let catalog;
  try {
    catalog = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Local SLMs: checking WebGPU and fetching model catalog…' },
      () => engineHost.listModels(cancelSource.token),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Local SLMs: could not fetch the model catalog — ${errorMessage(err)}`);
    return;
  } finally {
    cancelSource.dispose();
  }

  const items = catalog
    .slice()
    .sort((a, b) => (a.sizeB ?? 0) - (b.sizeB ?? 0))
    .map((model) => ({
      label: friendlyModelName(model.id),
      description: model.sizeB ? `~${model.sizeB}B params` : undefined,
      detail: model.id,
      modelId: model.id,
    }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Local SLMs: Download Model',
    placeHolder: 'Select a model to download and load',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return;
  }

  const loadSource = new vscode.CancellationTokenSource();
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Local SLMs: downloading ${picked.label}`,
        cancellable: true,
      },
      async (progress, progressToken) => {
        progressToken.onCancellationRequested(() => loadSource.cancel());
        let lastReported = 0;
        await engineHost.loadModel(
          picked.modelId,
          (fraction, text) => {
            const increment = Math.max(0, (fraction - lastReported) * 100);
            lastReported = fraction;
            progress.report({ increment, message: text });
          },
          loadSource.token,
        );
      },
    );
    if (!loadSource.token.isCancellationRequested) {
      void vscode.window.showInformationMessage(`Local SLMs: ${picked.label} is downloaded and ready.`);
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`Local SLMs: failed to download ${picked.label} — ${errorMessage(err)}`);
  } finally {
    loadSource.dispose();
  }
}

async function clearCacheCommand(engineHost: EngineHost): Promise<void> {
  const cancelSource = new vscode.CancellationTokenSource();
  let catalog;
  try {
    catalog = await engineHost.listModels(cancelSource.token);
  } catch (err) {
    void vscode.window.showErrorMessage(`Local SLMs: could not fetch the model catalog — ${errorMessage(err)}`);
    return;
  } finally {
    cancelSource.dispose();
  }

  const ALL: vscode.QuickPickItem & { modelId?: string } = {
    label: 'Clear all downloaded models',
    description: 'Frees disk space used by every cached model',
  };
  const items = [
    ALL,
    ...catalog
      .slice()
      .sort((a, b) => (a.sizeB ?? 0) - (b.sizeB ?? 0))
      .map((model) => ({ label: friendlyModelName(model.id), detail: model.id, modelId: model.id })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Local SLMs: Clear Downloaded Models',
    placeHolder: 'Select a model to remove from disk',
  });
  if (!picked) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete ${picked.label} from local storage? You'll need to re-download it before using it again.`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') {
    return;
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Local SLMs: clearing ${picked.label}…` },
      () => engineHost.clearCache(picked.modelId),
    );
    void vscode.window.showInformationMessage(`Local SLMs: cleared ${picked.label}.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Local SLMs: failed to clear ${picked.label} — ${errorMessage(err)}`);
  }
}

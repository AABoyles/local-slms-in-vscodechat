import * as vscode from 'vscode';
import { LocalSlmChatProvider } from './chatProvider';
import { registerCommands } from './commands';
import { EngineHost } from './engineHost';

export function activate(context: vscode.ExtensionContext): void {
  const engineHost = new EngineHost(context.extensionUri);
  context.subscriptions.push(engineHost);

  const provider = new LocalSlmChatProvider(engineHost);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('local-slms', provider));

  registerCommands(context, engineHost);
}

export function deactivate(): void {
  // Nothing to do: EngineHost is disposed via context.subscriptions.
}

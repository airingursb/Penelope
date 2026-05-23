// Penelope VSCode extension.
// Wires the bin/penelope-lsp server to the editor and adds a "run current file" command.

const path = require('path');
const { workspace, window, commands } = require('vscode');
const { LanguageClient } = require('vscode-languageclient/node');

let client;

function resolveServerPath() {
  const cfg = workspace.getConfiguration('penelope');
  const configured = cfg.get('lspPath');
  if (configured && configured.length > 0) return configured;
  // Try a sensible default relative to the workspace root.
  const ws = workspace.workspaceFolders?.[0];
  if (ws) {
    const guess = path.join(ws.uri.fsPath, 'bin', 'penelope-lsp');
    return guess;
  }
  return 'penelope-lsp';
}

function activate(context) {
  const serverPath = resolveServerPath();

  const serverOptions = {
    command: serverPath,
    args: [],
    transport: 0 /* TransportKind.stdio */,
  };

  const clientOptions = {
    documentSelector: [{ scheme: 'file', language: 'penelope' }],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher('**/*.pen'),
    },
  };

  client = new LanguageClient('penelope-lsp', 'Penelope LSP', serverOptions, clientOptions);
  client.start();

  context.subscriptions.push(
    commands.registerCommand('penelope.runCurrentFile', async () => {
      const editor = window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'penelope') {
        window.showWarningMessage('Penelope: open a .pen file first');
        return;
      }
      const filePath = editor.document.uri.fsPath;
      const term = window.createTerminal('Penelope');
      term.show();
      const ws = workspace.workspaceFolders?.[0];
      const pen = ws ? path.join(ws.uri.fsPath, 'bin', 'penelope') : 'penelope';
      term.sendText(`"${pen}" run "${filePath}"`);
    })
  );
}

function deactivate() {
  if (client) return client.stop();
}

module.exports = { activate, deactivate };

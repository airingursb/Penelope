# Penelope LSP

Minimal LSP server providing parse-error diagnostics for `.pen` files.

## What it does

- Speaks LSP over stdio (Content-Length-framed JSON-RPC)
- On `textDocument/didOpen`, `didChange`, and `didSave`: parses the source and publishes a single diagnostic per parse error with line/character coordinates and the parser's message
- Responds to `initialize` and `shutdown`

It does **not** (yet) provide:
- Hover info
- Completions
- Go-to-definition
- Semantic tokens
- Workspace symbols

These are deferred — the goal of this prototype is to validate the LSP plumbing and the parser's error-message surface area.

## Launching

```bash
bin/penelope-lsp
```

Reads LSP messages from stdin, writes responses to stdout. Stderr is for server logs only.

## Wiring to VSCode

A full extension is out of scope for this prototype, but the minimum extension to use this server is:

```json
{
  "name": "penelope-vscode",
  "version": "0.0.1",
  "engines": { "vscode": "^1.80.0" },
  "activationEvents": ["onLanguage:penelope"],
  "main": "./out/extension.js",
  "contributes": {
    "languages": [{
      "id": "penelope",
      "aliases": ["Penelope"],
      "extensions": [".pen"]
    }]
  },
  "dependencies": {
    "vscode-languageclient": "^9.0.0"
  }
}
```

And the extension activation:

```ts
import * as vscode from 'vscode';
import { LanguageClient, ServerOptions } from 'vscode-languageclient/node';

export function activate(ctx: vscode.ExtensionContext) {
  const serverOpts: ServerOptions = {
    command: 'bin/penelope-lsp',  // resolved against workspace root
    transport: 1, /* TransportKind.stdio */
  };
  const client = new LanguageClient('penelope-lsp', 'Penelope', serverOpts, {
    documentSelector: [{ scheme: 'file', language: 'penelope' }],
  });
  client.start();
  ctx.subscriptions.push(client);
}
```

## Wiring to other editors

Any LSP-compatible editor works. For Neovim with `nvim-lspconfig`:

```lua
local lspconfig = require('lspconfig')
local configs = require('lspconfig.configs')

if not configs.penelope then
  configs.penelope = {
    default_config = {
      cmd = { 'bin/penelope-lsp' },
      filetypes = { 'penelope' },
      root_dir = lspconfig.util.find_git_ancestor,
      settings = {},
    },
  }
end

lspconfig.penelope.setup({})
```

## Testing locally

```bash
# Feed a single LSP message via stdin
(printf 'Content-Length: 132\r\n\r\n{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///x.pen","text":"let x = ;"}}}'; sleep 0.2) | bin/penelope-lsp
```

Expected output: a `publishDiagnostics` notification with a single error diagnostic.

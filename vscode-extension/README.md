# Penelope — VSCode Extension

Syntax highlighting + parse-error diagnostics + a "run current file" command for [Penelope](../README.md).

## Install (dev mode)

1. From this folder: `npm install` (installs `vscode-languageclient`)
2. From the Penelope repo root: `npm run build` (compiles the LSP server to `dist/lsp.js`)
3. Open this folder in VSCode and press **F5** — an Extension Development Host opens
4. Open any `.pen` file in that host

## Install (production)

1. From this folder: `npm install`
2. Bundle into a `.vsix`: `npx vsce package` (requires `@vscode/vsce` globally or via `npx`)
3. Install: `code --install-extension penelope-vscode-0.0.1.vsix`

## Settings

- `penelope.lspPath` — absolute path to `bin/penelope-lsp`. Defaults to `<workspace>/bin/penelope-lsp`, falling back to `penelope-lsp` from `$PATH`.

## What works

- ✅ Syntax highlighting (keywords, builtins, strings, comments, operators)
- ✅ Parse-error diagnostics (squiggles + Problems panel) via LSP
- ✅ Commenting (Cmd-/ → `//`)
- ✅ Bracket / quote auto-pairing
- ✅ Command palette: "Penelope: Run current file" → opens an integrated terminal and runs `pen run <file>`

## What does not work yet

- Hover info / completions / go-to-definition (LSP server doesn't provide them yet)
- Snippets
- Debugger integration

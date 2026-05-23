// Minimal Penelope LSP server.
// Speaks LSP over stdio (JSON-RPC with Content-Length framing).
// Publishes parse-error diagnostics on textDocument/didOpen, didChange, didSave.
//
// Wire to VSCode via a thin extension; see docs/lsp-readme.md.

import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { checkWithTypes, typeStr } from './typecheck.js';
import type { ASTNode } from './ast.js';

type Diagnostic = {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity: 1 | 2 | 3 | 4;  // 1=Error 2=Warning 3=Info 4=Hint
  source: 'penelope';
  message: string;
};

const documents = new Map<string, string>();

function send(msg: object): void {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function publishDiagnostics(uri: string, source: string): void {
  const diags: Diagnostic[] = [];
  try {
    const tokens = tokenize(source);
    parse(tokens);
  } catch (e) {
    const msg = (e as Error).message;
    // Extract "line N col M" if present
    const m = msg.match(/line (\d+) col (\d+)/);
    let line = 0, col = 0;
    if (m) { line = Math.max(0, parseInt(m[1], 10) - 1); col = Math.max(0, parseInt(m[2], 10) - 1); }
    diags.push({
      range: { start: { line, character: col }, end: { line, character: col + 1 } },
      severity: 1,
      source: 'penelope',
      message: msg,
    });
  }
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: { uri, diagnostics: diags },
  });
}

type LspMessage = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

export function handleMessage(msg: LspMessage): void {
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        capabilities: {
          textDocumentSync: { openClose: true, change: 1 /* full */, save: true },
          hoverProvider: true,
          completionProvider: { triggerCharacters: [] },
          definitionProvider: true,
        },
        serverInfo: { name: 'penelope-lsp', version: '0.0.1' },
      },
    });
    return;
  }
  if (msg.method === 'textDocument/hover') {
    handleHover(msg);
    return;
  }
  if (msg.method === 'textDocument/completion') {
    handleCompletion(msg);
    return;
  }
  if (msg.method === 'textDocument/definition') {
    handleDefinition(msg);
    return;
  }
  if (msg.method === 'initialized' || msg.method === 'workspace/didChangeConfiguration') {
    return;
  }
  if (msg.method === 'textDocument/didOpen') {
    const td = (msg.params as { textDocument: { uri: string; text: string } }).textDocument;
    documents.set(td.uri, td.text);
    publishDiagnostics(td.uri, td.text);
    return;
  }
  if (msg.method === 'textDocument/didChange') {
    const p = msg.params as { textDocument: { uri: string }; contentChanges: { text: string }[] };
    const last = p.contentChanges[p.contentChanges.length - 1];
    documents.set(p.textDocument.uri, last.text);
    publishDiagnostics(p.textDocument.uri, last.text);
    return;
  }
  if (msg.method === 'textDocument/didSave') {
    const p = msg.params as { textDocument: { uri: string }; text?: string };
    const source = p.text ?? documents.get(p.textDocument.uri) ?? '';
    publishDiagnostics(p.textDocument.uri, source);
    return;
  }
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  if (msg.method === 'exit') {
    process.exit(0);
  }
  // Reply with method-not-found for unhandled requests (silently ignore notifications).
  if (msg.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `method not found: ${msg.method}` },
    });
  }
}

const KEYWORDS = ['let', 'fn', 'if', 'else', 'true', 'false', 'pause'];
const BUILTINS = [
  'print', 'net_fetch', 'now', 'random_int', 'read_file', 'write_file', 'wait_until', 'wait_for',
  'str_length', 'str_slice', 'to_str',
  'list_new', 'list_push', 'list_get', 'list_set', 'list_len',
  'dict_new', 'dict_set', 'dict_get', 'dict_has', 'dict_keys',
];

function handleCompletion(msg: LspMessage): void {
  const p = msg.params as { textDocument: { uri: string } };
  const source = documents.get(p.textDocument.uri) ?? '';
  const items: object[] = [];
  for (const k of KEYWORDS) items.push({ label: k, kind: 14 /* Keyword */ });
  for (const b of BUILTINS) items.push({ label: b, kind: 3 /* Function */, detail: 'builtin' });
  try {
    const ast = parse(tokenize(source));
    const localVars = new Set<string>();
    for (const id of Object.keys(ast.nodes)) {
      const n = ast.nodes[id];
      if (n.kind === 'Let') localVars.add(n.name);
      if (n.kind === 'Fn') for (const p of n.params) localVars.add(p);
    }
    for (const name of localVars) items.push({ label: name, kind: 6 /* Variable */, detail: 'local' });
  } catch { /* parse errors → just return keywords + builtins */ }
  send({ jsonrpc: '2.0', id: msg.id, result: items });
}

function handleDefinition(msg: LspMessage): void {
  const p = msg.params as {
    textDocument: { uri: string };
    position: { line: number; character: number };
  };
  const source = documents.get(p.textDocument.uri);
  if (!source) {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  const targetLine = p.position.line + 1;
  const targetCol = p.position.character + 1;
  let result: object | null = null;
  try {
    const ast = parse(tokenize(source));
    // Find Var node at cursor
    let cursorNode: ASTNode | null = null;
    for (const id of Object.keys(ast.nodes)) {
      const node = ast.nodes[id];
      if (node.kind !== 'Var' || !node.pos) continue;
      if (node.pos.line !== targetLine) continue;
      const endCol = node.pos.col + node.name.length;
      if (targetCol >= node.pos.col && targetCol < endCol) {
        cursorNode = node;
        break;
      }
    }
    if (cursorNode && cursorNode.kind === 'Var') {
      // Find matching Let by walking nodes in source order; pick the latest one before cursor.
      let bestLet: ASTNode | null = null;
      for (const id of Object.keys(ast.nodes)) {
        const node = ast.nodes[id];
        if (node.kind !== 'Let' || node.name !== cursorNode.name || !node.pos) continue;
        if (
          node.pos.line < targetLine ||
          (node.pos.line === targetLine && node.pos.col < targetCol)
        ) {
          if (!bestLet || !bestLet.pos ||
            node.pos.line > bestLet.pos.line ||
            (node.pos.line === bestLet.pos.line && node.pos.col > bestLet.pos.col)) {
            bestLet = node;
          }
        }
      }
      if (bestLet && bestLet.pos) {
        // Let.pos points at the `let` keyword; the identifier starts 4 chars later.
        const nameStart = bestLet.pos.col - 1 + 'let '.length;
        const nameLen = (bestLet as Extract<ASTNode, { kind: 'Let' }>).name.length;
        result = {
          uri: p.textDocument.uri,
          range: {
            start: { line: bestLet.pos.line - 1, character: nameStart },
            end:   { line: bestLet.pos.line - 1, character: nameStart + nameLen },
          },
        };
      }
    }
  } catch { /* parse error → no definition */ }
  send({ jsonrpc: '2.0', id: msg.id, result });
}

function handleHover(msg: LspMessage): void {
  const p = msg.params as {
    textDocument: { uri: string };
    position: { line: number; character: number };
  };
  const source = documents.get(p.textDocument.uri);
  if (!source) {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  const lspLine = p.position.line;
  const lspChar = p.position.character;
  // Penelope uses 1-based lines/cols; LSP uses 0-based.
  const targetLine = lspLine + 1;
  const targetCol = lspChar + 1;

  let result: object | null = null;
  try {
    const ast = parse(tokenize(source));
    const { types } = checkWithTypes(ast);
    // Find best-matching Var node: same line, col range covers target.
    let best: ASTNode | null = null;
    for (const id of Object.keys(ast.nodes)) {
      const node = ast.nodes[id];
      if (node.kind !== 'Var' || !node.pos) continue;
      if (node.pos.line !== targetLine) continue;
      const endCol = node.pos.col + node.name.length;
      if (targetCol >= node.pos.col && targetCol < endCol) {
        if (!best || (best.pos && node.pos.col > best.pos.col)) best = node;
      }
    }
    if (best && best.kind === 'Var') {
      const t = types.get(best.id);
      const typeText = t ? typeStr(t) : 'unknown';
      result = {
        contents: {
          kind: 'markdown',
          value: `\`${best.name}\`: \`${typeText}\``,
        },
      };
    }
  } catch {
    // ignore parse errors during hover
  }
  send({ jsonrpc: '2.0', id: msg.id, result });
}

export function runLsp(): void {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const headers = buffer.slice(0, headerEnd);
      const cl = /Content-Length: (\d+)/i.exec(headers);
      if (!cl) { buffer = buffer.slice(headerEnd + 4); continue; }
      const len = parseInt(cl[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + len) break;
      const body = buffer.slice(bodyStart, bodyStart + len);
      buffer = buffer.slice(bodyStart + len);
      try {
        const msg = JSON.parse(body) as LspMessage;
        handleMessage(msg);
      } catch (e) {
        process.stderr.write(`lsp parse error: ${(e as Error).message}\n`);
      }
    }
  });
}

// Self-invoke when run as a script.
if (process.argv[1]?.endsWith('lsp.js')) {
  runLsp();
}

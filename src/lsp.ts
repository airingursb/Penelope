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

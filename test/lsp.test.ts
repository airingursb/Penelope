// LSP server: unit tests against handleMessage by capturing stdout writes.

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleMessage } from '../src/lsp.js';

let writes: string[] = [];
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  writes = [];
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  writeSpy.mockRestore();
});

function lastJsonReply(): any {
  const last = writes[writes.length - 1];
  const m = last.match(/\r\n\r\n(.*)$/s);
  if (!m) throw new Error(`no body in ${last}`);
  return JSON.parse(m[1]);
}

test('initialize handshake returns capabilities', () => {
  handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const reply = lastJsonReply();
  expect(reply.id).toBe(1);
  expect(reply.result.capabilities.textDocumentSync).toBeDefined();
  expect(reply.result.serverInfo.name).toBe('penelope-lsp');
});

test('didOpen on valid source publishes empty diagnostics', () => {
  handleMessage({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: 'file:///a.pen', text: 'let x = 1;' } },
  });
  const reply = lastJsonReply();
  expect(reply.method).toBe('textDocument/publishDiagnostics');
  expect(reply.params.uri).toBe('file:///a.pen');
  expect(reply.params.diagnostics).toEqual([]);
});

test('didOpen on broken source publishes a diagnostic with line/character', () => {
  handleMessage({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: 'file:///b.pen', text: 'let x = ;' } },
  });
  const reply = lastJsonReply();
  expect(reply.method).toBe('textDocument/publishDiagnostics');
  expect(reply.params.diagnostics.length).toBe(1);
  const d = reply.params.diagnostics[0];
  expect(d.severity).toBe(1);
  expect(d.source).toBe('penelope');
  expect(d.range.start.line).toBeGreaterThanOrEqual(0);
});

test('didChange republishes diagnostics for new content', () => {
  handleMessage({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: 'file:///c.pen', text: 'let x = 1;' } },
  });
  writes = [];
  handleMessage({
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri: 'file:///c.pen' },
      contentChanges: [{ text: 'let x = ;' }],
    },
  });
  const reply = lastJsonReply();
  expect(reply.params.diagnostics.length).toBe(1);
});

test('shutdown returns null result', () => {
  handleMessage({ jsonrpc: '2.0', id: 42, method: 'shutdown' });
  const reply = lastJsonReply();
  expect(reply.id).toBe(42);
  expect(reply.result).toBeNull();
});

test('initialize advertises hoverProvider capability', () => {
  handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const reply = lastJsonReply();
  expect(reply.result.capabilities.hoverProvider).toBe(true);
});

test('hover on a Var returns the inferred type', () => {
  handleMessage({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: 'file:///h.pen', text: 'let x = 42; x;' } },
  });
  writes = [];
  handleMessage({
    jsonrpc: '2.0',
    id: 7,
    method: 'textDocument/hover',
    params: { textDocument: { uri: 'file:///h.pen' }, position: { line: 0, character: 12 } },
  });
  const reply = lastJsonReply();
  expect(reply.id).toBe(7);
  expect(reply.result.contents.value).toMatch(/`x`: `int`/);
});

test('hover on whitespace returns null', () => {
  handleMessage({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: 'file:///h2.pen', text: 'let x = 1;\n' } },
  });
  writes = [];
  handleMessage({
    jsonrpc: '2.0',
    id: 8,
    method: 'textDocument/hover',
    params: { textDocument: { uri: 'file:///h2.pen' }, position: { line: 1, character: 0 } },
  });
  const reply = lastJsonReply();
  expect(reply.result).toBeNull();
});

test('completion includes keywords + builtins + local vars', () => {
  handleMessage({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: 'file:///c.pen', text: 'let alpha = 1; let beta = 2;' } },
  });
  writes = [];
  handleMessage({
    jsonrpc: '2.0',
    id: 10,
    method: 'textDocument/completion',
    params: { textDocument: { uri: 'file:///c.pen' }, position: { line: 0, character: 30 } },
  });
  const reply = lastJsonReply();
  const labels = reply.result.map((it: { label: string }) => it.label);
  expect(labels).toContain('let');
  expect(labels).toContain('print');
  expect(labels).toContain('list_new');
  expect(labels).toContain('alpha');
  expect(labels).toContain('beta');
});

test('definition jumps from Var to its Let binding', () => {
  handleMessage({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: 'file:///d.pen', text: 'let x = 1;\nprint(to_str(x));' } },
  });
  writes = [];
  // Cursor on the `x` inside print(to_str(x)) — line 1 (0-indexed), char 13
  handleMessage({
    jsonrpc: '2.0',
    id: 11,
    method: 'textDocument/definition',
    params: { textDocument: { uri: 'file:///d.pen' }, position: { line: 1, character: 13 } },
  });
  const reply = lastJsonReply();
  expect(reply.result.uri).toBe('file:///d.pen');
  expect(reply.result.range.start).toEqual({ line: 0, character: 4 });
  expect(reply.result.range.end).toEqual({ line: 0, character: 5 });
});

test('definition on non-var returns null', () => {
  handleMessage({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: 'file:///d2.pen', text: 'let x = 1;' } },
  });
  writes = [];
  handleMessage({
    jsonrpc: '2.0',
    id: 12,
    method: 'textDocument/definition',
    params: { textDocument: { uri: 'file:///d2.pen' }, position: { line: 0, character: 0 } },
  });
  expect(lastJsonReply().result).toBeNull();
});

test('unknown method returns method-not-found error', () => {
  handleMessage({ jsonrpc: '2.0', id: 99, method: 'workspace/wat' });
  const reply = lastJsonReply();
  expect(reply.id).toBe(99);
  expect(reply.error.code).toBe(-32601);
});

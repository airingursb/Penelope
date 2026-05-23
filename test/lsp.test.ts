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

test('unknown method returns method-not-found error', () => {
  handleMessage({ jsonrpc: '2.0', id: 99, method: 'workspace/wat' });
  const reply = lastJsonReply();
  expect(reply.id).toBe(99);
  expect(reply.error.code).toBe(-32601);
});

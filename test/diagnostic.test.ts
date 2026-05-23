import { test, expect } from 'vitest';
import { formatDiagnostic, diagnosticFromMessage } from '../src/diagnostic.js';

test('formats with source line + caret', () => {
  const out = formatDiagnostic({
    message: 'undefined variable',
    pos: { line: 2, col: 9 },
    source: 'let x = 1;\nlet y = foo + 1;',
    filename: 'demo.pen',
    spanLen: 3,
  });
  expect(out).toContain('error: undefined variable');
  expect(out).toContain('--> demo.pen:2:9');
  expect(out).toContain('let y = foo + 1;');
  expect(out).toContain('        ^^^');
});

test('omits source block when source missing', () => {
  const out = formatDiagnostic({
    message: 'oops',
    pos: { line: 1, col: 1 },
    filename: 'x.pen',
  });
  expect(out).toContain('--> x.pen:1:1');
  expect(out).not.toContain('|');
});

test('includes hint when provided', () => {
  const out = formatDiagnostic({
    message: 'missing semicolon',
    pos: { line: 1, col: 5 },
    source: 'let x = 1',
    spanLen: 1,
    hint: 'add ; at end of statement',
  });
  expect(out).toContain('hint: add ; at end of statement');
});

test('diagnosticFromMessage parses "at line N col M" from text', () => {
  const d = diagnosticFromMessage('undefined variable \'foo\' at line 3 col 9');
  expect(d.pos).toEqual({ line: 3, col: 9 });
  expect(d.message).toBe(`undefined variable 'foo'`);
});

test('diagnosticFromMessage parses VM-style "at line N col M (ip K)"', () => {
  const d = diagnosticFromMessage('undefined variable \'x\' at line 1 col 1 (ip 0)');
  expect(d.pos).toEqual({ line: 1, col: 1 });
  expect(d.message).toBe(`undefined variable 'x'`);
});

test('diagnosticFromMessage with no positional info returns bare message', () => {
  const d = diagnosticFromMessage('something broke');
  expect(d.pos).toBeUndefined();
  expect(d.message).toBe('something broke');
});

test('full pipeline: message -> diagnostic -> formatted', () => {
  const out = formatDiagnostic(diagnosticFromMessage(
    "undefined variable 'whatevs' at line 1 col 1",
    'whatevs;',
    'test.pen',
  ));
  expect(out).toBe(
    `error: undefined variable 'whatevs'\n` +
    `  --> test.pen:1:1\n` +
    `   |\n` +
    ` 1 | whatevs;\n` +
    `   | ^`
  );
});

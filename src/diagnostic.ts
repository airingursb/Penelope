// Rich error formatting — Rust/Elm style with source line + caret.
//
//   error: undefined variable 'foo'
//    --> bar.pen:3:7
//     |
//   3 | let x = foo + 1;
//     |         ^^^

import type { Pos } from './ast.js';

export type Diagnostic = {
  message: string;
  pos?: Pos;
  source?: string;        // raw source text
  filename?: string;
  hint?: string;
  spanLen?: number;       // length of the underlined region; default 1
};

// ANSI color helpers. Disabled when stderr is not a TTY (or NO_COLOR is set).
function shouldColor(): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stderr && (process.stderr as { isTTY?: boolean }).isTTY);
}
const COLORS = {
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  brRed:  (s: string) => `\x1b[91;1m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
};
function paint(c: keyof typeof COLORS, s: string, enable: boolean): string {
  return enable ? COLORS[c](s) : s;
}

export function formatDiagnostic(d: Diagnostic, color?: boolean): string {
  const useColor = color ?? shouldColor();
  const lines: string[] = [];
  lines.push(paint('red', 'error', useColor) + ': ' + d.message);

  if (d.pos && d.source) {
    const srcLines = d.source.split('\n');
    const lineIdx = d.pos.line - 1;
    const offending = srcLines[lineIdx] ?? '';
    const gutterWidth = String(d.pos.line).length;
    const pad = (s: string) => s.padStart(gutterWidth, ' ');

    lines.push(` ${pad(' ')}${paint('cyan', '--> ', useColor)}${d.filename ?? '<input>'}:${d.pos.line}:${d.pos.col}`);
    lines.push(paint('dim', ` ${pad(' ')} |`, useColor));
    lines.push(`${paint('dim', ' ' + pad(String(d.pos.line)) + ' |', useColor)} ${offending}`);

    const padding = ' '.repeat(Math.max(0, d.pos.col - 1));
    const carets = '^'.repeat(Math.max(1, d.spanLen ?? 1));
    lines.push(`${paint('dim', ` ${pad(' ')} |`, useColor)} ${padding}${paint('brRed', carets, useColor)}`);
  } else if (d.pos) {
    lines.push(` ${paint('cyan', '--> ', useColor)}${d.filename ?? '<input>'}:${d.pos.line}:${d.pos.col}`);
  }

  if (d.hint) lines.push(paint('yellow', 'hint', useColor) + ': ' + d.hint);
  return lines.join('\n');
}

// Convenience: build a Diagnostic from a thrown Error message that contains "line N col M".
// If `lineMap` is supplied (from loadSourceWithMap), the line is translated back to its
// original file:line. Source display still uses the concatenated source (which contains
// the imported file's text at the right offset).
export function diagnosticFromMessage(
  message: string,
  source?: string,
  filename?: string,
  lineMap?: Array<{ file: string; line: number }>,
): Diagnostic {
  const m = message.match(/line (\d+) col (\d+)/);
  if (!m) return { message };
  let line = parseInt(m[1], 10);
  const col = parseInt(m[2], 10);
  let displayFile = filename;
  if (lineMap && line >= 1 && line <= lineMap.length) {
    const origin = lineMap[line - 1];
    if (origin) {
      displayFile = origin.file;
      line = origin.line;
    }
  }
  // Strip the "at line N col M" suffix from the message itself since formatDiagnostic prints it.
  const cleanMsg = message.replace(/\s*at line \d+ col \d+(?:\s*\(ip \d+\))?\s*$/, '');
  return { message: cleanMsg, pos: { line, col }, source, filename: displayFile };
}

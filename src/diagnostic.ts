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

export function formatDiagnostic(d: Diagnostic): string {
  const lines: string[] = [];
  lines.push(`error: ${d.message}`);

  if (d.pos && d.source) {
    const srcLines = d.source.split('\n');
    const lineIdx = d.pos.line - 1;
    const offending = srcLines[lineIdx] ?? '';
    const gutterWidth = String(d.pos.line).length;
    const pad = (s: string) => s.padStart(gutterWidth, ' ');

    lines.push(` ${pad(' ')}--> ${d.filename ?? '<input>'}:${d.pos.line}:${d.pos.col}`);
    lines.push(` ${pad(' ')} |`);
    lines.push(` ${pad(String(d.pos.line))} | ${offending}`);

    const padding = ' '.repeat(Math.max(0, d.pos.col - 1));
    const carets = '^'.repeat(Math.max(1, d.spanLen ?? 1));
    lines.push(` ${pad(' ')} | ${padding}${carets}`);
  } else if (d.pos) {
    lines.push(` --> ${d.filename ?? '<input>'}:${d.pos.line}:${d.pos.col}`);
  }

  if (d.hint) lines.push(`hint: ${d.hint}`);
  return lines.join('\n');
}

// Convenience: build a Diagnostic from a thrown Error message that contains "line N col M".
export function diagnosticFromMessage(
  message: string,
  source?: string,
  filename?: string,
): Diagnostic {
  const m = message.match(/line (\d+) col (\d+)/);
  if (!m) return { message };
  const line = parseInt(m[1], 10);
  const col = parseInt(m[2], 10);
  // Strip the "at line N col M" suffix from the message itself since formatDiagnostic prints it.
  const cleanMsg = message.replace(/\s*at line \d+ col \d+(?:\s*\(ip \d+\))?\s*$/, '');
  return { message: cleanMsg, pos: { line, col }, source, filename };
}

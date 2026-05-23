// pen doc: extract /// doc comments preceding top-level `let` bindings,
// emit Markdown summarizing the public API of a .pen file.

import type { ASTBundle } from './ast.js';
import type { Comment } from './lexer.js';

export type DocEntry = {
  name: string;
  kind: 'fn' | 'value';
  line: number;
  signature?: string;   // for fn: e.g. "fn(a, b)"
  doc: string;          // collected /// lines, joined with \n
};

export function extractDocs(ast: ASTBundle, comments: Comment[]): DocEntry[] {
  const entries: DocEntry[] = [];
  const root = ast.nodes[ast.rootId];
  if (root.kind !== 'Program') return entries;

  for (const stmtId of root.stmtIds) {
    const node = ast.nodes[stmtId];
    if (node.kind !== 'Let' || !node.pos) continue;

    // Collect /// lines immediately preceding this Let (allowing only adjacent lines).
    const docLines: string[] = [];
    let expectedLine = node.pos.line - 1;
    while (true) {
      const c = comments.find(c => c.doc && c.line === expectedLine);
      if (!c) break;
      docLines.unshift(c.text);
      expectedLine--;
    }
    if (docLines.length === 0) continue;

    const value = ast.nodes[node.valueId];
    let signature: string | undefined;
    let kind: 'fn' | 'value' = 'value';
    if (value.kind === 'Fn') {
      kind = 'fn';
      signature = `fn(${value.params.join(', ')})`;
    }

    entries.push({
      name: node.name,
      kind,
      line: node.pos.line,
      signature,
      doc: docLines.join('\n'),
    });
  }
  return entries;
}

export function renderMarkdown(filename: string, entries: DocEntry[]): string {
  const lines: string[] = [];
  lines.push(`# \`${filename}\``);
  lines.push('');
  if (entries.length === 0) {
    lines.push('_No `///` doc comments found._');
    return lines.join('\n') + '\n';
  }
  for (const e of entries) {
    if (e.kind === 'fn') {
      lines.push(`## \`${e.name}${e.signature?.replace(/^fn/, '') ?? ''}\``);
    } else {
      lines.push(`## \`${e.name}\``);
    }
    lines.push('');
    lines.push(`*defined at line ${e.line}*`);
    lines.push('');
    lines.push(e.doc);
    lines.push('');
  }
  return lines.join('\n');
}

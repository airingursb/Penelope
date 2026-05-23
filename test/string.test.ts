import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';

test('A1: string literal parses to StringLit', () => {
  const ast = parse(tokenize('"hello";'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  expect(ast.nodes[stmt.exprId]).toMatchObject({ kind: 'StringLit', value: 'hello' });
});

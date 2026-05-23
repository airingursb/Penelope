import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';

test('parses empty program', () => {
  const ast = parse(tokenize(''));
  expect(ast.nodes[ast.rootId]).toMatchObject({ kind: 'Program', stmtIds: [] });
});

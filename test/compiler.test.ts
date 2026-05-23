// test/compiler.test.ts
import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';

test('empty program compiles to just HALT', () => {
  const ast = parse(tokenize(''));
  const prog = compile(ast);
  expect(prog.version).toBe(1);
  expect(prog.code).toEqual([['HALT']]);
  expect(prog.constants).toEqual([]);
});

test('"42;" compiles to LOAD_CONST 0; POP; HALT with constants=[int 42]', () => {
  const ast = parse(tokenize('42;'));
  const prog = compile(ast);
  expect(prog.constants).toEqual([{ tag: 'int', v: 42 }]);
  expect(prog.code).toEqual([
    ['LOAD_CONST', 0],
    ['POP'],
    ['HALT'],
  ]);
});

test('"true;" compiles', () => {
  const prog = compile(parse(tokenize('true;')));
  expect(prog.constants).toEqual([{ tag: 'bool', v: true }]);
  expect(prog.code).toEqual([['LOAD_CONST', 0], ['POP'], ['HALT']]);
});

test('"false;" compiles', () => {
  const prog = compile(parse(tokenize('false;')));
  expect(prog.constants).toEqual([{ tag: 'bool', v: false }]);
});

test('StringLit compiles', () => {
  const prog = compile(parse(tokenize('"hello";')));
  expect(prog.constants).toEqual([{ tag: 'str', v: 'hello' }]);
  expect(prog.code).toEqual([['LOAD_CONST', 0], ['POP'], ['HALT']]);
});

test('repeated string literals share one constant pool entry', () => {
  const prog = compile(parse(tokenize('"x"; "x"; "y";')));
  expect(prog.constants).toEqual([
    { tag: 'str', v: 'x' },
    { tag: 'str', v: 'y' },
  ]);
  // Three LOAD_CONST opcodes; first two index 0, third index 1.
  const loads = prog.code.filter(op => op[0] === 'LOAD_CONST');
  expect(loads).toEqual([['LOAD_CONST', 0], ['LOAD_CONST', 0], ['LOAD_CONST', 1]]);
});

test('Var compiles to LOAD_VAR', () => {
  const prog = compile(parse(tokenize('x;')));
  expect(prog.code).toEqual([
    ['LOAD_VAR', 'x', null],
    ['POP'],
    ['HALT'],
  ]);
});

test('1 + 2 compiles to LOAD_CONST, LOAD_CONST, BIN_OP', () => {
  const prog = compile(parse(tokenize('1 + 2;')));
  expect(prog.constants).toEqual([{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }]);
  expect(prog.code).toEqual([
    ['LOAD_CONST', 0],
    ['LOAD_CONST', 1],
    ['BIN_OP', '+'],
    ['POP'],
    ['HALT'],
  ]);
});

test('comparison op compiles', () => {
  const prog = compile(parse(tokenize('1 < 2;')));
  expect(prog.code).toContainEqual(['BIN_OP', '<']);
});

test('precedence: 1 + 2 * 3', () => {
  const prog = compile(parse(tokenize('1 + 2 * 3;')));
  // Parser already encoded precedence in AST shape — compiler just walks.
  // Expect: LOAD 1, LOAD 2, LOAD 3, BIN_OP *, BIN_OP +, POP, HALT
  const opNames = prog.code.map(op => op[0]);
  expect(opNames).toEqual(['LOAD_CONST', 'LOAD_CONST', 'LOAD_CONST', 'BIN_OP', 'BIN_OP', 'POP', 'HALT']);
});

test('let x = 10; compiles to LOAD_CONST, STORE_VAR x', () => {
  const prog = compile(parse(tokenize('let x = 10;')));
  expect(prog.constants).toEqual([{ tag: 'int', v: 10 }]);
  expect(prog.code).toEqual([
    ['LOAD_CONST', 0],
    ['STORE_VAR', 'x'],
    ['HALT'],
  ]);
});

test('let then use', () => {
  const prog = compile(parse(tokenize('let x = 10; x;')));
  expect(prog.code).toEqual([
    ['LOAD_CONST', 0],
    ['STORE_VAR', 'x'],
    ['LOAD_VAR', 'x', null],
    ['POP'],
    ['HALT'],
  ]);
});

test('fn() { 1 } compiles', () => {
  const prog = compile(parse(tokenize('let f = fn() { 1 };')));
  const opNames = prog.code.map(op => op[0]);
  // Expected:
  //   MAKE_CLOSURE [], body_ip=2, body_len=4   (0)
  //   JUMP past=6                              (1)
  //   ENTER_BLOCK                              (2) <- body_ip
  //   LOAD_CONST 1                             (3)
  //   EXIT_BLOCK                               (4)
  //   RETURN                                   (5)
  //   STORE_VAR f                              (6) <- past
  //   HALT                                     (7)
  expect(opNames).toEqual([
    'MAKE_CLOSURE', 'JUMP',
    'ENTER_BLOCK', 'LOAD_CONST', 'EXIT_BLOCK', 'RETURN',
    'STORE_VAR',
    'HALT',
  ]);
  const mk = prog.code[0] as ['MAKE_CLOSURE', string[], number, number];
  expect(mk[1]).toEqual([]);         // no params
  expect(mk[2]).toBe(2);             // body_ip = ENTER_BLOCK position
  expect(mk[3]).toBe(4);             // body_len = 4 opcodes (ENTER, LOAD, EXIT, RETURN)
  const jp = prog.code[1] as ['JUMP', number];
  expect(jp[1]).toBe(6);             // jumps past RETURN to STORE_VAR
});

test('fn with two params', () => {
  const prog = compile(parse(tokenize('let add = fn(a, b) { a + b };')));
  const mk = prog.code.find(op => op[0] === 'MAKE_CLOSURE') as ['MAKE_CLOSURE', string[], number, number];
  expect(mk[1]).toEqual(['a', 'b']);
});

test('print("hi") compiles to LOAD_CONST + EFFECT', () => {
  const prog = compile(parse(tokenize('print("hi");')));
  expect(prog.code).toEqual([
    ['LOAD_CONST', 0],
    ['EFFECT', 'print', 1, null],
    ['POP'],
    ['HALT'],
  ]);
});

test('str_length("abc") compiles to LOAD_CONST + CALL_BUILTIN', () => {
  const prog = compile(parse(tokenize('str_length("abc");')));
  expect(prog.code).toEqual([
    ['LOAD_CONST', 0],
    ['CALL_BUILTIN', 'str_length', 1],
    ['POP'],
    ['HALT'],
  ]);
});

test('normal closure call compiles to LOAD_VAR callee + args + CALL', () => {
  const prog = compile(parse(tokenize('let f = fn(x) { x }; f(7);')));
  // After fn defn and STORE_VAR f, the call sequence is:
  //   LOAD_VAR f, LOAD_CONST 7, CALL 1
  const callIdx = prog.code.findIndex(op => op[0] === 'CALL');
  expect(callIdx).toBeGreaterThan(0);
  expect(prog.code[callIdx]).toEqual(['CALL', 1]);
  expect(prog.code[callIdx - 1]).toEqual(['LOAD_CONST', 0]); // arg
  expect(prog.code[callIdx - 2]).toEqual(['LOAD_VAR', 'f', null]);
});

test('net_fetch is an effect', () => {
  const prog = compile(parse(tokenize('net_fetch("http://x");')));
  expect(prog.code.find(op => op[0] === 'EFFECT')).toEqual(['EFFECT', 'net_fetch', 1, null]);
});

test('Block with trailing expression', () => {
  // Trigger via if branch which uses Block
  const prog = compile(parse(tokenize('if (true) { 1 } else { 2 };')));
  // The then-block (single trailing expr 1) is ENTER_BLOCK, LOAD_CONST 1, EXIT_BLOCK
  const enterAt = prog.code.findIndex(op => op[0] === 'ENTER_BLOCK');
  expect(prog.code[enterAt + 1][0]).toBe('LOAD_CONST');
  expect(prog.code[enterAt + 2]).toEqual(['EXIT_BLOCK']);
});

test('Block with no trailing expression emits PUSH_UNIT', () => {
  const prog = compile(parse(tokenize('if (true) { let x = 1; } else { };')));
  // both blocks have no trailing expr — should PUSH_UNIT
  const pushUnitCount = prog.code.filter(op => op[0] === 'PUSH_UNIT').length;
  expect(pushUnitCount).toBe(2);
});

test('Pause compiles to PAUSE opcode', () => {
  const prog = compile(parse(tokenize('let x = pause;')));
  expect(prog.code).toContainEqual(['PAUSE']);
  // Sequence: PAUSE, STORE_VAR x, HALT
  expect(prog.code).toEqual([
    ['PAUSE'],
    ['STORE_VAR', 'x'],
    ['HALT'],
  ]);
});

test('if (true) { 1 } else { 2 } compiles with two jumps', () => {
  const prog = compile(parse(tokenize('if (true) { 1 } else { 2 };')));
  const opNames = prog.code.map(op => op[0]);
  // Expected sequence:
  //   LOAD_CONST true        (0)
  //   JUMP_IF_FALSE A        (1)
  //   ENTER_BLOCK            (2)
  //   LOAD_CONST 1           (3)
  //   EXIT_BLOCK             (4)
  //   JUMP B                 (5)
  //   ENTER_BLOCK            (6) <- A
  //   LOAD_CONST 2           (7)
  //   EXIT_BLOCK             (8)
  //                          (9) <- B
  //   POP                    (9)
  //   HALT                   (10)
  expect(opNames).toEqual([
    'LOAD_CONST',
    'JUMP_IF_FALSE',
    'ENTER_BLOCK', 'LOAD_CONST', 'EXIT_BLOCK',
    'JUMP',
    'ENTER_BLOCK', 'LOAD_CONST', 'EXIT_BLOCK',
    'POP',
    'HALT',
  ]);
  // Validate jump targets:
  const jif = prog.code[1] as ['JUMP_IF_FALSE', number];
  const jmp = prog.code[5] as ['JUMP', number];
  expect(jif[1]).toBe(6);   // points to ENTER_BLOCK of else branch
  expect(jmp[1]).toBe(9);   // points past else branch (POP)
});

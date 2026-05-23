// Penelope compiler. AST → bytecode (one fn per ASTNode kind).
// Walks AST in source order and emits Opcodes into a flat code array.
// Each emitted opcode is at the IP equal to code.length at emission time.

import type { ASTNode, ASTBundle } from './ast.js';
import type { Program, Opcode, ConstantPoolEntry } from './bytecode.js';
import { makeProgram, internConstant } from './bytecode.js';

export function compile(ast: ASTBundle): Program {
  const prog = makeProgram();
  compileNode(ast.nodes[ast.rootId], ast, prog);
  prog.code.push(['HALT']);
  return prog;
}

// Dispatch on node.kind. Tasks 6-15 fill in per-kind cases.
function compileNode(node: ASTNode, ast: ASTBundle, prog: Program): void {
  switch (node.kind) {
    case 'Program': {
      for (const stmtId of node.stmtIds) compileNode(ast.nodes[stmtId], ast, prog);
      return;
    }
    case 'IntLit': {
      const idx = internConstant(prog.constants, { tag: 'int', v: node.value });
      emit(prog, ['LOAD_CONST', idx]);
      return;
    }
    case 'ExprStmt': {
      compileNode(ast.nodes[node.exprId], ast, prog);
      emit(prog, ['POP']);
      return;
    }
    case 'BoolLit': {
      const idx = internConstant(prog.constants, { tag: 'bool', v: node.value });
      emit(prog, ['LOAD_CONST', idx]);
      return;
    }
    default:
      throw new Error(`compile: unhandled node kind '${(node as ASTNode).kind}'`);
  }
}

// Helper: emit a single opcode and return its IP.
function emit(prog: Program, op: Opcode): number {
  const ip = prog.code.length;
  prog.code.push(op);
  return ip;
}

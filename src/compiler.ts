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
    case 'StringLit': {
      const idx = internConstant(prog.constants, { tag: 'str', v: node.value });
      emit(prog, ['LOAD_CONST', idx]);
      return;
    }
    case 'Var': {
      emit(prog, ['LOAD_VAR', node.name, null]);  // null = ic slot, filled by VM
      return;
    }
    case 'BinOp': {
      compileNode(ast.nodes[node.leftId], ast, prog);
      compileNode(ast.nodes[node.rightId], ast, prog);
      emit(prog, ['BIN_OP', node.op]);
      return;
    }
    case 'Let': {
      compileNode(ast.nodes[node.valueId], ast, prog);
      emit(prog, ['STORE_VAR', node.name]);
      return;
    }
    case 'If': {
      // Compile cond
      compileNode(ast.nodes[node.condId], ast, prog);
      // Emit JUMP_IF_FALSE with placeholder target
      const jifIp = emit(prog, ['JUMP_IF_FALSE', -1]);
      // Compile then-block
      compileNode(ast.nodes[node.thenBlockId], ast, prog);
      // Emit JUMP past else with placeholder
      const jmpIp = emit(prog, ['JUMP', -1]);
      // Back-patch JUMP_IF_FALSE to point here (else start)
      (prog.code[jifIp] as ['JUMP_IF_FALSE', number])[1] = prog.code.length;
      // Compile else-block
      compileNode(ast.nodes[node.elseBlockId], ast, prog);
      // Back-patch JUMP to point here (past else)
      (prog.code[jmpIp] as ['JUMP', number])[1] = prog.code.length;
      return;
    }
    case 'Block': {
      emit(prog, ['ENTER_BLOCK']);
      for (const stmtId of node.stmtIds) compileNode(ast.nodes[stmtId], ast, prog);
      if (node.trailingExprId !== null) {
        compileNode(ast.nodes[node.trailingExprId], ast, prog);
      } else {
        emit(prog, ['PUSH_UNIT']);
      }
      emit(prog, ['EXIT_BLOCK']);
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

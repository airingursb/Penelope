// Penelope compiler. AST → bytecode (one fn per ASTNode kind).
// Walks AST in source order and emits Opcodes into a flat code array.
// Each emitted opcode is at the IP equal to code.length at emission time.

import type { ASTNode, ASTBundle } from './ast.js';
import type { Program, Opcode } from './bytecode.js';
import { makeProgram, internConstant } from './bytecode.js';
import { EFFECT_NAMES } from './effects.js';

const PURE_BUILTINS: ReadonlySet<string> = new Set([
  'str_length', 'str_slice', 'to_str',
  'list_new', 'list_push', 'list_get', 'list_set', 'list_len',
  'dict_new', 'dict_set', 'dict_get', 'dict_has', 'dict_keys',
]);

export function compile(ast: ASTBundle): Program {
  const prog = makeProgram();
  compileNode(ast.nodes[ast.rootId], ast, prog);
  emit(prog, ['HALT']);
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
      emit(prog, ['LOAD_CONST', idx], node);
      return;
    }
    case 'ExprStmt': {
      compileNode(ast.nodes[node.exprId], ast, prog);
      emit(prog, ['POP'], node);
      return;
    }
    case 'BoolLit': {
      const idx = internConstant(prog.constants, { tag: 'bool', v: node.value });
      emit(prog, ['LOAD_CONST', idx], node);
      return;
    }
    case 'StringLit': {
      const idx = internConstant(prog.constants, { tag: 'str', v: node.value });
      emit(prog, ['LOAD_CONST', idx], node);
      return;
    }
    case 'Var': {
      emit(prog, ['LOAD_VAR', node.name, null], node);  // null = ic slot, filled by VM
      return;
    }
    case 'BinOp': {
      compileNode(ast.nodes[node.leftId], ast, prog);
      compileNode(ast.nodes[node.rightId], ast, prog);
      emit(prog, ['BIN_OP', node.op], node);
      return;
    }
    case 'Let': {
      compileNode(ast.nodes[node.valueId], ast, prog);
      emit(prog, ['STORE_VAR', node.name], node);
      return;
    }
    case 'If': {
      // Compile cond
      compileNode(ast.nodes[node.condId], ast, prog);
      // Emit JUMP_IF_FALSE with placeholder target
      const jifIp = emit(prog, ['JUMP_IF_FALSE', -1], node);
      // Compile then-block
      compileNode(ast.nodes[node.thenBlockId], ast, prog);
      // Emit JUMP past else with placeholder
      const jmpIp = emit(prog, ['JUMP', -1], node);
      // Back-patch JUMP_IF_FALSE to point here (else start)
      (prog.code[jifIp] as ['JUMP_IF_FALSE', number])[1] = prog.code.length;
      // Compile else-block
      compileNode(ast.nodes[node.elseBlockId], ast, prog);
      // Back-patch JUMP to point here (past else)
      (prog.code[jmpIp] as ['JUMP', number])[1] = prog.code.length;
      return;
    }
    case 'Block': {
      emit(prog, ['ENTER_BLOCK'], node);
      for (const stmtId of node.stmtIds) compileNode(ast.nodes[stmtId], ast, prog);
      if (node.trailingExprId !== null) {
        compileNode(ast.nodes[node.trailingExprId], ast, prog);
      } else {
        emit(prog, ['PUSH_UNIT'], node);
      }
      emit(prog, ['EXIT_BLOCK'], node);
      return;
    }
    case 'Call': {
      const callee = ast.nodes[node.calleeId];
      // Effect builtin?
      if (callee.kind === 'Var' && EFFECT_NAMES.has(callee.name as any)) {
        for (const argId of node.argIds) compileNode(ast.nodes[argId], ast, prog);
        emit(prog, ['EFFECT', callee.name, node.argIds.length, null], node);
        return;
      }
      // Pure builtin?
      if (callee.kind === 'Var' && PURE_BUILTINS.has(callee.name)) {
        for (const argId of node.argIds) compileNode(ast.nodes[argId], ast, prog);
        emit(prog, ['CALL_BUILTIN', callee.name, node.argIds.length], node);
        return;
      }
      // Normal closure call: callee, then args, then CALL.
      compileNode(callee, ast, prog);
      for (const argId of node.argIds) compileNode(ast.nodes[argId], ast, prog);
      emit(prog, ['CALL', node.argIds.length], node);
      return;
    }
    case 'Fn': {
      // Emit MAKE_CLOSURE with placeholders; back-patch body_ip and body_len.
      const mkIp = emit(prog, ['MAKE_CLOSURE', node.params, -1, -1], node);
      // Emit JUMP-past-body with placeholder
      const jmpIp = emit(prog, ['JUMP', -1], node);
      // Body starts here
      const bodyStartIp = prog.code.length;
      compileNode(ast.nodes[node.bodyBlockId], ast, prog);
      emit(prog, ['RETURN'], node);
      const bodyEndIp = prog.code.length;
      // Back-patch MAKE_CLOSURE body_ip and body_len
      (prog.code[mkIp] as ['MAKE_CLOSURE', string[], number, number])[2] = bodyStartIp;
      (prog.code[mkIp] as ['MAKE_CLOSURE', string[], number, number])[3] = bodyEndIp - bodyStartIp;
      // Back-patch JUMP to land here (past body)
      (prog.code[jmpIp] as ['JUMP', number])[1] = prog.code.length;
      return;
    }
    case 'Pause': {
      emit(prog, ['PAUSE'], node);
      return;
    }
    default:
      throw new Error(`compile: unhandled node kind '${(node as ASTNode).kind}'`);
  }
}

// Helper: emit a single opcode and return its IP. Records source position for VM error messages.
function emit(prog: Program, op: Opcode, from?: ASTNode): number {
  const ip = prog.code.length;
  prog.code.push(op);
  if (!prog.sourceMap) prog.sourceMap = [];
  prog.sourceMap[ip] = from?.pos ?? null;
  return ip;
}

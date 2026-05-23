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
  compileNode(ast.nodes[ast.rootId], ast, prog, false);
  emit(prog, ['HALT']);
  return prog;
}

// `tail` = this node is in tail position of an enclosing fn body.
// A Call in tail position becomes a TAILCALL (frame reuse — no stack growth).
function compileNode(node: ASTNode, ast: ASTBundle, prog: Program, tail: boolean): void {
  switch (node.kind) {
    case 'Program': {
      for (const stmtId of node.stmtIds) compileNode(ast.nodes[stmtId], ast, prog, false);
      return;
    }
    case 'IntLit': {
      const idx = internConstant(prog.constants, { tag: 'int', v: node.value });
      emit(prog, ['LOAD_CONST', idx], node);
      return;
    }
    case 'ExprStmt': {
      compileNode(ast.nodes[node.exprId], ast, prog, false);
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
    case 'UnitLit': {
      emit(prog, ['PUSH_UNIT'], node);
      return;
    }
    case 'Var': {
      emit(prog, ['LOAD_VAR', node.name, null], node);  // null = ic slot, filled by VM
      return;
    }
    case 'BinOp': {
      compileNode(ast.nodes[node.leftId], ast, prog, false);
      compileNode(ast.nodes[node.rightId], ast, prog, false);
      emit(prog, ['BIN_OP', node.op], node);
      return;
    }
    case 'Let': {
      compileNode(ast.nodes[node.valueId], ast, prog, false);
      emit(prog, ['STORE_VAR', node.name], node);
      return;
    }
    case 'If': {
      compileNode(ast.nodes[node.condId], ast, prog, false);
      const jifIp = emit(prog, ['JUMP_IF_FALSE', -1], node);
      // If `tail`, both branches inherit tail position.
      compileNode(ast.nodes[node.thenBlockId], ast, prog, tail);
      const jmpIp = emit(prog, ['JUMP', -1], node);
      (prog.code[jifIp] as ['JUMP_IF_FALSE', number])[1] = prog.code.length;
      compileNode(ast.nodes[node.elseBlockId], ast, prog, tail);
      (prog.code[jmpIp] as ['JUMP', number])[1] = prog.code.length;
      return;
    }
    case 'Block': {
      emit(prog, ['ENTER_BLOCK'], node);
      for (const stmtId of node.stmtIds) compileNode(ast.nodes[stmtId], ast, prog, false);
      if (node.trailingExprId !== null) {
        // The trailing expression of a tail-block is itself in tail position.
        compileNode(ast.nodes[node.trailingExprId], ast, prog, tail);
      } else {
        emit(prog, ['PUSH_UNIT'], node);
      }
      emit(prog, ['EXIT_BLOCK'], node);
      return;
    }
    case 'Call': {
      const callee = ast.nodes[node.calleeId];
      // Effect builtin? Never tail-callable (replay semantics + side effects).
      if (callee.kind === 'Var' && EFFECT_NAMES.has(callee.name as any)) {
        for (const argId of node.argIds) compileNode(ast.nodes[argId], ast, prog, false);
        emit(prog, ['EFFECT', callee.name, node.argIds.length, null], node);
        return;
      }
      // Pure builtin? Never tail-callable (synchronous return, no frame).
      if (callee.kind === 'Var' && PURE_BUILTINS.has(callee.name)) {
        for (const argId of node.argIds) compileNode(ast.nodes[argId], ast, prog, false);
        emit(prog, ['CALL_BUILTIN', callee.name, node.argIds.length], node);
        return;
      }
      // Normal closure call.
      compileNode(callee, ast, prog, false);
      for (const argId of node.argIds) compileNode(ast.nodes[argId], ast, prog, false);
      emit(prog, [tail ? 'TAILCALL' : 'CALL', node.argIds.length], node);
      return;
    }
    case 'Fn': {
      const mkIp = emit(prog, ['MAKE_CLOSURE', node.params, -1, -1], node);
      const jmpIp = emit(prog, ['JUMP', -1], node);
      const bodyStartIp = prog.code.length;
      // The body block is in tail position.
      compileNode(ast.nodes[node.bodyBlockId], ast, prog, true);
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
    case 'Match': {
      compileMatch(node, ast, prog, tail);
      return;
    }
    default:
      throw new Error(`compile: unhandled node kind '${(node as ASTNode).kind}'`);
  }
}

function compileMatch(
  node: Extract<ASTNode, { kind: 'Match' }>,
  ast: ASTBundle,
  prog: Program,
  tail: boolean,
): void {
  // Wrap the whole match in a block so the temp doesn't leak.
  emit(prog, ['ENTER_BLOCK'], node);
  compileNode(ast.nodes[node.scrutineeId], ast, prog, false);
  emit(prog, ['STORE_VAR', '__match_tmp'], node);

  const endJumps: number[] = [];   // JUMP IPs to back-patch at the end
  for (let i = 0; i < node.arms.length; i++) {
    const arm = node.arms[i];
    const isLast = i === node.arms.length - 1;

    let nextArmJif = -1;   // JUMP_IF_FALSE that skips this arm
    if (arm.pattern.kind !== 'wildcard' && arm.pattern.kind !== 'var') {
      // Emit: LOAD_VAR __match_tmp, LOAD_CONST pattern_value, BIN_OP ==, JUMP_IF_FALSE next
      emit(prog, ['LOAD_VAR', '__match_tmp', null], node);
      const pat = arm.pattern;
      if (pat.kind === 'int') {
        const idx = internConstant(prog.constants, { tag: 'int', v: pat.value });
        emit(prog, ['LOAD_CONST', idx], node);
      } else if (pat.kind === 'bool') {
        const idx = internConstant(prog.constants, { tag: 'bool', v: pat.value });
        emit(prog, ['LOAD_CONST', idx], node);
      } else if (pat.kind === 'str') {
        const idx = internConstant(prog.constants, { tag: 'str', v: pat.value });
        emit(prog, ['LOAD_CONST', idx], node);
      }
      emit(prog, ['BIN_OP', '=='], node);
      nextArmJif = emit(prog, ['JUMP_IF_FALSE', -1], node);
    }

    // Arm body — give var pattern a binding scope.
    emit(prog, ['ENTER_BLOCK'], node);
    if (arm.pattern.kind === 'var') {
      emit(prog, ['LOAD_VAR', '__match_tmp', null], node);
      emit(prog, ['STORE_VAR', arm.pattern.name], node);
    }
    compileNode(ast.nodes[arm.bodyId], ast, prog, tail);
    emit(prog, ['EXIT_BLOCK'], node);

    if (!isLast) {
      // Jump past remaining arms.
      const jmp = emit(prog, ['JUMP', -1], node);
      endJumps.push(jmp);
    }
    // Back-patch the JIF for this arm to land on the next arm's start.
    if (nextArmJif >= 0) {
      (prog.code[nextArmJif] as ['JUMP_IF_FALSE', number])[1] = prog.code.length;
    }
  }

  // If the last arm wasn't a catch-all and didn't match, the JIF would land here
  // with nothing pushed. Push unit so the EXIT_BLOCK below has something to preserve.
  const lastPat = node.arms[node.arms.length - 1].pattern;
  if (lastPat.kind !== 'wildcard' && lastPat.kind !== 'var') {
    emit(prog, ['PUSH_UNIT'], node);
  }

  // Back-patch all end-jumps.
  for (const j of endJumps) {
    (prog.code[j] as ['JUMP', number])[1] = prog.code.length;
  }

  emit(prog, ['EXIT_BLOCK'], node);
}

// Helper: emit a single opcode and return its IP. Records source position for VM error messages.
function emit(prog: Program, op: Opcode, from?: ASTNode): number {
  const ip = prog.code.length;
  prog.code.push(op);
  if (!prog.sourceMap) prog.sourceMap = [];
  prog.sourceMap[ip] = from?.pos ?? null;
  return ip;
}

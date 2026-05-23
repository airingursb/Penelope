// Penelope compiler. AST → bytecode (one fn per ASTNode kind).
// Walks AST in source order and emits Opcodes into a flat code array.
// Each emitted opcode is at the IP equal to code.length at emission time.

import type { ASTNode, ASTBundle } from './ast.js';
import type { Program, Opcode } from './bytecode.js';
import { makeProgram, internConstant } from './bytecode.js';
import { EFFECT_NAMES } from './effects.js';

const PURE_BUILTINS: ReadonlySet<string> = new Set([
  'str_length', 'str_slice', 'to_str', 'type_of',
  'str_chars', 'str_at', 'str_find', 'str_starts_with', 'str_ends_with', 'int_of_str',
  'list_new', 'list_push', 'list_get', 'list_set', 'list_len', 'list_slice', 'list_concat', 'list_reverse',
  'dict_new', 'dict_set', 'dict_get', 'dict_has', 'dict_keys',
  'char_is_digit', 'char_is_alpha', 'char_is_alphanum', 'char_is_whitespace',
  'panic',
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
  emit(prog, ['ENTER_BLOCK'], node);
  compileNode(ast.nodes[node.scrutineeId], ast, prog, false);
  emit(prog, ['STORE_VAR', '__match_tmp'], node);

  const endJumps: number[] = [];
  for (let i = 0; i < node.arms.length; i++) {
    const arm = node.arms[i];
    const isLast = i === node.arms.length - 1;

    // Each arm runs in its own block so pattern bindings stay scoped.
    emit(prog, ['ENTER_BLOCK'], node);

    // Emit a pattern check that leaves a bool on the stack and registers bindings if true.
    emitPatternCheck(arm.pattern, () => emit(prog, ['LOAD_VAR', '__match_tmp', null], node), prog, node);
    // JIF false: bail out of this arm (EXIT_BLOCK then jump to next).
    const failJif = emit(prog, ['JUMP_IF_FALSE', -1], node);

    // Guard check (optional). If guard is false, also bail out.
    let guardJif = -1;
    if (arm.guardId !== undefined) {
      compileNode(ast.nodes[arm.guardId], ast, prog, false);
      guardJif = emit(prog, ['JUMP_IF_FALSE', -1], node);
    }

    // Body.
    compileNode(ast.nodes[arm.bodyId], ast, prog, tail);
    emit(prog, ['EXIT_BLOCK'], node);
    const successJump = emit(prog, ['JUMP', -1], node);
    endJumps.push(successJump);

    // Failure landing pad: pop the arm's block, then either fall through to next
    // arm or (if this is the last) push unit as the match's value.
    (prog.code[failJif] as ['JUMP_IF_FALSE', number])[1] = prog.code.length;
    if (guardJif >= 0) (prog.code[guardJif] as ['JUMP_IF_FALSE', number])[1] = prog.code.length;
    emit(prog, ['EXIT_BLOCK'], node);
    if (isLast) {
      emit(prog, ['PUSH_UNIT'], node);
    }
  }

  for (const j of endJumps) {
    (prog.code[j] as ['JUMP', number])[1] = prog.code.length;
  }

  emit(prog, ['EXIT_BLOCK'], node);
}

// Emit code that pushes a bool (matched?) on the stack and registers bindings on match.
// `loadScrut` emits code that loads the scrutinee value onto the stack.
function emitPatternCheck(
  pat: import('./ast.js').Pattern,
  loadScrut: () => void,
  prog: Program,
  node: ASTNode,
): void {
  switch (pat.kind) {
    case 'wildcard': {
      const idx = internConstant(prog.constants, { tag: 'bool', v: true });
      emit(prog, ['LOAD_CONST', idx], node);
      return;
    }
    case 'var': {
      loadScrut();
      emit(prog, ['STORE_VAR', pat.name], node);
      const idx = internConstant(prog.constants, { tag: 'bool', v: true });
      emit(prog, ['LOAD_CONST', idx], node);
      return;
    }
    case 'int': {
      loadScrut();
      emit(prog, ['LOAD_CONST', internConstant(prog.constants, { tag: 'int', v: pat.value })], node);
      emit(prog, ['BIN_OP', '=='], node);
      return;
    }
    case 'bool': {
      loadScrut();
      emit(prog, ['LOAD_CONST', internConstant(prog.constants, { tag: 'bool', v: pat.value })], node);
      emit(prog, ['BIN_OP', '=='], node);
      return;
    }
    case 'str': {
      loadScrut();
      emit(prog, ['LOAD_CONST', internConstant(prog.constants, { tag: 'str', v: pat.value })], node);
      emit(prog, ['BIN_OP', '=='], node);
      return;
    }
    case 'unit': {
      loadScrut();
      emit(prog, ['LOAD_CONST', internConstant(prog.constants, { tag: 'unit' })], node);
      emit(prog, ['BIN_OP', '=='], node);
      return;
    }
    case 'or': {
      // First sub-pattern check.
      emitPatternCheck(pat.patterns[0], loadScrut, prog, node);
      // For each remaining: if the running result is false, try the next.
      for (let i = 1; i < pat.patterns.length; i++) {
        // Stack: [..., currentBool]. If true, jump past the next check.
        // We need JIF inverse — use IF (cond) { true } else { subN }.
        // Implementation: JIF nextCheck, then PUSH true, JUMP end. nextCheck: subN. end:
        const skipIfTrueIp = emit(prog, ['JUMP_IF_FALSE', -1], node);
        // The branch when currentBool was true:
        const trueIdx = internConstant(prog.constants, { tag: 'bool', v: true });
        emit(prog, ['LOAD_CONST', trueIdx], node);
        const endJmp = emit(prog, ['JUMP', -1], node);
        // The branch when currentBool was false: try next sub-pattern
        (prog.code[skipIfTrueIp] as ['JUMP_IF_FALSE', number])[1] = prog.code.length;
        emitPatternCheck(pat.patterns[i], loadScrut, prog, node);
        (prog.code[endJmp] as ['JUMP', number])[1] = prog.code.length;
      }
      return;
    }
    case 'list': {
      // is_list?  type_of(scrut) == "list"
      loadScrut();
      emit(prog, ['CALL_BUILTIN', 'type_of', 1], node);
      emit(prog, ['LOAD_CONST', internConstant(prog.constants, { tag: 'str', v: 'list' })], node);
      emit(prog, ['BIN_OP', '=='], node);
      const notListJif = emit(prog, ['JUMP_IF_FALSE', -1], node);

      // length check: with rest, len >= items.length; without rest, len == items.length
      loadScrut();
      emit(prog, ['CALL_BUILTIN', 'list_len', 1], node);
      emit(prog, ['LOAD_CONST', internConstant(prog.constants, { tag: 'int', v: pat.items.length })], node);
      emit(prog, ['BIN_OP', pat.rest !== undefined ? '>=' : '=='], node);
      const wrongLenJif = emit(prog, ['JUMP_IF_FALSE', -1], node);

      // Now check each item.  Each sub-check leaves a bool on stack; AND them via JIF.
      const failureJifs: number[] = [notListJif, wrongLenJif];
      for (let i = 0; i < pat.items.length; i++) {
        const loadItem = (): void => {
          loadScrut();
          emit(prog, ['LOAD_CONST', internConstant(prog.constants, { tag: 'int', v: i })], node);
          emit(prog, ['CALL_BUILTIN', 'list_get', 2], node);
        };
        emitPatternCheck(pat.items[i], loadItem, prog, node);
        failureJifs.push(emit(prog, ['JUMP_IF_FALSE', -1], node));
      }

      // Bind rest if present (matches the tail past pat.items.length).
      if (pat.rest !== undefined) {
        loadScrut();
        emit(prog, ['LOAD_CONST', internConstant(prog.constants, { tag: 'int', v: pat.items.length })], node);
        loadScrut();
        emit(prog, ['CALL_BUILTIN', 'list_len', 1], node);
        emit(prog, ['CALL_BUILTIN', 'list_slice', 3], node);
        emit(prog, ['STORE_VAR', pat.rest], node);
      }

      emit(prog, ['LOAD_CONST', internConstant(prog.constants, { tag: 'bool', v: true })], node);
      const okJump = emit(prog, ['JUMP', -1], node);
      // All failure paths land here and push false.
      for (const jif of failureJifs) (prog.code[jif] as ['JUMP_IF_FALSE', number])[1] = prog.code.length;
      emit(prog, ['LOAD_CONST', internConstant(prog.constants, { tag: 'bool', v: false })], node);
      (prog.code[okJump] as ['JUMP', number])[1] = prog.code.length;
      return;
    }
    case 'dict': {
      // is_dict?
      loadScrut();
      emit(prog, ['CALL_BUILTIN', 'type_of', 1], node);
      emit(prog, ['LOAD_CONST', internConstant(prog.constants, { tag: 'str', v: 'dict' })], node);
      emit(prog, ['BIN_OP', '=='], node);
      const failureJifs: number[] = [];
      failureJifs.push(emit(prog, ['JUMP_IF_FALSE', -1], node));

      // For each entry: check key exists + recursive pattern match
      for (const entry of pat.entries) {
        // dict_has(scrut, key)
        loadScrut();
        emit(prog, ['LOAD_CONST', internConstant(prog.constants, { tag: 'str', v: entry.key })], node);
        emit(prog, ['CALL_BUILTIN', 'dict_has', 2], node);
        failureJifs.push(emit(prog, ['JUMP_IF_FALSE', -1], node));

        // Recursive check with loadValue = dict_get(scrut, key)
        const loadValue = (): void => {
          loadScrut();
          emit(prog, ['LOAD_CONST', internConstant(prog.constants, { tag: 'str', v: entry.key })], node);
          emit(prog, ['CALL_BUILTIN', 'dict_get', 2], node);
        };
        emitPatternCheck(entry.pattern, loadValue, prog, node);
        failureJifs.push(emit(prog, ['JUMP_IF_FALSE', -1], node));
      }

      emit(prog, ['LOAD_CONST', internConstant(prog.constants, { tag: 'bool', v: true })], node);
      const okJump = emit(prog, ['JUMP', -1], node);
      for (const jif of failureJifs) (prog.code[jif] as ['JUMP_IF_FALSE', number])[1] = prog.code.length;
      emit(prog, ['LOAD_CONST', internConstant(prog.constants, { tag: 'bool', v: false })], node);
      (prog.code[okJump] as ['JUMP', number])[1] = prog.code.length;
      return;
    }
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

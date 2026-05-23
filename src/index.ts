// Public entry point for `import { ... } from 'penelope-lang'`.
//
// We re-export the most useful surface: the VM, JIT, type checker (incl. effect
// types), snapshot encoder/decoder, loader, parser, compiler, and the
// distributed runtime pieces. Internal helpers stay behind their own modules.

export { tokenize, tokenizeWithComments } from './lexer.js';
export type { Token, TokenKind, TemplatePart, Comment } from './lexer.js';

export { parse } from './parser.js';
export type { ASTNode, ASTBundle, Pattern, MatchArm, Value, NodeId, Pos, BinOp } from './ast.js';

export { compile } from './compiler.js';
export type { Program, Opcode } from './bytecode.js';

export { run, freshState, makeProfile } from './vm.js';
export type { RunResult, ProfileData, StepMode, DebugStop } from './vm.js';

export { jitCompile, jitRun } from './jit.js';

export {
  check, checkWithTypes, checkWithEffects,
  builtinEffects, effectsUnion, effectsStr, typeStr,
  PURE, T_INT, T_BOOL, T_STR, T_UNIT, T_LIST, T_DICT, T_UNKNOWN,
} from './typecheck.js';
export type { Type, TypeError, EffectName, EffectSet } from './typecheck.js';

export { loadSource, loadSourceWithMap } from './loader.js';

export { serialize, deserialize, sha256 } from './snapshot.js';
export type { Snapshot, VMState, Frame, EffectEntry } from './snapshot.js';

export { writePencFile, readPencFile } from './encoder.js';

export { runOptimizer } from './optimizer.js';
export type { OLevel } from './optimizer.js';

export { remapState } from './live-edit.js';

// Distributed runtime
export { Coordinator } from './dist/coordinator.js';
export { Worker, submitJob, awaitJob } from './dist/worker.js';
export { FileStore, InMemoryStore } from './dist/store.js';
export type { JobRecord, JobStore } from './dist/store.js';

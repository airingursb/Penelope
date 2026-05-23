// Live-editing support: remap a paused VMState from old bytecode to new bytecode
// after the source has been edited.
//
// Strategy (conservative): for every ip referenced in the state, find the new ip
// with the same source position. If any can't be matched, abort the edit.

import type { Program } from './bytecode.js';
import type { VMState, Frame } from './snapshot.js';
import type { Value, Pos } from './ast.js';

export type RemapOk = { ok: true; state: VMState };
export type RemapErr = { ok: false; reason: string };
export type RemapResult = RemapOk | RemapErr;

// Build a position → ip lookup for a program.
// For source positions that map to MULTIPLE ips (e.g., several opcodes from one node),
// we record the FIRST ip found (the canonical "entry" to that source position).
function buildPosIndex(prog: Program): Map<string, number> {
  const idx = new Map<string, number>();
  if (!prog.sourceMap) return idx;
  for (let ip = 0; ip < prog.sourceMap.length; ip++) {
    const pos = prog.sourceMap[ip];
    if (!pos) continue;
    const key = posKey(pos);
    if (!idx.has(key)) idx.set(key, ip);
  }
  return idx;
}

function posKey(p: Pos): string {
  return `${p.line}:${p.col}`;
}

// Translate an old IP to a new IP via source-position lookup. Returns -1 on failure.
function translateIp(oldProg: Program, newPosIdx: Map<string, number>, oldIp: number): number {
  if (oldIp < 0 || oldIp >= (oldProg.sourceMap?.length ?? 0)) return -1;
  const pos = oldProg.sourceMap?.[oldIp];
  if (!pos) return -1;
  const newIp = newPosIdx.get(posKey(pos));
  return newIp ?? -1;
}

// Translate a closure: find new bodyIp + bodyLen.  bodyLen is computed by
// walking forward in newProg.code from newBodyIp until we hit the corresponding
// RETURN (the opcode whose source pos matches oldProg's RETURN position).
function remapClosure(
  oldProg: Program,
  _newProg: Program,
  newPosIdx: Map<string, number>,
  closure: Extract<Value, { tag: 'closure' }>,
): Extract<Value, { tag: 'closure' }> | null {
  const newBodyIp = translateIp(oldProg, newPosIdx, closure.bodyIp);
  if (newBodyIp < 0) return null;
  // bodyLen = number of opcodes from bodyIp through the closure's RETURN.
  // Old RETURN is at closure.bodyIp + closure.bodyLen - 1.
  const oldRetIp = closure.bodyIp + closure.bodyLen - 1;
  const newRetIp = translateIp(oldProg, newPosIdx, oldRetIp);
  if (newRetIp < 0) return null;
  const newBodyLen = (newRetIp - newBodyIp) + 1;
  if (newBodyLen <= 0) return null;
  return {
    tag: 'closure',
    params: closure.params,
    bodyIp: newBodyIp,
    bodyLen: newBodyLen,
    capturedFrameIdx: closure.capturedFrameIdx,
  };
}

function remapValue(
  oldProg: Program,
  newProg: Program,
  newPosIdx: Map<string, number>,
  v: Value,
): Value | null {
  if (v.tag === 'closure') {
    const r = remapClosure(oldProg, newProg, newPosIdx, v);
    return r;
  }
  if (v.tag === 'list') {
    const items: Value[] = [];
    for (const it of v.items) {
      const r = remapValue(oldProg, newProg, newPosIdx, it);
      if (r === null) return null;
      items.push(r);
    }
    return { tag: 'list', items };
  }
  if (v.tag === 'dict') {
    const entries: Record<string, Value> = {};
    for (const [k, vv] of Object.entries(v.entries)) {
      const r = remapValue(oldProg, newProg, newPosIdx, vv);
      if (r === null) return null;
      entries[k] = r;
    }
    return { tag: 'dict', entries };
  }
  // primitives unchanged
  return v;
}

function remapFrame(
  oldProg: Program,
  newProg: Program,
  newPosIdx: Map<string, number>,
  frame: Frame,
): Frame | null {
  const bindings: Record<string, Value> = {};
  for (const [name, v] of Object.entries(frame.bindings)) {
    const r = remapValue(oldProg, newProg, newPosIdx, v);
    if (r === null) return null;
    bindings[name] = r;
  }
  let returnIP = frame.returnIP;
  if (returnIP !== undefined) {
    const r = translateIp(oldProg, newPosIdx, returnIP);
    if (r < 0) return null;
    returnIP = r;
  }
  const next: Frame = { bindings };
  if (returnIP !== undefined) next.returnIP = returnIP;
  if (frame.parentIdx !== undefined) next.parentIdx = frame.parentIdx;
  return next;
}

export function remapState(oldProg: Program, newProg: Program, state: VMState): RemapResult {
  const newPosIdx = buildPosIndex(newProg);
  if (newPosIdx.size === 0) {
    return { ok: false, reason: 'new program has no source map; cannot remap' };
  }

  // 1) Translate the suspended ip.
  const newIp = translateIp(oldProg, newPosIdx, state.ip);
  if (newIp < 0) {
    const oldPos = oldProg.sourceMap?.[state.ip];
    return {
      ok: false,
      reason: oldPos
        ? `paused source position line ${oldPos.line} col ${oldPos.col} no longer exists in new source`
        : `paused ip ${state.ip} has no source position to remap`,
    };
  }
  // Sanity: the opcode kind at the resumed ip must match what was there before.
  // Resuming an old PAUSE into a new LOAD_CONST (or similar) silently corrupts semantics.
  const oldOpKind = oldProg.code[state.ip]?.[0];
  const newOpKind = newProg.code[newIp]?.[0];
  if (oldOpKind && newOpKind && oldOpKind !== newOpKind) {
    return {
      ok: false,
      reason: `paused on ${oldOpKind} but new program has ${newOpKind} at the same source position`,
    };
  }

  // 2) Translate value-stack closures.
  const newValueStack: Value[] = [];
  for (const v of state.valueStack) {
    const r = remapValue(oldProg, newProg, newPosIdx, v);
    if (r === null) return { ok: false, reason: 'closure on value stack references vanished code' };
    newValueStack.push(r);
  }

  // 3) Translate frames (bindings + returnIP).
  const newFrames: Frame[] = [];
  for (const f of state.frames) {
    const r = remapFrame(oldProg, newProg, newPosIdx, f);
    if (r === null) return { ok: false, reason: 'frame references vanished code (active call needs re-translation)' };
    newFrames.push(r);
  }

  // 4) Translate effect entries' ip too — they're used for replay lookup.
  const newEffects = state.effects.map(e => {
    const newEip = translateIp(oldProg, newPosIdx, e.ip);
    return { ...e, ip: newEip >= 0 ? newEip : e.ip };
  });

  return {
    ok: true,
    state: {
      ip: newIp,
      valueStack: newValueStack,
      frames: newFrames,
      effects: newEffects,
      timeOverride: state.timeOverride,
      noReplay: state.noReplay,
    },
  };
}

import type { Program } from './bytecode.js';

export type OLevel = 0 | 1 | 2;

export type Pass = (prog: Program) => Program;

// Will be filled in by T32-T50 as each pass lands.
function passesForLevel(level: OLevel): Pass[] {
  if (level === 0) return [];
  const cheap: Pass[] = [];
  if (level === 1) return cheap;
  return [...cheap];
}

export function runOptimizer(prog: Program, level: OLevel): Program {
  let p = prog;
  for (const pass of passesForLevel(level)) {
    p = pass(p);
  }
  return p;
}

import type { Program } from './bytecode.js';
import { constFoldPass } from './optimizer/constfold.js';
import { dcePass } from './optimizer/dce.js';
import { icPass } from './optimizer/ic.js';
import { inlinePass } from './optimizer/inline.js';
import { peepholePass } from './optimizer/peephole.js';

export type OLevel = 0 | 1 | 2;

export type Pass = (prog: Program) => Program;

function passesForLevel(level: OLevel): Pass[] {
  if (level === 0) return [];
  const cheap: Pass[] = [constFoldPass, dcePass, peepholePass];
  if (level === 1) return cheap;
  return [...cheap, icPass, inlinePass, peepholePass];
}

export function runOptimizer(prog: Program, level: OLevel): Program {
  let p = prog;
  for (const pass of passesForLevel(level)) {
    p = pass(p);
  }
  return p;
}

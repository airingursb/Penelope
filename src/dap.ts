// Minimal Penelope Debug Adapter (DAP) — talks the standard DAP protocol over stdio.
//
// What works:
//   - launch (sourcePath in program)
//   - setBreakpoints (by source line)
//   - configurationDone → starts running
//   - continue (resume until next breakpoint or halt)
//   - threads / stackTrace / scopes / variables
//   - terminate / disconnect
//
// Not implemented yet:
//   - stepIn / stepOver / stepOut (needs proper single-step in VM)
//   - conditional / log breakpoints
//   - exception breakpoints

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { compile } from './compiler.js';
import { freshState, runUntilBreakpoint } from './vm.js';
import type { Program } from './bytecode.js';
import type { VMState } from './snapshot.js';
import type { Value } from './ast.js';

type DapMessage = {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  event?: string;
  arguments?: any;
  request_seq?: number;
  success?: boolean;
  body?: any;
};

let seqCounter = 1;
let prog: Program | null = null;
let state: VMState | null = null;
let sourcePath: string = '';
let breakpointIps: Set<number> = new Set();
let breakpointsBySourceLine = new Map<number, number>();  // source-line → ip

function send(msg: object): void {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function reply(req: DapMessage, body?: any, success: boolean = true): void {
  send({
    seq: seqCounter++,
    type: 'response',
    request_seq: req.seq,
    command: req.command,
    success,
    body,
  });
}

function event(name: string, body?: any): void {
  send({
    seq: seqCounter++,
    type: 'event',
    event: name,
    body,
  });
}

function buildSourceLineMap(): void {
  if (!prog?.sourceMap) return;
  breakpointsBySourceLine.clear();
  // For each source line, find the FIRST ip with that line — use as the breakpoint target.
  for (let ip = 0; ip < prog.sourceMap.length; ip++) {
    const pos = prog.sourceMap[ip];
    if (pos && !breakpointsBySourceLine.has(pos.line)) {
      breakpointsBySourceLine.set(pos.line, ip);
    }
  }
}

function valueRepr(v: Value): string {
  if (v.tag === 'int') return String(v.v);
  if (v.tag === 'bool') return v.v ? 'true' : 'false';
  if (v.tag === 'str') return JSON.stringify(v.v);
  if (v.tag === 'unit') return '()';
  if (v.tag === 'closure') return '<fn>';
  if (v.tag === 'list') return `list[${v.items.length}]`;
  if (v.tag === 'dict') return `dict[${Object.keys(v.entries).length}]`;
  return '<unknown>';
}

export function handleMessage(msg: DapMessage): void {
  if (msg.type !== 'request') return;
  switch (msg.command) {
    case 'initialize': {
      reply(msg, {
        supportsConfigurationDoneRequest: true,
        supportsBreakpointLocationsRequest: false,
      });
      event('initialized');
      break;
    }
    case 'launch': {
      const args = msg.arguments ?? {};
      sourcePath = args.program;
      try {
        const source = readFileSync(resolve(sourcePath), 'utf8');
        prog = compile(parse(tokenize(source)));
        state = freshState();
        breakpointIps = new Set();
        breakpointsBySourceLine = new Map();
        buildSourceLineMap();
        reply(msg);
      } catch (e) {
        reply(msg, { error: (e as Error).message }, false);
      }
      break;
    }
    case 'setBreakpoints': {
      const args = msg.arguments ?? {};
      const lines: number[] = (args.breakpoints ?? args.lines ?? []).map((b: any) =>
        typeof b === 'object' ? b.line : b
      );
      breakpointIps = new Set();
      const result: object[] = [];
      for (const line of lines) {
        const ip = breakpointsBySourceLine.get(line);
        if (ip !== undefined) {
          breakpointIps.add(ip);
          result.push({ verified: true, line });
        } else {
          result.push({ verified: false, line, message: 'no opcode at this line' });
        }
      }
      reply(msg, { breakpoints: result });
      break;
    }
    case 'configurationDone': {
      reply(msg);
      runToNextStop('entry');
      break;
    }
    case 'continue': {
      reply(msg, { allThreadsContinued: true });
      runToNextStop('breakpoint');
      break;
    }
    case 'threads': {
      reply(msg, { threads: [{ id: 1, name: 'main' }] });
      break;
    }
    case 'stackTrace': {
      if (!state || !prog) { reply(msg, { stackFrames: [], totalFrames: 0 }); break; }
      const frames: object[] = [];
      // Walk frames bottom-up; only emit CALL frames for the user.
      // Use the current ip for the top frame; deeper frames don't track their suspended ip,
      // so we just show their parent depth + a placeholder line.
      const pos = prog.sourceMap?.[state.ip];
      frames.push({
        id: 0,
        name: 'top',
        source: { path: resolve(sourcePath) },
        line: pos?.line ?? 1,
        column: pos?.col ?? 1,
      });
      // Walk down through call frames.
      let frameIdx = state.frames.length - 1;
      let frameId = 1;
      while (frameIdx > 0) {
        const f = state.frames[frameIdx];
        if (f.returnIP !== undefined) {
          const retPos = prog.sourceMap?.[f.returnIP - 1];
          frames.push({
            id: frameId++,
            name: `call at ip ${f.returnIP - 1}`,
            source: { path: resolve(sourcePath) },
            line: retPos?.line ?? 1,
            column: retPos?.col ?? 1,
          });
        }
        frameIdx--;
      }
      reply(msg, { stackFrames: frames, totalFrames: frames.length });
      break;
    }
    case 'scopes': {
      reply(msg, {
        scopes: [
          { name: 'Locals', variablesReference: 1, expensive: false },
          { name: 'Value Stack', variablesReference: 2, expensive: false },
        ],
      });
      break;
    }
    case 'variables': {
      if (!state) { reply(msg, { variables: [] }); break; }
      const ref = msg.arguments?.variablesReference;
      const vars: object[] = [];
      if (ref === 1) {
        // Locals: union of bindings from current frame walking up via parentIdx.
        let idx = state.frames.length - 1;
        const seen = new Set<string>();
        while (idx >= 0) {
          const f = state.frames[idx];
          for (const [name, v] of Object.entries(f.bindings)) {
            if (seen.has(name)) continue;
            seen.add(name);
            vars.push({ name, value: valueRepr(v), variablesReference: 0 });
          }
          if (f.parentIdx !== undefined) idx = f.parentIdx;
          else idx--;
        }
      } else if (ref === 2) {
        state.valueStack.forEach((v, i) => {
          vars.push({ name: `[${i}]`, value: valueRepr(v), variablesReference: 0 });
        });
      }
      reply(msg, { variables: vars });
      break;
    }
    case 'terminate':
    case 'disconnect': {
      reply(msg);
      // Give the client a moment to receive the response before exiting.
      setTimeout(() => process.exit(0), 50);
      break;
    }
    default: {
      reply(msg, { error: `unhandled DAP command: ${msg.command}` }, false);
    }
  }
}

function runToNextStop(reason: 'entry' | 'breakpoint'): void {
  if (!prog || !state) return;
  try {
    const r = runUntilBreakpoint(prog, state, breakpointIps);
    if (r.status === 'halted') {
      event('output', { category: 'console', output: '\n[program halted]\n' });
      event('terminated');
    } else if (r.status === 'paused') {
      event('stopped', { reason: 'pause', threadId: 1, allThreadsStopped: true });
    } else if (r.status === 'breakpoint') {
      event('stopped', { reason, threadId: 1, allThreadsStopped: true });
    }
  } catch (e) {
    event('output', { category: 'stderr', output: `runtime error: ${(e as Error).message}\n` });
    event('terminated');
  }
}

export function runDap(): void {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const headers = buffer.slice(0, headerEnd);
      const cl = /Content-Length: (\d+)/i.exec(headers);
      if (!cl) { buffer = buffer.slice(headerEnd + 4); continue; }
      const len = parseInt(cl[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + len) break;
      const body = buffer.slice(bodyStart, bodyStart + len);
      buffer = buffer.slice(bodyStart + len);
      try {
        handleMessage(JSON.parse(body) as DapMessage);
      } catch (e) {
        process.stderr.write(`dap parse error: ${(e as Error).message}\n`);
      }
    }
  });
}

if (process.argv[1]?.endsWith('dap.js')) {
  runDap();
}

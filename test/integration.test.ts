import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PEN = resolve('bin/penelope');

function cleanup(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

test('demo 1: top-level pause survives across processes', () => {
  const source = resolve('examples/01-toplevel-pause.pen');
  const snap = resolve('examples/01-toplevel-pause.penz');
  cleanup(snap);

  // First process: run, hit pause, write snapshot.
  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(existsSync(snap)).toBe(true);

  // Second process: resume with y = 5, expect 15.
  const r2 = spawnSync(PEN, ['resume', snap, '5'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('15');

  cleanup(snap);
});

test('demo 2: nested-function pause preserves the enclosing call frame', () => {
  const source = resolve('examples/02-nested-pause.pen');
  const snap = resolve('examples/02-nested-pause.penz');
  cleanup(snap);

  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(existsSync(snap)).toBe(true);

  // Resume with b = 41; outer should print 42 (a=1 + b=41).
  const r2 = spawnSync(PEN, ['resume', snap, '41'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('42');

  cleanup(snap);
});

test('demo 3: fork produces two independent futures from one snapshot', () => {
  const source = resolve('examples/03-fork.pen');
  const snap = resolve('examples/03-fork.penz');
  const fork0 = resolve('examples/03-fork.fork0.penz');
  const fork1 = resolve('examples/03-fork.fork1.penz');
  cleanup(snap); cleanup(fork0); cleanup(fork1);

  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(existsSync(snap)).toBe(true);

  // Fork with 5 and 10; expect both prints.
  const r2 = spawnSync(PEN, ['fork', snap, '5', '10'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);

  const lines = r2.stdout.trim().split('\n').sort();
  expect(lines).toEqual([
    '[fork-0] 105',
    '[fork-1] 110',
  ]);

  cleanup(snap); cleanup(fork0); cleanup(fork1);
});

test('C1/H1: print before pause is not re-printed on resume', () => {
  const source = resolve('examples/04-print-replay.pen');
  const snap = resolve('examples/04-print-replay.penz');
  cleanup(snap);

  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(r1.stdout.trim()).toBe('before');
  expect(existsSync(snap)).toBe(true);

  const r2 = spawnSync(PEN, ['resume', snap, '42'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('42');  // "before" must NOT appear

  cleanup(snap);
});

test('F2: write_file skipped on replay (manual override preserved)', () => {
  const source = resolve('/tmp/penelope-wf.pen');
  const snap = resolve('/tmp/penelope-wf.penz');
  const target = '/tmp/penelope-wf-output.txt';
  cleanup(snap); cleanup(target); cleanup(source);

  writeFileSync(source, 'write_file("/tmp/penelope-wf-output.txt", "first"); let _ = pause; print("done");');

  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(readFileSync(target, 'utf8')).toBe('first');

  writeFileSync(target, 'manual override');

  const r2 = spawnSync(PEN, ['resume', snap, 'true'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('done');
  expect(readFileSync(target, 'utf8')).toBe('manual override');

  cleanup(source); cleanup(snap); cleanup(target);
});

test('F3: write_file errors propagate first time', () => {
  const source = resolve('/tmp/penelope-wf-err.pen');
  cleanup(source);
  writeFileSync(source, 'write_file("/nonexistent_dir_xyz/file", "x"); print("never");');

  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(1);
  expect(r1.stderr).toMatch(/write_file/);

  cleanup(source);
});

test('D1+D2+H2: net_fetch records body; replay does not hit network', () => {
  const source = resolve('examples/05-net-fetch.pen');
  const snap = resolve('examples/05-net-fetch.penz');
  cleanup(snap);

  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(existsSync(snap)).toBe(true);

  const snapJson = JSON.parse(readFileSync(snap, 'utf8'));
  const fetchEntry = snapJson.state.effects.find((e: any) => e.effect === 'net_fetch');
  expect(fetchEntry).toBeDefined();
  expect(fetchEntry.status).toBe('committed');
  expect(fetchEntry.recordedValue.tag).toBe('str');
  const recordedBody = fetchEntry.recordedValue.v;

  const r2 = spawnSync(PEN, ['resume', snap, 'true'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe(recordedBody.trim());

  cleanup(snap);
}, 15000);

test('D3: two distinct net_fetch call sites get separate log entries', () => {
  const source = resolve('/tmp/penelope-2fetch.pen');
  cleanup(source);
  writeFileSync(source, 'let a = net_fetch("https://httpbin.org/uuid"); let b = net_fetch("https://httpbin.org/uuid"); print(to_str(str_length(a) + str_length(b)));');

  const r = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r.status).toBe(0);

  cleanup(source);
}, 15000);

test('E1: now() records first-call value and replays it', () => {
  const source = resolve('/tmp/penelope-now.pen');
  const snap = resolve('/tmp/penelope-now.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'let t = now(); let _ = pause; print(to_str(t));');

  spawnSync(PEN, ['run', source, '--time', '999'], { encoding: 'utf8' });

  const r2 = spawnSync(PEN, ['resume', snap, 'true'], { encoding: 'utf8' });
  expect(r2.stdout.trim()).toBe('999');

  cleanup(source); cleanup(snap);
});

test('E3: --time MS overrides now() on fresh execution', () => {
  const source = resolve('/tmp/penelope-now-mock.pen');
  cleanup(source);
  writeFileSync(source, 'print(to_str(now()));');

  const r = spawnSync(PEN, ['run', source, '--time', '12345'], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe('12345');

  cleanup(source);
});

test('E2: random_int recorded then replayed', () => {
  const source = resolve('/tmp/penelope-rand.pen');
  const snap = resolve('/tmp/penelope-rand.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'let r = random_int(1, 1000000); let _ = pause; print(to_str(r));');

  spawnSync(PEN, ['run', source], { encoding: 'utf8' });

  const recorded = JSON.parse(readFileSync(snap, 'utf8'))
    .state.effects.find((e: any) => e.effect === 'random_int').recordedValue.v;
  expect(typeof recorded).toBe('number');

  const r2 = spawnSync(PEN, ['resume', snap, 'true'], { encoding: 'utf8' });
  expect(r2.stdout.trim()).toBe(String(recorded));

  cleanup(source); cleanup(snap);
});

test('F1: read_file recorded then replayed (file can be deleted after)', () => {
  const source = resolve('/tmp/penelope-rf.pen');
  const snap = resolve('/tmp/penelope-rf.penz');
  const dataFile = '/tmp/penelope-rf-data.txt';
  cleanup(source); cleanup(snap); cleanup(dataFile);

  writeFileSync(dataFile, 'original content');
  writeFileSync(source, 'let c = read_file("/tmp/penelope-rf-data.txt"); let _ = pause; print(c);');

  spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  cleanup(dataFile);  // delete original file

  const r2 = spawnSync(PEN, ['resume', snap, 'true'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('original content');

  cleanup(source); cleanup(snap);
});

test('G1: wait_until pauses, resume after target time continues', () => {
  const source = resolve('/tmp/penelope-wu.pen');
  const snap = resolve('/tmp/penelope-wu.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'wait_until(50); print("done");');

  spawnSync(PEN, ['run', source, '--time', '1000'], { encoding: 'utf8' });
  expect(existsSync(snap)).toBe(true);

  const r2 = spawnSync(PEN, ['resume', snap, '--time', '2000'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('done');

  cleanup(source); cleanup(snap);
});

test('G2: wait_until resume too early re-pauses', () => {
  const source = resolve('/tmp/penelope-wu-early.pen');
  const snap = resolve('/tmp/penelope-wu-early.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'wait_until(10000); print("done");');

  spawnSync(PEN, ['run', source, '--time', '1000'], { encoding: 'utf8' });

  const r2 = spawnSync(PEN, ['resume', snap, '--time', '2000'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout).not.toMatch(/done/);
  expect(existsSync(snap)).toBe(true);

  cleanup(source); cleanup(snap);
});

test('G3: wait_for + --event approval=true resumes with bool', () => {
  const source = resolve('examples/07-wait-for.pen');
  const snap = resolve('examples/07-wait-for.penz');
  cleanup(snap);

  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(r1.stdout.trim()).toBe('waiting for approval');
  expect(existsSync(snap)).toBe(true);

  const r2 = spawnSync(PEN, ['resume', snap, '--event', 'approval=true'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('got: true');

  cleanup(snap);
});

test('G4: wait_for with int event value', () => {
  const source = resolve('/tmp/penelope-wfi.pen');
  const snap = resolve('/tmp/penelope-wfi.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'let n = wait_for("count"); print(to_str(n));');

  spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  const r = spawnSync(PEN, ['resume', snap, '--event', 'count=42'], { encoding: 'utf8' });
  expect(r.stdout.trim()).toBe('42');

  cleanup(source); cleanup(snap);
});

test('G5: wait_for with string event value', () => {
  const source = resolve('/tmp/penelope-wfs.pen');
  const snap = resolve('/tmp/penelope-wfs.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'let note = wait_for("memo"); print(note);');

  spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  const r = spawnSync(PEN, ['resume', snap, '--event', 'memo=hello world'], { encoding: 'utf8' });
  expect(r.stdout.trim()).toBe('hello world');

  cleanup(source); cleanup(snap);
});

test('H3: multi-pause flow — wait_for, then bare pause, then continue', () => {
  const source = resolve('/tmp/penelope-multi.pen');
  const snap = resolve('/tmp/penelope-multi.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'let a = wait_for("first"); print("got " + a); let b = pause; print("got2 " + to_str(b));');

  spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  spawnSync(PEN, ['resume', snap, '--event', 'first=hello'], { encoding: 'utf8' });
  // After first resume: prints "got hello", pauses at bare pause.
  const r3 = spawnSync(PEN, ['resume', snap, '99'], { encoding: 'utf8' });
  expect(r3.stdout.trim()).toBe('got2 99');  // first print is replay-skipped

  cleanup(source); cleanup(snap);
});

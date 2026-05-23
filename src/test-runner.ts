// Penelope doctest runner.
//   // EXPECT: <line>     — asserts the next emitted stdout line equals <line>
//   // EXPECTS: <prefix>   — asserts the next emitted stdout STARTS WITH <prefix>
// Lines are matched in order; extra stdout lines beyond the last EXPECT are fine.

export type ExpectKind = 'eq' | 'prefix';
export type Expectation = { kind: ExpectKind; text: string; line: number };

export type TestResult = {
  pass: boolean;
  total: number;
  failed: { exp: Expectation; got: string | undefined }[];
  excessOutput: string[];  // emitted lines that came after EXPECTS exhausted (informational)
};

export function extractExpectations(source: string): Expectation[] {
  const out: Expectation[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m1 = lines[i].match(/^\s*\/\/\s*EXPECT:\s?(.*)$/);
    if (m1) { out.push({ kind: 'eq', text: m1[1], line: i + 1 }); continue; }
    const m2 = lines[i].match(/^\s*\/\/\s*EXPECTS:\s?(.*)$/);
    if (m2) { out.push({ kind: 'prefix', text: m2[1], line: i + 1 }); continue; }
  }
  return out;
}

export function checkExpectations(expects: Expectation[], stdout: string): TestResult {
  const outLines = stdout.split('\n').filter(l => l.length > 0);
  const failed: { exp: Expectation; got: string | undefined }[] = [];
  for (let i = 0; i < expects.length; i++) {
    const exp = expects[i];
    const got = outLines[i];
    if (got === undefined) { failed.push({ exp, got }); continue; }
    const ok = exp.kind === 'eq' ? got === exp.text : got.startsWith(exp.text);
    if (!ok) failed.push({ exp, got });
  }
  const excessOutput = outLines.slice(expects.length);
  return { pass: failed.length === 0, total: expects.length, failed, excessOutput };
}

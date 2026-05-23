// pen new <dir>: scaffold a new Penelope project.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';

const MAIN_PEN = `/// The main entry point of your Penelope program.
let greeting = fn(name) {
  "hello \${name}!"
};

print(greeting("Penelope"));
`;

const README = (name: string): string => `# ${name}

A Penelope project.

## Run

\`\`\`sh
pen run main.pen
\`\`\`

## Test

Add \`// EXPECT: <line>\` comments next to your prints, then:

\`\`\`sh
pen test main.pen
\`\`\`

## Format

\`\`\`sh
pen fmt --write main.pen
\`\`\`
`;

const GITIGNORE = `# Penelope artifacts
*.penc
*.penz

# Editor
.DS_Store
.vscode/
.idea/
`;

export function scaffold(dirPath: string): { created: string[]; error?: string } {
  const abs = resolve(dirPath);
  if (existsSync(abs)) {
    return { created: [], error: `directory already exists: ${dirPath}` };
  }
  mkdirSync(abs, { recursive: true });
  const name = basename(abs);
  const files: Array<[string, string]> = [
    ['main.pen', MAIN_PEN],
    ['README.md', README(name)],
    ['.gitignore', GITIGNORE],
  ];
  const created: string[] = [];
  for (const [filename, content] of files) {
    const fp = join(abs, filename);
    writeFileSync(fp, content);
    created.push(fp);
  }
  return { created };
}

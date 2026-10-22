// Launches a real VS Code with this extension loaded in an isolated profile and runs test/integration/suite.cjs.
// Usage: node test/integration/runTest.mjs [path-to-Code.exe]
import { runTests } from '@vscode/test-electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const asmDir = path.resolve(root, '..');
const vscodeExecutablePath = process.argv[2] ?? process.env.VSCODE_EXECUTABLE;

// When launched from a terminal inside VS Code these variables make the new instance behave as plain Node
// or attach to the running VS Code, so drop them for the child process.
delete process.env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(process.env)) if (k.startsWith('VSCODE_')) delete process.env[k];

// Fresh workspace with one good and one broken program.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sparky-it-'));
const workspace = path.join(sandbox, 'workspace');
fs.mkdirSync(workspace);
fs.copyFileSync(path.join(asmDir, 'factorial.asm'), path.join(workspace, 'good.asm'));
fs.writeFileSync(path.join(workspace, 'bad.asm'), '.text\n addi t0, t0\n foo t1, t2\n lw t0, 0(zz)\n');

try {
  await runTests({
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(here, 'suite.cjs'),
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${path.join(sandbox, 'user')}`, `--extensions-dir=${path.join(sandbox, 'ext')}`],
  });
  console.log('integration tests finished OK');
} catch (e) {
  console.error('integration tests FAILED:', e.message);
  process.exitCode = 1;
} finally {
  const results = path.join(sandbox, 'results.txt');
  if (fs.existsSync(results)) console.log('\n' + fs.readFileSync(results, 'utf8'));
  fs.rmSync(sandbox, { recursive: true, force: true });
}

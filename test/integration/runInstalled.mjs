// Installs the packaged .vsix into a clean, isolated VS Code profile and runs the same integration suite against it.
// Usage: node test/integration/runInstalled.mjs <path-to-Code.exe> <path-to-code.cmd> <path-to.vsix>
import { runTests } from '@vscode/test-electron';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [codeExe, codeCli, vsix] = process.argv.slice(2);
if (!codeExe || !codeCli || !vsix) {
  console.error('usage: node runInstalled.mjs <Code.exe> <code.cmd> <extension.vsix>');
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const asmDir = path.resolve(root, '..');

delete process.env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(process.env)) if (k.startsWith('VSCODE_')) delete process.env[k];

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sparky-installed-'));
const userDir = path.join(sandbox, 'user');
const extDir = path.join(sandbox, 'ext');
const workspace = path.join(sandbox, 'workspace');
fs.mkdirSync(workspace);
fs.copyFileSync(path.join(asmDir, 'factorial.asm'), path.join(workspace, 'good.asm'));
fs.writeFileSync(path.join(workspace, 'bad.asm'), '.text\n addi t0, t0\n foo t1, t2\n lw t0, 0(zz)\n');

// An empty extension just to satisfy --extensionDevelopmentPath; the one under test is the installed .vsix.
const dummy = path.join(sandbox, 'dummy');
fs.mkdirSync(dummy);
fs.writeFileSync(path.join(dummy, 'package.json'), JSON.stringify({ name: 'dummy', publisher: 'dummy', version: '0.0.1', engines: { vscode: '^1.90.0' } }));

try {
  const q = (s) => `"${s}"`;
  const install = spawnSync(`${q(codeCli)} --install-extension ${q(path.resolve(vsix))} ${q('--user-data-dir=' + userDir)} ${q('--extensions-dir=' + extDir)}`, { encoding: 'utf8', shell: true });
  console.log((install.stdout || '').trim() || (install.stderr || '').trim());
  console.log('installed folders:', fs.readdirSync(extDir).filter((n) => !n.startsWith('.')).join(', '));
  await runTests({
    vscodeExecutablePath: codeExe,
    extensionDevelopmentPath: dummy,
    extensionTestsPath: path.join(here, 'suite.cjs'),
    launchArgs: [workspace, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userDir}`, `--extensions-dir=${extDir}`],
  });
  console.log('installed-extension tests finished OK');
} catch (e) {
  console.error('installed-extension tests FAILED:', e.message);
  process.exitCode = 1;
} finally {
  const results = path.join(sandbox, 'results.txt');
  if (fs.existsSync(results)) console.log('\n' + fs.readFileSync(results, 'utf8'));
  fs.rmSync(sandbox, { recursive: true, force: true });
}

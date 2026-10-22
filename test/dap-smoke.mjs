// Bundles test/dap-harness.ts (with a stub 'vscode' module) and runs it.
// Usage: node test/dap-smoke.mjs [folder-with-factorial.asm]
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'test', '.build', 'dap-harness.js');
await esbuild.build({
  entryPoints: [path.join(root, 'test', 'dap-harness.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  alias: { vscode: path.join(root, 'test', 'stubs', 'vscode.ts') },
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);

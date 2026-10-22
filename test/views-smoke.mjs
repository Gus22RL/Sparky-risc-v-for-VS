// Bundles test/views-harness.ts (stub 'vscode', jsdom kept external) and runs it.
// jsdom is a test-only tool: install it next to this repo (npm i -D jsdom) or point NODE_PATH at a folder that has it.
// Usage: node test/views-smoke.mjs [folder-with-asm-files]
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'test', '.build', 'views-harness.js');
await esbuild.build({
  entryPoints: [path.join(root, 'test', 'views-harness.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  external: ['jsdom'],
  alias: { vscode: path.join(root, 'test', 'stubs', 'vscode.ts') },
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);

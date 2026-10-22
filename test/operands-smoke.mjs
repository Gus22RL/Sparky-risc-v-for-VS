// Bundles test/operands-harness.ts and runs it. Usage: node test/operands-smoke.mjs [--list]
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'test', '.build', 'operands-harness.js');
await esbuild.build({
  entryPoints: [path.join(root, 'test', 'operands-harness.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);

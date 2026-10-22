// Compiles java/RarsBridge.java against the bundled RARS jar into bridge/classes (Java 8 bytecode).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jar = path.join(root, 'lib', 'rars1_6.jar');
const out = path.join(root, 'bridge', 'classes');

const javacCandidates = [
  process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'),
  'javac',
].filter(Boolean);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

let lastError = '';
for (const javac of javacCandidates) {
  const r = spawnSync(javac, ['--release', '8', '-Xlint:-options', '-cp', jar, '-d', out, path.join(root, 'java', 'RarsBridge.java')], { encoding: 'utf8' });
  if (r.error) { lastError = r.error.message; continue; }
  if (r.status === 0) {
    console.log(`bridge compiled with ${javac} -> ${path.relative(root, out)}`);
    process.exit(0);
  }
  console.error(r.stdout + r.stderr);
  process.exit(r.status ?? 1);
}
console.error(`javac not found (${lastError}). Install a JDK 8+ and make sure javac is on PATH or set JAVA_HOME.`);
process.exit(1);

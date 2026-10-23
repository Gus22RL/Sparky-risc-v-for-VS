// Checks the folding.markers in language-configuration.json: `.macro`/`.end_macro` and `label: #fn` / `#endfn`.
// Usage: node test/folding-smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'language-configuration.json'), 'utf8').replace(/^﻿/, ''));
const start = new RegExp(config.folding.markers.start);
const end = new RegExp(config.folding.markers.end);

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};

const starts = ['factorial: #fn', 'factorial:   #fn', '  fact.loop:#fn nombre', '#fn', '# fn', '  #fn factorial', '.macro m', '  .macro m %a'];
const notStarts = ['#fnord', '#endfn', 'addi t0, t0, 1 # fn', '.asciz "#fn"', '# nota sobre #fn', 'factorial:', '.end_macro'];
const ends = ['#endfn', '  # endfn', '#endfn factorial', '.end_macro', '  .end_macro'];
const notEnds = ['#endfnx', '#fn', 'ret # endfn', '.macro m', '# nota sobre #endfn'];

for (const line of starts) check(`start: ${JSON.stringify(line)}`, start.test(line));
for (const line of notStarts) check(`not a start: ${JSON.stringify(line)}`, !start.test(line));
for (const line of ends) check(`end: ${JSON.stringify(line)}`, end.test(line));
for (const line of notEnds) check(`not an end: ${JSON.stringify(line)}`, !end.test(line));

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

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

// Port of VS Code's indentation range provider (the folding used when a language has no folding provider), offSide=false.
// Returns the 1-based [start, end] line pairs of the folds it would create.
function foldRanges(lines, tabSize = 4) {
  const both = new RegExp(`(${start.source})|(?:${end.source})`);
  const level = (s) => {
    let n = 0, i = 0;
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 32) n++;
      else if (c === 9) n = n - (n % tabSize) + tabSize;
      else break;
    }
    return i === s.length ? -1 : n;
  };
  const ranges = [];
  const stack = [{ indent: -1, endAbove: lines.length + 1, line: lines.length + 1 }];
  for (let p = lines.length; p > 0; p--) {
    const text = lines[p - 1];
    const indent = level(text);
    let top = stack[stack.length - 1];
    if (indent === -1) continue;
    const m = both.exec(text);
    if (m && m[1]) {
      let i = stack.length - 1;
      while (i > 0 && stack[i].indent !== -2) i--;
      if (i > 0) {
        stack.length = i + 1;
        top = stack[i];
        ranges.push([p, top.line]);
        Object.assign(top, { line: p, indent, endAbove: p });
        continue;
      }
    } else if (m) {
      stack.push({ indent: -2, endAbove: p, line: p });
      continue;
    }
    if (top.indent > indent) {
      do { stack.pop(); top = stack[stack.length - 1]; } while (top.indent > indent);
      const last = top.endAbove - 1;
      if (last - p >= 1) ranges.push([p, last]);
    }
    if (top.indent === indent) top.endAbove = p;
    else stack.push({ indent, endAbove: p, line: p });
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}
const sameRanges = (got, want) => JSON.stringify(got) === JSON.stringify(want);

// Named groups inside a function, with an unindented body and the same id used twice.
const hanoi = [
  'hanoi: #fn', 'addi t0, zero, 1',
  '#fn push', 'addi sp, sp, -4', 'sw ra, 0(sp)', '#endfn push',
  'jal hanoi',
  '#fn pop', 'lw ra, 0(sp)', 'addi sp, sp, 4', '#endfn pop',
  '#fn push', 'sw a1, 0(sp)', '#endfn push',
  'jalr ra',
  '#endfn',
];
const got = foldRanges(hanoi);
check('nested groups with ids: function + 3 groups', sameRanges(got, [[1, 16], [3, 6], [8, 11], [12, 14]]), JSON.stringify(got));
check('a group can be folded inside a collapsed function (ranges nest, none cross)', got.every(([s, e]) => got.every(([s2, e2]) => e < s2 || e2 < s || (s <= s2 && e2 <= e) || (s2 <= s && e <= e2))));

const sample = fs.readFileSync(path.join(root, 'test', 'samples', 'folding.asm'), 'utf8').split(/\r?\n/);
const sampleRanges = foldRanges(sample);
const folds = (re) => sampleRanges.filter(([s]) => re.test(sample[s - 1]));
const factorial = folds(/^#fn factorial/)[0];
const groups = [...folds(/^\s*#fn push/), ...folds(/^\s*#fn pop/)];
check('sample: factorial folds from #fn to #endfn', !!factorial && /^#endfn$/.test(sample[factorial[1] - 1]));
check('sample: push and pop groups sit inside factorial', groups.length === 2 && groups.every(([s, e]) => factorial && s > factorial[0] && e < factorial[1]));
check('sample: every #fn fold ends on an #endfn line', sampleRanges.filter(([s]) => start.test(sample[s - 1]) && /#\s*fn\b/.test(sample[s - 1])).every(([, e]) => /^\s*#\s*endfn\b/.test(sample[e - 1])));
check('sample: #fnord creates no fold', folds(/^#fnord/).length === 0);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

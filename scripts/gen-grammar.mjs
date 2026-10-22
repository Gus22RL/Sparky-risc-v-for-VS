// Generates syntaxes/riscv.tmLanguage.json using the instruction list that the RARS jar itself reports
// (RV32 + RV64, basic + pseudo instructions), so the highlighting always matches the simulator.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cp = [path.join(root, 'lib', 'rars1_6.jar'), path.join(root, 'bridge', 'classes')].join(path.delimiter);
const child = spawn('java', ['-Djava.awt.headless=true', '-Dfile.encoding=UTF-8', '-cp', cp, 'RarsBridge'], { stdio: ['pipe', 'pipe', 'inherit'] });

const pending = new Map();
let nextId = 1;
let readyResolve;
const ready = new Promise((r) => (readyResolve = r));
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.event === 'ready') readyResolve();
  else if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const call = (cmd, args = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
});

await ready;
const names = new Map(); // name -> {pseudo}
for (const rv64 of [false, true]) {
  await call('lint', { text: '.text\n', options: { rv64 } });
  const res = await call('instructions');
  for (const i of res.result.instructions) {
    const prev = names.get(i.name);
    names.set(i.name, { pseudo: prev ? prev.pseudo && i.pseudo : i.pseudo });
  }
}
child.stdin.end();

const flow = (n) => /^(b[a-z]*|j|jal|jalr|jr|ret|call|tail|ecall|ebreak|uret|sret|mret|wfi|fence.*)$/.test(n) && !/^(bset|bclr|binv|bext)/.test(n);
const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const group = (list) => list.sort((a, b) => b.length - a.length).map(esc).join('|');

const all = [...names.keys()];
const flowNames = all.filter(flow);
const pseudoNames = all.filter((n) => !flow(n) && names.get(n).pseudo);
const basicNames = all.filter((n) => !flow(n) && !names.get(n).pseudo);

const ident = '[A-Za-z_.$][A-Za-z0-9_.$]*';
const registers = 'zero|ra|sp|gp|tp|fp|t[0-6]|s(?:1[01]|[0-9])|a[0-7]|x(?:[12][0-9]|3[01]|[0-9])|f(?:[12][0-9]|3[01]|[0-9])|ft(?:1[01]|[0-9])|fs(?:1[01]|[0-9])|fa[0-7]';
const csrs = 'fflags|frm|fcsr|ustatus|uie|utvec|uscratch|uepc|ucause|utval|uip|cycle|time|instret|cycleh|timeh|instreth';
const directives = 'text|data|word|half|byte|dword|ascii|asciz|string|space|float|double|align|balign|globl|global|eqv|macro|end_macro|include|set|extern|section|option|ktext|kdata|zero|skip|p2align';

const afterLabel = `^\\s*(?:(${ident})(:)\\s*)?`;
const grammar = {
  $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
  name: 'RISC-V (Sparky)',
  scopeName: 'source.sparky-riscv',
  patterns: [
    { include: '#comment' },
    { include: '#instructionLine' },
    { include: '#labelDefinition' },
    { include: '#directive' },
    { include: '#string' },
    { include: '#char' },
    { include: '#number' },
    { include: '#relocation' },
    { include: '#csr' },
    { include: '#register' },
    { include: '#labelReference' },
    { include: '#punctuation' },
  ],
  repository: {
    comment: { name: 'comment.line.number-sign.sparky-riscv', match: '#.*$' },
    instructionLine: {
      patterns: [
        {
          match: `${afterLabel}(${group(flowNames)})(?![A-Za-z0-9_.$])`,
          captures: {
            1: { name: 'entity.name.function.label.sparky-riscv' },
            2: { name: 'punctuation.separator.label.sparky-riscv' },
            3: { name: 'keyword.control.instruction.sparky-riscv' },
          },
        },
        {
          match: `${afterLabel}(${group(pseudoNames)})(?![A-Za-z0-9_.$])`,
          captures: {
            1: { name: 'entity.name.function.label.sparky-riscv' },
            2: { name: 'punctuation.separator.label.sparky-riscv' },
            3: { name: 'support.function.pseudo-instruction.sparky-riscv' },
          },
        },
        {
          match: `${afterLabel}(${group(basicNames)})(?![A-Za-z0-9_.$])`,
          captures: {
            1: { name: 'entity.name.function.label.sparky-riscv' },
            2: { name: 'punctuation.separator.label.sparky-riscv' },
            3: { name: 'support.function.instruction.sparky-riscv' },
          },
        },
      ],
    },
    labelDefinition: {
      match: `^\\s*(${ident})(:)`,
      captures: {
        1: { name: 'entity.name.function.label.sparky-riscv' },
        2: { name: 'punctuation.separator.label.sparky-riscv' },
      },
    },
    directive: { name: 'keyword.other.directive.sparky-riscv', match: `\\.(?:${directives})(?![A-Za-z0-9_.$])` },
    string: {
      name: 'string.quoted.double.sparky-riscv',
      begin: '"',
      end: '"|$',
      patterns: [{ name: 'constant.character.escape.sparky-riscv', match: '\\\\(?:[nrtb0fv\\\\\'"]|x[0-9a-fA-F]{1,2}|[0-7]{1,3})' }],
    },
    char: {
      name: 'string.quoted.single.sparky-riscv',
      match: "'(?:\\\\(?:[nrtb0fv\\\\'\"]|x[0-9a-fA-F]{1,2}|[0-7]{1,3})|[^'\\\\])'",
    },
    number: {
      patterns: [
        { name: 'constant.numeric.hex.sparky-riscv', match: '(?<![A-Za-z0-9_.$])[-+]?0[xX][0-9a-fA-F_]+\\b' },
        { name: 'constant.numeric.binary.sparky-riscv', match: '(?<![A-Za-z0-9_.$])[-+]?0[bB][01_]+\\b' },
        { name: 'constant.numeric.float.sparky-riscv', match: '(?<![A-Za-z0-9_.$])[-+]?\\d+\\.\\d+(?:[eE][-+]?\\d+)?\\b' },
        { name: 'constant.numeric.decimal.sparky-riscv', match: '(?<![A-Za-z0-9_.$])[-+]?\\d+\\b' },
      ],
    },
    relocation: { name: 'support.function.relocation.sparky-riscv', match: '%(?:hi|lo|pcrel_hi|pcrel_lo|tprel_hi|tprel_lo|got_pcrel_hi|tls_ie_pcrel_hi|tls_gd_pcrel_hi)(?=\\()' },
    csr: { name: 'variable.language.csr.sparky-riscv', match: `(?<![A-Za-z0-9_.$])(?:${csrs})(?![A-Za-z0-9_.$])` },
    register: { name: 'variable.language.register.sparky-riscv', match: `(?<![A-Za-z0-9_.$])(?:${registers})(?![A-Za-z0-9_.$:])` },
    labelReference: { name: 'variable.other.label.sparky-riscv', match: `(?<![A-Za-z0-9_.$])${ident}(?![A-Za-z0-9_.$:])` },
    punctuation: { name: 'punctuation.separator.sparky-riscv', match: '[,()]' },
  },
};

fs.mkdirSync(path.join(root, 'syntaxes'), { recursive: true });
fs.writeFileSync(path.join(root, 'syntaxes', 'riscv.tmLanguage.json'), JSON.stringify(grammar, null, 2) + '\n');
console.log(`grammar written: ${flowNames.length} control-flow, ${basicNames.length} basic, ${pseudoNames.length} pseudo instructions`);

// Smoke test for the Java bridge: talks JSON lines to RarsBridge and checks the behaviour of the RARS jar.
// Usage: node test/bridge-smoke.mjs [path-to-asm-folder]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asmDir = path.resolve(process.argv[2] ?? path.join(root, '..'));
const cp = [path.join(root, 'lib', 'rars1_6.jar'), path.join(root, 'bridge', 'classes')].join(path.delimiter);

const child = spawn('java', ['-Djava.awt.headless=true', '-Dfile.encoding=UTF-8', '-cp', cp, 'RarsBridge'], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
const events = [];
const waiters = [];
let nextId = 1;

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.event) {
    events.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  } else if (pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.ok ? resolve(m.result) : reject(new Error(m.error));
  }
});

const call = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
});
let lastCheck = '(start)';
const waitEvent = (pred, ms = 10000) => new Promise((resolve, reject) => {
  const hit = events.find(pred);
  if (hit) { events.splice(events.indexOf(hit), 1); return resolve(hit); }
  const t = setTimeout(() => reject(new Error(`timeout waiting for event; last passed check: "${lastCheck}"; unconsumed events: ${JSON.stringify(events)}`)), ms);
  waiters.push({ pred, resolve: (m) => { clearTimeout(t); const i = events.indexOf(m); if (i >= 0) events.splice(i, 1); resolve(m); } });
});

let failures = 0;
// Every run gets its own scratch folder so several runs can execute at the same time.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sparky-bridge-'));
const check = (name, cond, extra = '') => {
  lastCheck = name;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reg = async (name) => {
  const r = await call('registers', { bank: 'int' });
  return BigInt(r.registers.find((x) => x.name === name).value);
};

try {
  const ready = await waitEvent((e) => e.event === 'ready');
  check('bridge starts (ready event)', ready.version === '1.6', `version=${ready.version}`);

  // ---- instruction metadata ----
  const ins = (await call('instructions')).instructions;
  check('instruction metadata', ins.length === 267 && ins.some((i) => i.name === 'mul' && i.pseudo === false) && ins.some((i) => i.name === 'li' && i.pseudo), `count=${ins.length}`);
  const sys = (await call('syscalls')).syscalls;
  check('syscall metadata', sys.some((s) => s.number === 1 && /print/i.test(s.name)), `count=${sys.length}`);

  // ---- lint ----
  const lint = await call('lint', { text: '.text\n addi t0, t0\n foo t1, t2\n lw t0, 0(zz)\n', options: {} });
  const lines = lint.diagnostics.map((d) => d.line);
  check('lint reports errors with line/column', lint.diagnostics.length >= 3 && lines.includes(2) && lines.includes(3) && lint.diagnostics[0].column === 2,
    JSON.stringify(lint.diagnostics.map((d) => [d.line, d.column, d.message.slice(0, 30)])));
  const lintOk = await call('lint', { text: '.text\n addi t0, t0, 1\n', options: {} });
  check('lint accepts a valid program', lintOk.diagnostics.length === 0);

  // ---- Windows line endings (a new file in VS Code on Windows is CRLF) ----
  for (const [name, text] of Object.entries({
    '.text + blank lines (CRLF)': '.text\r\n\r\n addi t0, t0, 1\r\n\r\n',
    'blank lines only (CRLF)': '\r\n\r\n\r\n',
    '.text alone (CRLF)': '.text\r\n',
    'old Mac CR only': '.text\r\r addi t0, t0, 1\r',
  })) {
    const r = await call('lint', { text, options: {} });
    check(`lint has no false errors: ${name}`, r.diagnostics.length === 0, JSON.stringify(r.diagnostics.map((d) => d.message.slice(0, 40))));
  }
  const crlfBad = await call('lint', { text: '.text\r\n\r\n addi t0, t0\r\n\r\n foo t1, t2\r\n', options: {} });
  check('lint with CRLF reports only the real errors, once each, on the right lines',
    crlfBad.diagnostics.length === 2 && crlfBad.diagnostics[0].line === 3 && crlfBad.diagnostics[1].line === 5 && !crlfBad.diagnostics.some((d) => /\r/.test(d.message)),
    JSON.stringify(crlfBad.diagnostics.map((d) => [d.line, d.message.slice(0, 30)])));
  const crlfFile = path.join(scratch, 'crlf.asm');
  fs.writeFileSync(crlfFile, '.text\r\n\r\n addi t0, zero, 5\r\n\r\n li a7, 10\r\n ecall\r\n');
  const crlfAsm = await call('assemble', { files: [crlfFile], options: {} });
  check('assembling a CRLF file from disk works', crlfAsm.ok === true && crlfAsm.text.length === 3 && crlfAsm.text[0].line === 3, JSON.stringify(crlfAsm.diagnostics));

  // ---- assemble + debug factorial.asm ----
  const fact = path.join(asmDir, 'factorial.asm');
  const asm = await call('assemble', { files: [fact], options: { reverse: true } });
  check('assemble factorial.asm', asm.ok === true && asm.text.length === 21 && asm.startPc === 0x400000, `statements=${asm.text.length}`);
  check('text segment maps source lines', asm.text[0].line === 10 && asm.text[0].basic.startsWith('addi x11,x0,4'), JSON.stringify(asm.text[0]));
  const factoLabel = asm.labels.find((l) => l.name === 'factorial');
  check('labels exposed', !!factoLabel && factoLabel.address === 0x400010, JSON.stringify(factoLabel));

  await call('setBreakpoints', { addresses: [0x400010] });
  const hits = [];
  for (let i = 0; i < 5; i++) {
    await call('continue');
    const ev = await waitEvent((e) => e.event === 'stopped' || e.event === 'terminated');
    hits.push(ev.event === 'stopped' ? `${ev.reason}@a1=${await reg('a1')}` : ev.event);
  }
  check('breakpoint hit 5 times with a1=4..0', hits.join(',') === 'breakpoint@a1=4,breakpoint@a1=3,breakpoint@a1=2,breakpoint@a1=1,breakpoint@a1=0', hits.join(','));
  await call('continue');
  const end = await waitEvent((e) => e.event === 'terminated' || e.event === 'stopped');
  check('program finishes (cliff) with a0 = 4! = 24', end.event === 'terminated' && end.reason === 'cliff' && (await reg('a0')) === 24n, `a0=${await reg('a0')}`);

  // ---- reset + step + stepBack normalisation (jal) ----
  await call('reset');
  await call('setBreakpoints', { addresses: [] });
  const pcs = [];
  for (let i = 0; i < 4; i++) {
    await call('step');
    pcs.push((await waitEvent((e) => e.event === 'stopped')).pc);
  }
  check('single steps follow the program (0,4,8 -> jal target 0x10 -> 0x14)', pcs.join() === [0x400004, 0x400008, 0x400010, 0x400014].join(), pcs.map((x) => x.toString(16)).join());
  const back = [];
  for (let i = 0; i < 4; i++) {
    await call('stepBack');
    back.push((await waitEvent((e) => e.event === 'stopped')).pc);
  }
  check('stepBack is one instruction per call, even over jal', back.join() === [0x400010, 0x400008, 0x400004, 0x400000].join(), back.map((x) => x.toString(16)).join());
  check('registers restored after stepping all the way back', (await reg('a1')) === 0n && (await reg('ra')) === 0n);

  // ---- memory read/write ----
  const info = await call('memoryInfo');
  check('memory layout (text 0x400000, sp 0x7fffeffc)', info.textBase === 0x400000 && info.stackPointer === 0x7fffeffc, JSON.stringify({ t: info.textBase, sp: info.stackPointer, d: info.dataBase }));
  const mem = await call('readMemory', { address: 0x400000, words: 2 });
  check('read text segment words', mem.words[0] === 0x00400593, JSON.stringify(mem.words));
  await call('writeMemory', { address: info.dataBase, value: 0x1234abcd });
  const mem2 = await call('readMemory', { address: info.dataBase, words: 1 });
  check('write/read data memory', mem2.words[0] === 0x1234abcd);
  await call('setRegister', { bank: 'int', name: 't3', value: '123' });
  check('setRegister', (await reg('t3')) === 123n);

  // ---- memory write tracking (drives the highlighting in the Data Segment view) ----
  await call('reset');
  await call('writes'); // clear
  await call('setBreakpoints', { addresses: [0x400030] });
  await call('continue');
  await waitEvent((e) => e.event === 'stopped');
  const w = (await call('writes')).addresses;
  check('writes reports the stack words stored by the program', w.includes(0x7fffeff8) && w.includes(0x7fffeff4) && w.length === 2, JSON.stringify(w.map((x) => x.toString(16))));
  check('writes log is cleared after reading', (await call('writes')).addresses.length === 0);
  await call('setBreakpoints', { addresses: [] });

  // ---- interactive I/O ----
  const tmp = path.join(scratch, 'io.asm');
  fs.writeFileSync(tmp, '.text\n li a7, 5\n ecall\n mv s1, a0\n li a7, 1\n ecall\n li a7, 11\n li a0, 10\n ecall\n li a7, 4\n la a0, msg\n ecall\n li a7, 10\n ecall\n.data\nmsg: .asciz "bye\\n"\n');
  const io = await call('assemble', { files: [tmp], options: {} });
  check('assemble IO program', io.ok === true);
  await call('run');
  await waitEvent((e) => e.event === 'inputWait');
  check('program blocks waiting for input (inputWait event)', true);
  await call('input', { text: '42\n' });
  const term = await waitEvent((e) => e.event === 'terminated');
  const out = events.filter((e) => e.event === 'output').map((e) => e.text).join('');
  check('input is consumed and output is streamed', term.reason === 'exit' && out === '42\nbye\n', JSON.stringify(out));

  // ---- exception reporting ----
  fs.writeFileSync(tmp, '.text\n li t0, 3\n lw t1, 0(t0)\n');
  await call('assemble', { files: [tmp], options: {} });
  await call('run');
  const exc = await waitEvent((e) => e.event === 'stopped' || e.event === 'terminated');
  check('runtime exception is reported with source line', exc.event === 'stopped' && exc.reason === 'exception' && exc.line === 3, JSON.stringify(exc));

  // ---- pause / stop of a program that never ends ----
  fs.writeFileSync(tmp, '.text\nloop: addi t0, t0, 1\n j loop\n');
  await call('assemble', { files: [tmp], options: {} });
  await call('run');
  await sleep(300);
  await call('pause');
  const paused = await waitEvent((e) => e.event === 'stopped');
  check('pause interrupts an endless loop', paused.reason === 'pause' && (await reg('t0')) > 100n, `t0=${await reg('t0')}`);
  await call('continue');
  await sleep(200);
  await call('stop');
  const stopped = await waitEvent((e) => e.event === 'terminated');
  check('stop ends the program', stopped.reason === 'stopped');

  // Pause pressed immediately after Continue, before RARS has even created its simulator thread, must not be lost.
  await call('assemble', { files: [tmp], options: {} });
  let lost = 0;
  for (let i = 0; i < 25; i++) {
    await call('continue');
    await call('pause'); // no delay on purpose
    try {
      await waitEvent((e) => e.event === 'stopped' && e.reason === 'pause', 5000);
    } catch {
      lost++;
      break;
    }
  }
  check('pause right after continue is never lost (25 times)', lost === 0);
  await call('continue');
  await call('stop'); // stop right after continue too
  const quick = await waitEvent((e) => e.event === 'terminated', 5000).catch(() => null);
  check('stop right after continue is not lost either', quick !== null && quick.reason === 'stopped');

  // ---- advanced options: rv64, memory configuration, program arguments, start at main ----
  fs.writeFileSync(tmp, '.text\n li t0, -1\n addw t1, t0, t0\n li t2, 0x7fffffff\n slli t2, t2, 8\n li a7, 10\n ecall\n');
  const r64 = await call('assemble', { files: [tmp], options: { rv64: true } });
  check('rv64: RV64-only instructions assemble', r64.ok === true);
  await call('run');
  await waitEvent((e) => e.event === 'terminated');
  const regs64 = await call('registers', { bank: 'int' });
  check('rv64: registers are 64-bit (t2 = 0x7fffffff00)', regs64.rv64 === true && BigInt(regs64.registers.find((x) => x.name === 't2').value) === 0x7fffffff00n);
  const r32 = await call('assemble', { files: [tmp], options: { rv64: false } });
  check('rv32: the same program is rejected (addw is RV64-only)', r32.ok === false && /addw/.test(r32.diagnostics[0].message), r32.diagnostics[0]?.message.slice(0, 50));
  check('switching back to rv32 restores the 32-bit instruction set', (await call('instructions')).instructions.length === 267);

  fs.writeFileSync(tmp, '.data\nv: .word 7\n.text\n lw t0, v\n li a7, 10\n ecall\n');
  const compact = await call('assemble', { files: [tmp], options: { rv64: false, memoryConfig: 'CompactDataAtZero' } });
  check('memory configuration CompactDataAtZero (text at 0x3000, data at 0)', compact.memory.textBase === 0x3000 && compact.memory.dataBase === 0, JSON.stringify({ t: compact.memory.textBase, d: compact.memory.dataBase }));
  const dflt = await call('assemble', { files: [tmp], options: { rv64: false, memoryConfig: 'Default' } });
  check('memory configuration back to Default', dflt.memory.textBase === 0x400000);

  // RARS only honours a *global* main label (".globl main"), exactly like its "sm" command line option.
  fs.writeFileSync(tmp, '.globl main\n.text\n nop\nmain: li a0, 5\n li a7, 10\n ecall\n');
  const noMain = await call('assemble', { files: [tmp], options: {} });
  const withMain = await call('assemble', { files: [tmp], options: { startAtMain: true } });
  check('startAtMain starts at the main label', noMain.startPc === 0x400000 && withMain.startPc === 0x400004, `${noMain.startPc.toString(16)} / ${withMain.startPc.toString(16)}`);

  await call('assemble', { files: [tmp], options: { programArguments: ['foo', 'bar'] } });
  check('program arguments: a0 = argc', (await reg('a0')) === 2n);

  // ---- assembler error ----
  fs.writeFileSync(tmp, '.text\n addi t0, t0\n');
  const bad = await call('assemble', { files: [tmp], options: {} });
  check('assemble errors are returned (not thrown)', bad.ok === false && bad.diagnostics[0].line === 2, JSON.stringify(bad.diagnostics[0]));
} catch (e) {
  console.log('ERROR', e);
  failures++;
} finally {
  child.stdin.end();
  fs.rmSync(scratch, { recursive: true, force: true });
  setTimeout(() => process.exit(failures ? 1 : 0), 200);
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
}

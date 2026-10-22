// Drives SparkyDebugSession with real DAP messages against the real Java bridge (no VS Code needed).
import * as path from 'path';
import { SparkyDebugSession } from '../src/debugSession';
import { SparkyHub } from '../src/hub';

const root = path.resolve(__dirname, '..', '..');
const asmDir = process.argv[2] ?? path.resolve(root, '..');
const factorial = path.join(asmDir, 'factorial.asm');

let failures = 0;
const INIT_ARGS = { adapterID: 'sparky', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true };
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};

const out: string[] = [];
const io: any = {
  sink: (_: string) => undefined,
  reset: () => undefined,
  show: () => undefined,
  setInputSink(f: (t: string) => void) { this.sink = f; },
  write: (t: string) => out.push(t),
  writeError: (t: string) => out.push('[err]' + t),
  writeInfo: (t: string) => out.push('[info]' + t),
};
const problems: any = { set: () => undefined, delete: () => undefined };
const log: any = { appendLine: (l: string) => console.log('   log:', l) };
const hub = new SparkyHub();
const session = new SparkyDebugSession({ extensionPath: root } as any, hub, io, problems, log);

let seq = 1;
const pending = new Map<number, (r: any) => void>();
const events: any[] = [];
const eventWaiters: Array<{ pred: (e: any) => boolean; resolve: (e: any) => void }> = [];
(session as any).onDidSendMessage((m: any) => {
  if (m.type === 'response') pending.get(m.request_seq)?.(m);
  else if (m.type === 'event') {
    const w = eventWaiters.find((x) => x.pred(m));
    if (w) {
      eventWaiters.splice(eventWaiters.indexOf(w), 1);
      w.resolve(m);
    } else events.push(m);
  }
});
const request = (command: string, args: any = {}): Promise<any> =>
  new Promise((resolve) => {
    const id = seq++;
    pending.set(id, resolve);
    (session as any).handleMessage({ seq: id, type: 'request', command, arguments: args });
  });
const waitEvent = (name: string, ms = 15000): Promise<any> =>
  new Promise((resolve, reject) => {
    const i = events.findIndex((e) => e.event === name);
    if (i >= 0) return resolve(events.splice(i, 1)[0]);
    const t = setTimeout(() => reject(new Error(`timeout waiting for event ${name}`)), ms);
    eventWaiters.push({ pred: (e) => e.event === name, resolve: (e) => { clearTimeout(t); resolve(e); } });
  });

const frame = async () => (await request('stackTrace', { threadId: 1 })).body.stackFrames[0];
const regs = async () => {
  const v = (await request('variables', { variablesReference: 1 })).body.variables;
  return Object.fromEntries(v.map((x: any) => [x.name.split(' ')[0], x.value]));
};

async function main() {
  const init = await request('initialize', INIT_ARGS);
  check('initialize advertises step back / memory / disassemble', !!(init.body?.supportsStepBack && init.body?.supportsReadMemoryRequest && init.body?.supportsDisassembleRequest), JSON.stringify(init).slice(0, 200));

  const launch = await request('launch', { program: factorial, stopOnEntry: true });
  check('launch succeeds', launch.success === true, launch.message ?? '');
  await waitEvent('initialized');

  const bp = await request('setBreakpoints', { source: { path: factorial }, breakpoints: [{ line: 36 }, { line: 3 }] });
  check('breakpoint on code line is verified', bp.body.breakpoints[0].verified === true && bp.body.breakpoints[0].line === 36);
  check('breakpoint on comment line is not verified', bp.body.breakpoints[1].verified === false, bp.body.breakpoints[1].message);

  await request('configurationDone');
  const entry = await waitEvent('stopped');
  check('stops on entry', entry.body.reason === 'entry');
  let f = await frame();
  check('first frame is line 10 (addi a1, zero, 4)', f.line === 10 && f.source.name === 'factorial.asm', JSON.stringify({ n: f.name, l: f.line }));

  const scopes = (await request('scopes', { frameId: 1 })).body.scopes;
  check('three scopes', scopes.map((s: any) => s.name).join() === 'Registers,Floating Point,Control and Status');
  let r = await regs();
  check('registers formatted as hex (decimal)', r.a1 === '0x00000000  (0)' && r.sp === '0x7fffeffc  (2147479548)', `a1=${r.a1} sp=${r.sp}`);

  for (let i = 0; i < 3; i++) {
    await request('next', { threadId: 1 });
    await waitEvent('stopped');
  }
  f = await frame();
  check('after 3 steps we are at label factorial (line 26)', f.line === 26 && f.name === 'factorial', JSON.stringify({ n: f.name, l: f.line }));

  await request('stepBack', { threadId: 1 });
  await waitEvent('stopped');
  f = await frame();
  check('step back returns to the jal (line 13)', f.line === 13, `line=${f.line}`);

  await request('continue', { threadId: 1 });
  const hit = await waitEvent('stopped');
  f = await frame();
  r = await regs();
  check('continue stops on the breakpoint (line 36, a1 = 4)', hit.body.reason === 'breakpoint' && f.line === 36 && r.a1 === '0x00000004  (4)', `reason=${hit.body.reason} line=${f.line} a1=${r.a1}`);

  // Second hit of the breakpoint (a1 = 3), then Reverse Continue must go back to the first hit (a1 = 4).
  await request('continue', { threadId: 1 });
  await waitEvent('stopped');
  r = await regs();
  check('second breakpoint hit (a1 = 3)', r.a1 === '0x00000003  (3)', `a1=${r.a1}`);
  await request('reverseContinue', { threadId: 1 });
  const back = await waitEvent('stopped');
  f = await frame();
  r = await regs();
  check('reverse continue goes back to the previous breakpoint hit (a1 = 4)', back.body.reason === 'breakpoint' && f.line === 36 && r.a1 === '0x00000004  (4)', `reason=${back.body.reason} line=${f.line} a1=${r.a1}`);

  const ev1 = await request('evaluate', { expression: 'a1', context: 'watch' });
  const ev2 = await request('evaluate', { expression: 'sp+4', context: 'watch' });
  const ev3 = await request('evaluate', { expression: 'mem[sp]', context: 'watch' });
  const ev4 = await request('evaluate', { expression: 'factorial', context: 'hover' });
  check('evaluate register / arithmetic / memory / label',
    ev1.body.result === '0x00000004  (4)' && ev2.body.result.startsWith('0x7fffeff8') && ev3.success && ev4.body.result.startsWith('0x00400010'),
    `${ev1.body.result} | ${ev2.body.result} | ${ev3.body?.result} | ${ev4.body?.result}`);

  const sv = await request('setVariable', { variablesReference: 1, name: 't3 (x28)', value: '0x20' });
  r = await regs();
  check('setVariable writes a register', sv.success && r.t3 === '0x00000020  (32)', JSON.stringify(sv.body));

  const mem = await request('readMemory', { memoryReference: '0x00400000', count: 8 });
  check('readMemory returns the first two instruction words', Buffer.from(mem.body.data, 'base64').toString('hex') === '93054000' + '13050000', Buffer.from(mem.body.data, 'base64').toString('hex'));

  const dis = await request('disassemble', { memoryReference: '0x00400000', instructionOffset: 0, instructionCount: 3 });
  check('disassemble lists basic instructions', dis.body.instructions[0].instruction.startsWith('addi x11,x0,4') && dis.body.instructions[0].line === 10, dis.body.instructions[0].instruction);

  // Clear breakpoints so step out is not interrupted by the recursion.
  await request('setBreakpoints', { source: { path: factorial }, breakpoints: [] });
  await request('stepOut', { threadId: 1 });
  await waitEvent('stopped');
  f = await frame();
  check('step out returns to the caller (line 15)', f.line === 15, `line=${f.line}`);

  await request('continue', { threadId: 1 });
  await waitEvent('exited');
  await waitEvent('terminated');
  check('program terminates (dropped off bottom)', out.some((o) => o.includes('dropped off bottom')), out.join('|'));
  check('hub keeps the finished simulator for inspection', hub.state === 'terminated' && hub.bridge !== undefined);

  const hubRegs = await hub.bridge!.call('registers', { bank: 'int' });
  check('registers still readable after the program ended (a0 = 24)', hubRegs.registers.find((x: any) => x.name === 'a0').value === '24');

  await request('disconnect');

  // ---- second session: input/output through the I/O sink, reusing the finished simulator ----
  const fs = await import('fs');
  const os = await import('os');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sparky-dap-')), 'io.asm');
  fs.writeFileSync(tmp, '.text\n li a7, 5\n ecall\n mv s1, a0\n li a7, 1\n ecall\n li a7, 10\n ecall\n');
  out.length = 0;
  const s2 = new SparkyDebugSession({ extensionPath: root } as any, hub, io, problems, log);
  Object.assign(session, {});
  (s2 as any).onDidSendMessage((m: any) => {
    if (m.type === 'event') {
      const w = eventWaiters.find((x) => x.pred(m));
      if (w) { eventWaiters.splice(eventWaiters.indexOf(w), 1); w.resolve(m); } else events.push(m);
    } else pending.get(m.request_seq)?.(m);
  });
  const req2 = (command: string, args: any = {}): Promise<any> =>
    new Promise((resolve) => {
      const id = seq++;
      pending.set(id, resolve);
      (s2 as any).handleMessage({ seq: id, type: 'request', command, arguments: args });
    });
  await req2('initialize', INIT_ARGS);
  const l2 = await req2('launch', { program: tmp, stopOnEntry: false, noDebug: true });
  check('second launch (run without debugging) succeeds, reusing the simulator', l2.success === true, l2.message ?? '');
  await waitEvent('initialized');
  await req2('configurationDone');
  await new Promise((r) => setTimeout(r, 600));
  io.sink('99\n');
  await waitEvent('terminated');
  check('input typed in the terminal reaches the program and output comes back', out.join('').includes('99') && out.some((o) => o.includes('(0)')), out.join('|'));
  await req2('disconnect');

  // ---- pause and terminate a program that never ends ----
  fs.writeFileSync(tmp, '.text\nloop: addi t0, t0, 1\n j loop\n');
  const sp = new SparkyDebugSession({ extensionPath: root } as any, hub, io, problems, log);
  (sp as any).onDidSendMessage((m: any) => {
    if (m.type === 'event') {
      const w = eventWaiters.find((x) => x.pred(m));
      if (w) { eventWaiters.splice(eventWaiters.indexOf(w), 1); w.resolve(m); } else events.push(m);
    } else pending.get(m.request_seq)?.(m);
  });
  const reqP = (command: string, args: any = {}): Promise<any> =>
    new Promise((resolve) => {
      const id = seq++;
      pending.set(id, resolve);
      (sp as any).handleMessage({ seq: id, type: 'request', command, arguments: args });
    });
  await reqP('initialize', INIT_ARGS);
  await reqP('launch', { program: tmp, stopOnEntry: false });
  await waitEvent('initialized');
  await reqP('configurationDone');
  await new Promise((r) => setTimeout(r, 400));
  await reqP('pause', { threadId: 1 });
  const paused = await waitEvent('stopped');
  check('pause stops a running endless loop', paused.body.reason === 'pause');
  await reqP('continue', { threadId: 1 });
  await new Promise((r) => setTimeout(r, 200));
  await reqP('terminate');
  await waitEvent('terminated');
  check('terminate ends a running program', true);
  await reqP('disconnect');

  // ---- third session: assembly error is reported ----
  fs.writeFileSync(tmp, '.text\n addi t0, t0\n');
  const s3 = new SparkyDebugSession({ extensionPath: root } as any, hub, io, problems, log);
  (s3 as any).onDidSendMessage((m: any) => pending.get(m.request_seq)?.(m));
  const req3 = (command: string, args: any = {}): Promise<any> =>
    new Promise((resolve) => {
      const id = seq++;
      pending.set(id, resolve);
      (s3 as any).handleMessage({ seq: id, type: 'request', command, arguments: args });
    });
  await req3('initialize', INIT_ARGS);
  const l3 = await req3('launch', { program: tmp });
  check('assembly errors make launch fail with a message', l3.success === false && /Assembly failed/.test(l3.message), l3.message ?? '');
  await req3('disconnect');
}

main()
  .catch((e) => {
    console.log('ERROR', e);
    failures++;
  })
  .finally(() => {
    hub.dispose();
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    setTimeout(() => process.exit(failures ? 1 : 0), 200);
  });

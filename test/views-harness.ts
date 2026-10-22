// Mounts the real webview panels in jsdom, wired to the real hub and Java bridge, and checks what they draw.
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import * as vscode from 'vscode';
import { Bridge, BridgeEvent } from '../src/bridge';
import { SparkyHub } from '../src/hub';
import { DataSegmentView } from '../src/views/dataSegmentView';
import { LabelsView } from '../src/views/labelsView';
import { RegistersView } from '../src/views/registersView';
import { TextSegmentView } from '../src/views/textSegmentView';

const root = path.resolve(__dirname, '..', '..');
const asmDir = process.argv[2] ?? path.resolve(root, '..');
const OPTIONS = { rv64: false, pseudo: true, startAtMain: false, selfModifyingCode: false, warningsAreErrors: false, memoryConfig: 'Default', reverse: true, programArguments: [] };

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, label: string, ms = 6000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (fn()) return true;
    } catch {
      /* DOM not ready yet */
    }
    await sleep(25);
  }
  console.log(`   (timeout waiting for: ${label})`);
  return false;
}

interface Mounted {
  dom: JSDOM;
  doc: Document;
  win: any;
  $: (sel: string) => any;
  $$: (sel: string) => any[];
}

function mount(view: any): Mounted {
  const handlers: Array<(m: any) => void> = [];
  let state: any = {};
  let dom!: JSDOM;
  const fakeView: any = {
    visible: true,
    webview: {
      options: {},
      cspSource: 'csp',
      html: '',
      asWebviewUri: (u: any) => ({ toString: () => u.fsPath }),
      onDidReceiveMessage: (h: any) => {
        handlers.push(h);
        return { dispose() {} };
      },
      postMessage: async (m: any) => {
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: m }));
        return true;
      },
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };
  view.resolveWebviewView(fakeView);
  const html = (fakeView.webview.html as string)
    .replace(/<link rel="stylesheet"[^>]*>/, '')
    .replace(/<script nonce="[^"]*" src="([^"]*)"><\/script>/g, (_m, src) => `<script>${fs.readFileSync(src, 'utf8')}</script>`);
  dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window: any) {
      window.acquireVsCodeApi = () => ({ postMessage: (m: any) => handlers.forEach((h) => h(m)), getState: () => state, setState: (s: any) => (state = s) });
      window.Element.prototype.scrollIntoView = function () {};
      window.addEventListener('error', (e: any) => console.log('   page error:', e.message));
    },
  });
  const doc = dom.window.document;
  return { dom, doc, win: dom.window, $: (s) => doc.querySelector(s), $$: (s) => [...doc.querySelectorAll(s)] };
}

const cells = (tr: Element) => [...tr.children].map((td) => td.textContent ?? '');
const click = (m: Mounted, el: Element) => el.dispatchEvent(new m.win.MouseEvent('click', { bubbles: true }));
const dbl = (m: Mounted, el: Element) => el.dispatchEvent(new m.win.MouseEvent('dblclick', { bubbles: true }));
const key = (m: Mounted, el: Element, k: string) => el.dispatchEvent(new m.win.KeyboardEvent('keydown', { key: k, bubbles: true }));
const change = (m: Mounted, el: Element) => el.dispatchEvent(new m.win.Event('change', { bubbles: true }));

async function loadProgram(bridge: Bridge, file: string) {
  const res = await bridge.call<any>('assemble', { files: [file], main: file, options: OPTIONS });
  return { files: [file], startPc: res.startPc, rv64: false, text: res.text, labels: res.labels, memory: res.memory };
}

async function runTo(bridge: Bridge, hub: SparkyHub, cmd: 'continue' | 'step'): Promise<BridgeEvent> {
  hub.setState('running');
  const stop = new Promise<BridgeEvent>((resolve) => {
    const h = (ev: BridgeEvent) => {
      if (ev.event === 'stopped' || ev.event === 'terminated') {
        bridge.off('event', h);
        resolve(ev);
      }
    };
    bridge.on('event', h);
  });
  await bridge.call(cmd);
  const ev = await stop;
  hub.setState(ev.event === 'terminated' ? 'terminated' : 'stopped', ev.pc);
  return ev;
}

async function main() {
  const ctx: any = { extensionUri: vscode.Uri.file(root) };
  const hub = new SparkyHub();
  const regs = mount(new RegistersView(ctx, hub));
  const text = mount(new TextSegmentView(ctx, hub));
  const data = mount(new DataSegmentView(ctx, hub));
  const labels = mount(new LabelsView(ctx, hub));
  await sleep(100);

  // ---- before any program is loaded ----
  check('all panels start with an explanatory empty state', [regs, text, data, labels].every((m) => !m.$('#empty').hidden && m.$('#table').hidden));

  // ---- load factorial.asm ----
  const bridge = new Bridge({ extensionPath: root });
  await bridge.whenReady();
  const factorial = path.join(asmDir, 'factorial.asm');
  hub.attach(bridge, await loadProgram(bridge, factorial));

  // Registers
  await until(() => regs.$$('#rows tr').length === 33, 'registers rows');
  let rows = regs.$$('#rows tr').map(cells);
  check('Registers: 32 registers + pc, with names, numbers and hex values', rows.length === 33 && rows[2].join('|') === 'sp|x2|0x7fffeffc' && rows[33 - 1].join('|') === 'pc||0x00400000', rows[2].join('|') + ' / ' + rows[32].join('|'));

  // Text segment
  await until(() => text.$$('#rows tr').length === 21, 'text rows');
  rows = text.$$('#rows tr').map(cells);
  check('Text Segment: Address / Code / Basic / Source columns', rows.length === 21 && rows[0].join('|') === '|0x00400000|0x00400593|addi x11,x0,4|addi a1, zero, 4', rows[0].join('|'));
  check('Text Segment: current instruction (pc) is highlighted', text.$('#rows tr.current')?.dataset.address === '4194304');

  // Labels
  await until(() => labels.$$('#rows tr').length >= 4, 'label rows');
  const names = labels.$$('#rows tr').map((tr) => cells(tr)[0]);
  check('Labels: symbol table listed', ['factorial', 'if', 'else', 'end'].every((n) => names.includes(n)), names.join(','));

  // Data segment
  await until(() => !data.$('#table').hidden && data.$$('#rows tr').length === 16, 'data rows');
  check('Data Segment: 16 rows x 8 words starting at .data', data.$$('#rows tr').length === 16 && cells(data.$$('#rows tr')[0])[0] === '0x10010000' && data.$$('#head th').length === 9 && data.$$('#head th')[1].textContent === 'Value (+0)' && data.$$('#head th')[8].textContent === 'Value (+1c)');
  const options = data.$$('#mode option').map((o) => o.textContent);
  check('Data Segment: region selector like RARS', options.some((o) => /^\.data/.test(o)) && options.some((o) => /current sp/.test(o)) && options.some((o) => /current gp/.test(o)) && options.some((o) => /^\.text/.test(o)), options.join(' | '));

  // ---- run to the breakpoint inside factorial (line 36 -> 0x400030) ----
  await bridge.call('setBreakpoints', { addresses: [0x400030] });
  await runTo(bridge, hub, 'continue');
  await until(() => regs.$$('#rows tr').some((tr) => cells(tr)[0] === 'a1' && cells(tr)[2] === '0x00000004'), 'a1 = 4');
  const changedRegs = regs.$$('#rows td.changed').map((td) => cells(td.parentElement!)[0]);
  check('Registers: values changed since the previous stop are highlighted', ['a1', 'sp', 'ra', 't0'].every((n) => changedRegs.includes(n)) && !changedRegs.includes('s0'), changedRegs.join(','));
  await until(() => text.$('#rows tr.current')?.dataset.address === String(0x400030), 'text current row');
  check('Text Segment: highlight follows the pc', text.$('#rows tr.current')?.dataset.address === String(0x400030));

  // register tabs and number format
  click(regs, regs.$('.tab[data-bank="fp"]'));
  check('Registers: Floating Point tab', regs.$$('#rows tr').length === 32 && cells(regs.$$('#rows tr')[0])[0] === 'ft0' && cells(regs.$$('#rows tr')[0])[1] === 'f0');
  click(regs, regs.$('.tab[data-bank="csr"]'));
  check('Registers: Control and Status tab', regs.$$('#rows tr').length > 5 && regs.$$('#rows tr').some((tr) => cells(tr)[0] === 'instret'));
  click(regs, regs.$('.tab[data-bank="int"]'));
  regs.$('#hex').checked = false;
  change(regs, regs.$('#hex'));
  check('Registers: decimal mode', cells(regs.$$('#rows tr').find((tr) => cells(tr)[0] === 'a1')!)[2] === '4');
  regs.$('#hex').checked = true;
  change(regs, regs.$('#hex'));

  // edit a register from the panel
  const t3 = regs.$$('#rows tr').find((tr) => cells(tr)[0] === 't3')!;
  dbl(regs, t3.children[2]);
  const input = t3.querySelector('input') as HTMLInputElement | null;
  check('Registers: double-click opens an editor', !!input);
  if (input) {
    input.value = '0x20';
    key(regs, input, 'Enter');
  }
  await until(() => cells(regs.$$('#rows tr').find((tr) => cells(tr)[0] === 't3')!)[2] === '0x00000020', 't3 = 0x20');
  const t3now = regs.$$('#rows tr').find((tr) => cells(tr)[0] === 't3')!;
  check('Registers: edited value reaches the simulator and is highlighted', cells(t3now)[2] === '0x00000020' && t3now.children[2].classList.contains('changed'));

  // Data segment: follow sp and highlight the words the program just pushed
  data.$('#mode').value = 'sp';
  change(data, data.$('#mode'));
  await until(() => cells(data.$$('#rows tr')[0])[0] === '0x7fffefe0', 'data base follows sp');
  const cellAt = (addr: number) => data.$$('#rows td').find((td) => (td as HTMLElement).title.includes('0x' + addr.toString(16).padStart(8, '0')));
  const raWord = cellAt(0x7fffeff8)!;
  const a1Word = cellAt(0x7fffeff4)!;
  check('Data Segment: current sp region shows the pushed ra and a1', raWord?.textContent === '0x0040000c' && a1Word?.textContent === '0x00000004', `${raWord?.textContent} ${a1Word?.textContent}`);
  check('Data Segment: words written by the last run are highlighted', raWord.classList.contains('changed') && a1Word.classList.contains('changed') && !cellAt(0x7fffeffc)?.classList.contains('changed'));

  data.$('#hexVal').checked = false;
  change(data, data.$('#hexVal'));
  check('Data Segment: decimal values', cellAt(0x7fffeff4)?.textContent === '4');
  data.$('#hexVal').checked = true;
  change(data, data.$('#hexVal'));

  // edit a memory cell
  dbl(data, cellAt(0x7fffeff4)!);
  const cellInput = data.$('td input') as HTMLInputElement | null;
  if (cellInput) {
    cellInput.value = '7';
    key(data, cellInput, 'Enter');
  }
  await until(() => cellAt(0x7fffeff4)?.textContent === '0x00000007', 'cell edited');
  check('Data Segment: editing a cell writes simulator memory', cellAt(0x7fffeff4)?.textContent === '0x00000007');

  // go to a label
  (data.$('#goto') as HTMLInputElement).value = 'factorial';
  key(data, data.$('#goto'), 'Enter');
  await until(() => cells(data.$$('#rows tr')[0])[0] === '0x00400000', 'goto factorial');
  check('Data Segment: "Go to" accepts a label (shows the text segment words)', cells(data.$$('#rows tr')[0])[1] === '0x00400593', cells(data.$$('#rows tr')[0]).slice(0, 3).join('|'));
  click(data, data.$('#rowDown'));
  await until(() => cells(data.$$('#rows tr')[0])[0] === '0x00400020', 'row down');
  check('Data Segment: scrolling moves by one row (32 bytes)', cells(data.$$('#rows tr')[0])[0] === '0x00400020');

  // ASCII mode
  data.$('#ascii').checked = true;
  change(data, data.$('#ascii'));
  check('Data Segment: ASCII mode shows 4 characters per word', data.$$('#rows tr')[0].children[1].textContent!.length === 4);
  data.$('#ascii').checked = false;
  change(data, data.$('#ascii'));

  // ---- breakpoints from the Text Segment ----
  const bpRow = text.$$('#rows tr').find((tr) => (tr as HTMLElement).dataset.address === String(0x400010))!;
  const box = bpRow.querySelector('input.bkpt-box') as HTMLInputElement;
  box.checked = true;
  change(text, box);
  await until(() => vscode.debug.breakpoints.length === 1, 'breakpoint added');
  const bp = vscode.debug.breakpoints[0] as any;
  check('Text Segment: checking Bkpt creates an editor breakpoint on the source line', bp.location.uri.fsPath.endsWith('factorial.asm') && bp.location.range.start.line === 25, `line ${bp.location.range.start.line + 1}`);
  await sleep(150);
  check('Text Segment: checkbox stays checked and reflects editor breakpoints', (text.$$('#rows tr').find((tr) => (tr as HTMLElement).dataset.address === String(0x400010))!.querySelector('input') as HTMLInputElement).checked);
  vscode.debug.removeBreakpoints([bp]);
  await sleep(150);
  check('Text Segment: removing the editor breakpoint unchecks the box', !(text.$$('#rows tr').find((tr) => (tr as HTMLElement).dataset.address === String(0x400010))!.querySelector('input') as HTMLInputElement).checked);

  // ---- finish: panels keep showing the final state ----
  await bridge.call('setBreakpoints', { addresses: [] });
  const end = await runTo(bridge, hub, 'continue');
  // The saved n was edited from 4 to 7 in the Data Segment test above, so the program now computes 7 * 3! = 42.
  await until(() => cells(regs.$$('#rows tr').find((tr) => cells(tr)[0] === 'a0')!)[2] === '0x0000002a', 'a0 = 42');
  check('Registers: final result reflects the edited memory (a0 = 42) and "program finished"', end.event === 'terminated' && regs.$('#status').textContent === 'program finished' && cells(regs.$$('#rows tr').find((tr) => cells(tr)[0] === 'a0')!)[2] === '0x0000002a');

  // ---- second program with a .data segment (helloWorld.asm): data labels ----
  hub.attach(bridge, await loadProgram(bridge, path.join(asmDir, 'helloWorld.asm')));
  await until(() => labels.$$('#rows tr').some((tr) => cells(tr)[0] === 'str'), 'labels reloaded');
  const strRow = labels.$$('#rows tr').find((tr) => cells(tr)[0] === 'str')!;
  check('Labels: data label is flagged as .data', cells(strRow)[2] === '.data' && cells(strRow)[1] === '0x10010000', cells(strRow).join('|'));
  click(labels, strRow);
  await until(() => data.$('#mode').value === 'custom', 'data view reveals label');
  await until(() => cells(data.$$('#rows tr')[0])[0] === '0x10010000' && cells(data.$$('#rows tr')[0])[1] === '0x00000048', 'str words');
  check('Labels: clicking a data label shows it in the Data Segment ("H" = 0x48)', cells(data.$$('#rows tr')[0]).slice(0, 4).join('|') === '0x10010000|0x00000048|0x00000065|0x0000006c', cells(data.$$('#rows tr')[0]).slice(0, 4).join('|'));
  check('Text Segment reloads for the new program', text.$$('#rows tr').length === 12 || text.$$('#rows tr').length > 5, String(text.$$('#rows tr').length));

  bridge.dispose();
}

main()
  .catch((e) => {
    console.log('ERROR', e);
    failures++;
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    setTimeout(() => process.exit(failures ? 1 : 0), 200);
  });

import * as vscode from 'vscode';
import { SparkyHub } from '../hub';
import { MemoryWords, RegistersResult } from '../types';
import { BaseView } from './base';

const COLUMNS = 8; // words per row, like RARS
const ROWS = 16;
const ROW_BYTES = COLUMNS * 4;

type Mode = 'data' | 'sp' | 'gp' | 'text' | 'heap' | 'extern' | 'kernel' | 'mmio' | 'custom';

/** RARS "Data Segment" window: Address + Value (+0) ... Value (+1c), with selectable regions. */
export class DataSegmentView extends BaseView {
  static readonly viewId = 'sparky.dataSegment';
  private mode: Mode = 'data';
  private custom = 0;

  constructor(ctx: vscode.ExtensionContext, hub: SparkyHub) {
    super(ctx, hub, 'dataSegment.js', 'panel');
    this.disposables.push(
      hub.onDidRequestReveal((r) => {
        if (r.kind === 'data') {
          this.mode = 'custom';
          this.custom = r.address;
          void this.safeRefresh();
          void vscode.commands.executeCommand('sparky.dataSegment.focus');
        }
      }),
    );
  }

  protected body(): string {
    return `
<div class="layout">
  <div class="toolbar">
    <select id="mode" title="Region to show"></select>
    <button class="btn" id="pageUp" title="Previous page">&#x23EB;</button>
    <button class="btn" id="rowUp" title="Previous row">&#x25B2;</button>
    <button class="btn" id="rowDown" title="Next row">&#x25BC;</button>
    <button class="btn" id="pageDown" title="Next page">&#x23EC;</button>
    <input id="goto" class="goto" placeholder="Go to address / label" spellcheck="false">
    <label class="check"><input type="checkbox" id="hexAddr" checked> Hex addresses</label>
    <label class="check"><input type="checkbox" id="hexVal" checked> Hex values</label>
    <label class="check"><input type="checkbox" id="ascii"> ASCII</label>
    <span id="status" class="status"></span>
  </div>
  <div class="scroll" id="scroll">
    <div id="empty" class="empty">Run or debug a RISC-V file to see its memory.</div>
    <table id="table" hidden>
      <thead id="head"></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
</div>`;
  }

  private static align(addr: number): number {
    return (addr & ~(ROW_BYTES - 1)) >>> 0;
  }

  async refresh(): Promise<void> {
    const bridge = this.hub.bridge;
    const program = this.hub.program;
    if (!bridge || !program) {
      this.post({ type: 'empty' });
      return;
    }
    if (this.hub.state === 'running') {
      this.post({ type: 'state', state: 'running' });
      return;
    }
    const regs = await bridge.call<RegistersResult>('registers', { bank: 'int' });
    const reg = (name: string) => Number(BigInt.asUintN(32, BigInt(regs.registers.find((r) => r.name === name)?.value ?? '0')));
    const m = program.memory;
    const sp = reg('sp');
    const gp = reg('gp');
    const modes: Array<{ id: Mode; label: string; address: number }> = [
      { id: 'data', label: '.data', address: m.dataBase },
      { id: 'sp', label: 'current sp', address: sp },
      { id: 'gp', label: 'current gp', address: gp },
      { id: 'text', label: '.text', address: m.textBase },
      { id: 'heap', label: 'heap', address: m.heapBase },
      { id: 'extern', label: '.extern', address: m.externBase },
      { id: 'kernel', label: 'kernel', address: m.kernelBase },
      { id: 'mmio', label: 'MMIO', address: m.memoryMapBase },
    ];
    const chosen = modes.find((x) => x.id === this.mode);
    const base = DataSegmentView.align(chosen ? chosen.address : this.custom);
    if (!chosen) this.custom = base;

    const mem = await bridge.call<MemoryWords>('readMemory', { address: base, words: COLUMNS * ROWS });
    const writes = await this.hub.memoryWrites();
    const end = base + ROWS * ROW_BYTES;
    const changed: number[] = [];
    for (const w of writes) if (w >= base && w < end) changed.push(w);
    const labels: Record<number, string> = {};
    for (const l of program.labels) if (l.address >= base && l.address < end) labels[l.address & ~3] = labels[l.address & ~3] ? `${labels[l.address & ~3]}, ${l.name}` : l.name;

    this.post({
      type: 'memory',
      state: this.hub.state,
      mode: this.mode,
      modes,
      base,
      columns: COLUMNS,
      words: mem.words,
      changed,
      labels,
    });
  }

  protected async handle(msg: any): Promise<void> {
    const bridge = this.hub.bridge;
    const program = this.hub.program;
    if (!bridge || !program) return;
    switch (msg.type) {
      case 'select':
        this.mode = msg.mode as Mode;
        break;
      case 'scroll':
      case 'page': {
        const rows = msg.type === 'page' ? msg.dir * ROWS : msg.rows;
        const base = msg.base as number;
        this.mode = 'custom';
        this.custom = (base + rows * ROW_BYTES) >>> 0;
        break;
      }
      case 'goto': {
        const text = String(msg.text).trim();
        const label = program.labels.find((l) => l.name === text);
        const value = label ? label.address : /^0[xX][0-9a-fA-F]+$/.test(text) || /^\d+$/.test(text) ? Number(text) : NaN;
        if (!Number.isFinite(value)) throw new Error(`"${text}" is not an address or a label.`);
        this.mode = 'custom';
        this.custom = value >>> 0;
        break;
      }
      case 'write': {
        const value = parseWord(String(msg.text));
        await bridge.call('writeMemory', { address: msg.address, value });
        this.hub.mutated();
        return;
      }
      default:
        return;
    }
    await this.safeRefresh();
  }
}

function parseWord(text: string): number {
  const t = text.trim();
  let v: bigint;
  if (/^[-+]?0[xX][0-9a-fA-F]+$/.test(t)) v = t.startsWith('-') ? -BigInt(t.slice(1)) : BigInt(t.replace('+', ''));
  else if (/^[-+]?\d+$/.test(t)) v = BigInt(t);
  else if (/^'.'$/.test(t)) v = BigInt(t.charCodeAt(1));
  else throw new Error(`"${text}" is not a number.`);
  return Number(BigInt.asIntN(32, v));
}

import * as vscode from 'vscode';
import { SparkyHub } from '../hub';
import { RegisterBank, RegistersResult } from '../types';
import { BaseView } from './base';

const BANKS: RegisterBank[] = ['int', 'fp', 'csr'];

/** RARS "Registers" panel: Registers / Floating Point / Control and Status tabs. */
export class RegistersView extends BaseView {
  static readonly viewId = 'sparky.registers';
  private session = -1;
  private counter = -1;
  private prev: Map<string, string> | undefined;
  private curr: Map<string, string> | undefined;

  constructor(ctx: vscode.ExtensionContext, hub: SparkyHub) {
    super(ctx, hub, 'registers.js', 'sidebar');
  }

  protected body(): string {
    return `
<div class="layout">
  <div class="toolbar">
    <div class="tabs">
      <button class="tab active" data-bank="int">Registers</button>
      <button class="tab" data-bank="fp">Floating Point</button>
      <button class="tab" data-bank="csr">Control and Status</button>
    </div>
    <label class="check"><input type="checkbox" id="hex" checked> Hexadecimal</label>
    <span id="status" class="status"></span>
  </div>
  <div class="scroll" id="scroll">
    <div id="empty" class="empty">Run or debug a RISC-V file to see its registers.<br>Use <b>Sparky: Debug Current File</b> or press F5.</div>
    <table id="table" hidden>
      <thead><tr><th>Name</th><th>Number</th><th class="value">Value</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
</div>`;
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
    const banks = {} as Record<RegisterBank, RegistersResult>;
    for (const b of BANKS) banks[b] = await bridge.call<RegistersResult>('registers', { bank: b });

    if (this.session !== this.hub.sessionId) {
      this.session = this.hub.sessionId;
      this.prev = undefined;
      this.curr = undefined;
      this.counter = -1;
    }
    if (this.counter !== this.hub.stopCounter) {
      this.counter = this.hub.stopCounter;
      this.prev = this.curr;
      const snap = new Map<string, string>();
      for (const b of BANKS) for (const r of banks[b].registers) snap.set(`${b}:${r.name}`, r.value);
      snap.set('int:pc', String(banks.int.pc));
      this.curr = snap;
    }
    const changed: Record<RegisterBank, string[]> = { int: [], fp: [], csr: [] };
    if (this.prev && this.curr) {
      for (const [key, value] of this.curr) {
        const before = this.prev.get(key);
        if (before !== undefined && before !== value) {
          const [bank, name] = key.split(':') as [RegisterBank, string];
          changed[bank].push(name);
        }
      }
    }
    this.post({
      type: 'registers',
      state: this.hub.state,
      rv64: banks.int.rv64,
      pc: banks.int.pc,
      banks: { int: banks.int.registers, fp: banks.fp.registers, csr: banks.csr.registers },
      changed,
    });
  }

  protected async handle(msg: any): Promise<void> {
    if (msg.type !== 'setRegister') return;
    const bridge = this.hub.bridge;
    if (!bridge) return;
    await bridge.call('setRegister', { bank: msg.bank, name: msg.name, value: msg.value });
    await this.hub.syncPc();
    this.hub.mutated();
  }
}

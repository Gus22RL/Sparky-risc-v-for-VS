import * as vscode from 'vscode';
import { SparkyHub } from '../hub';
import { BaseView } from './base';

/** RARS "Labels" window: the symbol table; clicking a label jumps to it in the Text or Data Segment. */
export class LabelsView extends BaseView {
  static readonly viewId = 'sparky.labels';
  private sentSession = -1;

  constructor(ctx: vscode.ExtensionContext, hub: SparkyHub) {
    super(ctx, hub, 'labels.js', 'panel');
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.sentSession = -1;
    super.resolveWebviewView(view);
  }

  protected body(): string {
    return `
<div class="layout">
  <div class="toolbar">
    <input id="filter" class="goto" placeholder="Filter labels" spellcheck="false">
    <button class="btn" id="sort" title="Sort by name / address">Sort: name</button>
    <label class="check"><input type="checkbox" id="hex" checked> Hexadecimal</label>
  </div>
  <div class="scroll" id="scroll">
    <div id="empty" class="empty">Run or debug a RISC-V file to see its labels.</div>
    <table id="table" hidden>
      <thead><tr><th>Label</th><th>Address</th><th>Segment</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
</div>`;
  }

  async refresh(): Promise<void> {
    const program = this.hub.program;
    if (!program) {
      this.sentSession = -1;
      this.post({ type: 'empty' });
      return;
    }
    if (this.sentSession === this.hub.sessionId) return;
    this.sentSession = this.hub.sessionId;
    this.post({ type: 'labels', labels: program.labels.map((l) => ({ name: l.name, address: l.address, kind: l.type })) });
  }

  protected handle(msg: any): void {
    if (msg.type === 'reveal') this.hub.reveal({ address: msg.address, kind: msg.kind });
  }
}

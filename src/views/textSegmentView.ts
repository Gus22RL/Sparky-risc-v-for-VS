import * as path from 'path';
import * as vscode from 'vscode';
import { SparkyHub } from '../hub';
import { pathKey } from '../util';
import { BaseView } from './base';

/** RARS "Text Segment" window: Bkpt / Address / Code / Basic / Source, with the current instruction highlighted. */
export class TextSegmentView extends BaseView {
  static readonly viewId = 'sparky.textSegment';
  private sentSession = -1;

  constructor(ctx: vscode.ExtensionContext, hub: SparkyHub) {
    super(ctx, hub, 'textSegment.js', 'panel');
    this.disposables.push(
      vscode.debug.onDidChangeBreakpoints(() => {
        if (this.view?.visible) void this.safeRefresh();
      }),
      hub.onDidRequestReveal((r) => {
        if (r.kind === 'text') {
          this.post({ type: 'reveal', address: r.address });
          void vscode.commands.executeCommand('sparky.textSegment.focus');
        }
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.sentSession = -1; // a fresh webview has no rows yet
    super.resolveWebviewView(view);
  }

  protected body(): string {
    return `
<div class="layout">
  <div class="toolbar">
    <label class="check"><input type="checkbox" id="hex" checked> Hexadecimal</label>
    <span id="status" class="status"></span>
  </div>
  <div class="scroll" id="scroll">
    <div id="empty" class="empty">Run or debug a RISC-V file to see the assembled program.</div>
    <table id="table" hidden>
      <thead><tr><th class="bkpt">Bkpt</th><th>Address</th><th>Code</th><th>Basic</th><th>Source</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
</div>`;
  }

  private breakpointAddresses(): number[] {
    const program = this.hub.program;
    if (!program) return [];
    const wanted = new Set<string>();
    for (const bp of vscode.debug.breakpoints) {
      if (bp instanceof vscode.SourceBreakpoint && bp.enabled) wanted.add(`${pathKey(bp.location.uri.fsPath)}:${bp.location.range.start.line + 1}`);
    }
    return this.firstOfLine(program.text).filter((r) => wanted.has(`${pathKey(r.file)}:${r.line}`)).map((r) => r.address);
  }

  private firstOfLine<T extends { file: string; line: number; address: number }>(rows: T[]): T[] {
    const seen = new Map<string, T>();
    for (const r of rows) {
      const key = `${pathKey(r.file)}:${r.line}`;
      const cur = seen.get(key);
      if (!cur || r.address < cur.address) seen.set(key, r);
    }
    return [...seen.values()];
  }

  async refresh(): Promise<void> {
    const program = this.hub.program;
    if (!program) {
      this.sentSession = -1;
      this.post({ type: 'empty' });
      return;
    }
    if (this.sentSession !== this.hub.sessionId) {
      this.sentSession = this.hub.sessionId;
      const first = new Set(this.firstOfLine(program.text).map((r) => r.address));
      this.post({
        type: 'program',
        rows: program.text.map((r) => ({
          address: r.address,
          code: r.code,
          basic: r.basic,
          source: r.source,
          line: r.line,
          file: path.basename(r.file),
          bkpt: first.has(r.address),
        })),
      });
    }
    this.post({ type: 'update', pc: this.hub.pc, state: this.hub.state, breakpoints: this.breakpointAddresses() });
  }

  protected async handle(msg: any): Promise<void> {
    const program = this.hub.program;
    if (!program) return;
    const row = program.text.find((r) => r.address === msg.address);
    if (!row) return;
    const uri = vscode.Uri.file(row.file);
    const line = row.line - 1;
    if (msg.type === 'toggleBreakpoint') {
      const existing = vscode.debug.breakpoints.find(
        (b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint && pathKey(b.location.uri.fsPath) === pathKey(row.file) && b.location.range.start.line === line,
      );
      if (existing) vscode.debug.removeBreakpoints([existing]);
      else vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line, 0)))]);
    } else if (msg.type === 'open') {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(line, 0, line, 0),
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
      });
    }
  }
}

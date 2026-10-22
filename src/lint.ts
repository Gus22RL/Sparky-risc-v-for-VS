import * as vscode from 'vscode';
import { Bridge } from './bridge';
import { assembleOptions, bridgeOptions, cfg } from './config';
import { InstructionInfo } from './instructionInfo';
import { RarsDiagnostic } from './types';

export const LANGUAGE_ID = 'sparky-riscv';

/**
 * Runs the real RARS assembler on the text of each open RISC-V file (in a Java process of its own,
 * so it never disturbs a running debug session) and publishes the result as editor diagnostics.
 */
export class LintService implements vscode.Disposable {
  readonly diagnostics = vscode.languages.createDiagnosticCollection('sparky');
  readonly info = new InstructionInfo();
  private bridge: Bridge | undefined;
  private starting: Promise<Bridge | undefined> | undefined;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];
  private warnedAboutJava = false;
  private readonly onInfoEmitter = new vscode.EventEmitter<void>();
  readonly onDidLoadInfo = this.onInfoEmitter.event;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly log: vscode.OutputChannel) {
    this.disposables.push(
      this.diagnostics,
      this.onInfoEmitter,
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => {
        this.diagnostics.delete(d.uri);
        const t = this.timers.get(d.uri.toString());
        if (t) clearTimeout(t);
        this.timers.delete(d.uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        const relevant = ['javaPath', 'jarPath', 'lint', 'rv64', 'pseudoInstructions', 'warningsAreErrors', 'memoryConfiguration', 'selfModifyingCode'];
        if (!relevant.some((k) => e.affectsConfiguration(`sparky.${k}`))) return;
        if (!cfg().get<boolean>('lint.enable', true)) this.diagnostics.clear();
        void this.restart();
      }),
    );
    for (const d of vscode.workspace.textDocuments) this.schedule(d);
  }

  private enabled(): boolean {
    return cfg().get<boolean>('lint.enable', true);
  }

  private schedule(doc: vscode.TextDocument): void {
    if (doc.languageId !== LANGUAGE_ID || doc.uri.scheme === 'output') return;
    // Metadata (hover/completion) is useful even when the checker is switched off.
    void this.getBridge();
    if (!this.enabled()) return;
    const key = doc.uri.toString();
    const old = this.timers.get(key);
    if (old) clearTimeout(old);
    const delay = Math.max(100, cfg().get<number>('lint.delay', 500));
    this.timers.set(key, setTimeout(() => void this.lint(doc), delay));
  }

  async restart(): Promise<void> {
    this.bridge?.dispose();
    this.bridge = undefined;
    this.starting = undefined;
    this.warnedAboutJava = false;
    for (const d of vscode.workspace.textDocuments) this.schedule(d);
  }

  private getBridge(): Promise<Bridge | undefined> {
    if (this.bridge?.alive) return Promise.resolve(this.bridge);
    if (!this.starting) {
      this.starting = (async () => {
        const b = new Bridge(bridgeOptions(this.ctx.extensionPath, (l) => this.log.appendLine(`[checker] ${l}`)));
        try {
          await b.whenReady();
          b.once('exit', () => {
            if (this.bridge === b) this.bridge = undefined;
            this.starting = undefined;
          });
          this.bridge = b;
          await this.loadInfo(b);
          return b;
        } catch (e) {
          b.dispose();
          this.starting = undefined;
          this.reportStartFailure(e as Error);
          return undefined;
        }
      })();
    }
    return this.starting;
  }

  private reportStartFailure(err: Error): void {
    this.log.appendLine(`[checker] ${err.message}`);
    if (this.warnedAboutJava) return;
    this.warnedAboutJava = true;
    void vscode.window.showErrorMessage(`Sparky RISC-V: ${err.message}`, 'Open Settings').then((choice) => {
      if (choice) void vscode.commands.executeCommand('workbench.action.openSettings', 'sparky.javaPath');
    });
  }

  private async loadInfo(b: Bridge): Promise<void> {
    // The instruction set depends on RV32/RV64, which is selected through the options of a lint call.
    await b.call('lint', { text: '', options: assembleOptions() });
    const [ins, sys] = await Promise.all([b.call('instructions'), b.call('syscalls')]);
    this.info.set(ins.instructions, sys.syscalls);
    this.onInfoEmitter.fire();
  }

  private async lint(doc: vscode.TextDocument): Promise<void> {
    if (doc.isClosed) return;
    const b = await this.getBridge();
    if (!b) return;
    const version = doc.version;
    try {
      const res = await b.call<{ diagnostics: RarsDiagnostic[] }>('lint', { text: doc.getText(), options: assembleOptions() });
      if (doc.isClosed || doc.version !== version) return; // stale result
      this.diagnostics.set(doc.uri, res.diagnostics.map((d) => toDiagnostic(doc, d)));
    } catch (e) {
      this.log.appendLine(`[checker] ${(e as Error).message}`);
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.bridge?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

export function toDiagnostic(doc: vscode.TextDocument, d: RarsDiagnostic): vscode.Diagnostic {
  const lineNo = Math.min(Math.max(d.line - 1, 0), Math.max(doc.lineCount - 1, 0));
  const text = doc.lineAt(lineNo).text;
  let start: number;
  let end: number;
  if (d.column > 0 && d.column <= text.length) {
    start = d.column - 1;
    const m = /^[^\s,()]+/.exec(text.slice(start));
    end = start + (m ? m[0].length : 1);
  } else {
    start = text.length - text.trimStart().length;
    end = text.trimEnd().length;
    if (end <= start) end = start + 1;
  }
  const diag = new vscode.Diagnostic(
    new vscode.Range(lineNo, start, lineNo, end),
    d.message,
    d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
  );
  diag.source = 'RARS';
  return diag;
}

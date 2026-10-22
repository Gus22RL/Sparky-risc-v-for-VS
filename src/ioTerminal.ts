import * as vscode from 'vscode';

/** Pseudo-terminal that plays the role of RARS's "Run I/O" pane: program output and typed input. */
class SparkyPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  readonly onDidClose = this.closeEmitter.event;
  private opened = false;
  private queued: string[] = [];
  private line = '';
  private skipEscape = 0;
  onLine: (text: string) => void = () => undefined;

  open(): void {
    this.opened = true;
    for (const q of this.queued) this.writeEmitter.fire(q);
    this.queued = [];
  }

  close(): void {
    this.opened = false;
  }

  raw(text: string): void {
    if (this.opened) this.writeEmitter.fire(text);
    else this.queued.push(text);
  }

  handleInput(data: string): void {
    for (const ch of data) {
      if (this.skipEscape > 0) {
        // Swallow arrow keys and other escape sequences (ESC [ ... final-byte).
        if (this.skipEscape === 1 && ch !== '[' && ch !== 'O') this.skipEscape = 0;
        else if (this.skipEscape >= 2 && /[@-~]/.test(ch)) this.skipEscape = 0;
        else this.skipEscape = 2;
        continue;
      }
      if (ch === '\x1b') {
        this.skipEscape = 1;
      } else if (ch === '\r' || ch === '\n') {
        this.raw('\r\n');
        const text = this.line + '\n';
        this.line = '';
        this.onLine(text);
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.raw('\b \b');
        }
      } else if (ch >= ' ') {
        this.line += ch;
        this.raw(ch);
      }
    }
  }

  clear(): void {
    this.line = '';
    this.raw('\x1b[2J\x1b[3J\x1b[H');
  }
}

export class ProgramIO implements vscode.Disposable {
  private pty: SparkyPty | undefined;
  private terminal: vscode.Terminal | undefined;
  private readonly closeSub: vscode.Disposable;
  private sink: (text: string) => void = () => undefined;

  constructor() {
    this.closeSub = vscode.window.onDidCloseTerminal((t) => {
      if (t === this.terminal) {
        this.terminal = undefined;
        this.pty = undefined;
      }
    });
  }

  /** Where lines typed by the user go (the active simulator session). */
  setInputSink(sink: (text: string) => void): void {
    this.sink = sink;
    if (this.pty) this.pty.onLine = sink;
  }

  private ensure(): SparkyPty {
    if (!this.pty || !this.terminal) {
      const pty = new SparkyPty();
      pty.onLine = this.sink;
      this.pty = pty;
      this.terminal = vscode.window.createTerminal({ name: 'Sparky I/O', pty, iconPath: new vscode.ThemeIcon('chip') });
    }
    return this.pty;
  }

  show(preserveFocus: boolean): void {
    this.ensure();
    this.terminal?.show(preserveFocus);
  }

  reset(): void {
    this.ensure().clear();
  }

  write(text: string): void {
    this.ensure().raw(text.replace(/\r?\n/g, '\r\n'));
  }

  writeError(text: string): void {
    this.ensure().raw(`\x1b[31m${text.replace(/\r?\n/g, '\r\n')}\x1b[0m`);
  }

  writeInfo(text: string): void {
    this.ensure().raw(`\x1b[2m${text}\x1b[0m\r\n`);
  }

  dispose(): void {
    this.closeSub.dispose();
    this.terminal?.dispose();
  }
}

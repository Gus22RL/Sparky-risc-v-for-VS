// Minimal stand-in for the 'vscode' module so the debug adapter and the views can be exercised outside VS Code.
import * as fs from 'fs';
import * as path from 'path';

type Listener<T> = (e: T) => void;

export class EventEmitter<T> {
  private listeners: Array<Listener<T>> = [];
  event = (l: Listener<T>) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(e?: T): void {
    for (const l of [...this.listeners]) l(e as T);
  }
  dispose(): void {
    this.listeners = [];
  }
}

const mkUri = (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => fsPath });
export const Uri = {
  file: mkUri,
  joinPath: (base: { fsPath: string }, ...segs: string[]) => mkUri(path.join(base.fsPath, ...segs)),
};

export class Range {
  constructor(public sl: number, public sc: number, public el: number, public ec: number) {}
  get start() {
    return { line: this.sl, character: this.sc };
  }
}
export class Position {
  constructor(public line: number, public character: number) {}
}
export class Location {
  range: Range;
  constructor(public uri: { fsPath: string }, pos: Position) {
    this.range = new Range(pos.line, pos.character, pos.line, pos.character);
  }
}
export class SourceBreakpoint {
  enabled = true;
  constructor(public location: Location) {}
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

export class Diagnostic {
  source?: string;
  constructor(public range: Range, public message: string, public severity: number) {}
}

export const workspace = {
  textDocuments: [] as any[],
  async openTextDocument(uri: { fsPath: string }) {
    const lines = fs.readFileSync(uri.fsPath, 'utf8').split(/\r?\n/);
    return { uri, lineCount: lines.length, lineAt: (n: number) => ({ text: lines[n] ?? '' }) };
  },
  getConfiguration: () => ({ get: (_k: string, def: unknown) => def }),
};

const bpEmitter = new EventEmitter<void>();
export const debug = {
  breakpoints: [] as any[],
  onDidChangeBreakpoints: bpEmitter.event,
  addBreakpoints(list: any[]) {
    debug.breakpoints.push(...list);
    bpEmitter.fire();
  },
  removeBreakpoints(list: any[]) {
    debug.breakpoints = debug.breakpoints.filter((b) => !list.includes(b));
    bpEmitter.fire();
  },
};

export const commands = { executeCommand: async (..._a: unknown[]) => undefined };
export const window = {
  showErrorMessage: async (m: string) => console.log('   showErrorMessage:', m),
  showTextDocument: async (..._a: unknown[]) => undefined,
};
export const ViewColumn = { One: 1 };

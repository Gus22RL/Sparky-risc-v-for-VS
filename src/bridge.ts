import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

export interface BridgeEvent {
  event: string;
  [key: string]: any;
}

export interface BridgeOptions {
  extensionPath: string;
  javaPath?: string;
  jarPath?: string;
  log?: (line: string) => void;
}

export function resolveJava(configured?: string): string {
  if (configured && configured.trim()) return configured.trim();
  const home = process.env.JAVA_HOME;
  if (home) {
    const candidate = path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'java';
}

/**
 * One Java process running RarsBridge. Requests are JSON lines; responses are matched by id and
 * unsolicited messages (output, stopped, terminated, ...) are emitted as 'event'.
 */
export class Bridge extends EventEmitter {
  private proc: cp.ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readonly ready: Promise<void>;
  private closed = false;

  constructor(private readonly opts: BridgeOptions) {
    super();
    this.ready = this.start();
    // Avoid unhandled rejections when nobody awaits `ready` directly.
    this.ready.catch(() => undefined);
  }

  get alive(): boolean {
    return !this.closed;
  }

  private start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const jar = this.opts.jarPath && this.opts.jarPath.trim() ? this.opts.jarPath.trim() : path.join(this.opts.extensionPath, 'lib', 'rars1_6.jar');
      const classes = path.join(this.opts.extensionPath, 'bridge', 'classes');
      if (!fs.existsSync(jar)) {
        reject(new Error(`RARS jar not found: ${jar}`));
        return;
      }
      if (!fs.existsSync(path.join(classes, 'RarsBridge.class'))) {
        reject(new Error(`The Java bridge is not compiled (missing ${classes}). Run "npm run build:bridge".`));
        return;
      }
      const java = resolveJava(this.opts.javaPath);
      const args = ['-Djava.awt.headless=true', '-Dfile.encoding=UTF-8', '-XX:+UseSerialGC', '-cp', [jar, classes].join(path.delimiter), 'RarsBridge'];
      let started = false;
      let proc: cp.ChildProcessWithoutNullStreams;
      try {
        proc = cp.spawn(java, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) {
        reject(new Error(`Could not start Java (${java}): ${(e as Error).message}`));
        return;
      }
      this.proc = proc;

      proc.on('error', (err: NodeJS.ErrnoException) => {
        const msg = err.code === 'ENOENT'
          ? `Java was not found ("${java}"). Install a JRE/JDK 8 or newer, or set "sparky.javaPath".`
          : `Could not start Java: ${err.message}`;
        this.fail(new Error(msg));
        if (!started) reject(new Error(msg));
      });
      proc.on('exit', (code, signal) => {
        const msg = `The RARS process ended (${signal ?? code}).`;
        this.fail(new Error(msg));
        if (!started) reject(new Error(msg));
        this.emit('exit', code);
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d: string) => this.opts.log?.(d.trimEnd()));
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (line) this.onLine(line);
        }
      });
      this.once('ready', () => {
        started = true;
        resolve();
      });
    });
  }

  private onLine(line: string): void {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      this.opts.log?.(`bad bridge line: ${line}`);
      return;
    }
    if (m.event) {
      if (m.event === 'ready') this.emit('ready', m);
      this.emit('event', m as BridgeEvent);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error));
  }

  private fail(err: Error): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  async call<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.ready;
    if (this.closed || !this.proc) throw new Error('The RARS process is not running.');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Resolves when the Java side is initialised; rejects with a friendly message if it cannot start. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  dispose(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('The RARS process was closed.'));
    this.pending.clear();
    try {
      this.proc?.stdin.end();
      this.proc?.kill();
    } catch {
      /* already gone */
    }
    this.removeAllListeners();
  }
}

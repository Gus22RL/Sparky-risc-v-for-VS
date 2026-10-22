import * as vscode from 'vscode';
import { Bridge } from './bridge';
import { ProgramInfo } from './types';

export type RunState = 'idle' | 'running' | 'stopped' | 'terminated';

export interface RevealRequest {
  address: number;
  kind: 'text' | 'data';
}

/**
 * Shared state between the debug session and the views (registers, text segment, data segment).
 * It also keeps the simulator alive after a program finishes so its final registers and memory can
 * still be inspected, exactly like RARS does.
 */
export class SparkyHub implements vscode.Disposable {
  bridge: Bridge | undefined;
  program: ProgramInfo | undefined;
  state: RunState = 'idle';
  pc = 0;
  /** Bumps on every stop so views know when to refresh and re-diff. */
  stopCounter = 0;
  /** Bumps when a new program is loaded, so views can drop their previous snapshots. */
  sessionId = 0;

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly mutateEmitter = new vscode.EventEmitter<void>();
  /** Fired when a view edits a register or memory, so the debugger can refresh its Variables. */
  readonly onDidMutate = this.mutateEmitter.event;
  private readonly revealEmitter = new vscode.EventEmitter<RevealRequest>();
  /** Fired when the user clicks a label: the Data / Text Segment views jump to it. */
  readonly onDidRequestReveal = this.revealEmitter.event;

  /** Bumps only when the program itself stops (not when a view edits something). */
  private runCounter = 0;
  private writesCache: { counter: number; run: number; promise: Promise<Set<number>> } | undefined;

  /** Returns a usable idle bridge from a finished session, if any (avoids the JVM start-up). */
  takeIdleBridge(): Bridge | undefined {
    if (this.bridge?.alive && this.state === 'terminated') {
      const b = this.bridge;
      this.bridge = undefined;
      return b;
    }
    return undefined;
  }

  attach(bridge: Bridge, program: ProgramInfo): void {
    if (this.bridge && this.bridge !== bridge) this.bridge.dispose();
    this.bridge = bridge;
    this.program = program;
    this.state = 'stopped';
    this.pc = program.startPc;
    this.sessionId++;
    this.stopCounter++;
    this.runCounter++;
    this.changeEmitter.fire();
  }

  setState(state: RunState, pc?: number): void {
    this.state = state;
    if (pc !== undefined) this.pc = pc;
    if (state === 'stopped' || state === 'terminated') {
      this.stopCounter++;
      this.runCounter++;
    }
    this.changeEmitter.fire();
  }

  /** The session ended. Keep the simulator for inspection only if the program finished by itself. */
  detach(keepForInspection: boolean): void {
    if (!keepForInspection) {
      this.bridge?.dispose();
      this.bridge = undefined;
      this.state = 'idle';
    }
    this.changeEmitter.fire();
  }

  /** Re-reads the program counter from the simulator (after a register edit). */
  async syncPc(): Promise<void> {
    const st = await this.bridge?.call<{ pc: number }>('status');
    if (st) this.pc = st.pc;
  }

  /** A view changed the machine state (register / memory edit). */
  mutated(): void {
    this.stopCounter++;
    this.changeEmitter.fire();
    this.mutateEmitter.fire();
  }

  reveal(request: RevealRequest): void {
    this.revealEmitter.fire(request);
  }

  /**
   * Memory words written since the previous stop of the program (plus any edits made at this stop).
   * Reading the log on the Java side clears it, so the result is cached per stop and accumulated across edits.
   */
  memoryWrites(): Promise<Set<number>> {
    const bridge = this.bridge;
    if (!bridge) return Promise.resolve(new Set<number>());
    if (this.writesCache?.counter === this.stopCounter) return this.writesCache.promise;
    const previous = this.writesCache?.run === this.runCounter ? this.writesCache.promise : Promise.resolve(new Set<number>());
    const promise = Promise.all([previous, bridge.call<{ addresses: number[] }>('writes').catch(() => ({ addresses: [] as number[] }))]).then(
      ([before, now]) => new Set<number>([...before, ...now.addresses]),
    );
    this.writesCache = { counter: this.stopCounter, run: this.runCounter, promise };
    return promise;
  }

  dispose(): void {
    this.bridge?.dispose();
    this.changeEmitter.dispose();
    this.mutateEmitter.dispose();
    this.revealEmitter.dispose();
  }
}

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  DebugSession,
  ExitedEvent,
  InitializedEvent,
  InvalidatedEvent,
  OutputEvent,
  Scope,
  Source,
  StackFrame,
  StoppedEvent,
  TerminatedEvent,
  Thread,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Bridge, BridgeEvent } from './bridge';
import { assembleOptions, bridgeOptions, numberFormat } from './config';
import { SparkyHub } from './hub';
import { ProgramIO } from './ioTerminal';
import { toDiagnostic } from './lint';
import { AssembleResult, LabelRow, MemoryWords, ProgramInfo, RegisterBank, RegistersResult, TextRow } from './types';
import { formatFloatReg, formatInt, hex32, pathKey } from './util';

const THREAD_ID = 1;
const SCOPE_INT = 1;
const SCOPE_FP = 2;
const SCOPE_CSR = 3;

export interface LaunchArgs extends DebugProtocol.LaunchRequestArguments {
  program: string;
  extraFiles?: string[];
  project?: boolean;
  stopOnEntry?: boolean;
  startAtMain?: boolean;
  rv64?: boolean;
  pseudoInstructions?: boolean;
  selfModifyingCode?: boolean;
  warningsAreErrors?: boolean;
  memoryConfiguration?: string;
  reverseDebugging?: boolean;
  programArguments?: string[];
}

interface Located {
  file: string;
  line: number;
}

export class SparkyDebugSession extends DebugSession {
  private bridge: Bridge | undefined;
  private program: ProgramInfo | undefined;
  private noDebug = false;
  private stopOnEntry = true;
  private pc = 0;
  private running = false;
  private finished = false;
  private attached = false;
  private disposed = false;
  private exception: { message: string; where?: Located } | undefined;

  private readonly lineBreakpoints = new Map<string, number[]>();
  private instructionBreakpoints = new Set<number>();
  private byAddress = new Map<number, TextRow>();
  private rowsSorted: TextRow[] = [];
  private lineToAddress = new Map<string, Map<number, number>>();
  private codeLines = new Map<string, number[]>();
  private textLabels: LabelRow[] = [];
  private stopWaiters: Array<(ev: BridgeEvent) => void> = [];
  private readonly mutateSub: vscode.Disposable;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly hub: SparkyHub,
    private readonly io: ProgramIO,
    private readonly problems: vscode.DiagnosticCollection,
    private readonly log: vscode.OutputChannel,
  ) {
    super();
    // Registers or memory edited from the panels: make VS Code re-read Variables and the call stack.
    this.mutateSub = hub.onDidMutate(() => {
      this.pc = hub.pc;
      this.sendEvent(new InvalidatedEvent(['variables', 'stacks']));
    });
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  protected initializeRequest(response: DebugProtocol.InitializeResponse): void {
    response.body = {
      supportsConfigurationDoneRequest: true,
      supportsSetVariable: true,
      supportsEvaluateForHovers: true,
      supportsStepBack: true,
      supportsReadMemoryRequest: true,
      supportsWriteMemoryRequest: true,
      supportsDisassembleRequest: true,
      supportsSteppingGranularity: true,
      supportsInstructionBreakpoints: true,
      supportsBreakpointLocationsRequest: true,
      supportsTerminateRequest: true,
      supportsExceptionInfoRequest: true,
      exceptionBreakpointFilters: [],
    };
    this.sendResponse(response);
  }

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchArgs): Promise<void> {
    try {
      this.noDebug = !!args.noDebug;
      this.stopOnEntry = args.stopOnEntry !== false && !this.noDebug;
      if (!args.program) throw new Error('No program was specified ("program" in launch.json).');
      const program = path.resolve(args.program);
      if (!fs.existsSync(program)) throw new Error(`File not found: ${program}`);
      const files = this.collectFiles(program, args);
      const options = assembleOptions({
        rv64: args.rv64,
        pseudo: args.pseudoInstructions,
        startAtMain: args.startAtMain,
        selfModifyingCode: args.selfModifyingCode,
        warningsAreErrors: args.warningsAreErrors,
        memoryConfig: args.memoryConfiguration,
        reverse: args.reverseDebugging,
        programArguments: args.programArguments,
      });

      this.bridge = this.hub.takeIdleBridge() ?? new Bridge(bridgeOptions(this.ctx.extensionPath, (l) => this.log.appendLine(`[simulator] ${l}`)));
      await this.bridge.whenReady();
      this.bridge.removeAllListeners('event');
      this.bridge.on('event', (ev: BridgeEvent) => this.onBridgeEvent(ev));
      this.bridge.once('exit', () => this.onBridgeExit());

      this.io.reset();
      this.io.show(true);
      this.io.setInputSink((text) => {
        void this.bridge?.call('input', { text }).catch(() => undefined);
      });

      const res = await this.bridge.call<AssembleResult>('assemble', { files, main: program, options });
      await this.publishDiagnostics(res, files);
      if (!res.ok) {
        const errors = res.diagnostics.filter((d) => d.severity === 'error');
        for (const d of errors) {
          this.io.writeError(`Error in ${d.file} line ${d.line}${d.column > 0 ? ' column ' + d.column : ''}: ${d.message}\n`);
        }
        this.io.writeInfo('-- assembly failed --');
        this.bridge.dispose();
        this.bridge = undefined;
        void vscode.commands.executeCommand('workbench.actions.view.problems');
        throw new Error(`Assembly failed with ${errors.length} error(s). See the Problems panel.`);
      }
      for (const d of res.diagnostics) this.io.writeError(`Warning in ${d.file} line ${d.line}: ${d.message}\n`);

      this.program = {
        files,
        startPc: res.startPc!,
        rv64: options.rv64,
        text: res.text!,
        labels: res.labels!,
        memory: res.memory!,
      };
      this.buildIndexes(this.program);
      this.pc = this.program.startPc;
      this.hub.attach(this.bridge, this.program);
      this.attached = true;
      this.sendResponse(response);
      this.sendEvent(new InitializedEvent());
    } catch (e) {
      this.sendErrorResponse(response, { id: 1001, format: (e as Error).message, showUser: true });
    }
  }

  protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): void {
    this.sendResponse(response);
    if (this.stopOnEntry) {
      this.hub.setState('stopped', this.pc);
      this.sendEvent(new StoppedEvent('entry', THREAD_ID));
    } else {
      void this.resume('continue');
    }
  }

  protected async disconnectRequest(response: DebugProtocol.DisconnectResponse): Promise<void> {
    this.disposed = true;
    this.mutateSub.dispose();
    if (this.attached) this.hub.detach(this.finished);
    else this.bridge?.dispose();
    this.bridge = undefined;
    this.io.setInputSink(() => undefined);
    this.sendResponse(response);
  }

  protected async terminateRequest(response: DebugProtocol.TerminateResponse): Promise<void> {
    try {
      await this.bridge?.call('stop');
    } catch {
      /* not running */
    }
    this.sendResponse(response);
    this.sendEvent(new TerminatedEvent());
  }

  private collectFiles(program: string, args: LaunchArgs): string[] {
    const files = [program];
    if (args.project) {
      const dir = path.dirname(program);
      for (const f of fs.readdirSync(dir).sort()) {
        if (/\.(asm|s)$/i.test(f)) {
          const full = path.join(dir, f);
          if (pathKey(full) !== pathKey(program)) files.push(full);
        }
      }
    }
    for (const f of args.extraFiles ?? []) {
      const full = path.resolve(path.dirname(program), f);
      if (!files.some((x) => pathKey(x) === pathKey(full))) files.push(full);
    }
    return files;
  }

  private async publishDiagnostics(res: AssembleResult, files: string[]): Promise<void> {
    const byFile = new Map<string, typeof res.diagnostics>();
    for (const d of res.diagnostics) {
      const key = d.file && d.file.length > 0 ? d.file : files[0];
      byFile.set(key, [...(byFile.get(key) ?? []), d]);
    }
    for (const f of files) {
      if (!byFile.has(f) && !vscode.workspace.textDocuments.some((t) => pathKey(t.uri.fsPath) === pathKey(f))) {
        this.problems.delete(vscode.Uri.file(f));
      }
    }
    for (const [file, list] of byFile) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        this.problems.set(doc.uri, list.map((d) => toDiagnostic(doc, d)));
      } catch {
        /* file not readable: the message is still shown in the I/O terminal */
      }
    }
  }

  // ---- program indexes -----------------------------------------------------------------------

  private buildIndexes(p: ProgramInfo): void {
    this.byAddress = new Map(p.text.map((r) => [r.address, r]));
    this.rowsSorted = [...p.text].sort((a, b) => a.address - b.address);
    this.lineToAddress.clear();
    this.codeLines.clear();
    for (const r of this.rowsSorted) {
      const key = pathKey(r.file);
      let m = this.lineToAddress.get(key);
      if (!m) {
        m = new Map();
        this.lineToAddress.set(key, m);
      }
      if (!m.has(r.line)) m.set(r.line, r.address);
    }
    for (const [key, m] of this.lineToAddress) this.codeLines.set(key, [...m.keys()].sort((a, b) => a - b));
    this.textLabels = p.labels.filter((l) => l.type === 'text').sort((a, b) => a.address - b.address);
  }

  private locate(pc: number): Located | undefined {
    if (this.exception?.where) return this.exception.where;
    const r = this.byAddress.get(pc);
    return r ? { file: r.file, line: r.line } : undefined;
  }

  private frameName(pc: number): string {
    let best: LabelRow | undefined;
    for (const l of this.textLabels) {
      if (l.address <= pc) best = l;
      else break;
    }
    if (!best) return hex32(pc);
    const off = pc - best.address;
    return off === 0 ? best.name : `${best.name}+${off}`;
  }

  // ---- breakpoints ---------------------------------------------------------------------------

  protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
    const key = pathKey(args.source.path ?? '');
    const wanted = args.breakpoints ?? (args.lines ?? []).map((line) => ({ line }));
    const known = this.lineToAddress.get(key);
    const lines = this.codeLines.get(key) ?? [];
    const addresses: number[] = [];
    const result: DebugProtocol.Breakpoint[] = [];
    for (const bp of wanted) {
      let line = bp.line;
      let addr = known?.get(line);
      if (addr === undefined && known) {
        const next = lines.find((l) => l >= bp.line && l - bp.line <= 5);
        if (next !== undefined) {
          line = next;
          addr = known.get(next);
        }
      }
      if (addr === undefined) {
        result.push({ verified: false, line: bp.line, message: known ? 'There is no instruction on this line.' : 'This file is not part of the program being debugged.' });
      } else {
        addresses.push(addr);
        result.push({ verified: true, line });
      }
    }
    this.lineBreakpoints.set(key, addresses);
    await this.pushBreakpoints();
    response.body = { breakpoints: result };
    this.sendResponse(response);
  }

  protected async setInstructionBreakpointsRequest(
    response: DebugProtocol.SetInstructionBreakpointsResponse,
    args: DebugProtocol.SetInstructionBreakpointsArguments,
  ): Promise<void> {
    this.instructionBreakpoints = new Set();
    const result: DebugProtocol.Breakpoint[] = [];
    for (const bp of args.breakpoints) {
      const addr = (parseAddress(bp.instructionReference) + (bp.offset ?? 0)) >>> 0;
      const ok = this.byAddress.has(addr);
      if (ok) this.instructionBreakpoints.add(addr);
      result.push({ verified: ok, instructionReference: hex32(addr), message: ok ? undefined : 'No instruction at this address.' });
    }
    await this.pushBreakpoints();
    response.body = { breakpoints: result };
    this.sendResponse(response);
  }

  protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments): void {
    const lines = this.codeLines.get(pathKey(args.source.path ?? '')) ?? [];
    const last = args.endLine ?? args.line;
    response.body = { breakpoints: lines.filter((l) => l >= args.line && l <= last).map((line) => ({ line })) };
    this.sendResponse(response);
  }

  protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse): void {
    this.sendResponse(response);
  }

  private userBreakpoints(): Set<number> {
    const all = new Set<number>(this.instructionBreakpoints);
    for (const list of this.lineBreakpoints.values()) for (const a of list) all.add(a);
    return all;
  }

  private async pushBreakpoints(extra: number[] = []): Promise<void> {
    if (!this.bridge) return;
    const addresses = this.noDebug ? [] : [...this.userBreakpoints(), ...extra];
    try {
      await this.bridge.call('setBreakpoints', { addresses });
    } catch (e) {
      this.log.appendLine(`[simulator] setBreakpoints: ${(e as Error).message}`);
    }
  }

  // ---- running -------------------------------------------------------------------------------

  private onBridgeEvent(ev: BridgeEvent): void {
    switch (ev.event) {
      case 'output':
        if (ev.stream === 'stderr') this.io.writeError(ev.text);
        else this.io.write(ev.text);
        break;
      case 'inputWait':
        this.io.show(false);
        break;
      case 'stopped':
      case 'terminated': {
        const waiters = this.stopWaiters;
        this.stopWaiters = [];
        for (const w of waiters) w(ev);
        break;
      }
    }
  }

  private onBridgeExit(): void {
    if (this.disposed) return;
    this.running = false;
    const ev: BridgeEvent = { event: 'terminated', reason: 'crashed', exitCode: -1, message: 'The RARS process ended unexpectedly.' };
    const waiters = this.stopWaiters;
    this.stopWaiters = [];
    if (waiters.length > 0) for (const w of waiters) w(ev);
    else this.handleTerminated(ev);
  }

  private nextStop(): Promise<BridgeEvent> {
    return new Promise((resolve) => this.stopWaiters.push(resolve));
  }

  private async runBridge(cmd: 'continue' | 'step'): Promise<BridgeEvent> {
    const stop = this.nextStop();
    try {
      await this.bridge!.call(cmd);
    } catch (e) {
      this.stopWaiters = this.stopWaiters.slice(0, -1);
      throw e;
    }
    return stop;
  }

  private async resume(kind: 'continue' | 'step' | 'stepOut' | 'reverse'): Promise<void> {
    if (!this.bridge || this.running) return;
    this.running = true;
    this.exception = undefined;
    this.hub.setState('running');
    try {
      let ev: BridgeEvent;
      if (kind === 'continue') ev = await this.runBridge('continue');
      else if (kind === 'step') ev = await this.runBridge('step');
      else if (kind === 'stepOut') ev = await this.stepOut();
      else ev = await this.reverseContinue();
      this.running = false;
      this.afterStop(ev);
    } catch (e) {
      this.running = false;
      this.reportFailure(e as Error);
    }
  }

  private async stepOut(): Promise<BridgeEvent> {
    const regs = await this.readRegisters('int');
    const ra = Number(BigInt.asUintN(32, BigInt(regs.registers.find((r) => r.name === 'ra')!.value)));
    const sp0 = BigInt.asUintN(32, BigInt(regs.registers.find((r) => r.name === 'sp')!.value));
    if (!ra || !this.byAddress.has(ra)) return this.runBridge('continue');
    await this.pushBreakpoints([ra]);
    try {
      for (;;) {
        const ev = await this.runBridge('continue');
        if (ev.event === 'stopped' && ev.reason === 'breakpoint' && ev.pc === ra && !this.userBreakpoints().has(ra)) {
          const now = await this.readRegisters('int');
          const sp = BigInt.asUintN(32, BigInt(now.registers.find((r) => r.name === 'sp')!.value));
          if (sp >= sp0) return { ...ev, reason: 'step' };
          continue; // a deeper recursive return: keep going
        }
        return ev;
      }
    } finally {
      await this.pushBreakpoints();
    }
  }

  private async reverseContinue(): Promise<BridgeEvent> {
    const bps = this.userBreakpoints();
    for (let i = 0; i < 5000; i++) {
      const stop = this.nextStop();
      try {
        await this.bridge!.call('stepBack');
      } catch {
        this.stopWaiters = this.stopWaiters.slice(0, -1);
        const st = await this.bridge!.call('status');
        return { event: 'stopped', reason: 'step', pc: st.pc };
      }
      const ev = await stop;
      if (ev.event !== 'stopped') return ev;
      if (bps.has(ev.pc)) return { ...ev, reason: 'breakpoint' };
    }
    const st = await this.bridge!.call('status');
    return { event: 'stopped', reason: 'step', pc: st.pc };
  }

  private afterStop(ev: BridgeEvent): void {
    if (this.disposed) return;
    if (ev.event === 'terminated') {
      this.handleTerminated(ev);
      return;
    }
    this.pc = ev.pc;
    if (ev.reason === 'exception') {
      const where = ev.file && ev.line ? { file: ev.file as string, line: ev.line as number } : undefined;
      this.exception = { message: ev.message, where };
      const loc = where ? `Error in ${where.file} line ${where.line}: ` : 'Error: ';
      this.io.writeError(`\n${loc}${ev.message}\n`);
      this.io.writeInfo('-- program stopped because of an exception --');
      this.hub.setState('stopped', this.pc);
      this.sendEvent(new StoppedEvent('exception', THREAD_ID, ev.message));
      return;
    }
    const reason = ev.reason === 'ebreak' ? 'breakpoint' : ev.reason;
    this.hub.setState('stopped', this.pc);
    this.sendEvent(new StoppedEvent(reason, THREAD_ID));
  }

  private handleTerminated(ev: BridgeEvent): void {
    this.finished = ev.reason !== 'crashed' && ev.reason !== 'stopped';
    const how = ev.reason === 'cliff' ? 'dropped off bottom' : ev.reason === 'exit' ? String(ev.exitCode) : ev.reason === 'crashed' ? 'simulator crashed' : 'terminated';
    this.io.writeInfo(`\n-- program is finished running (${how}) --`);
    if (ev.reason === 'crashed') this.io.writeError(`${ev.message}\n`);
    this.hub.setState('terminated');
    this.sendEvent(new ExitedEvent(typeof ev.exitCode === 'number' ? ev.exitCode : 0));
    this.sendEvent(new TerminatedEvent());
  }

  private reportFailure(e: Error): void {
    this.sendEvent(new OutputEvent(`${e.message}\n`, 'stderr'));
    this.hub.setState('stopped', this.pc);
    this.sendEvent(new StoppedEvent('step', THREAD_ID, e.message));
  }

  protected continueRequest(response: DebugProtocol.ContinueResponse): void {
    response.body = { allThreadsContinued: true };
    this.sendResponse(response);
    void this.resume('continue');
  }

  protected nextRequest(response: DebugProtocol.NextResponse): void {
    this.sendResponse(response);
    void this.resume('step');
  }

  protected stepInRequest(response: DebugProtocol.StepInResponse): void {
    this.sendResponse(response);
    void this.resume('step');
  }

  protected stepOutRequest(response: DebugProtocol.StepOutResponse): void {
    this.sendResponse(response);
    void this.resume('stepOut');
  }

  protected stepBackRequest(response: DebugProtocol.StepBackResponse): void {
    this.sendResponse(response);
    void this.stepBackOnce();
  }

  protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse): void {
    this.sendResponse(response);
    void this.resume('reverse');
  }

  private async stepBackOnce(): Promise<void> {
    if (!this.bridge || this.running) return;
    this.exception = undefined;
    const stop = this.nextStop();
    try {
      await this.bridge.call('stepBack');
      this.afterStop(await stop);
    } catch (e) {
      this.stopWaiters = this.stopWaiters.slice(0, -1);
      this.reportFailure(e as Error);
    }
  }

  protected async pauseRequest(response: DebugProtocol.PauseResponse): Promise<void> {
    try {
      await this.bridge?.call('pause');
    } catch {
      /* not running */
    }
    this.sendResponse(response);
  }

  // ---- stack, scopes, variables --------------------------------------------------------------

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = { threads: [new Thread(THREAD_ID, 'RISC-V')] };
    this.sendResponse(response);
  }

  protected stackTraceRequest(response: DebugProtocol.StackTraceResponse): void {
    const where = this.locate(this.pc);
    const frame = new StackFrame(
      1,
      this.frameName(this.pc),
      where ? new Source(path.basename(where.file), where.file) : undefined,
      where ? where.line : 0,
      1,
    );
    frame.instructionPointerReference = hex32(this.pc);
    response.body = { stackFrames: [frame], totalFrames: 1 };
    this.sendResponse(response);
  }

  protected scopesRequest(response: DebugProtocol.ScopesResponse): void {
    response.body = {
      scopes: [new Scope('Registers', SCOPE_INT, false), new Scope('Floating Point', SCOPE_FP, true), new Scope('Control and Status', SCOPE_CSR, true)],
    };
    this.sendResponse(response);
  }

  private bankOf(ref: number): RegisterBank {
    return ref === SCOPE_FP ? 'fp' : ref === SCOPE_CSR ? 'csr' : 'int';
  }

  private async readRegisters(bank: RegisterBank): Promise<RegistersResult> {
    return this.bridge!.call<RegistersResult>('registers', { bank });
  }

  protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
    try {
      const bank = this.bankOf(args.variablesReference);
      const res = await this.readRegisters(bank);
      const mode = numberFormat();
      const rv64 = res.rv64;
      const vars: DebugProtocol.Variable[] = [];
      if (bank === 'int') {
        vars.push({ name: 'pc', value: formatInt(String(res.pc), false, mode), variablesReference: 0, evaluateName: 'pc', memoryReference: hex32(res.pc) });
      }
      for (const r of res.registers) {
        const label = bank === 'int' ? `${r.name} (x${r.number})` : bank === 'fp' ? `${r.name} (f${r.number})` : r.name;
        const value = bank === 'fp' ? formatFloatReg(r.value, r.f32, r.f64, mode) : formatInt(r.value, rv64, mode);
        const v: DebugProtocol.Variable = { name: label, value, variablesReference: 0, evaluateName: r.name };
        if (bank === 'int') v.memoryReference = hex32(Number(BigInt.asUintN(32, BigInt(r.value))));
        vars.push(v);
      }
      response.body = { variables: vars };
      this.sendResponse(response);
    } catch (e) {
      this.sendErrorResponse(response, { id: 1002, format: (e as Error).message });
    }
  }

  protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
    try {
      const bank = this.bankOf(args.variablesReference);
      const name = args.name.split(' ')[0];
      const text = args.value.trim();
      let value: bigint;
      if (bank === 'fp' && /^[-+]?(\d+\.\d*|\.\d+)(e[-+]?\d+)?[fd]?$/i.test(text)) {
        value = floatBits(Number.parseFloat(text), !this.program?.rv64 && !/d$/i.test(text));
      } else {
        value = await this.evaluateNumber(text);
      }
      await this.bridge!.call('setRegister', { bank, name, value: value.toString() });
      const res = await this.readRegisters(bank);
      const row = name === 'pc' ? undefined : res.registers.find((r) => r.name === name);
      const mode = numberFormat();
      let shown: string;
      if (name === 'pc') shown = formatInt(String(res.pc), false, mode);
      else if (!row) shown = args.value;
      else shown = bank === 'fp' ? formatFloatReg(row.value, row.f32, row.f64, mode) : formatInt(row.value, res.rv64, mode);
      if (name === 'pc') this.pc = res.pc;
      response.body = { value: shown };
      this.sendResponse(response);
      this.hub.setState('stopped', this.pc);
    } catch (e) {
      this.sendErrorResponse(response, { id: 1003, format: (e as Error).message, showUser: true });
    }
  }

  // ---- expressions (Watch / hover / Debug Console) -------------------------------------------

  private async lookupRegister(name: string): Promise<bigint | undefined> {
    if (name === 'pc') return BigInt((await this.readRegisters('int')).pc);
    for (const bank of ['int', 'fp', 'csr'] as RegisterBank[]) {
      const res = await this.readRegisters(bank);
      const prefix = bank === 'int' ? 'x' : bank === 'fp' ? 'f' : '';
      const row = res.registers.find((r) => r.name === name || (prefix && name === `${prefix}${r.number}`));
      if (row) return BigInt(row.value);
    }
    return undefined;
  }

  private async evaluateNumber(expr: string): Promise<bigint> {
    const tokens = expr.replace(/\s+/g, '').match(/[+-]?[^+-]+/g);
    if (!tokens) throw new Error(`Cannot evaluate "${expr}".`);
    let total = 0n;
    for (const tok of tokens) {
      const sign = tok.startsWith('-') ? -1n : 1n;
      const body = tok.replace(/^[+-]/, '');
      total += sign * (await this.evaluateTerm(body));
    }
    return total;
  }

  private async evaluateTerm(term: string): Promise<bigint> {
    if (/^0[xX][0-9a-fA-F]+$/.test(term) || /^\d+$/.test(term)) return BigInt(term);
    if (/^0[bB][01]+$/.test(term)) return BigInt(term);
    const ch = /^'(.)'$/.exec(term);
    if (ch) return BigInt(ch[1].charCodeAt(0));
    const reg = await this.lookupRegister(term);
    if (reg !== undefined) return reg;
    const label = this.program?.labels.find((l) => l.name === term);
    if (label) return BigInt(label.address);
    throw new Error(`Unknown name "${term}" (use a register, a label, a number or mem[address]).`);
  }

  protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
    try {
      const expr = args.expression.trim();
      const mode = numberFormat();
      const mem = /^(?:mem|m)\[(.+)\]$/i.exec(expr) ?? /^\*\s*(.+)$/.exec(expr) ?? /^\[(.+)\]$/.exec(expr);
      if (mem) {
        const addr = Number(BigInt.asUintN(32, await this.evaluateNumber(mem[1])));
        const words = await this.bridge!.call<MemoryWords>('readMemory', { address: addr, words: 1 });
        const w = words.words[0];
        if (w === null || w === undefined) throw new Error(`${hex32(addr)} is not a valid memory address.`);
        response.body = { result: formatInt(String(w | 0), false, mode), variablesReference: 0, memoryReference: hex32(addr) };
      } else {
        const reg = await this.lookupRegister(expr);
        const value = reg !== undefined ? reg : await this.evaluateNumber(expr);
        const isFp = /^f[0-9a-z]+$/.test(expr) && reg !== undefined && !/^(fp|fflags|frm|fcsr)$/.test(expr);
        const result = isFp ? formatFloatReg(value.toString(), undefined, undefined, mode) : formatInt(value.toString(), this.program?.rv64 ?? false, mode);
        const ref = Number(BigInt.asUintN(32, value));
        response.body = { result, variablesReference: 0, memoryReference: hex32(ref) };
      }
      this.sendResponse(response);
    } catch (e) {
      this.sendErrorResponse(response, { id: 1004, format: (e as Error).message });
    }
  }

  protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse): void {
    const message = this.exception?.message ?? 'The program stopped.';
    response.body = { exceptionId: 'RISC-V exception', description: message, breakMode: 'always', details: { message } };
    this.sendResponse(response);
  }

  // ---- memory and disassembly ----------------------------------------------------------------

  protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments): Promise<void> {
    try {
      const start = (parseAddress(args.memoryReference) + (args.offset ?? 0)) >>> 0;
      const count = Math.min(args.count, 1 << 20);
      const first = start & ~3;
      const nWords = Math.ceil((start - first + count) / 4);
      const res = await this.bridge!.call<MemoryWords>('readMemory', { address: first, words: nWords });
      const bytes = Buffer.alloc(nWords * 4);
      let readable = count;
      res.words.forEach((w, i) => {
        if (w === null) return;
        bytes.writeUInt32LE(w >>> 0, i * 4);
      });
      if (res.words.some((w) => w === null)) {
        // report the unmapped tail as unreadable
        let valid = 0;
        for (const w of res.words) {
          if (w === null) break;
          valid += 4;
        }
        readable = Math.max(0, Math.min(count, valid - (start - first)));
      }
      const data = bytes.subarray(start - first, start - first + readable);
      response.body = { address: hex32(start), data: data.toString('base64'), unreadableBytes: count - readable };
      this.sendResponse(response);
    } catch (e) {
      this.sendErrorResponse(response, { id: 1005, format: (e as Error).message });
    }
  }

  protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments): Promise<void> {
    try {
      const start = (parseAddress(args.memoryReference) + (args.offset ?? 0)) >>> 0;
      const data = Buffer.from(args.data, 'base64');
      for (let i = 0; i < data.length; i++) {
        await this.bridge!.call('writeMemory', { address: start + i, value: data[i], size: 1 });
      }
      response.body = { bytesWritten: data.length };
      this.sendResponse(response);
      this.hub.setState('stopped', this.pc);
    } catch (e) {
      this.sendErrorResponse(response, { id: 1006, format: (e as Error).message, showUser: true });
    }
  }

  protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments): void {
    const base = (parseAddress(args.memoryReference) + (args.offset ?? 0)) >>> 0;
    const rows = this.rowsSorted;
    let idx = rows.findIndex((r) => r.address >= base);
    if (idx < 0) idx = rows.length;
    // Walk back/forward by instruction index when the address is inside the text segment.
    const startIndex = idx + (args.instructionOffset ?? 0);
    const out: DebugProtocol.DisassembledInstruction[] = [];
    for (let i = 0; i < args.instructionCount; i++) {
      const row = rows[startIndex + i];
      if (!row) {
        const approx = startIndex + i < 0 ? base + (startIndex + i) * 4 : (rows.length ? rows[rows.length - 1].address + 4 * (startIndex + i - rows.length + 1) : base);
        out.push({ address: hex32(approx >>> 0), instruction: '??', presentationHint: 'invalid' });
        continue;
      }
      const label = this.textLabels.find((l) => l.address === row.address);
      const item: DebugProtocol.DisassembledInstruction = {
        address: hex32(row.address),
        instructionBytes: littleEndianBytes(row.code),
        instruction: row.basic,
      };
      if (label) item.symbol = label.name;
      if (args.resolveSymbols !== false && row.file) {
        item.location = new Source(path.basename(row.file), row.file);
        item.line = row.line;
      }
      out.push(item);
    }
    response.body = { instructions: out };
    this.sendResponse(response);
  }
}

function parseAddress(ref: string): number {
  const t = ref.trim();
  const n = /^0[xX]/.test(t) ? Number.parseInt(t.slice(2), 16) : Number.parseInt(t, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid address "${ref}".`);
  return n >>> 0;
}

function littleEndianBytes(code: number): string {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(code >>> 0, 0);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
}

function floatBits(value: number, single: boolean): bigint {
  const buf = Buffer.alloc(8);
  if (single) {
    buf.writeFloatLE(value, 0);
    return BigInt(buf.readUInt32LE(0));
  }
  buf.writeDoubleLE(value, 0);
  return buf.readBigUInt64LE(0);
}

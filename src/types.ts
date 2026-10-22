// Shapes of the data exchanged with the Java bridge (see java/RarsBridge.java).

export interface TextRow {
  address: number;
  code: number;
  basic: string;
  source: string;
  line: number;
  file: string;
}

export interface LabelRow {
  name: string;
  address: number;
  type: 'text' | 'data';
  file: string;
}

export interface MemoryInfo {
  textBase: number;
  textLimit: number;
  dataBase: number;
  dataSegmentBase: number;
  externBase: number;
  heapBase: number;
  globalPointer: number;
  stackPointer: number;
  stackBase: number;
  stackLimit: number;
  userHigh: number;
  kernelBase: number;
  kernelHigh: number;
  memoryMapBase: number;
  memoryMapLimit: number;
  dataSegmentLimit: number;
}

export interface RarsDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface AssembleOptions {
  rv64: boolean;
  pseudo: boolean;
  startAtMain: boolean;
  selfModifyingCode: boolean;
  warningsAreErrors: boolean;
  memoryConfig: string;
  reverse: boolean;
  programArguments: string[];
}

export interface AssembleResult {
  ok: boolean;
  diagnostics: RarsDiagnostic[];
  startPc?: number;
  text?: TextRow[];
  labels?: LabelRow[];
  memory?: MemoryInfo;
}

/** Everything the UI needs to know about the program that is loaded in the simulator. */
export interface ProgramInfo {
  files: string[];
  startPc: number;
  rv64: boolean;
  text: TextRow[];
  labels: LabelRow[];
  memory: MemoryInfo;
}

export interface RegisterRow {
  name: string;
  number: number;
  /** signed decimal string (64-bit safe) */
  value: string;
  f32?: string;
  f64?: string;
}

export type RegisterBank = 'int' | 'fp' | 'csr';

export interface RegistersResult {
  registers: RegisterRow[];
  pc: number;
  rv64: boolean;
}

export interface MemoryWords {
  address: number;
  /** unsigned 32-bit words, null where the address is not mapped */
  words: Array<number | null>;
}

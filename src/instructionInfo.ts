// Instruction / syscall metadata read from the RARS jar itself (InstructionSet + SyscallLoader).
import { describeForm, FormShape } from './operands';

export interface InstructionForm {
  /** The example RARS gives for this form, e.g. "addi t1,t2,-100". */
  example: string;
  description: string;
  pseudo: boolean;
  /** What the form is made of, e.g. "addi rd, rs1, imm". */
  shape: FormShape;
}

export interface SyscallInfo {
  name: string;
  number: number;
  description: string;
  inputs: string;
  outputs: string;
}

export class InstructionInfo {
  readonly forms = new Map<string, InstructionForm[]>();
  syscalls: SyscallInfo[] = [];
  loaded = false;

  set(instructions: Array<{ name: string; example: string; description: string; pseudo: boolean }>, syscalls: SyscallInfo[]): void {
    this.forms.clear();
    for (const i of instructions) {
      const example = i.example.trim().replace(/\s+/g, ' ');
      const list = this.forms.get(i.name) ?? [];
      list.push({ example, description: i.description.trim(), pseudo: i.pseudo, shape: describeForm(i.name, example) });
      this.forms.set(i.name, list);
    }
    for (const list of this.forms.values()) list.sort((a, b) => Number(a.pseudo) - Number(b.pseudo));
    this.syscalls = syscalls.slice().sort((a, b) => a.number - b.number);
    this.loaded = true;
  }

  has(name: string): boolean {
    return this.forms.has(name);
  }
}

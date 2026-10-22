// Explains what an instruction is made of ("addi rd, rs1, imm") from the example format that the RARS jar
// reports for it ("addi t1,t2,-100"). Only the *shape* of the instruction is described, never a solution.

export type OperandKind = 'reg' | 'freg' | 'imm' | 'label' | 'mem' | 'csr' | 'rm' | 'other';

export interface Operand {
  /** Placeholder name used in the pattern: rd, rs1, imm, label, imm(rs1) ... */
  role: string;
  kind: OperandKind;
  /** The operand exactly as RARS writes it in its example (t1, -100, label, -100(t2) ...). */
  example: string;
  /** For memory operands: the register inside the parentheses (its role is always rs1). */
  baseRole?: string;
  baseExample?: string;
}

export interface FormShape {
  name: string;
  operands: Operand[];
  /** e.g. "addi rd, rs1, imm" */
  pattern: string;
}

const STORES = new Set(['sb', 'sh', 'sw', 'sd', 'fsw', 'fsd']);
const BRANCH2 = new Set(['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu', 'bgt', 'ble', 'bgtu', 'bleu']);
const BRANCH1 = new Set(['beqz', 'bnez', 'blez', 'bgez', 'bltz', 'bgtz']);
const CSR_SOURCE_ONLY = new Set(['csrw', 'csrs', 'csrc']);

const INT_REG = /^(zero|ra|sp|gp|tp|fp|[tsa]\d+|x\d+)$/;
const FP_REG = /^f(?:[tsa])?\d+$/;
const NUMBER = /^[-+]?(0[xX][0-9a-fA-F]+|\d+)$/;

/** Splits "a, b(c), d" at top-level commas. */
function splitOperands(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function describeForm(name: string, example: string): FormShape {
  const raw = splitOperands(example.trim().slice(name.length));

  // 1. classify each operand by its syntax
  type Raw = { text: string; kind: OperandKind; offset?: string; base?: string };
  const classified: Raw[] = raw.map((text) => {
    const mem = /^(.*)\(\s*([A-Za-z0-9_$]+)\s*\)$/.exec(text);
    if (mem && (INT_REG.test(mem[2]) || mem[2] === 'zero')) return { text, kind: 'mem' as const, offset: mem[1].trim(), base: mem[2] };
    if (INT_REG.test(text)) return { text, kind: 'reg' as const };
    if (FP_REG.test(text)) return { text, kind: 'freg' as const };
    if (NUMBER.test(text) || /^%(hi|lo)\(/.test(text)) return { text, kind: 'imm' as const };
    if (text === 'dyn') return { text, kind: 'rm' as const };
    if (text === 'label' || text === 'target') return { text, kind: 'label' as const };
    if (/^(fcsr|frm|fflags|[a-z]+status|[a-z]+ie|[a-z]+ip|[a-z]+epc|[a-z]+cause|[a-z]+tval|[a-z]+scratch|[a-z]+tvec|cycle|time|instret)h?$/.test(text)) return { text, kind: 'csr' as const };
    return { text, kind: 'other' as const };
  });

  // 2. give every operand a role. The first register is the destination, except for the groups listed here.
  const valueFirst = STORES.has(name); // the first register is the value to store
  // "jalr t0" and "jalr t0, -100" jump to t0 (a source); "fscsr t1" writes the register from t1 (a source).
  const jumpToRegister = name === 'jalr' && (classified.length === 1 || (classified.length === 2 && classified[1].kind === 'imm'));
  const writesCsrFromRegister = /^(fscsr|fssr|fsrm|fsflags)$/.test(name) && classified.length === 1;
  const noDest = valueFirst || BRANCH2.has(name) || BRANCH1.has(name) || CSR_SOURCE_ONLY.has(name) || name === 'jr' || jumpToRegister || writesCsrFromRegister;
  let seenFirstReg = false;
  const counters = { reg: 0, freg: 0 };
  let tempUsed = false;

  const nextSource = (fp: boolean): string => {
    const key = fp ? 'freg' : 'reg';
    counters[key]++;
    return `${fp ? 'f' : ''}rs${counters[key]}`;
  };

  const operands: Operand[] = classified.map((c, i) => {
    switch (c.kind) {
      case 'reg':
      case 'freg': {
        const fp = c.kind === 'freg';
        if (!seenFirstReg) {
          seenFirstReg = true;
          if (valueFirst) {
            counters[fp ? 'freg' : 'reg'] = 1; // rs1 is the base register, so the value is rs2
            return { role: `${fp ? 'f' : ''}rs2`, kind: c.kind, example: c.text };
          }
          if (!noDest) return { role: fp ? 'frd' : 'rd', kind: c.kind, example: c.text };
          return { role: nextSource(fp), kind: c.kind, example: c.text };
        }
        // a register after "<value>, label|imm," in the store/load pseudo forms is a scratch register
        const prev = classified[i - 1];
        if (!fp && prev && (prev.kind === 'label' || prev.kind === 'imm') && classified.length === 3 && i === 2 && !tempUsed && (STORES.has(name) || /^f?l[bhwd]u?$/.test(name))) {
          tempUsed = true;
          return { role: 'rt', kind: c.kind, example: c.text };
        }
        return { role: nextSource(fp), kind: c.kind, example: c.text };
      }
      case 'mem': {
        // the base register of a memory operand is rs1; it also advances the counter so a following register would be rs2
        counters.reg = Math.max(counters.reg, 1);
        const off = c.offset ?? '';
        const offsetRole = off === '' ? '' : /^%lo\(/.test(off) ? off.replace(/\(.*\)/, '(label)') : 'imm';
        return { role: `${offsetRole}(rs1)`, kind: 'mem', example: c.text, baseRole: 'rs1', baseExample: c.base };
      }
      case 'imm':
        return { role: /^%hi\(/.test(c.text) ? '%hi(label)' : /^%lo\(/.test(c.text) ? '%lo(label)' : 'imm', kind: 'imm', example: c.text };
      case 'label':
        return { role: 'label', kind: 'label', example: c.text };
      case 'rm':
        return { role: 'rm', kind: 'rm', example: c.text };
      case 'csr':
        return { role: 'csr', kind: 'csr', example: c.text };
      default:
        return { role: c.text, kind: 'other', example: c.text };
    }
  });

  // csrw/csrs/csrc rs1 ... and csrwi imm: "csr" comes first in the immediate forms
  const pattern = operands.length ? `${name} ${operands.map((o) => o.role).join(', ')}` : name;
  return { name, operands, pattern };
}

export const ROLE_MEANING: Record<string, string> = {
  rd: 'destination register (receives the result)',
  rs1: 'first source register',
  rs2: 'second source register',
  rs3: 'third source register',
  rt: 'temporary register the assembler uses to build the address',
  frd: 'destination floating-point register',
  frs1: 'first source floating-point register',
  frs2: 'second source floating-point register',
  frs3: 'third source floating-point register',
  imm: 'immediate: a constant number written in the instruction',
  label: 'label: a name you define in your program',
  csr: 'control and status register',
  rm: 'rounding mode (dyn, rne, rtz, ...)',
  '%hi(label)': 'upper bits of a label address',
  '%lo(label)': 'lower bits of a label address',
};

/** One line per distinct role used by this form: "rd = destination register ...". */
export function legend(shape: FormShape): Array<{ role: string; meaning: string; example: string }> {
  const out: Array<{ role: string; meaning: string; example: string }> = [];
  const add = (role: string, example: string) => {
    const key = role.replace(/\(.*$/, '') || role;
    const meaning = ROLE_MEANING[role] ?? ROLE_MEANING[key];
    if (!meaning || out.some((x) => x.role === role)) return;
    out.push({ role, meaning, example });
  };
  for (const o of shape.operands) {
    if (o.kind === 'mem') {
      const off = o.role.replace(/\(rs1\)$/, '');
      if (off) add(off.startsWith('%lo') ? '%lo(label)' : off, (/^(.*)\(/.exec(o.example)?.[1] ?? '').trim());
      add('rs1', o.baseExample ?? '');
    } else add(o.role, o.example);
  }
  return out;
}

import * as vscode from 'vscode';
import { InstructionForm, InstructionInfo, SyscallInfo } from './instructionInfo';
import { LANGUAGE_ID } from './lint';
import { FormShape, legend, ROLE_MEANING } from './operands';

// The editor help explains how an instruction is *written* and what it is *made of*. It never proposes
// values, algorithms or program skeletons: those are for the student to work out.

// ---- static knowledge: registers and directives ------------------------------------------------

interface RegDoc {
  abi: string;
  alias: string;
  role: string;
  fp: boolean;
}

const REGISTERS = new Map<string, RegDoc>();
(function buildRegisters() {
  const add = (abi: string, alias: string, role: string, fp = false) => {
    const doc = { abi, alias, role, fp };
    REGISTERS.set(abi, doc);
    REGISTERS.set(alias, doc);
  };
  const roles: Array<[string, string]> = [
    ['zero', 'Hard-wired zero'],
    ['ra', 'Return address (caller-saved)'],
    ['sp', 'Stack pointer (callee-saved)'],
    ['gp', 'Global pointer'],
    ['tp', 'Thread pointer'],
  ];
  roles.forEach(([abi, role], i) => add(abi, `x${i}`, role));
  for (let i = 0; i < 3; i++) add(`t${i}`, `x${5 + i}`, 'Temporary (caller-saved)');
  add('s0', 'x8', 'Saved register / frame pointer, also called fp (callee-saved)');
  REGISTERS.set('fp', REGISTERS.get('s0')!);
  add('s1', 'x9', 'Saved register (callee-saved)');
  for (let i = 0; i < 2; i++) add(`a${i}`, `x${10 + i}`, 'Function argument / return value (caller-saved)');
  for (let i = 2; i < 8; i++) add(`a${i}`, `x${10 + i}`, 'Function argument (caller-saved)');
  for (let i = 2; i < 12; i++) add(`s${i}`, `x${16 + i}`, 'Saved register (callee-saved)');
  for (let i = 3; i < 7; i++) add(`t${i}`, `x${25 + i}`, 'Temporary (caller-saved)');
  for (let i = 0; i < 8; i++) add(`ft${i}`, `f${i}`, 'FP temporary (caller-saved)', true);
  for (let i = 0; i < 2; i++) add(`fs${i}`, `f${8 + i}`, 'FP saved register (callee-saved)', true);
  for (let i = 0; i < 2; i++) add(`fa${i}`, `f${10 + i}`, 'FP argument / return value (caller-saved)', true);
  for (let i = 2; i < 8; i++) add(`fa${i}`, `f${10 + i}`, 'FP argument (caller-saved)', true);
  for (let i = 2; i < 12; i++) add(`fs${i}`, `f${16 + i}`, 'FP saved register (callee-saved)', true);
  for (let i = 8; i < 12; i++) add(`ft${i}`, `f${20 + i}`, 'FP temporary (caller-saved)', true);
})();

const DIRECTIVES: Record<string, string> = {
  '.text': 'Following items go to the **text** (code) segment.',
  '.data': 'Following items go to the **data** segment.',
  '.word': 'Store 32-bit values: `.word value, value, ...`.',
  '.half': 'Store 16-bit values.',
  '.byte': 'Store 8-bit values.',
  '.dword': 'Store 64-bit values.',
  '.ascii': 'Store a string **without** a terminating zero.',
  '.asciz': 'Store a string followed by a zero byte.',
  '.string': 'Same as `.asciz`.',
  '.space': 'Reserve a number of bytes (filled with zero).',
  '.float': 'Store 32-bit floating point values.',
  '.double': 'Store 64-bit floating point values.',
  '.align': 'Align the next item to a multiple of 2^n bytes.',
  '.globl': 'Make a label visible to other files.',
  '.global': 'Make a label visible to other files.',
  '.eqv': 'Define a text substitution: `.eqv NAME, expression`.',
  '.macro': 'Start a macro: `.macro name(%arg1, %arg2)` ... `.end_macro`.',
  '.end_macro': 'End of a macro definition.',
  '.include': 'Include another file: `.include "file.asm"`.',
  '.set': 'Set an assembler option.',
  '.extern': 'Declare a global symbol of a given size in the extern area.',
  '.section': 'Switch section (`.text` / `.data`).',
};

const MNEMONIC_POSITION = /^\s*(?:[A-Za-z_.$][\w.$]*:\s*)?[\w.]*$/;
const WORD = /[%.]?[A-Za-z_$][A-Za-z0-9_.$]*/;

function mnemonicOf(lineText: string): { name: string; operandsStart: number } | undefined {
  const m = /^\s*(?:[A-Za-z_.$][\w.$]*:\s*)?([a-z][\w.]*)(?=\s|$)/.exec(lineText);
  if (!m) return undefined;
  return { name: m[1], operandsStart: m[0].length };
}

/** Where the cursor is inside the operand list of an instruction. */
interface OperandContext {
  mnemonic: string;
  /** zero-based number of the operand being typed */
  index: number;
  /** inside an unclosed "(" (the base register of off(base), or the argument of %hi / %lo) */
  inParen: boolean;
  /** the unclosed "(" belongs to %hi( or %lo( */
  inReloc: boolean;
}

function operandContext(linePrefix: string): OperandContext | undefined {
  const m = mnemonicOf(linePrefix);
  if (!m) return undefined;
  const rest = linePrefix.slice(m.operandsStart);
  let depth = 0;
  let commas = 0;
  let lastOpen = -1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '(') {
      depth++;
      lastOpen = i;
    } else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) commas++;
  }
  return { mnemonic: m.name, index: commas, inParen: depth > 0, inReloc: depth > 0 && /%(hi|lo)$/.test(rest.slice(0, lastOpen)) };
}

// ---- documentation ---------------------------------------------------------------------------

/** "rd = t1, rs1 = t2, imm = -100": how the roles map onto RARS's own example. */
function mapping(shape: FormShape): string {
  return legend(shape)
    .map((l) => `${l.role} = ${l.example}`)
    .join(', ');
}

function formsMarkdown(name: string, forms: InstructionForm[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const pseudo = forms.every((f) => f.pseudo);
  md.appendMarkdown(`**${name}**${pseudo ? ' — _pseudo-instruction_' : ''}\n\n`);
  md.appendCodeblock([...new Set(forms.map((f) => f.shape.pattern))].join('\n'), LANGUAGE_ID);

  const parts = new Map<string, string>();
  for (const f of forms) for (const l of legend(f.shape)) if (!parts.has(l.role)) parts.set(l.role, l.meaning);
  if (parts.size > 0) {
    md.appendMarkdown('**Parts**\n\n');
    for (const [role, meaning] of parts) md.appendMarkdown(`- \`${role}\` — ${meaning}\n`);
    md.appendMarkdown('\n');
  }

  const seen = new Set<string>();
  for (const f of forms) {
    const map = mapping(f.shape);
    const desc = f.description && !seen.has(f.description) ? ` — ${f.description}` : '';
    seen.add(f.description);
    md.appendMarkdown(`- \`${f.example}\`${map ? ` (${map})` : ''}${desc}\n`);
  }
  return md;
}

function syscallMarkdown(list: SyscallInfo[], title: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**ecall** — ${title}\n\n`);
  md.appendMarkdown('| a7 | Service | Arguments | Result |\n|---:|---|---|---|\n');
  for (const s of list) {
    const cell = (t: string) => (t || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
    md.appendMarkdown(`| ${s.number} | ${s.name} | ${cell(s.inputs)} | ${cell(s.outputs)} |\n`);
  }
  return md;
}

/** Finds the syscall number most recently loaded into a7 above `line` (li a7, N / addi a7, zero, N). */
function syscallNumberBefore(doc: vscode.TextDocument, line: number): number | undefined {
  for (let l = line - 1; l >= Math.max(0, line - 15); l--) {
    const t = doc.lineAt(l).text.replace(/#.*$/, '');
    const m = /^\s*(?:[\w.$]+:\s*)?(?:li|addi)\s+(?:a7|x17)\s*,\s*(?:zero\s*,\s*|x0\s*,\s*)?(-?\w+)\s*$/.exec(t);
    if (m) {
      const v = Number(m[1]);
      return Number.isFinite(v) ? v : undefined;
    }
    if (/^\s*(?:[\w.$]+:\s*)?(?:mv\s+a7|lw\s+a7|add\s+a7)/.test(t)) return undefined;
  }
  return undefined;
}

function labelsOf(doc: vscode.TextDocument): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < doc.lineCount; i++) {
    const m = /^\s*([A-Za-z_.$][\w.$]*):/.exec(doc.lineAt(i).text);
    if (m && !map.has(m[1])) map.set(m[1], i);
  }
  return map;
}

// ---- providers ---------------------------------------------------------------------------------

class SparkyHover implements vscode.HoverProvider {
  constructor(private readonly info: InstructionInfo) {}

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const range = doc.getWordRangeAtPosition(pos, WORD);
    if (!range) return undefined;
    const word = doc.getText(range);
    const lineText = doc.lineAt(pos.line).text;
    const before = lineText.slice(0, range.start.character);

    if (word.startsWith('.') && DIRECTIVES[word]) {
      return new vscode.Hover(new vscode.MarkdownString(`**${word}** — directive\n\n${DIRECTIVES[word]}`), range);
    }
    if (MNEMONIC_POSITION.test(before) && this.info.has(word)) {
      const md = formsMarkdown(word, this.info.forms.get(word)!);
      if (word === 'ecall') {
        const n = syscallNumberBefore(doc, pos.line);
        const hit = n !== undefined ? this.info.syscalls.filter((s) => s.number === n) : [];
        const sys = hit.length ? syscallMarkdown(hit, `service ${n} (value found in a7)`) : syscallMarkdown(this.commonSyscalls(), 'common services (value of a7)');
        md.appendMarkdown('\n---\n\n');
        md.appendMarkdown(sys.value);
      }
      return new vscode.Hover(md, range);
    }
    const reg = REGISTERS.get(word);
    if (reg) {
      return new vscode.Hover(new vscode.MarkdownString(`**${reg.abi}** (${reg.alias}) — ${reg.role}`), range);
    }
    const labels = labelsOf(doc);
    const defLine = labels.get(word);
    if (defLine !== undefined) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${word}** — label defined on line ${defLine + 1}\n\n`);
      md.appendCodeblock(doc.lineAt(defLine).text.trim(), LANGUAGE_ID);
      return new vscode.Hover(md, range);
    }
    return undefined;
  }

  private commonSyscalls(): SyscallInfo[] {
    const common = new Set([1, 4, 5, 8, 9, 10, 11, 12, 17, 93]);
    return this.info.syscalls.filter((s) => common.has(s.number));
  }
}

/** Inserts the *shape* of the instruction: every operand is a named placeholder (rd, rs1, imm...), never a value. */
function snippetFor(shape: FormShape): vscode.SnippetString {
  if (!shape.operands.length) return new vscode.SnippetString(shape.name);
  let n = 1;
  const ph = (text: string) => `\${${n++}:${text}}`;
  const parts = shape.operands.map((o) => {
    if (o.kind === 'mem') {
      const off = /^(.*)\(rs1\)$/.exec(o.role)![1];
      const offset = off === '' ? '' : off.startsWith('%lo') ? `%lo(${ph('label')})` : ph('imm');
      return `${offset}(${ph('rs1')})`;
    }
    if (o.role === '%hi(label)') return `%hi(${ph('label')})`;
    if (o.role === '%lo(label)') return `%lo(${ph('label')})`;
    return ph(o.role);
  });
  return new vscode.SnippetString(`${shape.name} ${parts.join(', ')}`);
}

class SparkyCompletion implements vscode.CompletionItemProvider {
  constructor(private readonly info: InstructionInfo) {}

  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] {
    const prefix = doc.lineAt(pos.line).text.slice(0, pos.character);
    if (/#/.test(prefix)) return [];
    if (MNEMONIC_POSITION.test(prefix)) return this.mnemonics(prefix);

    // After a directive (".word ...") only label names make sense.
    const afterLabel = prefix.replace(/^\s*(?:[A-Za-z_.$][\w.$]*:\s*)?/, '');
    if (afterLabel.startsWith('.')) return this.labelItems(doc);

    // After a mnemonic: offer only what the operand being typed can be.
    const ctx = operandContext(prefix);
    const forms = ctx ? this.info.forms.get(ctx.mnemonic) : undefined;
    if (!ctx || !forms) return [];
    const need = new Set<'reg' | 'freg' | 'label'>();
    for (const f of forms) {
      const slot = f.shape.operands[ctx.index];
      if (!slot) continue;
      if (ctx.inReloc) need.add('label');
      else if (ctx.inParen) {
        if (slot.kind === 'mem') need.add('reg');
      } else if (slot.kind === 'reg') need.add('reg');
      else if (slot.kind === 'freg') need.add('freg');
      else if (slot.kind === 'label') need.add('label');
    }
    const items: vscode.CompletionItem[] = [];
    if (need.has('reg')) items.push(...this.registerItems(false));
    if (need.has('freg')) items.push(...this.registerItems(true));
    if (need.has('label')) items.push(...this.labelItems(doc));
    return items;
  }

  private mnemonics(prefix: string): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const typed = /[\w.]*$/.exec(prefix)![0];
    if (typed.startsWith('.') || prefix.trim() === '') {
      for (const [d, text] of Object.entries(DIRECTIVES)) {
        const it = new vscode.CompletionItem(d, vscode.CompletionItemKind.Keyword);
        it.documentation = new vscode.MarkdownString(text);
        it.detail = 'directive';
        items.push(it);
      }
    }
    for (const [name, forms] of this.info.forms) {
      const it = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
      it.detail = forms[0].shape.pattern + (forms.every((f) => f.pseudo) ? '   (pseudo-instruction)' : '');
      it.documentation = formsMarkdown(name, forms);
      it.insertText = snippetFor(forms[0].shape);
      items.push(it);
    }
    return items;
  }

  private registerItems(fp: boolean): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();
    for (const [name, r] of REGISTERS) {
      if (r.fp !== fp || seen.has(name)) continue;
      seen.add(name);
      const it = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
      it.detail = `${r.abi} / ${r.alias}`;
      it.documentation = r.role;
      it.sortText = (name === r.abi ? '1' : '2') + name.padStart(4, ' ');
      items.push(it);
    }
    return items;
  }

  private labelItems(doc: vscode.TextDocument): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    for (const [label, line] of labelsOf(doc)) {
      const it = new vscode.CompletionItem(label, vscode.CompletionItemKind.Reference);
      it.detail = `label (line ${line + 1})`;
      items.push(it);
    }
    return items;
  }
}

class SparkySignature implements vscode.SignatureHelpProvider {
  constructor(private readonly info: InstructionInfo) {}

  provideSignatureHelp(doc: vscode.TextDocument, pos: vscode.Position): vscode.SignatureHelp | undefined {
    const code = doc.lineAt(pos.line).text.replace(/#.*$/, '');
    const ctx = operandContext(code.slice(0, pos.character));
    const m = mnemonicOf(code);
    if (!ctx || !m || pos.character < m.operandsStart) return undefined;
    const forms = this.info.forms.get(m.name);
    if (!forms) return undefined;

    const help = new vscode.SignatureHelp();
    help.signatures = forms.map((f) => {
      const label = f.shape.pattern;
      const doc = new vscode.MarkdownString();
      if (f.pseudo) doc.appendMarkdown('_pseudo-instruction_\n\n');
      const map = mapping(f.shape);
      doc.appendMarkdown(`Example: \`${f.example}\`${map ? ` (${map})` : ''}`);
      if (f.description) doc.appendMarkdown(`\n\n${f.description}`);
      const sig = new vscode.SignatureInformation(label, doc);
      let start = f.shape.name.length + 1;
      sig.parameters = f.shape.operands.map((o) => {
        const range: [number, number] = [start, start + o.role.length];
        start += o.role.length + 2;
        const key = o.kind === 'mem' ? 'rs1' : o.role;
        return new vscode.ParameterInformation(range, ROLE_MEANING[key] ?? ROLE_MEANING[key.replace(/\(.*$/, '')]);
      });
      return sig;
    });
    const fit = help.signatures.findIndex((s) => (s.parameters?.length ?? 0) > ctx.index);
    help.activeSignature = fit >= 0 ? fit : 0;
    help.activeParameter = ctx.index;
    return help;
  }
}

export function registerLanguageFeatures(info: InstructionInfo): vscode.Disposable[] {
  const sel: vscode.DocumentSelector = { language: LANGUAGE_ID };
  return [
    vscode.languages.registerHoverProvider(sel, new SparkyHover(info)),
    vscode.languages.registerCompletionItemProvider(sel, new SparkyCompletion(info), '.', '%', ',', ' ', '('),
    vscode.languages.registerSignatureHelpProvider(sel, new SparkySignature(info), { triggerCharacters: [' ', ','], retriggerCharacters: [','] }),
  ];
}

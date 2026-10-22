// Checks the operand analysis (src/operands.ts) against every instruction form the RARS jar reports.
import * as path from 'path';
import { Bridge } from '../src/bridge';
import { describeForm, legend } from '../src/operands';

const root = path.resolve(__dirname, '..', '..');
const verbose = process.argv.includes('--list');

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};

async function main() {
  const bridge = new Bridge({ extensionPath: root });
  await bridge.whenReady();
  const forms = new Map<string, { name: string; example: string }>();
  for (const rv64 of [false, true]) {
    await bridge.call('lint', { text: '', options: { rv64 } });
    const res = await bridge.call<{ instructions: Array<{ name: string; example: string }> }>('instructions');
    for (const i of res.instructions) forms.set(`${i.name}|${i.example.trim()}`, i);
  }
  bridge.dispose();

  const patterns = new Map<string, string>(); // "name|example" -> pattern
  const problems: string[] = [];
  for (const [key, i] of forms) {
    const shape = describeForm(i.name, i.example);
    patterns.set(key, shape.pattern);
    const roles = shape.operands.map((o) => o.role);
    const regRoles = shape.operands.flatMap((o) => (o.kind === 'mem' ? [o.baseRole!] : o.kind === 'reg' || o.kind === 'freg' ? [o.role] : []));
    if (shape.operands.some((o) => o.kind === 'other')) problems.push(`unclassified operand in "${i.example}" -> ${shape.pattern}`);
    if (new Set(regRoles).size !== regRoles.length) problems.push(`repeated role in "${i.example}" -> ${shape.pattern}`);
    if (roles.filter((r) => r === 'rd' || r === 'frd').length > 1) problems.push(`two destinations in "${i.example}" -> ${shape.pattern}`);
    // the legend must explain every role that appears
    const explained = new Set(legend(shape).map((l) => l.role));
    for (const o of shape.operands) {
      const need = o.kind === 'mem' ? [o.role.replace(/\(rs1\)$/, '').replace(/^$/, 'rs1')] : [o.role];
      for (const r of need) if (!explained.has(r) && o.kind !== 'mem' && o.kind !== 'other') problems.push(`no legend for ${r} in ${shape.pattern}`);
    }
  }
  if (verbose) for (const [k, p] of [...patterns].sort()) console.log(`${k.split('|')[1].padEnd(34)} => ${p}`);

  check(`analysed ${forms.size} instruction forms from the jar`, forms.size > 300);
  check('no unclassified operands, repeated roles, double destinations or missing legend entries', problems.length === 0, problems.slice(0, 6).join(' ; '));

  const expect: Record<string, string> = {
    'add t1,t2,t3': 'add rd, rs1, rs2',
    'addi t1,t2,-100': 'addi rd, rs1, imm',
    'lw t1, -100(t2)': 'lw rd, imm(rs1)',
    'lw t1,(t2)': 'lw rd, (rs1)',
    'lw t1,label': 'lw rd, label',
    'lw t1,%lo(label)(t2)': 'lw rd, %lo(label)(rs1)',
    'sw t1, -100(t2)': 'sw rs2, imm(rs1)',
    'sw t1,label,t2': 'sw rs2, label, rt',
    'beq t1,t2,label': 'beq rs1, rs2, label',
    'beqz t1,label': 'beqz rs1, label',
    'jal t1, target': 'jal rd, label',
    'jal label': 'jal label',
    'jalr t1, t2, -100': 'jalr rd, rs1, imm',
    'jalr t0,-100(t1)': 'jalr rd, imm(rs1)',
    'jalr t0, -100': 'jalr rs1, imm',
    'jalr t0': 'jalr rs1',
    'jr t0': 'jr rs1',
    'jr t0, -100': 'jr rs1, imm',
    'fscsr t1, t2': 'fscsr rd, rs1',
    'fscsr t1': 'fscsr rs1',
    'frcsr t1': 'frcsr rd',
    'csrr t1, fcsr': 'csrr rd, csr',
    'sb t1,label,t2': 'sb rs2, label, rt',
    'flw f1,label, t3': 'flw frd, label, rt',
    'fsd f1,label, t3': 'fsd frs2, label, rt',
    'lui t1,100000': 'lui rd, imm',
    'li t1,-100': 'li rd, imm',
    'la t1,label': 'la rd, label',
    'mv t1,t2': 'mv rd, rs1',
    'csrrw t0, fcsr, t1': 'csrrw rd, csr, rs1',
    'csrrwi t0, fcsr, 10': 'csrrwi rd, csr, imm',
    'csrw t1, fcsr': 'csrw rs1, csr',
    'csrwi fcsr, 100': 'csrwi csr, imm',
    'fadd.s f1, f2, f3, dyn': 'fadd.s frd, frs1, frs2, rm',
    'fmadd.s f1, f2, f3, f4': 'fmadd.s frd, frs1, frs2, frs3',
    'fsw f1, -100(t1)': 'fsw frs2, imm(rs1)',
    'flw f1, -100(t1)': 'flw frd, imm(rs1)',
    'fcvt.s.w f1, t1': 'fcvt.s.w frd, rs1',
    'fmv.x.s t1, f1': 'fmv.x.s rd, frs1',
    'feq.s t1, f1, f2': 'feq.s rd, frs1, frs2',
    'ecall': 'ecall',
  };
  const byExample = new Map<string, string>();
  for (const [key, p] of patterns) byExample.set(key.split('|')[1].replace(/\s+/g, ' ').trim(), p);
  const wrong: string[] = [];
  for (const [example, want] of Object.entries(expect)) {
    const got = byExample.get(example);
    if (got !== want) wrong.push(`"${example}": expected "${want}" but got "${got}"`);
  }
  check(`${Object.keys(expect).length} well-known instruction patterns are exactly right`, wrong.length === 0, wrong.join(' ; '));
}

main()
  .catch((e) => {
    console.log('ERROR', e);
    failures++;
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    setTimeout(() => process.exit(failures ? 1 : 0), 100);
  });

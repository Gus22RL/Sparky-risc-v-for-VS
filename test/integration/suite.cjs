// Runs INSIDE a real VS Code (Extension Development Host). Written in CommonJS so it needs no build step.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const lines = [];
let failures = 0;
const log = (s) => {
  lines.push(s);
  console.log(s);
};
const check = (name, cond, extra = '') => {
  log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not ready */
    }
    await sleep(100);
  }
  log(`   (timeout waiting for: ${label})`);
  return undefined;
}

exports.run = async function run() {
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const goodPath = path.join(ws, 'good.asm');
  const badPath = path.join(ws, 'bad.asm');
  try {
    const ext = vscode.extensions.getExtension('sparky.sparky-riscv');
    check('extension is available', !!ext);
    await ext.activate();
    check('extension activates', ext.isActive);

    const commands = await vscode.commands.getCommands(true);
    check('commands are registered', ['sparky.run', 'sparky.debug', 'sparky.restartLint', 'sparky.showIO'].every((c) => commands.includes(c)));
    check('view focus commands exist (views and containers are declared)', ['sparky.registers', 'sparky.textSegment', 'sparky.dataSegment', 'sparky.labels'].every((v) => commands.includes(`${v}.focus`)));

    // ---- language + lint ----
    const bad = await vscode.workspace.openTextDocument(vscode.Uri.file(badPath));
    check('.asm files use the Sparky RISC-V language', bad.languageId === 'sparky-riscv', bad.languageId);
    await vscode.window.showTextDocument(bad);
    const diags = await until(() => {
      const d = vscode.languages.getDiagnostics(bad.uri);
      return d.length >= 2 ? d : undefined;
    }, 'diagnostics for bad.asm');
    check('real-time errors from the RARS assembler', !!diags && diags.some((d) => d.range.start.line === 1 && d.source === 'RARS' && d.severity === vscode.DiagnosticSeverity.Error), diags ? diags.map((d) => `${d.range.start.line + 1}:${d.message.slice(0, 40)}`).join(' | ') : 'none');

    const good = await vscode.workspace.openTextDocument(vscode.Uri.file(goodPath));
    await vscode.window.showTextDocument(good);
    await sleep(2500);
    check('a valid program has no diagnostics', vscode.languages.getDiagnostics(good.uri).length === 0);

    // A brand-new file on Windows has CRLF line endings; the checker must not flag ".text" or blank lines.
    const crlfPath = path.join(ws, 'crlf.asm');
    fs.writeFileSync(crlfPath, '.text\r\n\r\n addi t0, zero, 5\r\n\r\n li a7, 10\r\n ecall\r\n');
    const crlf = await vscode.workspace.openTextDocument(vscode.Uri.file(crlfPath));
    await vscode.window.showTextDocument(crlf);
    check('the test file really uses CRLF', crlf.eol === vscode.EndOfLine.CRLF);
    await sleep(2500);
    check('CRLF file (.text and blank lines) has no diagnostics', vscode.languages.getDiagnostics(crlf.uri).length === 0, JSON.stringify(vscode.languages.getDiagnostics(crlf.uri).map((d) => d.message.slice(0, 40))));
    await vscode.window.showTextDocument(good);

    // ---- editor intelligence ----
    const hovers = await until(async () => {
      const h = await vscode.commands.executeCommand('vscode.executeHoverProvider', good.uri, new vscode.Position(9, 2)); // "addi" on line 10
      return h && h.length ? h : undefined;
    }, 'hover');
    const hoverText = hovers ? hovers.map((h) => h.contents.map((c) => c.value ?? String(c)).join('\n')).join('\n') : '';
    check('hover explains the instruction (from the jar)', /addi/.test(hoverText) && /Addition|immediate/i.test(hoverText), hoverText.slice(0, 80).replace(/\n/g, ' '));

    const ecallDoc = await vscode.workspace.openTextDocument({ language: 'sparky-riscv', content: '.text\n li a7, 1\n ecall\n' });
    const ecallHover = await vscode.commands.executeCommand('vscode.executeHoverProvider', ecallDoc.uri, new vscode.Position(2, 3));
    const ecallText = ecallHover ? ecallHover.map((h) => h.contents.map((c) => c.value ?? String(c)).join('\n')).join('\n') : '';
    check('hover on ecall shows the service selected by a7 (PrintInt)', /PrintInt/i.test(ecallText) && /\| 1 \|/.test(ecallText), ecallText.slice(-120).replace(/\n/g, ' '));

    check('hover shows how the instruction is written and what each part is', /addi rd, rs1, imm/.test(hoverText) && /destination register/.test(hoverText) && /first source register/.test(hoverText) && /\bimm\b.*constant/.test(hoverText), hoverText.slice(0, 160).replace(/\n/g, ' '));

    const labelOf = (i) => (typeof i.label === 'string' ? i.label : i.label.label);
    const textOf = (i) => (typeof i.insertText === 'string' ? i.insertText : i.insertText ? i.insertText.value : labelOf(i));
    const complete = async (content, line, character) => {
      const doc = await vscode.workspace.openTextDocument({ language: 'sparky-riscv', content });
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(line, character));
      return list ? list.items : [];
    };
    const names = (items) => items.map(labelOf);

    // 1. at the start of a line: instructions and directives, inserted as a *shape* (placeholders), never values
    const atStart = await until(async () => {
      const items = await complete('.text\n', 1, 0);
      return items.length > 100 ? items : undefined;
    }, 'mnemonic completion');
    const addi = atStart && atStart.find((i) => labelOf(i) === 'addi');
    check('completion offers instructions and directives', !!atStart && names(atStart).includes('jal') && names(atStart).includes('.word') && !!addi, atStart ? `${atStart.length} items` : 'none');
    check('an instruction is inserted as its shape: addi rd, rs1, imm (placeholders, no values)', !!addi && addi.detail.startsWith('addi rd, rs1, imm') && textOf(addi) === 'addi ${1:rd}, ${2:rs1}, ${3:imm}', addi ? `${addi.detail} / ${textOf(addi)}` : '');
    const sw = atStart && atStart.find((i) => labelOf(i) === 'sw');
    const beq = atStart && atStart.find((i) => labelOf(i) === 'beq');
    check('stores and branches show their own shape (sw rs2, imm(rs1) / beq rs1, rs2, label)', !!sw && !!beq && textOf(sw) === 'sw ${1:rs2}, ${2:imm}(${3:rs1})' && textOf(beq) === 'beq ${1:rs1}, ${2:rs2}, ${3:label}', sw && beq ? `${textOf(sw)} / ${textOf(beq)}` : '');

    // 2. nothing that writes code for the student: no snippets, no multi-line insertions, no algorithm skeletons
    const multiLine = (atStart || []).filter((i) => /\n/.test(textOf(i)));
    const skeletons = (atStart || []).filter((i) => ['program', 'ifelse', 'for', 'while', 'func', 'printint', 'printstr', 'readint', 'exit', 'hanoi'].includes(labelOf(i)));
    const snippetKind = (atStart || []).filter((i) => i.kind === vscode.CompletionItemKind.Snippet);
    check('no code skeletons, snippets or multi-line suggestions', multiLine.length === 0 && skeletons.length === 0 && snippetKind.length === 0, `multiLine=${multiLine.length} skeletons=${skeletons.length} snippets=${snippetKind.length}`);

    // 3. inside an instruction only what fits the operand being typed
    const doc3 = '.text\nloop: addi t0, t0, 1\n';
    const second = names(await complete(`${doc3} addi t0, `, 2, 10));
    check('2nd operand of addi: registers only (no labels, no values)', second.includes('t1') && second.includes('a0') && !second.includes('loop') && !second.includes('ft0'));
    const third = await complete(`${doc3} addi t0, t1, `, 2, 14);
    check('3rd operand of addi is an immediate: nothing is suggested', third.length === 0, `${third.length} items`);
    const branch = names(await complete(`${doc3} beq t0, t1, `, 2, 14));
    check('last operand of beq: your labels only', branch.includes('loop') && !branch.includes('t0'), branch.join(','));
    const base = names(await complete(`${doc3} lw t0, 0(`, 2, 11));
    check('inside off( ) of lw: base registers', base.includes('sp') && base.includes('t2') && !base.includes('loop'));
    const fp = names(await complete(`${doc3} flw `, 2, 5));
    check('flw destination: floating-point registers only', fp.includes('ft0') && fp.includes('fa0') && !fp.includes('t0'), fp.slice(0, 4).join(','));
    check('after a directive only labels are offered', JSON.stringify(names(await complete(`${doc3}.data\n.word `, 3, 6))) === JSON.stringify(['loop']));
    check('nothing is suggested inside comments', (await complete('.text\n addi t0, t0, 1 # lo', 1, 24)).length === 0);

    // 4. VS Code's own prediction features are switched off for this language
    const ed = vscode.workspace.getConfiguration('editor', { languageId: 'sparky-riscv' });
    check('inline (ghost text) suggestions are off for this language', ed.get('inlineSuggest.enabled') === false);
    check('word-based suggestions are off for this language', ed.get('wordBasedSuggestions') === 'off');

    const sigDoc = await vscode.workspace.openTextDocument({ language: 'sparky-riscv', content: '.text\n addi t0, ' });
    const sig = await until(async () => {
      const s = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', sigDoc.uri, new vscode.Position(1, 10), ',');
      return s && s.signatures.length ? s : undefined;
    }, 'signature help');
    const active = sig && sig.signatures[0].parameters[sig.activeParameter];
    const activeDoc = active ? (typeof active.documentation === 'string' ? active.documentation : active.documentation && active.documentation.value) : '';
    check('signature help shows addi rd, rs1, imm and explains the operand being typed', !!sig && sig.signatures[0].label === 'addi rd, rs1, imm' && sig.activeParameter === 1 && /first source register/.test(activeDoc), sig ? `${sig.signatures[0].label} param=${sig.activeParameter} "${activeDoc}"` : 'none');

    // ---- debugger ----
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(good.uri, new vscode.Position(35, 0)))]); // line 36
    const started = await vscode.debug.startDebugging(undefined, { type: 'sparky', request: 'launch', name: 'Sparky test', program: goodPath, stopOnEntry: true });
    check('debug session starts', started === true);
    const session = vscode.debug.activeDebugSession;
    check('active session is a Sparky session', !!session && session.type === 'sparky');
    const top = async () => (await session.customRequest('stackTrace', { threadId: 1 })).stackFrames[0];
    const entry = await until(async () => {
      const f = await top();
      return f && f.line === 10 ? f : undefined;
    }, 'stop on entry');
    check('stops on entry at the first instruction (line 10)', !!entry, entry ? `${entry.name} line ${entry.line}` : '');

    await session.customRequest('continue', { threadId: 1 });
    const hit = await until(async () => {
      const f = await top();
      return f && f.line === 36 ? f : undefined;
    }, 'breakpoint hit');
    check('editor breakpoint is hit (line 36)', !!hit);
    const vars = (await session.customRequest('variables', { variablesReference: 1 })).variables;
    const a1 = vars.find((v) => v.name.startsWith('a1'));
    check('Variables panel shows registers (a1 = 4)', !!a1 && a1.value.startsWith('0x00000004'), a1 ? a1.value : '');

    // Every panel must really render inside a real webview (CSP, scripts, messages) with the expected number of rows.
    const expectedRows = { 'sparky.registers': 33, 'sparky.textSegment': 21, 'sparky.dataSegment': 16, 'sparky.labels': 4 };
    for (const [v, rows] of Object.entries(expectedRows)) {
      await vscode.commands.executeCommand(`${v}.focus`);
      const ok = await until(() => (ext.exports.viewHealth()[v].renderedRows === rows ? true : undefined), `${v} rendered`, 15000);
      const h = ext.exports.viewHealth()[v];
      check(`panel ${v} renders in a real webview (${rows} rows) with no script errors`, !!ok && h.errors.length === 0, JSON.stringify(h));
    }
    await sleep(500);

    await session.customRequest('stepBack', { threadId: 1 });
    await sleep(500);

    const ended = new Promise((resolve) => {
      const d = vscode.debug.onDidTerminateDebugSession((s) => {
        if (s === session) {
          d.dispose();
          resolve(true);
        }
      });
    });
    await vscode.debug.stopDebugging(session);
    check('session terminates', await Promise.race([ended, sleep(10000).then(() => false)]));
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);

    // ---- run without debugging (uses the I/O terminal) ----
    await vscode.window.showTextDocument(good);
    const runEnded = new Promise((resolve) => {
      const d = vscode.debug.onDidTerminateDebugSession((s) => {
        if (s.type === 'sparky') {
          d.dispose();
          resolve(true);
        }
      });
    });
    await vscode.commands.executeCommand('sparky.run');
    check('"Run Current File" finishes the program', await Promise.race([runEnded, sleep(20000).then(() => false)]));
    check('the Sparky I/O terminal exists', vscode.window.terminals.some((t) => t.name === 'Sparky I/O'));
  } catch (e) {
    log(`ERROR ${e && e.stack ? e.stack : e}`);
    failures++;
  } finally {
    log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    try {
      fs.writeFileSync(path.join(ws, '..', 'results.txt'), lines.join('\n'));
    } catch {
      /* ignore */
    }
  }
  if (failures) throw new Error(`${failures} integration check(s) failed`);
};

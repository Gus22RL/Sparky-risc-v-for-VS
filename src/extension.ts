import * as vscode from 'vscode';
import { cfg } from './config';
import { SparkyDebugSession } from './debugSession';
import { DataSegmentView } from './views/dataSegmentView';
import { LabelsView } from './views/labelsView';
import { RegistersView } from './views/registersView';
import { TextSegmentView } from './views/textSegmentView';
import { SparkyHub } from './hub';
import { ProgramIO } from './ioTerminal';
import { registerLanguageFeatures } from './language';
import { LANGUAGE_ID, LintService } from './lint';

export function activate(ctx: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Sparky RISC-V');
  const hub = new SparkyHub();
  const io = new ProgramIO();
  const lint = new LintService(ctx, log);
  ctx.subscriptions.push(log, hub, io, lint, ...registerLanguageFeatures(lint.info));

  const views = [
    new RegistersView(ctx, hub),
    new TextSegmentView(ctx, hub),
    new DataSegmentView(ctx, hub),
    new LabelsView(ctx, hub),
  ];
  const viewIds = [RegistersView.viewId, TextSegmentView.viewId, DataSegmentView.viewId, LabelsView.viewId];
  views.forEach((view, i) => {
    ctx.subscriptions.push(
      view,
      vscode.window.registerWebviewViewProvider(viewIds[i], view, { webviewOptions: { retainContextWhenHidden: true } }),
    );
  });

  // Show the RARS-style panels when a Sparky debug session starts, then give the focus back to the editor.
  ctx.subscriptions.push(
    vscode.debug.onDidStartDebugSession(async (session) => {
      if (session.type !== 'sparky' || !cfg().get<boolean>('showViewsOnDebug', true)) return;
      await vscode.commands.executeCommand(`${TextSegmentView.viewId}.focus`);
      await vscode.commands.executeCommand(`${RegistersView.viewId}.focus`);
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }),
  );

  ctx.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('sparky', {
      createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new SparkyDebugSession(ctx, hub, io, lint.diagnostics, log)),
    }),
    vscode.debug.registerDebugConfigurationProvider('sparky', {
      resolveDebugConfiguration(_folder, config) {
        if (!config.type && !config.request && !config.name) {
          const editor = vscode.window.activeTextEditor;
          if (editor && editor.document.languageId === LANGUAGE_ID) {
            config.type = 'sparky';
            config.request = 'launch';
            config.name = 'Sparky: Debug current file';
            config.program = '${file}';
            config.stopOnEntry = true;
          }
        }
        if (!config.program) {
          void vscode.window.showInformationMessage('Open a RISC-V assembly file (.asm / .s) to run or debug it.');
          return null;
        }
        return config;
      },
    }),
  );

  const launch = async (debug: boolean) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== LANGUAGE_ID) {
      void vscode.window.showInformationMessage('Open a RISC-V assembly file (.asm / .s) to run or debug it.');
      return;
    }
    if (editor.document.isDirty) await editor.document.save();
    await vscode.debug.startDebugging(
      vscode.workspace.getWorkspaceFolder(editor.document.uri),
      {
        type: 'sparky',
        request: 'launch',
        name: debug ? 'Sparky: Debug current file' : 'Sparky: Run current file',
        program: editor.document.uri.fsPath,
        stopOnEntry: debug,
      },
      { noDebug: !debug },
    );
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('sparky.run', () => launch(false)),
    vscode.commands.registerCommand('sparky.debug', () => launch(true)),
    vscode.commands.registerCommand('sparky.restartLint', () => lint.restart()),
    vscode.commands.registerCommand('sparky.showIO', () => io.show(false)),
  );

  // Small API for the integration tests: lets them check that every panel really rendered.
  return {
    viewHealth: () => Object.fromEntries(views.map((v, i) => [viewIds[i], v.health()])),
  };
}

export function deactivate(): void {
  /* everything is disposed through ctx.subscriptions */
}

import * as vscode from 'vscode';
import { SparkyHub } from '../hub';
import { nonce } from '../util';

/**
 * Base class for the RARS-style panels. Each panel is a webview that draws its own table with plain
 * HTML/CSS using the VS Code theme variables, so it follows the active colour theme automatically.
 */
export abstract class BaseView implements vscode.WebviewViewProvider, vscode.Disposable {
  protected view: vscode.WebviewView | undefined;
  protected readonly disposables: vscode.Disposable[] = [];
  private refreshing = false;
  private again = false;
  private renderedRows: number | undefined;
  private readonly scriptErrors: string[] = [];

  constructor(
    protected readonly ctx: vscode.ExtensionContext,
    protected readonly hub: SparkyHub,
    private readonly scriptName: string,
    /** Where the view lives; decides which theme background the sticky header uses. */
    private readonly surface: 'sidebar' | 'panel',
  ) {
    this.disposables.push(
      hub.onDidChange(() => {
        if (this.view?.visible) void this.safeRefresh();
      }),
    );
  }

  /** Inner HTML of <body>, without scripts. */
  protected abstract body(): string;
  protected abstract handle(message: any): Promise<void> | void;
  abstract refresh(): Promise<void>;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage(
      (m) => {
        if (m?.type === 'ready') void this.safeRefresh();
        else if (m?.type === 'rendered') this.renderedRows = m.rows;
        else if (m?.type === 'jsError') this.scriptErrors.push(`${m.message}${m.line ? ` (line ${m.line})` : ''}`);
        else void Promise.resolve(this.handle(m)).catch((e) => void vscode.window.showErrorMessage(`Sparky RISC-V: ${(e as Error).message}`));
      },
      undefined,
      this.disposables,
    );
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.safeRefresh();
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  /** What the webview reported back: used by the integration tests to prove the panel really rendered. */
  health(): { resolved: boolean; renderedRows: number | undefined; errors: string[] } {
    return { resolved: this.view !== undefined, renderedRows: this.renderedRows, errors: [...this.scriptErrors] };
  }

  /** Coalesces overlapping refreshes (stepping quickly would otherwise queue many fetches). */
  protected async safeRefresh(): Promise<void> {
    if (!this.view) return;
    if (this.refreshing) {
      this.again = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.again = false;
        await this.refresh();
      } while (this.again);
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
    } finally {
      this.refreshing = false;
    }
  }

  protected post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const n = nonce();
    const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('common.css')}">
</head>
<body class="${this.surface}">
${this.body()}
<script nonce="${n}" src="${uri('common.js')}"></script>
<script nonce="${n}" src="${uri(this.scriptName)}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

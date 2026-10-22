// Helpers shared by the RARS-style panels. Plain JS: the webviews have no build step.
(function () {
  const vscode = acquireVsCodeApi();

  const sparky = {
    vscode,
    state: vscode.getState() || {},
    saveState(patch) {
      Object.assign(this.state, patch);
      vscode.setState(this.state);
    },
    post(message) {
      vscode.postMessage(message);
    },
    $(id) {
      return document.getElementById(id);
    },
    /** Unsigned hex of a number or BigInt padded to `digits`. */
    hex(value, digits) {
      return '0x' + BigInt.asUintN(digits * 4, BigInt(value)).toString(16).padStart(digits, '0');
    },
    /** Parses what the user typed (decimal, 0x, 0b, 'c', or a float when allowed). Returns BigInt or null. */
    parseNumber(text, opts) {
      const t = String(text).trim();
      if (!t) return null;
      if (opts && opts.float && /^[-+]?(\d+\.\d*|\.\d+)(e[-+]?\d+)?[fd]?$/i.test(t)) {
        const single = !(opts.rv64 || /d$/i.test(t));
        const dv = new DataView(new ArrayBuffer(8));
        const f = parseFloat(t);
        if (single) {
          dv.setFloat32(0, f, true);
          return BigInt(dv.getUint32(0, true));
        }
        dv.setFloat64(0, f, true);
        return dv.getBigUint64(0, true);
      }
      let m = /^([-+]?)(0[xX][0-9a-fA-F]+|0[bB][01]+|\d+)$/.exec(t);
      if (m) {
        const v = BigInt(m[2]);
        return m[1] === '-' ? -v : v;
      }
      m = /^'(.)'$/.exec(t);
      if (m) return BigInt(m[1].charCodeAt(0));
      return null;
    },
    /** Replaces the content of a table cell with an input; calls commit(text) on Enter. */
    editCell(cell, current, commit, done) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = current;
      input.spellcheck = false;
      cell.textContent = '';
      cell.appendChild(input);
      input.focus();
      input.select();
      let finished = false;
      const finish = (send) => {
        if (finished) return;
        finished = true;
        if (send) commit(input.value);
        done();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(false));
    },
  };

  // Report script problems to the extension (shown in its output channel and checked by the integration tests).
  window.addEventListener('error', (e) => vscode.postMessage({ type: 'jsError', message: String(e.message), line: e.lineno, source: String(e.filename || '') }));
  window.addEventListener('unhandledrejection', (e) => vscode.postMessage({ type: 'jsError', message: String(e.reason) }));
  /** Tells the extension that a view finished drawing (used by the tests and for diagnostics). */
  sparky.rendered = function (view, rows) {
    vscode.postMessage({ type: 'rendered', view, rows });
  };

  window.sparky = sparky;
  window.addEventListener('DOMContentLoaded', () => vscode.postMessage({ type: 'ready' }));
  if (document.readyState !== 'loading') vscode.postMessage({ type: 'ready' });
})();

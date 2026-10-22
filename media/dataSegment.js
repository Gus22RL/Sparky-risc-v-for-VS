// "Data Segment" panel: Address + Value (+0) ... Value (+1c), selectable region, hex / decimal / ASCII.
(function () {
  const S = window.sparky;
  const $ = S.$;
  let hexAddr = S.state.hexAddr !== false;
  let hexVal = S.state.hexVal !== false;
  let ascii = S.state.ascii === true;
  let model = null;
  let editing = false;

  function fmtAddr(a) {
    return hexAddr ? S.hex(a, 8) : String(a >>> 0);
  }

  function fmtWord(w) {
    if (w === null) return '—';
    if (ascii) {
      let s = '';
      for (let i = 0; i < 4; i++) {
        const b = (w >>> (8 * i)) & 0xff;
        s += b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
      }
      return s;
    }
    return hexVal ? S.hex(w, 8) : String(w | 0);
  }

  function render() {
    if (editing) return;
    $('empty').hidden = !!model;
    $('table').hidden = !model;
    if (!model) return;

    const running = model.state === 'running';
    document.querySelector('.layout').classList.toggle('running', running);
    const status = $('status');
    status.textContent = running ? 'running…' : model.state === 'terminated' ? 'program finished' : '';
    status.className = 'status' + (running ? ' running' : '');

    // region selector
    const sel = $('mode');
    const wanted = model.modes.map((m) => m.id + ':' + m.label + ':' + m.address).join('|') + '|' + (model.mode === 'custom');
    if (sel.dataset.sig !== wanted) {
      sel.textContent = '';
      for (const m of model.modes) {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.label + ' (' + S.hex(m.address, 8) + ')';
        sel.appendChild(o);
      }
      if (model.mode === 'custom') {
        const o = document.createElement('option');
        o.value = 'custom';
        o.textContent = 'Custom (' + S.hex(model.base, 8) + ')';
        sel.appendChild(o);
      }
      sel.dataset.sig = wanted;
    }
    sel.value = model.mode;

    // header
    const head = $('head');
    head.textContent = '';
    const htr = document.createElement('tr');
    const hAddr = document.createElement('th');
    hAddr.textContent = 'Address';
    htr.appendChild(hAddr);
    for (let c = 0; c < model.columns; c++) {
      const th = document.createElement('th');
      th.className = 'value';
      th.textContent = 'Value (+' + (c * 4).toString(16) + ')';
      htr.appendChild(th);
    }
    head.appendChild(htr);

    // body
    const changed = new Set(model.changed);
    const tbody = $('rows');
    tbody.textContent = '';
    const rowCount = model.words.length / model.columns;
    for (let r = 0; r < rowCount; r++) {
      const tr = document.createElement('tr');
      const rowAddr = (model.base + r * model.columns * 4) >>> 0;
      const tdA = document.createElement('td');
      tdA.className = 'addr';
      tdA.textContent = fmtAddr(rowAddr);
      tr.appendChild(tdA);
      for (let c = 0; c < model.columns; c++) {
        const address = (rowAddr + c * 4) >>> 0;
        const w = model.words[r * model.columns + c];
        const td = document.createElement('td');
        td.className = 'value' + (ascii ? ' ascii' : '') + (changed.has(address) ? ' changed' : '') + (w === null ? ' muted' : '');
        td.textContent = fmtWord(w);
        const label = model.labels[address];
        td.title = (label ? label + ' — ' : '') + S.hex(address, 8) + (w === null ? ' (not mapped)' : ' (double-click to edit)');
        if (label) td.style.textDecoration = 'underline dotted';
        if (w !== null) {
          td.addEventListener('dblclick', () => {
            if (model.state === 'running') return;
            editing = true;
            S.editCell(td, hexVal ? S.hex(w, 8) : String(w | 0), (text) => S.post({ type: 'write', address, text }), () => {
              editing = false;
              render();
            });
          });
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    S.rendered('dataSegment', rowCount);
  }

  function bind(id, fn) {
    $(id).addEventListener('click', fn);
  }
  bind('rowUp', () => model && S.post({ type: 'scroll', rows: -1, base: model.base }));
  bind('rowDown', () => model && S.post({ type: 'scroll', rows: 1, base: model.base }));
  bind('pageUp', () => model && S.post({ type: 'page', dir: -1, base: model.base }));
  bind('pageDown', () => model && S.post({ type: 'page', dir: 1, base: model.base }));
  $('mode').addEventListener('change', () => S.post({ type: 'select', mode: $('mode').value }));
  $('goto').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && $('goto').value.trim()) {
      S.post({ type: 'goto', text: $('goto').value });
      $('goto').select();
    }
  });
  $('scroll').addEventListener(
    'wheel',
    (e) => {
      // The grid always shows a fixed number of rows: use the wheel to move through memory.
      const el = $('scroll');
      if (!model || el.scrollHeight > el.clientHeight + 1) return;
      e.preventDefault();
      S.post({ type: 'scroll', rows: e.deltaY > 0 ? 1 : -1, base: model.base });
    },
    { passive: false },
  );

  for (const [id, key] of [['hexAddr', 'hexAddr'], ['hexVal', 'hexVal'], ['ascii', 'ascii']]) {
    $(id).checked = S.state[key] === undefined ? id !== 'ascii' : S.state[key];
    $(id).onchange = () => {
      const v = $(id).checked;
      S.saveState({ [key]: v });
      if (key === 'hexAddr') hexAddr = v;
      if (key === 'hexVal') hexVal = v;
      if (key === 'ascii') ascii = v;
      render();
    };
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'memory') {
      model = m;
      render();
    } else if (m.type === 'state') {
      if (model) model.state = m.state;
      render();
    } else if (m.type === 'empty') {
      model = null;
      render();
    } else if (m.type === 'error') {
      $('status').textContent = m.message;
    }
  });
})();

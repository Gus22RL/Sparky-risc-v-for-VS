// "Text Segment" panel: Bkpt / Address / Code / Basic / Source.
(function () {
  const S = window.sparky;
  const $ = S.$;
  let hex = S.state.hex !== false;
  let rows = [];
  let pc = -1;
  let state = 'idle';
  let breakpoints = new Set();
  const byAddress = new Map();

  function fmt(value) {
    return hex ? S.hex(value, 8) : String(value | 0);
  }

  function build() {
    const tbody = $('rows');
    tbody.textContent = '';
    byAddress.clear();
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.dataset.address = r.address;

      const tdB = document.createElement('td');
      tdB.className = 'bkpt';
      if (r.bkpt) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'bkpt-box';
        box.title = 'Toggle breakpoint';
        box.addEventListener('change', () => S.post({ type: 'toggleBreakpoint', address: r.address }));
        tdB.appendChild(box);
      } else {
        const sp = document.createElement('span');
        sp.className = 'bkpt-none';
        tdB.appendChild(sp);
      }

      const tdA = document.createElement('td');
      tdA.className = 'addr';
      const tdC = document.createElement('td');
      const tdBasic = document.createElement('td');
      tdBasic.textContent = r.basic;
      const tdSrc = document.createElement('td');
      tdSrc.className = 'link';
      tdSrc.textContent = r.source;
      tdSrc.title = r.file + ':' + r.line + ' (double-click to open)';
      tdSrc.addEventListener('dblclick', () => S.post({ type: 'open', address: r.address }));

      tr.append(tdB, tdA, tdC, tdBasic, tdSrc);
      tbody.appendChild(tr);
      byAddress.set(r.address, { tr, tdA, tdC, box: tdB.querySelector('input') });
    }
    paintNumbers();
    paintState(false);
    S.rendered('textSegment', rows.length);
  }

  function paintNumbers() {
    for (const r of rows) {
      const c = byAddress.get(r.address);
      c.tdA.textContent = fmt(r.address);
      c.tdC.textContent = fmt(r.code);
    }
  }

  function paintState(scroll) {
    for (const [address, c] of byAddress) {
      c.tr.classList.toggle('current', address === pc);
      if (c.box) c.box.checked = breakpoints.has(address);
    }
    const status = $('status');
    status.textContent = state === 'running' ? 'running…' : state === 'terminated' ? 'program finished' : '';
    status.className = 'status' + (state === 'running' ? ' running' : '');
    document.querySelector('.layout').classList.toggle('running', state === 'running');
    if (scroll && byAddress.has(pc)) byAddress.get(pc).tr.scrollIntoView({ block: 'nearest' });
  }

  $('hex').checked = hex;
  $('hex').onchange = () => {
    hex = $('hex').checked;
    S.saveState({ hex });
    paintNumbers();
  };

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'program') {
      rows = m.rows;
      $('empty').hidden = true;
      $('table').hidden = false;
      build();
    } else if (m.type === 'update') {
      pc = m.pc;
      state = m.state;
      breakpoints = new Set(m.breakpoints);
      paintState(m.state !== 'running');
    } else if (m.type === 'reveal') {
      const c = byAddress.get(m.address);
      if (c) {
        c.tr.scrollIntoView({ block: 'center' });
        c.tr.classList.add('reveal');
        setTimeout(() => c.tr.classList.remove('reveal'), 1500);
      }
    } else if (m.type === 'empty') {
      rows = [];
      $('empty').hidden = false;
      $('table').hidden = true;
    }
  });
})();

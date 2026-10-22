// "Labels" panel: the symbol table. Clicking a label jumps to it in the Text or Data Segment.
(function () {
  const S = window.sparky;
  const $ = S.$;
  let hex = S.state.hex !== false;
  let sortBy = S.state.sortBy || 'name';
  let labels = [];

  function render() {
    $('sort').textContent = 'Sort: ' + sortBy;
    const filter = $('filter').value.trim().toLowerCase();
    const list = labels
      .filter((l) => !filter || l.name.toLowerCase().includes(filter))
      .sort((a, b) => (sortBy === 'name' ? a.name.localeCompare(b.name) : a.address - b.address));
    const tbody = $('rows');
    tbody.textContent = '';
    for (const l of list) {
      const tr = document.createElement('tr');
      tr.className = 'link';
      const a = document.createElement('td');
      a.textContent = l.name;
      const b = document.createElement('td');
      b.className = 'addr';
      b.textContent = hex ? S.hex(l.address, 8) : String(l.address >>> 0);
      const c = document.createElement('td');
      c.className = 'muted';
      c.textContent = l.kind === 'data' ? '.data' : '.text';
      tr.append(a, b, c);
      tr.title = 'Click to show in the ' + (l.kind === 'data' ? 'Data' : 'Text') + ' Segment';
      tr.addEventListener('click', () => S.post({ type: 'reveal', address: l.address, kind: l.kind }));
      tbody.appendChild(tr);
    }
    S.rendered('labels', list.length);
  }

  $('hex').checked = hex;
  $('hex').onchange = () => {
    hex = $('hex').checked;
    S.saveState({ hex });
    render();
  };
  $('sort').onclick = () => {
    sortBy = sortBy === 'name' ? 'address' : 'name';
    S.saveState({ sortBy });
    render();
  };
  $('filter').oninput = render;

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'labels') {
      labels = m.labels;
      $('empty').hidden = true;
      $('table').hidden = false;
      render();
    } else if (m.type === 'empty') {
      labels = [];
      $('empty').hidden = false;
      $('table').hidden = true;
    }
  });
})();

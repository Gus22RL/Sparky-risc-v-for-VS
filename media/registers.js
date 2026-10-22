// "Registers" panel: Registers / Floating Point / Control and Status.
(function () {
  const S = window.sparky;
  const $ = S.$;
  let bank = S.state.bank || 'int';
  let hex = S.state.hex !== false;
  let model = null;
  let editing = false;

  function fmtInt(valueStr, rv64) {
    const bits = rv64 ? 64 : 32;
    const v = BigInt(valueStr);
    return hex ? '0x' + BigInt.asUintN(bits, v).toString(16).padStart(bits / 4, '0') : BigInt.asIntN(bits, v).toString();
  }

  function fmtFp(r) {
    const v = BigInt.asUintN(64, BigInt(r.value));
    const upperZero = v >> 32n === 0n;
    if (hex) return '0x' + v.toString(16).padStart(upperZero ? 8 : 16, '0');
    return upperZero ? r.f32 : r.f64;
  }

  function setBank(b) {
    bank = b;
    S.saveState({ bank });
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.bank === b));
    render();
  }

  function numberLabel(r) {
    if (bank === 'int') return 'x' + r.number;
    if (bank === 'fp') return 'f' + r.number;
    return '0x' + r.number.toString(16).padStart(3, '0');
  }

  function row(name, number, valueText, changed, edit) {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = name;
    const tdNum = document.createElement('td');
    tdNum.className = 'muted';
    tdNum.textContent = number;
    const tdVal = document.createElement('td');
    tdVal.className = 'value' + (changed ? ' changed' : '');
    tdVal.textContent = valueText;
    tdVal.title = 'Double-click to edit';
    tdVal.addEventListener('dblclick', () => {
      if (!model || model.state === 'running') return;
      editing = true;
      S.editCell(tdVal, valueText, (text) => edit(text), () => {
        editing = false;
        render();
      });
    });
    tr.append(tdName, tdNum, tdVal);
    return tr;
  }

  function send(name, text, isFp) {
    const v = S.parseNumber(text, { float: isFp, rv64: model.rv64 });
    if (v === null) return;
    S.post({ type: 'setRegister', bank, name, value: v.toString() });
  }

  function render() {
    if (editing) return;
    const status = $('status');
    $('empty').hidden = !!model;
    $('table').hidden = !model;
    if (!model) {
      status.textContent = '';
      return;
    }
    const running = model.state === 'running';
    document.querySelector('.layout').classList.toggle('running', running);
    status.textContent = running ? 'running…' : model.state === 'terminated' ? 'program finished' : '';
    status.className = 'status' + (running ? ' running' : '');

    const changed = new Set(model.changed[bank]);
    const rows = model.banks[bank];
    const tbody = $('rows');
    tbody.textContent = '';
    for (const r of rows) {
      const isFp = bank === 'fp';
      const text = isFp ? fmtFp(r) : fmtInt(r.value, model.rv64);
      tbody.appendChild(row(r.name, numberLabel(r), text, changed.has(r.name), (t) => send(r.name, t, isFp)));
    }
    if (bank === 'int') {
      const pcText = hex ? S.hex(model.pc, 8) : String(model.pc);
      tbody.appendChild(row('pc', '', pcText, changed.has('pc'), (t) => send('pc', t, false)));
    }
    S.rendered('registers', tbody.children.length);
  }

  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => setBank(t.dataset.bank)));
  $('hex').checked = hex;
  $('hex').onchange = () => {
    hex = $('hex').checked;
    S.saveState({ hex });
    render();
  };
  setBank(bank);

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'registers') {
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

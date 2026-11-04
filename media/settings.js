(() => {
  'use strict';
  const api = acquireVsCodeApi(), token = document.body.dataset.token;
  const $ = id => document.getElementById(id), rows = new Map(), actions = new Map(), sections = new Map();
  let values = {}, selected = 'all', search = '';
  const send = value => api.postMessage({ ...value, token });
  const node = (tag, text, className) => { const e = document.createElement(tag); if (text) e.textContent = text; if (className) e.className = className; return e; };
  function filter() {
    let visible = 0;
    for (const [id, section] of sections) {
      let count = 0;
      for (const row of section.rows) { row.element.hidden = (selected !== 'all' && selected !== id) || !`${section.title} ${row.field.label} ${row.field.help}`.toLowerCase().includes(search); if (!row.element.hidden) count++; }
      section.element.hidden = !count; visible += count;
    }
    $('empty').hidden = visible > 0;
    for (const b of $('categories').children) b.setAttribute('aria-current', String(b.dataset.id === selected));
  }
  function apply(row, value) {
    if (row.pending || document.activeElement === row.input && ['number', 'integer', 'dates'].includes(row.field.type)) return;
    const f = row.field;
    if (f.type === 'boolean') row.input.checked = value;
    else if (f.type === 'checks') for (const input of row.inputs) input.checked = value.includes(input.value);
    else if (f.type === 'list') {
      row.input.replaceChildren(...(value.length ? value.map(v => node('span', v, 'chip')) : [node('span', '尚未添加', 'muted')]));
    } else row.input.value = f.type === 'dates' ? value.join('\n') : value;
  }
  function busy(row, value) { row.pending = value; for (const c of row.controls) c.disabled = value; }
  function makeField(field) {
    const element = node('article', '', 'setting'), text = node('div', '', 'setting-copy'), title = node('label', field.label), help = node('p', field.help);
    title.htmlFor = 'field-' + field.key; text.append(title, help);
    const control = node('div', '', 'control'), error = node('p', '', 'error'); error.setAttribute('role', 'alert');
    let input, inputs = [];
    if (field.type === 'checks') {
      input = node('fieldset'); const legend = node('legend', field.label, 'sr-only'); input.append(legend);
      for (const opt of field.options) { const label = node('label', '', 'check'); const box = node('input'); box.type = 'checkbox'; box.value = opt.value; label.append(box, node('span', opt.label)); input.append(label); inputs.push(box); }
    } else if (field.type === 'select') { input = node('select'); }
    else if (field.type === 'dates') { input = node('textarea'); input.rows = 3; input.placeholder = 'YYYY-MM-DD'; }
    else if (field.type === 'list') { input = node('div', '', 'chips'); }
    else { input = node('input'); input.type = field.type === 'boolean' ? 'checkbox' : 'number'; if (input.type === 'number') { input.min = field.min; input.max = field.max; input.step = field.type === 'integer' ? '1' : 'any'; input.required = true; } }
    input.id = title.htmlFor; input.setAttribute('aria-label', field.label);
    help.id = 'help-' + field.key; input.setAttribute('aria-describedby', help.id);
    control.append(input);
    const row = { element, field, input, inputs, error, controls: field.type === 'checks' ? inputs : [input], pending: false };
    if (field.type !== 'list') {
      const reset = node('button', '恢复默认', 'reset'); reset.type = 'button'; row.controls.push(reset); control.append(reset);
      reset.addEventListener('click', () => { busy(row, true); error.textContent = ''; $('save-status').textContent = '保存中…'; send({ type: 'reset', key: field.key }); });
      const change = () => {
        let value;
        if (field.type === 'boolean') value = input.checked;
        else if (field.type === 'checks') value = inputs.filter(i => i.checked).map(i => i.value);
        else if (field.type === 'dates') value = input.value.split(/[\n,，]+/).map(v => v.trim()).filter(Boolean);
        else if (['number', 'integer'].includes(field.type)) { if (!input.checkValidity()) { error.textContent = `请输入 ${field.min}–${field.max} 之间的${field.type === 'integer' ? '整数' : '数值'}`; return; } value = Number(input.value); }
        else value = input.value;
        error.textContent = ''; busy(row, true); $('save-status').textContent = '保存中…'; send({ type: 'save', key: field.key, value });
      };
      for (const c of field.type === 'checks' ? inputs : [input]) c.addEventListener('change', change);
    }
    element.append(text, control, error); rows.set(field.key, row); return row;
  }
  function build(groups) {
    const all = node('button', '全部设置'); all.dataset.id = 'all'; $('categories').append(all);
    for (const group of groups) {
      const nav = node('button', group.title); nav.dataset.id = group.id; $('categories').append(nav);
      const section = node('section'), heading = node('h2', group.title), toolbar = node('div', '', 'actions'); section.append(heading, toolbar);
      for (const action of group.actions) { const b = node('button', action.label); b.type = 'button'; b.addEventListener('click', () => { b.disabled = true; send({ type: 'action', action: action.id }); }); toolbar.append(b); actions.set(action.id, b); }
      const sectionRows = group.fields.map(f => makeField(f)); sectionRows.forEach(row => section.append(row.element));
      sections.set(group.id, { element: section, rows: sectionRows, title: group.title }); $('sections').append(section);
    }
    for (const b of $('categories').children) b.addEventListener('click', () => { selected = b.dataset.id; filter(); });
  }
  window.addEventListener('message', e => {
    const m = e.data; if (!m || m.token !== token) return;
    if (m.type === 'state') {
      if (!rows.size) { build(m.groups); $('save-status').textContent = '修改自动保存'; }
      for (const group of m.groups) for (const f of group.fields) {
        const row = rows.get(f.key); values[f.key] = f.value;
        if (f.type === 'select' && !row.pending) { row.input.replaceChildren(...f.options.map(o => { const option = node('option', o.label); option.value = o.value; return option; })); }
        row.field = f; row.element.title = f.workspace ? '此项在当前工作区有单独设置，修改将应用于当前工作区。' : '';
        apply(row, f.value);
      }
      $('dependencies').textContent = !values.enabled && (values['temperature.enabled'] || values['risk.enabled']) ? '市场温度和风险提示需要开启“显示成交额”。' : !values['stocks.enabled'] && values['risk.enabled'] ? '风险提示需要开启“启用自选行情”。' : '';
      filter();
    }
    if (m.type === 'result') {
      if (rows.has(m.key)) { const row = rows.get(m.key); busy(row, false); row.error.textContent = m.ok ? '' : m.error; }
      if (actions.has(m.action)) actions.get(m.action).disabled = false;
      $('save-status').textContent = m.ok ? (m.action ? '操作完成' : '已保存') : m.error;
    }
  });
  $('search').addEventListener('input', () => { search = $('search').value.trim().toLowerCase(); if (search) selected = 'all'; filter(); });
  send({ type: 'ready' });
})();

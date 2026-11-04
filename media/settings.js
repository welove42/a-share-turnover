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
      for (const row of section.rows) { row.element.hidden = (selected !== 'all' && selected !== id) || !`${section.title} ${row.field.label} ${row.field.help} ${(row.field.items || []).map(item => item.name + ' ' + item.id).join(' ')} ${(row.field.stockGroups || []).map(g => g.name).join(' ')}`.toLowerCase().includes(search); if (!row.element.hidden) count++; }
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
    else if (f.type === 'list') renderList(row);
    else row.input.value = f.type === 'dates' ? value.join('\n') : value;
  }
  function busy(row, value) { row.pending = value; for (const c of row.controls) c.disabled = value || c.dataset.locked === 'true'; }
  function listAction(row, operation, id) {
    if (row.pending) return;
    row.error.textContent = ''; busy(row, true); $('save-status').textContent = operation === 'remove' ? '正在移除…' : '等待操作…';
    send({ type: 'list', key: row.field.key, operation, id });
  }
  function groupAction(row, operation, extra = {}) {
    if (row.pending) return;
    row.error.textContent = ''; busy(row, true); $('save-status').textContent = '正在处理分组…';
    send({ type: 'stockGroup', key: row.field.key, operation, ...extra });
  }
  function stockLine(row, item) {
    const line = node('li', '', 'watch-item'), identity = node('div', '', 'watch-identity');
    const name = node('span', item.name, 'watch-name'); name.title = item.name;
    identity.append(name, node('span', item.id, 'watch-code')); line.append(identity);
    if (row.field.stockGroups?.length > 1) {
      const select = node('select', '', 'watch-group-select'); select.setAttribute('aria-label', `移动 ${item.name} 到分组`);
      for (const g of row.field.stockGroups) { const option = node('option', g.name); option.value = g.id; select.append(option); }
      select.value = row.field.stockGroups.find(g => g.symbols.includes(item.id))?.id || 'ungrouped';
      select.addEventListener('change', () => groupAction(row, 'move', { id: item.id, groupId: select.value }));
      line.append(select); row.controls.push(select);
    }
    if (row.field.canEdit) { const edit = node('button', '持仓', 'watch-edit'); edit.type = 'button'; edit.setAttribute('aria-label', `设置 ${item.name} 持仓`); edit.addEventListener('click', () => listAction(row, 'edit', item.id)); line.append(edit); row.controls.push(edit); }
    const remove = node('button', '×', 'watch-remove'); remove.type = 'button'; remove.title = `移除 ${item.name}`; remove.setAttribute('aria-label', `移除 ${item.name} ${item.id}`);
    remove.addEventListener('click', () => listAction(row, 'remove', item.id)); line.append(remove); row.controls.push(remove);
    return line;
  }
  function groupButton(row, g, text, label, operation, disabled = false) {
    const button = node('button', text, 'group-button'); button.type = 'button'; button.title = label;
    button.setAttribute('aria-label', `${label}：${g.name}`); button.disabled = disabled; button.dataset.locked = String(disabled);
    button.addEventListener('click', event => { event?.preventDefault(); event?.stopPropagation(); groupAction(row, operation, { groupId: g.id }); });
    row.controls.push(button); return button;
  }
  function renderList(row) {
    const items = row.field.items || [], groups = row.field.stockGroups, signature = JSON.stringify([items, groups, row.query.value]);
    if (signature === row.signature) return;
    row.signature = signature; row.count.textContent = String(items.length);
    row.query.hidden = items.length < 8 && (!groups || groups.length < 2) && !row.query.value;
    row.controls = [row.add, row.newGroup].filter(Boolean);
    const query = row.query.value.trim().toLowerCase(), visible = items.filter(item => `${item.name} ${item.id}`.toLowerCase().includes(query));
    row.input.replaceChildren();
    if (groups) {
      row.input.className = 'watch-list watch-groups'; let shown = 0;
      for (const [index, g] of groups.entries()) {
        const members = items.filter(item => g.symbols.includes(item.id));
        const matches = g.name.toLowerCase().includes(query) ? members : members.filter(item => visible.includes(item));
        if (query && !matches.length && !g.name.toLowerCase().includes(query)) continue;
        shown++;
        const container = node('li', '', 'stock-group'), details = node('details'), summary = node('summary');
        details.open = Boolean(query) || !row.collapsed.has(g.id);
        details.addEventListener('toggle', () => { if (!row.query.value) { if (details.open) row.collapsed.delete(g.id); else row.collapsed.add(g.id); } });
        const title = node('span', `${g.name} (${members.length})`, 'stock-group-name'); title.title = g.name;
        const buttons = node('span', '', 'stock-group-buttons');
        buttons.append(groupButton(row, g, '＋', row.field.addLabel || '添加个股', 'add'));
        if (g.custom) buttons.append(groupButton(row, g, '↑', '上移分组', 'up', index === 0), groupButton(row, g, '↓', '下移分组', 'down', index === groups.filter(g => g.custom).length - 1), groupButton(row, g, '✎', '重命名分组', 'rename'), groupButton(row, g, '×', '删除分组，保留个股', 'remove'));
        summary.append(title, buttons); details.append(summary);
        const list = node('ul', '', 'watch-list stock-group-list'); for (const item of matches) list.append(stockLine(row, item));
        details.append(list);
        if (!matches.length) details.append(node('p', query ? '此分组没有匹配的个股' : '点击＋添加，或在侧栏拖入个股。', 'watch-empty'));
        container.append(details); row.input.append(container);
      }
      row.empty.hidden = shown > 0; row.empty.textContent = '没有匹配的分组、名称或代码'; return;
    }
    for (const item of visible) row.input.append(stockLine(row, item));
    row.empty.hidden = visible.length > 0; row.empty.textContent = items.length ? '没有匹配的名称或代码' : '尚未添加，点击右上角按钮开始添加。';
  }
  function makeList(field) {
    const element = node('article', '', 'watch-setting'), header = node('div', '', 'watch-header'), title = node('h3', field.label), count = node('span', '0', 'watch-count');
    const add = node('button', '+ ' + field.addLabel, 'watch-add'); add.type = 'button';
    const tools = node('div', '', 'watch-tools'); title.append(count); header.append(title, tools);
    const query = node('input', '', 'watch-filter'); query.type = 'search'; query.value = ''; query.placeholder = '按名称或代码筛选'; query.setAttribute('aria-label', `筛选${field.label}`); query.hidden = true;
    const input = node('ul', '', 'watch-list'); input.setAttribute('aria-label', field.label);
    const empty = node('p', '', 'watch-empty'), error = node('p', '', 'error'); error.setAttribute('role', 'alert');
    const row = { element, field, input, query, count, add, empty, error, controls: [add], pending: false, collapsed: new Set() };
    if (field.stockGroups) {
      row.newGroup = node('button', '+ 新建分组'); row.newGroup.type = 'button'; row.newGroup.addEventListener('click', () => groupAction(row, 'create'));
      tools.append(row.newGroup); row.controls.push(row.newGroup);
    }
    tools.append(add);
    add.addEventListener('click', () => listAction(row, 'add')); query.addEventListener('input', () => renderList(row));
    element.append(header, query, input, empty, error); rows.set(field.key, row); return row;
  }
  function makeField(field) {
    if (field.type === 'list') return makeList(field);
    const element = node('article', '', 'setting'), text = node('div', '', 'setting-copy'), title = node('label', field.label), help = node('p', field.help);
    title.htmlFor = 'field-' + field.key; text.append(title, help);
    const control = node('div', '', 'control'), error = node('p', '', 'error'); error.setAttribute('role', 'alert');
    let input, inputs = [];
    if (field.type === 'checks') {
      input = node('fieldset'); const legend = node('legend', field.label, 'sr-only'); input.append(legend);
      for (const opt of field.options) { const label = node('label', '', 'check'); const box = node('input'); box.type = 'checkbox'; box.value = opt.value; label.append(box, node('span', opt.label)); input.append(label); inputs.push(box); }
    } else if (field.type === 'select') { input = node('select'); }
    else if (field.type === 'dates') { input = node('textarea'); input.rows = 3; input.placeholder = 'YYYY-MM-DD'; }
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
    for (const b of $('categories').children) b.addEventListener('click', () => { selected = b.dataset.id; search = ''; $('search').value = ''; filter(); });
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
      if (rows.has(m.key)) { const row = rows.get(m.key); busy(row, false); row.error.textContent = m.ok ? '' : m.error; if (!m.ok && row.field.stockGroups) { row.signature = ''; renderList(row); } }
      if (actions.has(m.action)) actions.get(m.action).disabled = false;
      $('save-status').textContent = m.ok ? (m.action ? '操作完成' : '已保存') : m.error;
    }
  });
  $('search').addEventListener('input', () => { search = $('search').value.trim().toLowerCase(); if (search) selected = 'all'; filter(); });
  send({ type: 'ready' });
})();

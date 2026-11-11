/** 设置页面通过消息提交更改；Key 输入只发送至安全存储，不放进 Webview 持久状态。 */
import { elements } from '../shared/dom';
import { ModelPicker } from './model-picker';
interface PageElements {
  'save-status': HTMLElement;
  categories: HTMLElement;
  search: HTMLInputElement;
  dependencies: HTMLElement;
  sections: HTMLElement;
  empty: HTMLElement;
}
(() => {
  'use strict';
  const api = acquireVsCodeApi(),
    token = document.body.dataset.token;
  const $ = elements<PageElements>(),
    rows = new Map(),
    actions = new Map(),
    sections = new Map();
  let values: Record<string, any> = {},
    selected = 'all',
    search = '';
  const ai: {
    dirty: boolean;
    sequence: number;
    pending: { id: string; operation: string; started: number; note: string; revision: number } | null;
    modelsRevision: number;
    timer: number | null;
    cancel?: HTMLButtonElement;
    result?: HTMLElement;
  } = { dirty: false, sequence: 0, pending: null, timer: null, modelsRevision: 0 };
  const send = (value) => api.postMessage({ ...value, token });
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const e = document.createElement(tag);
    if (text) e.textContent = text;
    if (className) e.className = className;
    return e;
  };
  function filter() {
    let visible = 0;
    for (const [id, section] of sections) {
      let count = 0;
      for (const row of section.rows) {
        const condition = row.field.visibleWhen;
        row.element.hidden =
          (selected !== 'all' && selected !== id) ||
          (condition && values[condition.key] !== condition.value) ||
          !`${section.title} ${row.field.label} ${row.field.help} ${(row.field.items || []).map((item) => item.name + ' ' + item.id).join(' ')} ${(row.field.stockGroups || []).map((g) => g.name).join(' ')}`
            .toLowerCase()
            .includes(search);
        if (!row.element.hidden) count++;
      }
      section.element.hidden = !count;
      visible += count;
    }
    $('empty').hidden = visible > 0;
    for (const b of $('categories').children)
      b.setAttribute('aria-current', String((b as HTMLElement).dataset.id === selected));
  }
  function apply(row, value) {
    if (row.field.type === 'secret') {
      updateKeyStatus();
      return;
    }
    if (row.field.key.startsWith('ai.') && ai.dirty) return;
    if (
      row.pending ||
      (document.activeElement === row.input &&
        ['number', 'integer', 'dates', 'string', 'color'].includes(row.field.type)) ||
      (row.picker && document.activeElement === row.picker)
    )
      return;
    const f = row.field;
    if (f.type === 'boolean') row.input.checked = value;
    else if (f.type === 'checks') for (const input of row.inputs) input.checked = value.includes(input.value);
    else if (f.type === 'list') renderList(row);
    else if (f.type === 'color') {
      row.input.value = value;
      if (/^#[0-9a-f]{6}$/i.test(value)) row.picker.value = value.toLowerCase();
    } else {
      if (f.key === 'ai.baseUrl' && row.input.value !== value) invalidateModels();
      row.input.value = f.type === 'dates' ? value.join('\n') : value;
    }
  }
  function busy(row, value) {
    row.pending = value;
    for (const c of row.controls) c.disabled = value || c.dataset.locked === 'true';
  }
  function sameEndpoint(a, b) {
    const normalize = (value) =>
      String(value || '')
        .trim()
        .replace(/\/+$/, '')
        .replace(/\/chat\/completions$/, '')
        .replace(/\/+$/, '');
    return normalize(a) === normalize(b);
  }
  function updateKeyStatus() {
    const row = rows.get('ai.apiKey');
    if (!row) return;
    const saved = row.field.configured && sameEndpoint(rows.get('ai.baseUrl')?.input.value, row.field.endpoint);
    row.input.placeholder = saved ? '••••••••（已保存，留空保留）' : '输入 API Key';
    row.saved.textContent = row.input.value ? '新 Key 待保存' : saved ? '已保存' : '尚未设置';
    row.clear.disabled = Boolean(ai.pending) || !saved;
  }
  function lockAi(locked) {
    for (const [key, row] of rows) if (key.startsWith('ai.')) busy(row, locked);
    for (const [id, b] of actions) if (id.startsWith('ai.')) b.disabled = locked;
    const testing = locked && ai.pending?.operation === 'test';
    const listing = locked && ai.pending?.operation === 'models';
    if (locked) rows.get('ai.model')?.modelPicker?.close();
    if (actions.has('ai.test')) actions.get('ai.test').textContent = testing ? '测试中…' : '测试连接';
    if (actions.has('ai.models')) actions.get('ai.models').textContent = listing ? '获取中…' : '获取列表';
    if (ai.cancel) {
      ai.cancel.hidden = !testing && !listing;
      ai.cancel.textContent = listing ? '取消获取' : '取消测试';
    }
    updateKeyStatus();
  }
  function showAiResult(text, kind) {
    if (!ai.result) return;
    ai.result.textContent = text;
    ai.result.dataset.kind = kind;
    ai.result.hidden = !text;
  }
  function waitingAi() {
    if (!ai.pending) return;
    const seconds = Math.floor((Date.now() - ai.pending.started) / 1000);
    showAiResult(`${ai.pending.note}… ${seconds} 秒`, 'running');
  }
  function configureAi(operation) {
    if (ai.pending) return;
    const id = 'ai-' + ++ai.sequence,
      url = rows.get('ai.baseUrl').input.value,
      model = rows.get('ai.model').input.value;
    ai.pending = {
      id,
      operation,
      started: Date.now(),
      revision: ai.modelsRevision,
      note: operation === 'models' ? '正在获取模型列表' : operation === 'clear' ? '正在清除 Key' : '正在保存配置'
    };
    lockAi(true);
    waitingAi();
    ai.timer = setInterval(waitingAi, 1000);
    send({ type: 'aiConfigure', id, operation, url, model, key: rows.get('ai.apiKey').input.value });
  }
  function invalidateModels() {
    ai.modelsRevision++;
    rows.get('ai.model')?.modelPicker?.setOptions([]);
  }
  function aiChanged() {
    ai.dirty = true;
    updateKeyStatus();
    showAiResult('配置已修改，点击保存或测试连接。', 'idle');
  }
  function makeSecret(field) {
    const element = node('article', '', 'setting'),
      copy = node('div', '', 'setting-copy'),
      title = node('label', field.label),
      help = node('p', field.help);
    title.htmlFor = 'field-' + field.key;
    copy.append(title, help);
    const control = node('div', '', 'control secret-control'),
      line = node('div', '', 'secret-input compound-input'),
      input = node('input');
    input.id = title.htmlFor;
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = 4096;
    input.setAttribute('aria-label', 'API Key');
    const reveal = node('button', '显示', 'secret-reveal compound-action');
    reveal.type = 'button';
    reveal.setAttribute('aria-label', '显示本次输入的 API Key');
    reveal.setAttribute('aria-pressed', 'false');
    reveal.addEventListener('click', () => {
      const shown = input.type === 'password';
      input.type = shown ? 'text' : 'password';
      reveal.textContent = shown ? '隐藏' : '显示';
      reveal.setAttribute('aria-pressed', String(shown));
      reveal.setAttribute('aria-label', `${shown ? '隐藏' : '显示'}本次输入的 API Key`);
    });
    const meta = node('div', '', 'secret-meta'),
      saved = node('span', '', 'muted'),
      clear = node('button', '清除已存 Key', 'reset');
    clear.type = 'button';
    clear.addEventListener('click', () => configureAi('clear'));
    meta.append(saved, clear);
    line.append(input, reveal);
    control.append(line, meta);
    const error = node('p', '', 'error');
    error.setAttribute('role', 'alert');
    element.append(copy, control, error);
    const row = {
      element,
      field,
      input,
      reveal,
      saved,
      clear,
      error,
      controls: [input, reveal, clear],
      pending: false
    };
    input.addEventListener('input', () => {
      invalidateModels();
      aiChanged();
    });
    rows.set(field.key, row);
    return row;
  }
  function listAction(row, operation, id?: string) {
    if (row.pending) return;
    row.error.textContent = '';
    busy(row, true);
    $('save-status').textContent = operation === 'remove' ? '正在移除…' : '等待操作…';
    send({ type: 'list', key: row.field.key, operation, id });
  }
  function groupAction(row, operation, extra = {}) {
    if (row.pending) return;
    row.error.textContent = '';
    busy(row, true);
    $('save-status').textContent = '正在处理分组…';
    send({ type: 'stockGroup', key: row.field.key, operation, ...extra });
  }
  function stockLine(row, item) {
    const line = node('li', '', 'watch-item'),
      identity = node('div', '', 'watch-identity');
    const name = node('span', item.name, 'watch-name');
    name.title = item.name;
    identity.append(name, node('span', item.id, 'watch-code'));
    line.append(identity);
    if (row.field.stockGroups?.length > 1) {
      const select = node('select', '', 'watch-group-select');
      select.setAttribute('aria-label', `移动 ${item.name} 到分组`);
      for (const g of row.field.stockGroups) {
        const option = node('option', g.name);
        option.value = g.id;
        select.append(option);
      }
      select.value = row.field.stockGroups.find((g) => g.symbols.includes(item.id))?.id || 'ungrouped';
      select.addEventListener('change', () => groupAction(row, 'move', { id: item.id, groupId: select.value }));
      line.append(select);
      row.controls.push(select);
    }
    if (row.field.canEdit) {
      const edit = node('button', '持仓', 'watch-edit');
      edit.type = 'button';
      edit.setAttribute('aria-label', `设置 ${item.name} 持仓`);
      edit.addEventListener('click', () => listAction(row, 'edit', item.id));
      line.append(edit);
      row.controls.push(edit);
    }
    const remove = node('button', '×', 'watch-remove');
    remove.type = 'button';
    remove.title = `移除 ${item.name}`;
    remove.setAttribute('aria-label', `移除 ${item.name} ${item.id}`);
    remove.addEventListener('click', () => listAction(row, 'remove', item.id));
    line.append(remove);
    row.controls.push(remove);
    return line;
  }
  function groupButton(row, g, text, label, operation, disabled = false) {
    const button = node('button', text, 'group-button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', `${label}：${g.name}`);
    button.disabled = disabled;
    button.dataset.locked = String(disabled);
    button.addEventListener('click', (event) => {
      event?.preventDefault();
      event?.stopPropagation();
      groupAction(row, operation, { groupId: g.id });
    });
    row.controls.push(button);
    return button;
  }
  function renderList(row) {
    const items = row.field.items || [],
      groups = row.field.stockGroups,
      signature = JSON.stringify([items, groups, row.query.value]);
    if (signature === row.signature) return;
    row.signature = signature;
    row.count.textContent = String(items.length);
    row.query.hidden = items.length < 8 && (!groups || groups.length < 2) && !row.query.value;
    row.controls = [row.add, row.newGroup].filter(Boolean);
    const query = row.query.value.trim().toLowerCase(),
      visible = items.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(query));
    row.input.replaceChildren();
    if (groups) {
      row.input.className = 'watch-list watch-groups';
      let shown = 0;
      for (const [index, g] of groups.entries()) {
        const members = items.filter((item) => g.symbols.includes(item.id));
        const matches = g.name.toLowerCase().includes(query)
          ? members
          : members.filter((item) => visible.includes(item));
        if (query && !matches.length && !g.name.toLowerCase().includes(query)) continue;
        shown++;
        const container = node('li', '', 'stock-group'),
          details = node('details'),
          summary = node('summary');
        details.open = Boolean(query) || !row.collapsed.has(g.id);
        details.addEventListener('toggle', () => {
          if (!row.query.value) {
            if (details.open) row.collapsed.delete(g.id);
            else row.collapsed.add(g.id);
          }
        });
        const title = node('span', `${g.name} (${members.length})`, 'stock-group-name');
        title.title = g.name;
        const buttons = node('span', '', 'stock-group-buttons');
        buttons.append(groupButton(row, g, '＋', row.field.addLabel || '添加个股', 'add'));
        if (g.custom)
          buttons.append(
            groupButton(row, g, '↑', '上移分组', 'up', index === 0),
            groupButton(row, g, '↓', '下移分组', 'down', index === groups.filter((g) => g.custom).length - 1),
            groupButton(row, g, '✎', '重命名分组', 'rename'),
            groupButton(row, g, '×', '删除分组，保留个股', 'remove')
          );
        summary.append(title, buttons);
        details.append(summary);
        const list = node('ul', '', 'watch-list stock-group-list');
        for (const item of matches) list.append(stockLine(row, item));
        details.append(list);
        if (!matches.length)
          details.append(node('p', query ? '此分组没有匹配的个股' : '点击＋添加，或在侧栏拖入个股。', 'watch-empty'));
        container.append(details);
        row.input.append(container);
      }
      row.empty.hidden = shown > 0;
      row.empty.textContent = '没有匹配的分组、名称或代码';
      return;
    }
    for (const item of visible) row.input.append(stockLine(row, item));
    row.empty.hidden = visible.length > 0;
    row.empty.textContent = items.length ? '没有匹配的名称或代码' : '尚未添加，点击右上角按钮开始添加。';
  }
  function makeList(field) {
    const element = node('article', '', 'watch-setting'),
      header = node('div', '', 'watch-header'),
      title = node('h3', field.label),
      count = node('span', '0', 'watch-count');
    const add = node('button', '+ ' + field.addLabel, 'watch-add');
    add.type = 'button';
    const tools = node('div', '', 'watch-tools');
    title.append(count);
    header.append(title, tools);
    const query = node('input', '', 'watch-filter');
    query.type = 'search';
    query.value = '';
    query.placeholder = '按名称或代码筛选';
    query.setAttribute('aria-label', `筛选${field.label}`);
    query.hidden = true;
    const input = node('ul', '', 'watch-list');
    input.setAttribute('aria-label', field.label);
    const empty = node('p', '', 'watch-empty'),
      error = node('p', '', 'error');
    error.setAttribute('role', 'alert');
    const row = {
      element,
      field,
      input,
      query,
      count,
      add,
      empty,
      error,
      controls: [add],
      pending: false,
      newGroup: undefined as HTMLButtonElement | undefined,
      collapsed: new Set<string>()
    };
    if (field.stockGroups) {
      row.newGroup = node('button', '+ 新建分组');
      row.newGroup.type = 'button';
      row.newGroup.addEventListener('click', () => groupAction(row, 'create'));
      tools.append(row.newGroup);
      row.controls.push(row.newGroup);
    }
    tools.append(add);
    add.addEventListener('click', () => listAction(row, 'add'));
    query.addEventListener('input', () => renderList(row));
    element.append(header, query, input, empty, error);
    rows.set(field.key, row);
    return row;
  }
  function makeColor(field) {
    const element = node('article', '', 'setting'),
      text = node('div', '', 'setting-copy');
    const title = node('label', field.label),
      help = node('p', field.help);
    const control = node('div', '', 'control color-control'),
      picker = node('input'),
      input = node('input');
    const reset = node('button', '恢复默认', 'reset'),
      error = node('p', '', 'error');
    input.id = 'field-' + field.key;
    input.type = 'text';
    input.placeholder = '#f14c4c';
    input.maxLength = 7;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', field.label + ' HEX');
    title.htmlFor = input.id;
    help.id = 'help-' + field.key;
    input.setAttribute('aria-describedby', help.id);
    picker.type = 'color';
    picker.setAttribute('aria-label', '选择' + field.label);
    picker.setAttribute('aria-describedby', help.id);
    reset.type = 'button';
    error.setAttribute('role', 'alert');
    text.append(title, help);
    control.append(picker, input, reset);
    element.append(text, control, error);
    const row = { element, field, input, picker, error, controls: [picker, input, reset], pending: false };
    const save = (value) => {
      if (!/^#[0-9a-f]{6}$/i.test(value)) {
        error.textContent = '请输入六位 HEX 颜色，例如 #f14c4c';
        return;
      }
      value = value.toLowerCase();
      picker.value = value;
      input.value = value;
      error.textContent = '';
      busy(row, true);
      $('save-status').textContent = '保存中…';
      send({ type: 'save', key: field.key, value });
    };
    picker.addEventListener('input', () => {
      input.value = picker.value;
    });
    picker.addEventListener('change', () => save(picker.value));
    input.addEventListener('change', () => save(input.value.trim()));
    reset.addEventListener('click', () => {
      busy(row, true);
      error.textContent = '';
      $('save-status').textContent = '保存中…';
      send({ type: 'reset', key: field.key });
    });
    rows.set(field.key, row);
    return row;
  }
  function makeField(field) {
    if (field.type === 'list') return makeList(field);
    if (field.type === 'secret') return makeSecret(field);
    if (field.type === 'color') return makeColor(field);
    const element = node('article', '', 'setting'),
      text = node('div', '', 'setting-copy'),
      title = node('label', field.label),
      help = node('p', field.help);
    title.htmlFor = 'field-' + field.key;
    text.append(title, help);
    const control = node('div', '', 'control'),
      error = node('p', '', 'error');
    error.setAttribute('role', 'alert');
    let input,
      inputs: HTMLInputElement[] = [];
    if (field.type === 'checks') {
      input = node('fieldset');
      const legend = node('legend', field.label, 'sr-only');
      input.append(legend);
      for (const opt of field.options) {
        const label = node('label', '', 'check');
        const box = node('input');
        box.type = 'checkbox';
        box.value = opt.value;
        label.append(box, node('span', opt.label));
        input.append(label);
        inputs.push(box);
      }
    } else if (field.type === 'select') {
      input = node('select');
    } else if (field.type === 'dates') {
      input = node('textarea');
      input.rows = 3;
      input.placeholder = 'YYYY-MM-DD';
    } else {
      input = node('input');
      input.type = field.type === 'boolean' ? 'checkbox' : field.type === 'string' ? 'text' : 'number';
      if (input.type === 'number') {
        input.min = field.min;
        input.max = field.max;
        input.step = field.type === 'integer' ? '1' : 'any';
        input.required = true;
      }
      if (field.type === 'string') {
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.placeholder = field.key === 'ai.baseUrl' ? 'https://api.example.com/v1' : '模型 ID';
      }
    }
    input.id = title.htmlFor;
    input.setAttribute('aria-label', field.label);
    help.id = 'help-' + field.key;
    input.setAttribute('aria-describedby', help.id);
    let modelPicker: ModelPicker | undefined, modelActions: HTMLElement | undefined;
    if (field.key === 'ai.model') {
      element.className += ' model-setting';
      control.className += ' model-control';
      const line = node('div', '', 'model-line');
      modelActions = node('div', '', 'model-actions');
      const get = node('button', '获取列表');
      get.type = 'button';
      get.addEventListener('click', () => configureAi('models'));
      actions.set('ai.models', get);
      modelPicker = new ModelPicker(input, aiChanged);
      modelActions.append(get);
      line.append(modelPicker.element, modelActions);
      control.append(line);
    } else control.append(input);
    const row = {
      element,
      field,
      input,
      inputs,
      error,
      controls: field.type === 'checks' ? inputs : [input],
      modelPicker,
      modelActions,
      pending: false
    };
    if (field.key.startsWith('ai.')) {
      if (modelPicker) row.controls.push(modelPicker.toggle);
      input.addEventListener('input', () => {
        if (field.key === 'ai.baseUrl') invalidateModels();
        aiChanged();
      });
    } else if (field.type !== 'list') {
      const reset = node('button', '恢复默认', 'reset');
      reset.type = 'button';
      row.controls.push(reset);
      control.append(reset);
      reset.addEventListener('click', () => {
        busy(row, true);
        error.textContent = '';
        $('save-status').textContent = '保存中…';
        send({ type: 'reset', key: field.key });
      });
      const change = () => {
        let value;
        if (field.type === 'boolean') value = input.checked;
        else if (field.type === 'checks') value = inputs.filter((i) => i.checked).map((i) => i.value);
        else if (field.type === 'dates')
          value = input.value
            .split(/[\n,，]+/)
            .map((v) => v.trim())
            .filter(Boolean);
        else if (['number', 'integer'].includes(field.type)) {
          if (!input.checkValidity()) {
            error.textContent = `请输入 ${field.min}–${field.max} 之间的${field.type === 'integer' ? '整数' : '数值'}`;
            return;
          }
          value = Number(input.value);
        } else value = input.value;
        error.textContent = '';
        busy(row, true);
        $('save-status').textContent = '保存中…';
        send({ type: 'save', key: field.key, value });
      };
      for (const c of field.type === 'checks' ? inputs : [input]) c.addEventListener('change', change);
    }
    element.append(text, control, error);
    rows.set(field.key, row);
    return row;
  }
  function build(groups) {
    const all = node('button', '全部设置');
    all.dataset.id = 'all';
    $('categories').append(all);
    for (const group of groups) {
      const nav = node('button', group.title);
      nav.dataset.id = group.id;
      $('categories').append(nav);
      const section = node('section'),
        heading = node('h2', group.title),
        toolbar = node('div', '', 'actions'),
        info = node('p', group.info || '', 'hint');
      section.append(heading, info);
      for (const action of group.actions) {
        const b = node('button', action.label);
        b.type = 'button';
        b.addEventListener('click', () => {
          if (action.id === 'ai.save' || action.id === 'ai.test')
            configureAi(action.id === 'ai.test' ? 'test' : 'save');
          else {
            b.disabled = true;
            send({ type: 'action', action: action.id });
          }
        });
        toolbar.append(b);
        actions.set(action.id, b);
      }
      const sectionRows = group.fields.map((f) => makeField(f));
      sectionRows.forEach((row) => section.append(row.element));
      section.append(toolbar);
      if (group.id === 'ai') {
        section.className = 'ai-settings';
        const test = actions.get('ai.test');
        if (test) rows.get('ai.model')?.modelActions?.append(test);
        ai.cancel = node('button', '取消测试');
        ai.cancel.hidden = true;
        ai.cancel.type = 'button';
        ai.cancel.addEventListener('click', () => {
          if (ai.pending) {
            ai.pending!.note = ai.pending.operation === 'models' ? '正在取消获取' : '正在取消测试';
            waitingAi();
            send({ type: 'aiCancel', id: ai.pending.id });
          }
        });
        toolbar.append(ai.cancel);
        ai.result = node('p', '', 'ai-result');
        ai.result.hidden = true;
        ai.result.setAttribute('role', 'status');
        ai.result.setAttribute('aria-live', 'polite');
        section.append(ai.result);
      }
      sections.set(group.id, {
        element: section,
        rows: sectionRows,
        title: group.title,
        info
      });
      $('sections').append(section);
    }
    for (const b of $('categories').children)
      b.addEventListener('click', () => {
        selected = (b as HTMLElement).dataset.id || 'all';
        search = '';
        $('search').value = '';
        filter();
      });
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.token !== token) return;
    if (m.type === 'state') {
      if (!rows.size) {
        build(m.groups);
        $('save-status').textContent = '常规设置自动保存';
      }
      if (m.category && sections.has(m.category)) {
        selected = m.category;
        search = '';
        $('search').value = '';
      }
      for (const group of m.groups) sections.get(group.id).info.textContent = group.info || '';
      for (const group of m.groups)
        for (const f of group.fields) {
          const row = rows.get(f.key);
          values[f.key] = f.value;
          if (f.type === 'select' && !row.pending) {
            row.input.replaceChildren(
              ...f.options.map((o) => {
                const option = node('option', o.label);
                option.value = o.value;
                return option;
              })
            );
          }
          row.field = f;
          row.element.title = f.workspace ? '此项在当前工作区有单独设置，修改将应用于当前工作区。' : '';
          apply(row, f.value);
        }
      $('dependencies').textContent =
        !values.enabled && (values['temperature.enabled'] || values['risk.enabled'])
          ? '市场温度和风险提示需要开启“显示成交额”。'
          : !values['stocks.enabled'] && values['risk.enabled']
            ? '风险提示需要开启“启用自选行情”。'
            : '';
      updateKeyStatus();
      filter();
    }
    if (m.type === 'result') {
      if (rows.has(m.key)) {
        const row = rows.get(m.key);
        busy(row, false);
        row.error.textContent = m.ok ? '' : m.error;
        if (!m.ok && row.field.stockGroups) {
          row.signature = '';
          renderList(row);
        }
      }
      if (actions.has(m.action)) actions.get(m.action).disabled = false;
      $('save-status').textContent = m.ok ? m.note || (m.action ? '操作完成' : '已保存') : m.error;
    }
    if (m.type === 'aiProgress' && m.id === ai.pending?.id) {
      ai.pending!.note = m.note;
      waitingAi();
    }
    if (m.type === 'aiResult' && m.id === ai.pending?.id) {
      const pending = ai.pending!;
      clearInterval(ai.timer ?? undefined);
      ai.timer = null;
      ai.pending = null;
      if (m.saved || (m.ok && m.operation === 'clear')) {
        const row = rows.get('ai.apiKey');
        row.input.value = '';
        row.input.type = 'password';
        row.reveal.textContent = '显示';
        row.reveal.setAttribute('aria-pressed', 'false');
        row.reveal.setAttribute('aria-label', '显示本次输入的 API Key');
        if (m.saved) ai.dirty = false;
      }
      lockAi(false);
      if (m.operation === 'clear' && m.ok) invalidateModels();
      if (m.operation === 'models' && m.ok) {
        if (pending.revision !== ai.modelsRevision) {
          showAiResult('API 地址或 Key 已变化，请重新获取模型列表。', 'idle');
          return;
        }
        rows.get('ai.model').modelPicker.setOptions(Array.isArray(m.models) ? m.models : [], Boolean(m.models?.length));
      }
      const elapsed = m.operation === 'test' && m.ok ? ` 耗时 ${(m.elapsedMs / 1000).toFixed(1)} 秒。` : '';
      const failure =
        m.operation === 'models'
          ? '获取失败：'
          : m.operation === 'test'
            ? '测试失败：'
            : m.operation === 'clear'
              ? '清除失败：'
              : '保存失败：';
      showAiResult(
        (m.ok ? '✓ ' + m.note : m.cancelled ? m.error : failure + m.error) + elapsed,
        m.ok ? 'success' : m.cancelled ? 'idle' : 'error'
      );
      $('save-status').textContent = m.saved ? 'AI 配置已保存' : m.ok ? m.note : '请查看 AI 设置中的提示';
    }
  });
  $('search').addEventListener('input', () => {
    search = $('search').value.trim().toLowerCase();
    if (search) selected = 'all';
    filter();
  });
  send({ type: 'ready' });
})();

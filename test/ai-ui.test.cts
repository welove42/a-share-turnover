'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  vm = require('node:vm'),
  fs = require('node:fs'),
  path = require('node:path');
function page() {
  const nodes = new Map(),
    sent = [],
    documentHandlers = new Map();
  let receive;
  function element(tag) {
    const handlers = {};
    const attributes = new Map();
    return {
      tagName: tag.toUpperCase(),
      children: [],
      dataset: {},
      style: {},
      value: '',
      textContent: '',
      hidden: false,
      disabled: false,
      scrollHeight: 0,
      scrollTop: 0,
      clientHeight: 0,
      setAttribute(key, value) {
        attributes.set(key, String(value));
      },
      getAttribute(key) {
        return attributes.get(key) ?? null;
      },
      removeAttribute(key) {
        attributes.delete(key);
      },
      contains(target) {
        return target === this || this.children.some((n) => n.contains(target));
      },
      focus() {
        document.activeElement = this;
      },
      scrollIntoView() {
        this.scrolled = true;
      },
      append(...children) {
        this.children.push(...children);
      },
      replaceChildren(...children) {
        this.children = children;
      },
      get lastElementChild() {
        return this.children.at(-1);
      },
      querySelector() {
        return (this.summary ||= element('summary'));
      },
      addEventListener(type, fn) {
        handlers[type] = fn;
      },
      dispatch(type, event = {}) {
        handlers[type]?.({ target: this, preventDefault() {}, ...event });
      }
    };
  }
  const document = {
    body: { dataset: { token: 'test' } },
    createElement: element,
    addEventListener(type, fn) {
      documentHandlers.set(type, fn);
    },
    getElementById: (id) => {
      if (!nodes.has(id)) {
        const child = element(id);
        nodes.set(id, child);
        if (['choose', 'target-menu'].includes(id)) document.getElementById('target-picker').append(child);
        if (['target-search', 'target-options', 'target-empty'].includes(id))
          document.getElementById('target-menu').append(child);
      }
      return nodes.get(id);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/webviews/ai-analysis.js'), 'utf8'), {
    document,
    window: {
      addEventListener: (type, fn) => {
        if (type === 'message') receive = fn;
      }
    },
    acquireVsCodeApi: () => ({ postMessage: (m) => sent.push(m) })
  });
  return {
    nodes,
    sent,
    document,
    documentEvent: (type, event) => documentHandlers.get(type)?.(event),
    receive: (state) =>
      receive({ data: { token: 'test', type: 'state', configured: true, name: '测试', messages: [], ...state } })
  };
}
const text = (node) => node.textContent + node.children.map(text).join('');

test('全局画像与个股持仓分开编辑，切股不覆盖全局草稿，清空分别生效', () => {
  const p = page(),
    profile = { risk: 'unknown', horizon: 'long', goal: '关注风险' },
    state = { profileVisible: true, target: 'sh600519', profile, holding: { status: 'held', cost: 50, exposure: 10 } };
  p.receive(state);
  const node = (id) => p.nodes.get('profile-' + id);
  assert.equal(node('title').textContent, '全局用户画像');
  assert.equal(node('holding').hidden, true);
  node('goal').value = '关注长期回撤';
  p.receive({ ...state, target: 'sz000001', holding: null });
  assert.equal(node('goal').value, '关注长期回撤');
  node('panel').dispatch('submit');
  assert.equal(p.sent.at(-1).type, 'profileSave');
  assert.equal(p.sent.at(-1).value.holding, undefined);
  p.receive(state);
  node('toggle').dispatch('click');
  assert.equal(node('holding').hidden, false);
  assert.equal(node('general').hidden, true);
  assert.equal(node('cost').value, '50');
  node('panel').dispatch('submit');
  assert.equal(p.sent.at(-1).type, 'holdingSave');
  assert.equal(p.sent.at(-1).symbol, 'sh600519');
  assert.equal(p.sent.at(-1).value.cost, 50);
  const length = p.sent.length;
  node('clear').dispatch('click');
  assert.equal(p.sent.length, length);
  node('clear').dispatch('click');
  assert.equal(p.sent.at(-1).type, 'holdingClear');
  node('toggle').dispatch('click');
  node('clear').dispatch('click');
  node('clear').dispatch('click');
  assert.equal(p.sent.at(-1).type, 'profileClear');
  p.receive({ ...state, busy: true });
  assert.equal(node('save').disabled, true);
  assert.equal(node('cost').disabled, true);
  p.receive({ ...state, target: 'market', busy: false });
  assert.equal(node('holding').hidden, true);
  assert.equal(node('toggle').hidden, true);
});
const descendants = (node) => [node, ...node.children.flatMap(descendants)];
const targets = [
  { symbol: 'market', label: '沪深大盘' },
  { symbol: 'sh601138', label: '工业富联' },
  { symbol: 'sh563530', label: '卫星ETF易方达' },
  { symbol: 'sz002475', label: '立讯精密' }
];
test('分析下拉在页面内展开，按名称和代码过滤，点击选中且展开搜索不调用分析', () => {
  const p = page();
  p.receive({ targetOptions: targets, target: 'sh601138' });
  const button = p.nodes.get('choose'),
    menu = p.nodes.get('target-menu'),
    search = p.nodes.get('target-search'),
    list = p.nodes.get('target-options');
  button.dispatch('click');
  assert.equal(menu.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(p.document.activeElement, search);
  assert.equal(list.children.length, 4);
  assert.equal(list.children[1].getAttribute('aria-selected'), 'true');
  search.value = '卫星';
  search.dispatch('input');
  assert.equal(list.children.length, 1);
  assert.match(text(list), /sh563530/);
  search.value = 'SZ002475';
  search.dispatch('input');
  assert.equal(list.children.length, 1);
  assert.match(text(list), /立讯精密/);
  assert.deepEqual(
    p.sent.map((m) => m.type),
    ['ready', 'refreshTargets']
  );
  list.children[0].dispatch('click');
  assert.equal(menu.hidden, true);
  assert.equal(p.sent.at(-1).type, 'selectTarget');
  assert.equal(p.sent.at(-1).symbol, 'sz002475');
  assert.equal(p.document.activeElement, button);
});

test('下拉支持方向键和 Enter，输入法确认不误选；无结果、Esc 和点击空白不切换对象', () => {
  const p = page();
  p.receive({ targetOptions: targets, target: 'market' });
  const button = p.nodes.get('choose'),
    search = p.nodes.get('target-search'),
    menu = p.nodes.get('target-menu'),
    list = p.nodes.get('target-options');
  button.dispatch('keydown', { key: 'ArrowDown' });
  search.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(search.getAttribute('aria-activedescendant'), list.children[1].id);
  search.dispatch('keydown', { key: 'Enter', isComposing: true });
  search.dispatch('keydown', { key: 'Enter', keyCode: 229 });
  assert.equal(p.sent.filter((m) => m.type === 'selectTarget').length, 0);
  search.dispatch('keydown', { key: 'Enter' });
  assert.equal(p.sent.at(-1).symbol, 'sh601138');
  button.dispatch('click');
  search.value = '不存在';
  search.dispatch('input');
  assert.equal(p.nodes.get('target-empty').hidden, false);
  assert.equal(search.getAttribute('aria-activedescendant'), null);
  search.dispatch('keydown', { key: 'Enter' });
  search.dispatch('keydown', { key: 'Escape' });
  assert.equal(menu.hidden, true);
  button.dispatch('click');
  p.documentEvent('pointerdown', { target: p.nodes.get('question') });
  assert.equal(menu.hidden, true);
  assert.equal(p.sent.filter((m) => m.type === 'selectTarget').length, 1);
});

test('分析进度刷新不清空搜索，名单更新保留输入；历史打开和外部切股收起下拉', () => {
  const p = page(),
    state = { targetOptions: targets, target: 'sh601138', targetPickerRequest: 0 };
  p.receive(state);
  p.nodes.get('choose').dispatch('click');
  const search = p.nodes.get('target-search');
  search.value = 'ETF';
  search.dispatch('input');
  p.receive({ ...state, busy: true, status: '正在接收分析…' });
  assert.equal(search.value, 'ETF');
  assert.equal(p.nodes.get('target-options').children.length, 1);
  p.receive({ ...state, targetOptions: [...targets, { symbol: 'sh510300', label: '沪深300ETF' }] });
  assert.equal(search.value, 'ETF');
  assert.equal(p.nodes.get('target-options').children.length, 2);
  p.receive({ ...state, historyVisible: true });
  assert.equal(p.nodes.get('target-menu').hidden, true);
  p.receive(state);
  p.nodes.get('choose').dispatch('click');
  p.receive({ ...state, target: 'sz002475' });
  assert.equal(p.nodes.get('target-menu').hidden, true);
});

test('未选对象的开始分析能打开页内列表，取消后不被状态刷新重新弹出，名称作为安全文本显示', () => {
  const p = page(),
    state = { targetPickerRequest: 1, targetOptions: [{ symbol: 'market', label: '<img onerror=alert(1)>' }] };
  p.receive(state);
  assert.equal(p.nodes.get('target-menu').hidden, false);
  assert.match(text(p.nodes.get('target-options')), /<img/);
  assert.equal(
    descendants(p.nodes.get('target-options')).some((n) => n.tagName === 'IMG'),
    false
  );
  p.nodes.get('target-search').dispatch('keydown', { key: 'Escape' });
  p.receive({ ...state, status: '状态更新' });
  assert.equal(p.nodes.get('target-menu').hidden, true);
  p.receive({ ...state, targetPickerRequest: 2 });
  assert.equal(p.nodes.get('target-menu').hidden, false);
  const restored = page();
  restored.receive({ ...state, target: 'market' });
  assert.equal(restored.nodes.get('target-menu').hidden, true);
});

test('分析结论单独突出，原因与观察条件渲染为列表，用户消息不伪装成结论', () => {
  const p = page();
  const content =
    '## 一句话结论\n**短线偏弱**，先看能否守住今天的涨幅。\n\n## 为什么这么看\n- 价格涨了，但成交比昨天少。\n- 同行涨得更多，它跟涨较弱。\n\n## 接下来盯什么\n1. 成交增加且涨幅扩大，再看是否变强。\n2. 跌回开盘附近，要小心反弹结束。\n\n## 最需要小心\n外围行情是上一交易日，不能当作同步走势。';
  p.receive({
    messages: [
      { role: 'user', content: '## 一句话结论\n帮我看下' },
      { role: 'assistant', content, state: 'complete' }
    ]
  });
  const [user, answer] = p.nodes.get('messages').children;
  assert.equal(
    descendants(user).some((n) => n.className?.includes('analysis-summary')),
    false
  );
  const summary = descendants(answer).find((n) => n.className?.includes('analysis-summary'));
  assert.match(text(summary), /短线偏弱/);
  assert.doesNotMatch(text(summary), /同行|外围/);
  assert.equal(descendants(answer).filter((n) => n.tagName === 'LI').length, 4);
  assert.equal(descendants(answer).filter((n) => n.tagName === 'STRONG').length, 1);
  assert.match(text(answer), /上一交易日/);
});

test('流式回复和历史普通文本完整保留，加粗标题可识别，外部 HTML 和命令链接只作为文本', () => {
  const p = page(),
    answer = { role: 'assistant', content: '## 一句话', state: 'pending' };
  p.receive({ busy: true, messages: [answer] });
  answer.content =
    '**一句话结论**\n数据不足，暂时看不清。\n## 为什么这么看\n- <img src=x onerror=alert(1)>\n- [打开](command:workbench.action.closeWindow)';
  p.receive({ busy: true, messages: [answer] });
  const root = p.nodes.get('messages');
  assert.match(text(root), /数据不足/);
  assert.equal(descendants(root).filter((n) => n.className?.includes('analysis-summary')).length, 1);
  assert.equal(
    descendants(root).some((n) => ['IMG', 'SCRIPT', 'A'].includes(n.tagName)),
    false
  );
  assert.match(text(root), /onerror=alert\(1\)/);
  answer.content = '旧历史没有标题。\n仍显示完整正文。\n\n3. 第三项\n7. 第七项';
  answer.state = 'complete';
  p.receive({ busy: false, messages: [answer] });
  assert.match(text(root), /旧历史没有标题.*仍显示完整正文/);
  assert.equal(
    descendants(root).some((n) => n.className?.includes('analysis-summary')),
    false
  );
  assert.deepEqual(
    descendants(root)
      .filter((n) => n.tagName === 'LI')
      .map((n) => n.value),
    [3, 7]
  );
});

test('历史在分析面板内显示，恢复及删除均通过本页面操作', () => {
  const p = page();
  p.receive({
    historyVisible: true,
    activeSessionId: 'one',
    historyItems: [{ id: 'one', name: '个股 <script>', createdAt: 1, preview: '历史问题' }]
  });
  assert.equal(p.nodes.get('history-panel').hidden, false);
  const row = p.nodes.get('history-list').children[0];
  assert.match(row.className, /current/);
  row.children[0].dispatch('click');
  assert.equal(p.sent.at(-1).type, 'historyRestore');
  assert.equal(p.sent.at(-1).id, 'one');
  row.children[1].dispatch('click');
  assert.equal(p.nodes.get('history-confirm').hidden, false);
  p.nodes.get('history-confirm-delete').dispatch('click');
  assert.equal(p.sent.at(-1).type, 'historyDelete');
  assert.equal(p.sent.at(-1).id, 'one');
  assert.match(text(row), /<script>/);
  p.receive({ historyVisible: false });
  assert.equal(p.nodes.get('history-panel').hidden, true);
});

test('切换历史恢复草稿与等长对话，普通状态更新不覆盖正在输入的文字', () => {
  const p = page();
  p.receive({ sessionRevision: 1, draft: '旧草稿', messages: [{ role: 'assistant', content: '旧对话' }] });
  assert.equal(p.nodes.get('question').value, '旧草稿');
  p.nodes.get('question').value = '正在写';
  p.nodes.get('question').dispatch('input');
  assert.equal(p.sent.at(-1).type, 'draft');
  assert.equal(p.sent.at(-1).sessionRevision, 1);
  p.receive({ sessionRevision: 1, draft: '旧草稿' });
  assert.equal(p.nodes.get('question').value, '正在写');
  p.receive({ sessionRevision: 2, draft: '另一段草稿', messages: [{ role: 'assistant', content: '新对话' }] });
  assert.equal(p.nodes.get('question').value, '另一段草稿');
  assert.equal(p.nodes.get('messages').children.length, 1);
  assert.doesNotMatch(text(p.nodes.get('messages')), /旧对话/);
});

test('生成期间仍可编辑草稿，中断后可发送追问，状态刷新不清空输入', () => {
  const p = page();
  p.receive({ busy: true, canAsk: false });
  const input = p.nodes.get('question');
  assert.equal(input.disabled, false);
  assert.equal(p.nodes.get('send').disabled, true);
  input.value = '继续';
  p.nodes.get('followup').dispatch('submit');
  assert.equal(input.value, '继续');
  assert.equal(p.sent.filter((m) => m.type === 'ask').length, 0);
  p.receive({ busy: false, canAsk: true, interrupted: true });
  assert.equal(input.value, '继续');
  assert.equal(input.disabled, false);
  assert.equal(p.nodes.get('send').disabled, false);
  assert.match(p.nodes.get('followup-hint').textContent, /未完成.*继续/);
  p.nodes.get('followup').dispatch('submit');
  assert.equal(p.sent.at(-1).type, 'ask');
  assert.equal(p.sent.at(-1).text, '继续');
  assert.equal(input.value, '');
});

test('尚无可追问内容或缺少配置时能写草稿，说明不能发送的原因', () => {
  const p = page();
  p.receive({ busy: false, canAsk: false });
  assert.equal(p.nodes.get('question').disabled, false);
  assert.equal(p.nodes.get('send').disabled, true);
  assert.match(p.nodes.get('followup-hint').textContent, /先完成一次分析/);
  p.receive({ busy: false, canAsk: true, configured: false });
  assert.equal(p.nodes.get('send').disabled, true);
  assert.match(p.nodes.get('followup-hint').textContent, /API 配置/);
});

test('追问输入框自动增高并限制最大高度，空白不发送', () => {
  const p = page();
  p.receive({ busy: false, canAsk: true });
  const input = p.nodes.get('question');
  assert.equal(p.nodes.get('send').disabled, true);
  input.value = '较长的追问';
  input.scrollHeight = 135;
  input.dispatch('input');
  assert.equal(input.style.height, '135px');
  assert.equal(p.nodes.get('send').disabled, false);
  input.scrollHeight = 500;
  input.dispatch('input');
  assert.equal(input.style.height, '180px');
  input.value = '  ';
  input.dispatch('input');
  assert.equal(p.nodes.get('send').disabled, true);
});

test('失败或停止后，空回复不再显示正在思考；重新分析不能复活旧等待提示', () => {
  const p = page(),
    answer = { role: 'assistant', content: '', state: 'pending', phase: 'reasoning', elapsedSeconds: 12 };
  const render = (busy) => p.receive({ busy, messages: [answer] });
  render(true);
  assert.match(text(p.nodes.get('messages')), /思考/);
  assert.match(text(p.nodes.get('messages')), /12 秒/);
  answer.state = 'error';
  answer.notice = 'AI 请求超时';
  render(false);
  assert.match(text(p.nodes.get('messages')), /超时/);
  assert.doesNotMatch(text(p.nodes.get('messages')), /正在思考/);
  render(true);
  assert.doesNotMatch(text(p.nodes.get('messages')), /正在思考/);
  answer.state = 'stopped';
  answer.notice = '已停止分析';
  render(false);
  assert.match(text(p.nodes.get('messages')), /已停止/);
  assert.equal(p.nodes.get('stop').hidden, true);
  assert.equal(p.nodes.get('analyze').disabled, false);
});

test('空回复只改变busy或status也会重绘，部分正文失败保留内容和原因，外部文本不执行HTML', () => {
  const p = page(),
    answer = { role: 'assistant', content: '' };
  p.receive({ busy: true, messages: [answer] });
  p.receive({ busy: false, status: 'AI 接口 HTTP 401', messages: [answer] });
  assert.match(text(p.nodes.get('messages')), /401/);
  assert.doesNotMatch(text(p.nodes.get('messages')), /思考/);
  answer.content = '<script>doNotRun()</script>已接收部分正文';
  answer.state = 'error';
  answer.notice = 'AI 响应中断';
  p.receive({ busy: false, messages: [answer] });
  assert.match(text(p.nodes.get('messages')), /部分正文/);
  assert.match(text(p.nodes.get('messages')), /中断/);
  assert.match(text(p.nodes.get('messages')), /<script>/);
});

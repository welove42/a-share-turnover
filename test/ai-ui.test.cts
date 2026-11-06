'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  vm = require('node:vm'),
  fs = require('node:fs'),
  path = require('node:path');
function page() {
  const nodes = new Map(),
    sent = [];
  let receive;
  function element(tag) {
    const handlers = {};
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
      dispatch(type) {
        handlers[type]?.({ preventDefault() {} });
      }
    };
  }
  const document = {
    body: { dataset: { token: 'test' } },
    createElement: element,
    getElementById: (id) => {
      if (!nodes.has(id)) nodes.set(id, element(id));
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
    receive: (state) =>
      receive({ data: { token: 'test', type: 'state', configured: true, name: '测试', messages: [], ...state } })
  };
}
const text = (node) => node.textContent + node.children.map(text).join('');

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

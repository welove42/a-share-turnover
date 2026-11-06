'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
function page() {
  const nodes = new Map(), sent = []; let receive;
  function element(tag) {
    const handlers = {};
    return { tagName: tag.toUpperCase(), children: [], dataset: {}, value: '', textContent: '', hidden: false, disabled: false, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      get lastElementChild() { return this.children.at(-1); }, querySelector() { return this.summary ||= element('summary'); },
      addEventListener(type, fn) { handlers[type] = fn; }, dispatch(type) { handlers[type]?.({ preventDefault() {} }); }
    };
  }
  const document = { body: { dataset: { token: 'test' } }, createElement: element, getElementById: id => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/ai-analysis.js'), 'utf8'), { document, window: { addEventListener: (_, fn) => { receive = fn; } }, acquireVsCodeApi: () => ({ postMessage: m => sent.push(m) }) });
  return { nodes, sent, receive: state => receive({ data: { token: 'test', type: 'state', configured: true, name: '测试', messages: [], ...state } }) };
}
const text = node => node.textContent + node.children.map(text).join('');

test('失败或停止后，空回复不再显示正在思考；重新分析不能复活旧等待提示', () => {
  const p = page(), answer = { role: 'assistant', content: '', state: 'pending', phase: 'reasoning', elapsedSeconds: 12 };
  const render = busy => p.receive({ busy, messages: [answer] });
  render(true); assert.match(text(p.nodes.get('messages')), /思考/); assert.match(text(p.nodes.get('messages')), /12 秒/);
  answer.state = 'error'; answer.notice = 'AI 请求超时'; render(false);
  assert.match(text(p.nodes.get('messages')), /超时/); assert.doesNotMatch(text(p.nodes.get('messages')), /正在思考/);
  render(true); assert.doesNotMatch(text(p.nodes.get('messages')), /正在思考/);
  answer.state = 'stopped'; answer.notice = '已停止分析'; render(false);
  assert.match(text(p.nodes.get('messages')), /已停止/); assert.equal(p.nodes.get('stop').hidden, true); assert.equal(p.nodes.get('analyze').disabled, false);
});

test('空回复只改变busy或status也会重绘，部分正文失败保留内容和原因，外部文本不执行HTML', () => {
  const p = page(), answer = { role: 'assistant', content: '' };
  p.receive({ busy: true, messages: [answer] });
  p.receive({ busy: false, status: 'AI 接口 HTTP 401', messages: [answer] });
  assert.match(text(p.nodes.get('messages')), /401/); assert.doesNotMatch(text(p.nodes.get('messages')), /思考/);
  answer.content = '<script>doNotRun()</script>已接收部分正文'; answer.state = 'error'; answer.notice = 'AI 响应中断';
  p.receive({ busy: false, messages: [answer] });
  assert.match(text(p.nodes.get('messages')), /部分正文/); assert.match(text(p.nodes.get('messages')), /中断/);
  assert.match(text(p.nodes.get('messages')), /<script>/);
});

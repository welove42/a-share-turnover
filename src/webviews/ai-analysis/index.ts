/** 页面只负责展示与交互。模型输出使用文本节点渲染，历史操作交给扩展主进程。 */
import { elements } from '../shared/dom';
import { renderAnalysisText } from './text';
interface PageElements {
  model: HTMLElement;
  history: HTMLButtonElement;
  diagnostics: HTMLButtonElement;
  settings: HTMLButtonElement;
  choose: HTMLButtonElement;
  target: HTMLElement;
  analyze: HTMLButtonElement;
  stop: HTMLButtonElement;
  clear: HTMLButtonElement;
  status: HTMLElement;
  'save-warning': HTMLElement;
  'context-summary': HTMLElement;
  conversation: HTMLElement;
  welcome: HTMLElement;
  messages: HTMLElement;
  snapshot: HTMLElement;
  data: HTMLElement;
  followup: HTMLFormElement;
  question: HTMLTextAreaElement;
  send: HTMLButtonElement;
  'followup-hint': HTMLElement;
  'history-panel': HTMLElement;
  historyClose: HTMLButtonElement;
  'history-list': HTMLElement;
  'history-empty': HTMLElement;
  'history-confirm': HTMLElement;
  'history-confirm-text': HTMLElement;
  'history-confirm-delete': HTMLButtonElement;
  'history-cancel-delete': HTMLButtonElement;
  'history-delete-all': HTMLButtonElement;
}
(() => {
  'use strict';
  const vscode = acquireVsCodeApi(),
    token = document.body.dataset.token;
  const $ = elements<PageElements>(),
    send = (type, rest = {}) => vscode.postMessage({ type, token, ...rest });
  for (const id of ['settings', 'choose', 'analyze', 'stop', 'clear', 'history', 'diagnostics', 'historyClose'])
    $(id).addEventListener('click', () => send(id));
  let deleteId = '',
    lastHistory = '';
  const confirmDelete = (id) => {
    deleteId = id;
    $('history-confirm-text').textContent =
      id === 'all' ? '删除全部本地对话？此操作无法撤销。' : '删除这段对话？此操作无法撤销。';
    $('history-confirm').hidden = false;
  };
  $('history-delete-all').addEventListener('click', () => confirmDelete('all'));
  $('history-cancel-delete').addEventListener('click', () => {
    deleteId = '';
    $('history-confirm').hidden = true;
  });
  $('history-confirm-delete').addEventListener('click', () => {
    if (deleteId) send('historyDelete', { id: deleteId });
    deleteId = '';
    $('history-confirm').hidden = true;
  });
  let sessionRevision;
  let canSend = false;
  function resizeComposer() {
    const input = $('question');
    input.style.height = 'auto';
    input.style.height = Math.min(180, Math.max(72, input.scrollHeight)) + 'px';
    $('send').disabled = !canSend || !input.value.trim();
  }
  $('question').addEventListener('input', () => {
    resizeComposer();
    send('draft', { text: $('question').value, sessionRevision });
  });
  $('followup').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('question').value.trim();
    if (text && !$('send').disabled) {
      send('ask', { text });
      $('question').value = '';
      resizeComposer();
    }
  });
  window.addEventListener('resize', resizeComposer);
  $('question').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $('followup').requestSubmit();
    }
  });
  let last = '',
    data = '',
    count = 0;
  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m?.token !== token || m.type !== 'state') return;
    $('history-panel').hidden = !m.historyVisible;
    if (!m.historyVisible) {
      deleteId = '';
      $('history-confirm').hidden = true;
    }
    const history = JSON.stringify([m.historyItems, m.activeSessionId]);
    if (history !== lastHistory) {
      lastHistory = history;
      $('history-list').replaceChildren();
      for (const item of m.historyItems || []) {
        const row = document.createElement('div');
        row.className = 'history-row' + (item.id === m.activeSessionId ? ' current' : '');
        const open = document.createElement('button');
        open.className = 'history-entry';
        const title = document.createElement('strong');
        title.textContent = item.name;
        const date = document.createElement('span');
        date.className = 'history-date';
        date.textContent = new Date(item.createdAt).toLocaleString('zh-CN', {
          timeZone: 'Asia/Shanghai',
          hour12: false
        });
        const preview = document.createElement('span');
        preview.className = 'history-preview';
        preview.textContent = item.preview;
        open.append(title, date, preview);
        open.addEventListener('click', () => send('historyRestore', { id: item.id }));
        const remove = document.createElement('button');
        remove.className = 'quiet history-remove';
        remove.textContent = '删除';
        remove.addEventListener('click', () => confirmDelete(item.id));
        row.append(open, remove);
        $('history-list').append(row);
      }
      $('history-empty').hidden = Boolean(m.historyItems?.length);
      $('history-delete-all').hidden = !m.historyItems?.length;
    }
    if (m.sessionRevision !== sessionRevision) {
      sessionRevision = m.sessionRevision;
      $('question').value = m.draft || '';
      last = '';
      count = 0;
      $('messages').replaceChildren();
    }
    $('model').textContent = m.model || '尚未配置';
    $('target').textContent = m.name;
    $('status').textContent = m.status || (m.configured ? '已配置 · 点击开始分析' : '先配置一次 API，即可随时分析。');
    $('analyze').textContent = m.messages.length ? '重新分析' : '开始分析';
    $('analyze').disabled = m.busy;
    $('stop').hidden = !m.busy;
    canSend = !m.busy && m.canAsk && m.configured;
    resizeComposer();
    // Drafts stay editable while streaming or after failure; only sending needs context.
    $('question').disabled = false;
    $('followup-hint').textContent = m.busy
      ? '可以先写下问题，等待回复结束或点击停止后发送。'
      : !m.configured
        ? '请先在设置中完成 API 配置，再开始分析。'
        : !m.canAsk
          ? '先完成一次分析；已收到部分回复时也可继续追问。'
          : m.interrupted
            ? '上次回复未完成，可输入“继续”补全，也可直接追问。'
            : '追问沿用本次行情；重新分析获取新数据。';
    $('welcome').hidden = m.messages.length > 0;
    $('snapshot').hidden = !m.snapshot;
    $('context-summary').textContent = (m.snapshot?.coverage || [])
      .map((item) => item.label + ' ' + item.detail)
      .join(' · ');
    $('context-summary').hidden = !m.snapshot?.coverage?.length;
    $('save-warning').textContent = m.saveWarning || '';
    $('save-warning').hidden = !m.saveWarning;
    const q = m.snapshot?.quote,
      daily = m.snapshot?.daily;
    const time = q?.timestamp
      ? String(q.timestamp).replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3 $4:$5:$6 北京')
      : '报价时间缺失';
    $('snapshot').querySelector('summary')!.textContent = m.snapshot
      ? `${q?.cached ? '缓存报价' : '行情快照'} · ${time}${daily?.date ? ' · 日K ' + daily.date : ''}`
      : '本次行情数据';
    const snapshot = m.snapshot ? JSON.stringify(m.snapshot, null, 2) : '';
    if (snapshot !== data) {
      $('data').textContent = snapshot;
      data = snapshot;
    }
    const encoded = JSON.stringify([m.messages, m.busy, m.status]);
    if (encoded !== last) {
      const box = $('conversation'),
        bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      if (m.messages.length < count) {
        $('messages').replaceChildren();
        count = 0;
      }
      m.messages.forEach((item, i) => {
        let article = $('messages').children[i];
        if (!article) {
          article = document.createElement('article');
          article.className = item.role;
          const label = document.createElement('div');
          label.className = 'role';
          label.textContent = item.role === 'user' ? '你' : '牛来盯盘';
          const notice = document.createElement('div');
          notice.className = 'result-notice';
          article.append(label, document.createElement('div'), notice);
          $('messages').append(article);
        }
        const pending =
          item.role === 'assistant' &&
          m.busy &&
          (item.state === 'pending' || (!item.state && i === m.messages.length - 1));
        const phases = {
          connecting: '正在连接 AI 服务…',
          waiting: '等待模型回复…',
          reasoning: '模型正在思考，尚未返回正文…',
          answering: '正在接收分析…'
        };
        const waiting = `${phases[item.phase] || phases.waiting}（${item.elapsedSeconds || 0} 秒）`;
        const fallback =
          item.notice || (item.state === 'stopped' ? '已停止分析。' : m.status || '未收到分析正文，请重新分析。');
        const content = item.content || (pending ? waiting : fallback);
        if ((article as HTMLElement).dataset.content !== content) {
          renderAnalysisText(article.children[1], content, item.role === 'assistant');
          (article as HTMLElement).dataset.content = content;
        }
        article.lastElementChild!.textContent = item.content ? (pending ? waiting : item.notice || '') : '';
        (article.lastElementChild as HTMLElement).hidden = !article.lastElementChild!.textContent;
      });
      if (bottom || m.messages.length > count) box.scrollTop = box.scrollHeight;
      count = m.messages.length;
      last = encoded;
    }
  });
  send('ready');
})();

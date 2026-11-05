(() => {
  'use strict';
  const vscode = acquireVsCodeApi(), token = document.body.dataset.token;
  const $ = id => document.getElementById(id), send = (type, rest = {}) => vscode.postMessage({ type, token, ...rest });
  for (const id of ['settings', 'choose', 'analyze', 'stop', 'clear']) $(id).addEventListener('click', () => send(id));
  $('followup').addEventListener('submit', event => { event.preventDefault(); const text = $('question').value.trim(); if (text && !$('send').disabled) { send('ask', { text }); $('question').value = ''; } });
  $('question').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('followup').requestSubmit(); } });
  let last = '', data = '', count = 0;
  // Use text nodes only: remote model output cannot execute HTML or command links.
  function renderText(element, text) {
    element.replaceChildren();
    for (const line of text.split('\n')) {
      const p = document.createElement('div');
      if (/^#{1,4}\s/.test(line)) { p.className = 'heading'; p.textContent = line.replace(/^#{1,4}\s+/, ''); }
      else {
        for (const part of line.split(/(\*\*[^*]+\*\*)/g)) { const span = document.createElement(part.startsWith('**') && part.endsWith('**') ? 'strong' : 'span'); span.textContent = span.tagName === 'STRONG' ? part.slice(2, -2) : part; p.append(span); }
      }
      element.append(p);
    }
  }
  window.addEventListener('message', event => {
    const m = event.data; if (m?.token !== token || m.type !== 'state') return;
    $('model').textContent = m.model || '尚未配置'; $('target').textContent = m.name;
    $('status').textContent = m.status || (m.configured ? '已配置 · 点击开始分析' : '先配置一次 API，即可随时分析。');
    $('analyze').textContent = m.messages.length ? '重新分析' : '开始分析'; $('analyze').disabled = m.busy;
    $('stop').hidden = !m.busy; $('send').disabled = m.busy || !m.canAsk; $('question').disabled = m.busy || !m.canAsk;
    $('welcome').hidden = m.messages.length > 0; $('snapshot').hidden = !m.snapshot;
    const q = m.snapshot?.quote, daily = m.snapshot?.daily;
    const time = q?.timestamp ? String(q.timestamp).replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3 $4:$5:$6 北京') : '报价时间缺失';
    $('snapshot').querySelector('summary').textContent = m.snapshot ? `${q?.cached ? '缓存报价' : '行情快照'} · ${time}${daily?.date ? ' · 日K ' + daily.date : ''}` : '本次行情数据';
    const snapshot = m.snapshot ? JSON.stringify(m.snapshot, null, 2) : '';
    if (snapshot !== data) { $('data').textContent = snapshot; data = snapshot; }
    const encoded = JSON.stringify(m.messages);
    if (encoded !== last) {
      const box = $('conversation'), bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      if (m.messages.length < count) { $('messages').replaceChildren(); count = 0; }
      m.messages.forEach((item, i) => {
        let article = $('messages').children[i];
        if (!article) { article = document.createElement('article'); article.className = item.role; const label = document.createElement('div'); label.className = 'role'; label.textContent = item.role === 'user' ? '你' : '牛来盯盘'; article.append(label, document.createElement('div')); $('messages').append(article); }
        if (article.dataset.content !== item.content) { renderText(article.lastElementChild, item.content || '正在思考…'); article.dataset.content = item.content; }
      });
      if (bottom || m.messages.length > count) box.scrollTop = box.scrollHeight;
      count = m.messages.length; last = encoded;
    }
  });
  send('ready');
})();

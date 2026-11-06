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
    $('stop').hidden = !m.busy; $('send').disabled = m.busy || !m.canAsk || !m.configured;
    // Drafts stay editable while streaming or after failure; only sending needs context.
    $('question').disabled = false;
    $('followup-hint').textContent = m.busy ? '可以先写下问题，等待回复结束或点击停止后发送。'
      : !m.configured ? '请先在设置中完成 API 配置，再开始分析。'
      : !m.canAsk ? '先完成一次分析；已收到部分回复时也可继续追问。'
      : m.interrupted ? '上次回复未完成，可输入“继续”补全，也可直接追问。' : '追问沿用本次行情；重新分析获取新数据。';
    $('welcome').hidden = m.messages.length > 0; $('snapshot').hidden = !m.snapshot;
    $('context-summary').textContent = (m.snapshot?.coverage || []).map(item => item.label + ' ' + item.detail).join(' · ');
    $('context-summary').hidden = !m.snapshot?.coverage?.length;
    const q = m.snapshot?.quote, daily = m.snapshot?.daily;
    const time = q?.timestamp ? String(q.timestamp).replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3 $4:$5:$6 北京') : '报价时间缺失';
    $('snapshot').querySelector('summary').textContent = m.snapshot ? `${q?.cached ? '缓存报价' : '行情快照'} · ${time}${daily?.date ? ' · 日K ' + daily.date : ''}` : '本次行情数据';
    const snapshot = m.snapshot ? JSON.stringify(m.snapshot, null, 2) : '';
    if (snapshot !== data) { $('data').textContent = snapshot; data = snapshot; }
    const encoded = JSON.stringify([m.messages, m.busy, m.status]);
    if (encoded !== last) {
      const box = $('conversation'), bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      if (m.messages.length < count) { $('messages').replaceChildren(); count = 0; }
      m.messages.forEach((item, i) => {
        let article = $('messages').children[i];
        if (!article) { article = document.createElement('article'); article.className = item.role; const label = document.createElement('div'); label.className = 'role'; label.textContent = item.role === 'user' ? '你' : '牛来盯盘'; const notice = document.createElement('div'); notice.className = 'result-notice'; article.append(label, document.createElement('div'), notice); $('messages').append(article); }
        const pending = item.role === 'assistant' && m.busy && (item.state === 'pending' || (!item.state && i === m.messages.length - 1));
        const phases = { connecting: '正在连接 AI 服务…', waiting: '等待模型回复…', reasoning: '模型正在思考，尚未返回正文…', answering: '正在接收分析…' };
        const waiting = `${phases[item.phase] || phases.waiting}（${item.elapsedSeconds || 0} 秒）`;
        const fallback = item.notice || (item.state === 'stopped' ? '已停止分析。' : m.status || '未收到分析正文，请重新分析。');
        const content = item.content || (pending ? waiting : fallback);
        if (article.dataset.content !== content) { renderText(article.children[1], content); article.dataset.content = content; }
        article.lastElementChild.textContent = item.content ? (pending ? waiting : item.notice || '') : '';
        article.lastElementChild.hidden = !article.lastElementChild.textContent;
      });
      if (bottom || m.messages.length > count) box.scrollTop = box.scrollHeight;
      count = m.messages.length; last = encoded;
    }
  });
  send('ready');
})();

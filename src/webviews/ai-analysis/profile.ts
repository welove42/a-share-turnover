/** 全局偏好与逐股持仓使用独立视图和保存动作，切股不切换用户画像。 */
export function profileView(send: (type: string, data?: object) => void) {
  const $ = (id: string) => document.getElementById('profile-' + id) as HTMLInputElement;
  let signature = '',
    wasVisible = false,
    holdingMode = false,
    state: any = {};
  const clearLabel = () => (holdingMode ? '清除本股持仓' : '清空画像');
  const layout = () => {
    $('title').textContent = holdingMode ? '个股持仓记录' : '全局用户画像';
    $('description').textContent = holdingMode
      ? '按股票独立保存，与全局用户画像分开。填写后仅在分析该股票时发送给 AI；可以留空。'
      : '所有个股分析共用一份画像。仅存本机，启用后发送给你配置的 AI 服务；浏览行为仅作参考。';
    $('general').hidden = holdingMode;
    $('holding').hidden = !holdingMode;
    $('toggle').textContent = holdingMode ? '返回全局画像' : '个股持仓';
    $('toggle').hidden = !state.target || state.target === 'market';
    $('clear').textContent = clearLabel();
    const p = state.profile || {},
      h = state.holding;
    $('note').textContent = holdingMode
      ? h?.at
        ? `${h.confirmed ? '用户已确认' : '从对话整理，待确认'} · ${h.at.slice(0, 10)}。请核对后保存。`
        : '未填写也可以分析，不会假定你已经买入。'
      : p.observation
        ? `AI观察（全局弱参考，${(p.observedAt || p.updatedAt || '').slice(0, 10)}）：${p.observation}`
        : '偏好尚未确认；可以主动告诉 AI 你的目标、周期和风险偏好。';
    for (const id of ['risk', 'horizon', 'goal']) $(id).disabled = !!state.busy || holdingMode;
    $('position').disabled = !!state.busy || !holdingMode;
    for (const id of ['cost', 'exposure'])
      $(id).disabled = !!state.busy || !holdingMode || $('position').value !== 'held';
    for (const id of ['save', 'clear']) $(id).disabled = !!state.busy;
  };
  $('close').addEventListener('click', () => send('profile'));
  $('panel').addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      send('profile');
    }
  });
  $('toggle').addEventListener('click', () => {
    holdingMode = !holdingMode;
    $('status').textContent = '';
    layout();
  });
  $('clear').addEventListener('click', () => {
    if ($('clear').textContent !== '确认清空') {
      $('clear').textContent = '确认清空';
      return;
    }
    send(holdingMode ? 'holdingClear' : 'profileClear', { symbol: state.target });
    $('clear').textContent = clearLabel();
  });
  $('panel').addEventListener('submit', (event) => {
    event.preventDefault();
    if (holdingMode)
      send('holdingSave', {
        symbol: state.target,
        value: {
          status: $('position').value,
          cost: $('cost').value.trim() ? Number($('cost').value) : null,
          exposure: $('exposure').value.trim() ? Number($('exposure').value) : null
        }
      });
    else send('profileSave', { value: { risk: $('risk').value, horizon: $('horizon').value, goal: $('goal').value } });
  });
  $('position').addEventListener('change', layout);
  return (message: any) => {
    const opened = message.profileVisible && !wasVisible,
      changedTarget = state.target !== message.target;
    state = message;
    $('panel').hidden = !message.profileVisible;
    $('status').textContent = message.profileStatus || '';
    if (opened) {
      holdingMode = false;
      $('close').focus();
    }
    if (!message.profileVisible && wasVisible) document.getElementById('profile')?.focus();
    if (changedTarget && (!message.target || message.target === 'market')) holdingMode = false;
    const next = JSON.stringify([message.profile, message.holding, message.target]);
    if (message.profileVisible && (opened || next !== signature)) {
      const p = message.profile || {},
        h = message.holding;
      // 只有画像本身变化或重新打开时才更新全局表单，切股不覆盖正在编辑的偏好。
      if (opened || JSON.stringify(p) !== JSON.stringify(JSON.parse(signature || '[null]')[0])) {
        $('risk').value = p.risk || 'unknown';
        $('horizon').value = p.horizon || 'unknown';
        $('goal').value = p.goal || '';
      }
      $('symbol').textContent = `${message.name || message.target || ''} · 持仓信息`;
      $('position').value = h?.status || 'unknown';
      $('cost').value = h?.cost == null ? '' : String(h.cost);
      $('exposure').value = h?.exposure == null ? '' : String(h.exposure);
      const interests = p.interests;
      $('interests').textContent = interests
        ? `关注股票：${
            (interests.stocks || [])
              .slice(0, 8)
              .map((s) => `${s.name}（${s.industry}）`)
              .join('、') || '暂无'
          }\n关注板块：${
            (interests.sectors || [])
              .slice(0, 6)
              .map((s) => s.name)
              .join('、') || '尚无已确认归属'
          }\n来自自选与近期浏览，不代表已持仓。`
        : '近期关注：暂无记录。';
      signature = next;
    }
    // 普通流式刷新保留二次清空确认状态。
    const confirming = $('clear').textContent === '确认清空';
    layout();
    if (confirming && wasVisible && !opened) $('clear').textContent = '确认清空';
    wasVisible = !!message.profileVisible;
  };
}

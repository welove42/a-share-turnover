export function profileView(send: (type: string, data?: object) => void) {
  const $ = (id: string) => document.getElementById('profile-' + id) as HTMLInputElement;
  let signature = '',
    wasVisible = false;
  $('close').addEventListener('click', () => send('profile'));
  $('panel').addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      send('profile');
    }
  });
  $('clear').addEventListener('click', () => {
    if ($('clear').textContent !== '确认清空') {
      $('clear').textContent = '确认清空';
      return;
    }
    send('profileClear');
    $('clear').textContent = '清空画像';
  });
  $('panel').addEventListener('submit', (event) => {
    event.preventDefault();
    send('profileSave', {
      value: {
        risk: $('risk').value,
        horizon: $('horizon').value,
        goal: $('goal').value,
        holding: {
          status: $('position').value,
          cost: $('cost').value.trim() ? Number($('cost').value) : null,
          exposure: $('exposure').value.trim() ? Number($('exposure').value) : null
        }
      }
    });
  });
  const position = () => {
    for (const id of ['cost', 'exposure']) $(id).disabled = $('position').value !== 'held';
  };
  $('position').addEventListener('change', position);
  return (message: any) => {
    $('panel').hidden = !message.profileVisible;
    $('status').textContent = message.profileStatus || '';
    if (message.profileVisible && !wasVisible) $('close').focus();
    if (!message.profileVisible && wasVisible) document.getElementById('profile')?.focus();
    if (!message.profileVisible) $('clear').textContent = '清空画像';
    const next = JSON.stringify([message.profile, message.target]);
    if (message.profileVisible && (!wasVisible || next !== signature)) {
      const p = message.profile || {};
      $('risk').value = p.risk || 'unknown';
      $('horizon').value = p.horizon || 'unknown';
      $('goal').value = p.goal || '';
      $('holding').hidden = !message.target || message.target === 'market';
      $('symbol').textContent = `${message.name || message.target || ''} · 持仓信息`;
      $('position').value = p.holding?.status || 'unknown';
      $('cost').value = p.holding?.cost == null ? '' : String(p.holding.cost);
      $('exposure').value = p.holding?.exposure == null ? '' : String(p.holding.exposure);
      $('note').textContent =
        (p.observation
          ? `AI观察（弱参考，${(p.observedAt || p.updatedAt || '').slice(0, 10)}）：${p.observation}\n`
          : '') +
        (p.holding?.at
          ? `${p.holding.confirmed ? '用户已确认' : '从对话整理，待确认'} · ${p.holding.at.slice(0, 10)}。请核对后保存。`
          : '未填写持仓也可以分析，不会假定你已经买入。');
      position();
      signature = next;
    }
    for (const id of ['risk', 'horizon', 'goal', 'position', 'save', 'clear']) $(id).disabled = !!message.busy;
    if (message.busy) {
      $('cost').disabled = true;
      $('exposure').disabled = true;
    } else position();
    wasVisible = !!message.profileVisible;
  };
}

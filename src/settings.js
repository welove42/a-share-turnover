'use strict';
const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { normalizeDate } = require('./market');
const manifest = require('../package.json');
const properties = manifest.contributes.configuration.properties;
const GROUPS = [
  { id: 'market', title: '状态栏与市场', keys: ['enabled', 'comparisonMode', 'showDifferenceAmount', 'colorMode', 'sectors.enabled', 'sectors.category', 'temperature.enabled', 'temperature.colorize'] },
  { id: 'stocks', title: '自选与图表', keys: ['stocks.enabled', 'stocks.symbols', 'stocks.hkSymbols', 'stocks.usSymbols', 'stocks.statusBarSymbol', 'stocks.sortBy', 'charts.defaultMode'] },
  { id: 'assets', title: '指数、基金与商品', keys: ['globalIndices.enabled', 'globalIndices.symbols', 'funds.enabled', 'funds.symbols', 'commodities.enabled', 'commodities.symbols'] },
  { id: 'news', title: '财经新闻', keys: ['news.enabled', 'news.source', 'news.refreshIntervalSeconds'], actions: ['news.setToken'] },
  { id: 'risk', title: '涨跌提醒与风险', keys: ['stockAlerts.mode', 'risk.enabled', 'risk.volumePercent', 'risk.dropPercent'] },
  { id: 'events', title: '大事提醒与休市', keys: ['reminders.enabled', 'reminders.notifications', 'reminders.categories', 'additionalClosedDates'] }
];
const LABELS = {
  'stockAlerts.mode': '自选股涨跌超过 7% 时提醒',
  enabled: '显示成交额', comparisonMode: '放量 / 缩量比较方式', showDifferenceAmount: '显示成交额差值', colorMode: '成交额颜色',
  'sectors.enabled': '显示领涨板块', 'sectors.category': '板块类型', 'temperature.enabled': '显示市场温度', 'temperature.colorize': '温度使用颜色区分',
  'stocks.enabled': '启用自选行情', 'stocks.symbols': 'A 股自选', 'stocks.hkSymbols': '港股自选', 'stocks.usSymbols': '美股自选', 'stocks.statusBarSymbol': '底部显示的股票 / 指数', 'stocks.sortBy': '自选排序', 'charts.defaultMode': '默认图表',
  'globalIndices.enabled': '显示全球指数', 'globalIndices.symbols': '关注的指数', 'funds.enabled': '显示基金', 'funds.symbols': '关注的基金', 'commodities.enabled': '显示全球商品', 'commodities.symbols': '关注的商品',
  'news.enabled': '启用新闻', 'news.source': '新闻来源', 'news.refreshIntervalSeconds': '刷新间隔（秒）',
  'risk.enabled': '启用风险提示', 'risk.volumePercent': '成交额变化阈值（%）', 'risk.dropPercent': '上证跌幅阈值（%）',
  'reminders.enabled': '显示大事倒计时', 'reminders.notifications': '启用事件弹窗', 'reminders.categories': '提醒哪些大事', additionalClosedDates: '补充休市日期'
};
const HELP = {
  'stockAlerts.mode': '覆盖 A 股、港股和美股。当天同一股票同一方向只提醒一次；“一直提醒”在老板键开启时仍监测并弹窗。关闭自选行情或暂停刷新时不监测。',
  enabled: '底部显示沪深 A 股成交额。市场温度和风险提示需要此项。', comparisonMode: '昨日指上一个交易日。', showDifferenceAmount: '在百分比后显示增加或减少了多少亿元。', colorMode: '选择默认颜色或红增绿减。',
  'sectors.enabled': '显示涨幅第一的板块，悬停看前十。', 'sectors.category': '选择行业或概念板块排行。', 'temperature.enabled': '查看市场冷热和当天走势，需要开启成交额。', 'temperature.colorize': '偏热用红色，偏冷用蓝色。',
  'stocks.enabled': '启用侧栏自选和底部股票行情。', 'stocks.statusBarSymbol': '可选择上证指数或已添加的 A 股自选。', 'stocks.sortBy': '选择手动顺序时，可在侧栏拖动个股排序。', 'charts.defaultMode': '下次新打开详情标签时使用；已经打开的标签保留当前图表。',
  'globalIndices.enabled': '启用全球指数栏目。', 'funds.enabled': '启用净值和持仓收益栏目。', 'commodities.enabled': '启用黄金、原油等商品栏目。',
  'news.enabled': '底部显示新闻入口，点击打开资讯面板。', 'news.source': '东方财富无需登录；选股宝需设置自己的登录 Token。', 'news.refreshIntervalSeconds': '10–300 秒；休市期间也会更新。',
  'risk.enabled': '需同时开启成交额和自选行情。放缩量与上证跌幅同时达到阈值时提示。', 'risk.volumePercent': '例如 30，表示成交额比昨日同刻增加或减少至少 30%。', 'risk.dropPercent': '例如 1.5，表示上证指数下跌至少 1.5%。',
  'reminders.enabled': '在底部显示最近事件，点击看日历。', 'reminders.notifications': '事件前 24 小时和 30 分钟提醒；仅在 VS Code 运行时生效。', 'reminders.categories': '勾选要关注的事件。', additionalClosedDates: '每行一个日期，例如 2026-12-31；只填写额外休市日。'
};
const OPTIONS = {
  comparisonMode: ['昨日同一时刻', '昨日全天'], colorMode: ['默认颜色', '放量红色 / 缩量绿色'],
  'charts.defaultMode': ['内置分时', '内置五日分时', '1 分钟 K 线', '5 分钟 K 线', '15 分钟 K 线', '30 分钟 K 线', '60 分钟 K 线', '日 K', '周 K', '月 K', '东方财富图表', '东方财富筹码盘口'],
  'news.source': ['东方财富', '选股宝']
};
const ACTIONS = { 'news.setToken': '设置选股宝登录 Token' };
const ADD_LABELS = { 'stocks.symbols': '添加 A 股', 'stocks.hkSymbols': '添加港股', 'stocks.usSymbols': '添加美股', 'globalIndices.symbols': '添加指数', 'funds.symbols': '添加基金', 'commodities.symbols': '添加商品' };
const LISTS = new Set(['stocks.symbols', 'stocks.hkSymbols', 'stocks.usSymbols', 'globalIndices.symbols', 'funds.symbols', 'commodities.symbols']);
function schema(key) { return properties['aShareTurnover.' + key]; }
function validate(key, value, read) {
  const s = schema(key);
  if (!Object.hasOwn(LABELS, key) || LISTS.has(key)) throw new Error('不支持修改此设置');
  if (s.type === 'boolean' && typeof value !== 'boolean' || s.type === 'string' && typeof value !== 'string') throw new Error('设置值格式不正确');
  if (['number', 'integer'].includes(s.type) && (typeof value !== 'number' || !Number.isFinite(value) || s.type === 'integer' && !Number.isInteger(value) || value < s.minimum || value > s.maximum)) throw new Error(`请输入 ${s.minimum}–${s.maximum} 之间的${s.type === 'integer' ? '整数' : '数值'}`);
  if (s.enum && !s.enum.includes(value)) throw new Error('请选择有效选项');
  if (s.type === 'array') {
    if (!Array.isArray(value) || value.length > 366 || value.some(v => typeof v !== 'string')) throw new Error('列表格式不正确');
    if (key === 'reminders.categories' && value.some(v => !s.items.enum.includes(v))) throw new Error('未知事件类型');
    if (key === 'additionalClosedDates') for (const date of value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期请使用 YYYY-MM-DD'); normalizeDate(date); }
    value = [...new Set(value)];
  }
  if (key === 'stocks.statusBarSymbol' && value !== 'sh000001' && !read('stocks.symbols').includes(value)) throw new Error('请先添加这只自选股');
  return value;
}
function settingsHtml(webview, context, token) {
  const uri = name => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', name));
  const nonce = randomBytes(18).toString('base64');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';"><link rel="stylesheet" href="${uri('settings.css')}"><title>行情设置</title></head><body data-token="${token}"><header><div><h1>行情设置</h1><p>按你的习惯安排看盘。</p></div><span id="save-status" role="status" aria-live="polite">正在加载…</span></header><div class="layout"><nav id="categories" aria-label="设置分类"></nav><main><label class="search"><span>搜索设置</span><input id="search" type="search" placeholder="搜索设置，例如：板块、图表、提醒" autocomplete="off"></label><p class="hint">修改自动保存 · 老板键 Ctrl+Shift+; 可隐藏行情和设置页</p><p id="dependencies" role="status"></p><div id="sections"></div><p id="empty" hidden>没有匹配的设置</p></main></div><script nonce="${nonce}" src="${uri('settings.js')}"></script></body></html>`;
}
class SettingsController {
  constructor(context, { stocks, actions = {}, lists = {}, sources = [] } = {}) {
    this.context = context; this.stocks = stocks; this.actions = actions; this.lists = lists; this.queue = Promise.resolve();
    this.listener = vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('aShareTurnover')) this.publish(); });
    this.listListeners = sources.map(source => source.onDidChangeTreeData(() => this.publish()));
  }
  read(key) { if (LISTS.has(key) && this.lists[key]) return this.lists[key].ids(); return key.startsWith('stocks.') && key !== 'stocks.enabled' && this.stocks ? this.stocks.settings.get(key, schema(key).default) : vscode.workspace.getConfiguration('aShareTurnover').get(key, schema(key).default); }
  model() {
    return GROUPS.map(group => ({ ...group, actions: (group.actions || []).map(id => ({ id, label: ACTIONS[id] })), fields: group.keys.map(key => {
      const s = schema(key), c = vscode.workspace.getConfiguration('aShareTurnover').inspect?.(key);
      const options = key === 'stocks.statusBarSymbol' ? [...new Set(['sh000001', ...this.read('stocks.symbols')])].map(value => ({ value, label: value === 'sh000001' ? '上证指数' : `${this.lists['stocks.symbols']?.name(value) || this.stocks?.quotes.get(value)?.name || '名称待获取'} · ${value}` }))
        : (s.enum || s.items?.enum || []).map((value, i) => ({ value, label: OPTIONS[key]?.[i] || (s.enumDescriptions || s.items?.enumDescriptions)?.[i] || value }));
      return { key, label: LABELS[key], help: HELP[key] || '', type: LISTS.has(key) ? 'list' : key === 'additionalClosedDates' ? 'dates' : options.length ? s.type === 'array' ? 'checks' : 'select' : s.type, options, min: s.minimum, max: s.maximum, value: this.read(key), workspace: c?.workspaceValue !== undefined,
        ...(LISTS.has(key) ? { addLabel: ADD_LABELS[key], canEdit: Boolean(this.lists[key]?.edit), items: this.read(key).map(id => ({ id, name: this.lists[key]?.name(id) || '名称待获取' })) } : {}) };
    }) }));
  }
  publish(force = false) { if (this.panel && !this.hidden && !this.disposed) { const groups = this.model(), signature = JSON.stringify(groups); if (!force && signature === this.signature) return; this.signature = signature; void this.panel.webview.postMessage({ type: 'state', token: this.token, groups }); } }
  open() {
    if (this.hidden || this.disposed) return;
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Active); this.publish(true); return; }
    const panel = this.panel = vscode.window.createWebviewPanel('welove42.aShareTurnover.settings', '行情设置', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
    const token = this.token = randomBytes(24).toString('hex');
    panel.webview.html = settingsHtml(panel.webview, this.context, token);
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = null; });
    panel.webview.onDidReceiveMessage(message => {
      if (!message || message.token !== token || this.panel !== panel || this.hidden || this.disposed) return;
      if (message.type === 'ready') { this.publish(true); return; }
      this.queue = this.queue.catch(() => {}).then(async () => {
        if (this.panel !== panel || this.hidden || this.disposed) return;
        try {
          if (message.type === 'list') {
            const list = LISTS.has(message.key) && this.lists[message.key];
            if (!list || !['add', 'remove', 'edit'].includes(message.operation) || typeof list[message.operation] !== 'function') throw new Error('不支持此列表操作');
            if (message.operation !== 'add' && (typeof message.id !== 'string' || !list.ids().includes(message.id))) throw new Error('该项目已不在列表中，请重试');
            await list[message.operation](message.operation === 'add' ? undefined : message.id);
          } else if (message.type === 'action') {
            if (!Object.hasOwn(ACTIONS, message.action) || typeof this.actions[message.action] !== 'function') throw new Error('未知操作');
            await this.actions[message.action]();
          } else if (message.type === 'save' || message.type === 'reset') {
            const value = validate(message.key, message.type === 'reset' ? schema(message.key)?.default : message.value, key => this.read(key));
            if (message.key.startsWith('stocks.') && message.key !== 'stocks.enabled' && this.stocks) await this.stocks.updateSetting(message.key, value);
            else {
              const c = vscode.workspace.getConfiguration('aShareTurnover');
              const target = c.inspect?.(message.key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
              await c.update(message.key, value, target);
            }
          } else return;
          if (this.panel === panel && !this.hidden) { await panel.webview.postMessage({ type: 'result', token, key: message.key, action: message.action, ok: true }); this.publish(true); }
        } catch (error) { if (this.panel === panel && !this.hidden) void panel.webview.postMessage({ type: 'result', token, key: message.key, action: message.action, ok: false, error: error.message || '保存失败，请重试' }); }
      });
    });
  }
  setHidden(hidden) { this.hidden = hidden; if (hidden) this.panel?.dispose(); }
  dispose() { this.disposed = true; this.panel?.dispose(); this.listener.dispose(); for (const listener of this.listListeners) listener.dispose(); }
}
module.exports = { SettingsController, validate, GROUPS, LISTS };

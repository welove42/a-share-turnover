'use strict';
const vscode = require('vscode');
const { shanghaiClock } = require('./market');
const { signed, percentText } = require('./quotes');
const { StockSettings } = require('./stock-settings');
const { FUND_POLL_MS, fundCode, fundCodes, isFundQuote, holdingPosition, holdingReturn, FundProvider, fundUrl } = require('./fund-data');

class FundsController {
  constructor(context, { provider = new FundProvider(), now = () => new Date(), log = () => {} } = {}) {
    this.context = context; this.provider = provider; this.now = now; this.log = log;
    this.settings = new StockSettings(context, message => log(message.replace('自选股设置', '基金列表设置')));
    this.quotes = new Map(); this.errors = new Map(); this.elements = new Map(); this.signatures = new Map();
    this.disposed = false; this.cached = true; this.inflight = null; this.abort = null; this.lastAttempt = -Infinity; this.generation = 0;
    this.paused = Boolean(context.globalState.get('fundsPaused', false));
    const cache = context.globalState.get('fundQuotes', []);
    if (Array.isArray(cache)) for (const q of cache) if (isFundQuote(q)) this.quotes.set(q.code, q);
    this.holdings = {}; this.holdingWrite = Promise.resolve();
    const saved = context.globalState.get('fundHoldings', {});
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) for (const [code, position] of Object.entries(saved)) {
      try { this.holdings[fundCode(code)] = holdingPosition(position); } catch { /* Ignore damaged local records. */ }
    }
    this.readConfig(); this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event;
    this.tree = vscode.window.createTreeView('welove42.aShareTurnover.funds', { treeDataProvider: this });
    this.listeners = [this.tree.onDidChangeVisibility(event => {
      this.publish();
      if (!event.visible) this.abort?.abort(); else if (!this.paused) void this.refresh(true);
    }), vscode.workspace.onDidChangeConfiguration(event => {
      if (this.writingSettings || !event.affectsConfiguration('aShareTurnover.funds')) return;
      this.generation++; this.abort?.abort(); this.readConfig(); this.publish(true);
      if (!this.paused) void this.refresh(true);
    })];
  }
  readConfig() {
    this.enabled = vscode.workspace.getConfiguration('aShareTurnover').get('funds.enabled', true); this.configError = '';
    try { this.symbols = fundCodes(this.settings.get('funds.symbols', [])); }
    catch (error) { this.configError = error.message; this.symbols ||= []; }
  }
  start() {
    this.publish(true); this.timer = setInterval(() => void this.tick(), 1000);
    if (!this.paused) void this.refresh();
  }
  tick() {
    if (!this.disposed && this.enabled && this.symbols.length && !this.paused && this.tree.visible && !this.inflight && this.now().getTime() - this.lastAttempt >= FUND_POLL_MS) return this.refresh(true);
  }
  getChildren(element) { return !element && this.enabled ? this.symbols.map(code => this.element(code)) : []; }
  getParent() { return undefined; }
  element(code) { if (!this.elements.has(code)) this.elements.set(code, { kind: 'fund', code }); return this.elements.get(code); }
  getTreeItem(element) {
    const code = element.code, q = this.quotes.get(code), position = this.holdings[code], income = holdingReturn(q, position), failed = this.errors.has(code);
    const label = !q ? `—   —   [${code}]` : q.kind === 'money'
      ? `${q.incomeUnit === 10000 ? '万份' : '百份'}收益 ${q.incomePerUnit.toFixed(4)}   [${q.name}]`
      : `${percentText(q.percent).padStart(7)}   ${q.nav.toFixed(4)}   [${q.name}]`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `fund:${code}`; item.contextValue = 'aShareFund';
    const detail = income ? `持仓 ${signed(income.profit)} (${percentText(income.rate)})` : q?.kind === 'money' ? `七日年化 ${percentText(q.sevenDayYield)}` : position ? '持仓待计算' : '可设置持仓';
    item.description = `${failed ? '获取失败 · ' : this.cached && q ? '缓存 · ' : ''}${q?.date || '待公布'} · ${detail}`;
    item.command = { command: 'welove42.aShareTurnover.funds.open', title: '查看基金详情', arguments: [code] };
    item.iconPath = failed ? new vscode.ThemeIcon('warning') : q?.kind === 'money' ? new vscode.ThemeIcon('pie-chart')
      : new vscode.ThemeIcon(q?.percent > 0 ? 'chevron-up' : q?.percent < 0 ? 'chevron-down' : 'dash',
        q?.percent > 0 ? new vscode.ThemeColor('charts.red') : q?.percent < 0 ? new vscode.ThemeColor('charts.green') : undefined);
    const tip = new vscode.MarkdownString(); tip.isTrusted = false; tip.supportHtml = false;
    tip.appendText(`${q?.name || code}（${code}）\n类型：${q?.type || '待查询'}\n\n`);
    if (!q) tip.appendText('尚未获取已公布数据。');
    else if (q.kind === 'money') tip.appendText(`${q.incomeUnit === 10000 ? '每万份' : '每百份'}收益：${q.incomePerUnit.toFixed(4)}\n七日年化：${percentText(q.sevenDayYield)}\n收益日期：${q.date}\n货币基金不按单位净值计算持仓盈亏；当前只展示基金已公布的收益指标。`);
    else {
      tip.appendText(`单位净值：${q.nav.toFixed(4)}\n净值日涨跌：${percentText(q.percent)}\n累计净值：${q.cumulativeNav === null ? '—' : q.cumulativeNav.toFixed(4)}\n净值日期：${q.date}`);
      if (income) tip.appendText(`\n\n持仓份额：${income.shares}\n持仓总成本：${income.cost.toFixed(2)}\n按净值计算的市值：${income.value.toFixed(2)}\n持仓收益：${signed(income.profit)}\n持仓收益率：${percentText(income.rate)}\n计算依据：${income.date}已公布净值。\n持仓收益 = 份额 × 单位净值 − 持仓总成本。金额与净值同币种，未换汇。分红、份额变动及费用需自行更新份额和成本；不包含已赎回部分收益。`);
      else tip.appendText('\n\n点击行末铅笔设置持仓份额、持仓总成本，可查看个人持仓收益。');
    }
    tip.appendText('\n\n来源：天天基金 / 东方财富。公布日期不等于今天；页面显示已公布数据，不提供盘中估算。');
    if (this.cached && q) tip.appendText('\n当前为重启前保存的缓存。');
    if (this.paused) tip.appendText('\n自动检查已暂停。');
    if (failed) tip.appendText('\n' + this.errors.get(code));
    tip.appendText('\n点击打开基金详情；右键可编辑或清除持仓，移出列表。'); item.tooltip = tip;
    item.accessibilityInformation = { label: `${label}，${item.description}` };
    return item;
  }
  publish(structural = false) {
    if (this.disposed) return;
    const description = !this.enabled ? '已禁用' : this.paused ? '已暂停' : !this.symbols.length ? '点击＋添加基金' : this.tree.visible ? '已公布净值 · 60秒检查' : '展开后检查净值';
    if (this.tree.description !== description) this.tree.description = description;
    const failed = this.symbols.filter(code => this.errors.has(code)).length;
    const message = this.configError || (failed ? `${failed}只基金未更新，保留上次数据；悬停查看原因及净值日期。` : undefined);
    if (this.tree.message !== message) this.tree.message = message;
    const changed = [];
    for (const code of this.symbols) {
      const signature = JSON.stringify([this.quotes.get(code), this.errors.get(code), this.holdings[code], this.paused, this.cached]);
      if (this.signatures.get(code) !== signature) { this.signatures.set(code, signature); changed.push(code); }
    }
    if (structural) this.emitter.fire(undefined); else for (const code of changed) this.emitter.fire(this.element(code));
  }
  refresh(automatic = false) {
    if (this.disposed || !this.enabled || !this.symbols.length || automatic && (this.paused || !this.tree.visible)) return Promise.resolve();
    if (this.inflight && this.abort?.signal.aborted) return this.inflight.then(() => this.refresh(automatic));
    if (this.inflight) return this.inflight;
    const codes = [...this.symbols], generation = this.generation, abort = this.abort = new AbortController();
    this.lastAttempt = this.now().getTime();
    this.inflight = (async () => {
      try {
        const result = await this.provider.load(codes, abort.signal);
        if (this.disposed || abort.signal.aborted || this.generation !== generation) return;
        this.errors = new Map(result.errors);
        for (const code of codes) {
          const q = result.quotes.get(code);
          if (!q) { this.errors.set(code, this.errors.get(code) || '本次未返回该基金净值'); continue; }
          if (isFundQuote(q) && q.code === code && q.date <= shanghaiClock(this.now()).date && (!this.quotes.has(code) || q.date >= this.quotes.get(code).date)) this.quotes.set(code, q);
          else this.errors.set(code, '基金数据或净值日期异常，保留上次成功数据');
        }
        this.cached = false;
        await this.context.globalState.update('fundQuotes', codes.map(code => this.quotes.get(code)).filter(Boolean)).catch(() => {});
      } catch (error) {
        if (!this.disposed && !abort.signal.aborted) { for (const code of codes) this.errors.set(code, error.message || '基金请求失败'); this.log('基金净值请求失败'); }
      } finally { this.inflight = null; this.abort = null; if (!this.disposed) this.publish(); }
    })();
    return this.inflight;
  }
  async saveSymbols(values) {
    const codes = fundCodes(values); this.writingSettings = (this.writingSettings || 0) + 1;
    try { await this.settings.set('funds.symbols', codes); } finally { this.writingSettings--; }
    if (this.disposed) return;
    this.generation++; this.abort?.abort(); this.readConfig(); this.publish(true);
    if (!this.paused) void this.refresh(true);
  }
  async add(input) {
    if (this.disposed || !this.enabled) return;
    if (typeof input !== 'string' && !Array.isArray(input)) return this.searchAndAdd();
    try {
      let codes;
      try { codes = fundCodes(input); }
      catch (error) { if (typeof input === 'string' && input.trim() && !/[,，;；]/.test(input)) return this.searchAndAdd(input); throw error; }
      await this.saveSymbols([...this.symbols, ...codes]);
    } catch (error) { return vscode.window.showErrorMessage(error.message); }
  }
  searchAndAdd(initial = '') {
    const picker = vscode.window.createQuickPick();
    picker.title = '搜索并添加基金'; picker.placeholder = '输入基金名称、拼音或六位代码；例如 沪深300 / 110020。完整代码可用逗号批量添加';
    picker.matchOnDescription = true; picker.matchOnDetail = true; picker.ignoreFocusOut = true;
    let timer, request, generation = 0, closed = false, accepting = false;
    const update = value => {
      const current = ++generation; request?.abort(); clearTimeout(timer); picker.busy = false; picker.items = []; picker.activeItems = [];
      if (!value.trim()) return;
      let direct; try { direct = fundCodes(value); } catch { /* Names and partial codes need lookup. */ }
      if (direct?.length) { picker.items = [{ label: `添加 ${direct.join('、')}`, codes: direct, alwaysShow: true }]; picker.activeItems = [picker.items[0]]; }
      timer = setTimeout(async () => {
        if (closed || this.disposed || direct?.length > 1) return;
        const abort = request = new AbortController(); picker.busy = true;
        try {
          const rows = await this.provider.search(value.trim(), abort.signal);
          if (closed || this.disposed || abort.signal.aborted || current !== generation) return;
          const candidates = rows.map(row => ({ label: row.name, description: `${row.code} · ${row.type}${this.symbols.includes(row.code) ? ' · 已添加' : ''}`, detail: row.pinyin, codes: [row.code], alwaysShow: true }));
          picker.items = candidates.length ? candidates : direct?.length ? picker.items : [{ label: '未找到基金，请换一个名称或完整六位代码', alwaysShow: true }];
          picker.activeItems = picker.items[0]?.codes ? [picker.items[0]] : [];
        } catch (error) {
          if (!closed && !abort.signal.aborted && current === generation && !direct?.length) picker.items = [{ label: '搜索失败，可重新输入或直接添加完整代码', detail: error.message, alwaysShow: true }];
        } finally { if (!closed && current === generation) picker.busy = false; }
      }, 300);
    };
    return new Promise(resolve => {
      const listeners = [picker.onDidChangeValue(update), picker.onDidAccept(async () => {
        const item = picker.selectedItems[0] || picker.activeItems?.[0]; if (!item?.codes || accepting) return;
        accepting = true;
        try { await this.saveSymbols([...this.symbols, ...item.codes]); picker.hide(); }
        catch (error) { accepting = false; void vscode.window.showErrorMessage(error.message); }
      }), picker.onDidHide(() => {
        closed = true; request?.abort(); clearTimeout(timer); for (const listener of listeners) listener.dispose(); picker.dispose(); if (this.activePicker === picker) this.activePicker = null; resolve();
      })];
      this.activePicker?.hide(); this.activePicker = picker; picker.value = initial; picker.show(); update(initial);
    });
  }
  async chooseCode(element, title) {
    const raw = typeof element === 'string' ? element : element?.code;
    if (raw !== undefined) { try { const code = fundCode(raw); return this.symbols.includes(code) ? code : undefined; } catch { return undefined; } }
    const selected = await vscode.window.showQuickPick(this.symbols.map(code => ({ label: this.quotes.get(code)?.name || code, description: code, code })), { title });
    return selected?.code;
  }
  async remove(element) {
    const code = await this.chooseCode(element, '移出基金列表');
    if (code && !this.disposed) await this.saveSymbols(this.symbols.filter(item => item !== code));
  }
  saveHolding(code, position) {
    const next = position === null ? null : holdingPosition(position);
    const write = this.holdingWrite.catch(() => {}).then(async () => {
      if (this.disposed || !this.enabled || !this.symbols.includes(code)) return;
      const holdings = { ...this.holdings }; if (next === null) delete holdings[code]; else holdings[code] = next;
      // Private position data stays in local extension storage, never settings or quote requests.
      await this.context.globalState.update('fundHoldings', holdings);
      this.holdings = holdings; this.publish();
    });
    this.holdingWrite = write; return write;
  }
  async editHolding(element) {
    const code = await this.chooseCode(element, '选择基金并设置持仓');
    if (!code || this.disposed || !this.enabled) return;
    if (!this.quotes.has(code)) await this.refresh();
    if (this.disposed || !this.symbols.includes(code)) return;
    const q = this.quotes.get(code);
    if (!q) return vscode.window.showErrorMessage('请先成功获取该基金净值，再设置持仓');
    if (q.kind === 'money') return vscode.window.showErrorMessage('货币基金已显示万份收益和七日年化；累计持仓收益需要交易流水，本版不按净值估算货币基金盈亏。');
    const current = this.holdings[code];
    const validate = (value, field) => { try { holdingPosition({ shares: 1, cost: 1, [field]: value }); return undefined; } catch (error) { return error.message; } };
    const shares = await vscode.window.showInputBox({ title: `${q.name} · 持仓份额（1/2）`, prompt: '填写当前已确认的持仓份额；申购、赎回或分红再投资后需更新。清除持仓请用右键菜单。', value: current ? String(current.shares) : '', ignoreFocusOut: true, validateInput: value => validate(value, 'shares') });
    if (shares === undefined || this.disposed || !this.symbols.includes(code)) return;
    const cost = await vscode.window.showInputBox({ title: `${q.name} · 持仓总成本（2/2）`, prompt: '填写剩余持仓的总成本（含费用，非单位成本），币种应与基金净值一致；已收现金分红可自行从成本扣除。', value: current ? String(current.cost) : '', ignoreFocusOut: true, validateInput: value => validate(value, 'cost') });
    if (cost === undefined || this.disposed || !this.symbols.includes(code)) return;
    try { await this.saveHolding(code, { shares, cost }); } catch (error) { return vscode.window.showErrorMessage(error.message); }
  }
  async clearHolding(element) {
    const code = await this.chooseCode(element, '清除基金持仓（保留关注）');
    if (code && !this.disposed) return this.saveHolding(code, null);
  }
  async open(element) {
    const code = await this.chooseCode(element, '查看基金详情');
    if (code && !this.disposed) return vscode.env.openExternal(vscode.Uri.parse(fundUrl(code)));
  }
  async togglePause() {
    this.paused = !this.paused; if (this.paused) this.abort?.abort();
    await this.context.globalState.update('fundsPaused', this.paused); this.publish();
    if (!this.paused) return this.refresh(true);
  }
  dispose() {
    this.disposed = true; clearInterval(this.timer); this.abort?.abort(); this.activePicker?.hide();
    for (const listener of this.listeners) listener.dispose(); this.tree.dispose(); this.emitter.dispose();
  }
}
module.exports = { FundsController };

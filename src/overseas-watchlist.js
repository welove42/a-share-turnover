'use strict';
const vscode = require('vscode');
const privateUI = require('./privacy-ui');
const { requestQuoteText } = require('./http');
const { percentText, signed, orderedSymbols } = require('./quotes');
const { trendIcon } = require('./trend-icon');
const { normalizeDate, timeToMinute } = require('./market');
const { normalizeOverseas } = require('./overseas-symbols');
const { parseMarketSuggestions } = require('./stock-search');
const { StockGroups, normalizeGroups, UNGROUPED } = require('./stock-groups');
const { UsExtendedProvider, usClock, validExtended } = require('./us-extended');

function parseOverseasSearch(text, market) {
  return parseMarketSuggestions(text).filter(item => item.market === market).map(({symbol,name,pinyin})=>({symbol,name,pinyin}));
}
function parseOverseasQuotes(text, market, symbols) {
  const wanted = new Set(symbols), quotes = new Map(), errors = new Map();
  for (const match of text.matchAll(/v_(hk\d{5}|us[A-Z][A-Z0-9.]{0,14})="([^"\r\n]*)"\s*;?/g)) {
    const symbol = match[1]; if (!wanted.has(symbol)) continue;
    try {
      const q = match[2].split('~'), expected = market === 'hk' ? symbol.slice(2) : symbol.slice(2);
      if (!q[1] || (market === 'hk' ? q[2] !== expected : normalizeOverseas(q[2], 'us') !== symbol)) throw new Error('行情代码不匹配');
      const t = (q[30] || '').match(/^(\d{4})[-/](\d{2})[-/](\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
      if (!t) throw new Error('行情时间缺失');
      const date = normalizeDate(t[1]+t[2]+t[3]), timestamp = t.slice(1).join('');
      timeToMinute(t[4]+t[5]); if (Number(t[6]) > 59) throw new Error('行情时间无效');
      const n = x => /^[-+]?\d+(?:\.\d+)?$/.test(x || '') && Number.isFinite(Number(x)) ? Number(x) : null;
      const price = n(q[3]), previousClose = n(q[4]), percent = n(q[32]), delta = n(q[31]);
      if (price === null || price <= 0 || previousClose === null || previousClose <= 0 || percent === null || delta === null) throw new Error('行情字段无效');
      quotes.set(symbol, { symbol, name:q[1].slice(0,100), price, priceText:q[3], previousClose, percent, delta, high:n(q[33]), low:n(q[34]), timestamp, date });
    } catch (error) { errors.set(symbol, error.message); }
  }
  for (const symbol of symbols) if (!quotes.has(symbol) && !errors.has(symbol)) errors.set(symbol, '未查询到行情，请检查代码');
  return { quotes, errors };
}
function localClock(now, market) {
  if (market === 'us') return usClock(now);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: market === 'hk' ? 'Asia/Hong_Kong' : 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23', weekday:'short' }).formatToParts(now).map(p => [p.type,p.value]));
  const minute = Number(parts.hour)*60+Number(parts.minute), weekday = parts.weekday !== 'Sat' && parts.weekday !== 'Sun';
  const polling = weekday && (market === 'hk' ? (minute >= 570 && minute < 720 || minute >= 780 && minute < 960) : minute >= 570 && minute < 960);
  return { date:`${parts.year}-${parts.month}-${parts.day}`, minute, polling };
}
class OverseasWatchlist {
  constructor(parent, request = requestQuoteText, extendedProvider = new UsExtendedProvider()) {
    this.parent = parent; this.request = request; this.groups = { hk:{kind:'overseasGroup',market:'hk'}, us:{kind:'overseasGroup',market:'us'} };
    this.elements = new Map(); this.quotes = new Map(); this.errors = new Map(); this.last = {hk:-Infinity,us:-Infinity}; this.inflight = {}; this.abort = {}; this.generation = 0;
    const stored = parent.context.globalState.get('overseasQuotes', []);
    if (Array.isArray(stored)) for (const q of stored) if (this.validQuote(q)) this.quotes.set(q.symbol,q);
    this.cached = new Set(this.quotes.keys()); this.signatures = new Map(); this.cacheWrite = Promise.resolve(); this.read();
    this.extendedProvider = extendedProvider; this.extended = new Map(); this.extendedCached = new Set(); this.extendedErrors = new Map(); this.lastExtendedAttempt = -Infinity;
    const extended = parent.context.globalState.get('usExtendedQuotes', []);
    if (Array.isArray(extended)) for (const q of extended.slice(0, 200)) if (validExtended(q, parent.now()) && this.symbols.us.includes(q.symbol)) {
      const slots = this.extended.get(q.symbol) || {}; slots[q.phase] = q; this.extended.set(q.symbol, slots); this.extendedCached.add(q.symbol + ':' + q.phase);
    }
    this.usPhaseKey = localClock(parent.now(), 'us').date + ':' + localClock(parent.now(), 'us').phase;
    this.grouping = { hk: new StockGroups(parent, 'hk'), us: new StockGroups(parent, 'us') };
  }
  validQuote(q) {
    try { const market = q.symbol?.slice(0,2); return ['hk','us'].includes(market) && normalizeOverseas(q.symbol,market) === q.symbol && typeof q.name === 'string' && /^\d{14}$/.test(q.timestamp) && normalizeDate(q.timestamp.slice(0,8)) === q.date && timeToMinute(q.timestamp.slice(8,12)) >= 0 && Number(q.timestamp.slice(12,14)) < 60 && typeof q.priceText === 'string' && /^\d+(?:\.\d+)?$/.test(q.priceText) && Number.isFinite(q.price) && q.price > 0 && Number.isFinite(q.previousClose) && q.previousClose > 0 && [q.percent,q.delta].every(Number.isFinite) && [q.high,q.low].every(v => v === null || Number.isFinite(v)); } catch { return false; }
  }
  read() {
    this.symbols = {}; this.stockGroups = {};
    for (const market of ['hk','us']) {
      const raw = this.parent.settings.get(`stocks.${market}Symbols`, []);
      try { if (!Array.isArray(raw) || raw.length > 100) throw new Error(); this.symbols[market] = [...new Set(raw.map(s=>normalizeOverseas(s,market)))]; }
      catch { this.symbols[market] = []; }
      this.stockGroups[market] = normalizeGroups(this.parent.settings.get(`stocks.${market}Groups`, []), this.symbols[market], s => normalizeOverseas(s, market));
    }
  }
  changed() { this.generation++; for (const c of Object.values(this.abort)) c?.abort(); this.read(); this.lastExtendedAttempt = -Infinity; for (const symbol of this.extended.keys()) if (!this.symbols.us.includes(symbol)) { this.extended.delete(symbol); this.extendedErrors.delete(symbol); this.extendedCached.delete(symbol + ':pre'); this.extendedCached.delete(symbol + ':post'); } }
  getGroups() { return [this.groups.hk,this.groups.us]; }
  element(symbol) { if (!this.elements.has(symbol)) this.elements.set(symbol, {kind:'overseasStock',market:symbol.slice(0,2),symbol}); return this.elements.get(symbol); }
  getChildren(group) {
    const grouping = this.grouping[group.market];
    return grouping.groups.length ? grouping.buckets().map(g => grouping.element(g.id)) : orderedSymbols(this.symbols[group.market] || [], this.displayQuotes(group.market), this.parent.config.sortBy).map(s=>this.element(s));
  }
  displayInfo(symbol) {
    const regular = this.quotes.get(symbol);
    if (!symbol.startsWith('us')) return { quote: regular, stale: this.stale(symbol), error: this.errors.get(symbol), description: this.errors.has(symbol) ? '获取失败' : this.stale(symbol) ? '未更新' : '' };
    const now = this.parent.now(), clock = localClock(now, 'us'), slots = this.extended.get(symbol) || {};
    const earlyClose = slots.post?.earlyClose && slots.post.date === clock.date && clock.minute >= 780 && clock.minute < 1200;
    const phase = earlyClose ? 'post' : clock.phase, active = ['pre', 'post'].includes(phase);
    let extended = active ? slots[phase] : clock.phase === 'closed' && slots.post?.timestamp > (regular?.timestamp || '') ? slots.post : null;
    if (extended && (!validExtended(extended, now) || active && extended.date !== clock.date)) extended = null;
    if (extended) {
      const cached = this.extendedCached.has(symbol + ':' + extended.phase) || this.extendedErrors.has(symbol), earlier = active && now.getTime() - extended.epoch > 5 * 60000;
      const stale = cached || earlier;
      const label = extended.phase === 'pre' ? '盘前' : '盘后';
      return { quote: extended, phase: extended.phase, stale, cached, error: this.extendedErrors.get(symbol), description: label + (extended.date !== clock.date ? ' ' + extended.date.slice(5) : '') + (cached ? ' · 缓存' : earlier ? ' · 较早报价' : '') };
    }
    return { quote: regular, phase: 'regular', stale: this.stale(symbol), error: this.errors.get(symbol), description: active ? `常规 · ${phase === 'pre' ? '盘前' : '盘后'}暂无` : this.errors.has(symbol) ? '常规 · 获取失败' : '常规' };
  }
  displayQuotes(market) { return market === 'us' ? new Map(this.symbols.us.map(s => [s, this.displayInfo(s).quote])) : this.quotes; }
  getTreeItem(element) {
    if (element.kind === 'overseasGroup') {
      const label = element.market === 'hk' ? '港股' : '美股';
      const item = new vscode.TreeItem(`${label} (${this.symbols[element.market].length})`, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `overseas:${element.market}`; item.contextValue = 'aShareOverseasGroup'; item.description = element.market === 'us' ? '常规 / 盘前 / 盘后' : '涨跌幅 · 现价 · 名称'; item.tooltip = `点击行尾＋添加${label}；文件夹图标新建分组。拖动个股可排序或移动分组，拖回此标题进入未分组。` + (element.market === 'us' ? '\n美股按时段显示价格和涨跌幅，悬停查看常规、盘前和盘后数据。盘前/盘后涨跌均以对应常规收盘价为基准。' : ''); return item;
    }
    const display = this.displayInfo(element.symbol), q = display.quote, stale = display.stale;
    const item = new vscode.TreeItem(q ? `${percentText(q.percent).padStart(7)}   ${q.priceText.padStart(8)}   [${q.name}]` : `—   —   [${element.symbol}]`, vscode.TreeItemCollapsibleState.None);
    item.id = `stock:${element.symbol}`; item.contextValue = 'aShareOverseasStock'; item.iconPath = display.error ? new vscode.ThemeIcon('warning') : trendIcon(this.parent.context.extensionUri,q?.percent);
    item.description = display.description;
    item.command = { command:'welove42.aShareTurnover.overseas.open', title:'在浏览器查看行情', arguments:[element] };
    const tip = new vscode.MarkdownString(); tip.isTrusted = false;
    if (element.market === 'us') {
      const regular = this.quotes.get(element.symbol), time = q => {
        const minute = q.timePrecision === 'minute' || q.source === '新浪财经' && !q.timePrecision;
        return `${q.date} ${q.timestamp.slice(8,10)}:${q.timestamp.slice(10,12)}${minute ? '' : ':' + q.timestamp.slice(12,14)}（美东时间${minute ? '，分钟精度' : ''}）`;
      };
      tip.appendText(`${q?.name || regular?.name || element.symbol}（${element.symbol}）\n价格单位：美元\n`);
      tip.appendText(regular ? `\n常规：${regular.priceText}　${percentText(regular.percent)}\n涨跌额：${signed(regular.delta,3)}　昨收：${regular.previousClose}\n行情时间：${time(regular)}\n来源：腾讯行情${this.stale(element.symbol) ? '（历史/缓存，请核对时间）' : ''}\n` : '\n常规：暂无报价\n');
      for (const phase of ['pre', 'post']) {
        const quote = this.extended.get(element.symbol)?.[phase], label = phase === 'pre' ? '盘前' : '盘后';
        if (quote && validExtended(quote, this.parent.now())) tip.appendText(`\n${label}：${quote.priceText}　${percentText(quote.percent)}\n涨跌额：${signed(quote.delta,3)}　常规收盘基准：${quote.basePrice}\n行情时间：${time(quote)}\n基准日期：${quote.regularTimestamp.slice(0,4)}-${quote.regularTimestamp.slice(4,6)}-${quote.regularTimestamp.slice(6,8)}\n来源：${quote.source}${this.extendedCached.has(element.symbol + ':' + phase) || this.extendedErrors.has(element.symbol) ? '（缓存）' : ''}\n`);
        else tip.appendText(`\n${label}：暂无有效报价\n`);
      }
      if (display.phase !== 'regular' && stale) tip.appendText(display.cached ? '\n当前行使用缓存，请核对行情时间。' : '\n当前行报价时间较早，可能尚无新成交，请核对行情时间。');
      if (this.errors.has(element.symbol)) tip.appendText(`\n常规行情：${this.errors.get(element.symbol)}`);
      if (this.extendedErrors.has(element.symbol)) tip.appendText(`\n盘前/盘后行情：${this.extendedErrors.get(element.symbol)}`);
      tip.appendText('\n公开行情可能延迟；盘前/盘后按源提供的收盘基准计算，可能含收盘修正，不等于常规时段涨跌幅。');
    } else {
      tip.appendText(q ? `${q.name}（${element.symbol}）\n现价：${q.priceText}　涨跌幅：${percentText(q.percent)}\n涨跌额：${signed(q.delta,3)}　昨收：${q.previousClose}\n行情时间：${q.date} ${q.timestamp.slice(8,10)}:${q.timestamp.slice(10,12)}:${q.timestamp.slice(12,14)}（香港时间）\n腾讯行情，可能延迟。` : `${element.symbol}\n尚未获取行情`);
      if (stale) tip.appendText('\n当前为缓存或未更新行情，请核对时间。');
      if (this.errors.has(element.symbol)) tip.appendText(`\n${this.errors.get(element.symbol)}`);
    }
    const grouping = this.grouping[element.market];
    if (grouping.groups.length) tip.appendText(`\n分组：${grouping.bucket(grouping.idFor(element.symbol)).name}`);
    tip.appendText('\n点击在浏览器查看行情，行尾可删除。'); item.tooltip = tip; return item;
  }
  stale(symbol) {
    const q = this.quotes.get(symbol), clock = localClock(this.parent.now(),symbol.slice(0,2));
    if (!q || this.cached.has(symbol) || this.errors.has(symbol) || q.date !== clock.date) return true;
    return clock.polling && clock.minute - timeToMinute(q.timestamp.slice(8,12)) > 2;
  }
  publish(m) {
    const changed=[]; for(const symbol of this.symbols[m]) { const signature=JSON.stringify([this.quotes.get(symbol),this.errors.get(symbol),this.stale(symbol),this.parent.paused,this.extended.get(symbol),this.extendedErrors.get(symbol),m === 'us' ? this.displayInfo(symbol) : null]); if(this.signatures.get(symbol)!==signature){this.signatures.set(symbol,signature);changed.push(symbol);} }
    if(changed.length && this.parent.config.sortBy!=='manual')this.parent.emitter.fire(this.groups[m]); else for(const symbol of changed)this.parent.emitter.fire(this.element(symbol));
  }
  publishAll() { for(const m of ['hk','us'])this.publish(m); }
  tick(active = true) { for (const m of ['hk','us']) { this.publish(m); const clock = localClock(this.parent.now(),m), key = clock.date + ':' + clock.phase, boundary = m === 'us' && key !== this.usPhaseKey; if(m === 'us')this.usPhaseKey = key; if (active && this.symbols[m].length && ((clock.quotePolling ?? clock.polling) && this.parent.now().getTime()-this.last[m]>=10000 || boundary)) void this.refresh(m, false, boundary); } }
  async refresh(m, force = false, boundary = false) {
    if (this.parent.disposed || this.parent.hidden || !this.parent.config.enabled || (this.parent.paused && !force) || !this.symbols[m].length) return;
    if (this.inflight[m] && this.abort[m]?.signal.aborted) return this.inflight[m].then(()=>this.refresh(m,force,boundary));
    if (this.inflight[m]) return this.inflight[m];
    const symbols = [...this.symbols[m]], generation = this.generation, abort = this.abort[m] = new AbortController(); this.last[m] = this.parent.now().getTime();
    this.inflight[m] = (async()=>{
      try {
        const clock = localClock(this.parent.now(), 'us'), early = this.symbols.us.some(s => this.extended.get(s)?.post?.earlyClose && this.extended.get(s).post.date === clock.date);
        const loadExtended = m === 'us' && (force || boundary || !Number.isFinite(this.lastExtendedAttempt) || ['pre', 'post'].includes(clock.phase) || early || this.parent.now().getTime() - this.lastExtendedAttempt >= 60000);
        let extendedTask = Promise.resolve(null);
        if (loadExtended) { this.lastExtendedAttempt = this.parent.now().getTime(); extendedTask = this.extendedProvider.load(symbols, abort.signal, this.parent.now()).catch(error => ({ quotes: new Map(), errors: new Map(symbols.map(s => [s, error.message || '盘前盘后行情获取失败'])) })); }
        const batches=[]; for(let i=0;i<symbols.length;i+=50)batches.push(symbols.slice(i,i+50));
        const [results, extendedResult] = await Promise.all([Promise.all(batches.map(async batch=>{ try { return parseOverseasQuotes(await this.request(`https://qt.gtimg.cn/q=${batch.join(',')}`,abort.signal),m,batch); } catch(e) { return {quotes:new Map(),errors:new Map(batch.map(s=>[s,e.message||'行情请求失败']))}; } })), extendedTask]);
        if (abort.signal.aborted || generation !== this.generation || this.parent.disposed || this.parent.hidden) return;
        for(const result of results) {
          for(const [s,e] of result.errors) this.errors.set(s,e);
          for(const [s,q] of result.quotes) { if (q.date > localClock(this.parent.now(),m).date) { this.errors.set(s,'行情日期异常'); continue; } const old=this.quotes.get(s); if (old && q.timestamp<old.timestamp) { this.errors.set(s,'行情时间早于上次结果'); continue; } this.quotes.set(s,q); this.errors.delete(s); this.cached.delete(s); }
        }
        if (extendedResult) for (const symbol of symbols) {
          const q = extendedResult.quotes.get(symbol), error = extendedResult.errors.get(symbol);
          if (error) this.extendedErrors.set(symbol, error); else this.extendedErrors.delete(symbol);
          if (!q) for (const phase of ['pre', 'post']) if (this.extended.get(symbol)?.[phase]) this.extendedCached.add(symbol + ':' + phase);
          if (!q || !validExtended(q, this.parent.now())) continue;
          const slots = this.extended.get(symbol) || {};
          if (slots[q.phase] && q.epoch < slots[q.phase].epoch) { this.extendedErrors.set(symbol, '盘前盘后报价早于上次结果，保留原数据'); continue; }
          slots[q.phase] = q; this.extended.set(symbol, slots); this.extendedCached.delete(symbol + ':' + q.phase);
        }
        const saved = this.symbols.us.flatMap(s => Object.values(this.extended.get(s) || {})).filter(q => validExtended(q, this.parent.now()));
        this.cacheWrite=this.cacheWrite.then(async()=>{ await this.parent.context.globalState.update('overseasQuotes',[...this.quotes.values()]); if (m === 'us') await this.parent.context.globalState.update('usExtendedQuotes', saved); }).catch(()=>{}); await this.cacheWrite;
      } finally { delete this.inflight[m]; delete this.abort[m]; if (!this.parent.disposed) this.publish(m); }
    })(); return this.inflight[m];
  }
  refreshAll(force = false) { return Promise.all(['hk','us'].map(m=>this.refresh(m,force))); }
  async add(element, groupId) {
    const market = element?.market; if (!['hk','us'].includes(market) || this.parent.hidden || this.parent.disposed) return;
    if (groupId !== undefined && !this.grouping[market].bucket(groupId)) throw new Error('目标分组已删除，请重新选择。');
    const picker = vscode.window.createQuickPick(); picker.title = `添加${market === 'hk' ? '港股' : '美股'}`; picker.placeholder = market === 'hk' ? '输入名称或代码，例如 腾讯 / 00700' : '输入名称或代码，例如 苹果 / AAPL'; picker.matchOnDescription=true; picker.ignoreFocusOut=true;
    if (groupId !== undefined) picker.title += `到「${this.grouping[market].bucket(groupId).name}」`;
    let timer, abort, generation=0, closed=false, accepting=false;
    const update = value=>{
      generation++; const current=generation; abort?.abort(); clearTimeout(timer); picker.items=[]; picker.activeItems=[]; picker.busy=false;
      if (!value.trim()) return;
      let direct; try { direct=normalizeOverseas(value,market); } catch {}
      if(direct) { picker.items=[{label:`添加 ${direct}`,symbol:direct,alwaysShow:true}]; picker.activeItems=[picker.items[0]]; }
      timer=setTimeout(async()=>{ if(closed || this.parent.disposed)return; const controller=abort=new AbortController(); picker.busy=true;
        try { const text=await this.request(`https://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(value.trim())}&t=all`,controller.signal); const rows=parseOverseasSearch(text,market);
          if(closed || controller.signal.aborted || current!==generation)return;
          if(rows.length) {picker.items=rows.map(r=>({label:r.name,description:r.symbol,detail:r.pinyin,symbol:r.symbol,alwaysShow:true}));picker.activeItems=[picker.items[0]];}
          else if(!direct) picker.items=[{label:'未找到匹配股票，请尝试完整代码',alwaysShow:true}];
        } catch(e) { if(!closed && !controller.signal.aborted && current===generation && !direct) picker.items=[{label:'搜索失败，请输入完整代码',detail:e.message,alwaysShow:true}]; }
        finally { if(!closed && current===generation)picker.busy=false; }
      },300);
    };
    return new Promise(resolve=>{ const listeners=[picker.onDidChangeValue(update),picker.onDidAccept(async()=>{ const item=picker.selectedItems[0]||picker.activeItems?.[0]; if(!item?.symbol||accepting)return; accepting=true;
      try { await this.mutate(market, list => [...list,item.symbol], groupId, [item.symbol]); picker.hide(); } catch(e) { accepting=false; void privateUI.showErrorMessage(e.message); }
    }),picker.onDidHide(()=>{ closed=true;abort?.abort();clearTimeout(timer);for(const l of listeners)l.dispose();picker.dispose();if(this.picker===picker)this.picker=null;resolve(); })]; this.picker?.hide();this.picker=picker;picker.show(); });
  }
  async mutate(market, change, groupId, additions = []) {
    if (!['hk','us'].includes(market)) return;
    await this.parent.enqueueSettings(async()=>{
      if (this.parent.hidden || this.parent.disposed) return;
      const grouping = this.grouping[market];
      if (groupId !== undefined && !grouping.bucket(groupId)) throw new Error('目标分组已删除，请重新选择。');
      const unique=[...new Set(change([...this.symbols[market]]).map(s=>normalizeOverseas(s,market)))];
      if(unique.length>100)throw new Error('每个市场最多100只股票');
      const members = new Set(additions.map(s => normalizeOverseas(s, market)));
      let groups = normalizeGroups(grouping.groups, unique, s => normalizeOverseas(s, market));
      if (groupId !== undefined) groups = groups.map(g => ({ ...g, symbols: [...g.symbols.filter(s => !members.has(s)), ...(g.id === groupId ? unique.filter(s => members.has(s)) : [])] }));
      await this.parent.writeSettings([[grouping.symbolsKey, unique], [grouping.groupsKey, groups]], false);
    });
  }
  async remove(element) { if(!element || element.kind!=='overseasStock')return; await this.mutate(element.market,list=>list.filter(s=>s!==element.symbol)); }
  reorder(payload, target, token) {
    const market=payload.market;
    if (!['hk','us'].includes(market) || target && (target.market !== market || !['overseasGroup','overseasStock','stockGroup'].includes(target.kind))) return;
    return this.parent.enqueueSettings(async()=>{
      if(this.parent.disposed || this.parent.hidden || token?.isCancellationRequested || !this.parent.config.enabled)return;
      const grouping = this.grouping[market];
      const id = target?.kind === 'stockGroup' ? target.id : target?.kind === 'overseasStock' ? grouping.idFor(target.symbol) : UNGROUPED;
      if (!grouping.bucket(id) || payload.symbols.some(s => !this.symbols[market].includes(s))) return;
      return grouping.moveNow(payload.symbols, id, target?.kind === 'overseasStock' ? target.symbol : undefined);
    });
  }
  async open(element) {
    try { const m=element?.market, symbol=normalizeOverseas(element?.symbol,m); await vscode.env.openExternal(vscode.Uri.parse(`https://gu.qq.com/${symbol}`)); }
    catch(e) { void privateUI.showErrorMessage(e.message); }
  }
  dispose() { this.generation++; for(const c of Object.values(this.abort))c?.abort(); this.picker?.hide(); }
}
module.exports={OverseasWatchlist,normalizeOverseas,parseOverseasSearch,parseOverseasQuotes,localClock};

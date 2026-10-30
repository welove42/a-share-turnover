'use strict';
const vscode = require('vscode');
const privateUI = require('./privacy-ui');
const { requestQuoteText } = require('./http');
const { percentText, signed, orderedSymbols } = require('./quotes');
const { trendIcon } = require('./trend-icon');
const { normalizeDate, timeToMinute } = require('./market');
const { normalizeOverseas } = require('./overseas-symbols');
const { parseMarketSuggestions } = require('./stock-search');

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
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: market === 'hk' ? 'Asia/Hong_Kong' : 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23', weekday:'short' }).formatToParts(now).map(p => [p.type,p.value]));
  const minute = Number(parts.hour)*60+Number(parts.minute), weekday = parts.weekday !== 'Sat' && parts.weekday !== 'Sun';
  const polling = weekday && (market === 'hk' ? (minute >= 570 && minute < 720 || minute >= 780 && minute < 960) : minute >= 570 && minute < 960);
  return { date:`${parts.year}-${parts.month}-${parts.day}`, minute, polling };
}
class OverseasWatchlist {
  constructor(parent, request = requestQuoteText) {
    this.parent = parent; this.request = request; this.groups = { hk:{kind:'overseasGroup',market:'hk'}, us:{kind:'overseasGroup',market:'us'} };
    this.elements = new Map(); this.quotes = new Map(); this.errors = new Map(); this.last = {hk:-Infinity,us:-Infinity}; this.inflight = {}; this.abort = {}; this.generation = 0;
    const stored = parent.context.globalState.get('overseasQuotes', []);
    if (Array.isArray(stored)) for (const q of stored) if (this.validQuote(q)) this.quotes.set(q.symbol,q);
    this.cached = new Set(this.quotes.keys()); this.signatures = new Map(); this.cacheWrite = Promise.resolve(); this.read();
  }
  validQuote(q) {
    try { const market = q.symbol?.slice(0,2); return ['hk','us'].includes(market) && normalizeOverseas(q.symbol,market) === q.symbol && typeof q.name === 'string' && /^\d{14}$/.test(q.timestamp) && normalizeDate(q.timestamp.slice(0,8)) === q.date && timeToMinute(q.timestamp.slice(8,12)) >= 0 && Number(q.timestamp.slice(12,14)) < 60 && typeof q.priceText === 'string' && /^\d+(?:\.\d+)?$/.test(q.priceText) && Number.isFinite(q.price) && q.price > 0 && Number.isFinite(q.previousClose) && q.previousClose > 0 && [q.percent,q.delta].every(Number.isFinite) && [q.high,q.low].every(v => v === null || Number.isFinite(v)); } catch { return false; }
  }
  read() {
    this.symbols = {};
    for (const market of ['hk','us']) {
      const raw = this.parent.settings.get(`stocks.${market}Symbols`, []);
      try { if (!Array.isArray(raw) || raw.length > 100) throw new Error(); this.symbols[market] = [...new Set(raw.map(s=>normalizeOverseas(s,market)))]; }
      catch { this.symbols[market] = []; }
    }
  }
  changed() { this.generation++; for (const c of Object.values(this.abort)) c?.abort(); this.read(); }
  getGroups() { return [this.groups.hk,this.groups.us]; }
  element(symbol) { if (!this.elements.has(symbol)) this.elements.set(symbol, {kind:'overseasStock',market:symbol.slice(0,2),symbol}); return this.elements.get(symbol); }
  getChildren(group) { return orderedSymbols(this.symbols[group.market] || [], this.quotes, this.parent.config.sortBy).map(s=>this.element(s)); }
  getTreeItem(element) {
    if (element.kind === 'overseasGroup') {
      const label = element.market === 'hk' ? '港股' : '美股';
      const item = new vscode.TreeItem(`${label} (${this.symbols[element.market].length})`, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `overseas:${element.market}`; item.contextValue = 'aShareOverseasGroup'; item.description = '涨跌幅 · 现价 · 名称'; item.tooltip = `点击行尾＋添加${label}，可输入名称或代码。`; return item;
    }
    const q = this.quotes.get(element.symbol), stale = this.stale(element.symbol);
    const item = new vscode.TreeItem(q ? `${percentText(q.percent).padStart(7)}   ${q.priceText.padStart(8)}   [${q.name}]` : `—   —   [${element.symbol}]`, vscode.TreeItemCollapsibleState.None);
    item.id = `stock:${element.symbol}`; item.contextValue = 'aShareOverseasStock'; item.iconPath = this.errors.has(element.symbol) ? new vscode.ThemeIcon('warning') : trendIcon(this.parent.context.extensionUri,q?.percent);
    item.description = this.errors.has(element.symbol) ? '获取失败' : stale ? '未更新' : '';
    item.command = { command:'welove42.aShareTurnover.overseas.open', title:'在浏览器查看行情', arguments:[element] };
    const tip = new vscode.MarkdownString(); tip.isTrusted = false;
    tip.appendText(q ? `${q.name}（${element.symbol}）\n现价：${q.priceText}　涨跌幅：${percentText(q.percent)}\n涨跌额：${signed(q.delta,3)}　昨收：${q.previousClose}\n行情时间：${q.date} ${q.timestamp.slice(8,10)}:${q.timestamp.slice(10,12)}:${q.timestamp.slice(12,14)}（${element.market === 'hk' ? '香港' : '美东'}时间）\n腾讯行情，可能延迟。` : `${element.symbol}\n尚未获取行情`);
    if (stale) tip.appendText('\n当前为缓存或未更新行情，请核对时间。');
    if (this.errors.has(element.symbol)) tip.appendText(`\n${this.errors.get(element.symbol)}`);
    tip.appendText('\n点击在浏览器查看行情，行尾可删除。'); item.tooltip = tip; return item;
  }
  stale(symbol) {
    const q = this.quotes.get(symbol), clock = localClock(this.parent.now(),symbol.slice(0,2));
    if (!q || this.cached.has(symbol) || this.errors.has(symbol) || q.date !== clock.date) return true;
    return clock.polling && clock.minute - timeToMinute(q.timestamp.slice(8,12)) > 2;
  }
  publish(m) {
    const changed=[]; for(const symbol of this.symbols[m]) { const signature=JSON.stringify([this.quotes.get(symbol),this.errors.get(symbol),this.stale(symbol),this.parent.paused]); if(this.signatures.get(symbol)!==signature){this.signatures.set(symbol,signature);changed.push(symbol);} }
    if(changed.length && this.parent.config.sortBy!=='manual')this.parent.emitter.fire(this.groups[m]); else for(const symbol of changed)this.parent.emitter.fire(this.element(symbol));
  }
  publishAll() { for(const m of ['hk','us'])this.publish(m); }
  tick(active = true) { for (const m of ['hk','us']) { this.publish(m); if (active && this.symbols[m].length && localClock(this.parent.now(),m).polling && this.parent.now().getTime()-this.last[m]>=10000) void this.refresh(m); } }
  async refresh(m, force = false) {
    if (this.parent.disposed || this.parent.hidden || !this.parent.config.enabled || (this.parent.paused && !force) || !this.symbols[m].length) return;
    if (this.inflight[m] && this.abort[m]?.signal.aborted) return this.inflight[m].then(()=>this.refresh(m,force));
    if (this.inflight[m]) return this.inflight[m];
    const symbols = [...this.symbols[m]], generation = this.generation, abort = this.abort[m] = new AbortController(); this.last[m] = this.parent.now().getTime();
    this.inflight[m] = (async()=>{
      try {
        const batches=[]; for(let i=0;i<symbols.length;i+=50)batches.push(symbols.slice(i,i+50));
        const results=await Promise.all(batches.map(async batch=>{ try { return parseOverseasQuotes(await this.request(`https://qt.gtimg.cn/q=${batch.join(',')}`,abort.signal),m,batch); } catch(e) { return {quotes:new Map(),errors:new Map(batch.map(s=>[s,e.message||'行情请求失败']))}; } }));
        if (abort.signal.aborted || generation !== this.generation || this.parent.disposed) return;
        for(const result of results) {
          for(const [s,e] of result.errors) this.errors.set(s,e);
          for(const [s,q] of result.quotes) { if (q.date > localClock(this.parent.now(),m).date) { this.errors.set(s,'行情日期异常'); continue; } const old=this.quotes.get(s); if (old && q.timestamp<old.timestamp) { this.errors.set(s,'行情时间早于上次结果'); continue; } this.quotes.set(s,q); this.errors.delete(s); this.cached.delete(s); }
        }
        this.cacheWrite=this.cacheWrite.then(()=>this.parent.context.globalState.update('overseasQuotes',[...this.quotes.values()])).catch(()=>{}); await this.cacheWrite;
      } finally { delete this.inflight[m]; delete this.abort[m]; if (!this.parent.disposed) this.publish(m); }
    })(); return this.inflight[m];
  }
  refreshAll(force = false) { return Promise.all(['hk','us'].map(m=>this.refresh(m,force))); }
  async add(element) {
    const market = element?.market; if (!['hk','us'].includes(market)) return;
    const picker = vscode.window.createQuickPick(); picker.title = `添加${market === 'hk' ? '港股' : '美股'}`; picker.placeholder = market === 'hk' ? '输入名称或代码，例如 腾讯 / 00700' : '输入名称或代码，例如 苹果 / AAPL'; picker.matchOnDescription=true; picker.ignoreFocusOut=true;
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
      try { await this.mutate(market, list => [...list,item.symbol]); picker.hide(); } catch(e) { accepting=false; void privateUI.showErrorMessage(e.message); }
    }),picker.onDidHide(()=>{ closed=true;abort?.abort();clearTimeout(timer);for(const l of listeners)l.dispose();picker.dispose();if(this.picker===picker)this.picker=null;resolve(); })]; this.picker?.hide();this.picker=picker;picker.show(); });
  }
  async mutate(market, change) {
    await this.parent.enqueueSettings(async()=>{
      const unique=[...new Set(change([...this.symbols[market]]).map(s=>normalizeOverseas(s,market)))];
      if(unique.length>100)throw new Error('每个市场最多100只股票');
      await this.parent.writeSetting(`stocks.${market}Symbols`,unique);
    });
  }
  async remove(element) { if(!element || element.kind!=='overseasStock')return; await this.mutate(element.market,list=>list.filter(s=>s!==element.symbol)); }
  reorder(payload, target, token) {
    const market=payload.market;
    if (!['hk','us'].includes(market) || !target || target.market !== market || !['overseasGroup','overseasStock'].includes(target.kind)) return;
    return this.parent.enqueueSettings(async()=>{
      if(this.parent.disposed || token.isCancellationRequested || !this.parent.config.enabled)return;
      const visible=orderedSymbols(this.symbols[market],this.quotes,this.parent.config.sortBy), moving=new Set(payload.symbols);
      if(!moving.size || [...moving].some(s=>!visible.includes(s)) || (target.kind==='overseasStock' && (!visible.includes(target.symbol) || moving.has(target.symbol))))return;
      const selected=visible.filter(s=>moving.has(s)), rest=visible.filter(s=>!moving.has(s)); let at=rest.length;
      if(target.kind==='overseasStock') { at=rest.indexOf(target.symbol); if(visible.indexOf(selected[0])<visible.indexOf(target.symbol))at++; }
      const next=[...rest.slice(0,at),...selected,...rest.slice(at)]; if(next.every((s,i)=>s===visible[i]))return;
      this.parent.writingSettings=(this.parent.writingSettings||0)+1;
      try { await this.parent.settings.set(`stocks.${market}Symbols`,next); if(this.parent.config.sortBy!=='manual')await this.parent.settings.set('stocks.sortBy','manual'); }
      finally { this.parent.writingSettings--; if(!this.parent.disposed){this.parent.config=this.parent.readConfig();this.read();this.parent.publish(true);} }
    });
  }
  async open(element) {
    try { const m=element?.market, symbol=normalizeOverseas(element?.symbol,m); await vscode.env.openExternal(vscode.Uri.parse(`https://gu.qq.com/${symbol}`)); }
    catch(e) { void privateUI.showErrorMessage(e.message); }
  }
  dispose() { this.generation++; for(const c of Object.values(this.abort))c?.abort(); this.picker?.hide(); }
}
module.exports={OverseasWatchlist,normalizeOverseas,parseOverseasSearch,parseOverseasQuotes,localClock};

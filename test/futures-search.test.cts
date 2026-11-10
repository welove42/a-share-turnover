const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { harness } = require('./vscode-mock.cts');
const rawQuotes = fs.readFileSync(path.join(__dirname, 'fixtures/futures-quotes.txt'), 'utf8');
const suggestion = (...rows) => `var futures_hint="${rows.join(';')}";`;
const row = (code, name, type = '85') => `${name},${type},${code},${code},${name},,${name},99,1,,,,`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('操作未在预期时间内完成');
}
function modules() {
  const h = harness({ 'aShareTurnover.futures.symbols': [] });
  const { FuturesController } = h.load('../dist/features/futures/controller.js');
  const search = require('../dist/features/futures/search.js');
  const data = require('../dist/features/commodities/data.js');
  return { ...h, FuturesController, ...search, ...data };
}

test('远程搜索接受国内主连、月份、海外和金融期货，过滤期权/股票/脚本并消除主连重复', () => {
  const h = modules();
  h.initializeFuturesCatalog();
  const entries = h.parseFuturesSuggestions(
    suggestion(
      row('lc0', '碳酸锂', '87'),
      row('lc0', '碳酸锂连续'),
      row('lc2701', '碳酸锂2701'),
      row('si', '白银', '86'),
      row('si0', '工业硅', '87'),
      row('if2612', '沪深2612', '88'),
      row('es2612', '标普2612', '86'),
      row('ta701', 'PTA701'),
      row('lc2701C90000', '期权', '109'),
      row('rb2701P3000', '期权'),
      row('RBEFP', '换期货'),
      row('sh600000', '浦发', '11'),
      row('CL&x=evil', '错误', '86'),
      row('bad', '<script>', '86')
    )
  );
  assert.deepEqual(
    entries.map((e) => e.code),
    ['LC0', 'LC2701', 'SI', 'SI0', 'IF2612', 'ES2612', 'TA701']
  );
  assert.equal(entries.find((e) => e.code === 'SI').market, 'cfd');
  assert.equal(entries.find((e) => e.code === 'SI0').market, 'domesticFutures');
  assert.equal(entries.find((e) => e.code === 'IF2612').quoteSchema, 'financial');
  assert.equal(entries.find((e) => e.code === 'LC2701').unit, '元/吨');
  assert.equal(entries.find((e) => e.code === 'TA701').unit, '');
  assert.throws(() => h.parseFuturesSuggestions('throw new Error("do not execute");'), /格式/);
  assert.throws(() => h.registerCommodity({ ...entries[0], code: '../evil' }), /无效/);
  assert.throws(() => h.registerCommodity({ ...entries[2], market: 'domesticFutures' }));
});

test('搜索正确编码中文和GBK响应，缓存5分钟；前缀过滤市场，不将NF_SI当成海外白银', async () => {
  const h = modules(),
    calls = [];
  let now = 0;
  // GBK的“中文”，验证并非把中文响应当UTF-8解析。
  const payload = Buffer.concat([
    Buffer.from('var futures_hint="query,85,ab2701,ab2701,'),
    Buffer.from('d6d0cec4', 'hex'),
    Buffer.from(',,name;si,86,si,si,Silver,,;si0,87,si0,si0,Silicon,,";')
  ]);
  const search = new h.FuturesSearch(
    async (...args) => {
      calls.push(args);
      return payload;
    },
    () => now
  );
  assert.equal(search.local('nf_si')[0].code, 'SI0');
  assert.equal(search.local('hf_si')[0].code, 'SI');
  assert.equal(calls.length, 0);
  const entries = await search.search('中文');
  assert.equal(entries.find((e) => e.code === 'AB2701').name, '中文');
  assert.match(calls[0][0], /type=85,86,87,88&key=%E4%B8%AD%E6%96%87&name=futures_hint$/);
  assert.equal(calls[0][2].Referer, 'https://finance.sina.com.cn/');
  await search.search('中文');
  assert.equal(calls.length, 1);
  now = 300001;
  await search.search('中文');
  assert.equal(calls.length, 2);
  assert.ok((await search.search('nf_si')).every((e) => e.market === 'domesticFutures'));
  assert.ok((await search.search('hf_si')).every((e) => e.market === 'cfd'));
  assert.equal(calls.length, 3, '同关键词不同前缀共用缓存');
  await assert.rejects(search.search('a'.repeat(61)), /60字/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(search.search('中文', abort.signal), /取消/);
});

test('真实报价样本适配商品/股指/国债/海外月份，金融期货以昨结算而非昨收计算', () => {
  const h = modules();
  h.initializeFuturesCatalog();
  for (const e of h.parseFuturesSuggestions(
    suggestion(
      row('lc2701', '碳酸锂2701'),
      row('if2612', '沪深2612', '88'),
      row('nq2612', '纳指2612', '86'),
      row('cl2612', '原油2612', '86')
    )
  ))
    h.registerCommodity(e);
  const codes = ['RB0', 'AU0', 'SI0', 'IF0', 'IF2612', 'T0', 'LC2701', 'ES', 'NK', 'NQ2612', 'CL2612', 'GC', 'HSI'];
  const result = h.parseCommodityQuotes(rawQuotes, codes);
  assert.equal(result.errors.size, 0);
  assert.equal(result.quotes.size, codes.length);
  const q = result.quotes.get('IF2612');
  assert.deepEqual(
    [q.price, q.open, q.high, q.low, q.volume, q.openInterest],
    [4036.2, 4060, 4068.6, 4027.8, 39500, 169279]
  );
  assert.equal(q.previousSettlement, 4029.8);
  assert.equal(q.previousClose, null);
  assert.ok(Math.abs(q.percent - (4036.2 / 4029.8 - 1) * 100) < 1e-10);
  assert.equal(q.time, '13:51:56');
  assert.equal(result.quotes.get('T0').previousSettlement, 110.23);
  assert.equal(result.quotes.get('LC2701').previousSettlement, 89760);
  assert.equal(result.quotes.get('CL2612').previousClose, 86.85);
  assert.deepEqual(h.normalizeCommodityCodes('nf_SI,hf_SI,LC2701'), ['SI0', 'SI', 'LC2701']);
  assert.throws(() => h.normalizeCommodityCodes('hf_SI0'));
});

function setup(options = {}) {
  const h = modules(),
    service = new h.FuturesSearch();
  service.search = options.search || (async () => h.parseFuturesSuggestions(suggestion(row('lc2701', '碳酸锂2701'))));
  const requests = [];
  const provider = {
    load: async (codes, signal) => {
      requests.push({ codes, signal });
      return options.load ? options.load(codes, signal) : h.parseCommodityQuotes(rawQuotes, codes);
    }
  };
  const controller = new h.FuturesController(h.context, {
    search: service,
    provider,
    now: () => new Date('2026-11-10T14:00:00+08:00')
  });
  return { ...h, controller, service, requests };
}

test('加号动态搜索，选中先验证行情；名称/合约/月度提示及配置重启后保持，全球商品不被移动', async () => {
  const h = setup();
  let restored;
  try {
    const adding = h.controller.add({ viewId: 'toolbar' }),
      picker = h.pickers.at(-1);
    assert.match(picker.title, /搜索/);
    picker.change('LC2701');
    await until(() => picker.items.some((i) => i.entry?.code === 'LC2701'));
    const item = picker.items.find((i) => i.entry?.code === 'LC2701');
    assert.match(item.detail, /国内商品期货.*月份合约/);
    picker.selectedItems = [item];
    picker.accept();
    await adding;
    assert.deepEqual(h.controller.codes, ['LC2701']);
    assert.deepEqual(h.requests[0].codes, ['LC2701']);
    assert.equal(h.controller.quotes.get('LC2701').price, 87320);
    assert.match(h.controller.getTreeItem(h.controller.element('LC2701')).tooltip.value, /月份合约/);
    assert.doesNotMatch(h.controller.getTreeItem(h.controller.element('LC2701')).tooltip.value, /主力切换/);
    assert.equal(h.store.get(h.CATALOG_KEY)[0].name, '碳酸锂2701');
    const Fresh = h.load('../dist/features/futures/controller.js').FuturesController;
    restored = new Fresh(h.context);
    assert.deepEqual(restored.codes, ['LC2701']);
    assert.match(restored.getTreeItem(restored.element('LC2701')).label, /碳酸锂2701/);
    assert.equal(h.values.has('aShareTurnover.commodities.symbols'), false);
    assert.equal(picker.disposed, true);
  } finally {
    restored?.dispose();
    h.controller.dispose();
  }
});

test('输入防抖、迟到结果隔离、网络失败显示本地候选，取消搜索不添加', async () => {
  const pending = [],
    h = setup({
      search: (query, signal) => new Promise((resolve, reject) => pending.push({ query, signal, resolve, reject }))
    });
  try {
    const adding = h.controller.add(),
      p = h.pickers.at(-1);
    p.change('碳');
    p.change('碳酸');
    p.change('LC2701');
    await until(() => pending.length === 1);
    assert.equal(pending[0].query, 'LC2701');
    p.change('IF');
    assert.equal(pending[0].signal.aborted, true);
    await until(() => pending.length === 2);
    pending[0].resolve(h.parseFuturesSuggestions(suggestion(row('lc2701', '碳酸锂2701'))));
    pending[1].reject(new Error('网络中断'));
    await until(() => p.items.some((i) => i.label.includes('暂不可用')));
    assert.ok(p.items.some((i) => i.entry?.code === 'IF0'));
    assert.ok(p.items.every((i) => i.entry?.code !== 'LC2701'));
    p.hide();
    await adding;
    assert.deepEqual(h.controller.codes, []);
    assert.equal(pending[1].signal.aborted, true);
  } finally {
    h.controller.dispose();
  }
});

test('无效或缺失报价不添加；老板键取消验证，迟到报价不能回写设置', async () => {
  for (const scenario of ['invalid', 'hidden', 'disabled', 'disposed']) {
    let resolveQuote, requestSignal;
    const h = setup({
      load: (_codes, signal) =>
        new Promise((resolve) => {
          resolveQuote = resolve;
          requestSignal = signal;
        })
    });
    try {
      const adding = h.controller.add(),
        p = h.pickers.at(-1);
      p.selectedItems = [p.items.find((i) => i.entry?.code === 'RB0')];
      p.accept();
      await until(() => Boolean(resolveQuote));
      if (scenario === 'hidden') h.controller.setHidden(true);
      if (scenario === 'disabled')
        await h.api.workspace.getConfiguration('aShareTurnover').update('futures.enabled', false);
      if (scenario === 'disposed') h.controller.dispose();
      resolveQuote(
        scenario === 'invalid'
          ? { quotes: new Map(), errors: new Map([['RB0', '暂无报价']]) }
          : h.parseCommodityQuotes(rawQuotes, ['RB0'])
      );
      if (scenario === 'invalid') {
        await until(() => p.title.includes('暂未添加'));
        assert.ok(p.items.some((i) => i.detail === '暂无报价'));
        p.hide();
      } else assert.equal(requestSignal.aborted, true);
      await adding;
      await delay(10);
      assert.deepEqual(h.controller.codes, []);
      assert.deepEqual(h.values.get('aShareTurnover.futures.symbols'), []);
    } finally {
      h.controller.dispose();
    }
  }
});

test('元数据保存失败不写入未知代码；最多30个一批且失败不吞其他报价', async () => {
  const h = setup();
  try {
    h.context.globalState.update = async () => {
      throw new Error('磁盘失败');
    };
    await assert.rejects(h.controller.add('nf_RB0'), /磁盘失败/);
    assert.deepEqual(h.values.get('aShareTurnover.futures.symbols'), []);
    const codes = [];
    for (let i = 1; i <= 65; i++) {
      const code = `AA${2600 + i}`;
      h.registerCommodity({ code, name: code, unit: '', aliases: '', market: 'domesticFutures' });
      codes.push(code);
    }
    const calls = [];
    const provider = new h.CommodityProvider({
      request: async (url) => {
        const selected = url
          .split('=')[1]
          .split(',')
          .map((code) => code.slice(3));
        calls.push(selected);
        if (calls.length === 2) throw new Error('失败批次');
        const raw = rawQuotes.match(/var hq_str_nf_RB0="[^"]*";/)[0];
        return Buffer.from(selected.map((code) => raw.replace('nf_RB0', 'nf_' + code)).join('\n'));
      }
    });
    const result = await provider.load(codes);
    assert.deepEqual(
      calls.map((c) => c.length),
      [30, 30, 5]
    );
    assert.equal(result.quotes.size, 35);
    assert.equal(result.errors.size, 30);
  } finally {
    h.controller.dispose();
  }
});

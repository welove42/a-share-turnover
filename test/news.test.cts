'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { harness } = require('./vscode-mock.cts');
const NOW = new Date('2026-10-26T10:30:30+08:00');
const article = (id, time = 1792980000000) => ({
  key: 'eastmoney:' + id,
  id: String(id),
  source: 'eastmoney',
  title: '测试快讯 ' + id,
  body: '测试全文',
  publishedAt: time,
  stocks: ''
});
function setup(extra = {}, load, prepare = () => {}) {
  const h = harness(extra);
  let now = NOW,
    calls = 0;
  prepare(h);
  const { NewsController } = h.load('../dist/features/news/controller.js');
  const c = new NewsController(h.context, {
    now: () => now,
    provider: {
      load: async (...args) => {
        calls++;
        return load ? load(...args) : [article(1)];
      }
    }
  });
  return {
    ...h,
    c,
    calls: () => calls,
    setNow: (d) => {
      now = new Date(d);
    }
  };
}
test('首次读取不算未读；重复刷新不重复追加输出，新文章增加未读', async () => {
  let batch = [article(1)];
  const h = setup({}, async () => batch);
  try {
    await h.c.refresh();
    assert.equal(h.c.items.length, 1);
    assert.equal(h.c.unread, 0);
    assert.equal(h.c.output.lines.length, 1);
    await h.c.refresh();
    assert.equal(h.c.output.lines.length, 1);
    batch = [article(2, NOW.getTime() + 1000), article(1)];
    await h.c.refresh();
    assert.equal(h.c.unread, 1);
    assert.equal(h.c.status.text, '$(megaphone) 新闻 (1)');
    assert.equal(h.c.output.lines.length, 2);
    h.c.show();
    assert.equal(h.c.unread, 0);
  } finally {
    h.c.dispose();
  }
});
test('点击新闻在只读虚拟文档展示全文，不生成需要保存的临时文件', async () => {
  const h = setup();
  try {
    await h.c.refresh();
    await h.c.open(h.c.items[0]);
    const uri = h.opened[0];
    assert.equal(uri.scheme, 'a-share-news');
    assert.match(h.documents.get(uri.scheme).provideTextDocumentContent(uri), /测试全文/);
    assert.equal(h.trees.has('aShareTurnover.news'), false);
  } finally {
    h.c.dispose();
  }
});
test('网络失败保留上次新闻，后续刷新可自动恢复', async () => {
  let fail = false;
  const h = setup({}, async () => {
    if (fail) throw new Error('网络断开');
    return [article(1)];
  });
  try {
    await h.c.refresh();
    fail = true;
    await h.c.refresh();
    assert.equal(h.c.items.length, 1);
    assert.match(h.c.output.lines.at(-1), /保留上次/);
    fail = false;
    await h.c.refresh();
    assert.equal(h.c.error, '');
  } finally {
    h.c.dispose();
  }
});
test('取消中的请求不会写入新闻，重复刷新请求会合并', async () => {
  let resolve, signal;
  const h = setup({}, async (a) => {
    signal = a;
    return new Promise((r) => {
      resolve = r;
    });
  });
  try {
    const first = h.c.refresh();
    assert.equal(h.c.refresh(), first);
    await h.c.togglePause();
    assert.equal(signal.aborted, true);
    resolve([article(1)]);
    await first;
    assert.equal(h.c.items.length, 0);
  } finally {
    h.c.dispose();
  }
});
test('旧选股宝配置自动使用东方财富，丢弃旧源缓存，只删除本插件旧凭证', async () => {
  const h = setup({ 'aShareTurnover.news.source': 'xuangubao' }, undefined, (h) => {
    h.secrets.set('aShareTurnover.xuangubaoToken', 'synthetic-token');
    h.secrets.set('unrelated', 'keep');
    h.context.secrets.get = async () => {
      assert.fail('新闻不能读取凭证');
    };
    h.store.set('newsCache', {
      source: 'xuangubao',
      items: [{ ...article(99), source: 'xuangubao', key: 'xuangubao:99' }]
    });
  });
  try {
    assert.equal(h.c.items.length, 0);
    await h.c.refresh();
    assert.equal(h.c.config.source, 'eastmoney');
    assert.deepEqual(h.c.items, [article(1)]);
    assert.equal(h.secrets.has('aShareTurnover.xuangubaoToken'), false);
    assert.equal(h.secrets.get('unrelated'), 'keep');
    assert.equal(h.store.get('newsCache').source, 'eastmoney');
    assert.match(h.c.status.tooltip, /东方财富/);
    assert.equal(h.opened.length, 0);
  } finally {
    h.c.dispose();
  }
});

test('旧凭证清理失败不阻塞公开新闻，日志不包含凭证内容', async () => {
  const h = setup({}, undefined, (h) => {
    h.context.secrets.delete = async () => {
      throw new Error('synthetic-secret');
    };
  });
  const logs = [];
  h.c.log = (m) => logs.push(m);
  try {
    await h.c.refresh();
    assert.equal(h.c.items.length, 1);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0], /synthetic-secret/);
    assert.equal(h.c.error, '');
  } finally {
    h.c.dispose();
  }
});

test('东方财富旧缓存仍可离线打开，刷新间隔修改不清空文章', async () => {
  const h = setup(
    {},
    async () => {
      throw new Error('离线');
    },
    (h) => {
      h.store.set('newsCache', { source: 'eastmoney', items: [article(1)] });
    }
  );
  try {
    h.c.show();
    assert.match(h.c.output.lines[0], /缓存/);
    assert.match(h.c.output.lines[1], /测试全文/);
    await h.api.workspace.getConfiguration('aShareTurnover').update('news.refreshIntervalSeconds', 60);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.c.config.interval, 60000);
    assert.equal(h.c.items.length, 1);
  } finally {
    h.c.dispose();
  }
});

test('新闻只使用底部输出，包含全文和时间；无变化不重写悬浮，主动打开清除未读', async () => {
  const h = setup();
  try {
    await h.c.refresh();
    const writes = { ...h.c.status.writes };
    h.c.publish();
    h.c.publish();
    assert.deepEqual(h.c.status.writes, writes);
    assert.equal(h.c.output.name, '财经新闻7×24资讯');
    assert.match(h.c.output.lines[0], /📣.*\n📄 摘要：测试全文\n🕒 时间：/);
    assert.equal(h.trees.size, 0);
    h.c.unread = 2;
    h.c.show();
    assert.equal(h.c.unread, 0);
    assert.equal(h.c.output.shown, 1);
  } finally {
    h.c.dispose();
  }
});

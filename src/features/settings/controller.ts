import { settingsHtml } from './view';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { normalizeDate } from '../turnover/market';
import { endpoint, modelName } from '../ai/client';
import { COLOR_KEYS, HEX_COLOR } from '../watchlist/colors';
import * as manifest from '../../../package.json';
const properties = manifest.contributes.configuration.properties;
const GROUPS = [
  {
    id: 'market',
    title: '状态栏与市场',
    keys: [
      'enabled',
      'comparisonMode',
      'showDifferenceAmount',
      'colorMode',
      'sectors.enabled',
      'sectors.category',
      'sectors.direction',
      'temperature.enabled',
      'temperature.colorize'
    ]
  },
  {
    id: 'stocks',
    title: '自选与图表',
    keys: [
      'stocks.enabled',
      'stocks.colorMode',
      'stocks.upColor',
      'stocks.downColor',
      'stocks.symbols',
      'stocks.groups',
      'stocks.hkSymbols',
      'stocks.hkGroups',
      'stocks.usSymbols',
      'stocks.usGroups',
      'stocks.statusBarSymbol',
      'stocks.sortBy',
      'stocks.trendDisplay',
      'stocks.volumeComparison',
      'charts.defaultMode'
    ]
  },
  {
    id: 'assets',
    title: '指数、基金与商品',
    keys: [
      'globalIndices.enabled',
      'globalIndices.symbols',
      'funds.enabled',
      'funds.estimateEnabled',
      'funds.symbols',
      'commodities.enabled',
      'commodities.symbols',
      'futures.enabled',
      'futures.symbols'
    ]
  },
  { id: 'news', title: '财经新闻', keys: ['news.highlightTitles', 'news.refreshIntervalSeconds'] },
  {
    id: 'risk',
    title: '涨跌提醒与风险',
    keys: [
      'stockAlerts.mode',
      'stockAlerts.limitEvents',
      'turnoverAlerts.enabled',
      'turnoverAlerts.percent',
      'turnoverAlerts.colorize',
      'risk.enabled',
      'risk.volumePercent',
      'risk.dropPercent'
    ]
  },
  {
    id: 'events',
    title: '大事提醒与休市',
    keys: ['reminders.enabled', 'reminders.notifications', 'reminders.categories', 'additionalClosedDates']
  },
  { id: 'ai', title: 'AI 分析', keys: ['ai.baseUrl', 'ai.model'], actions: ['ai.save', 'ai.test'] }
];
const LABELS = {
  'funds.estimateEnabled': '显示基金盘中估算',
  'stocks.colorMode': '自选配色',
  'stocks.upColor': '上涨颜色',
  'stocks.downColor': '下跌颜色',
  'ai.baseUrl': 'API 地址',
  'ai.model': '模型名称',
  'stockAlerts.mode': '自选股异常波动提醒',
  'stockAlerts.limitEvents': 'A 股涨跌停与炸板提醒',
  'turnoverAlerts.enabled': '大盘放量 / 缩量弹窗提醒',
  'turnoverAlerts.percent': '放量 / 缩量提醒阈值（%）',
  'turnoverAlerts.colorize': '超过阈值时成交额变色',
  enabled: '显示成交额',
  comparisonMode: '放量 / 缩量比较方式',
  showDifferenceAmount: '显示成交额差值',
  colorMode: '成交额颜色',
  'sectors.enabled': '显示板块排行',
  'sectors.category': '板块类型',
  'sectors.direction': '涨跌榜',
  'temperature.enabled': '显示市场温度',
  'temperature.colorize': '温度使用颜色区分',
  'stocks.enabled': '启用自选行情',
  'stocks.symbols': 'A 股自选',
  'stocks.hkSymbols': '港股自选',
  'stocks.usSymbols': '美股自选',
  'stocks.statusBarSymbol': '底部显示的股票 / 指数',
  'stocks.sortBy': '自选排序',
  'stocks.trendDisplay': '列表趋势',
  'stocks.volumeComparison': '列表七日均量对比',
  'charts.defaultMode': '默认图表',
  'globalIndices.enabled': '显示全球指数',
  'globalIndices.symbols': '关注的指数',
  'funds.enabled': '显示基金',
  'funds.symbols': '关注的基金',
  'commodities.enabled': '显示全球商品',
  'commodities.symbols': '关注的商品',
  'futures.enabled': '显示期货',
  'futures.symbols': '关注的期货',
  'news.highlightTitles': '高亮新闻标题',
  'news.refreshIntervalSeconds': '刷新间隔（秒）',
  'risk.enabled': '启用风险提示',
  'risk.volumePercent': '成交额变化阈值（%）',
  'risk.dropPercent': '上证跌幅阈值（%）',
  'reminders.enabled': '显示大事倒计时',
  'reminders.notifications': '启用事件弹窗',
  'reminders.categories': '提醒哪些大事',
  additionalClosedDates: '补充休市日期'
};
const HELP = {
  'funds.estimateEnabled':
    '有有效估值时自动显示估算涨跌和持仓收益；正式净值公布后切回。每60秒检查，缺失或过期时显示正式净值。部分主动基金、货币基金没有估值；估算不等于实际收益。',
  'stocks.colorMode':
    '统一调整 A 股、港股、美股列表的涨跌箭头，以及底部股票行情。跟随主题时不使用红绿区分，保留箭头和涨跌数字。',
  'stocks.upColor': '点击色块选色，或输入六位 HEX 颜色。修改后立即生效。',
  'stocks.downColor': '可与上涨使用相同颜色，选中个股后仍保留自定义颜色。',
  'ai.baseUrl':
    '填写兼容 API 地址，例如 https://api.deepseek.com 或 https://api.openai.com/v1，也支持完整 /responses 地址。',
  'ai.model': '获取列表后选择，也可输入自定义模型 ID；选择后保存。是否支持分析可用“测试连接”确认。',
  'turnoverAlerts.enabled':
    '交易期间超过阈值时弹窗，当天放量、缩量各提醒一次，重启不重复；老板键、暂停或关闭成交额时不提醒。',
  'turnoverAlerts.percent':
    '默认 20，严格超过才触发。弹窗和变色使用状态栏所选比较口径，默认对比上一交易日同刻；选择昨日全天时，盘中累计额通常偏低。',
  'turnoverAlerts.colorize':
    '状态栏成交额一栏超过阈值后放量红色、缩量绿色；回到阈值内恢复常规颜色设置。此项可独立于弹窗开关使用。',
  'stockAlerts.mode':
    'A股、港股和美股涨跌超过7%时提醒；下方可启用A股涨跌停事件。每只股票每类每天最多一次。“一直提醒”在老板键开启时仍弹窗；关闭自选行情或暂停时不监测。',
  'stockAlerts.limitEvents':
    '仅A股个股：涨停、跌停、涨停炸板、跌停炸板。按当日实际限价判断；开板须先观测到涨跌停，再离开限价。每类每天最多一次，重启不重复；关闭不影响7%提醒。',
  enabled: '底部显示沪深 A 股成交额。市场温度和风险提示需要此项。',
  comparisonMode: '昨日指上一个交易日。',
  showDifferenceAmount: '在百分比后显示增加或减少了多少亿元。',
  colorMode: '选择常规颜色；开启超过阈值变色后，优先使用提醒颜色。',
  'sectors.enabled': '显示所选涨跌榜第一名，悬停看前十；点击底部板块行情可直接切换榜单。',
  'sectors.category': '选择行业或概念板块排行。',
  'sectors.direction': '涨幅榜从高到低，跌幅榜从低到高。切换后立即更新并记住选择。',
  'temperature.enabled': '查看市场冷热和当天走势，需要开启成交额。',
  'temperature.colorize': '偏热用红色，偏冷用蓝色。',
  'stocks.enabled': '启用侧栏自选和底部股票行情。',
  'stocks.statusBarSymbol': '可选择上证指数或已添加的 A 股自选。',
  'stocks.sortBy': '选择手动顺序时，可在侧栏拖动个股排序。',
  'stocks.trendDisplay': '在行尾显示基于5日、10日均线的短线趋势，可关闭；保留原生列表交互。',
  'stocks.volumeComparison':
    '对比前7个完整交易日均量：超过1.2倍放量，低于0.8倍缩量。A股、港股盘中按交易进度预估，收盘按实际量；美股盘中仅显示累计比例。',
  'charts.defaultMode': '下次新打开详情标签时使用；已经打开的标签保留当前图表。',
  'globalIndices.enabled': '启用全球指数栏目。',
  'funds.enabled': '启用净值和持仓收益栏目。',
  'commodities.enabled': '查看黄金、原油、铜银等全球商品参考行情。',
  'futures.enabled': '独立查看期货，点击添加可搜索国内主连、月份合约及海外期货；支持刷新和暂停。',
  'news.highlightTitles': '默认开启，标题高亮加粗；关闭后恢复普通输出样式。切换立即生效。',
  'news.refreshIntervalSeconds': '10–300 秒；休市期间也会更新。',
  'risk.enabled': '需同时开启成交额和自选行情。放缩量与上证跌幅同时达到阈值时提示。',
  'risk.volumePercent': '例如 30，表示成交额比昨日同刻增加或减少至少 30%。',
  'risk.dropPercent': '例如 1.5，表示上证指数下跌至少 1.5%。',
  'reminders.enabled': '在底部显示最近事件，点击看日历。',
  'reminders.notifications': '事件前 24 小时和 30 分钟提醒；仅在 VS Code 运行时生效。',
  'reminders.categories': '勾选要关注的事件。',
  additionalClosedDates: '每行一个日期，例如 2026-12-31；只填写额外休市日。'
};
const OPTIONS = {
  'stocks.colorMode': ['红涨绿跌', '跟随主题', '自定义'],
  comparisonMode: ['昨日同一时刻', '昨日全天'],
  colorMode: ['默认颜色', '放量红色 / 缩量绿色'],
  'charts.defaultMode': [
    '内置分时',
    '内置五日分时',
    '1 分钟 K 线',
    '5 分钟 K 线',
    '15 分钟 K 线',
    '30 分钟 K 线',
    '60 分钟 K 线',
    '日 K',
    '周 K',
    '月 K',
    '东方财富图表',
    '东方财富筹码盘口'
  ]
};
const ACTIONS = {
  'ai.save': '保存配置',
  'ai.test': '测试连接'
};
const ADD_LABELS = {
  'stocks.symbols': '添加 A 股',
  'stocks.hkSymbols': '添加港股',
  'stocks.usSymbols': '添加美股',
  'globalIndices.symbols': '添加指数',
  'funds.symbols': '添加基金',
  'commodities.symbols': '添加商品',
  'futures.symbols': '添加期货'
};
const LISTS = new Set([
  'stocks.symbols',
  'stocks.hkSymbols',
  'stocks.usSymbols',
  'globalIndices.symbols',
  'funds.symbols',
  'commodities.symbols',
  'futures.symbols'
]);
const GROUP_KEYS = new Set(['stocks.groups', 'stocks.hkGroups', 'stocks.usGroups']);
const STOCK_MARKETS = { 'stocks.symbols': 'a', 'stocks.hkSymbols': 'hk', 'stocks.usSymbols': 'us' };
function schema(key) {
  return properties['aShareTurnover.' + key];
}
function validate(key, value, read = (_key: string): any => undefined) {
  const s = schema(key);
  if (!Object.hasOwn(LABELS, key) || LISTS.has(key) || GROUP_KEYS.has(key)) throw new Error('不支持修改此设置');
  if ((s.type === 'boolean' && typeof value !== 'boolean') || (s.type === 'string' && typeof value !== 'string'))
    throw new Error('设置值格式不正确');
  if (
    ['number', 'integer'].includes(s.type) &&
    (typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (s.type === 'integer' && !Number.isInteger(value)) ||
      value < s.minimum ||
      value > s.maximum)
  )
    throw new Error(`请输入 ${s.minimum}–${s.maximum} 之间的${s.type === 'integer' ? '整数' : '数值'}`);
  if (s.enum && !s.enum.includes(value)) throw new Error('请选择有效选项');
  if (COLOR_KEYS.has(key) && key !== 'stocks.colorMode') {
    value = value.trim();
    if (!HEX_COLOR.test(value)) throw new Error('请输入六位 HEX 颜色，例如 #f14c4c');
    value = value.toLowerCase();
  }
  if (key === 'ai.baseUrl') {
    value = value.trim();
    if (value.length > 2048) throw new Error('API 地址过长');
    if (value) endpoint(value);
  }
  if (key === 'ai.model') {
    value = value.trim();
    if (value) value = modelName(value);
  }
  if (s.type === 'array') {
    if (!Array.isArray(value) || value.length > 366 || value.some((v) => typeof v !== 'string'))
      throw new Error('列表格式不正确');
    if (key === 'reminders.categories' && value.some((v) => !s.items.enum.includes(v))) throw new Error('未知事件类型');
    if (key === 'additionalClosedDates')
      for (const date of value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期请使用 YYYY-MM-DD');
        normalizeDate(date);
      }
    value = [...new Set(value)];
  }
  if (key === 'stocks.statusBarSymbol' && value !== 'sh000001' && !read('stocks.symbols').includes(value))
    throw new Error('请先添加这只自选股');
  return value;
}
interface SettingField {
  key: string;
  label: string;
  type: string;
  help?: string;
  configured?: boolean;
  endpoint?: string;
  options?: { value: unknown; label: string }[];
  min?: number;
  max?: number;
  value?: unknown;
  workspace?: boolean;
  visibleWhen?: { key: string; value: string };
  stockGroups?: unknown;
  addLabel?: string;
  canEdit?: boolean;
  items?: unknown;
}
class SettingsController {
  declare context: any;
  declare stocks: any;
  declare actions: {};
  declare lists: {};
  declare queue: Promise<void>;
  declare ai: any;
  declare listener: vscode.Disposable;
  declare listListeners: any[];
  declare aiTask:
    | {
        id: any;
        abort: AbortController;
        started: number;
        saved: boolean;
      }
    | null
    | undefined;
  declare aiTaskPromise: Promise<void> | undefined;
  declare signature: any;
  declare category: any;
  declare panel: vscode.WebviewPanel | null | undefined;
  declare token: string | undefined;
  declare hidden: any;
  declare disposed: boolean | undefined;

  constructor(
    context,
    {
      stocks,
      actions = {},
      lists = {},
      sources = [],
      ai
    }: {
      stocks?: import('../watchlist/controller').WatchlistController;
      actions?: Record<string, (...args: any[]) => unknown>;
      lists?: Record<string, any>;
      sources?: { onDidChangeTreeData: vscode.Event<any> }[];
      ai?: import('../ai/controller').AiAnalysisController;
    } = {}
  ) {
    this.context = context;
    this.stocks = stocks;
    this.actions = actions;
    this.lists = lists;
    this.queue = Promise.resolve();
    this.ai = ai;
    this.listener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aShareTurnover')) this.publish();
      if (e.affectsConfiguration('aShareTurnover.ai')) void this.ai?.updateConfiguration().then(() => this.publish());
    });
    void this.ai?.ready?.then(() => this.publish());
    this.listListeners = sources.map((source) => source.onDidChangeTreeData(() => this.publish()));
  }
  read(key) {
    if (LISTS.has(key) && this.lists[key]) return this.lists[key].ids();
    if (key.startsWith('futures.') || key.startsWith('commodities.')) {
      const fallback = this.context.globalState.get('stockSettingsFallback', {});
      if (Object.hasOwn(fallback, key)) return fallback[key];
    }
    const config = vscode.workspace.getConfiguration('aShareTurnover');
    if (key.startsWith('ai.') && config.inspect) return config.inspect(key)?.globalValue ?? schema(key).default;
    return key.startsWith('stocks.') && key !== 'stocks.enabled' && this.stocks
      ? this.stocks.settings.get(key, schema(key).default)
      : config.get(key, schema(key).default);
  }
  model() {
    const groups: { id: string; fields: SettingField[]; [key: string]: unknown }[] = GROUPS.map((group) => ({
      ...group,
      info: group.id === 'ai' ? '填写后保存即可使用。测试连接会先保存本页配置，并产生少量 API 用量。' : '',
      actions: (group.actions || []).map((id) => ({ id, label: ACTIONS[id] })),
      fields: group.keys
        .filter((key) => !GROUP_KEYS.has(key))
        .map((key) => {
          const s = schema(key),
            c = vscode.workspace.getConfiguration('aShareTurnover').inspect?.(key);
          const grouping = Object.hasOwn(STOCK_MARKETS, key) && this.stocks?.groupingFor?.(STOCK_MARKETS[key]);
          const options =
            key === 'stocks.statusBarSymbol'
              ? [...new Set(['sh000001', ...this.read('stocks.symbols')])].map((value) => ({
                  value,
                  label:
                    value === 'sh000001'
                      ? '上证指数'
                      : `${this.lists['stocks.symbols']?.name(value) || this.stocks?.quotes.get(value)?.name || '名称待获取'} · ${value}`
                }))
              : (s.enum || s.items?.enum || []).map((value, i) => ({
                  value,
                  label: OPTIONS[key]?.[i] || (s.enumDescriptions || s.items?.enumDescriptions)?.[i] || value
                }));
          const isColor = COLOR_KEYS.has(key) && key !== 'stocks.colorMode';
          return {
            key,
            label: LABELS[key],
            help: HELP[key] || '',
            type: isColor
              ? 'color'
              : LISTS.has(key)
                ? 'list'
                : key === 'additionalClosedDates'
                  ? 'dates'
                  : options.length
                    ? s.type === 'array'
                      ? 'checks'
                      : 'select'
                    : s.type,
            options,
            min: s.minimum,
            max: s.maximum,
            value: this.read(key),
            workspace: c?.workspaceValue !== undefined,
            visibleWhen: isColor ? { key: 'stocks.colorMode', value: 'custom' } : undefined,
            ...(LISTS.has(key)
              ? {
                  addLabel: ADD_LABELS[key],
                  canEdit: Boolean(this.lists[key]?.edit),
                  items: this.read(key).map((id) => ({ id, name: this.lists[key]?.name(id) || '名称待获取' }))
                }
              : {}),
            ...(grouping ? { stockGroups: grouping.buckets() } : {})
          };
        })
    }));
    let keyConfigured = false;
    try {
      keyConfigured = Boolean(this.ai?.keyConfigured && this.ai.keyEndpoint === endpoint(this.read('ai.baseUrl')));
    } catch {
      /* Unconfigured URL. */
    }
    groups
      .find((g) => g.id === 'ai')!
      .fields.splice(1, 0, {
        key: 'ai.apiKey',
        label: 'API Key',
        type: 'secret',
        help: '安全保存在本机，不写入设置文件。已保存时留空可保留，输入新 Key 可替换。',
        configured: keyConfigured,
        endpoint: this.read('ai.baseUrl')
      });
    return groups;
  }
  configureAi(panel, token, message) {
    if (
      this.aiTask ||
      !['save', 'test', 'clear', 'models'].includes(message.operation) ||
      typeof message.id !== 'string' ||
      !/^[\w-]{1,64}$/.test(message.id)
    )
      return;
    const task: NonNullable<SettingsController['aiTask']> = (this.aiTask = {
      id: message.id,
      abort: new AbortController(),
      started: Date.now(),
      saved: false
    });
    const active = () =>
      this.aiTask === task && this.panel === panel && !this.hidden && !this.disposed && !task.abort.signal.aborted;
    const check = () => {
      if (!active()) {
        const e = new Error('操作已取消。');
        e.name = 'AbortError';
        throw e;
      }
    };
    const post = (value) => {
      if (this.panel === panel && !this.hidden && !this.disposed)
        void panel.webview.postMessage({ token, id: task.id, ...value });
    };
    const prepare = this.queue
      .catch(() => {})
      .then(async () => {
        check();
        if (!this.ai) throw new Error('AI 功能尚未就绪，请重载窗口后重试。');
        if (message.operation === 'clear') {
          await this.ai.clearKey(message.url);
          check();
          return;
        }
        const url = validate('ai.baseUrl', message.url);
        endpoint(url);
        const key = message.key;
        if (typeof key !== 'string' || key.length > 4096 || /[\r\n]/.test(key))
          throw new Error('请输入有效的 API Key。');
        if (message.operation === 'models') return { url, model: '' };
        const model = modelName(message.model);
        const c = vscode.workspace.getConfiguration('aShareTurnover');
        if (this.read('ai.baseUrl') !== url) await c.update('ai.baseUrl', url, vscode.ConfigurationTarget.Global);
        check();
        if (this.read('ai.model') !== model) await c.update('ai.model', model, vscode.ConfigurationTarget.Global);
        check();
        if (key.trim()) await this.ai.saveKey(key, url);
        else await this.ai.updateConfiguration();
        check();
        task.saved = true;
        return { url, model };
      });
    this.queue = prepare.then(
      () => {},
      () => {}
    ); // A network test must not block unrelated settings.
    this.aiTaskPromise = prepare
      .then(async (config) => {
        check();
        let models: string[] | undefined;
        if (message.operation === 'models') {
          post({ type: 'aiProgress', note: '正在获取模型列表' });
          models = await this.ai.getModels({ url: config!.url, key: message.key, signal: task.abort.signal });
          check();
        }
        if (message.operation === 'test') {
          const phases = {
            connecting: '正在连接服务',
            waiting: '等待模型回复',
            reasoning: '模型正在思考',
            answering: '正在接收回复'
          };
          post({ type: 'aiProgress', note: '正在连接服务' });
          await this.ai.testConnection({
            signal: task.abort.signal,
            expectedUrl: config!.url,
            expectedModel: config!.model,
            onProgress: (phase) => {
              if (active() && phases[phase]) post({ type: 'aiProgress', note: phases[phase] });
            }
          });
          check();
        }
        post({
          type: 'aiResult',
          ok: true,
          saved: task.saved,
          operation: message.operation,
          ...(models ? { models } : {}),
          elapsedMs: Date.now() - task.started,
          note:
            message.operation === 'models'
              ? models?.length
                ? `已获取 ${models.length} 个模型，请选择后保存。是否支持分析可用“测试连接”确认。`
                : '接口未返回可用模型，可手动输入模型 ID。'
              : message.operation === 'test'
                ? '连接成功，可以开始分析。'
                : message.operation === 'clear'
                  ? '已清除当前接口的 Key。'
                  : this.ai.configured
                    ? '配置已保存。'
                    : '配置已保存，请填写 API Key 后开始分析。'
        });
      })
      .catch((error) => {
        post({
          type: 'aiResult',
          ok: false,
          saved: task.saved,
          operation: message.operation,
          cancelled: task.abort.signal.aborted || error.name === 'AbortError',
          error:
            task.abort.signal.aborted || error.name === 'AbortError'
              ? message.operation === 'models'
                ? '获取模型列表已取消。'
                : '测试已取消。'
              : error.message || '操作失败，请重试。'
        });
      })
      .finally(() => {
        message.key = undefined;
        if (this.aiTask === task) this.aiTask = null;
        this.publish(true);
      });
  }
  publish(force = false) {
    if (this.panel && !this.hidden && !this.disposed) {
      const groups = this.model(),
        signature = JSON.stringify(groups);
      if (!force && signature === this.signature && !this.category) return;
      this.signature = signature;
      void this.panel.webview.postMessage({ type: 'state', token: this.token, groups, category: this.category });
      this.category = undefined;
    }
  }
  open(category?: string) {
    if (this.hidden || this.disposed) return;
    if (GROUPS.some((g) => g.id === category)) this.category = category;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.publish(true);
      return;
    }
    const panel = (this.panel = vscode.window.createWebviewPanel(
      'welove42.aShareTurnover.settings',
      '行情设置',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
          vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews')
        ]
      }
    ));
    const token = (this.token = randomBytes(24).toString('hex'));
    panel.webview.html = settingsHtml(panel.webview, this.context, token);
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.aiTask?.abort.abort();
        this.panel = null;
      }
    });
    panel.webview.onDidReceiveMessage((message) => {
      if (!message || message.token !== token || this.panel !== panel || this.hidden || this.disposed) return;
      if (message.type === 'aiConfigure') {
        this.configureAi(panel, token, message);
        return;
      }
      if (message.type === 'aiCancel') {
        if (this.aiTask?.id === message.id) this.aiTask?.abort.abort();
        return;
      }
      if (message.type === 'ready') {
        this.publish(true);
        return;
      }
      this.queue = this.queue
        .catch(() => {})
        .then(async () => {
          if (this.panel !== panel || this.hidden || this.disposed) return;
          try {
            if (message.type === 'stockGroup') {
              const grouping =
                Object.hasOwn(STOCK_MARKETS, message.key) && this.stocks?.groupingFor?.(STOCK_MARKETS[message.key]);
              if (!grouping) throw new Error('不支持此分组操作');
              if (message.operation === 'create') await grouping.create();
              else {
                const group = typeof message.groupId === 'string' && grouping.bucket(message.groupId);
                if (!group) throw new Error('分组已不存在，请重试');
                if (message.operation === 'add') await grouping.add(group.id);
                else if (message.operation === 'move') {
                  if (typeof message.id !== 'string' || !grouping.config.symbols.includes(message.id))
                    throw new Error('该股票已不在自选中');
                  await grouping.move(message.id, group.id);
                } else if (!group.custom) throw new Error('未分组不能重命名、删除或排序');
                else if (message.operation === 'rename') await grouping.rename(group.id);
                else if (message.operation === 'remove') await grouping.remove(group.id);
                else if (message.operation === 'up' || message.operation === 'down')
                  await grouping.shift(group.id, message.operation === 'up' ? -1 : 1);
                else throw new Error('不支持此分组操作');
              }
            } else if (message.type === 'list') {
              const list = LISTS.has(message.key) && this.lists[message.key];
              if (
                !list ||
                !['add', 'remove', 'edit'].includes(message.operation) ||
                typeof list[message.operation] !== 'function'
              )
                throw new Error('不支持此列表操作');
              if (message.operation !== 'add' && (typeof message.id !== 'string' || !list.ids().includes(message.id)))
                throw new Error('该项目已不在列表中，请重试');
              await list[message.operation](message.operation === 'add' ? undefined : message.id);
            } else if (message.type === 'action') {
              if (!Object.hasOwn(ACTIONS, message.action) || typeof this.actions[message.action] !== 'function')
                throw new Error('未知操作');
              await this.actions[message.action]();
            } else if (message.type === 'save' || message.type === 'reset') {
              const value = validate(
                message.key,
                message.type === 'reset' ? schema(message.key)?.default : message.value,
                (key) => this.read(key)
              );
              if (message.key.startsWith('stocks.') && message.key !== 'stocks.enabled' && this.stocks)
                await this.stocks.updateSetting(message.key, value);
              else {
                const c = vscode.workspace.getConfiguration('aShareTurnover');
                const target =
                  !message.key.startsWith('ai.') && c.inspect?.(message.key)?.workspaceValue !== undefined
                    ? vscode.ConfigurationTarget.Workspace
                    : vscode.ConfigurationTarget.Global;
                await c.update(message.key, value, target);
              }
            } else return;
            if (this.panel === panel && !this.hidden) {
              await panel.webview.postMessage({
                type: 'result',
                token,
                key: message.key,
                action: message.action,
                ok: true,
                note: message.action === 'ai.test' ? '连接成功，可以开始分析。' : undefined
              });
              this.publish(true);
            }
          } catch (error) {
            if (this.panel === panel && !this.hidden)
              void panel.webview.postMessage({
                type: 'result',
                token,
                key: message.key,
                action: message.action,
                ok: false,
                error: error.message || '保存失败，请重试'
              });
          }
        });
    });
  }
  setHidden(hidden) {
    this.hidden = hidden;
    if (hidden) this.panel?.dispose();
  }
  dispose() {
    this.disposed = true;
    this.panel?.dispose();
    this.listener.dispose();
    for (const listener of this.listListeners) listener.dispose();
  }
}
export { SettingsController, validate, GROUPS, LISTS };

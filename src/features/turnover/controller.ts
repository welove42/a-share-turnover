import * as vscode from 'vscode';
import * as privateUI from '../../core/ui/privacy';
import { MarketProvider } from './provider';
import { POLL_MS, session, isSnapshot, PHASE_LABELS } from './market';
import { view } from './view';
import { marketRisk } from './risk';
import { marketTemperature, temperatureView } from '../temperature/service';
import { TemperatureHistory } from '../temperature/history';
import { TemperatureChartController } from '../temperature/chart';
import { TurnoverAlerts } from './alerts';

/** 管理成交额轮询、缓存与状态栏；入口只负责创建和销毁实例。 */
class TurnoverController {
  declare context: any;
  declare now: () => Date;
  declare disposed: boolean;
  declare lastAttempt: number;
  declare lastPhase: string;
  declare lastDate: string;
  declare inflight: any;
  declare rendered: any;
  declare visible: boolean;
  declare state: {
    paused: boolean;
    cached: boolean;
    error: string;
    busy: boolean;
  };
  declare snapshot: any;
  declare output: vscode.OutputChannel;
  declare turnoverAlerts: TurnoverAlerts;
  declare item: vscode.StatusBarItem;
  declare temperatureItem: vscode.StatusBarItem;
  declare temperatureOutput: vscode.OutputChannel;
  declare temperatureHistory: TemperatureHistory;
  declare temperatureChart: TemperatureChartController;
  declare provider: any;
  declare config: {
    enabled: boolean;
    comparisonMode: string;
    showDifferenceAmount: boolean;
    colorMode: string;
    turnoverAlerts: {
      enabled: boolean;
      percent: number;
      colorize: boolean;
    };
    additionalClosedDates: never[];
    temperature: {
      enabled: boolean;
      colorize: boolean;
    };
    risk: {
      enabled: boolean;
      volumePercent: number;
      dropPercent: number;
    };
  };
  declare requestController: AbortController | null;
  declare listeners: vscode.Disposable[];
  declare timer: NodeJS.Timeout | undefined;
  declare temperatureVisible: boolean | undefined;
  declare temperatureResult:
    | {
        score: null;
        label: any;
        reason: any;
      }
    | {
        score: number;
        label: string;
        components: {
          breadth: number;
          momentum: number;
          turnover: number;
        };
        counts: {
          [k: string]: any;
        };
        total: any;
        averagePercent: number;
        volumePercent: any;
        markets: any[];
        comparisonTime: any;
        date: any;
        phase: any;
        reason: string;
      }
    | undefined;
  declare temperatureRendered:
    | {
        text: string;
        markdown: string;
        detail: string;
        color: string | undefined;
        accessibility: string;
      }
    | undefined;
  declare hidden: any;
  declare riskSource: any;

  constructor(context, provider?: MarketProvider, now = () => new Date()) {
    this.context = context;
    this.now = now;
    this.disposed = false;
    this.lastAttempt = -Infinity;
    this.lastPhase = '';
    this.lastDate = '';
    this.inflight = null;
    this.rendered = null;
    this.visible = false;
    this.state = { paused: Boolean(context.globalState.get('paused', false)), cached: false, error: '', busy: false };
    const cached = context.globalState.get('snapshot');
    this.snapshot = isSnapshot(cached) ? cached : null;
    this.state.cached = Boolean(this.snapshot);
    this.output = vscode.window.createOutputChannel('A股成交额');
    this.turnoverAlerts = new TurnoverAlerts(
      context.globalState,
      (text) => vscode.window.showWarningMessage(text),
      (message) => this.log(message)
    );
    this.item = vscode.window.createStatusBarItem('aShareTurnover', vscode.StatusBarAlignment.Right, 100);
    this.item.name = '沪深 A 股成交额';
    this.item.command = 'welove42.aShareTurnover.showMenu';
    this.temperatureItem = vscode.window.createStatusBarItem(
      'aShareTurnover.temperature',
      vscode.StatusBarAlignment.Right,
      99
    );
    this.temperatureItem.name = '沪深A股市场温度';
    this.temperatureItem.command = 'welove42.aShareTurnover.showTemperature';
    this.temperatureOutput = vscode.window.createOutputChannel('A股市场温度');
    this.temperatureHistory = new TemperatureHistory(context.globalState, session(this.now()).date, (message) =>
      this.log(message)
    );
    this.temperatureChart = new TemperatureChartController(context, () => this.temperatureChartData());
    this.provider = provider || new MarketProvider({ log: (message) => this.log(message), now });
    this.config = this.readConfig();
    this.requestController = null;
    this.listeners = [
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('aShareTurnover')) return;
        const wasEnabled = this.config.enabled;
        this.config = this.readConfig();
        if (!this.config.enabled) this.requestController?.abort();
        this.render();
        if (!wasEnabled && this.config.enabled && !this.state.paused) {
          // A quick disable/enable may still have an aborted request settling.
          // Wait for it, then start a fresh request even outside trading hours.
          void (this.inflight || Promise.resolve()).then(() => {
            if (!this.disposed && this.config.enabled && !this.state.paused) return this.refresh();
          });
        }
      })
    ];
  }

  readConfig() {
    const config = vscode.workspace.getConfiguration('aShareTurnover');
    return {
      enabled: config.get('enabled', true),
      comparisonMode: config.get('comparisonMode', 'sameTime'),
      showDifferenceAmount: config.get('showDifferenceAmount', true),
      colorMode: config.get('colorMode', 'neutral'),
      turnoverAlerts: {
        enabled: config.get('turnoverAlerts.enabled', true),
        percent: config.get('turnoverAlerts.percent', 20),
        colorize: config.get('turnoverAlerts.colorize', true)
      },
      additionalClosedDates: config.get('additionalClosedDates', []),
      temperature: {
        enabled: config.get('temperature.enabled', true),
        colorize: config.get('temperature.colorize', true)
      },
      risk: {
        enabled: config.get('risk.enabled', true),
        volumePercent: config.get('risk.volumePercent', 30),
        dropPercent: config.get('risk.dropPercent', 1.5)
      }
    };
  }

  log(message) {
    if (!this.disposed) this.output.appendLine(`[${this.now().toISOString()}] ${message}`);
  }

  start() {
    const clock = session(this.now(), this.config.additionalClosedDates);
    this.lastPhase = clock.phase;
    this.lastDate = clock.date;
    this.render();
    // This timer checks the local clock only. Network requests remain 10s apart.
    this.timer = setInterval(() => void this.tick(), 1000);
    if (this.config.enabled && !this.state.paused) void this.refresh();
  }

  tick() {
    if (this.disposed || this.hidden) return;
    const clock = session(this.now(), this.config.additionalClosedDates);
    const phaseChanged = clock.phase !== this.lastPhase;
    const dateChanged = clock.date !== this.lastDate;
    const wasTrading = this.lastPhase === 'trading';
    this.lastPhase = clock.phase;
    this.lastDate = clock.date;
    // Re-render locally so data staleness is visible even during a failed request.
    this.render();
    if (!this.config.enabled || this.state.paused || this.inflight) return;
    const elapsed = this.now().getTime() - this.lastAttempt;
    if (
      (clock.polling && elapsed >= POLL_MS) ||
      (phaseChanged && wasTrading) ||
      (dateChanged && this.lastAttempt !== -Infinity)
    )
      return this.refresh();
  }

  refresh(manual = false) {
    if (this.disposed || this.hidden || !this.config.enabled) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.lastAttempt = this.now().getTime();
    this.requestController = new AbortController();
    this.state.busy = true;
    this.render();
    this.inflight = this.fetchAndRender(this.requestController.signal, manual).finally(() => {
      this.inflight = null;
      this.requestController = null;
      this.state.busy = false;
      if (!this.disposed) this.render();
    });
    return this.inflight;
  }

  async fetchAndRender(signal, manual) {
    try {
      const snapshot = await this.provider.load(signal, manual);
      if (this.disposed || signal.aborted) return;
      if (!isSnapshot(snapshot)) throw new Error('行情快照校验失败');
      const clock = session(this.now(), this.config.additionalClosedDates);
      if (snapshot.date > clock.date) throw new Error('行情日期晚于北京时间，请核对系统时间');
      this.snapshot = snapshot;
      this.state.error = '';
      this.state.cached = false;
      this.temperatureHistory.rollover(clock.date);
      if (this.config.temperature.enabled) {
        const result = marketTemperature(snapshot, this.state, clock, this.now());
        this.temperatureHistory.record(result, snapshot.fetchedAt);
        await this.temperatureHistory.flush();
      }
      await this.context.globalState
        .update('snapshot', snapshot)
        .catch((error) => this.log(`缓存保存失败：${error.message}`));
      if (!this.disposed && !this.hidden && !signal.aborted) {
        const now = this.now();
        this.turnoverAlerts.check(
          snapshot,
          this.state,
          this.config,
          session(now, this.config.additionalClosedDates),
          now
        );
      }
    } catch (error) {
      if (this.disposed || signal.aborted) return;
      this.state.error = error.message || '网络连接失败';
      this.log(this.state.error);
    }
  }

  render() {
    if (this.disposed) return;
    const now = this.now(),
      clock = session(now, this.config.additionalClosedDates);
    this.temperatureHistory.rollover(clock.date);
    if (!this.config.enabled || this.hidden) {
      if (this.visible) {
        this.item.hide();
        this.visible = false;
      }
      if (this.temperatureVisible) {
        this.temperatureItem.hide();
        this.temperatureVisible = false;
      }
      this.temperatureChart.update();
      return;
    }
    const result = view(this.snapshot, this.state, this.config, clock, now);
    const risk = marketRisk(this.snapshot, this.state, this.riskSource?.(), clock, now, this.config.risk);
    if (risk) {
      result.text += ` | $(warning) ${risk.label}`;
      result.markdown += `\n\n**风险提示：${risk.label}**。沪深A股成交额较昨同刻 ${risk.volume >= 0 ? '+' : ''}${risk.volume.toFixed(2)}%，上证指数 ${risk.change.toFixed(2)}%；比较时间 ${risk.comparisonTime}，触发阈值为成交额变化至少 ${risk.volumeLimit}% 且指数跌幅至少 ${risk.dropLimit}%。`;
      result.accessibility += ` 风险提示：${risk.label}。`;
    }
    const markdown = result.markdown.replace(/[<>]/g, '');
    const previous = this.rendered;
    // Avoid invalidating the status bar/hover during unchanged clock checks.
    if (!previous || result.text !== previous.text) this.item.text = result.text;
    if (!previous || markdown !== previous.markdown) {
      // All tooltip text is generated locally; disable executable links and HTML.
      const tooltip = new vscode.MarkdownString(markdown);
      tooltip.isTrusted = false;
      tooltip.supportHtml = false;
      this.item.tooltip = tooltip;
    }
    if (!previous || result.color !== previous.color) {
      this.item.color = result.color ? new vscode.ThemeColor(result.color) : undefined;
    }
    if (!previous || result.accessibility !== previous.accessibility) {
      this.item.accessibilityInformation = { label: result.accessibility };
    }
    this.rendered = { ...result, markdown };
    if (!this.visible) {
      this.item.show();
      this.visible = true;
    }
    this.renderTemperature(clock, now);
    this.temperatureChart.update();
  }

  renderTemperature(clock, now) {
    if (!this.config.temperature.enabled) {
      if (this.temperatureVisible) {
        this.temperatureItem.hide();
        this.temperatureVisible = false;
      }
      return;
    }
    this.temperatureResult = marketTemperature(this.snapshot, this.state, clock, now);
    const result = temperatureView(this.temperatureResult, this.config.temperature),
      previous = this.temperatureRendered;
    if (!previous || previous.text !== result.text) this.temperatureItem.text = result.text;
    if (!previous || previous.markdown !== result.markdown) {
      const tooltip = new vscode.MarkdownString(result.markdown);
      tooltip.isTrusted = false;
      tooltip.supportHtml = false;
      this.temperatureItem.tooltip = tooltip;
    }
    if (!previous || previous.color !== result.color)
      this.temperatureItem.color = result.color ? new vscode.ThemeColor(result.color) : undefined;
    if (!previous || previous.accessibility !== result.accessibility)
      this.temperatureItem.accessibilityInformation = { label: result.accessibility };
    this.temperatureRendered = result;
    if (!this.temperatureVisible) {
      this.temperatureItem.show();
      this.temperatureVisible = true;
    }
  }

  temperatureChartData() {
    const now = this.now(),
      clock = session(now, this.config.additionalClosedDates);
    const result =
      !this.config.enabled || !this.config.temperature.enabled
        ? { score: null, label: '已停用', reason: '温度或成交额模块已停用，当前曲线保留已采集记录。' }
        : marketTemperature(this.snapshot, this.state, clock, now);
    return {
      ...this.temperatureHistory.data(),
      current: { score: result.score, label: result.label, reason: result.reason },
      phase: PHASE_LABELS[clock.phase]
    };
  }

  showTemperature() {
    if (this.disposed || this.hidden) return;
    this.temperatureHistory.rollover(session(this.now(), this.config.additionalClosedDates).date);
    this.temperatureChart.open();
  }

  showTemperatureDetails() {
    const now = this.now(),
      clock = session(now, this.config.additionalClosedDates);
    const result = marketTemperature(this.snapshot, this.state, clock, now);
    this.temperatureOutput.clear();
    this.temperatureOutput.appendLine(temperatureView(result, this.config.temperature).detail);
    this.temperatureOutput.show();
  }

  async togglePause() {
    this.state.paused = !this.state.paused;
    if (this.state.paused) this.requestController?.abort();
    await this.context.globalState.update('paused', this.state.paused);
    this.render();
    if (!this.state.paused) {
      if (this.inflight) await this.inflight;
      return this.refresh();
    }
  }

  async switchComparison() {
    const selected = await privateUI.showQuickPick(
      [
        { label: '昨日同刻', description: '相同分钟的累计成交额（默认）', mode: 'sameTime' },
        { label: '昨日全天', description: '当前累计额对比上个交易日全天', mode: 'previousDay' }
      ],
      { title: '选择缩量 / 放量的比较口径', placeHolder: '昨日均指上一交易日' }
    );
    if (selected)
      await vscode.workspace
        .getConfiguration('aShareTurnover')
        .update('comparisonMode', selected.mode, vscode.ConfigurationTarget.Global);
  }

  async showMenu() {
    const selected = await privateUI.showQuickPick(
      [
        { label: '$(refresh) 立即刷新', command: 'welove42.aShareTurnover.refresh' },
        { label: '$(arrow-swap) 切换比较口径', command: 'welove42.aShareTurnover.switchComparison' },
        { label: '$(dashboard) 市场温度走势图', command: 'welove42.aShareTurnover.showTemperature' },
        { label: '$(sparkle) AI 分析大盘', command: 'welove42.aShareTurnover.ai.market' },
        {
          label: this.state.paused ? '$(play) 恢复自动刷新' : '$(debug-pause) 暂停自动刷新',
          command: 'welove42.aShareTurnover.togglePause'
        },
        { label: '$(settings-gear) 插件设置', command: 'welove42.aShareTurnover.settings.open' },
        { label: '$(output) 查看请求日志', command: 'welove42.aShareTurnover.showLog' }
      ],
      { title: '沪深 A 股成交额', placeHolder: this.item.accessibilityInformation?.label }
    );
    if (!selected) return;
    return vscode.commands.executeCommand(selected.command);
  }

  setHidden(hidden) {
    this.hidden = hidden;
    if (hidden) {
      this.requestController?.abort();
      this.temperatureChart.state?.panel.dispose();
      this.output.hide();
      this.temperatureOutput.hide();
    }
    this.render();
    if (!hidden && !this.state.paused && this.config.enabled) {
      void (this.inflight || Promise.resolve()).then(() => {
        if (!this.disposed && !this.hidden && !this.state.paused && this.config.enabled) return this.refresh();
      });
    }
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.requestController?.abort();
    for (const listener of this.listeners) listener.dispose();
    this.item.dispose();
    this.temperatureItem.dispose();
    this.temperatureOutput.dispose();
    this.temperatureChart.dispose();
    this.output.dispose();
  }
}
export { TurnoverController };

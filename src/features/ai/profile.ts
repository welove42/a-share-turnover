import type { Memento } from 'vscode';
import type { TurnOptions } from './types';
import type { TurnRequest } from './agent';
import type { GlobalInterests } from './interests';
type Positions = Record<
  string,
  { status: string; cost: number | null; exposure: number | null; at: string; confirmed?: boolean }
>;
export interface UserProfile {
  schemaVersion: 2;
  risk: string;
  horizon: string;
  goal: string;
  interests?: GlobalInterests;
  initialized: boolean;
  updatedAt: string;
  observation?: string;
  observedAt?: string;
  evidence?: Record<string, string>;
}
const KEY = 'ai.profile.v1';
const POSITIONS_KEY = 'ai.positions.v1';
export const RISKS = ['unknown', 'conservative', 'balanced', 'aggressive'];
export const HORIZONS = ['unknown', 'short', 'medium', 'long', 'mixed'];
export const emptyProfile = (): UserProfile => ({
  schemaVersion: 2,
  risk: 'unknown',
  horizon: 'unknown',
  goal: '',
  initialized: false,
  updatedAt: ''
});
const validSymbol = (symbol: string) => /^(sh|sz|bj)\d{6}$/.test(symbol);
function validInterests(value: any): value is GlobalInterests {
  const text = (s: unknown) => typeof s === 'string' && s.length <= 100;
  const count = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const scores = (rows: any) =>
    Array.isArray(rows) && rows.length <= 20 && rows.every((r: any) => r && text(r.value) && count(r.score));
  return (
    value?.scope === 'user' &&
    text(value.updatedAt) &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    count(value.watchedCount) &&
    Array.isArray(value.stocks) &&
    value.stocks.length <= 100 &&
    value.stocks.every((s: any) => s && validSymbol(s.symbol) && text(s.name) && text(s.industry) && count(s.views)) &&
    Array.isArray(value.sectors) &&
    value.sectors.length <= 100 &&
    value.sectors.every((s: any) => s && text(s.name) && count(s.views) && count(s.watched)) &&
    scores(value.periods) &&
    scores(value.indicators)
  );
}
function boundedHoldings(value: Positions) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([code, h]) =>
          validSymbol(code) &&
          h &&
          ['unknown', 'none', 'held'].includes(h.status) &&
          typeof h.at === 'string' &&
          Number.isFinite(Date.parse(h.at)) &&
          (h.cost === null || (Number.isFinite(h.cost) && h.cost > 0)) &&
          (h.exposure === null || (Number.isFinite(h.exposure) && h.exposure >= 0 && h.exposure <= 100))
      )
      .sort((a, b) => b[1].at.localeCompare(a[1].at))
      .slice(0, 100)
      .map(([code, h]) => [
        code,
        {
          status: h.status,
          cost: h.status === 'held' ? h.cost : null,
          exposure: h.status === 'held' ? h.exposure : null,
          at: h.at,
          confirmed: h.confirmed === true
        }
      ])
  );
}
/** 画像只记录投资分析偏好；持仓逐标的保存，不读取基金持仓或券商账户。 */
export class ProfileStore {
  private value: UserProfile;
  private positions: Positions;
  private queue = Promise.resolve();
  private revision = 0;
  private retryAt = 0;
  constructor(private state: Memento) {
    const saved = state.get<any>(KEY);
    const positions = state.get<any>(POSITIONS_KEY, saved?.holdings || {});
    this.positions = positions && typeof positions === 'object' ? boundedHoldings(positions) : {};
    this.value = emptyProfile();
    if (saved && typeof saved === 'object') {
      this.value = {
        schemaVersion: 2,
        risk: RISKS.includes(saved.risk) ? saved.risk : 'unknown',
        horizon: HORIZONS.includes(saved.horizon) ? saved.horizon : 'unknown',
        goal: typeof saved.goal === 'string' && saved.goal.length <= 300 ? saved.goal : '',
        initialized: saved.initialized === true,
        updatedAt:
          typeof saved.updatedAt === 'string' && Number.isFinite(Date.parse(saved.updatedAt)) ? saved.updatedAt : '',
        ...(saved.schemaVersion === 2 && typeof saved.observation === 'string' && saved.observation.length <= 300
          ? { observation: saved.observation }
          : {}),
        ...(saved.schemaVersion === 2 &&
        typeof saved.observedAt === 'string' &&
        Number.isFinite(Date.parse(saved.observedAt))
          ? { observedAt: saved.observedAt }
          : {}),
        evidence: Object.fromEntries(
          Object.entries(saved.evidence && typeof saved.evidence === 'object' ? saved.evidence : {}).filter(
            ([k, v]) => ['risk', 'horizon', 'goal'].includes(k) && typeof v === 'string' && v.length <= 2000
          )
        ) as Record<string, string>
      };
      if (validInterests(saved.interests)) this.value.interests = saved.interests;
    }
  }
  read() {
    return JSON.parse(JSON.stringify(this.value)) as UserProfile;
  }
  private save() {
    const value = this.read();
    const positions = JSON.parse(JSON.stringify(this.positions));
    // 先保存独立持仓，再替换旧画像；迁移中断也不会丢失原成本和仓位。
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        await this.state.update(POSITIONS_KEY, positions);
        await this.state.update(KEY, value);
      });
    return this.queue;
  }
  clear() {
    this.revision++;
    this.retryAt = 0;
    this.value = emptyProfile();
    return this.save();
  }
  edit(input: any) {
    if (
      !input ||
      !RISKS.includes(input.risk) ||
      !HORIZONS.includes(input.horizon) ||
      typeof input.goal !== 'string' ||
      input.goal.length > 300
    )
      throw new Error('画像内容无效');
    const next = this.read();
    this.revision++;
    this.value = {
      ...next,
      risk: input.risk,
      horizon: input.horizon,
      goal: input.goal.trim(),
      evidence: {},
      initialized: true,
      updatedAt: new Date().toISOString()
    };
    return this.save();
  }
  forAnalysis(includeBehavior = true) {
    const profile = this.read();
    if (!includeBehavior) {
      delete profile.interests;
      delete profile.observation;
      delete profile.observedAt;
    }
    return {
      ...profile,
      scope: 'user',
      note: '所有标的共用此全局画像；关注股票、板块和浏览周期仅作偏好参考，不代表持仓或风险承受力。'
    };
  }
  positionForAnalysis(symbol: string) {
    return this.positions[symbol] ? JSON.parse(JSON.stringify(this.positions[symbol])) : null;
  }
  editHolding(h: any, symbol: string) {
    if (
      !validSymbol(symbol) ||
      !h ||
      !['unknown', 'none', 'held'].includes(h.status) ||
      (h.cost !== null && (!Number.isFinite(h.cost) || h.cost <= 0)) ||
      (h.exposure !== null && (!Number.isFinite(h.exposure) || h.exposure < 0 || h.exposure > 100))
    )
      throw new Error('请填写有效成本及0至100%的仓位');
    this.revision++;
    this.positions[symbol] = {
      status: h.status,
      cost: h.status === 'held' ? h.cost : null,
      exposure: h.status === 'held' ? h.exposure : null,
      at: new Date().toISOString(),
      confirmed: true
    };
    this.positions = boundedHoldings(this.positions);
    return this.save();
  }
  clearHolding(symbol: string) {
    this.revision++;
    delete this.positions[symbol];
    return this.save();
  }
  noteInterests(interests: GlobalInterests | null) {
    if (interests) this.value.interests = interests;
    else {
      this.revision++;
      delete this.value.interests;
      delete this.value.observation;
      delete this.value.observedAt;
    }
    return this.save();
  }
  async learn(
    question: string | undefined,
    focus: unknown,
    symbol: string,
    options: Omit<TurnOptions, 'messages'>,
    request: TurnRequest
  ) {
    if (Date.now() < this.retryAt) return;
    const explicitPreference =
      question &&
      /(?:成本|仓位|持仓|空仓|更正|改为|喜欢|偏好|只看|偏激进|偏保守|投资周期|(?:我|本人).*(?:保守|激进|稳健|长线|短线|中线|长期|偏好|目标|回撤|周期))/.test(
        question
      );
    const observationExpired =
      !question && !!focus && Date.now() - Date.parse(this.value.observedAt || '1970-01-01') >= 86400000;
    if (this.value.initialized && !explicitPreference && !observationExpired) return;
    const revision = this.revision;
    this.retryAt = Date.now() + 5 * 60000;
    // 只接受用户原话有证据的更新，模型无法凭浏览次数替用户填写风险偏好或仓位。
    const result = await request({
      ...options,
      tools: [],
      maxTokens: 900,
      timeoutMs: 15000,
      idleTimeoutMs: 12000,
      messages: [
        {
          role: 'system',
          content:
            '为行情分析更新全局用户画像（所有个股共用）。只返回JSON对象。observation概括跨标的关注的股票、板块、周期与指标偏好，不能围绕本次个股单独刻画，标记为弱参考，数据不足说不足。支持risk、horizon、goal三个可选字段，每个字段结构为{value,evidence}。risk枚举unknown/conservative/balanced/aggressive；horizon枚举unknown/short/medium/long/mixed；goal简述用户明确的目标。可选holding={symbol:股票代码,status:held或none,cost:数字或null,exposure:数字或null,evidence:原话}，symbol必须对应原话所指股票；提到其他股票或指代不清则不提取。仅提取当前标的明确每股成本和该股占总资产的百分比，不换算、推测，不把总仓位当个股仓位。evidence必须逐字引用本次用户原话，不能引用已有画像或浏览摘要。没有明确证据就不输出相应字段。浏览仅为弱参考，不推断风险承受力，不提取敏感个人特征。用户没有发言时只输出observation，风格仍未知。'
        },
        {
          role: 'user',
          content: JSON.stringify({
            currentSymbol: symbol,
            question: question || '',
            prior: this.forAnalysis(),
            browsing: focus
          })
        }
      ]
    });
    if (options.signal?.aborted || revision !== this.revision) return;
    const parsed = JSON.parse(result.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!parsed || typeof parsed !== 'object' || result.calls.length) throw new Error('画像提取无效');
    const next = this.read();
    if (typeof parsed.observation === 'string' && parsed.observation.length <= 300) {
      next.observation = parsed.observation;
      next.observedAt = new Date().toISOString();
    }
    // 空的有效结果也计作本次整理，避免没有足够样本时每次新分析都重复请求。
    if (!question && !(typeof parsed.observation === 'string' && parsed.observation.length <= 300)) {
      next.observedAt = new Date().toISOString();
      delete next.observation;
    }
    for (const field of ['risk', 'horizon', 'goal'] as const) {
      const item = parsed[field];
      if (!item || typeof item.evidence !== 'string' || item.evidence.length < 2 || !question?.includes(item.evidence))
        continue;
      if (
        (field === 'risk' && RISKS.includes(item.value)) ||
        (field === 'horizon' && HORIZONS.includes(item.value)) ||
        (field === 'goal' && typeof item.value === 'string' && item.value.length <= 300)
      ) {
        next[field] = item.value;
        next.evidence = { ...next.evidence, [field]: item.evidence };
      }
    }
    const holding = parsed.holding;
    if (
      /^(sh|sz|bj)\d{6}$/.test(symbol) &&
      holding?.symbol === symbol &&
      typeof holding.evidence === 'string' &&
      holding.evidence.length >= 2 &&
      question?.includes(holding.evidence)
    ) {
      const evidence = holding.evidence;
      const old = this.positions[symbol];
      if (holding.status === 'none' && /空仓|清仓|没有持仓|没持仓|未持仓/.test(evidence))
        this.positions[symbol] = {
          status: 'none',
          cost: null,
          exposure: null,
          at: new Date().toISOString(),
          confirmed: false
        };
      else if (holding.status === 'held' && /成本|持有|持仓|买入/.test(evidence)) {
        const numbers = [...evidence.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
        const cost =
          Number.isFinite(holding.cost) && holding.cost > 0 && /成本/.test(evidence) && numbers.includes(holding.cost)
            ? holding.cost
            : (old?.cost ?? null);
        const exposure =
          Number.isFinite(holding.exposure) &&
          holding.exposure >= 0 &&
          holding.exposure <= 100 &&
          /%|％|百分之/.test(evidence) &&
          /仓位|占/.test(evidence) &&
          numbers.includes(holding.exposure)
            ? holding.exposure
            : (old?.exposure ?? null);
        this.positions[symbol] = { status: 'held', cost, exposure, at: new Date().toISOString(), confirmed: false };
      }
    }
    this.positions = boundedHoldings(this.positions);
    this.value = { ...next, initialized: true, updatedAt: new Date().toISOString() };
    this.retryAt = 0;
    await this.save();
  }
}

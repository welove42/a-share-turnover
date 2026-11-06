# 源码结构与开发

## 从哪里开始看

`src/app/extension.ts` 是唯一扩展入口，只负责创建功能、注册命令和回收资源。业务按功能放在 `features`；浏览器页面代码放在 `webviews`。

```text
src/
  app/                    扩展装配、旧版本提示、老板键
  core/
    network/              HTTP 请求、超时、取消和字符解码
    ui/                   老板键下的输入窗口管理
  features/
    ai/                   AI 请求、行情上下文、会话和本地历史
    turnover/             沪深成交额、同刻比较、风险和提醒
    watchlist/            自选、搜索、分组、拖拽、配色和涨跌提醒
      overseas/           港美股及美股盘前盘后
    charts/               图表数据源、标签页控制和 HTML 模板
    global-indices/       全球指数
    funds/                基金净值、估算及持仓收益
    commodities/          商品行情
    sectors/              板块涨跌榜
    news/                 财经快讯
    reminders/            大事提醒、在线和内置日历
    temperature/          市场温度计算、当日记录和图表
    settings/             设置模型、校验、保存和页面模板
  shared/                 行情类型、技术指标、温度图计算
  webviews/
    ai-analysis/          右侧 AI 对话、历史和输入交互
    chart/                内置图表绘制和鼠标悬停
    settings/             设置页面交互
    temperature-chart/    温度走势图
    shared/               DOM 元素查找和浏览器公共工具
media/                    样式、图标和展示图片
scripts/                  构建与真实接口检查（TypeScript .cts）
test/                     离线回归测试和 VS Code 模拟环境（.cts）
dist/                     自动生成的 JavaScript，不提交 Git
```

每个功能里，`controller.ts` 管生命周期和交互，`data.ts` 或 `provider.ts` 管数据源，`view.ts` 生成页面或展示模型。简单模块不为分层而额外拆空文件。

## 两个运行环境

扩展主进程可访问 VS Code API、网络和安全存储。`tsc` 将其编译到 `dist/app`、`dist/features` 等目录。

Webview 只能使用浏览器 API，通过消息与主进程通信。esbuild 把四个页面及各自依赖打包到 `dist/webviews`，不在页面里加载 Node.js 模块。HTML 模板留在对应功能的 `view.ts`，CSS 留在 `media`。修改页面需要重新构建。

`shared` 不引用 VS Code 或 DOM，两端共用计算规则。金额统一以元计算、展示时转换为亿元；图表成交量统一为手；缺失数值使用 `null`，避免把无数据当作 0。

## 主要数据流

- 行情：数据源解析和验证 → 功能控制器更新缓存 → 状态栏、侧栏或图表。请求取消或代次变化后忽略旧结果。
- AI：选择对象 → 收集公开行情上下文 → 流式请求 → 右侧展示 → 本机保存。历史恢复不调用 API，主动追问才发送保存的上下文。
- 设置：页面发送消息 → 主进程验证 → 写入配置并通知功能。API Key 单独使用 SecretStorage，不写入设置或对话记录。

## 开发命令

需要 Node.js 24。构建工具版本记录在 `package-lock.json`。

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 安装锁定依赖 |
| `npm run typecheck` | 检查主进程与浏览器 TypeScript，不输出产物 |
| `npm run build` | 编译主进程并打包四个页面 |
| `npm test` | 先构建，再运行全部离线测试 |
| `npm run format` | 统一源码、脚本和测试格式 |
| `npm run package` | 先构建，再生成当前版本 VSIX |
| `npm run smoke:*` | 检查指定真实行情源，需要联网 |

F5 配置会先构建，再启动开发宿主。测试加载编译后的主进程和页面产物，以便发现导入路径、打包和消息处理问题。

## 修改时的约定

1. 新功能放入对应功能目录，入口只增加装配和命令。
2. 公共行情结构放 `shared/types.ts`，AI 会话和请求类型放 `features/ai/types.ts`。外部接口及动态设置在边界验证，字段缺失不可直接参与计算。
3. 注释解释单位、时区、缓存有效期、取消和并发约束，避免逐句翻译代码。不要把前端事件写进 HTML 模板。
4. 配置键、命令 ID、SecretStorage 和 Memento 键保持兼容；修改存储格式时明确迁移策略。
5. 更新 `CHANGELOG.md` 并通过测试。源码以 Git 管理，不再另存源码 ZIP。
6. **仅用户明确要求时打 Tag**。日常提交与本地打包不发布市场；已有标签不移动、不重打。

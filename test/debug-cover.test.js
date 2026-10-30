'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { harness } = require('./vscode-mock');

test('隐藏页面使用主题色和真正的按钮，不包含行情文字', () => {
  const h=harness(), {debugCoverHtml}=h.load('../src/debug-cover'), html=debugCoverHtml();
  assert.match(html, /<button type="button" data-action="start">运行和调试<\/button>/);
  assert.match(html, /<button type="button" class="secondary" data-action="configure">创建调试配置<\/button>/);
  assert.match(html, /--vscode-button-background/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /A股|股票|行情|新闻|自选/);
});

test('调试按钮只在隐藏期间触发对应的 VS Code 命令，拒绝其他消息', () => {
  const h=harness(), calls=[], event=new h.api.EventEmitter(); let hidden=true;
  h.api.commands={executeCommand:command=>{calls.push(command);return Promise.resolve();}};
  const {DebugCoverProvider}=h.load('../src/debug-cover');
  const view={webview:{onDidReceiveMessage:event.event}};
  new DebugCoverProvider(()=>hidden).resolveWebviewView(view);
  assert.equal(view.webview.options.enableScripts,true);
  event.fire({action:'start'}); event.fire({action:'configure'}); event.fire({action:'other'});
  hidden=false; event.fire({action:'start'});
  assert.deepEqual(calls,['workbench.action.debug.start','workbench.action.debug.configure']);
});

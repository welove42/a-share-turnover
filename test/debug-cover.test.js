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

test('隐藏页面禁用脚本且不注册消息处理，按钮不会触发 VS Code 命令', () => {
  const h=harness(), calls=[];
  h.api.commands={executeCommand:command=>{calls.push(command);return Promise.resolve();}};
  const {DebugCoverProvider}=h.load('../src/debug-cover');
  const view={webview:{onDidReceiveMessage:()=>{throw new Error('不得注册按钮处理');}}};
  new DebugCoverProvider().resolveWebviewView(view);
  assert.equal(view.webview.options.enableScripts,false);
  assert.doesNotMatch(view.webview.html,/<script|command:|postMessage|onclick=/i);
  assert.deepEqual(calls,[]);
});

'use strict';
const Module = require('node:module');
function harness(configuration = {}) {
  class EventEmitter {
    constructor() { this.listeners = new Set(); this.fired = []; this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
    fire(value) { this.fired.push(value); for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  }
  class MarkdownString {
    constructor(value = '') { this.value = value; }
    appendText(value) { this.value += value; return this; }
  }
  const changes = new EventEmitter(), values = new Map(Object.entries(configuration));
  const trees = new Map(), webviewViews = new Map(), statuses = [], channels = [], opened = [], documents = new Map(), panels = [], pickers = [];
  const api = {
    EventEmitter, MarkdownString, CancellationTokenSource: class { constructor() { const e = new EventEmitter(); this.token = { isCancellationRequested: false, onCancellationRequested: e.event }; this.events = e; } cancel() { this.token.isCancellationRequested = true; this.events.fire(); } dispose() { this.events.dispose(); } }, DataTransferItem: class { constructor(value) { this.value = value; } }, StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1 },
    ThemeColor: class { constructor(id) { this.id = id; } }, ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: { from: value => value, parse: value => ({ toString: () => value }), joinPath: (uri, ...parts) => [uri?.toString() || 'file:///extension', ...parts].join('/') },
    ViewColumn: { Active: -1 }, env: { openExternal: async uri => { opened.push(uri.toString()); return true; } },
    window: {
      registerWebviewViewProvider: (id, provider) => { webviewViews.set(id, provider); return { dispose() { webviewViews.delete(id); } }; },
      createWebviewPanel: (type, title, column, options) => {
        const dispose = new EventEmitter(), change = new EventEmitter(), receive = new EventEmitter();
        const panel = { type, title, column, options, visible: true, disposed: false, revealCalls: 0,
          onDidDispose: dispose.event, onDidChangeViewState: change.event,
          reveal() { this.visible = true; this.revealCalls++; change.fire({ webviewPanel: this }); },
          setVisible(value) { this.visible = value; change.fire({ webviewPanel: this }); },
          dispose() { if (!this.disposed) { this.disposed = true; dispose.fire(); } },
          webview: { cspSource: 'vscode-webview:', asWebviewUri: uri => uri, messages: [], receive,
            onDidReceiveMessage: receive.event, postMessage(message) { this.messages.push(message); return Promise.resolve(true); } }
        }; panels.push(panel); return panel;
      },
      createQuickPick: () => {
        const change = new EventEmitter(), accept = new EventEmitter(), hide = new EventEmitter();
        const picker = { value: '', items: [], selectedItems: [], onDidChangeValue: change.event, onDidAccept: accept.event, onDidHide: hide.event,
          change(value) { this.value = value; change.fire(value); }, accept() { accept.fire(); }, show() { this.visible = true; }, hide() { this.visible = false; hide.fire(); }, dispose() { this.disposed = true; } };
        pickers.push(picker); return picker;
      },
      createTreeView: (id, options) => {
        const emitter = new EventEmitter();
        const tree = { ...options, visible: false, onDidChangeVisibility: emitter.event, visibility: emitter, dispose() {} };
        trees.set(id, tree); return tree;
      },
      createStatusBarItem: () => {
        const item = { writes: {}, showCalls: 0, show() { this.visible = true; this.showCalls++; }, hide() { this.visible = false; }, dispose() {} };
        const props = {};
        for (const key of ['text', 'tooltip']) Object.defineProperty(item, key, { get: () => props[key], set: value => { props[key] = value; item.writes[key] = (item.writes[key] || 0) + 1; } });
        statuses.push(item); return item;
      },
      createOutputChannel: name => { const channel = { name, lines: [], shown: 0, hidden: 0, appendLine(t) { this.lines.push(t); }, clear() { this.lines = []; }, show() { this.shown++; }, hide() { this.hidden++; }, dispose() {} }; channels.push(channel); return channel; },
      showInputBox: async () => undefined, showQuickPick: async () => undefined,
      showErrorMessage: async text => { opened.push({ error: text }); },
      showTextDocument: async uri => { opened.push(uri); return uri; }
    },
    workspace: {
      onDidChangeConfiguration: changes.event,
      getConfiguration: (section = '') => ({ get: (key, fallback) => values.has(section + '.' + key) ? values.get(section + '.' + key) : fallback,
        update: async (key, value) => {
          const name = section + '.' + key; values.set(name, value);
          changes.fire({ affectsConfiguration: prefix => name === prefix || name.startsWith(prefix + '.') || prefix.startsWith(name + '.') });
        } }),
      registerTextDocumentContentProvider: (scheme, provider) => { documents.set(scheme, provider); return { dispose() {} }; }
    }
  };
  function load(file) {
    const sourceRoot = require('node:path').resolve(__dirname, '../src') + require('node:path').sep;
    for (const cached of Object.keys(require.cache)) if (cached.startsWith(sourceRoot)) delete require.cache[cached];
    const original = Module._load;
    Module._load = function(name, ...args) { return name === 'vscode' ? api : original.call(this, name, ...args); };
    try { return require(file); } finally { Module._load = original; }
  }
  const store = new Map(), secrets = new Map();
  const context = { extensionUri: 'file:///extension', globalState: { get: (key, fallback) => store.has(key) ? store.get(key) : fallback, update: async (key, value) => { store.set(key, value); } },
    secrets: { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); } } };
  return { api, context, load, values, trees, webviewViews, statuses, channels, opened, documents, store, secrets, panels, pickers };
}
module.exports = { harness };

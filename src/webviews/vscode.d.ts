/** Webview 只能通过此桥接协议访问扩展，不接触 Node.js、文件系统或 API Key。 */
interface WebviewApi<State = Record<string, unknown>> {
  getState(): State | undefined;
  setState(state: State): State;
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi<State = Record<string, any>>(): WebviewApi<State>;

import * as vscode from 'vscode';

export const NEWS_OUTPUT_LANGUAGE = 'a-share-news-output';
// A private language without a grammar keeps ordinary output uncolored, including timestamps and labels.
export const NEWS_PLAIN_LANGUAGE = 'a-share-news-plain';

/** Change the existing output document's language, preserving its text, selection and channel. */
export class NewsOutputStyle implements vscode.Disposable {
  pending: Promise<void> = Promise.resolve();
  private disposed = false;
  private listener: vscode.Disposable;

  constructor(
    private highlighted: boolean,
    private log: (message: string) => void
  ) {
    // Output documents are created lazily. Reapply after opening or recreating the model.
    this.listener = vscode.workspace.onDidOpenTextDocument((document) => {
      if (this.owns(document)) void this.apply();
    });
    void this.apply();
  }
  get languageId(): string {
    return this.highlighted ? NEWS_OUTPUT_LANGUAGE : NEWS_PLAIN_LANGUAGE;
  }
  private owns(document: vscode.TextDocument): boolean {
    return (
      document.uri.scheme === 'output' && [NEWS_OUTPUT_LANGUAGE, NEWS_PLAIN_LANGUAGE].includes(document.languageId)
    );
  }
  setHighlighted(value: boolean): Promise<void> {
    this.highlighted = value;
    return this.apply();
  }
  private apply(): Promise<void> {
    // Serialize rapid toggles; read the latest setting at execution time so an older async change cannot win.
    this.pending = this.pending
      .then(async () => {
        if (this.disposed) return;
        for (const document of vscode.workspace.textDocuments) {
          if (this.disposed) return;
          if (document.isClosed || !this.owns(document) || document.languageId === this.languageId) continue;
          await vscode.languages.setTextDocumentLanguage(document, this.languageId);
        }
      })
      .catch(() => {
        if (!this.disposed) this.log('新闻显示样式更新失败，下次打开输出面板时重试。');
      });
    return this.pending;
  }
  dispose(): void {
    this.disposed = true;
    this.listener.dispose();
  }
}

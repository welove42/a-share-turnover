import type { AnalysisTargetOption } from '../../shared/types';

interface PickerElements {
  root: HTMLElement;
  button: HTMLButtonElement;
  menu: HTMLElement;
  search: HTMLInputElement;
  list: HTMLElement;
  empty: HTMLElement;
}

/** 面板内选择器：搜索、焦点和展开状态完全在本地管理，进度刷新不打断输入。 */
export class TargetPicker {
  private options: AnalysisTargetOption[] = [];
  private filtered: AnalysisTargetOption[] = [];
  private selected = '';
  private signature = '';
  private active = -1;
  private open = false;
  private request: number | undefined;

  constructor(
    private ui: PickerElements,
    private select: (symbol: string) => void,
    private refresh: () => void
  ) {
    ui.button.addEventListener('click', () => {
      if (this.open) this.close();
      else {
        this.show();
        this.refresh();
      }
    });
    ui.button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!this.open) {
          this.show();
          this.refresh();
        } else ui.search.focus();
      } else if (event.key === 'Escape') this.close(true);
    });
    ui.search.addEventListener('input', () => this.render(false));
    ui.search.addEventListener('keydown', (event) => {
      // Enter confirms Chinese IME composition, not the highlighted stock.
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close(true);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!this.filtered.length) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.active = (this.active + step + this.filtered.length) % this.filtered.length;
        this.paintActive();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        this.commit(this.filtered[this.active]?.symbol);
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (this.open && !ui.root.contains(event.target as Node)) this.close();
    });
    ui.root.addEventListener('focusout', (event) => {
      if (event.relatedTarget && !ui.root.contains(event.relatedTarget as Node)) this.close();
    });
    this.close();
  }

  update(options: AnalysisTargetOption[], selected: string | undefined, request = 0, covered = false): void {
    if (this.request !== undefined && this.selected !== (selected || '')) this.close();
    const signature = JSON.stringify([options, selected]);
    if (signature !== this.signature) {
      this.options = options;
      this.selected = selected || '';
      this.signature = signature;
      if (this.open) this.render(true);
    }
    // Restoring a Webview must not replay an old open request after a target was chosen.
    const requested = this.request === undefined ? request > 0 && !selected : request !== this.request;
    this.request = request;
    if (covered) this.close();
    else if (requested && !this.open) this.show();
  }

  private show(): void {
    this.open = true;
    this.ui.menu.hidden = false;
    this.ui.button.setAttribute('aria-expanded', 'true');
    this.ui.search.setAttribute('aria-expanded', 'true');
    this.ui.search.value = '';
    this.render(false);
    this.ui.search.focus();
  }

  private close(focus = false): void {
    this.open = false;
    this.ui.menu.hidden = true;
    this.ui.button.setAttribute('aria-expanded', 'false');
    this.ui.search.setAttribute('aria-expanded', 'false');
    this.ui.search.removeAttribute('aria-activedescendant');
    if (focus) this.ui.button.focus();
  }

  private commit(symbol: string | undefined): void {
    if (!symbol || !this.open || !this.filtered.some((item) => item.symbol === symbol)) return;
    this.close(true);
    this.select(symbol);
  }

  private render(preserve: boolean): void {
    const oldActive = preserve ? this.filtered[this.active]?.symbol : undefined;
    const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    const query = normalize(this.ui.search.value);
    this.filtered = this.options.filter((item) => normalize(item.label + item.symbol).includes(query));
    this.active = this.filtered.findIndex((item) => item.symbol === (oldActive || this.selected));
    if (this.active < 0) this.active = this.filtered.length ? 0 : -1;
    this.ui.list.replaceChildren();
    this.filtered.forEach((item, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.id = `analysis-target-${index}`;
      row.tabIndex = -1;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(item.symbol === this.selected));
      const name = document.createElement('span');
      name.className = 'target-option-name';
      name.textContent = item.label;
      const code = document.createElement('span');
      code.className = 'target-option-code';
      code.textContent = item.symbol === 'market' ? '大盘' : item.symbol;
      const check = document.createElement('span');
      check.className = 'target-option-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = item.symbol === this.selected ? '✓' : '';
      row.title = `${item.label} · ${item.symbol === 'market' ? '沪深大盘' : item.symbol}`;
      row.append(name, code, check);
      row.addEventListener('click', () => this.commit(item.symbol));
      this.ui.list.append(row);
    });
    this.ui.empty.hidden = this.filtered.length > 0;
    this.paintActive();
  }

  private paintActive(): void {
    Array.from(this.ui.list.children).forEach((row, index) => {
      row.className = `target-option${index === this.active ? ' active' : ''}`;
      if (index === this.active) {
        this.ui.search.setAttribute('aria-activedescendant', row.id);
        row.scrollIntoView({ block: 'nearest' });
      }
    });
    if (this.active < 0) this.ui.search.removeAttribute('aria-activedescendant');
  }
}

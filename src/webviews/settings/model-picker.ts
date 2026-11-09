/** 可编辑模型下拉：模型 ID 始终可手动输入，远程列表只作为候选，不自动覆盖当前值。 */
export class ModelPicker {
  readonly element = document.createElement('div');
  readonly toggle = document.createElement('button');
  private menu = document.createElement('div');
  private options: string[] = [];
  private filtered: string[] = [];
  private active = -1;
  private filtering = false;
  private opened = false;

  constructor(
    readonly input: HTMLInputElement,
    private changed: () => void
  ) {
    this.element.className = 'model-picker';
    const line = document.createElement('div');
    line.className = 'compound-input model-input';
    this.toggle.type = 'button';
    this.toggle.className = 'compound-action model-toggle';
    this.toggle.setAttribute('aria-label', '展开模型列表');
    this.toggle.setAttribute('aria-controls', 'ai-model-options');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'ai-model-options');
    input.placeholder = '选择模型，或输入自定义 ID';
    input.maxLength = 160;
    this.menu.id = 'ai-model-options';
    this.menu.className = 'model-menu';
    this.menu.setAttribute('role', 'listbox');
    this.menu.setAttribute('aria-label', '服务商模型列表');
    line.append(input, this.toggle);
    this.element.append(line, this.menu);
    this.close();
    this.toggle.addEventListener('click', () => (this.opened ? this.close() : this.show(false)));
    input.addEventListener('input', () => {
      this.filtering = true;
      if (this.options.length) this.show(true);
    });
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!this.opened) this.show(false);
        else if (this.filtered.length) {
          this.active =
            (this.active + (event.key === 'ArrowDown' ? 1 : -1) + this.filtered.length) % this.filtered.length;
          this.paint();
        }
      } else if (event.key === 'Enter' && this.opened) {
        event.preventDefault();
        if (this.filtered[this.active]) this.pick(this.filtered[this.active]);
        else this.close();
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (!this.element.contains(event.target as Node)) this.close();
    });
    this.element.addEventListener('focusout', (event) => {
      if (event.relatedTarget && !this.element.contains(event.relatedTarget as Node)) this.close();
    });
  }
  setOptions(options: string[], open = false): void {
    this.options = options;
    if (open) this.show(false);
    else this.close();
  }
  close(): void {
    this.opened = false;
    this.menu.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    this.toggle.setAttribute('aria-expanded', 'false');
  }
  private show(filter: boolean): void {
    if (this.input.disabled) return;
    this.opened = true;
    this.filtering = filter;
    this.menu.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.toggle.setAttribute('aria-expanded', 'true');
    this.render();
    this.input.focus();
  }
  private pick(value: string): void {
    if (this.input.disabled) return;
    this.input.value = value;
    this.close();
    this.input.focus();
    this.changed();
  }
  private render(): void {
    const query = this.filtering ? this.input.value.trim().toLowerCase() : '';
    this.filtered = this.options.filter((id) => id.toLowerCase().includes(query));
    this.active = this.filtered.indexOf(this.input.value);
    if (this.active < 0) this.active = this.filtered.length ? 0 : -1;
    this.menu.replaceChildren();
    if (!this.filtered.length) {
      const note = document.createElement('p');
      note.className = 'model-empty';
      note.textContent = this.options.length
        ? '没有匹配项，可直接输入模型 ID。'
        : '先点击“获取列表”，也可直接输入模型 ID。';
      this.menu.append(note);
    } else
      this.filtered.forEach((id, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.tabIndex = -1;
        row.id = `model-option-${index}`;
        row.textContent = id;
        row.title = id;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(id === this.input.value));
        row.addEventListener('click', () => this.pick(id));
        this.menu.append(row);
      });
    this.paint();
  }
  private paint(): void {
    for (const [index, child] of Array.from(this.menu.children).entries()) {
      if (child.getAttribute('role') !== 'option') continue;
      child.className = `model-option${index === this.active ? ' active' : ''}`;
      if (index === this.active) {
        this.input.setAttribute('aria-activedescendant', child.id);
        child.scrollIntoView({ block: 'nearest' });
      }
    }
    if (this.active < 0) this.input.removeAttribute('aria-activedescendant');
  }
}

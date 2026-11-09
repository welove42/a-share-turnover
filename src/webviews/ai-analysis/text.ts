/** 仅渲染安全的文本、标题、加粗和列表；不执行模型输出的 HTML 或 command 链接。 */
function inline(element: HTMLElement, text: string): void {
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    const bold = part.startsWith('**') && part.endsWith('**') && part.length > 4;
    const span = document.createElement(bold ? 'strong' : 'span');
    span.textContent = bold ? part.slice(2, -2) : part;
    element.append(span);
  }
}

export function renderAnalysisText(element: Element, text: string, assistant: boolean): void {
  element.replaceChildren();
  let section: HTMLElement | Element = element;
  let list: HTMLUListElement | HTMLOListElement | undefined;
  let listType = '';
  for (const line of text.split(/\r?\n/)) {
    // Also accept a fully bold heading, a common variation from compatible models.
    const heading =
      line.match(/^\s{0,3}#{1,4}\s+(.+?)\s*#*\s*$/)?.[1] ??
      line.match(/^\s*\*\*(一句话结论|为什么这么看|接下来盯什么|最需要小心)[：:]?\*\*\s*$/)?.[1];
    if (heading) {
      section = document.createElement('section');
      const summary = assistant && /^(?:一句话结论|一句话判断|先说结论|结论)[：:]?$/.test(heading.replace(/\*\*/g, ''));
      section.className = summary ? 'analysis-section analysis-summary' : 'analysis-section';
      const title = document.createElement('div');
      title.className = 'heading';
      inline(title, heading);
      section.append(title);
      element.append(section);
      list = undefined;
      continue;
    }
    if (!line.trim()) {
      list = undefined;
      continue;
    }
    const bullet = line.match(/^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (bullet) {
      const kind = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (!list || listType !== kind) {
        list = document.createElement(kind);
        list.className = 'analysis-list';
        listType = kind;
        section.append(list);
      }
      const item = document.createElement('li');
      if (kind === 'ol') item.value = Number(line.match(/^\s*(\d+)/)![1]);
      inline(item, bullet[1]);
      list.append(item);
    } else {
      list = undefined;
      const paragraph = document.createElement('p');
      paragraph.className = 'analysis-paragraph';
      inline(paragraph, line);
      section.append(paragraph);
    }
  }
}

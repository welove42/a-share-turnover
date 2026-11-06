/** 模板中的静态节点必须存在；类型由每个页面的元素表限定。 */
export function elements<Schema extends { [K in keyof Schema]: Element }>() {
  function get<K extends keyof Schema>(id: K): Schema[K];
  function get(id: string): HTMLElement;
  function get(id: PropertyKey): Element {
    const element = document.getElementById(String(id));
    if (!element) throw new Error('页面缺少元素：' + String(id));
    return element;
  }
  return get;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

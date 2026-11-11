/** 跨服务商使用保守估算；不能当作精确账单。 */
export const estimateTokens = (value: unknown) =>
  Math.ceil(Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8') / 2) + 16;

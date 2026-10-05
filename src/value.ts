// 电表读数数值:以千分之一 kWh(毫千瓦时)的 BigInt 整数表示,
// 解析、比较、求差、汇总、显示全程精确整数运算,不产生浮点尾差,
// 也不因超过 Number 安全整数范围而拒绝合法输入。

const VALUE_RE = /^(\d+)(?:\.(\d{1,3}))?$/;

/** 解析 kWh 读数(非负、最多三位小数)为毫千瓦时 BigInt;失败返回 null。 */
export function parseKwh(input: string): bigint | null {
  const m = VALUE_RE.exec(input);
  if (!m) return null;
  const intPart = m[1].replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').padEnd(3, '0');
  return BigInt(intPart) * 1000n + BigInt(frac);
}

/** 将毫千瓦时整数格式化为固定三位小数的 kWh 字符串(不使用科学计数法)。 */
export function formatKwh(milli: bigint): string {
  const sign = milli < 0n ? '-' : '';
  const abs = milli < 0n ? -milli : milli;
  const int = abs / 1000n;
  const frac = (abs % 1000n).toString().padStart(3, '0');
  return `${sign}${int}.${frac}`;
}

/**
 * 解析存储中的毫千瓦时值:兼容旧的数值型安全整数与新的十进制字符串。
 * 数值型超出安全整数范围时原值已不可知,返回 null(按损坏数据处理)。
 */
export function parseStoredMilli(value: unknown): bigint | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

/** 序列化毫千瓦时值:安全整数范围内写为数值(兼容旧格式),否则写为十进制字符串。 */
export function milliToJson(milli: bigint): number | string {
  return milli <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(milli) : milli.toString();
}

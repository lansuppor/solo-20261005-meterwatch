// 电表读数数值:以千分之一 kWh(毫千瓦时)的整数表示,
// 解析、比较、求差、显示全程整数运算,不产生浮点尾差。

const VALUE_RE = /^(\d+)(?:\.(\d{1,3}))?$/;

/** 解析 kWh 读数(非负、最多三位小数)为毫千瓦时整数;失败返回 null。 */
export function parseKwh(input: string): number | null {
  const m = VALUE_RE.exec(input);
  if (!m) return null;
  const intPart = m[1].replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').padEnd(3, '0');
  const milli = Number(intPart) * 1000 + (frac === '' ? 0 : Number(frac));
  if (!Number.isSafeInteger(milli)) return null;
  return milli;
}

/** 将毫千瓦时整数格式化为固定三位小数的 kWh 字符串。 */
export function formatKwh(milli: number): string {
  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(milli);
  const int = Math.floor(abs / 1000);
  const frac = String(abs % 1000).padStart(3, '0');
  return `${sign}${int}.${frac}`;
}

/**
 * 将毫千瓦时整数(BigInt)格式化为固定三位小数的 kWh 字符串。
 * 用于中间乘积与多区间汇总可能超出 Number 安全整数范围的场合。
 */
export function formatKwhBig(milli: bigint): string {
  const sign = milli < 0n ? '-' : '';
  const abs = milli < 0n ? -milli : milli;
  return `${sign}${abs / 1000n}.${String(abs % 1000n).padStart(3, '0')}`;
}

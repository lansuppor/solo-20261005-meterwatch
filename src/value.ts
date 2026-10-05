// 电表读数数值:以千分之一 kWh(毫千瓦时)的 BigInt 表示,
// 解析、比较、求差、显示全程整数运算,不产生浮点尾差,
// 也不受 Number 安全整数范围限制,任意大的十进制输入都精确。

const VALUE_RE = /^(\d+)(?:\.(\d{1,3}))?$/;

/** 解析 kWh 读数(非负、最多三位小数)为毫千瓦时 BigInt;失败返回 null。 */
export function parseKwh(input: string): bigint | null {
  const m = VALUE_RE.exec(input);
  if (!m) return null;
  const intPart = m[1].replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').padEnd(3, '0');
  return BigInt(intPart) * 1000n + BigInt(frac);
}

/** 将毫千瓦时 BigInt 格式化为固定三位小数的 kWh 字符串(不用科学计数法)。 */
export function formatKwh(milli: bigint): string {
  const sign = milli < 0n ? '-' : '';
  const abs = milli < 0n ? -milli : milli;
  const int = abs / 1000n;
  const frac = (abs % 1000n).toString().padStart(3, '0');
  return `${sign}${int}.${frac}`;
}

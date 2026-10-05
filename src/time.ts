// ISO8601 时间解析与格式化。
// 仅接受秒精度、显式时区(Z 或数字偏移)的形式,如:
//   2026-01-01T00:00:00Z
//   2026-01-01T08:00:00+08:00
// 解析结果为 epoch 秒;不同偏移表示同一时刻时结果相同。

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** 解析成功返回 epoch 秒,失败返回 null。无效日期(如 2 月 30 日)返回 null,绝不顺延。 */
export function parseIso8601(input: string): number | null {
  const m = ISO_RE.exec(input);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const offset = m[7];

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetSeconds = 0;
  if (offset !== 'Z') {
    const sign = offset.startsWith('+') ? 1 : -1;
    const body = offset.slice(1).replace(':', '');
    const oh = Number(body.slice(0, 2));
    const om = body.length === 4 ? Number(body.slice(2)) : 0;
    if (oh > 23 || om > 59) return null;
    offsetSeconds = sign * (oh * 3600 + om * 60);
  }

  // 用 setUTCFullYear 构造以支持 0-99 年,并回读各分量校验是否为真实日期。
  const dt = new Date(0);
  dt.setUTCFullYear(year, month - 1, day);
  dt.setUTCHours(hour, minute, second, 0);
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return dt.getTime() / 1000 - offsetSeconds;
}

/** 解析 YYYY-MM-DD 的 UTC 日期为该日零点的 epoch 秒;无效日期(如 2 月 30 日)返回 null。 */
export function parseUtcDate(input: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  return parseIso8601(`${input}T00:00:00Z`);
}

/**
 * 校验 YYYY-MM-DD 为真实日历日期(仅按字面年月日,不绑定任何时区)。
 * 用于按规则时区解释的当地日期:标签本身不换算成固定 UTC 时刻。
 */
export function isValidDateLabel(input: string): boolean {
  return parseUtcDate(input) !== null;
}

/** 格式化为 UTC 的秒精度 ISO8601(带 Z)。 */
export function formatIsoUtc(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

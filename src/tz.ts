// 命名时区(IANA)的当地日期与日界线计算。
// 只使用运行环境内置的 Intl(ICU)时区数据,无外部依赖。
// 日界线按实际时刻的当地日期归属确定:不按固定 86400 秒或全年固定偏移
// 推算,因此夏令时前拨的当地日更短(跳过的小时不算未知)、回拨的当地日
// 更长(重复小时按各自实际时刻完整计入);被时区切换整体跳过、没有实际
// 时段的当地日期不产生任何分段,不生成虚构日报。

const formatters = new Map<string, Intl.DateTimeFormat>();

/** 校验名称是否为运行环境支持的 IANA 时区。 */
export function isValidTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** 返回时区的规范名称(如 UTC、America/New_York);调用前须通过 isValidTimeZone 校验。 */
export function canonicalTimeZone(name: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** 实际时刻 t(epoch 秒)在指定时区的当地日期,YYYY-MM-DD。 */
export function localDateOf(tz: string, t: number): string {
  const parts = formatter(tz).formatToParts(new Date(t * 1000));
  let year = '';
  let month = '';
  let day = '';
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
  }
  return `${year.padStart(4, '0')}-${month}-${day}`;
}

/**
 * 当地日期在 t 之后首次变化的实际时刻(epoch 秒),即 t 所在当地日的日界线。
 * 当地日期随实际时刻单调不减,故可二分查找首个日期不同的秒;
 * 该时刻可能不是当地午夜(时区切换发生在午夜附近时),但一定是日期归属
 * 变化的实际边界。
 */
export function nextDayBoundary(tz: string, t: number): number {
  const date = localDateOf(tz, t);
  let lo = t;
  let hi = t + 1;
  while (localDateOf(tz, hi) === date) {
    hi = lo + (hi - lo) * 2;
  }
  while (lo + 1 < hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (localDateOf(tz, mid) === date) lo = mid;
    else hi = mid;
  }
  return hi;
}

export interface LocalDaySegment {
  /** 该段归属的当地日期,YYYY-MM-DD。 */
  date: string;
  /** 段起点(含),epoch 秒。 */
  start: number;
  /** 段终点(不含),epoch 秒。 */
  end: number;
}

/**
 * 把 [from, to) 按当地日界线切成段:每段完整落在同一当地日期内,按实际
 * 时刻升序,首尾只含与查询范围重叠的部分。被时区切换整体跳过的当地日期
 * 不产生段。UTC 下等价于按 86400 秒切分。
 */
export function localDaySegments(tz: string, from: number, to: number): LocalDaySegment[] {
  const segments: LocalDaySegment[] = [];
  let cursor = from;
  while (cursor < to) {
    const date = localDateOf(tz, cursor);
    const end = Math.min(nextDayBoundary(tz, cursor), to);
    segments.push({ date, start: cursor, end });
    cursor = end;
  }
  return segments;
}

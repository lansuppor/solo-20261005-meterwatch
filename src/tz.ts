// 命名时区分日:用运行环境自带的 Intl(ECMA-402)解析 IANA 时区,
// 按当地墙钟把查询范围切成自然日。不按固定 86400 秒或全年固定偏移
// 推算日界线:夏令时前拨跳过的当天更短(跳过的小时不存在,不补为未知),
// 回拨当天更长(重复小时按各自实际时刻完整计入);同一当地日期在不连续
// 时段出现时合并统计、时段分别保留;整日被跳过的当地日期没有实际时段,
// 不生成虚构日报。

export interface LocalDayPeriod {
  /** 时段起点(含),epoch 秒。 */
  start: number;
  /** 时段终点(不含),epoch 秒。 */
  end: number;
}

export interface LocalDay {
  /** 当地日期标签,YYYY-MM-DD。 */
  label: string;
  /** 该当地日期在查询范围内的实际 UTC 时段,按时间升序、互不重叠。 */
  periods: LocalDayPeriod[];
}

interface WallClock {
  /** 日期比较键,y*10000+m*100+d。 */
  key: number;
  /** 日期标签,YYYY-MM-DD。 */
  label: string;
  /** 墙钟分量按 UTC 解释的 epoch 秒(用于偏移与午夜推算)。 */
  naive: number;
  /** 下一个当地午夜的墙钟,按 UTC 解释的 epoch 秒。 */
  nextMidnight: number;
}

/** 校验 IANA 时区名并构造墙钟格式化器;运行环境不支持时返回 null。 */
export function loadTimezone(name: string): Intl.DateTimeFormat | null {
  if (name === '') return null;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: name,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    fmt.format(0);
    return fmt;
  } catch {
    return null;
  }
}

/**
 * 校验 IANA 时区名并返回运行环境解析后的规范名称(取 resolvedOptions 的
 * timeZone):别名(如 Etc/UTC、Zulu)归并为同一规范名(UTC),故省略与
 * 显式 UTC 等价;运行环境不支持时返回 null。
 */
export function canonicalTimezone(name: string): string | null {
  const fmt = loadTimezone(name);
  return fmt === null ? null : fmt.resolvedOptions().timeZone;
}

/** 年月日时分秒按 UTC 解释的 epoch 秒(setUTCFullYear 以支持 0-99 年)。 */
function naiveEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, s, 0);
  return dt.getTime() / 1000;
}

/** 时刻 t 在时区 fmt 下的墙钟。 */
function wallClock(fmt: Intl.DateTimeFormat, t: number): WallClock {
  let y = 0;
  let mo = 0;
  let d = 0;
  let h = 0;
  let mi = 0;
  let s = 0;
  for (const p of fmt.formatToParts(t * 1000)) {
    switch (p.type) {
      case 'year':
        y = Number(p.value);
        break;
      case 'month':
        mo = Number(p.value);
        break;
      case 'day':
        d = Number(p.value);
        break;
      case 'hour':
        h = Number(p.value);
        break;
      case 'minute':
        mi = Number(p.value);
        break;
      case 'second':
        s = Number(p.value);
        break;
    }
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    key: y * 10000 + mo * 100 + d,
    label: `${String(y).padStart(4, '0')}-${pad(mo)}-${pad(d)}`,
    naive: naiveEpoch(y, mo, d, h, mi, s),
    nextMidnight: naiveEpoch(y, mo, d, 0, 0, 0) + 86400,
  };
}

/** 时区在时刻 t 的偏移(墙钟 - UTC),秒。 */
function offsetAt(fmt: Intl.DateTimeFormat, t: number): number {
  return wallClock(fmt, t).naive - t;
}

/**
 * 在 (t, limit] 内找第一个偏移与 o0 不同的时刻;没有返回 Infinity。
 * 先按小时步进定位再秒级二分;IANA 时区的相邻偏移切换间隔远大于一小时,
 * 一小时内两次切换且净偏移不变的情形不存在。
 */
function nextTransition(fmt: Intl.DateTimeFormat, t: number, o0: number, limit: number): number {
  let lo = t;
  let u = t;
  while (u < limit) {
    u = Math.min(u + 3600, limit);
    if (offsetAt(fmt, u) !== o0) {
      let hi = u;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetAt(fmt, mid) !== o0) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    lo = u;
  }
  return Infinity;
}

/** YYYY-MM-DD 标签按 UTC 分量构造的 epoch 秒;非真实日期返回 null。 */
function labelEpoch(label: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt.getTime() / 1000;
}

/**
 * 枚举当地日期标签区间 [fromLabel, toLabel) 内每个有实际时段的当地日期。
 * 不按固定偏移把当地午夜换算成 UTC:先在覆盖范围内全部可能实际时刻的 UTC
 * 窗口上用 localDays 按真实墙钟归属(两侧各留 48 小时余量,tz 数据库中
 * 任何偏移的绝对值都小于 24 小时,故余量必然充足),再只保留标签落在
 * 区间内的日期。整日被跳过(没有任何实际 UTC 时段)的当地日期不出现在
 * 返回的 Map 中,由调用方标明跳过。
 */
export function localDaysForLabels(
  fmt: Intl.DateTimeFormat,
  fromLabel: string,
  toLabel: string,
): Map<string, LocalDay> {
  const fromNaive = labelEpoch(fromLabel);
  const toNaive = labelEpoch(toLabel);
  if (fromNaive === null || toNaive === null) throw new Error('invalid date label');
  const margin = 2 * 86400;
  const all = localDays(fmt, fromNaive - margin, toNaive + margin);
  const byLabel = new Map<string, LocalDay>();
  for (const day of all) {
    if (day.label >= fromLabel && day.label < toLabel) byLabel.set(day.label, day);
  }
  return byLabel;
}

/**
 * 把 [from, to) 按当地自然日切分。返回按首次出现排序(即日期升序)的
 * 当地日期,每个日期带实际统计的 UTC 时段;同一日期的不连续时段合并到
 * 同一日期下分别列出,相邻时段并为一个区间。没有实际时段的当地日期
 * (如整体被跳过的日期)不出现。
 */
export function localDays(fmt: Intl.DateTimeFormat, from: number, to: number): LocalDay[] {
  const days: LocalDay[] = [];
  const byKey = new Map<number, LocalDay>();
  let cursor = from;
  while (cursor < to) {
    const w = wallClock(fmt, cursor);
    const o0 = w.naive - cursor;
    // 偏移不变时下一次日期变化的 UTC 时刻;wall(cursor) < nextMidnight,
    // 故 uStar > cursor 恒成立。
    const uStar = w.nextMidnight - o0;
    // 偏移切换可能先于午夜到达(如午夜前后切换夏令时),此时日期是否变化
    // 由下一轮以新偏移重新计算;段内偏移恒定,日期不会中途改变。
    const trans = nextTransition(fmt, cursor, o0, Math.min(uStar, to));
    const end = Math.min(uStar, trans, to);
    let day = byKey.get(w.key);
    if (!day) {
      day = { label: w.label, periods: [] };
      byKey.set(w.key, day);
      days.push(day);
    }
    const last = day.periods[day.periods.length - 1];
    if (last && last.end === cursor) last.end = end;
    else day.periods.push({ start: cursor, end });
    cursor = end;
  }
  return days;
}

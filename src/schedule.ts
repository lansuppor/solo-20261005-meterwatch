// 每周运行时间表:本地文本文件,把查询范围划分为运行与非运行两类时段。
//
// 文件格式:零个或多个窗口,每行一个
//   <星期> <开始 HH:mm> <结束 HH:mm>
// - 星期:mon..sun 或 monday..sunday,不区分大小写;
// - 开始限 00:00..23:59,结束另可 24:00;起止相同拒绝;
// - 结束早于开始即跨至下一日,尾段(次日 [00:00, 结束))沿用开始日规则,
//   周日可跨至周一;
// - 窗口起点含、终点不含,重叠或重复取并集;
// - 空行与 # 开头的行忽略;空表(零个窗口)表示全部非运行。
//
// 分类按实际时刻在指定时区的当地日期与墙钟,每秒只属一类:夏令时前拨
// 跳过的墙钟不存在,不虚构覆盖;回拨重复的墙钟各段各自按当时墙钟分类;
// 不按固定偏移或固定日长推算。

import { formatIsoUtc } from './time.ts';
import { offsetSpans } from './tz.ts';

export interface ScheduleWindow {
  /** 开始星期,0=周日 .. 6=周六。 */
  startDay: number;
  /** 开始时刻,当地午夜起分钟数(0..1439)。 */
  startMin: number;
  /** 结束时刻,当地午夜起分钟数(0..1440;1440 即 24:00)。 */
  endMin: number;
}

export interface ClassPeriod {
  /** 时段起点(含),epoch 秒。 */
  start: number;
  /** 时段终点(不含),epoch 秒。 */
  end: number;
}

export interface ClassifiedPeriods {
  /** 运行时段,按时间升序、互不重叠(相邻同类时段已合并)。 */
  running: ClassPeriod[];
  /** 非运行时段,按时间升序、互不重叠;与运行时段合计恰好覆盖查询范围。 */
  nonRunning: ClassPeriod[];
}

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const CLOCK_RE = /^(\d{2}):(\d{2})$/;

/** 解析 HH:mm 为当地午夜起分钟数;endOfDay 时另允许 24:00(=1440)。失败返回 null。 */
function parseClock(raw: string, endOfDay: boolean): number | null {
  const m = CLOCK_RE.exec(raw);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (mm > 59) return null;
  if (hh === 24) return endOfDay && mm === 0 ? 1440 : null;
  if (hh > 23) return null;
  return hh * 60 + mm;
}

/**
 * 解析每周运行时间表文本。成功返回窗口数组(可为空,空表全部非运行);
 * 任一窗口非法返回错误消息字符串(含行号),由调用方按参数错误处理。
 */
export function parseSchedule(text: string): ScheduleWindow[] | string {
  const windows: ScheduleWindow[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 3) {
      return `第 ${lineNo} 行:需要 '<星期> <开始 HH:mm> <结束 HH:mm>' 三个字段`;
    }
    const day = WEEKDAYS[fields[0].toLowerCase()];
    if (day === undefined) {
      return `第 ${lineNo} 行:未知星期 '${fields[0]}'(需 mon..sun 或 monday..sunday,不区分大小写)`;
    }
    const startMin = parseClock(fields[1], false);
    if (startMin === null) {
      return `第 ${lineNo} 行:开始时刻无效 '${fields[1]}'(需 HH:mm,00:00..23:59)`;
    }
    const endMin = parseClock(fields[2], true);
    if (endMin === null) {
      return `第 ${lineNo} 行:结束时刻无效 '${fields[2]}'(需 HH:mm,00:00..23:59 或 24:00)`;
    }
    if (startMin === endMin) {
      return `第 ${lineNo} 行:窗口起止时刻相同('${fields[1]}'),拒绝`;
    }
    windows.push({ startDay: day, startMin, endMin });
  }
  return windows;
}

/** 当地日期标签(YYYY-MM-DD)的星期,0=周日 .. 6=周六(格里历,与时区无关)。 */
function weekdayOfLabel(label: string): number {
  const [y, m, d] = label.split('-').map(Number);
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  return dt.getUTCDay();
}

/**
 * 某星期几的运行墙钟片段(当地午夜起秒数,已排序并取并集)。
 * 跨日窗口在开始日贡献 [开始, 24:00),在次日贡献尾段 [00:00, 结束)。
 */
function runningSegments(windows: ScheduleWindow[], day: number): Array<[number, number]> {
  const segs: Array<[number, number]> = [];
  for (const w of windows) {
    const cross = w.endMin < w.startMin;
    if (w.startDay === day) segs.push([w.startMin * 60, (cross ? 1440 : w.endMin) * 60]);
    if (cross && (w.startDay + 1) % 7 === day) segs.push([0, w.endMin * 60]);
  }
  segs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of segs) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/**
 * 把 [from, to) 按时间表分为运行与非运行两类实际 UTC 时段。
 * 逐偏移恒定时段处理:时段内墙钟 = UTC + 固定偏移,与该时段墙钟范围覆盖的
 * 每个当地日期的运行片段(当地午夜起秒数)求交,再换算回 UTC。夏令时前拨
 * 跳过的墙钟不出现在任何时段的墙钟范围内,不虚构覆盖;回拨重复的墙钟在
 * 两个相邻时段各自分类。两类合计恰好覆盖 [from, to),每秒只属一类。
 */
export function classifySchedule(
  fmt: Intl.DateTimeFormat,
  windows: ScheduleWindow[],
  from: number,
  to: number,
): ClassifiedPeriods {
  const running: ClassPeriod[] = [];
  const nonRunning: ClassPeriod[] = [];
  const push = (into: ClassPeriod[], start: number, end: number): void => {
    if (start >= end) return;
    const last = into[into.length - 1];
    if (last && last.end === start) last.end = end;
    else into.push({ start, end });
  };
  for (const span of offsetSpans(fmt, from, to)) {
    // 时段内墙钟 = UTC + span.offset;墙钟以"按 UTC 解释的当地日期午夜"为基准,
    // 该基准本身是 86400 的整数倍(当地日期标签即该基准的 UTC 日期)。
    const wallStart = span.start + span.offset;
    const wallEnd = span.end + span.offset;
    let midnight = Math.floor(wallStart / 86400) * 86400;
    for (; midnight < wallEnd; midnight += 86400) {
      const label = formatIsoUtc(midnight).slice(0, 10);
      const segs = runningSegments(windows, weekdayOfLabel(label));
      for (const [s, e] of segs) {
        const lo = Math.max(midnight + s, wallStart);
        const hi = Math.min(midnight + e, wallEnd);
        if (lo >= hi) continue;
        push(running, lo - span.offset, hi - span.offset);
      }
    }
  }
  // 非运行时段为运行时段在 [from, to) 内的补集。
  let cursor = from;
  for (const p of running) {
    push(nonRunning, cursor, p.start);
    cursor = p.end;
  }
  push(nonRunning, cursor, to);
  return { running, nonRunning };
}

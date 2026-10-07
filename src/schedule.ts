// group schedule-report 子命令:按本地每周运行时间表把查询范围划分为运行与
// 非运行两类时段,分别核查分组能耗的只读报表,用于核查停运消耗。
//
// - 时间表为零个或多个每周窗口:开始星期 + 起止 HH:mm。开始限 00:00-23:59,
//   结束另可 24:00;同值起止拒绝;结束早于开始即跨至下一日(尾段沿用开始
//   日规则,周日可跨至周一)。窗口起点含、终点不含,重叠或重复取并集;空表
//   (零个窗口)表示全部非运行。
// - 分类按实际时刻的当地日期与墙钟:每秒只属一类;夏令时跳过时段不虚构
//   覆盖,回拨重复时段各自分类,不套固定偏移或日长。--tz 只解释时间表,
//   不重新解释起止时刻或已存读数。
// - 能耗口径与 group daily 相同:按当时生效成员与完整读数时序,全部成员
//   可信才累加消耗,任一成员下降优先为异常,否则任一成员未知为未知;首个
//   版本生效前、读数首末之外与孤立读数未知,不外推。采样限制按原始相邻
//   区间判断,裁切不使过长区间可信,等于限制仍可信;有效片段取原区间起点
//   累计比例向下取整的两端差,切分不重置起点;BigInt 精确计算,kWh 固定
//   三位小数。
// - 两类覆盖合计等于查询时长,消耗合计等于同范围、同限制的分组日报,拆开
//   查询相加一致;覆盖按时间计,不叠加成员秒数。
// - 只读:不改写时间表或业务存储,不自动评估;修正撤销后重查使用当前读数。
//   成功(含不可计算结果)返回 0;非法时间表返回 2;时间表文件不可读、未知
//   分组、所用存储损坏或全库重复读数身份返回 1,指出原因,不输出部分报表。

import { readFileSync } from 'node:fs';
import { dataFilePath, groupFilePath, loadStore, StoreError, type Reading } from './store.ts';
import { formatIsoUtc, parseUtcDate } from './time.ts';
import { loadTimezone, wallSegments } from './tz.ts';
import { formatKwh } from './value.ts';
import { formatGapLine, maxIntervalText, mergeGaps, type GapDetail } from './report.ts';
import {
  computeGroupSegment,
  loadCheckedSeriesByDevice,
  loadGroups,
  type Group,
} from './groups.ts';

function err(message: string): void {
  console.error(`meterwatch: ${message}`);
}

export interface ScheduleWindow {
  /** 开始星期,0=周日 .. 6=周六。 */
  startDow: number;
  /** 开始当日的起始分钟,0..1439。 */
  startMin: number;
  /** 相对开始日的结束分钟(不含),恒大于 startMin;结束早于开始时 +1440 跨至下一日。 */
  endMin: number;
}

const DOW_BY_NAME: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** 星期序号的显示名(0=周日 .. 6=周六)。 */
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** 一周分钟数(7 * 1440)。 */
const WEEK_MINUTES = 7 * 1440;

/**
 * 单个窗口相对开始日的最大结束分钟(两天):分类只对每个当地日期回看
 * 上一日开始的窗口,故规范形窗口最长跨至下一日结束,更长的时间段必须
 * 拆成多个窗口表示。
 */
const MAX_WINDOW_END_MIN = 2 * 1440;

/** 解析 HH:mm 为当日分钟数;allow24 时另接受 24:00(=1440)。无效返回 null。 */
function parseHm(raw: string, allow24: boolean): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(raw);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59) return null;
  if (h > 23) {
    if (allow24 && h === 24 && mi === 0) return 1440;
    return null;
  }
  return h * 60 + mi;
}

/**
 * 解析每周运行时间表文本。每行一个窗口:<星期> <开始 HH:mm> <结束 HH:mm>;
 * 空行与 # 之后的注释忽略。星期为 mon..sun(不区分大小写)。开始限
 * 00:00-23:59,结束另可 24:00;同值起止拒绝;结束早于开始跨至下一日。
 * 重叠或重复窗口不在此拒绝,分类时取并集。非法时返回错误消息字符串。
 */
export function parseSchedule(text: string): ScheduleWindow[] | string {
  const windows: ScheduleWindow[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const hash = lines[i].indexOf('#');
    const line = (hash === -1 ? lines[i] : lines[i].slice(0, hash)).trim();
    if (line === '') continue;
    const where = `line ${i + 1}`;
    const parts = line.split(/\s+/);
    if (parts.length !== 3) {
      return `${where}: expect '<weekday> <start HH:mm> <end HH:mm>' (weekday: mon..sun)`;
    }
    // 只认对象自身的星期键,避免 constructor/__proto__/toString 等原型名被
    // 误当成合法星期(那些名字解析为 undefined,但用 in/点访问会命中原型)。
    const dow = Object.hasOwn(DOW_BY_NAME, parts[0].toLowerCase())
      ? DOW_BY_NAME[parts[0].toLowerCase() as keyof typeof DOW_BY_NAME]
      : undefined;
    if (dow === undefined) {
      return `${where}: unknown weekday '${parts[0]}' (expect mon, tue, wed, thu, fri, sat or sun)`;
    }
    const start = parseHm(parts[1], false);
    if (start === null) {
      return `${where}: invalid start time '${parts[1]}' (expect HH:mm within 00:00-23:59)`;
    }
    const end = parseHm(parts[2], true);
    if (end === null) {
      return `${where}: invalid end time '${parts[2]}' (expect HH:mm within 00:00-24:00)`;
    }
    if (end === start) {
      return `${where}: start and end must differ (both are '${parts[1]}')`;
    }
    // 结束早于开始即跨至下一日,尾段沿用开始日规则(周日可跨至周一)。
    const endMin = end < start ? end + 1440 : end;
    windows.push({ startDow: dow, startMin: start, endMin });
  }
  return windows;
}

/**
 * 把每周运行窗口规范化为并集的最简形式:按周分钟(0..10079)展开为覆盖
 * 集合(结束越过周界的窗口取模回卷),再合并为按周分钟升序、互不重叠、
 * 互不相邻的窗口列表;超过两天的连续覆盖按每个窗口最多跨至下一日结束
 * 切分(分类只回看上一日开始的窗口)。窗口顺序、重复与等价拆分(如
 * mon 08:00-12:00 加 mon 12:00-18:00 对比 mon 08:00-18:00)不影响规范形,
 * 故规范形相同当且仅当每周运行窗口的并集相同。空表(零个窗口)的规范形
 * 为空数组。
 */
export function canonicalizeWindows(windows: ScheduleWindow[]): ScheduleWindow[] {
  const covered = new Uint8Array(WEEK_MINUTES);
  for (const w of windows) {
    const s = w.startDow * 1440 + w.startMin;
    const e = w.startDow * 1440 + w.endMin;
    for (let m = s; m < e; m++) covered[m % WEEK_MINUTES] = 1;
  }
  const out: ScheduleWindow[] = [];
  let m = 0;
  while (m < WEEK_MINUTES) {
    if (covered[m] === 0) {
      m++;
      continue;
    }
    const s = m;
    while (m < WEEK_MINUTES && covered[m] === 1) m++;
    // 连续覆盖段 [s, m):切成每个窗口最多跨至下一日结束(分类只回看一天)。
    let cur = s;
    while (cur < m) {
      const startDow = Math.floor(cur / 1440);
      const end = Math.min(m, startDow * 1440 + MAX_WINDOW_END_MIN);
      out.push({ startDow, startMin: cur - startDow * 1440, endMin: end - startDow * 1440 });
      cur = end;
    }
  }
  return out;
}

/**
 * 时间表的展示形式:`dow HH:mm-HH:mm` 列表(逗号分隔);结束可跨夜,
 * 小时可大于 24(相对开始日)。零个窗口显示为 `(no running windows)`。
 */
export function formatSchedule(windows: ScheduleWindow[]): string {
  if (windows.length === 0) return '(no running windows)';
  const hm = (min: number): string =>
    `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  return windows
    .map((w) => `${DOW_NAMES[w.startDow]} ${hm(w.startMin)}-${hm(w.endMin)}`)
    .join(', ');
}

/**
 * 解析存储中的时间表字段(窗口数组,元素为 {startDow, startMin, endMin}):
 * startDow 0..6,startMin 0..1439,endMin 大于 startMin 且不超过两天(规范
 * 形窗口最多跨至下一日结束,与分类的回看口径一致)。非法返回 null,由
 * 调用方按损坏数据处理。
 */
export function validateStoredSchedule(value: unknown): ScheduleWindow[] | null {
  if (!Array.isArray(value)) return null;
  const out: ScheduleWindow[] = [];
  for (const w of value) {
    if (w === null || typeof w !== 'object') return null;
    const o = w as Record<string, unknown>;
    if (
      !Number.isSafeInteger(o.startDow) ||
      (o.startDow as number) < 0 ||
      (o.startDow as number) > 6 ||
      !Number.isSafeInteger(o.startMin) ||
      (o.startMin as number) < 0 ||
      (o.startMin as number) > 1439 ||
      !Number.isSafeInteger(o.endMin) ||
      (o.endMin as number) <= (o.startMin as number) ||
      (o.endMin as number) > MAX_WINDOW_END_MIN
    ) {
      return null;
    }
    out.push({
      startDow: o.startDow as number,
      startMin: o.startMin as number,
      endMin: o.endMin as number,
    });
  }
  return out;
}

interface Period {
  /** 时段起点(含),epoch 秒。 */
  start: number;
  /** 时段终点(不含),epoch 秒。 */
  end: number;
}

/** 墙钟午夜(按 UTC 解释的 epoch 秒)对应的星期,0=周日。1970-01-01 为周四。 */
function dowOfNaive(naiveMidnight: number): number {
  const days = Math.floor(naiveMidnight / 86400);
  return (((days + 4) % 7) + 7) % 7;
}

/**
 * 把 [from, to) 按每周时间表分为运行与非运行两类实际 UTC 时段,两类合计
 * 恰好等于查询范围(每秒只属一类)。分类按实际时刻的当地日期与墙钟:
 * 墙钟段切分自命名时区(段内偏移恒定、当地日期单一),窗口墙钟区间与段
 * 墙钟区间求交后换算回 UTC;夏令时跳过的墙钟没有实际时刻,不虚构覆盖,
 * 回拨重复的墙钟两段实际时段各自分类,不套固定偏移或日长。
 */
export function classifyPeriods(
  fmt: Intl.DateTimeFormat,
  from: number,
  to: number,
  windows: ScheduleWindow[],
): { running: Period[]; nonRunning: Period[] } {
  const raw: Period[] = [];
  if (windows.length > 0) {
    // 各当地日期生效的窗口墙钟区间(按墙钟午夜缓存):本日开始的窗口,以及
    // 上一日开始、跨至本日的窗口尾段。
    const wallByDate = new Map<string, Array<[number, number]>>();
    const wallIntervalsOf = (label: string): Array<[number, number]> => {
      const cached = wallByDate.get(label);
      if (cached) return cached;
      const dayNaive = parseUtcDate(label) as number;
      const wall: Array<[number, number]> = [];
      for (const w of windows) {
        for (const startNaive of [dayNaive, dayNaive - 86400]) {
          if (dowOfNaive(startNaive) !== w.startDow) continue;
          wall.push([startNaive + w.startMin * 60, startNaive + w.endMin * 60]);
        }
      }
      wallByDate.set(label, wall);
      return wall;
    };
    for (const seg of wallSegments(fmt, from, to)) {
      const wall = wallIntervalsOf(seg.label);
      if (wall.length === 0) continue;
      // 段内偏移恒定,墙钟区间随 UTC 线性平移。
      const ws = seg.start + seg.offset;
      const we = seg.end + seg.offset;
      for (const [a, b] of wall) {
        const lo = Math.max(a, ws);
        const hi = Math.min(b, we);
        if (lo < hi) raw.push({ start: lo - seg.offset, end: hi - seg.offset });
      }
    }
    raw.sort((a, b) => a.start - b.start);
  }
  // 重叠或重复窗口取并集。
  const running: Period[] = [];
  for (const r of raw) {
    const last = running[running.length - 1];
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
    } else {
      running.push({ start: r.start, end: r.end });
    }
  }
  const nonRunning: Period[] = [];
  let cursor = from;
  for (const r of running) {
    if (cursor < r.start) nonRunning.push({ start: cursor, end: r.start });
    cursor = r.end;
  }
  if (cursor < to) nonRunning.push({ start: cursor, end: to });
  return { running, nonRunning };
}

/**
 * 分组运行/非运行时段能耗报表:按本地每周运行时间表把 [from, to) 分为
 * 两类时段,分别按当时生效成员核查能耗。只读,不写入数据。返回进程退出码。
 */
export function cmdGroupScheduleReport(opts: {
  id: string;
  /** 本地每周运行时间表文件路径(只读)。 */
  schedulePath: string;
  from: number;
  to: number;
  /** 解释时间表的 IANA 时区;省略为 UTC。 */
  tz?: string;
  /** 最大采样间隔限制(正整数秒);省略表示无上限。只影响本次查询结果。 */
  maxInterval?: number;
}): number {
  const tzName = opts.tz ?? 'UTC';
  const tz = loadTimezone(tzName);
  if (!tz) {
    err(`unknown timezone '${tzName}' (expect an IANA timezone name supported by this runtime)`);
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(opts.schedulePath, 'utf8');
  } catch (e) {
    err(`cannot read schedule file ${opts.schedulePath}: ${(e as Error).message}`);
    return 1;
  }
  const parsed = parseSchedule(text);
  if (typeof parsed === 'string') {
    err(`invalid schedule file ${opts.schedulePath}: ${parsed}`);
    return 2;
  }
  const windows = parsed;

  let groups: Group[];
  try {
    groups = loadGroups(groupFilePath());
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  const group = groups.find((g) => g.id === opts.id);
  if (!group) {
    err(`unknown group '${opts.id}'`);
    return 1;
  }

  let seriesByDevice: Map<string, Reading[]>;
  try {
    seriesByDevice = loadCheckedSeriesByDevice(loadStore(dataFilePath()));
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  const { running, nonRunning } = classifyPeriods(tz, opts.from, opts.to, windows);

  console.log(`group: ${group.id}`);
  console.log(`schedule: ${opts.schedulePath} (${windows.length} window(s))`);
  console.log(`timezone: ${tzName}`);
  console.log(`max-interval: ${maxIntervalText(opts.maxInterval)}`);

  const classes: Array<{ name: string; periods: Period[] }> = [
    { name: 'running', periods: running },
    { name: 'non-running', periods: nonRunning },
  ];
  let incomplete = false;
  const coverage: number[] = [];
  for (const c of classes) {
    let valid = 0;
    let anomaly = 0;
    let unknown = 0;
    let gapUnknown = 0;
    const gaps: GapDetail[] = [];
    let consumption = 0n;
    for (const p of c.periods) {
      const stats = computeGroupSegment(
        group.versions,
        seriesByDevice,
        p.start,
        p.end,
        opts.maxInterval,
      );
      valid += stats.valid;
      anomaly += stats.anomaly;
      unknown += stats.unknown;
      gapUnknown += stats.gapUnknown;
      mergeGaps(gaps, stats.gaps);
      consumption += stats.consumption;
    }
    let seconds = 0;
    for (const p of c.periods) seconds += p.end - p.start;
    coverage.push(seconds);
    const classIncomplete = anomaly > 0 || unknown > 0;
    if (classIncomplete) incomplete = true;

    const consumptionText =
      valid > 0
        ? `consumption=${formatKwh(consumption)} kWh (estimate)`
        : 'consumption=n/a (no valid coverage)';
    let line =
      `  class=${c.name}  ${consumptionText}` +
      `  valid=${valid}s  anomaly=${anomaly}s  unknown=${unknown}s`;
    if (opts.maxInterval !== undefined) line += `  gap=${gapUnknown}s`;
    if (classIncomplete) line += '  INCOMPLETE';
    console.log(line);
    for (const p of c.periods) {
      console.log(`    period=${formatIsoUtc(p.start)}..${formatIsoUtc(p.end)}`);
    }
    for (const g of gaps) {
      console.log(formatGapLine(g));
    }
  }

  const status = incomplete
    ? 'status=INCOMPLETE (unknown or anomaly coverage present)'
    : 'status=complete';
  console.log(
    `  summary: group=${group.id}  running=${coverage[0]}s  non-running=${coverage[1]}s` +
      `  total=${opts.to - opts.from}s  ${status}`,
  );
  return 0;
}

// daily 子命令:按当地自然日核查能耗的只读日报,默认 UTC,可用 --tz 指定
// 运行环境支持的 IANA 时区。时区只决定分日,不重新解释输入时刻或已存读数。
//
// 估算口径:
// - 区间由每个设备完整已存时序的相邻读数构成,两端读数即使在查询范围外
//   也参与;范围内没有读数但被区间覆盖时仍得到结果。
// - 非下降区间把累计值之差按持续时间均匀分摊:以千分之一 kWh 为单位,
//   从区间起点累计到任一切点 t 的比例量为 floor(diff*(t-start)/duration),
//   片段消耗为终点与起点累计量之差。切点为查询边界与当地日界线,因此
//   完整区间的分摊总量等于原差值,同一区间拆开查询再相加结果一致;
//   新的日界线不重置分摊起点。
// - 中间乘积与多区间汇总使用 BigInt,超过 Number 安全整数范围仍精确。
// - 下降区间不分摊消耗,记为异常覆盖;其后的区间仍从下降后的读数计算。
// - 首条读数之前、末条之后及孤立读数时段为未知,不外推。
// - 日界线按实际时刻的当地日期归属计算,不用固定 86400 秒或固定偏移推算:
//   夏令时前拨当天更短(跳过的小时不补为未知),回拨当天更长(重复小时按
//   各自实际时刻完整计入);同一当地日期的不连续时段合并统计、分别列出;
//   没有实际时段的当地日期不生成日报。

import { loadStore, StoreError, dataFilePath, type Reading } from './store.ts';
import { formatIsoUtc } from './time.ts';
import { localDays, loadTimezone, type LocalDay } from './tz.ts';
import { formatKwh } from './value.ts';
import { formatLimit, formatGapInterval, type GapInterval } from './interval.ts';

export interface DailyFilter {
  devices: string[];
  /** 查询起点(含),epoch 秒。 */
  from: number;
  /** 查询终点(不含),epoch 秒。 */
  to: number;
  /** 分日时区(IANA 名称);省略时按 UTC。 */
  tz?: string;
  /** 最大采样间隔(正整数秒);省略表示无上限,沿用原计算口径。 */
  maxGapSeconds?: number;
}

export const DAY_SECONDS = 86400;

function err(message: string): void {
  console.error(`meterwatch: ${message}`);
}

export interface DayStats {
  /** 有效(非下降且未超长的区间)覆盖秒数。 */
  valid: number;
  /** 异常(下降区间;即使也超长)覆盖秒数。 */
  anomaly: number;
  /** 未知(无区间覆盖)秒数。 */
  unknown: number;
  /** 其中因相邻读数实际时间差超过限制而记为未知的秒数(unknown 的子集)。 */
  gapUnknown: number;
  /** 该天分摊消耗,毫千瓦时;仅 valid > 0 时有意义。 */
  consumption: bigint;
  /** 与该统计时段相交的过长非下降区间(完整时序口径,去重),用于结果展示。 */
  gapIntervals: GapInterval[];
}

/** 计算 [segStart, segEnd) 一天(或一个 UTC 时段)的统计;区间取自完整时序。 */
export function computeDay(
  series: Reading[],
  segStart: number,
  segEnd: number,
  maxGapSeconds?: number,
): DayStats {
  let valid = 0;
  let anomaly = 0;
  let gapUnknown = 0;
  let consumption = 0n;
  const gapKeys = new Set<string>();
  const gapIntervals: GapInterval[] = [];
  const recordGap = (a: Reading, b: Reading, length: number): void => {
    gapUnknown += length;
    const key = `${a.ts}|${b.ts}`;
    if (!gapKeys.has(key)) {
      gapKeys.add(key);
      gapIntervals.push({ prevTs: a.ts, nextTs: b.ts, duration: b.ts - a.ts });
    }
  };
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1];
    const b = series[i];
    const lo = Math.max(a.ts, segStart);
    const hi = Math.min(b.ts, segEnd);
    if (lo >= hi) continue;
    const length = hi - lo;
    const diff = b.milli - a.milli;
    if (diff < 0n) {
      // 下降区间即使也超过限制仍为异常:异常优先于过长未知。
      anomaly += length;
    } else if (maxGapSeconds !== undefined && b.ts - a.ts > maxGapSeconds) {
      // 时间差按完整时序的相邻读数判定,查询/日界裁切不改变判定结果:
      // 整个区间视为未知,不分摊消耗。
      recordGap(a, b, length);
    } else {
      valid += length;
      const duration = BigInt(b.ts - a.ts);
      const total = diff;
      // 从区间起点累计到 t 的比例量(向下取整);BigInt 除法向零截断,
      // 被除数非负,等价于向下取整。
      const cumulative = (t: number): bigint => (total * BigInt(t - a.ts)) / duration;
      consumption += cumulative(hi) - cumulative(lo);
    }
  }
  const unknown = segEnd - segStart - valid - anomaly;
  return { valid, anomaly, unknown, gapUnknown, consumption, gapIntervals };
}

/** 合并多个 UTC 时段的统计;gapIntervals 按区间起点去重后按时刻升序。 */
function mergeDayStats(parts: DayStats[]): DayStats {
  let valid = 0;
  let anomaly = 0;
  let unknown = 0;
  let gapUnknown = 0;
  let consumption = 0n;
  const byKey = new Map<string, GapInterval>();
  for (const s of parts) {
    valid += s.valid;
    anomaly += s.anomaly;
    unknown += s.unknown;
    gapUnknown += s.gapUnknown;
    consumption += s.consumption;
    for (const g of s.gapIntervals) byKey.set(`${g.prevTs}|${g.nextTs}`, g);
  }
  const gapIntervals = [...byKey.values()].sort((x, y) => x.prevTs - y.prevTs || x.nextTs - y.nextTs);
  return { valid, anomaly, unknown, gapUnknown, consumption, gapIntervals };
}

/** 汇总一天内各 UTC 时段的统计;三类秒数之和等于这些时段的总秒数。 */
function sumDayStats(series: Reading[], day: LocalDay, maxGapSeconds?: number): DayStats {
  return mergeDayStats(day.periods.map((p) => computeDay(series, p.start, p.end, maxGapSeconds)));
}

/**
 * 输出按当地自然日划分的能耗日报。只读,不修改数据。
 * 同设备同一实际时刻存在多条存储记录时报错并返回 1。
 * 返回进程退出码。
 */
export function cmdDaily(filter: DailyFilter): number {
  const tzName = filter.tz ?? 'UTC';
  const tz = loadTimezone(tzName);
  if (!tz) {
    err(`unknown timezone '${tzName}' (expect an IANA timezone name supported by this runtime)`);
    return 2;
  }
  const days = localDays(tz, filter.from, filter.to);

  const storePath = dataFilePath();
  let all: Reading[];
  try {
    all = loadStore(storePath);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  const byDevice = new Map<string, Reading[]>();
  for (const r of all) {
    const list = byDevice.get(r.device);
    if (list) list.push(r);
    else byDevice.set(r.device, [r]);
  }
  for (const [device, list] of byDevice) {
    list.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < list.length; i++) {
      if (list[i].ts === list[i - 1].ts) {
        err(
          `storage error: multiple stored readings for device '${device}' at ${formatIsoUtc(list[i].ts)}`,
        );
        return 1;
      }
    }
  }

  const wanted =
    filter.devices.length > 0 ? [...new Set(filter.devices)] : [...byDevice.keys()];
  wanted.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  console.log(`timezone: ${tzName}`);
  console.log(`max sample gap: ${formatLimit(filter.maxGapSeconds)}`);
  let printed = false;
  for (const device of wanted) {
    const series = byDevice.get(device);
    if (!series) continue;
    printed = true;

    console.log(`device: ${device}`);
    let total = 0n;
    let computedDays = 0;
    let incomplete = false;
    for (const day of days) {
      const stats = sumDayStats(series, day, filter.maxGapSeconds);
      const dayIncomplete = stats.anomaly > 0 || stats.unknown > 0;
      if (dayIncomplete) incomplete = true;

      let consumption: string;
      if (stats.valid > 0) {
        consumption = `consumption=${formatKwh(stats.consumption)} kWh (estimate)`;
        total += stats.consumption;
        computedDays++;
      } else {
        consumption = 'consumption=n/a (no valid coverage)';
      }
      let line =
        `  ${day.label}  ${consumption}` +
        `  valid=${stats.valid}s  anomaly=${stats.anomaly}s  unknown=${stats.unknown}s`;
      if (stats.gapUnknown > 0) line += `  gap-unknown=${stats.gapUnknown}s`;
      if (dayIncomplete) line += '  INCOMPLETE';
      console.log(line);
      for (const p of day.periods) {
        console.log(`    period=${formatIsoUtc(p.start)}..${formatIsoUtc(p.end)}`);
      }
      for (const g of stats.gapIntervals) {
        console.log(`    overlong gap: device=${device}  adjacent readings=${formatGapInterval(g)}`);
      }
    }

    const totalText =
      computedDays > 0
        ? `total consumption=${formatKwh(total)} kWh (estimate)`
        : 'total consumption=n/a (no valid coverage)';
    const status = incomplete
      ? 'status=INCOMPLETE (unknown or anomaly coverage present)'
      : 'status=complete';
    console.log(
      `  summary: device=${device}  computed=${computedDays}/${days.length} day(s)  ${totalText}  ${status}`,
    );
  }
  if (!printed) console.log('no matching devices');
  return 0;
}

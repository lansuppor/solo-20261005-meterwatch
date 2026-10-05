// daily 子命令:按自然日核查能耗的只读日报。
//
// 分日:默认按 UTC 自然日;--tz 指定 IANA 命名时区时按该时区的当地日期
// 划分,日界线由实际时刻的当地日期归属确定(见 tz.ts),不按固定 86400 秒
// 或固定偏移推算;时区只决定分日,不重新解释输入时刻或已存读数。同一当地
// 日期的不连续时段合并统计、分别列出;没有实际时段的当地日期不生成日报。
//
// 估算口径:
// - 区间由每个设备完整已存时序的相邻读数构成,两端读数即使在查询范围外
//   也参与;范围内没有读数但被区间覆盖时仍得到结果。
// - 非下降区间把累计值之差按持续时间均匀分摊:以千分之一 kWh 为单位,
//   从区间起点累计到任一切点 t 的比例量为 floor(diff*(t-start)/duration),
//   片段消耗为终点与起点累计量之差。切点为查询边界与日界线,日界线不重置
//   分摊起点,因此完整区间的分摊总量等于原差值,同一区间拆开查询再相加
//   结果一致。
// - 中间乘积与多区间汇总使用 BigInt,超过 Number 安全整数范围仍精确。
// - 下降区间不分摊消耗,记为异常覆盖;其后的区间仍从下降后的读数计算。
// - 首条读数之前、末条之后及孤立读数时段为未知,不外推。

import { loadStore, StoreError, dataFilePath, type Reading } from './store.ts';
import { formatIsoUtc } from './time.ts';
import { formatKwh } from './value.ts';
import { localDaySegments, type LocalDaySegment } from './tz.ts';

export interface DailyFilter {
  devices: string[];
  /** 查询起点(含),epoch 秒。 */
  from: number;
  /** 查询终点(不含),epoch 秒。 */
  to: number;
  /** 分日所用 IANA 时区的规范名称(默认 UTC);只决定日界线。 */
  tz: string;
}

export const DAY_SECONDS = 86400;

function err(message: string): void {
  console.error(`meterwatch: ${message}`);
}

export interface DayStats {
  /** 有效(非下降区间)覆盖秒数。 */
  valid: number;
  /** 异常(下降区间)覆盖秒数。 */
  anomaly: number;
  /** 未知(无区间覆盖)秒数。 */
  unknown: number;
  /** 该天分摊消耗,毫千瓦时;仅 valid > 0 时有意义。 */
  consumption: bigint;
}

/** 计算 [segStart, segEnd) 一天的统计;区间取自完整时序。 */
export function computeDay(series: Reading[], segStart: number, segEnd: number): DayStats {
  let valid = 0;
  let anomaly = 0;
  let consumption = 0n;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1];
    const b = series[i];
    const lo = Math.max(a.ts, segStart);
    const hi = Math.min(b.ts, segEnd);
    if (lo >= hi) continue;
    const diff = b.milli - a.milli;
    if (diff < 0n) {
      anomaly += hi - lo;
    } else {
      valid += hi - lo;
      const duration = BigInt(b.ts - a.ts);
      const total = diff;
      // 从区间起点累计到 t 的比例量(向下取整);BigInt 除法向零截断,
      // 被除数非负,等价于向下取整。
      const cumulative = (t: number): bigint => (total * BigInt(t - a.ts)) / duration;
      consumption += cumulative(hi) - cumulative(lo);
    }
  }
  const unknown = segEnd - segStart - valid - anomaly;
  return { valid, anomaly, unknown, consumption };
}

/** 同一当地日期的合并统计及其按实际时刻列出的各 UTC 时段。 */
interface DayAggregate {
  /** 当地日期,YYYY-MM-DD。 */
  date: string;
  /** 该日期在查询范围内的各 UTC 时段,按实际时刻升序。 */
  segments: LocalDaySegment[];
  valid: number;
  anomaly: number;
  unknown: number;
  /** 分摊消耗合计,毫千瓦时;仅 valid > 0 时有意义。 */
  consumption: bigint;
}

/**
 * 输出按当地自然日划分的能耗日报(分日时区由 filter.tz 指定)。只读,不修改数据。
 * 同设备同一实际时刻存在多条存储记录时报错并返回 1。
 * 返回进程退出码。
 */
export function cmdDaily(filter: DailyFilter): number {
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

  // 查询范围按当地日界线切分,与设备无关,只算一次。
  const segments = localDaySegments(filter.tz, filter.from, filter.to);

  let printed = false;
  for (const device of wanted) {
    const series = byDevice.get(device);
    if (!series) continue;
    printed = true;

    console.log(`device: ${device}`);
    console.log(`timezone: ${filter.tz}`);

    // 按当地日期合并:同一日期的不连续时段合并统计、分别列出。
    const days: DayAggregate[] = [];
    const byDate = new Map<string, DayAggregate>();
    for (const seg of segments) {
      const stats = computeDay(series, seg.start, seg.end);
      let day = byDate.get(seg.date);
      if (!day) {
        day = { date: seg.date, segments: [], valid: 0, anomaly: 0, unknown: 0, consumption: 0n };
        byDate.set(seg.date, day);
        days.push(day);
      }
      day.segments.push(seg);
      day.valid += stats.valid;
      day.anomaly += stats.anomaly;
      day.unknown += stats.unknown;
      day.consumption += stats.consumption;
    }

    let total = 0n;
    let computedDays = 0;
    let incomplete = false;
    for (const day of days) {
      const dayIncomplete = day.anomaly > 0 || day.unknown > 0;
      if (dayIncomplete) incomplete = true;

      let consumption: string;
      if (day.valid > 0) {
        consumption = `consumption=${formatKwh(day.consumption)} kWh (estimate)`;
        total += day.consumption;
        computedDays++;
      } else {
        consumption = 'consumption=n/a (no valid coverage)';
      }
      let line =
        `  ${day.date}  ${consumption}` +
        `  valid=${day.valid}s  anomaly=${day.anomaly}s  unknown=${day.unknown}s`;
      if (dayIncomplete) line += '  INCOMPLETE';
      console.log(line);
      for (const seg of day.segments) {
        console.log(`    utc=${formatIsoUtc(seg.start)}..${formatIsoUtc(seg.end)}`);
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

// daily 子命令:按 UTC 自然日核查能耗的只读日报。
//
// 估算口径:
// - 区间由每个设备完整已存时序的相邻读数构成,两端读数即使在查询范围外
//   也参与;范围内没有读数但被区间覆盖时仍得到结果。
// - 非下降区间把累计值之差按持续时间均匀分摊:以千分之一 kWh 为单位,
//   从区间起点累计到任一切点 t 的比例量为 floor(diff*(t-start)/duration),
//   片段消耗为终点与起点累计量之差。切点为查询边界与 UTC 日界线,因此
//   完整区间的分摊总量等于原差值,同一区间拆开查询再相加结果一致。
// - 中间乘积与多区间汇总使用 BigInt,超过 Number 安全整数范围仍精确。
// - 下降区间不分摊消耗,记为异常覆盖;其后的区间仍从下降后的读数计算。
// - 首条读数之前、末条之后及孤立读数时段为未知,不外推。

import { loadStore, StoreError, dataFilePath, type Reading } from './store.ts';
import { formatIsoUtc } from './time.ts';
import { formatKwh } from './value.ts';

export interface DailyFilter {
  devices: string[];
  /** 查询起点(含),epoch 秒。 */
  from: number;
  /** 查询终点(不含),epoch 秒。 */
  to: number;
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

/**
 * 输出按 UTC 自然日划分的能耗日报。只读,不修改数据。
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

  let printed = false;
  for (const device of wanted) {
    const series = byDevice.get(device);
    if (!series) continue;
    printed = true;

    console.log(`device: ${device}`);
    let total = 0n;
    let computedDays = 0;
    let days = 0;
    let incomplete = false;
    for (let dayStart = Math.floor(filter.from / DAY_SECONDS) * DAY_SECONDS;
      dayStart < filter.to;
      dayStart += DAY_SECONDS) {
      const segStart = Math.max(dayStart, filter.from);
      const segEnd = Math.min(dayStart + DAY_SECONDS, filter.to);
      const stats = computeDay(series, segStart, segEnd);
      days++;

      const date = formatIsoUtc(dayStart).slice(0, 10);
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
        `  ${date}  ${consumption}` +
        `  valid=${stats.valid}s  anomaly=${stats.anomaly}s  unknown=${stats.unknown}s`;
      if (dayIncomplete) line += '  INCOMPLETE';
      console.log(line);
    }

    const totalText =
      computedDays > 0
        ? `total consumption=${formatKwh(total)} kWh (estimate)`
        : 'total consumption=n/a (no valid coverage)';
    const status = incomplete
      ? 'status=INCOMPLETE (unknown or anomaly coverage present)'
      : 'status=complete';
    console.log(
      `  summary: device=${device}  computed=${computedDays}/${days} day(s)  ${totalText}  ${status}`,
    );
  }
  if (!printed) console.log('no matching devices');
  return 0;
}

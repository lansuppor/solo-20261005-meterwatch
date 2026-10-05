// 按 UTC 自然日核查能耗的日报计算(纯计算,不触碰存储)。
//
// 口径:
// - 区间由设备完整时序的相邻读数构成 [前读数时刻, 后读数时刻);
//   与查询范围相交的区间,两端读数即使在范围外也参与计算。
// - 非下降区间按持续时间均匀分摊累计值之差,结果为估算:
//   以千分之一 kWh(毫千瓦时)为单位,从区间起点累计到任一切点 t 的
//   比例量 floor(diff * (t - start) / duration) 向下取整,
//   任一片段的消耗 = 片段终点累计量 - 片段起点累计量。
//   切点只取查询边界与日界线,因此完整区间分摊总量恒等于原差值,
//   同一区间任意拆开查询再相加结果一致。
// - 下降区间不分摊消耗,整段记为异常覆盖;其后的区间仍从下降后的读数计算。
// - 首条读数之前、末条读数之后以及只有孤立读数(无任何区间)的时段为未知,
//   不外推。
// - 乘积与汇总使用 BigInt,超出 Number 安全整数范围时仍然精确。

import { formatDateUtc } from './time.ts';
import type { Reading } from './store.ts';

const DAY_SECONDS = 86400;

export interface DayReport {
  /** UTC 日期,YYYY-MM-DD。 */
  date: string;
  /** 估算消耗(毫千瓦时);当天无有效覆盖时为 null(无法计算)。 */
  milli: bigint | null;
  validSecs: number;
  anomalySecs: number;
  unknownSecs: number;
}

export interface DeviceReport {
  device: string;
  days: DayReport[];
  /** 已计算每日消耗之和(毫千瓦时);范围内无任何有效覆盖时为 null。 */
  totalMilli: bigint | null;
  /** 范围内所有天都无未知、无异常覆盖时为 true。 */
  complete: boolean;
}

interface Interval {
  start: number;
  end: number;
  /** 后读数 - 前读数(毫千瓦时),valid 时保证 >= 0。 */
  diff: bigint;
  valid: boolean;
}

/**
 * 计算单个设备在 [from, to) 内每个 UTC 自然日的日报。
 * series 必须按 ts 升序且无重复时刻(由调用方保证)。
 */
export function buildDeviceReport(
  device: string,
  series: Reading[],
  from: number,
  to: number,
): DeviceReport {
  const intervals: Interval[] = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1];
    const b = series[i];
    intervals.push({
      start: a.ts,
      end: b.ts,
      diff: BigInt(b.milli) - BigInt(a.milli),
      valid: b.milli >= a.milli,
    });
  }

  const firstDay = Math.floor(from / DAY_SECONDS);
  const lastDay = Math.floor((to - 1) / DAY_SECONDS);

  const days: DayReport[] = [];
  let totalMilli: bigint | null = null;
  let complete = true;

  for (let d = firstDay; d <= lastDay; d++) {
    const dayStart = Math.max(d * DAY_SECONDS, from);
    const dayEnd = Math.min((d + 1) * DAY_SECONDS, to);
    let validSecs = 0;
    let anomalySecs = 0;
    let milli = 0n;
    let hasValid = false;

    for (const iv of intervals) {
      if (iv.end <= dayStart) continue;
      if (iv.start >= dayEnd) break;
      const s = Math.max(iv.start, dayStart);
      const e = Math.min(iv.end, dayEnd);
      const secs = e - s;
      if (!iv.valid) {
        anomalySecs += secs;
        continue;
      }
      validSecs += secs;
      hasValid = true;
      // 从区间起点累计到切点 t 的分摊量(向下取整);片段消耗为两点累计量之差。
      const duration = BigInt(iv.end - iv.start);
      const cumulative = (t: number): bigint =>
        (iv.diff * BigInt(t - iv.start)) / duration;
      milli += cumulative(e) - cumulative(s);
    }

    const unknownSecs = dayEnd - dayStart - validSecs - anomalySecs;
    if (anomalySecs > 0 || unknownSecs > 0) complete = false;
    days.push({
      date: formatDateUtc(dayStart),
      milli: hasValid ? milli : null,
      validSecs,
      anomalySecs,
      unknownSecs,
    });
    if (hasValid) totalMilli = (totalMilli ?? 0n) + milli;
  }

  return { device, days, totalMilli, complete };
}

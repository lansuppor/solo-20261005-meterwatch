// 可选的最大采样间隔限制:避免把长时间缺采当成可信能耗。
//
// 限制按完整已存时序中相邻读数的实际时间差判断,与查询范围、当地日界线、
// 分组成员切换都无关——区间不会因这些边界被裁短而"变回"可信:时间差是否
// 超过限制只由相邻读数时刻决定。等于限制仍可信(实际时间差 > 限制才超长)。
//
// 非下降区间超过限制时,整个区间视为未知,不分摊消耗;下降区间仍为异常,
// 即使它也超过限制(下降优先于过长)。首条读数之前、末条之后及孤立读数
// 时段仍为未知,不外推。省略限制(undefined)表示无上限,沿用原计算口径。

import { formatIsoUtc } from './time.ts';

/** 解析正整数秒数的限制参数;非正整数、非数字形式返回 null。 */
export function parseMaxGapSeconds(input: string): number | null {
  if (!/^\d+$/.test(input)) return null;
  const n = Number(input);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

/** 一次过长间隔(相邻读数实际时间差超过限制)的来源信息,用于结果展示。 */
export interface GapInterval {
  /** 相邻读数中的前一条时刻,epoch 秒。 */
  prevTs: number;
  /** 相邻读数中的后一条时刻,epoch 秒。 */
  nextTs: number;
  /** 两条相邻读数的实际时间差,秒(完整时序口径,不被任何边界裁短)。 */
  duration: number;
}

/** 限制的展示形式:无上限时为 none,否则为 <n>s。 */
export function formatLimit(maxGapSeconds: number | undefined): string {
  return maxGapSeconds === undefined ? 'none' : `${maxGapSeconds}s`;
}

/** 过长间隔的原始相邻读数时刻展示:<前时刻>..<后时刻> (<实际秒数>s)。 */
export function formatGapInterval(gap: GapInterval): string {
  return `${formatIsoUtc(gap.prevTs)}..${formatIsoUtc(gap.nextTs)} (${gap.duration}s)`;
}

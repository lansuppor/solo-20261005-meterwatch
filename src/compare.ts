// group compare 子命令:同一分组两个等长时段(参考期与比较期)的只读能耗
// 对比报表,用于核查用能变化,避免缺采被误读为节能。
//
// - 两期各自给出起止时刻(秒精度、显式偏移 ISO8601,起点含、终点不含且
//   起点更早),两期实际秒数必须相等;两期可重叠或相同。按距各自起点的
//   实际经过秒数一一对齐,不按当地钟表或自然日配对。
// - 各侧独立使用当时生效的成员版本与完整已存读数时序,成员不同仍可比较,
//   并分别显示各自成员与生效时段。首版生效前、读数首末之外与孤立读数为
//   未知;任一成员下降优先为异常,否则任一成员未知则未知,全部成员可信
//   才有效。可选 --max-interval(正整数秒,省略无上限,只影响本次查询,
//   不持久化)同一限制用于两侧:非下降相邻区间的实际时间差超过限制即整段
//   未知,等于限制仍可信,不因裁切或配对变短而可信;下降区间即使超过限制
//   仍为异常。
// - 成员有效片段取原读数区间起点累计比例向下取整的两端差,成员切换与对齐
//   边界不重置分摊起点;BigInt 精确计算,kWh 固定三位小数。
// - 仅两侧同时有效的对齐片段计入可比能耗;其余片段任一侧异常归为异常排除,
//   否则归为未知排除。共同可比、异常排除、未知排除秒数之和等于一期时长,
//   不叠加两侧秒数。共同可比少于全长标 INCOMPLETE,不以零填缺失、不外推。
// - 汇总同一可比集合上的两侧估算消耗与比较期减参考期的有符号差值;两侧全
//   有效时各侧消耗与对应范围、同限制的分组日报汇总一致。可比覆盖为零时
//   两侧及差值明确无法计算,有效零增长显示 0.000。把两期在相同经过秒数处
//   分段查询再相加,覆盖、消耗与差值与完整查询一致。
// - 只读:启动恢复协调由入口统一完成,本报表不改业务存储、不自动评估;
//   修正、撤销或补录成员后重查使用当前数据,旧告警状态与事件消耗保留。
//   成功(含不可计算结果)返回 0;非法参数或两期不等长返回 2;未知分组、
//   所用存储损坏或不可读、全库重复读数身份返回 1,指出原因且不输出部分
//   报表。

import { dataFilePath, groupFilePath, loadStore, StoreError, type Reading } from './store.ts';
import { formatIsoUtc } from './time.ts';
import { formatKwh } from './value.ts';
import { maxIntervalText, mergeGaps, type GapDetail } from './report.ts';
import {
  deviceSlice,
  loadCheckedSeriesByDevice,
  loadGroups,
  type Group,
  type GroupPeriod,
  type GroupVersion,
} from './groups.ts';

function err(message: string): void {
  console.error(`meterwatch: ${message}`);
}

type SideState = 'valid' | 'anomaly' | 'unknown';

/** 一侧在一个对齐片段上的求值结果。 */
interface SideEval {
  state: SideState;
  /** state 为 valid 时全体生效成员的分摊消耗之和,毫千瓦时。 */
  consumption: bigint;
  /** state 为 unknown 且由成员过长区间造成时的明细(设备与原始相邻读数时刻)。 */
  gaps: GapDetail[];
}

/**
 * 一侧在 [s, e) 上的状态与消耗。调用方保证 (s, e) 内没有版本生效时刻、
 * 也没有当时生效成员的读数时刻,故每个成员的状态在片段内恒定。口径与
 * 分组日报相同:任一成员下降优先为异常,否则任一成员未知为未知,全部
 * 可信才有效并累加成员消耗。
 */
function evalSideInterval(
  versions: GroupVersion[],
  seriesByDevice: Map<string, Reading[]>,
  s: number,
  e: number,
  maxInterval?: number,
): SideEval {
  let idx = -1;
  for (let i = 0; i < versions.length; i++) {
    if (versions[i].at <= s) idx = i;
    else break;
  }
  if (idx < 0) return { state: 'unknown', consumption: 0n, gaps: [] };
  let anyAnomaly = false;
  let anyUnknown = false;
  let consumption = 0n;
  const gaps: GapDetail[] = [];
  for (const m of versions[idx].members) {
    const res = deviceSlice(seriesByDevice.get(m) ?? [], s, e, maxInterval);
    if (res.kind === 'anomaly') {
      anyAnomaly = true;
    } else if (res.kind === 'unknown') {
      anyUnknown = true;
      if (res.gap) gaps.push({ device: m, start: res.gap.start, end: res.gap.end });
    } else {
      consumption += res.consumption;
    }
  }
  if (anyAnomaly) return { state: 'anomaly', consumption: 0n, gaps: [] };
  if (anyUnknown) return { state: 'unknown', consumption: 0n, gaps };
  return { state: 'valid', consumption, gaps: [] };
}

/**
 * 一侧在 [start, end) 内的切点(距起点的经过秒数,不含 0 与时长):
 * 期间版本生效时刻,以及期间生效版本全部成员的读数时刻。
 */
function sideCutOffsets(
  versions: GroupVersion[],
  seriesByDevice: Map<string, Reading[]>,
  start: number,
  end: number,
): Set<number> {
  const cuts = new Set<number>();
  const members = new Set<string>();
  let idx = -1;
  for (let i = 0; i < versions.length; i++) {
    if (versions[i].at <= start) idx = i;
    else break;
  }
  if (idx >= 0) for (const m of versions[idx].members) members.add(m);
  for (let i = idx + 1; i < versions.length; i++) {
    if (versions[i].at >= end) break;
    cuts.add(versions[i].at - start);
    for (const m of versions[i].members) members.add(m);
  }
  for (const m of members) {
    for (const r of seriesByDevice.get(m) ?? []) {
      if (r.ts > start && r.ts < end) cuts.add(r.ts - start);
    }
  }
  return cuts;
}

/** 一侧的成员时段(按生效时刻切分;首个版本生效前 members 为 null),用于展示。 */
function sideMemberPeriods(versions: GroupVersion[], start: number, end: number): GroupPeriod[] {
  const periods: GroupPeriod[] = [];
  let idx = -1;
  for (let i = 0; i < versions.length; i++) {
    if (versions[i].at <= start) idx = i;
    else break;
  }
  let cursor = start;
  while (cursor < end) {
    const nextAt = idx + 1 < versions.length ? versions[idx + 1].at : Number.POSITIVE_INFINITY;
    const pEnd = Math.min(end, nextAt);
    periods.push({ start: cursor, end: pEnd, members: idx >= 0 ? versions[idx].members : null });
    cursor = pEnd;
    idx++;
  }
  return periods;
}

/** 有符号毫千瓦时格式:正数带 '+' 号,零不带符号(0.000)。 */
function formatSignedKwh(milli: bigint): string {
  if (milli > 0n) return `+${formatKwh(milli)}`;
  return formatKwh(milli);
}

interface SideTotals {
  valid: number;
  anomaly: number;
  unknown: number;
  /** unknown 中由成员过长区间造成的秒数:只在最终未知片段内按实际时间计并集。 */
  gapUnknown: number;
  /** 与统计范围相交的成员过长区间明细(设备与原始相邻读数时刻),已去重。 */
  gaps: GapDetail[];
}

type PairClass = 'comparable' | 'excluded-anomaly' | 'excluded-unknown';

interface Pair {
  /** 距各自期起点的经过秒数区间 [o1, o2)。 */
  o1: number;
  o2: number;
  cls: PairClass;
  /** 排除原因涉及的侧('reference'/'comparison','+ ' 连接);可比时为空。 */
  sidesLabel: string;
}

/**
 * 同一分组两个等长时段的只读能耗对比报表。返回进程退出码。
 * 先完成全部求值再输出:任何数据错误都不会产生部分报表。
 */
export function cmdGroupCompare(opts: {
  id: string;
  /** 参考期 [refFrom, refTo),epoch 秒,起点含、终点不含。 */
  refFrom: number;
  refTo: number;
  /** 比较期 [cmpFrom, cmpTo),epoch 秒,与参考期实际秒数相等(入口已校验)。 */
  cmpFrom: number;
  cmpTo: number;
  /** 最大采样间隔限制(正整数秒);省略表示无上限。只影响本次查询结果。 */
  maxInterval?: number;
}): number {
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

  const duration = opts.refTo - opts.refFrom;
  // 全局对齐切点:两侧各自切点(版本生效时刻与成员读数时刻,按经过秒数)
  // 的并集,保证每个对齐片段在两侧内部状态都恒定;对齐边界不重置各设备
  // 原读数区间的分摊起点,故相同经过秒数处分段查询再相加与完整查询一致。
  const offsets = new Set<number>([0, duration]);
  for (const o of sideCutOffsets(group.versions, seriesByDevice, opts.refFrom, opts.refTo)) {
    offsets.add(o);
  }
  for (const o of sideCutOffsets(group.versions, seriesByDevice, opts.cmpFrom, opts.cmpTo)) {
    offsets.add(o);
  }
  const sorted = [...offsets].sort((a, b) => a - b);

  const sides: { ref: SideTotals; cmp: SideTotals } = {
    ref: { valid: 0, anomaly: 0, unknown: 0, gapUnknown: 0, gaps: [] },
    cmp: { valid: 0, anomaly: 0, unknown: 0, gapUnknown: 0, gaps: [] },
  };
  let comparable = 0;
  let anomalyExcluded = 0;
  let unknownExcluded = 0;
  let refConsumption = 0n;
  let cmpConsumption = 0n;
  const pairs: Pair[] = [];

  for (let k = 0; k + 1 < sorted.length; k++) {
    const o1 = sorted[k];
    const o2 = sorted[k + 1];
    const len = o2 - o1;
    const refEval = evalSideInterval(
      group.versions, seriesByDevice, opts.refFrom + o1, opts.refFrom + o2, opts.maxInterval,
    );
    const cmpEval = evalSideInterval(
      group.versions, seriesByDevice, opts.cmpFrom + o1, opts.cmpFrom + o2, opts.maxInterval,
    );
    for (const [key, ev] of [['ref', refEval], ['cmp', cmpEval]] as const) {
      const t = sides[key];
      if (ev.state === 'valid') {
        t.valid += len;
      } else if (ev.state === 'anomaly') {
        t.anomaly += len;
      } else {
        t.unknown += len;
        // 过长间隔未知只在最终未知片段内按实际时间计并集,不叠加成员秒数。
        if (ev.gaps.length > 0) {
          t.gapUnknown += len;
          mergeGaps(t.gaps, ev.gaps);
        }
      }
    }
    if (refEval.state === 'valid' && cmpEval.state === 'valid') {
      comparable += len;
      refConsumption += refEval.consumption;
      cmpConsumption += cmpEval.consumption;
      pairs.push({ o1, o2, cls: 'comparable', sidesLabel: '' });
    } else if (refEval.state === 'anomaly' || cmpEval.state === 'anomaly') {
      anomalyExcluded += len;
      const bad: string[] = [];
      if (refEval.state === 'anomaly') bad.push('reference');
      if (cmpEval.state === 'anomaly') bad.push('comparison');
      pairs.push({ o1, o2, cls: 'excluded-anomaly', sidesLabel: bad.join('+') });
    } else {
      unknownExcluded += len;
      const bad: string[] = [];
      if (refEval.state === 'unknown') bad.push('reference');
      if (cmpEval.state === 'unknown') bad.push('comparison');
      pairs.push({ o1, o2, cls: 'excluded-unknown', sidesLabel: bad.join('+') });
    }
  }

  console.log(`group: ${group.id}`);
  console.log(`max-interval: ${maxIntervalText(opts.maxInterval)}`);
  console.log(`reference: ${formatIsoUtc(opts.refFrom)}..${formatIsoUtc(opts.refTo)}`);
  console.log(`comparison: ${formatIsoUtc(opts.cmpFrom)}..${formatIsoUtc(opts.cmpTo)}`);
  console.log(`duration: ${duration}s (aligned by elapsed seconds from each period start)`);

  const printSide = (label: 'reference' | 'comparison', key: 'ref' | 'cmp', start: number, end: number): void => {
    const t = sides[key];
    let line = `side=${label}  valid=${t.valid}s  anomaly=${t.anomaly}s  unknown=${t.unknown}s`;
    if (opts.maxInterval !== undefined) line += `  gap=${t.gapUnknown}s`;
    console.log(line);
    for (const p of sideMemberPeriods(group.versions, start, end)) {
      const members = p.members === null ? '(no version in effect)' : p.members.join(',');
      console.log(`  members=${members}  period=${formatIsoUtc(p.start)}..${formatIsoUtc(p.end)}`);
    }
    for (const g of t.gaps) {
      console.log(
        `  gap: side=${label}  device=${g.device ?? '?'}  ` +
          `interval=${formatIsoUtc(g.start)}..${formatIsoUtc(g.end)}`,
      );
    }
  };
  printSide('reference', 'ref', opts.refFrom, opts.refTo);
  printSide('comparison', 'cmp', opts.cmpFrom, opts.cmpTo);

  // 成对 UTC 时段:相邻且分类与排除原因相同的片段合并显示。
  const merged: Pair[] = [];
  for (const p of pairs) {
    const last = merged[merged.length - 1];
    if (last && last.cls === p.cls && last.sidesLabel === p.sidesLabel && last.o2 === p.o1) {
      last.o2 = p.o2;
    } else {
      merged.push({ ...p });
    }
  }
  console.log('pairs (aligned by elapsed seconds):');
  for (const p of merged) {
    const refRange = `${formatIsoUtc(opts.refFrom + p.o1)}..${formatIsoUtc(opts.refFrom + p.o2)}`;
    const cmpRange = `${formatIsoUtc(opts.cmpFrom + p.o1)}..${formatIsoUtc(opts.cmpFrom + p.o2)}`;
    const reason = p.cls === 'comparable' ? '' : `  sides=${p.sidesLabel}`;
    console.log(`  pair ref=${refRange}  cmp=${cmpRange}  class=${p.cls}${reason}`);
  }

  const incomplete = comparable < duration;
  let coverageLine =
    `comparable=${comparable}s  anomaly-excluded=${anomalyExcluded}s  ` +
    `unknown-excluded=${unknownExcluded}s`;
  if (incomplete) coverageLine += '  INCOMPLETE';
  console.log(coverageLine);

  if (comparable > 0) {
    console.log(`reference consumption=${formatKwh(refConsumption)} kWh (estimate, comparable coverage)`);
    console.log(`comparison consumption=${formatKwh(cmpConsumption)} kWh (estimate, comparable coverage)`);
    console.log(`difference=${formatSignedKwh(cmpConsumption - refConsumption)} kWh (comparison - reference)`);
  } else {
    console.log('reference consumption=n/a (no comparable coverage)');
    console.log('comparison consumption=n/a (no comparable coverage)');
    console.log('difference=n/a (no comparable coverage)');
  }
  const status = incomplete
    ? 'status=INCOMPLETE (comparable coverage less than full duration)'
    : 'status=complete';
  console.log(
    `  summary: group=${group.id}  duration=${duration}s  comparable=${comparable}s` +
      `  anomaly-excluded=${anomalyExcluded}s  unknown-excluded=${unknownExcluded}s  ${status}`,
  );
  return 0;
}

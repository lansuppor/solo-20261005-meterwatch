// group compare 子命令:同一分组两个等长时段的只读能耗对比报表。
//
// 用途:核查用能变化,避免把缺采(未知覆盖)误读为节能——只有两侧同时
// 有效的对齐片段才计入可比能耗,其余片段按异常排除或未知排除单列,绝不
// 以零填缺失、不外推。
//
// 对比口径:
// - 输入已有分组及参考期、比较期各自的 [起点含, 终点不含),均为秒精度、
//   显式偏移的真实 ISO8601;两期实际秒数必须相等(由入口校验,不等长返回
//   2),两期可重叠或完全相同。
// - 对齐按距各自起点的实际经过秒数一一对应,不按当地钟表或自然日配对;
//   故夏令时、不同 UTC 偏移都不影响配对。
// - 各侧独立使用当时生效的成员版本与各自的完整读数时序:两期成员不同仍可
//   比较,报表分别显示两侧成员与生效时段;成员切换与对齐边界都不重置各
//   设备原读数区间的分摊起点。
// - 单侧状态沿用分组日报口径:首个版本生效前、读数首末之外与孤立读数为
//   未知;任一成员下降优先为异常,否则任一成员未知为未知,全部可信才有效。
//   非下降相邻区间超过 --max-interval 时整段未知(等于限制仍可信),按原始
//   相邻区间判定,不因裁切或配对变短而可信。BigInt 精确计算,kWh 固定三位。
// - 联合分类:仅双方同时有效的对齐片段为可比;其余片段任一侧异常即归异常
//   排除,否则归未知排除。可比、异常排除、未知排除秒数之和等于一期时长,
//   不叠加两侧秒数。
// - 汇总在同一可比集合上估算两侧消耗及比较期减参考期的有符号差值;可比
//   覆盖为零时两侧与差值均明确无法计算,有效零增长显示 0.000。共同可比少于
//   全长时标 INCOMPLETE。两侧全有效时,各侧消耗与对应范围、同限制的分组
//   日报汇总一致;把两期在相同经过秒数处分段查询后,覆盖、消耗与差值分别
//   相加与完整查询一致(分摊起点不被对齐边界重置)。
// - 只读:报表查询不改业务存储、不自动评估;修正、撤销或补录成员后重查
//   使用当前数据,旧告警状态与事件消耗保留。同一 --max-interval 限制用于
//   两侧且不持久化。成功(含不可计算结果)返回 0;非法参数或两期不等长
//   返回 2;未知分组、所用存储损坏或不可读、全库重复读数身份返回 1,指出
//   原因且不输出部分报表。

import { dataFilePath, groupFilePath, loadStore, StoreError, type Reading } from './store.ts';
import { formatIsoUtc } from './time.ts';
import { formatKwh } from './value.ts';
import { formatGapLine, maxIntervalText, mergeGaps, type GapDetail } from './report.ts';
import {
  groupStateTimeline,
  loadCheckedSeriesByDevice,
  loadGroups,
  type GroupStateSlice,
} from './groups.ts';

function err(message: string): void {
  console.error(`meterwatch: ${message}`);
}

type SideKind = 'reference' | 'compare';

interface AlignedCell {
  /** 距各侧起点的经过秒数区间 [oStart, oEnd),两侧共用。 */
  oStart: number;
  oEnd: number;
  ref: GroupStateSlice;
  cmp: GroupStateSlice;
}

type JointKind = 'comparable' | 'anomaly-excluded' | 'unknown-excluded';

/** 合并相邻、成员集合相同的切片为成员生效时段(用于显示)。 */
function memberRuns(
  slices: GroupStateSlice[],
): Array<{ members: string[] | null; start: number; end: number }> {
  const runs: Array<{ members: string[] | null; start: number; end: number }> = [];
  for (const sl of slices) {
    const last = runs[runs.length - 1];
    const same =
      last !== undefined &&
      ((last.members === null && sl.members === null) ||
        (last.members !== null &&
          sl.members !== null &&
          last.members.length === sl.members.length &&
          last.members.every((m, i) => m === sl.members![i])));
    if (same && last.end === sl.start) last.end = sl.end;
    else runs.push({ members: sl.members, start: sl.start, end: sl.end });
  }
  return runs;
}

/** 有符号毫千瓦时差值的固定三位小数显示(零增长显示 0.000,正数带 +)。 */
function formatSignedKwh(milli: bigint): string {
  if (milli === 0n) return '0.000';
  if (milli > 0n) return `+${formatKwh(milli)}`;
  return formatKwh(milli);
}

/**
 * 分组两期能耗对比报表。两期等长与各自起点早于终点由入口(返回 2)保证。
 * 只读,不写入数据。返回进程退出码。
 */
export function cmdGroupCompare(opts: {
  id: string;
  referenceFrom: number;
  referenceTo: number;
  compareFrom: number;
  compareTo: number;
  /** 最大采样间隔限制(正整数秒);省略表示无上限。同一限制用于两侧,只影响本次查询。 */
  maxInterval?: number;
}): number {
  let groups;
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

  const duration = opts.referenceTo - opts.referenceFrom;

  // 先各取一次最细时间线,收集两侧全部状态边界的经过秒数(含成员切换与
  // 读数时刻),作为统一对齐切点;再用并集切点重切两侧,使每个对齐单元在
  // 两侧都状态恒定。附加切点不改变单侧口径(分摊起点不重置)。
  const refBase = groupStateTimeline(
    group.versions,
    seriesByDevice,
    opts.referenceFrom,
    opts.referenceTo,
    opts.maxInterval,
  );
  const cmpBase = groupStateTimeline(
    group.versions,
    seriesByDevice,
    opts.compareFrom,
    opts.compareTo,
    opts.maxInterval,
  );
  const offsets = new Set<number>([0, duration]);
  for (const sl of refBase) offsets.add(sl.start - opts.referenceFrom);
  for (const sl of cmpBase) offsets.add(sl.start - opts.compareFrom);
  const cuts = [...offsets].sort((a, b) => a - b);

  const refCutsAbs = cuts.map((o) => opts.referenceFrom + o);
  const cmpCutsAbs = cuts.map((o) => opts.compareFrom + o);
  const refSlices = groupStateTimeline(
    group.versions,
    seriesByDevice,
    opts.referenceFrom,
    opts.referenceTo,
    opts.maxInterval,
    refCutsAbs,
  );
  const cmpSlices = groupStateTimeline(
    group.versions,
    seriesByDevice,
    opts.compareFrom,
    opts.compareTo,
    opts.maxInterval,
    cmpCutsAbs,
  );

  // 每个切点段在两侧各落在唯一一个切片内(并集切点保证不穿越状态边界)。
  const cells: AlignedCell[] = [];
  let ri = 0;
  let ci = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const oStart = cuts[i];
    const oEnd = cuts[i + 1];
    const refAbs = opts.referenceFrom + oStart;
    const cmpAbs = opts.compareFrom + oStart;
    while (ri < refSlices.length && refSlices[ri].end <= refAbs) ri++;
    while (ci < cmpSlices.length && cmpSlices[ci].end <= cmpAbs) ci++;
    cells.push({ oStart, oEnd, ref: refSlices[ri], cmp: cmpSlices[ci] });
  }

  const jointOf = (cell: AlignedCell): JointKind => {
    if (cell.ref.kind === 'valid' && cell.cmp.kind === 'valid') return 'comparable';
    if (cell.ref.kind === 'anomaly' || cell.cmp.kind === 'anomaly') return 'anomaly-excluded';
    return 'unknown-excluded';
  };

  let comparableSecs = 0;
  let anomalyExcludedSecs = 0;
  let unknownExcludedSecs = 0;
  let refValid = 0;
  let refAnomaly = 0;
  let refUnknown = 0;
  let cmpValid = 0;
  let cmpAnomaly = 0;
  let cmpUnknown = 0;
  let refGapSecs = 0;
  let cmpGapSecs = 0;
  const refGaps: GapDetail[] = [];
  const cmpGaps: GapDetail[] = [];
  let refConsumption = 0n;
  let cmpConsumption = 0n;

  for (const cell of cells) {
    const secs = cell.oEnd - cell.oStart;
    if (cell.ref.kind === 'valid') refValid += secs;
    else if (cell.ref.kind === 'anomaly') refAnomaly += secs;
    else {
      refUnknown += secs;
      if (cell.ref.gaps.length > 0) {
        refGapSecs += secs;
        mergeGaps(refGaps, cell.ref.gaps);
      }
    }
    if (cell.cmp.kind === 'valid') cmpValid += secs;
    else if (cell.cmp.kind === 'anomaly') cmpAnomaly += secs;
    else {
      cmpUnknown += secs;
      if (cell.cmp.gaps.length > 0) {
        cmpGapSecs += secs;
        mergeGaps(cmpGaps, cell.cmp.gaps);
      }
    }
    const joint = jointOf(cell);
    if (joint === 'comparable') {
      comparableSecs += secs;
      refConsumption += cell.ref.consumption;
      cmpConsumption += cell.cmp.consumption;
    } else if (joint === 'anomaly-excluded') {
      anomalyExcludedSecs += secs;
    } else {
      unknownExcludedSecs += secs;
    }
  }

  const incomplete = comparableSecs < duration;

  // ---- 输出(数据加载与计算全部成功后才开始输出,不产生部分报表) ----
  console.log(`group: ${group.id}`);
  console.log(`max-interval: ${maxIntervalText(opts.maxInterval)}`);
  console.log(
    `reference-period: ${formatIsoUtc(opts.referenceFrom)}..${formatIsoUtc(opts.referenceTo)}`,
  );
  for (const run of memberRuns(refSlices)) {
    const members = run.members === null ? '(no version in effect)' : run.members.join(',');
    console.log(
      `  members=${members}  period=${formatIsoUtc(run.start)}..${formatIsoUtc(run.end)}`,
    );
  }
  console.log(
    `compare-period:   ${formatIsoUtc(opts.compareFrom)}..${formatIsoUtc(opts.compareTo)}`,
  );
  for (const run of memberRuns(cmpSlices)) {
    const members = run.members === null ? '(no version in effect)' : run.members.join(',');
    console.log(
      `  members=${members}  period=${formatIsoUtc(run.start)}..${formatIsoUtc(run.end)}`,
    );
  }
  console.log(`duration: ${duration}s (aligned by elapsed seconds from each period's own start)`);

  // 相邻、联合分类相同的对齐单元合并显示;排除原因在该时段下汇总去重。
  console.log('aligned segments:');
  let runStart = 0;
  let runKind: JointKind | null = null;
  const flushRun = (runEnd: number): void => {
    if (runKind === null) return;
    const runCells = cells.filter((c) => c.oStart >= runStart && c.oEnd <= runEnd);
    const secs = runEnd - runStart;
    const jointText =
      runKind === 'comparable'
        ? 'comparable'
        : runKind === 'anomaly-excluded'
          ? 'excluded:anomaly'
          : 'excluded:unknown';
    console.log(
      `  elapsed=${runStart}..${runEnd} (${secs}s)  ${jointText}` +
        `  reference=${formatIsoUtc(opts.referenceFrom + runStart)}..` +
        `${formatIsoUtc(opts.referenceFrom + runEnd)}` +
        `  compare=${formatIsoUtc(opts.compareFrom + runStart)}..` +
        `${formatIsoUtc(opts.compareFrom + runEnd)}`,
    );
    if (runKind !== 'comparable') {
      const anomalySides = new Set<SideKind>();
      const nonGapUnknown = new Map<SideKind, GroupStateSlice>();
      const gapKeys = new Set<string>();
      const gapReasons: Array<{ side: SideKind; gap: GapDetail }> = [];
      for (const cell of runCells) {
        const sides: Array<{ name: SideKind; sl: GroupStateSlice }> = [
          { name: 'reference', sl: cell.ref },
          { name: 'compare', sl: cell.cmp },
        ];
        for (const { name, sl } of sides) {
          if (sl.kind === 'anomaly') anomalySides.add(name);
          else if (sl.kind === 'unknown') {
            if (sl.gaps.length > 0) {
              for (const g of sl.gaps) {
                const key = `${name} ${g.device ?? ''} ${g.start} ${g.end}`;
                if (!gapKeys.has(key)) {
                  gapKeys.add(key);
                  gapReasons.push({ side: name, gap: g });
                }
              }
            } else if (!nonGapUnknown.has(name)) {
              nonGapUnknown.set(name, sl);
            }
          }
        }
      }
      for (const name of anomalySides) {
        console.log(`    anomaly: side=${name} (a member reading decreased in a stored interval)`);
      }
      for (const [name, sl] of nonGapUnknown) {
        console.log(`    unknown: side=${name} (${unknownReason(sl)})`);
      }
      for (const { side, gap } of gapReasons) {
        console.log(`    unknown: side=${side}  ${formatGapLine(gap).trimStart()}`);
      }
    }
    runKind = null;
  };
  for (const cell of cells) {
    const joint = jointOf(cell);
    if (runKind === null) {
      runStart = cell.oStart;
      runKind = joint;
    } else if (joint !== runKind) {
      flushRun(cell.oStart);
      runStart = cell.oStart;
      runKind = joint;
    }
  }
  flushRun(duration);

  const gapSuffix = (sideSecs: number): string =>
    opts.maxInterval !== undefined ? `  gap=${sideSecs}s` : '';
  console.log(
    `reference-side coverage: valid=${refValid}s  anomaly=${refAnomaly}s  unknown=${refUnknown}s` +
      gapSuffix(refGapSecs),
  );
  for (const g of refGaps) console.log(`  side=reference  ${formatGapLine(g).trimStart()}`);
  console.log(
    `compare-side coverage:   valid=${cmpValid}s  anomaly=${cmpAnomaly}s  unknown=${cmpUnknown}s` +
      gapSuffix(cmpGapSecs),
  );
  for (const g of cmpGaps) console.log(`  side=compare    ${formatGapLine(g).trimStart()}`);

  console.log(
    `summary: duration=${duration}s  comparable=${comparableSecs}s` +
      `  anomaly-excluded=${anomalyExcludedSecs}s  unknown-excluded=${unknownExcludedSecs}s`,
  );
  if (comparableSecs > 0) {
    const difference = cmpConsumption - refConsumption;
    console.log(
      `  reference consumption=${formatKwh(refConsumption)} kWh (estimate)` +
        ` over ${comparableSecs} comparable second(s)`,
    );
    console.log(
      `  compare consumption=${formatKwh(cmpConsumption)} kWh (estimate)` +
        ` over ${comparableSecs} comparable second(s)`,
    );
    console.log(
      `  difference (compare - reference)=${formatSignedKwh(difference)} kWh (estimate)`,
    );
  } else {
    console.log('  reference consumption=n/a (not computable: no comparable coverage)');
    console.log('  compare consumption=n/a (not computable: no comparable coverage)');
    console.log('  difference (compare - reference)=n/a (not computable: no comparable coverage)');
  }
  console.log(
    incomplete
      ? 'status=INCOMPLETE (comparable coverage is shorter than the full period; exclusions are not counted as zero)'
      : 'status=complete',
  );
  return 0;
}

/** 单侧未知的非 gap 原因说明。 */
function unknownReason(sl: GroupStateSlice): string {
  if (sl.members === null) return 'no member version in effect before the first version';
  if (sl.gaps.length > 0) return 'member sampling interval exceeded the limit';
  return 'outside stored reading range or isolated reading (no extrapolation)';
}

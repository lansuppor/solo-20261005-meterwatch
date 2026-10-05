// group 子命令:分组成员版本配置、成员历史查询与分组能耗日报。
//
// - 分组以首次配置建立,标识非空唯一(去首尾空白、区分大小写);每次配置指定
//   生效时刻(含)与一整套已有设备,从该时刻起生效直到下一版本接替;允许乱序
//   补录历史版本。成员不能为空,同设备重复列出只算一次,成员顺序不影响等价性,
//   设备可属于多个分组。同组同一实际生效时刻、同成员集合重试成功且不新增,
//   异成员集合报冲突。
// - 配置整次成功或不提交:未知设备、冲突、损坏或不可读存储及写入失败都明确
//   报错并保留操作前状态。配置不改读数、规则和告警,导入也不改配置。
// - 日报按 UTC 自然日切分(起点含、终点不含,首尾只统计重叠部分),按当时生效
//   成员计算,不把最新成员套用到历史;首个版本生效前记为未知。各设备使用完整
//   已存时序,区间两端读数即使在查询范围外也参与;成员切换不需要恰好有读数,
//   首条读数之前、末条之后及孤立读数时段为未知,不外推。
// - 每个时段只有全部生效成员均处于非下降读数区间时才是有效覆盖,并计入成员
//   消耗之和;任一成员下降则为异常覆盖,否则任一成员未知则为未知覆盖。异常与
//   未知时段不计任何成员消耗,不以缺失设备为零补齐。覆盖秒数按分组实际时间
//   计算,不累加成员秒数。各设备片段仍以原读数区间起点累计比例向下取整,
//   两端累计量之差为消耗;日界线、查询边界与成员切换均不重置分摊起点,
//   拆开查询相加结果一致。全程 BigInt 精确计算,kWh 固定三位小数。
// - 日报与历史只读;读取读数时拒绝同设备同一实际时刻的多条存储记录。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataFilePath, groupFilePath, loadStore, StoreError, type Reading } from './store.ts';
import { DAY_SECONDS } from './report.ts';
import { formatIsoUtc } from './time.ts';
import { formatKwh } from './value.ts';

export interface GroupVersion {
  /** 生效时刻(含),epoch 秒。 */
  at: number;
  /** 成员设备标识,已去重并按字典序排序(规范形,成员顺序不影响等价性)。 */
  members: string[];
}

export interface Group {
  /** 分组标识(非空、唯一,已去首尾空白,区分大小写)。 */
  id: string;
  /** 成员版本,按生效时刻升序。 */
  versions: GroupVersion[];
}

function err(message: string): void {
  console.error(`meterwatch: ${message}`);
}

/** 读取分组存储;文件不存在返回空数组,存在但无法读取或内容损坏抛出 StoreError。 */
function loadGroups(path: string): Group[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new StoreError(`cannot read storage file ${path}: ${(e as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StoreError(`storage file ${path} is corrupted (invalid JSON)`);
  }
  const bad = (what: string): StoreError =>
    new StoreError(`storage file ${path} is corrupted (${what})`);
  const o = data as Record<string, unknown>;
  if (o === null || typeof o !== 'object') throw bad('not an object');
  if (!Array.isArray(o.groups)) throw bad('missing groups array');

  const ids = new Set<string>();
  const groups: Group[] = [];
  for (const g of o.groups as Array<Record<string, unknown>>) {
    const ok =
      g !== null &&
      typeof g === 'object' &&
      typeof g.id === 'string' &&
      g.id.length > 0 &&
      Array.isArray(g.versions) &&
      g.versions.length > 0;
    if (!ok) throw bad('invalid group entry');
    if (ids.has(g.id as string)) throw bad(`duplicate group id '${g.id}'`);
    ids.add(g.id as string);

    const versions: GroupVersion[] = [];
    const seenAts = new Set<number>();
    for (const v of g.versions as Array<Record<string, unknown>>) {
      const vok =
        v !== null &&
        typeof v === 'object' &&
        Number.isSafeInteger(v.at) &&
        Array.isArray(v.members) &&
        v.members.length > 0 &&
        (v.members as unknown[]).every((m) => typeof m === 'string' && (m as string).length > 0);
      if (!vok) throw bad(`invalid version entry in group '${g.id}'`);
      const at = v.at as number;
      if (seenAts.has(at)) throw bad(`duplicate version time in group '${g.id}'`);
      seenAts.add(at);
      const members = [...(v.members as string[])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (let i = 1; i < members.length; i++) {
        if (members[i] === members[i - 1]) {
          throw bad(`duplicate member '${members[i]}' in group '${g.id}'`);
        }
      }
      versions.push({ at, members });
    }
    versions.sort((a, b) => a.at - b.at);
    groups.push({ id: g.id as string, versions });
  }
  return groups;
}

/** 原子写入分组存储;失败抛错,原有数据保持不变。 */
function saveGroups(path: string, groups: Group[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const body = JSON.stringify({ version: 1, groups }, null, 2) + '\n';
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    throw new StoreError(`cannot write storage file ${path}: ${(e as Error).message}`);
  }
}

/**
 * 载入读数并取出指定设备的完整时序(按时刻排序)。
 * 同设备同一实际时刻存在多条存储记录时抛 StoreError。
 */
function deviceSeries(all: Reading[], device: string): Reading[] {
  const series = all.filter((r) => r.device === device).sort((a, b) => a.ts - b.ts);
  for (let i = 1; i < series.length; i++) {
    if (series[i].ts === series[i - 1].ts) {
      throw new StoreError(
        `storage error: multiple stored readings for device '${device}' at ${formatIsoUtc(series[i].ts)}`,
      );
    }
  }
  return series;
}

/** 在按时刻升序的时序中找最后一条 ts <= s 的下标,无则 -1。 */
function floorIndex(series: Reading[], s: number): number {
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].ts <= s) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

type SliceKind = 'valid' | 'anomaly' | 'unknown';

/**
 * 单设备在片段 [s, e) 上的状态与消耗。片段完全落在同一读数区间内
 * (调用方保证切点包含区间内全部读数时刻)。非下降区间以区间起点累计
 * 比例向下取整,消耗为两端累计量之差;下降区间为异常;首条读数之前、
 * 末条之后及孤立读数时段为未知,不外推。
 */
function deviceSlice(
  series: Reading[],
  s: number,
  e: number,
): { kind: SliceKind; consumption: bigint } {
  const i = floorIndex(series, s);
  if (i < 0 || i + 1 >= series.length) return { kind: 'unknown', consumption: 0n };
  const a = series[i];
  const b = series[i + 1];
  const diff = b.milli - a.milli;
  if (diff < 0n) return { kind: 'anomaly', consumption: 0n };
  const duration = BigInt(b.ts - a.ts);
  const cumulative = (t: number): bigint => (diff * BigInt(t - a.ts)) / duration;
  return { kind: 'valid', consumption: cumulative(e) - cumulative(s) };
}

export interface GroupPeriod {
  /** 时段起点(含),epoch 秒。 */
  start: number;
  /** 时段终点(不含),epoch 秒。 */
  end: number;
  /** 该时段生效成员;null 表示首个版本生效前(未知)。 */
  members: string[] | null;
}

export interface GroupSegmentStats {
  /** 有效(全部成员非下降)覆盖秒数,按分组实际时间计。 */
  valid: number;
  /** 异常(任一成员下降)覆盖秒数。 */
  anomaly: number;
  /** 未知(无生效版本或任一成员未知)覆盖秒数。 */
  unknown: number;
  /** 有效时段内全部生效成员的分摊消耗之和,毫千瓦时 BigInt。 */
  consumption: bigint;
  /** 段内按生效时刻切分的成员时段。 */
  periods: GroupPeriod[];
}

/**
 * 计算分组在 [segStart, segEnd) 上的覆盖与消耗。
 * versions 按生效时刻升序;seriesByDevice 含全部版本成员的完整时序。
 */
export function computeGroupSegment(
  versions: GroupVersion[],
  seriesByDevice: Map<string, Reading[]>,
  segStart: number,
  segEnd: number,
): GroupSegmentStats {
  // 按版本生效时刻把段切成成员恒定的时段;首个版本生效前 members 为 null。
  const periods: GroupPeriod[] = [];
  let idx = -1;
  for (let i = 0; i < versions.length; i++) {
    if (versions[i].at <= segStart) idx = i;
    else break;
  }
  let cursor = segStart;
  while (cursor < segEnd) {
    const nextAt = idx + 1 < versions.length ? versions[idx + 1].at : Number.POSITIVE_INFINITY;
    const pEnd = Math.min(segEnd, nextAt);
    periods.push({ start: cursor, end: pEnd, members: idx >= 0 ? versions[idx].members : null });
    cursor = pEnd;
    idx++;
  }

  let valid = 0;
  let anomaly = 0;
  let unknown = 0;
  let consumption = 0n;
  for (const p of periods) {
    if (p.members === null) {
      unknown += p.end - p.start;
      continue;
    }
    // 切点:时段边界与全部成员的读数时刻;相邻切点间每个成员的状态恒定。
    const bounds = new Set<number>([p.start, p.end]);
    for (const m of p.members) {
      for (const r of seriesByDevice.get(m) ?? []) {
        if (r.ts > p.start && r.ts < p.end) bounds.add(r.ts);
      }
    }
    const sorted = [...bounds].sort((a, b) => a - b);
    for (let k = 0; k + 1 < sorted.length; k++) {
      const s = sorted[k];
      const e = sorted[k + 1];
      let anyAnomaly = false;
      let anyUnknown = false;
      let slice = 0n;
      for (const m of p.members) {
        const res = deviceSlice(seriesByDevice.get(m) ?? [], s, e);
        if (res.kind === 'anomaly') anyAnomaly = true;
        else if (res.kind === 'unknown') anyUnknown = true;
        else slice += res.consumption;
      }
      if (anyAnomaly) {
        anomaly += e - s;
      } else if (anyUnknown) {
        unknown += e - s;
      } else {
        valid += e - s;
        consumption += slice;
      }
    }
  }
  return { valid, anomaly, unknown, consumption, periods };
}

/**
 * 配置分组成员版本。首次配置即建立分组;同组同一实际生效时刻、同成员集合
 * 重试成功且不新增,异成员集合报冲突。整次成功或不提交。返回进程退出码。
 */
export function cmdGroupConfigure(opts: { id: string; at: number; members: string[] }): number {
  const path = groupFilePath();
  let groups: Group[];
  try {
    groups = loadGroups(path);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  // 规范形:同设备重复列出只算一次,成员顺序不影响等价性。
  const members = [...new Set(opts.members)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  let known: Set<string>;
  try {
    known = new Set(loadStore(dataFilePath()).map((r) => r.device));
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  for (const m of members) {
    if (!known.has(m)) {
      err(`unknown device '${m}': no stored readings; import readings before configuring a group`);
      return 1;
    }
  }

  const existing = groups.find((g) => g.id === opts.id);
  if (existing) {
    const v = existing.versions.find((ver) => ver.at === opts.at);
    if (v) {
      const same =
        v.members.length === members.length && v.members.every((m, i) => m === members[i]);
      if (same) {
        console.log(
          `group '${opts.id}' already has an identical member version at ${formatIsoUtc(opts.at)}; unchanged`,
        );
        return 0;
      }
      err(
        `group '${opts.id}' already has a different member version at ${formatIsoUtc(opts.at)} ` +
          `(stored members=${v.members.join(',')}, got members=${members.join(',')}); conflict`,
      );
      return 1;
    }
    existing.versions.push({ at: opts.at, members });
    existing.versions.sort((a, b) => a.at - b.at);
  } else {
    groups.push({ id: opts.id, versions: [{ at: opts.at, members }] });
  }

  try {
    saveGroups(path, groups);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  console.log(
    `group '${opts.id}' configured: members=${members.join(',')} effective ${formatIsoUtc(opts.at)}`,
  );
  return 0;
}

/** 查看分组成员版本历史,按生效时刻排序。只读。返回进程退出码。 */
export function cmdGroupHistory(opts: { id: string }): number {
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
  console.log(`group: ${group.id}`);
  for (const v of group.versions) {
    console.log(`  ${formatIsoUtc(v.at)}  members=${v.members.join(',')}`);
  }
  return 0;
}

/**
 * 分组能耗日报:按 UTC 自然日切分,按当时生效成员计算。只读,不写入数据。
 * 返回进程退出码。
 */
export function cmdGroupDaily(opts: { id: string; from: number; to: number }): number {
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
    const all = loadStore(dataFilePath());
    seriesByDevice = new Map();
    for (const v of group.versions) {
      for (const m of v.members) {
        if (!seriesByDevice.has(m)) seriesByDevice.set(m, deviceSeries(all, m));
      }
    }
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  console.log(`group: ${group.id}`);
  let total = 0n;
  let computedDays = 0;
  let days = 0;
  let incomplete = false;
  for (
    let dayStart = Math.floor(opts.from / DAY_SECONDS) * DAY_SECONDS;
    dayStart < opts.to;
    dayStart += DAY_SECONDS
  ) {
    const segStart = Math.max(dayStart, opts.from);
    const segEnd = Math.min(dayStart + DAY_SECONDS, opts.to);
    const stats = computeGroupSegment(group.versions, seriesByDevice, segStart, segEnd);
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
    for (const p of stats.periods) {
      const members = p.members === null ? '(no version in effect)' : p.members.join(',');
      console.log(
        `    members=${members}  period=${formatIsoUtc(p.start)}..${formatIsoUtc(p.end)}`,
      );
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
    `  summary: group=${group.id}  computed=${computedDays}/${days} day(s)  ${totalText}  ${status}`,
  );
  return 0;
}

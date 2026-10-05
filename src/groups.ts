// group 子命令:分组成员版本配置、成员历史查看与分组能耗日报。
//
// - 分组以首次配置建立,标识非空唯一(去首尾空白、区分大小写)。每次配置
//   指定生效时刻(秒精度、显式时区的真实 ISO8601)与一整套已有设备,从该
//   时刻(含)起生效,直到下一版本接替;允许乱序补录历史版本。成员不能为
//   空,同设备重复列出只算一次,成员顺序不影响等价性,设备可属于多个分组。
// - 同组同一实际生效时刻、同成员集合重试成功且不新增版本;异成员集合报冲突。
// - 分组与版本存于数据目录的 groups.json(与 readings.json、alerts.json
//   相互独立;配置不改读数、规则和告警,导入也不改配置)。写入先完成全部
//   校验再一次性原子提交,任何失败保留操作前状态;损坏或不可读存储明确
//   报错,绝不当作空库。
// - 日报只读:按 UTC 自然日切分(起点含、终点不含,起点必须更早),按当时
//   生效成员计算,不把最新成员套用到历史;首个版本生效前记为未知。只有全部
//   生效成员都处于非下降读数区间时才是有效覆盖,并计入成员消耗之和;任一
//   成员下降为异常覆盖,否则任一成员未知为未知覆盖。异常与未知时段不计
//   任何成员消耗,缺失设备不按零补齐。覆盖秒数按分组实际时间计,不累加
//   成员秒数。各设备片段仍以原读数区间起点累计比例向下取整,日界线、查询
//   边界与成员切换都不重置分摊起点,拆开查询相加一致。全程 BigInt 精确
//   计算,kWh 固定三位小数。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataFilePath, groupFilePath, loadStore, StoreError, type Reading } from './store.ts';
import { formatIsoUtc } from './time.ts';
import { formatKwh } from './value.ts';
import { DAY_SECONDS } from './report.ts';

export interface GroupVersion {
  /** 生效时刻(含),epoch 秒。 */
  ts: number;
  /** 生效成员(设备标识),已排序去重,非空。 */
  members: string[];
}

export interface Group {
  /** 分组标识(非空、唯一,已去首尾空白,区分大小写)。 */
  id: string;
  /** 版本按生效时刻升序,时刻唯一。 */
  versions: GroupVersion[];
}

interface GroupState {
  groups: Group[];
}

function err(message: string): void {
  console.error(`meterwatch: ${message}`);
}

function emptyState(): GroupState {
  return { groups: [] };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 读取分组存储;文件不存在返回空状态,存在但无法读取或内容损坏抛出 StoreError。 */
function loadGroupState(path: string): GroupState {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
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
    if (
      g === null ||
      typeof g !== 'object' ||
      typeof g.id !== 'string' ||
      g.id.length === 0 ||
      !Array.isArray(g.versions) ||
      g.versions.length === 0
    ) {
      throw bad('invalid group entry');
    }
    if (ids.has(g.id)) throw bad(`duplicate group id '${g.id}'`);
    ids.add(g.id);
    const versions: GroupVersion[] = [];
    const seenTs = new Set<number>();
    for (const v of g.versions as Array<Record<string, unknown>>) {
      const ok =
        v !== null &&
        typeof v === 'object' &&
        Number.isSafeInteger(v.ts) &&
        Array.isArray(v.members) &&
        v.members.length > 0 &&
        (v.members as unknown[]).every((m) => typeof m === 'string' && m.length > 0);
      if (!ok) throw bad('invalid group version entry');
      const ts = v.ts as number;
      if (seenTs.has(ts)) throw bad(`duplicate version effective time in group '${g.id}'`);
      seenTs.add(ts);
      const rawMembers = v.members as string[];
      const members = [...new Set(rawMembers)].sort(compareStrings);
      if (members.length !== rawMembers.length) {
        throw bad(`duplicate member in group '${g.id}'`);
      }
      versions.push({ ts, members });
    }
    versions.sort((a, b) => a.ts - b.ts);
    groups.push({ id: g.id, versions });
  }
  return { groups };
}

/** 原子写入分组存储;失败抛错,原有数据保持不变。 */
function saveGroupState(path: string, state: GroupState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const body = JSON.stringify({ version: 1, groups: state.groups }, null, 2) + '\n';
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    throw new StoreError(`cannot write storage file ${path}: ${(e as Error).message}`);
  }
}

/**
 * 配置分组成员版本。首次配置建立分组;同组同一实际生效时刻、同成员集合
 * 重试成功且不新增,异成员集合报冲突;允许乱序补录历史版本。成员设备必须
 * 已有存储读数。整次成功或不提交。返回进程退出码。
 */
export function cmdGroupConfig(opts: { id: string; at: number; devices: string[] }): number {
  const statePath = groupFilePath();
  let state: GroupState;
  let known: Set<string>;
  try {
    state = loadGroupState(statePath);
    known = new Set(loadStore(dataFilePath()).map((r) => r.device));
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  const members = [...new Set(opts.devices)].sort(compareStrings);
  if (members.length === 0) {
    err(`group '${opts.id}': member set must not be empty`);
    return 1;
  }
  const unknownDevices = members.filter((d) => !known.has(d));
  if (unknownDevices.length > 0) {
    err(
      `unknown device(s): ${unknownDevices.join(', ')}: no stored readings; ` +
        'import readings before configuring a group',
    );
    return 1;
  }
  const membersText = members.join(', ');

  const group = state.groups.find((g) => g.id === opts.id);
  if (!group) {
    state.groups.push({ id: opts.id, versions: [{ ts: opts.at, members }] });
    try {
      saveGroupState(statePath, state);
    } catch (e) {
      if (e instanceof StoreError) {
        err(e.message);
        return 1;
      }
      throw e;
    }
    console.log(
      `group '${opts.id}' created: version 1 effective from ${formatIsoUtc(opts.at)}  members: ${membersText}`,
    );
    return 0;
  }

  const existing = group.versions.find((v) => v.ts === opts.at);
  if (existing) {
    if (
      existing.members.length === members.length &&
      existing.members.every((m, i) => m === members[i])
    ) {
      console.log(
        `group '${opts.id}' already has an identical version effective from ` +
          `${formatIsoUtc(opts.at)} (members: ${membersText}); unchanged`,
      );
      return 0;
    }
    err(
      `group '${opts.id}' already has a version effective from ${formatIsoUtc(opts.at)} ` +
        `with different members (stored: ${existing.members.join(', ')}; got: ${membersText}); conflict`,
    );
    return 1;
  }

  group.versions.push({ ts: opts.at, members });
  group.versions.sort((a, b) => a.ts - b.ts);
  try {
    saveGroupState(statePath, state);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  const index = group.versions.findIndex((v) => v.ts === opts.at);
  console.log(
    `group '${opts.id}' version ${index + 1} added: effective from ${formatIsoUtc(opts.at)}  members: ${membersText}`,
  );
  return 0;
}

/** 查看分组成员版本历史,按生效时刻排序。只读。返回进程退出码。 */
export function cmdGroupHistory(opts: { id: string }): number {
  let state: GroupState;
  try {
    state = loadGroupState(groupFilePath());
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  const group = state.groups.find((g) => g.id === opts.id);
  if (!group) {
    err(`unknown group '${opts.id}'`);
    return 1;
  }
  console.log(`group: ${group.id}  versions=${group.versions.length}`);
  group.versions.forEach((v, i) => {
    const until =
      i + 1 < group.versions.length ? formatIsoUtc(group.versions[i + 1].ts) : '(ongoing)';
    console.log(
      `  v${i + 1}  effective ${formatIsoUtc(v.ts)} .. ${until}  members: ${v.members.join(', ')}`,
    );
  });
  return 0;
}

export interface GroupDayPeriod {
  /** 时段起点(含),epoch 秒。 */
  start: number;
  /** 时段终点(不含),epoch 秒。 */
  end: number;
  /** 该时段生效成员;null 表示首个版本生效前(未知)。 */
  members: string[] | null;
}

export interface GroupDayStats {
  /** 有效(全部生效成员均处于非下降区间)覆盖秒数。 */
  valid: number;
  /** 异常(任一成员下降)覆盖秒数。 */
  anomaly: number;
  /** 未知(任一成员无区间覆盖,或首个版本生效前)秒数。 */
  unknown: number;
  /** 该天分摊消耗之和,毫千瓦时;仅 valid > 0 时有意义。 */
  consumption: bigint;
  /** 当天生效成员及其时段(按时间顺序,覆盖整天查询段)。 */
  periods: GroupDayPeriod[];
}

/** 找到覆盖时刻 t 的读数区间 [a, b);不存在(首条之前或末条之后)返回 null。 */
function intervalAt(series: Reading[], t: number): { a: Reading; b: Reading } | null {
  let lo = 0;
  let hi = series.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].ts <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx === -1 || idx + 1 >= series.length) return null;
  return { a: series[idx], b: series[idx + 1] };
}

/**
 * 计算 [segStart, segEnd) 一天的分组统计。
 * 成员版本与成员读数区间都作为切点;每个基本片段内各成员状态恒定。
 * 各成员片段消耗从原读数区间起点累计比例向下取整,两端累计量之差为消耗,
 * 切点(日界线、查询边界、成员切换)不重置分摊起点。
 */
export function computeGroupDay(
  versions: GroupVersion[],
  seriesByDevice: Map<string, Reading[]>,
  segStart: number,
  segEnd: number,
): GroupDayStats {
  const bounds = [segStart];
  for (const v of versions) {
    if (v.ts > segStart && v.ts < segEnd) bounds.push(v.ts);
  }
  bounds.push(segEnd);

  const periods: GroupDayPeriod[] = [];
  let valid = 0;
  let anomaly = 0;
  let unknown = 0;
  let consumption = 0n;

  for (let i = 0; i + 1 < bounds.length; i++) {
    const p = bounds[i];
    const q = bounds[i + 1];
    // 当时生效版本:最后一个生效时刻 <= p 的版本(版本已按时刻升序)。
    let version: GroupVersion | null = null;
    for (const v of versions) {
      if (v.ts <= p) version = v;
      else break;
    }
    periods.push({ start: p, end: q, members: version ? version.members : null });
    if (!version) {
      unknown += q - p;
      continue;
    }

    // 成员读数时刻落在 (p, q) 内的都作为切点,保证基本片段内无读数边界。
    const cuts = new Set<number>();
    for (const m of version.members) {
      const series = seriesByDevice.get(m);
      if (!series) continue;
      for (const r of series) {
        if (r.ts > p && r.ts < q) cuts.add(r.ts);
      }
    }
    const points = [p, ...[...cuts].sort((a, b) => a - b), q];

    for (let j = 0; j + 1 < points.length; j++) {
      const s = points[j];
      const e = points[j + 1];
      let sliceAnomaly = false;
      let sliceUnknown = false;
      let sliceConsumption = 0n;
      for (const m of version.members) {
        const series = seriesByDevice.get(m);
        const iv = series ? intervalAt(series, s) : null;
        if (!iv) {
          sliceUnknown = true;
          continue;
        }
        const diff = iv.b.milli - iv.a.milli;
        if (diff < 0n) {
          sliceAnomaly = true;
          continue;
        }
        const duration = BigInt(iv.b.ts - iv.a.ts);
        // 从区间起点累计到 t 的比例量(向下取整);BigInt 除法向零截断,
        // 被除数非负,等价于向下取整。
        const cumulative = (t: number): bigint => (diff * BigInt(t - iv.a.ts)) / duration;
        sliceConsumption += cumulative(e) - cumulative(s);
      }
      if (sliceAnomaly) {
        anomaly += e - s;
      } else if (sliceUnknown) {
        unknown += e - s;
      } else {
        valid += e - s;
        consumption += sliceConsumption;
      }
    }
  }
  return { valid, anomaly, unknown, consumption, periods };
}

/**
 * 输出分组按 UTC 自然日划分的能耗日报。只读,不修改数据。
 * 按当时生效成员计算;同设备同一实际时刻存在多条存储记录时报错并返回 1。
 * 返回进程退出码。
 */
export function cmdGroupDaily(opts: { id: string; from: number; to: number }): number {
  let state: GroupState;
  let all: Reading[];
  try {
    state = loadGroupState(groupFilePath());
    all = loadStore(dataFilePath());
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  const group = state.groups.find((g) => g.id === opts.id);
  if (!group) {
    err(`unknown group '${opts.id}'`);
    return 1;
  }

  const needed = new Set<string>();
  for (const v of group.versions) for (const m of v.members) needed.add(m);
  const seriesByDevice = new Map<string, Reading[]>();
  for (const r of all) {
    if (!needed.has(r.device)) continue;
    const list = seriesByDevice.get(r.device);
    if (list) list.push(r);
    else seriesByDevice.set(r.device, [r]);
  }
  for (const [device, list] of seriesByDevice) {
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
    const stats = computeGroupDay(group.versions, seriesByDevice, segStart, segEnd);
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
    for (const period of stats.periods) {
      const who =
        period.members === null ? '(none, before first version)' : period.members.join(', ');
      console.log(
        `    members: ${who}  (${formatIsoUtc(period.start)}..${formatIsoUtc(period.end)})`,
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

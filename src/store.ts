// 本地持久化:JSON 文件,默认位于 ~/.meterwatch/readings.json,
// 可用环境变量 METERWATCH_DATA_DIR 指定其他目录。
// 写入采用临时文件 + rename 的原子方式;读取失败或内容损坏一律报错,绝不当作空库。
//
// 毫千瓦时数值在文件中以十进制字符串保存,可表示任意大的精确值;
// 同时兼容旧版以 JSON 数值保存的安全整数读数。数值型毫千瓦时若超出
// Number 安全整数范围,JSON 解析时已丢失精度,按损坏数据拒绝,不猜测原值。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Reading {
  /** 设备标识(已去除首尾空白,区分大小写)。 */
  device: string;
  /** 实际时刻,epoch 秒。 */
  ts: number;
  /** 累计读数,毫千瓦时(千分之一 kWh)BigInt,非负。 */
  milli: bigint;
}

export interface CorrectionItem {
  /** 设备标识(已去除首尾空白,区分大小写)。 */
  device: string;
  /** 实际时刻,epoch 秒。 */
  ts: number;
  /** 提交时核验的预期原值,毫千瓦时 BigInt。 */
  expectedMilli: bigint;
  /** 替换值,毫千瓦时 BigInt。 */
  replacementMilli: bigint;
}

export interface Correction {
  /** 请求标识(已去除首尾空白,区分大小写),在数据目录内唯一。 */
  requestId: string;
  /** 本次提交的修正项,按提交顺序保存。 */
  items: CorrectionItem[];
}

export interface UndoRecord {
  /** 撤销请求标识(已去除首尾空白,区分大小写),与修正请求共用唯一标识空间。 */
  requestId: string;
  /** 目标修正请求标识;只能是成功修正,不能是撤销请求。 */
  targetId: string;
  /** 首次撤销时实际恢复的读数条数(目标中实际改变过的项)。 */
  restored: number;
}

export interface StoreData {
  readings: Reading[];
  /** 已成功提交的修正历史,按提交顺序;与读数同文件原子持久化。 */
  corrections: Correction[];
  /** 已成功提交的撤销记录,按成功发生顺序;与读数、修正历史同文件原子持久化。 */
  undos: UndoRecord[];
}

export class StoreError extends Error {}

export function dataFilePath(): string {
  const dir = process.env.METERWATCH_DATA_DIR ?? join(homedir(), '.meterwatch');
  return join(dir, 'readings.json');
}

/** 告警规则与历史的存储文件,与读数文件同目录、相互独立。 */
export function alertFilePath(): string {
  const dir = process.env.METERWATCH_DATA_DIR ?? join(homedir(), '.meterwatch');
  return join(dir, 'alerts.json');
}

/** 分组配置的存储文件,与读数、告警文件同目录、相互独立。 */
export function groupFilePath(): string {
  const dir = process.env.METERWATCH_DATA_DIR ?? join(homedir(), '.meterwatch');
  return join(dir, 'groups.json');
}

/**
 * 解析存储中的毫千瓦时字段:十进制数字字符串,或旧格式的安全整数数值。
 * 其他形式(含超出安全整数范围的数值,精度已丢失)返回 null,由调用方按损坏处理。
 */
export function parseStoredMilli(value: unknown): bigint | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return null;
}

/**
 * 解析存储中的修正历史;字段缺失按空历史(旧版文件),存在但结构非法返回 null。
 */
function parseStoredCorrections(value: unknown): Correction[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: Correction[] = [];
  const ids = new Set<string>();
  for (const c of value as Array<Record<string, unknown>>) {
    if (
      c === null ||
      typeof c !== 'object' ||
      typeof c.requestId !== 'string' ||
      c.requestId.length === 0 ||
      !Array.isArray(c.items) ||
      c.items.length === 0 ||
      ids.has(c.requestId)
    ) {
      return null;
    }
    const items: CorrectionItem[] = [];
    for (const it of c.items as Array<Record<string, unknown>>) {
      const expectedMilli = it !== null && typeof it === 'object' ? parseStoredMilli(it.expectedMilli) : null;
      const replacementMilli = it !== null && typeof it === 'object' ? parseStoredMilli(it.replacementMilli) : null;
      const ok =
        it !== null &&
        typeof it === 'object' &&
        typeof it.device === 'string' &&
        it.device.length > 0 &&
        Number.isSafeInteger(it.ts) &&
        expectedMilli !== null &&
        replacementMilli !== null;
      if (!ok) return null;
      items.push({
        device: it.device as string,
        ts: it.ts as number,
        expectedMilli: expectedMilli as bigint,
        replacementMilli: replacementMilli as bigint,
      });
    }
    ids.add(c.requestId);
    out.push({ requestId: c.requestId, items });
  }
  return out;
}

/**
 * 解析存储中的撤销历史;字段缺失按空历史(旧版文件,原修正视为未撤销),
 * 存在但结构非法或与修正历史不一致返回 null。
 */
function parseStoredUndos(value: unknown, corrections: Correction[]): UndoRecord[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const correctionIds = new Set(corrections.map((c) => c.requestId));
  const ids = new Set<string>();
  const targets = new Set<string>();
  const out: UndoRecord[] = [];
  for (const u of value as Array<Record<string, unknown>>) {
    const ok =
      u !== null &&
      typeof u === 'object' &&
      typeof u.requestId === 'string' &&
      u.requestId.length > 0 &&
      typeof u.targetId === 'string' &&
      u.targetId.length > 0 &&
      Number.isSafeInteger(u.restored) &&
      (u.restored as number) >= 0;
    if (!ok) return null;
    // 撤销与修正共用唯一标识空间;目标必须是已存修正且每个目标最多被撤销一次。
    if (ids.has(u.requestId as string) || correctionIds.has(u.requestId as string)) return null;
    if (!correctionIds.has(u.targetId as string) || targets.has(u.targetId as string)) return null;
    ids.add(u.requestId as string);
    targets.add(u.targetId as string);
    out.push({
      requestId: u.requestId as string,
      targetId: u.targetId as string,
      restored: u.restored as number,
    });
  }
  return out;
}

/** 读取存储(读数与修正历史);文件不存在返回空数据,存在但无法读取或内容损坏抛出 StoreError。 */
export function loadData(path: string): StoreData {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { readings: [], corrections: [], undos: [] };
    throw new StoreError(`cannot read storage file ${path}: ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StoreError(`storage file ${path} is corrupted (invalid JSON)`);
  }
  const readings = (data as { readings?: unknown })?.readings;
  if (!Array.isArray(readings)) {
    throw new StoreError(`storage file ${path} is corrupted (missing readings array)`);
  }
  const out: Reading[] = [];
  for (const r of readings as Array<Record<string, unknown>>) {
    const milli = r !== null && typeof r === 'object' ? parseStoredMilli(r.milli) : null;
    const ok =
      r !== null &&
      typeof r === 'object' &&
      typeof r.device === 'string' &&
      r.device.length > 0 &&
      Number.isSafeInteger(r.ts) &&
      milli !== null;
    if (!ok) {
      throw new StoreError(`storage file ${path} is corrupted (invalid reading entry)`);
    }
    out.push({ device: r.device as string, ts: r.ts as number, milli: milli as bigint });
  }
  const corrections = parseStoredCorrections((data as { corrections?: unknown })?.corrections);
  if (corrections === null) {
    throw new StoreError(`storage file ${path} is corrupted (invalid corrections)`);
  }
  const undos = parseStoredUndos((data as { undos?: unknown })?.undos, corrections);
  if (undos === null) {
    throw new StoreError(`storage file ${path} is corrupted (invalid undos)`);
  }
  return { readings: out, corrections, undos };
}

/** 只取读数的便捷封装;语义与 loadData 相同。 */
export function loadStore(path: string): Reading[] {
  return loadData(path).readings;
}

/** 原子写入存储(读数、修正历史与撤销记录同文件同时持久化);失败抛错,原有数据保持不变。 */
export function saveData(path: string, data: StoreData): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const body =
    JSON.stringify(
      {
        version: 1,
        readings: data.readings.map((r) => ({ device: r.device, ts: r.ts, milli: r.milli.toString() })),
        corrections: data.corrections.map((c) => ({
          requestId: c.requestId,
          items: c.items.map((it) => ({
            device: it.device,
            ts: it.ts,
            expectedMilli: it.expectedMilli.toString(),
            replacementMilli: it.replacementMilli.toString(),
          })),
        })),
        undos: data.undos.map((u) => ({
          requestId: u.requestId,
          targetId: u.targetId,
          restored: u.restored,
        })),
      },
      null,
      2,
    ) + '\n';
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    throw new StoreError(`cannot write storage file ${path}: ${(err as Error).message}`);
  }
}

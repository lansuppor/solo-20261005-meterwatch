// 本地持久化:JSON 文件,默认位于 ~/.meterwatch/readings.json,
// 可用环境变量 METERWATCH_DATA_DIR 指定其他目录。
// 写入采用临时文件 + rename 的原子方式;读取失败或内容损坏一律报错,绝不当作空库。
// 读数与修正历史(corrections)存于同一文件,修正替换与请求成功记录同次原子写入。
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
  /** 预期原读数,毫千瓦时 BigInt,非负。 */
  expectedMilli: bigint;
  /** 替换读数,毫千瓦时 BigInt,非负。 */
  replacementMilli: bigint;
}

export interface CorrectionRecord {
  /** 请求标识(非空,已去首尾空白,数据目录内唯一),识别整次提交。 */
  request: string;
  /** 实际改变的读数条数(替换值不同于操作前已存值的项数)。 */
  changed: number;
  /** 本次提交的修正项,按提交时顺序记录。 */
  items: CorrectionItem[];
}

export interface StoreData {
  readings: Reading[];
  /** 已成功提交的修正记录,按成功提交顺序排列。 */
  corrections: CorrectionRecord[];
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

const ENOENT_CODE = 'ENOENT';

/** 读取存储;文件不存在返回空数据,存在但无法读取或内容损坏抛出 StoreError。 */
export function loadData(path: string): StoreData {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === ENOENT_CODE) return { readings: [], corrections: [] };
    throw new StoreError(`cannot read storage file ${path}: ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StoreError(`storage file ${path} is corrupted (invalid JSON)`);
  }
  const bad = (what: string): StoreError =>
    new StoreError(`storage file ${path} is corrupted (${what})`);
  const readings = (data as { readings?: unknown })?.readings;
  if (!Array.isArray(readings)) throw bad('missing readings array');
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
    if (!ok) throw bad('invalid reading entry');
    out.push({ device: r.device as string, ts: r.ts as number, milli: milli as bigint });
  }

  // 修正历史:旧版文件没有 corrections 字段,按空历史读入,无需手工迁移;
  // 字段存在但形式非法(含重复请求标识)按损坏数据拒绝,不当作空库。
  const rawCorrections = (data as { corrections?: unknown })?.corrections;
  const corrections: CorrectionRecord[] = [];
  if (rawCorrections !== undefined) {
    if (!Array.isArray(rawCorrections)) throw bad('invalid corrections');
    const requests = new Set<string>();
    for (const c of rawCorrections as Array<Record<string, unknown>>) {
      const cok =
        c !== null &&
        typeof c === 'object' &&
        typeof c.request === 'string' &&
        c.request.length > 0 &&
        Number.isSafeInteger(c.changed) &&
        (c.changed as number) >= 0 &&
        Array.isArray(c.items) &&
        (c.items as unknown[]).length > 0 &&
        (c.changed as number) <= (c.items as unknown[]).length;
      if (!cok) throw bad('invalid correction entry');
      if (requests.has(c.request as string)) {
        throw bad(`duplicate correction request '${c.request}'`);
      }
      requests.add(c.request as string);
      const items: CorrectionItem[] = [];
      for (const it of c.items as Array<Record<string, unknown>>) {
        const expectedMilli = it !== null && typeof it === 'object' ? parseStoredMilli(it.expectedMilli) : null;
        const replacementMilli = it !== null && typeof it === 'object' ? parseStoredMilli(it.replacementMilli) : null;
        const iok =
          it !== null &&
          typeof it === 'object' &&
          typeof it.device === 'string' &&
          it.device.length > 0 &&
          Number.isSafeInteger(it.ts) &&
          expectedMilli !== null &&
          replacementMilli !== null;
        if (!iok) throw bad(`invalid correction item in request '${c.request}'`);
        items.push({
          device: it.device as string,
          ts: it.ts as number,
          expectedMilli: expectedMilli as bigint,
          replacementMilli: replacementMilli as bigint,
        });
      }
      corrections.push({ request: c.request as string, changed: c.changed as number, items });
    }
  }
  return { readings: out, corrections };
}

/** 读取已存读数;文件不存在返回空数组,存在但无法读取或内容损坏抛出 StoreError。 */
export function loadStore(path: string): Reading[] {
  return loadData(path).readings;
}

/** 原子写入存储(读数与修正历史一起);失败抛错,原有数据保持不变。 */
export function saveData(path: string, data: StoreData): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const body =
    JSON.stringify(
      {
        version: 1,
        readings: data.readings.map((r) => ({ device: r.device, ts: r.ts, milli: r.milli.toString() })),
        corrections: data.corrections.map((c) => ({
          request: c.request,
          changed: c.changed,
          items: c.items.map((it) => ({
            device: it.device,
            ts: it.ts,
            expectedMilli: it.expectedMilli.toString(),
            replacementMilli: it.replacementMilli.toString(),
          })),
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

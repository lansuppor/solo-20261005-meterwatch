// 本地持久化:JSON 文件,默认位于 ~/.meterwatch/readings.json,
// 可用环境变量 METERWATCH_DATA_DIR 指定其他目录。
// 写入采用临时文件 + rename 的原子方式;读取失败或内容损坏一律报错,绝不当作空库。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { milliToJson, parseStoredMilli } from './value.ts';

export interface Reading {
  /** 设备标识(已去除首尾空白,区分大小写)。 */
  device: string;
  /** 实际时刻,epoch 秒。 */
  ts: number;
  /** 累计读数,毫千瓦时(千分之一 kWh)BigInt 整数,可超出 Number 安全范围。 */
  milli: bigint;
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

/** 读取存储;文件不存在返回空数组,存在但无法读取或内容损坏抛出 StoreError。 */
export function loadStore(path: string): Reading[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
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
    // milli 兼容旧的数值型安全整数与新的十进制字符串;数值型超出安全整数
    // 范围时原值已不可知,按损坏数据拒绝,不猜测原值。
    const milli =
      r !== null && typeof r === 'object' ? parseStoredMilli(r.milli) : null;
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
    out.push({ device: r.device as string, ts: r.ts as number, milli });
  }
  return out;
}

/** 原子写入存储;失败抛错,原有数据保持不变。 */
export function saveStore(path: string, readings: Reading[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const body =
    JSON.stringify(
      {
        version: 1,
        readings: readings.map((r) => ({
          device: r.device,
          ts: r.ts,
          milli: milliToJson(r.milli),
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

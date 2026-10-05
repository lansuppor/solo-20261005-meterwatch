// 本地持久化:JSON 文件,默认位于 ~/.meterwatch/readings.json,
// 可用环境变量 METERWATCH_DATA_DIR 指定其他目录。
// 写入采用临时文件 + rename 的原子方式;读取失败或内容损坏一律报错,绝不当作空库。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Reading {
  /** 设备标识(已去除首尾空白,区分大小写)。 */
  device: string;
  /** 实际时刻,epoch 秒。 */
  ts: number;
  /** 累计读数,毫千瓦时(千分之一 kWh)整数。 */
  milli: number;
}

export class StoreError extends Error {}

export function dataFilePath(): string {
  const dir = process.env.METERWATCH_DATA_DIR ?? join(homedir(), '.meterwatch');
  return join(dir, 'readings.json');
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
  for (const r of readings as Array<Record<string, unknown>>) {
    const ok =
      r !== null &&
      typeof r === 'object' &&
      typeof r.device === 'string' &&
      r.device.length > 0 &&
      Number.isSafeInteger(r.ts) &&
      Number.isSafeInteger(r.milli) &&
      (r.milli as number) >= 0;
    if (!ok) {
      throw new StoreError(`storage file ${path} is corrupted (invalid reading entry)`);
    }
  }
  return readings as Reading[];
}

/** 原子写入存储;失败抛错,原有数据保持不变。 */
export function saveStore(path: string, readings: Reading[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const body = JSON.stringify({ version: 1, readings }, null, 2) + '\n';
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    throw new StoreError(`cannot write storage file ${path}: ${(err as Error).message}`);
  }
}

// import 与 readings 两个子命令的实现。

import { readFileSync } from 'node:fs';
import { CsvError, parseCsv } from './csv.ts';
import { loadData, loadStore, saveData, StoreError, dataFilePath, type Reading, type StoreData } from './store.ts';
import { formatIsoUtc, parseIso8601 } from './time.ts';
import { formatKwh, parseKwh } from './value.ts';

export const CSV_HEADER = 'device,time,reading';

function err(message: string): void {
  console.error(`meterwatch: ${message}`);
}

/**
 * 导入 CSV 文件。整批成功或整批拒绝:
 * 任一行格式错误或读数冲突都不写入任何新数据。
 * 返回进程退出码。
 */
export function cmdImport(file: string): number {
  const storePath = dataFilePath();

  let data: StoreData;
  try {
    data = loadData(storePath);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  const existing = data.readings;

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    err(`cannot read '${file}': ${(e as Error).message}`);
    return 1;
  }

  let records;
  try {
    records = parseCsv(text);
  } catch (e) {
    if (e instanceof CsvError) {
      err(`${file}: ${e.message}`);
      return 1;
    }
    throw e;
  }

  if (records.length === 0) {
    err(`${file}: empty file, expected header '${CSV_HEADER}'`);
    return 1;
  }
  const header = records[0];
  if (header.fields.length !== 3 || header.fields.join(',') !== CSV_HEADER) {
    err(`${file}: line ${header.line}: expected header '${CSV_HEADER}'`);
    return 1;
  }

  // 逐行解析,收集全部格式错误。
  const errors: string[] = [];
  const rows: Array<Reading & { line: number }> = [];
  for (const rec of records.slice(1)) {
    if (rec.fields.length !== 3) {
      errors.push(`line ${rec.line}: expected 3 fields (device,time,reading), got ${rec.fields.length}`);
      continue;
    }
    const device = rec.fields[0].trim();
    if (device === '') {
      errors.push(`line ${rec.line}: device identifier is empty`);
      continue;
    }
    const ts = parseIso8601(rec.fields[1].trim());
    if (ts === null) {
      errors.push(`line ${rec.line}: invalid timestamp '${rec.fields[1].trim()}' (need ISO8601 with seconds and Z or numeric offset, e.g. 2026-01-01T00:00:00Z)`);
      continue;
    }
    const milli = parseKwh(rec.fields[2].trim());
    if (milli === null) {
      errors.push(`line ${rec.line}: invalid reading '${rec.fields[2].trim()}' (need a non-negative kWh value with at most 3 decimals)`);
      continue;
    }
    rows.push({ device, ts, milli, line: rec.line });
  }
  if (errors.length > 0) {
    for (const e of errors) err(`${file}: ${e}`);
    err(`import rejected: ${errors.length} invalid row(s); nothing was imported`);
    return 1;
  }

  // 去重与冲突检测:先文件内部,再与已存数据比对。身份 = (设备, 实际时刻)。
  const key = (device: string, ts: number): string => `${device} ${ts}`;
  const inStore = new Map<string, bigint>();
  for (const r of existing) inStore.set(key(r.device, r.ts), r.milli);

  const inFile = new Map<string, bigint>();
  const toAdd: Reading[] = [];
  const conflicts: string[] = [];
  let duplicates = 0;
  for (const r of rows) {
    const k = key(r.device, r.ts);
    const at = formatIsoUtc(r.ts);
    const fileVal = inFile.get(k);
    if (fileVal !== undefined) {
      if (fileVal === r.milli) {
        duplicates++;
      } else {
        conflicts.push(`line ${r.line}: conflicting readings for device '${r.device}' at ${at} (${formatKwh(fileVal)} vs ${formatKwh(r.milli)} kWh)`);
      }
      continue;
    }
    inFile.set(k, r.milli);
    const storeVal = inStore.get(k);
    if (storeVal !== undefined) {
      if (storeVal === r.milli) {
        duplicates++;
      } else {
        conflicts.push(`line ${r.line}: conflicts with stored reading for device '${r.device}' at ${at} (stored ${formatKwh(storeVal)} vs new ${formatKwh(r.milli)} kWh)`);
      }
      continue;
    }
    toAdd.push({ device: r.device, ts: r.ts, milli: r.milli });
  }
  if (conflicts.length > 0) {
    for (const c of conflicts) err(`${file}: ${c}`);
    err(`import rejected: ${conflicts.length} conflict(s); nothing was imported`);
    return 1;
  }

  try {
    // 读数与修正历史同文件保存:导入新增读数时原样保留已有修正历史。
    saveData(storePath, { readings: existing.concat(toAdd), corrections: data.corrections });
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  console.log(`imported ${toAdd.length} new reading(s), ${duplicates} duplicate(s) skipped`);
  return 0;
}

export interface ReadingsFilter {
  devices: string[];
  from?: number;
  to?: number;
}

/**
 * 查询读数与消耗。只读,不修改数据。
 * 前驱取自完整已存时序(可能在范围之外);区间归属结束时刻。
 * 返回进程退出码。
 */
export function cmdReadings(filter: ReadingsFilter): number {
  const storePath = dataFilePath();
  let all: Reading[];
  try {
    all = loadStore(storePath);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  const byDevice = new Map<string, Reading[]>();
  for (const r of all) {
    const list = byDevice.get(r.device);
    if (list) list.push(r);
    else byDevice.set(r.device, [r]);
  }
  for (const list of byDevice.values()) list.sort((a, b) => a.ts - b.ts);

  const wanted =
    filter.devices.length > 0
      ? [...new Set(filter.devices)]
      : [...byDevice.keys()];
  wanted.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  let printed = false;
  for (const device of wanted) {
    const series = byDevice.get(device);
    if (!series) continue;
    const selected: Array<{ r: Reading; prev: Reading | null }> = [];
    for (let i = 0; i < series.length; i++) {
      const r = series[i];
      if (filter.from !== undefined && r.ts < filter.from) continue;
      if (filter.to !== undefined && r.ts >= filter.to) continue;
      selected.push({ r, prev: i > 0 ? series[i - 1] : null });
    }
    if (selected.length === 0) continue;
    printed = true;

    console.log(`device: ${device}`);
    let total = 0n;
    for (const { r, prev } of selected) {
      let line = `  ${formatIsoUtc(r.ts)}  reading=${formatKwh(r.milli)} kWh`;
      if (prev === null) {
        line += '  interval=n/a  consumption=n/a (no predecessor)';
      } else {
        const duration = r.ts - prev.ts;
        const diff = r.milli - prev.milli;
        line += `  interval=${formatIsoUtc(prev.ts)}..${formatIsoUtc(r.ts)} (${duration}s)`;
        if (diff < 0n) {
          line += `  consumption=ANOMALY: decrease of ${formatKwh(-diff)} kWh (excluded from summary)`;
        } else {
          line += `  consumption=${formatKwh(diff)} kWh`;
          total += diff;
        }
      }
      console.log(line);
    }
    console.log(`  summary: device=${device}  total consumption=${formatKwh(total)} kWh`);
  }
  if (!printed) console.log('no readings match');
  return 0;
}

export { parseIso8601 };

// correct 与 corrections 两个子命令的实现:可追溯的已存读数批量修正。
//
// 一次提交指定非空请求标识及至少一项修正;每项给出设备、实际时刻、预期原读数
// 和替换读数,只修改已有读数的累计值,不新增或删除读数。首次提交逐项核验预期
// 原值与操作前已存值精确一致,全部匹配才整体替换;任一不符整批拒绝,不占用
// 请求标识。读数替换与请求成功记录在同一存储文件中原子持久化,写入失败保留
// 操作前全部状态。同标识同内容重放直接返回原成功结果,不重新校验、不再次
// 替换;同标识异内容报冲突且保持状态。

import {
  dataFilePath,
  loadData,
  saveData,
  StoreError,
  type CorrectionItem,
  type Reading,
} from './store.ts';
import { loadCheckedSeriesByDevice } from './groups.ts';
import { formatIsoUtc } from './time.ts';
import { formatKwh } from './value.ts';

function err(message: string): void {
  console.error(`meterwatch: ${message}`);
}

function sameItem(a: CorrectionItem, b: CorrectionItem): boolean {
  return (
    a.device === b.device &&
    a.ts === b.ts &&
    a.expectedMilli === b.expectedMilli &&
    a.replacementMilli === b.replacementMilli
  );
}

/** 内容等价:修正项集合相同,顺序无关(时刻已按 epoch 秒、数值已按毫千瓦时规范化)。 */
function itemsEquivalent(a: CorrectionItem[], b: CorrectionItem[]): boolean {
  if (a.length !== b.length) return false;
  const used = new Array<boolean>(b.length).fill(false);
  for (const item of a) {
    let found = false;
    for (let j = 0; j < b.length; j++) {
      if (!used[j] && sameItem(item, b[j])) {
        used[j] = true;
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/** 实际改变的读数条数:提交时预期原值已与已存值一致,故替换值不同于预期原值即为改变。 */
function changedCount(items: CorrectionItem[]): number {
  return items.filter((it) => it.expectedMilli !== it.replacementMilli).length;
}

function reportSuccess(requestId: string, items: CorrectionItem[]): void {
  console.log(
    `correction '${requestId}' committed: ${items.length} item(s), ${changedCount(items)} reading(s) changed`,
  );
}

/**
 * 提交一批修正。requestId 与 items 均由调用方完成格式解析(去空白、
 * 时间与数值已规范化)。返回进程退出码。
 */
export function cmdCorrect(requestId: string, items: CorrectionItem[]): number {
  // 同批同一读数身份(设备 + 实际时刻)只允许一项。
  const seen = new Set<string>();
  for (const it of items) {
    const k = `${it.device} ${it.ts}`;
    if (seen.has(k)) {
      err(`duplicate correction item for device '${it.device}' at ${formatIsoUtc(it.ts)}`);
      return 2;
    }
    seen.add(k);
  }

  const storePath = dataFilePath();
  let data;
  try {
    data = loadData(storePath);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  // 重放:同标识同内容直接返回原成功结果,不重新校验当前读数、不再次替换;
  // 同标识异内容报冲突且保持状态。
  const prior = data.corrections.find((c) => c.requestId === requestId);
  if (prior !== undefined) {
    if (itemsEquivalent(prior.items, items)) {
      reportSuccess(requestId, prior.items);
      return 0;
    }
    err(`correction request '${requestId}' conflicts with an already committed request of the same id; nothing was changed`);
    return 1;
  }

  // 全库重复身份(同一设备同一实际时刻多条存储记录)必须报错,不能当空库。
  let byDevice;
  try {
    byDevice = loadCheckedSeriesByDevice(data.readings);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  // 核验:每项身份必须存在,且预期原值与操作前已存值精确一致。
  const errors: string[] = [];
  const readings: Array<{ reading: Reading; item: CorrectionItem }> = [];
  for (const it of items) {
    const series = byDevice.get(it.device);
    const reading = series?.find((r) => r.ts === it.ts);
    if (reading === undefined) {
      errors.push(`no stored reading for device '${it.device}' at ${formatIsoUtc(it.ts)}`);
      continue;
    }
    if (reading.milli !== it.expectedMilli) {
      errors.push(
        `stored value mismatch for device '${it.device}' at ${formatIsoUtc(it.ts)}: ` +
          `expected ${formatKwh(it.expectedMilli)} kWh but stored ${formatKwh(reading.milli)} kWh`,
      );
      continue;
    }
    readings.push({ reading, item: it });
  }
  if (errors.length > 0) {
    for (const e of errors) err(e);
    err(`correction '${requestId}' rejected: ${errors.length} item(s) failed; nothing was changed`);
    return 1;
  }

  // 整体替换,并把请求成功记录与读数替换同文件原子持久化。
  for (const { reading, item } of readings) reading.milli = item.replacementMilli;
  try {
    saveData(storePath, {
      readings: data.readings,
      corrections: data.corrections.concat([{ requestId, items }]),
    });
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  reportSuccess(requestId, items);
  return 0;
}

/**
 * 按成功提交顺序显示修正历史:请求标识及各项设备、时刻、原值和替换值。
 * 只读,不写入数据。返回进程退出码。
 */
export function cmdCorrections(): number {
  const storePath = dataFilePath();
  let data;
  try {
    data = loadData(storePath);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  if (data.corrections.length === 0) {
    console.log('no corrections recorded');
    return 0;
  }
  for (const c of data.corrections) {
    console.log(`correction '${c.requestId}': ${c.items.length} item(s), ${changedCount(c.items)} reading(s) changed`);
    for (const it of c.items) {
      console.log(
        `  ${formatIsoUtc(it.ts)}  device=${it.device}  expected=${formatKwh(it.expectedMilli)} kWh  replacement=${formatKwh(it.replacementMilli)} kWh`,
      );
    }
  }
  return 0;
}

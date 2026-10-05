// correct、undo 与 corrections 三个子命令的实现:可追溯的已存读数批量修正
// 及已成功修正的整批撤销。
//
// 一次 correct 提交指定非空请求标识及至少一项修正;每项给出设备、实际时刻、预期
// 原读数和替换读数,只修改已有读数的累计值,不新增或删除读数。首次提交逐项核验
// 预期原值与操作前已存值精确一致,全部匹配才整体替换;任一不符整批拒绝,不占用
// 请求标识。读数替换与请求成功记录在同一存储文件中原子持久化,写入失败保留操作
// 前全部状态。同标识同内容重放直接返回原成功结果,不重新校验、不再次替换;同标识
// 异内容报冲突且保持状态。
//
// undo 整批撤销一个已成功且未撤销的修正:指定自身的非空请求标识与目标修正请求
// 标识,撤销与修正请求在数据目录内共用唯一标识空间,成功标识绑定操作类型和内容。
// 只恢复目标中实际改变过的读数(同值项不恢复也不阻塞),还原为该修正记录的原值,
// 不新增或删除读数。每个待恢复身份必须存在、当前值精确等于原替换值,且没有后来
// 尚未撤销、实际改变过该读数的修正(后来改回相同数值也不能绕过来源检查);任一项
// 不满足指出身份和原因,整次拒绝,不占用撤销标识。读数恢复、目标已撤销标记与
// 撤销成功记录同时原子持久化。同标识同目标重放返回原成功结果,不重新核验、不
// 重复恢复;同标识异目标或跨操作类型复用标识均报冲突。已撤销修正的原请求重放
// 仍返回原成功结果,不重新应用修正。

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
  // 同标识异内容报冲突且保持状态。撤销与修正共用标识空间:标识已被撤销请求
  // 占用同样报冲突。已撤销修正的原请求重放仍返回原成功结果,不重新应用修正。
  const prior = data.corrections.find((c) => c.requestId === requestId);
  if (prior !== undefined) {
    if (itemsEquivalent(prior.items, items)) {
      reportSuccess(requestId, prior.items);
      return 0;
    }
    err(`correction request '${requestId}' conflicts with an already committed request of the same id; nothing was changed`);
    return 1;
  }
  if (data.undos.some((u) => u.requestId === requestId)) {
    err(`correction request '${requestId}' conflicts with an already committed undo request of the same id; nothing was changed`);
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

  // 整体替换,并把请求成功记录与读数替换同文件原子持久化(保留撤销历史)。
  for (const { reading, item } of readings) reading.milli = item.replacementMilli;
  try {
    saveData(storePath, {
      readings: data.readings,
      corrections: data.corrections.concat([{ requestId, items }]),
      undos: data.undos,
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

function reportUndoSuccess(requestId: string, targetId: string, restored: number): void {
  console.log(`undo '${requestId}' committed: target='${targetId}', ${restored} reading(s) restored`);
}

/**
 * 整批撤销一个已成功且未撤销的修正。requestId 与 targetId 均由调用方完成
 * 格式解析(去空白、非空)。返回进程退出码。
 */
export function cmdUndo(requestId: string, targetId: string): number {
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

  // 重放:同标识同目标直接返回原成功结果,不重新核验撤销资格、不重复恢复;
  // 同标识异目标或跨操作类型(标识已被修正请求占用)均报冲突且保持状态。
  const priorUndo = data.undos.find((u) => u.requestId === requestId);
  if (priorUndo !== undefined) {
    if (priorUndo.targetId === targetId) {
      reportUndoSuccess(priorUndo.requestId, priorUndo.targetId, priorUndo.restored);
      return 0;
    }
    err(`undo request '${requestId}' conflicts with an already committed request of the same id; nothing was changed`);
    return 1;
  }
  if (data.corrections.some((c) => c.requestId === requestId)) {
    err(`undo request '${requestId}' conflicts with an already committed correction request of the same id; nothing was changed`);
    return 1;
  }

  // 目标只能是已成功且尚未撤销的修正;未知或已撤销目标报错,不占用撤销标识。
  const targetIndex = data.corrections.findIndex((c) => c.requestId === targetId);
  if (targetIndex < 0) {
    err(`undo '${requestId}' rejected: unknown correction request '${targetId}'`);
    return 1;
  }
  const target = data.corrections[targetIndex];
  if (target.undone === true) {
    err(`undo '${requestId}' rejected: correction '${targetId}' is already undone`);
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

  // 只恢复目标中实际改变过的读数;同值项不恢复也不阻塞。每个待恢复身份必须
  // 存在、当前值精确等于原替换值,且没有后来尚未撤销、实际改变过该读数的修正
  // (后来改回相同数值也不能绕过来源检查)。
  const changed = target.items.filter((it) => it.expectedMilli !== it.replacementMilli);
  const later = data.corrections.slice(targetIndex + 1).filter((c) => c.undone !== true);
  const errors: string[] = [];
  const toRestore: Array<{ reading: Reading; item: CorrectionItem }> = [];
  for (const it of changed) {
    const at = formatIsoUtc(it.ts);
    const series = byDevice.get(it.device);
    const reading = series?.find((r) => r.ts === it.ts);
    if (reading === undefined) {
      errors.push(`no stored reading for device '${it.device}' at ${at}`);
      continue;
    }
    const blocker = later.find((c) =>
      c.items.some(
        (x) => x.device === it.device && x.ts === it.ts && x.expectedMilli !== x.replacementMilli,
      ),
    );
    if (blocker !== undefined) {
      errors.push(
        `device '${it.device}' at ${at} was later changed by correction '${blocker.requestId}'; undo that request first`,
      );
      continue;
    }
    if (reading.milli !== it.replacementMilli) {
      errors.push(
        `current value mismatch for device '${it.device}' at ${at}: ` +
          `expected ${formatKwh(it.replacementMilli)} kWh but stored ${formatKwh(reading.milli)} kWh`,
      );
      continue;
    }
    toRestore.push({ reading, item: it });
  }
  if (errors.length > 0) {
    for (const e of errors) err(e);
    err(`undo '${requestId}' of correction '${targetId}' rejected: ${errors.length} item(s) failed; nothing was changed`);
    return 1;
  }

  // 恢复为该修正记录的原值,不新增或删除读数;读数恢复、目标已撤销标记与
  // 撤销成功记录同文件原子持久化,写入失败保留操作前全部状态。
  for (const { reading, item } of toRestore) reading.milli = item.expectedMilli;
  target.undone = true;
  const restored = toRestore.length;
  try {
    saveData(storePath, {
      readings: data.readings,
      corrections: data.corrections,
      undos: data.undos.concat([{ requestId, targetId, restored }]),
    });
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  reportUndoSuccess(requestId, targetId, restored);
  return 0;
}

/**
 * 显示修正与撤销历史:修正按成功提交顺序列出各请求及各项设备、时刻、原值和
 * 替换值,已撤销的标注撤销来源;撤销记录另按成功发生顺序列出请求与目标关系。
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
  if (data.corrections.length === 0 && data.undos.length === 0) {
    console.log('no corrections recorded');
    return 0;
  }
  for (const c of data.corrections) {
    const undo = data.undos.find((u) => u.targetId === c.requestId);
    const mark = undo !== undefined ? `  UNDONE by '${undo.requestId}'` : '';
    console.log(`correction '${c.requestId}': ${c.items.length} item(s), ${changedCount(c.items)} reading(s) changed${mark}`);
    for (const it of c.items) {
      console.log(
        `  ${formatIsoUtc(it.ts)}  device=${it.device}  expected=${formatKwh(it.expectedMilli)} kWh  replacement=${formatKwh(it.replacementMilli)} kWh`,
      );
    }
  }
  for (const u of data.undos) {
    console.log(`undo '${u.requestId}': target='${u.targetId}', ${u.restored} reading(s) restored`);
  }
  return 0;
}

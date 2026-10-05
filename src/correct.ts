// correct、undo 与 corrections 三个子命令的实现:可追溯的已存读数批量修正
// 及其整批撤销。
//
// 一次 correct 提交指定非空请求标识及至少一项修正;每项给出设备、实际时刻、
// 预期原读数和替换读数,只修改已有读数的累计值,不新增或删除读数。首次提交
// 逐项核验预期原值与操作前已存值精确一致,全部匹配才整体替换;任一不符整批
// 拒绝,不占用请求标识。读数替换与请求成功记录在同一存储文件中原子持久化,
// 写入失败保留操作前全部状态。同标识同内容重放直接返回原成功结果,不重新
// 校验、不再次替换;同标识异内容报冲突且保持状态。
//
// undo 提交指定非空撤销请求标识及目标修正请求标识,整批撤销一次已成功修正:
// 只恢复目标中实际改变过的读数,将其还原为该修正记录的原值,不新增或删除
// 读数,不允许挑选部分项。每个待恢复身份必须存在、当前值精确等于原替换值,
// 且没有后来尚未撤销、实际改变过该读数的修正;后来改回相同数值也不能绕过
// 来源检查,相关后续修正先撤销后才能再撤销较早请求。同值项不恢复、不阻塞;
// 全部为同值项的目标仍可成功撤销,恢复数为零。任一项不满足条件指出身份和
// 原因、整次拒绝,不占用撤销标识。撤销与修正请求共用唯一标识空间,成功标识
// 绑定操作类型和内容:同撤销标识、同目标重放返回原成功结果,不重新核验、
// 不重复恢复;同标识异内容或跨操作类型复用均报冲突。读数恢复、目标已撤销
// 标记(由撤销记录体现)与撤销成功记录同文件原子持久化,重启后状态一致。

import {
  dataFilePath,
  loadData,
  saveData,
  StoreError,
  type CorrectionItem,
  type Reading,
  type StoreData,
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

function reportUndoSuccess(requestId: string, targetId: string, restored: number): void {
  console.log(`undo '${requestId}' committed: target='${targetId}', ${restored} reading(s) restored`);
}

/** 读取存储;损坏或不可读时报错并返回 null。 */
function loadChecked(storePath: string): StoreData | null {
  try {
    return loadData(storePath);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return null;
    }
    throw e;
  }
}

/**
 * 载入数据并检查全库重复读数身份;任一步失败报错并返回 null。
 * 修正、撤销及历史查询(含重放)都不得绕过该检查。
 */
function loadVerified(storePath: string): { data: StoreData; byDevice: Map<string, Reading[]> } | null {
  const data = loadChecked(storePath);
  if (data === null) return null;
  try {
    return { data, byDevice: loadCheckedSeriesByDevice(data.readings) };
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return null;
    }
    throw e;
  }
}

/** 已被撤销的修正请求标识集合(由撤销记录推导,修正记录本身保持原内容不变)。 */
function undoneTargetIds(data: StoreData): Set<string> {
  return new Set(data.undos.map((u) => u.targetId));
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
  const loaded = loadVerified(storePath);
  if (loaded === null) return 1;
  const { data, byDevice } = loaded;

  // 重放:同标识同内容直接返回原成功结果,不重新校验当前读数、不再次替换
  // (即使这些读数后来又被其他请求修正,或本修正后来被撤销);同标识异内容
  // 报冲突且保持状态。
  const prior = data.corrections.find((c) => c.requestId === requestId);
  if (prior !== undefined) {
    if (itemsEquivalent(prior.items, items)) {
      reportSuccess(requestId, prior.items);
      return 0;
    }
    err(`correction request '${requestId}' conflicts with an already committed request of the same id; nothing was changed`);
    return 1;
  }
  // 撤销与修正共用唯一标识空间:跨操作类型复用标识报冲突。
  if (data.undos.some((u) => u.requestId === requestId)) {
    err(`correction request '${requestId}' conflicts with an already committed undo request of the same id; nothing was changed`);
    return 1;
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

/**
 * 整批撤销一次已成功修正。requestId 与 targetId 均由调用方完成格式解析
 * (非空、已去首尾空白)。返回进程退出码。
 */
export function cmdUndo(requestId: string, targetId: string): number {
  const storePath = dataFilePath();
  const loaded = loadVerified(storePath);
  if (loaded === null) return 1;
  const { data, byDevice } = loaded;

  // 重放:同撤销标识、同目标直接返回原成功结果,不重新核验撤销资格、不重复
  // 恢复;同标识异目标报冲突。修正标识被撤销复用属跨操作类型冲突。
  const priorUndo = data.undos.find((u) => u.requestId === requestId);
  if (priorUndo !== undefined) {
    if (priorUndo.targetId === targetId) {
      reportUndoSuccess(priorUndo.requestId, priorUndo.targetId, priorUndo.restored);
      return 0;
    }
    err(`undo request '${requestId}' conflicts with an already committed undo request of the same id; nothing was changed`);
    return 1;
  }
  if (data.corrections.some((c) => c.requestId === requestId)) {
    err(`undo request '${requestId}' conflicts with an already committed correction request of the same id; nothing was changed`);
    return 1;
  }

  // 目标只能是成功修正,不能是撤销请求;未知或已撤销目标报错。
  const targetIndex = data.corrections.findIndex((c) => c.requestId === targetId);
  if (targetIndex === -1) {
    if (data.undos.some((u) => u.requestId === targetId)) {
      err(`undo target '${targetId}' is an undo request, not a committed correction; nothing was changed`);
    } else {
      err(`unknown correction '${targetId}': no committed correction with that request id; nothing was changed`);
    }
    return 1;
  }
  const undone = undoneTargetIds(data);
  if (undone.has(targetId)) {
    const by = data.undos.find((u) => u.targetId === targetId);
    err(`correction '${targetId}' is already undone by undo '${by?.requestId}'; nothing was changed`);
    return 1;
  }
  const target = data.corrections[targetIndex];

  // 后来尚未撤销、实际改变过某读数身份的修正会阻塞对该身份的恢复;
  // 同值项(预期原值等于替换值)不恢复也不阻塞。
  const blockerByKey = new Map<string, string>();
  for (let i = targetIndex + 1; i < data.corrections.length; i++) {
    const later = data.corrections[i];
    if (undone.has(later.requestId)) continue;
    for (const it of later.items) {
      if (it.expectedMilli !== it.replacementMilli) {
        blockerByKey.set(`${it.device} ${it.ts}`, later.requestId);
      }
    }
  }

  // 核验:每个待恢复身份必须存在、当前值精确等于原替换值、且无阻塞来源。
  const errors: string[] = [];
  const restores: Array<{ reading: Reading; item: CorrectionItem }> = [];
  for (const it of target.items) {
    if (it.expectedMilli === it.replacementMilli) continue;
    const key = `${it.device} ${it.ts}`;
    const series = byDevice.get(it.device);
    const reading = series?.find((r) => r.ts === it.ts);
    if (reading === undefined) {
      errors.push(`no stored reading for device '${it.device}' at ${formatIsoUtc(it.ts)}`);
      continue;
    }
    if (reading.milli !== it.replacementMilli) {
      errors.push(
        `current value mismatch for device '${it.device}' at ${formatIsoUtc(it.ts)}: ` +
          `expected ${formatKwh(it.replacementMilli)} kWh (replacement of '${targetId}') but stored ${formatKwh(reading.milli)} kWh`,
      );
      continue;
    }
    const blocker = blockerByKey.get(key);
    if (blocker !== undefined) {
      errors.push(
        `reading for device '${it.device}' at ${formatIsoUtc(it.ts)} was also changed by later correction '${blocker}' (not yet undone); undo '${blocker}' first`,
      );
      continue;
    }
    restores.push({ reading, item: it });
  }
  if (errors.length > 0) {
    for (const e of errors) err(e);
    err(`undo '${requestId}' of correction '${targetId}' rejected: ${errors.length} item(s) failed; nothing was changed`);
    return 1;
  }

  // 恢复为目标记录的原值;读数恢复与撤销成功记录同文件原子持久化,
  // 目标修正内容保留,已撤销标记由撤销记录体现。
  for (const { reading, item } of restores) reading.milli = item.expectedMilli;
  try {
    saveData(storePath, {
      readings: data.readings,
      corrections: data.corrections,
      undos: data.undos.concat([{ requestId, targetId, restored: restores.length }]),
    });
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  reportUndoSuccess(requestId, targetId, restores.length);
  return 0;
}

/**
 * 按成功提交顺序显示修正历史(请求标识、各项设备、时刻、原值和替换值及
 * 已撤销标记),另按成功发生顺序显示撤销请求与目标关系。只读,不写入数据。
 * 返回进程退出码。
 */
export function cmdCorrections(): number {
  const storePath = dataFilePath();
  const loaded = loadVerified(storePath);
  if (loaded === null) return 1;
  const { data } = loaded;
  if (data.corrections.length === 0 && data.undos.length === 0) {
    console.log('no corrections recorded');
    return 0;
  }
  const undoneBy = new Map(data.undos.map((u) => [u.targetId, u.requestId]));
  for (const c of data.corrections) {
    const undoId = undoneBy.get(c.requestId);
    const marker = undoId === undefined ? '' : `  (undone by '${undoId}')`;
    console.log(
      `correction '${c.requestId}': ${c.items.length} item(s), ${changedCount(c.items)} reading(s) changed${marker}`,
    );
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

// 整库备份与恢复:把三个业务存储(readings.json / alerts.json / groups.json)
// 导出为带格式版本与完整性校验的单个快照文件,或从快照整库替换恢复。
//
// - 快照完整保留累计读数、修正与撤销请求及顺序、分组成员版本、设备和分组
//   规则及时区、告警标识、检测与确认状态、事件顺序和当时消耗,以及后续编号
//   所需状态(nextAlertNum / nextEventSeq);毫千瓦时数值以十进制字符串精确
//   保存,任意大数不丢失精度。快照带格式版本与 SHA-256 完整性校验。
// - 快照文件必须位于数据目录之外;备份的输出文件必须事先不存在(拒绝覆盖),
//   经临时文件 + 硬链接原子落位,失败不留下可被当作成功快照的输出;备份只读
//   业务数据,不改写任何存储。
// - 备份与恢复都检查三个存储的结构和关联:全库重复读数身份、修正项引用缺失
//   读数、撤销引用缺失修正、成员或规则目标不存在、告警引用缺失规则,指出
//   原因并拒绝。恢复先校验格式版本与完整性(不支持的版本、截断、校验不符或
//   不可读时不开始替换),可用于当前存储已损坏的目录,不要求原库能解析。
// - 恢复为整库替换:成功后业务状态完全等于快照,快照为空的部分清除原数据,
//   快照之后新增的读数、请求和告警不保留;只替换三个业务存储,目录内其他
//   文件保持不变;不自动评估或重新生成历史。
// - 三个存储作为一次提交:先把新内容写入临时文件,现有存储改名为备份,写
//   提交日志后逐个换入,最后清理备份与日志。读写或重命名失败回退到恢复前
//   全部状态;提交中断后,任一命令再次启动先按日志恢复为完整旧状态或完整
//   快照状态(日志可解析为提交中则前滚,否则回退),无法完成时明确报错,
//   不查询或修改混合状态。

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  alertFilePath,
  dataDirPath,
  dataFilePath,
  groupFilePath,
  parseStoreDataJson,
  serializeStoreData,
  StoreError,
  type StoreData,
} from './store.ts';
import { loadCheckedSeriesByDevice, parseGroupsJson, serializeGroups, type Group } from './groups.ts';
import { emptyAlertState, parseAlertStateJson, serializeAlertState, type AlertState } from './alerts.ts';
import { formatIsoUtc } from './time.ts';

const SNAPSHOT_FORMAT = 'meterwatch-snapshot';
const SNAPSHOT_VERSION = 1;

/** 三个业务存储文件名,恢复时作为一次提交整体替换。 */
const STORE_FILES = ['readings.json', 'alerts.json', 'groups.json'] as const;
type StoreFile = (typeof STORE_FILES)[number];

/** 恢复提交日志:存在表示一次恢复提交被中断,下次启动须先恢复。 */
const JOURNAL_FILE = 'restore.journal';
/** 恢复期间新内容临时文件后缀(与提交日志配合用于中断恢复)。 */
const NEW_SUFFIX = '.restore-new';
/** 恢复期间旧存储的备份后缀(用于失败回退与中断恢复)。 */
const OLD_SUFFIX = '.restore-old';

interface AllStores {
  data: StoreData;
  alerts: AlertState;
  groups: Group[];
}

function err(message: string): void {
  console.error(`meterwatch: ${message}`);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 文件是否位于目录之内(含目录本身)。 */
function isInsideDir(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 读取存储文件文本;不存在返回 null(对应空状态),其他读取失败抛 StoreError。 */
function readStoreText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StoreError(`cannot read storage file ${path}: ${(e as Error).message}`);
  }
}

/** 读取当前数据目录的三个业务存储;缺失文件按空状态,损坏或不可读抛 StoreError。 */
function readAllStores(): AllStores {
  const readingsText = readStoreText(dataFilePath());
  const alertsText = readStoreText(alertFilePath());
  const groupsText = readStoreText(groupFilePath());
  return {
    data:
      readingsText === null
        ? { readings: [], corrections: [], undos: [] }
        : parseStoreDataJson(readingsText, dataFilePath()),
    alerts: alertsText === null ? emptyAlertState() : parseAlertStateJson(alertsText, alertFilePath()),
    groups: groupsText === null ? [] : parseGroupsJson(groupsText, groupFilePath()),
  };
}

/**
 * 三个业务存储之间的关联完整性检查;返回全部问题原因,空数组表示通过。
 * 结构合法性由各自的解析器保证,这里检查跨存储引用与全库读数身份唯一性。
 */
function relationErrors(stores: AllStores): string[] {
  const errors: string[] = [];
  // 全库重复读数身份(同一设备同一实际时刻多条存储记录)。
  try {
    loadCheckedSeriesByDevice(stores.data.readings);
  } catch (e) {
    if (e instanceof StoreError) errors.push(e.message);
    else throw e;
  }
  const readingKeys = new Set(stores.data.readings.map((r) => `${r.device} ${r.ts}`));
  const devices = new Set(stores.data.readings.map((r) => r.device));
  // 修正项必须引用已存读数。
  for (const c of stores.data.corrections) {
    for (const it of c.items) {
      if (!readingKeys.has(`${it.device} ${it.ts}`)) {
        errors.push(
          `correction '${c.requestId}' references missing reading for device '${it.device}' at ${formatIsoUtc(it.ts)}`,
        );
      }
    }
  }
  // 撤销必须引用已存修正。
  const correctionIds = new Set(stores.data.corrections.map((c) => c.requestId));
  for (const u of stores.data.undos) {
    if (!correctionIds.has(u.targetId)) {
      errors.push(`undo '${u.requestId}' references missing correction '${u.targetId}'`);
    }
  }
  // 分组成员必须是有读数的设备。
  const groupIds = new Set(stores.groups.map((g) => g.id));
  for (const g of stores.groups) {
    for (const v of g.versions) {
      for (const m of v.members) {
        if (!devices.has(m)) {
          errors.push(`group '${g.id}' member '${m}' has no stored readings`);
        }
      }
    }
  }
  // 规则目标必须存在:设备规则需有读数,分组规则需已配置。
  for (const r of stores.alerts.rules) {
    if (r.targetType === 'device' && !devices.has(r.targetId)) {
      errors.push(`rule '${r.id}' targets device '${r.targetId}' which has no stored readings`);
    } else if (r.targetType === 'group' && !groupIds.has(r.targetId)) {
      errors.push(`rule '${r.id}' targets unknown group '${r.targetId}'`);
    }
  }
  // 告警必须引用已存规则。
  const ruleIds = new Set(stores.alerts.rules.map((r) => r.id));
  for (const a of stores.alerts.alerts) {
    if (!ruleIds.has(a.ruleId)) {
      errors.push(`alert '${a.id}' references missing rule '${a.ruleId}'`);
    }
  }
  return errors;
}

function summaryLine(stores: AllStores): string {
  const versions = stores.groups.reduce((n, g) => n + g.versions.length, 0);
  return (
    `${stores.data.readings.length} reading(s), ${stores.data.corrections.length} correction(s), ` +
    `${stores.data.undos.length} undo(s), ${stores.groups.length} group(s) (${versions} version(s)), ` +
    `${stores.alerts.rules.length} rule(s), ${stores.alerts.alerts.length} alert(s)`
  );
}

type StoreBodies = Record<StoreFile, string>;

/** 由三个存储文件内容构造快照文本(格式版本 + 完整性校验)。 */
function buildSnapshot(bodies: StoreBodies): string {
  const stores = {
    'readings.json': bodies['readings.json'],
    'alerts.json': bodies['alerts.json'],
    'groups.json': bodies['groups.json'],
  };
  const checksum = `sha256:${sha256(JSON.stringify(stores))}`;
  return (
    JSON.stringify({ format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION, stores, checksum }, null, 2) + '\n'
  );
}

/**
 * 回退到恢复前状态:删除新内容临时文件,旧存储备份改名回原位
 * (原本不存在的存储删除对应新文件)。改名失败抛出异常。
 */
function rollBack(dir: string): void {
  for (const f of STORE_FILES) {
    try {
      unlinkSync(join(dir, f + NEW_SUFFIX));
    } catch {
      // 临时文件可能不存在,忽略。
    }
  }
  for (const f of STORE_FILES) {
    const oldPath = join(dir, f + OLD_SUFFIX);
    if (existsSync(oldPath)) {
      renameSync(oldPath, join(dir, f));
    } else {
      try {
        unlinkSync(join(dir, f));
      } catch {
        // 目标可能不存在,忽略。
      }
    }
  }
}

/**
 * 把三个业务存储作为一次提交整体替换为 bodies 的内容。
 * 失败时回退到恢复前全部状态并返回错误消息;成功返回 null。
 */
function commitRestore(bodies: StoreBodies): string | null {
  const dir = dataDirPath();
  mkdirSync(dir, { recursive: true });
  const target = (f: StoreFile): string => join(dir, f);
  const tmp = (f: StoreFile): string => join(dir, f + NEW_SUFFIX);
  const old = (f: StoreFile): string => join(dir, f + OLD_SUFFIX);
  const journal = join(dir, JOURNAL_FILE);
  const cleanupTemps = (): void => {
    for (const f of STORE_FILES) {
      try {
        unlinkSync(tmp(f));
      } catch {
        // 临时文件可能未写出,忽略。
      }
    }
  };

  // 1. 新内容写入临时文件并落盘;失败不触碰现有存储。
  try {
    for (const f of STORE_FILES) {
      writeFileSync(tmp(f), bodies[f], 'utf8');
      fsyncFile(tmp(f));
    }
  } catch (e) {
    cleanupTemps();
    return `cannot write restore temp files in ${dir}: ${(e as Error).message}; previous state preserved`;
  }

  // 2. 现有存储改名为备份,保留旧状态用于失败回退与中断恢复。
  const backedUp: StoreFile[] = [];
  try {
    for (const f of STORE_FILES) {
      if (existsSync(target(f))) {
        renameSync(target(f), old(f));
        backedUp.push(f);
      }
    }
  } catch (e) {
    for (const f of backedUp) {
      try {
        renameSync(old(f), target(f));
      } catch {
        // 尽力回退;失败由下次启动的恢复流程处理。
      }
    }
    cleanupTemps();
    return `cannot prepare restore in ${dir}: ${(e as Error).message}; previous state preserved`;
  }

  // 3. 提交日志:此后的中断由下次启动的恢复流程收敛到完整状态。
  try {
    writeFileSync(journal, `${JSON.stringify({ phase: 'committing' })}\n`, 'utf8');
    fsyncFile(journal);
  } catch (e) {
    for (const f of backedUp) {
      try {
        renameSync(old(f), target(f));
      } catch {
        // 尽力回退。
      }
    }
    cleanupTemps();
    return `cannot write restore journal in ${dir}: ${(e as Error).message}; previous state preserved`;
  }

  // 4. 逐个换入新存储;失败回退到恢复前全部状态。
  try {
    for (const f of STORE_FILES) renameSync(tmp(f), target(f));
  } catch (e) {
    let rollbackError: string | null = null;
    try {
      writeFileSync(journal, `${JSON.stringify({ phase: 'rolling-back' })}\n`, 'utf8');
      rollBack(dir);
      unlinkSync(journal);
    } catch (re) {
      rollbackError = (re as Error).message;
    }
    if (rollbackError === null) {
      return `restore failed during commit: ${(e as Error).message}; previous state preserved`;
    }
    return (
      `restore failed during commit: ${(e as Error).message}; ` +
      `could not restore previous state (${rollbackError}); recovery will run on next start`
    );
  }

  // 5. 清理备份与日志,提交完成。
  for (const f of STORE_FILES) {
    try {
      unlinkSync(old(f));
    } catch {
      // 备份可能不存在,忽略。
    }
  }
  try {
    unlinkSync(journal);
  } catch {
    // 日志清理失败时,下次启动的恢复流程会按提交完成处理(临时文件已不存在)。
  }
  return null;
}

/**
 * 启动时恢复被中断的恢复提交:日志可解析为提交中则前滚为完整快照状态,
 * 否则回退为完整旧状态。无需恢复或恢复成功返回 null;无法完成返回错误消息。
 */
export function recoverInterruptedRestore(): string | null {
  const dir = dataDirPath();
  const journal = join(dir, JOURNAL_FILE);
  if (!existsSync(journal)) return null;
  // 日志不可解析时按回退处理:此时旧存储备份齐全,可收敛到完整旧状态。
  let phase = 'rolling-back';
  try {
    const j = JSON.parse(readFileSync(journal, 'utf8')) as { phase?: unknown };
    if (j !== null && typeof j === 'object' && j.phase === 'committing') phase = 'committing';
  } catch {
    // 按回退处理。
  }
  try {
    if (phase === 'committing') {
      // 前滚:换入尚未就位的新存储(已换入的临时文件不存在,自然跳过)。
      for (const f of STORE_FILES) {
        const t = join(dir, f + NEW_SUFFIX);
        if (existsSync(t)) renameSync(t, join(dir, f));
      }
      for (const f of STORE_FILES) {
        try {
          unlinkSync(join(dir, f + OLD_SUFFIX));
        } catch {
          // 备份可能不存在,忽略。
        }
      }
    } else {
      rollBack(dir);
    }
    unlinkSync(journal);
  } catch (e) {
    return `cannot complete recovery of an interrupted restore in ${dir}: ${(e as Error).message}`;
  }
  console.error(`meterwatch: completed recovery of an interrupted restore in ${dir}; storage is consistent`);
  return null;
}

/**
 * 整库备份:把当前三个业务存储导出为带格式版本与完整性校验的快照文件。
 * 只读业务数据;输出文件必须位于数据目录之外且事先不存在。返回进程退出码。
 */
export function cmdBackup(snapshotArg: string): number {
  const dir = resolve(dataDirPath());
  const snap = resolve(snapshotArg);
  if (isInsideDir(dir, snap)) {
    err(`snapshot file must be outside the data directory ('${snap}' is inside '${dir}')`);
    return 2;
  }
  if (existsSync(snap)) {
    err(`output file '${snap}' already exists; refusing to overwrite`);
    return 1;
  }

  let stores: AllStores;
  try {
    stores = readAllStores();
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  const problems = relationErrors(stores);
  if (problems.length > 0) {
    for (const p of problems) err(p);
    err(`backup rejected: current storage failed ${problems.length} integrity check(s); no snapshot was written`);
    return 1;
  }

  const body = buildSnapshot({
    'readings.json': serializeStoreData(stores.data),
    'alerts.json': serializeAlertState(stores.alerts),
    'groups.json': serializeGroups(stores.groups),
  });

  // 临时文件 + 硬链接原子落位:目标已存在则失败,不覆盖、不留下半成品输出。
  try {
    mkdirSync(dirname(snap), { recursive: true });
    const tmp = `${snap}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, body, 'utf8');
      fsyncFile(tmp);
      linkSync(tmp, snap);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // 临时文件可能未写出,忽略。
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      err(`output file '${snap}' already exists; refusing to overwrite`);
    } else {
      err(`cannot write snapshot '${snap}': ${(e as Error).message}`);
    }
    return 1;
  }
  console.log(`snapshot written to '${snap}': ${summaryLine(stores)}`);
  return 0;
}

/**
 * 整库恢复:先校验快照的格式版本与完整性,再检查快照内容的结构和关联,
 * 全部通过后把三个业务存储作为一次提交整体替换。返回进程退出码。
 */
export function cmdRestore(snapshotArg: string): number {
  const dir = resolve(dataDirPath());
  const snap = resolve(snapshotArg);
  if (isInsideDir(dir, snap)) {
    err(`snapshot file must be outside the data directory ('${snap}' is inside '${dir}')`);
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(snap, 'utf8');
  } catch (e) {
    err(`cannot read snapshot '${snap}': ${(e as Error).message}; nothing was restored`);
    return 1;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    err(`snapshot '${snap}' is corrupted or truncated (invalid JSON); nothing was restored`);
    return 1;
  }
  const o = parsed as Record<string, unknown>;
  if (o === null || typeof o !== 'object' || o.format !== SNAPSHOT_FORMAT) {
    err(`snapshot '${snap}' has an unrecognized format; nothing was restored`);
    return 1;
  }
  if (o.version !== SNAPSHOT_VERSION) {
    err(
      `snapshot '${snap}' has unsupported version ${String(o.version)} ` +
        `(this build supports version ${SNAPSHOT_VERSION}); nothing was restored`,
    );
    return 1;
  }
  const s = o.stores as Record<string, unknown> | null;
  if (s === null || typeof s !== 'object' || STORE_FILES.some((f) => typeof s[f] !== 'string')) {
    err(`snapshot '${snap}' is corrupted (missing store payloads); nothing was restored`);
    return 1;
  }
  const bodies: StoreBodies = {
    'readings.json': s['readings.json'] as string,
    'alerts.json': s['alerts.json'] as string,
    'groups.json': s['groups.json'] as string,
  };
  const expectedChecksum = `sha256:${sha256(JSON.stringify(bodies))}`;
  if (o.checksum !== expectedChecksum) {
    err(`snapshot '${snap}' failed integrity check (checksum mismatch); nothing was restored`);
    return 1;
  }

  // 快照内容的结构与关联检查;任何一步失败都不得开始替换。
  let stores: AllStores;
  try {
    stores = {
      data: parseStoreDataJson(bodies['readings.json'], `${snap}#readings.json`),
      alerts: parseAlertStateJson(bodies['alerts.json'], `${snap}#alerts.json`),
      groups: parseGroupsJson(bodies['groups.json'], `${snap}#groups.json`),
    };
  } catch (e) {
    if (e instanceof StoreError) {
      err(`snapshot '${snap}' contains invalid data: ${e.message}; nothing was restored`);
      return 1;
    }
    throw e;
  }
  const problems = relationErrors(stores);
  if (problems.length > 0) {
    for (const p of problems) err(p);
    err(`snapshot '${snap}' rejected: ${problems.length} integrity problem(s); nothing was restored`);
    return 1;
  }

  const commitError = commitRestore(bodies);
  if (commitError !== null) {
    err(commitError);
    return 1;
  }
  console.log(
    `restored from '${snap}': ${summaryLine(stores)}; ` +
      `business state now matches the snapshot (no re-evaluation performed)`,
  );
  return 0;
}

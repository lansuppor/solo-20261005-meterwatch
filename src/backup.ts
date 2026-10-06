// 本地整库备份与恢复:导出快照(backup)与从快照整库恢复(restore)。
//
// - 快照为单个 JSON 文件,含格式标识、格式版本、负载的 SHA-256 完整性校验和
//   及三个业务存储(读数与修正/撤销历史、告警规则与历史、分组成员版本)的
//   完整内容;毫千瓦时为十进制字符串,任意大数精确保留。快照文件必须位于
//   数据目录之外;已有输出文件拒绝覆盖(原子无覆盖创建),备份失败不留下
//   可被当作成功快照的输出(先写临时文件再原子链接为最终名)。
// - 备份与恢复都校验三个业务存储的结构与关联:全库重复读数身份、修正项引用
//   缺失读数、撤销引用缺失修正、分组成员或规则目标不存在、告警引用缺失规则,
//   任一问题指出原因并拒绝。缺失的存储文件按对应空状态处理。
// - 恢复为整库替换:成功后业务状态完全等于快照,快照为空的部分清除原数据,
//   快照之后新增的读数、请求和告警不保留;只替换三个业务存储文件,目录内
//   其他文件保持不变;不自动评估或重新生成历史。恢复可用于当前存储已损坏
//   的目录,不解析原库。
// - 三个业务存储作为一次恢复提交:先写全部新内容到临时文件,再写恢复日志
//   (journal),然后整体换名提交,最后清理。读写或重命名失败回滚为恢复前
//   全部状态;进程在提交中断后,任一命令再次启动时先按日志前滚为完整快照
//   状态或回滚为完整旧状态,绝不查询或修改混合状态,无法完成时明确报错。
// - 备份与恢复执行期间对数据目录持有排他锁(锁文件,进程退出即 stale 可判),
//   不与其他进程同时读写同一目录。

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  linkSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  alertFilePath,
  dataDirPath,
  dataFilePath,
  groupFilePath,
  loadData,
  parseStoreData,
  serializeStoreData,
  StoreError,
  type StoreData,
} from './store.ts';
import {
  loadAlertState,
  parseAlertState,
  serializeAlertState,
  type AlertState,
} from './alerts.ts';
import { loadGroups, parseGroups, serializeGroups, type Group } from './groups.ts';
import { formatIsoUtc } from './time.ts';

const SNAPSHOT_FORMAT = 'meterwatch-snapshot';
const SNAPSHOT_VERSION = 1;

const LOCK_NAME = 'backup-restore.lock';
const JOURNAL_NAME = 'restore.journal';
const JOURNAL_FORMAT = 'meterwatch-restore-journal';
const NEW_SUFFIX = '.restore-new';
const OLD_SUFFIX = '.restore-old';

function err(message: string): void {
  console.error(`meterwatch: ${message}`);
}

/** 三个业务存储文件的绝对路径(顺序固定,恢复作为一次提交)。 */
function storeFiles(): string[] {
  return [dataFilePath(), alertFilePath(), groupFilePath()];
}

/** 快照路径是否位于数据目录之内(含等于目录本身)。 */
function isInsideDir(dir: string, p: string): boolean {
  const rel = relative(resolve(dir), resolve(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 校验三个业务存储的关联一致性(结构合法性由各自的解析函数保证)。
 * 返回问题列表,空数组表示一致。
 */
function validateStores(data: StoreData, alerts: AlertState, groups: Group[]): string[] {
  const problems: string[] = [];

  // 全库重复读数身份:同一设备同一实际时刻只允许一条存储记录。
  const readingKeys = new Set<string>();
  for (const r of data.readings) {
    const k = `${r.device} ${r.ts}`;
    if (readingKeys.has(k)) {
      problems.push(`duplicate stored reading for device '${r.device}' at ${formatIsoUtc(r.ts)}`);
    } else {
      readingKeys.add(k);
    }
  }

  // 修正项必须引用已存读数。
  for (const c of data.corrections) {
    for (const it of c.items) {
      if (!readingKeys.has(`${it.device} ${it.ts}`)) {
        problems.push(
          `correction '${c.requestId}' references missing reading ` +
            `(device='${it.device}' at ${formatIsoUtc(it.ts)})`,
        );
      }
    }
  }

  // 撤销必须引用已存修正。
  const correctionIds = new Set(data.corrections.map((c) => c.requestId));
  for (const u of data.undos) {
    if (!correctionIds.has(u.targetId)) {
      problems.push(`undo '${u.requestId}' references missing correction '${u.targetId}'`);
    }
  }

  // 分组成员必须是已有读数的设备。
  const devices = new Set(data.readings.map((r) => r.device));
  for (const g of groups) {
    for (const v of g.versions) {
      for (const m of v.members) {
        if (!devices.has(m)) {
          problems.push(`group '${g.id}' member '${m}' has no stored readings`);
        }
      }
    }
  }

  // 规则目标必须存在:设备规则绑定有读数的设备,分组规则绑定已配置分组。
  const groupIds = new Set(groups.map((g) => g.id));
  for (const r of alerts.rules) {
    if (r.targetType === 'device' && !devices.has(r.targetId)) {
      problems.push(`rule '${r.id}' targets device '${r.targetId}' which has no stored readings`);
    }
    if (r.targetType === 'group' && !groupIds.has(r.targetId)) {
      problems.push(`rule '${r.id}' targets unknown group '${r.targetId}'`);
    }
  }

  // 告警必须引用已存规则。
  const ruleIds = new Set(alerts.rules.map((r) => r.id));
  for (const a of alerts.alerts) {
    if (!ruleIds.has(a.ruleId)) {
      problems.push(`alert '${a.id}' references missing rule '${a.ruleId}'`);
    }
  }

  return problems;
}

/**
 * 获取数据目录的排他锁;成功返回 null,失败返回错误消息。
 * 锁文件已存在且属存活进程时拒绝;属已退出进程时清理后重试一次。
 */
function acquireLock(dir: string): string | null {
  const lockPath = join(dir, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return null;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        return `cannot acquire lock ${lockPath}: ${(e as Error).message}`;
      }
      let pid = Number.NaN;
      try {
        pid = Number(readFileSync(lockPath, 'utf8').trim());
      } catch {
        // 读不出属主按存活处理,不冒险清理。
      }
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (ke) {
          alive = (ke as NodeJS.ErrnoException).code === 'EPERM';
        }
      }
      if (alive) {
        return (
          `another backup/restore process${Number.isInteger(pid) && pid > 0 ? ` (pid ${pid})` : ''} ` +
          `is operating on data directory ${dir}; wait for it to finish`
        );
      }
      try {
        rmSync(lockPath);
      } catch (re) {
        return `cannot remove stale lock ${lockPath}: ${(re as Error).message}`;
      }
    }
  }
  return `cannot acquire lock ${join(dir, LOCK_NAME)}`;
}

function releaseLock(dir: string): void {
  try {
    rmSync(join(dir, LOCK_NAME));
  } catch {
    // 锁文件可能已被清理;释放失败不影响已完成的操作。
  }
}

interface JournalFile {
  name: string;
  hadOld: boolean;
}

interface Journal {
  files: JournalFile[];
}

/** 解析恢复日志;结构非法返回 null(调用方按无法恢复处理,不猜测)。 */
function parseJournal(data: unknown): Journal | null {
  const o = data as Record<string, unknown>;
  if (
    o === null ||
    typeof o !== 'object' ||
    o.format !== JOURNAL_FORMAT ||
    o.version !== 1 ||
    !Array.isArray(o.files) ||
    o.files.length === 0
  ) {
    return null;
  }
  const files: JournalFile[] = [];
  for (const f of o.files as Array<Record<string, unknown>>) {
    if (
      f === null ||
      typeof f !== 'object' ||
      typeof f.name !== 'string' ||
      f.name.length === 0 ||
      typeof f.hadOld !== 'boolean'
    ) {
      return null;
    }
    files.push({ name: f.name, hadOld: f.hadOld });
  }
  return { files };
}

/**
 * 回滚到恢复前状态:凡有旧文件备份的换回原文件,原本不存在的文件删除新文件;
 * 清理临时文件与日志。任何一步失败抛错。
 */
function rollback(dir: string, journal: Journal): void {
  for (const f of journal.files) {
    const target = join(dir, f.name);
    const oldPath = target + OLD_SUFFIX;
    const newPath = target + NEW_SUFFIX;
    if (existsSync(oldPath)) {
      // 旧文件备份必为常规文件(本进程只会写出常规文件);否则按被篡改处理,不猜测。
      if (!statSync(oldPath).isFile()) {
        throw new StoreError(`restore backup ${oldPath} is not a regular file`);
      }
      if (existsSync(target)) rmSync(target);
      renameSync(oldPath, target);
    } else if (!f.hadOld && !existsSync(newPath) && existsSync(target)) {
      // 新文件已被换入且原本不存在:删除以恢复原状。
      rmSync(target);
    } else if (f.hadOld && !existsSync(target)) {
      // 日志称原有旧文件,但旧备份与原文件都不在:状态不一致,不猜测。
      throw new StoreError(`cannot roll back ${target}: both the original and its backup are missing`);
    }
  }
  for (const f of journal.files) {
    const newPath = join(dir, f.name) + NEW_SUFFIX;
    if (existsSync(newPath)) {
      try {
        rmSync(newPath);
      } catch {
        // 残留的临时文件不影响业务状态,下次启动再清理。
      }
    }
  }
  rmSync(join(dir, JOURNAL_NAME));
}

/**
 * 前滚到完整快照状态:把仍待换入的新文件换入,删除日志与旧文件备份。
 * 任何一步失败抛错。
 */
function rollForward(dir: string, journal: Journal): void {
  for (const f of journal.files) {
    const newPath = join(dir, f.name) + NEW_SUFFIX;
    if (existsSync(newPath)) {
      // 待换入的新内容必为常规文件(本进程只会写出常规文件);否则按被篡改
      // 处理,中止前滚,由调用方回退或报错,绝不把异常内容当作业务存储。
      if (!statSync(newPath).isFile()) {
        throw new StoreError(`restore temp file ${newPath} is not a regular file`);
      }
      renameSync(newPath, join(dir, f.name));
    }
  }
  // 前滚完成后每个业务存储都必须就位;缺失说明状态被外部破坏,中止并交由
  // 调用方回退或报错,绝不删除旧文件备份。
  for (const f of journal.files) {
    if (!existsSync(join(dir, f.name))) {
      throw new StoreError(`restore temp file for ${f.name} is missing; cannot complete the commit`);
    }
  }
  rmSync(join(dir, JOURNAL_NAME));
  for (const f of journal.files) {
    const oldPath = join(dir, f.name) + OLD_SUFFIX;
    if (existsSync(oldPath)) rmSync(oldPath);
  }
}

/**
 * 任一命令启动时调用:若上次恢复在提交中断,先把数据目录恢复为完整快照
 * 状态(优先)或完整旧状态,绝不留下混合状态。成功(或无需恢复)返回 null,
 * 无法完成返回错误消息。
 */
export function recoverInterruptedRestore(): string | null {
  const dir = dataDirPath();
  const journalPath = join(dir, JOURNAL_NAME);
  if (existsSync(journalPath)) {
    let journal: Journal | null = null;
    try {
      journal = parseJournal(JSON.parse(readFileSync(journalPath, 'utf8')));
    } catch {
      journal = null;
    }
    if (journal === null) {
      return (
        `cannot recover data directory ${dir}: restore journal ${journalPath} is unreadable or invalid; ` +
        `the directory may hold a mixed state, restore it manually from a snapshot`
      );
    }
    try {
      rollForward(dir, journal);
      console.error('meterwatch: completed an interrupted restore: snapshot state committed');
      return null;
    } catch {
      // 前滚失败则尝试回滚为完整旧状态。
    }
    try {
      rollback(dir, journal);
      console.error('meterwatch: rolled back an interrupted restore: previous state preserved');
      return null;
    } catch (e) {
      return (
        `cannot recover data directory ${dir} to a consistent state: ${(e as Error).message}; ` +
        `restore it manually from a snapshot`
      );
    }
  }
  // 无日志:提交要么未开始(可能残留新临时文件),要么已完整完成(可能残留旧文件
  // 备份);两种残留都不影响业务状态,清理即可。清理失败明确报错,不继续启动。
  for (const path of storeFiles()) {
    for (const leftover of [path + NEW_SUFFIX, path + OLD_SUFFIX]) {
      if (existsSync(leftover)) {
        try {
          rmSync(leftover);
        } catch (e) {
          return `cannot clean up interrupted restore leftover ${leftover}: ${(e as Error).message}`;
        }
      }
    }
  }
  return null;
}

/**
 * 把三个业务存储的新内容作为一次恢复提交。失败抛 StoreError 并尽力回滚为
 * 提交前状态;回滚也失败时错误中明确说明目录可能处于混合状态。
 */
function commitRestore(dir: string, files: Array<{ path: string; body: string }>): void {
  const journalPath = join(dir, JOURNAL_NAME);
  const journal: Journal = {
    files: files.map((f) => ({ name: basename(f.path), hadOld: existsSync(f.path) })),
  };

  // 阶段一:写全部新内容到临时文件,再原子写入恢复日志。此阶段失败或中断
  // 不影响现有业务文件;残留的临时文件由下次启动清理。
  try {
    for (const f of files) {
      writeFileSync(f.path + NEW_SUFFIX, f.body, 'utf8');
    }
    const journalTmp = `${journalPath}.tmp-${process.pid}`;
    writeFileSync(
      journalTmp,
      JSON.stringify({ format: JOURNAL_FORMAT, version: 1, files: journal.files }, null, 2) + '\n',
      'utf8',
    );
    renameSync(journalTmp, journalPath);
  } catch (e) {
    for (const f of files) {
      try {
        rmSync(f.path + NEW_SUFFIX);
      } catch {
        // 清理失败不掩盖原始错误。
      }
    }
    throw new StoreError(`cannot prepare restore in ${dir}: ${(e as Error).message}; nothing was changed`);
  }

  // 阶段二:整体换名提交(旧文件换为备份,新文件换入),然后删除日志与备份。
  // 此阶段中断由下次启动按日志前滚或回滚;受控失败按已完成的步骤精确回滚
  // (只动本次自己换名的文件,不触碰目录内任何其他文件)。
  const movedToOld: string[] = [];
  const movedIn: string[] = [];
  try {
    for (const f of files) {
      if (existsSync(f.path)) {
        renameSync(f.path, f.path + OLD_SUFFIX);
        movedToOld.push(f.path);
      }
    }
    for (const f of files) {
      renameSync(f.path + NEW_SUFFIX, f.path);
      movedIn.push(f.path);
    }
    rmSync(journalPath);
    for (const f of files) {
      if (existsSync(f.path + OLD_SUFFIX)) rmSync(f.path + OLD_SUFFIX);
    }
  } catch (e) {
    try {
      // 撤销已换入的新文件,再把已换出的旧文件换回原位;未完成的步骤不动。
      for (const path of movedIn) {
        if (existsSync(path)) rmSync(path);
      }
      for (const path of movedToOld) {
        renameSync(path + OLD_SUFFIX, path);
      }
      for (const f of files) {
        if (existsSync(f.path + NEW_SUFFIX)) rmSync(f.path + NEW_SUFFIX);
      }
      rmSync(journalPath);
    } catch (re) {
      throw new StoreError(
        `restore failed (${(e as Error).message}) and rollback also failed (${(re as Error).message}); ` +
          `data directory ${dir} may be in a mixed state, restore it manually from a snapshot`,
      );
    }
    throw new StoreError(`restore failed: ${(e as Error).message}; previous state preserved`);
  }
}

/** 各存储内容汇总的一行数量报告。 */
function countsReport(data: StoreData, alerts: AlertState, groups: Group[]): string {
  const versions = groups.reduce((n, g) => n + g.versions.length, 0);
  return (
    `${data.readings.length} reading(s), ${data.corrections.length} correction(s), ` +
    `${data.undos.length} undo(s), ${groups.length} group(s) (${versions} member version(s)), ` +
    `${alerts.rules.length} rule(s), ${alerts.alerts.length} alert(s)`
  );
}

/**
 * 导出全库快照。只读取业务存储,不改写业务数据;输出文件必须位于数据目录
 * 之外且不得已存在。返回进程退出码。
 */
export function cmdBackup(outPath: string): number {
  const dir = dataDirPath();
  if (isInsideDir(dir, outPath)) {
    err(`snapshot file '${outPath}' must be located outside the data directory ${dir}`);
    return 2;
  }

  mkdirSync(dir, { recursive: true });
  const lockError = acquireLock(dir);
  if (lockError !== null) {
    err(lockError);
    return 1;
  }
  try {
    let data: StoreData;
    let alerts: AlertState;
    let groups: Group[];
    try {
      data = loadData(dataFilePath());
      alerts = loadAlertState(alertFilePath());
      groups = loadGroups(groupFilePath());
    } catch (e) {
      if (e instanceof StoreError) {
        err(e.message);
        return 1;
      }
      throw e;
    }

    const problems = validateStores(data, alerts, groups);
    if (problems.length > 0) {
      for (const p of problems) err(p);
      err(`backup rejected: ${problems.length} consistency problem(s); no snapshot was written`);
      return 1;
    }

    const payload = {
      readings: serializeStoreData(data),
      alerts: serializeAlertState(alerts),
      groups: serializeGroups(groups),
    };
    const checksum = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
    const body =
      JSON.stringify(
        {
          format: SNAPSHOT_FORMAT,
          version: SNAPSHOT_VERSION,
          checksum: `sha256:${checksum}`,
          payload,
        },
        null,
        2,
      ) + '\n';

    // 先写临时文件,再原子链接为最终名:已存在的输出拒绝覆盖,失败不留下
    // 可被当作成功快照的输出。
    const out = resolve(outPath);
    const tmp = `${out}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, body, 'utf8');
      linkSync(tmp, out);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        err(`output file '${outPath}' already exists; refusing to overwrite`);
      } else {
        err(`cannot write snapshot '${outPath}': ${(e as Error).message}`);
      }
      return 1;
    } finally {
      try {
        rmSync(tmp);
      } catch {
        // 临时文件可能未创建;清理失败不影响结果。
      }
    }

    console.log(`snapshot written to '${outPath}': ${countsReport(data, alerts, groups)}`);
    return 0;
  } finally {
    releaseLock(dir);
  }
}

/**
 * 从快照整库恢复。快照须通过格式版本与完整性校验,且三个业务存储的结构与
 * 关联一致,否则不开始替换。成功后业务状态完全等于快照。返回进程退出码。
 */
export function cmdRestore(snapshotPath: string): number {
  const dir = dataDirPath();
  if (isInsideDir(dir, snapshotPath)) {
    err(`snapshot file '${snapshotPath}' must be located outside the data directory ${dir}`);
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(resolve(snapshotPath), 'utf8');
  } catch (e) {
    err(`cannot read snapshot '${snapshotPath}': ${(e as Error).message}`);
    return 1;
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    err(`snapshot '${snapshotPath}' is corrupted (invalid JSON or truncated); nothing was restored`);
    return 1;
  }
  const env = envelope as Record<string, unknown>;
  if (env === null || typeof env !== 'object' || env.format !== SNAPSHOT_FORMAT) {
    err(`snapshot '${snapshotPath}' is not a meterwatch snapshot; nothing was restored`);
    return 1;
  }
  if (env.version !== SNAPSHOT_VERSION) {
    err(
      `snapshot '${snapshotPath}' has unsupported format version ${String(env.version)} ` +
        `(this build supports version ${SNAPSHOT_VERSION}); nothing was restored`,
    );
    return 1;
  }
  const payloadText = JSON.stringify(env.payload) ?? '';
  const checksum = createHash('sha256').update(payloadText, 'utf8').digest('hex');
  if (typeof env.checksum !== 'string' || env.checksum !== `sha256:${checksum}`) {
    err(`snapshot '${snapshotPath}' failed its integrity check; nothing was restored`);
    return 1;
  }

  const payload = env.payload as Record<string, unknown>;
  let data: StoreData;
  let alerts: AlertState;
  let groups: Group[];
  try {
    data = parseStoreData(payload?.readings, `snapshot '${snapshotPath}' readings store`);
    alerts = parseAlertState(payload?.alerts, `snapshot '${snapshotPath}' alerts store`);
    groups = parseGroups(payload?.groups, `snapshot '${snapshotPath}' groups store`);
  } catch (e) {
    if (e instanceof StoreError) {
      err(`${e.message}; nothing was restored`);
      return 1;
    }
    throw e;
  }
  const problems = validateStores(data, alerts, groups);
  if (problems.length > 0) {
    for (const p of problems) err(p);
    err(`restore rejected: snapshot has ${problems.length} consistency problem(s); nothing was restored`);
    return 1;
  }

  mkdirSync(dir, { recursive: true });
  const lockError = acquireLock(dir);
  if (lockError !== null) {
    err(lockError);
    return 1;
  }
  try {
    commitRestore(dir, [
      { path: dataFilePath(), body: JSON.stringify(serializeStoreData(data), null, 2) + '\n' },
      { path: alertFilePath(), body: JSON.stringify(serializeAlertState(alerts), null, 2) + '\n' },
      { path: groupFilePath(), body: JSON.stringify(serializeGroups(groups), null, 2) + '\n' },
    ]);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  } finally {
    releaseLock(dir);
  }

  console.log(`restored from snapshot '${snapshotPath}': ${countsReport(data, alerts, groups)}`);
  return 0;
}

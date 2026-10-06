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
// - 三个业务存储作为一次恢复提交,恢复日志(journal)用阶段字段记录进度:
//   preparing(准备,可收敛为完整旧库或完整快照)→ committing(整体换名,
//   只能前滚为完整快照)→ rolling-back(已进入失败回滚,只能继续还原完整
//   旧库,不能改为前滚)→ done。任何阶段被杀死,任一命令再次启动都会先
//   取得目录操作权并续接未完成恢复;已还原的旧文件绝不误删,原本缺失的
//   文件恢复为缺失,不把事务造成的缺文件当成空库。无法可靠判定或完成一致
//   恢复时报错返回 1,保留全部续接材料,不输出业务结果、不做业务写入。
// - 任一命令从取得数据目录操作权起,先处理未完成恢复,再执行业务查询或
//   写入。操作权是按数据目录隔离的排他锁:同目录被其他存活进程占用时明确
//   拒绝返回 1,不读写业务存储、不清理对方事务材料;属主退出后可安全接管,
//   不同数据目录互不阻塞。备份、恢复与启动自恢复期间同样持锁。

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
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

const LOCK_NAME = 'meterwatch.lock';
const JOURNAL_NAME = 'restore.journal';
const JOURNAL_FORMAT = 'meterwatch-restore-journal';
const NEW_SUFFIX = '.restore-new';
const OLD_SUFFIX = '.restore-old';

/** 恢复阶段;阶段只能按声明的顺序推进,字段缺失按最保守的 committing 处理。 */
type RestorePhase = 'preparing' | 'committing' | 'rolling-back' | 'done';
const PHASES: RestorePhase[] = ['preparing', 'committing', 'rolling-back', 'done'];

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

// ---------------------------------------------------------------------------
// 目录操作权(排他锁,按数据目录隔离)
// ---------------------------------------------------------------------------

/**
 * 获取数据目录的排他操作权;成功返回 null,失败返回错误消息。
 * 锁文件已存在且属存活进程时拒绝(不读写业务存储、不清理对方事务材料);
 * 属已退出进程时清理后重试一次(其未完成恢复由接管方持锁续接)。
 */
function acquireLock(dir: string): string | null {
  const lockPath = join(dir, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return null;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        return `cannot acquire directory lock ${lockPath}: ${(e as Error).message}`;
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
          `data directory ${dir} is locked by another live meterwatch process` +
          `${Number.isInteger(pid) && pid > 0 ? ` (pid ${pid})` : ''}; ` +
          `wait for it to finish, or use another data directory`
        );
      }
      try {
        rmSync(lockPath);
      } catch (re) {
        return `cannot remove stale lock ${lockPath}: ${(re as Error).message}`;
      }
    }
  }
  return `cannot acquire directory lock ${join(dir, LOCK_NAME)}`;
}

function releaseLock(dir: string): void {
  try {
    rmSync(join(dir, LOCK_NAME));
  } catch {
    // 锁文件可能已被清理;释放失败不影响已完成的操作。
  }
}

/** 目标是否为常规文件;路径不存在返回 false,其他类型(目录等)返回 false。 */
function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 恢复日志
// ---------------------------------------------------------------------------

interface JournalFile {
  /** 业务存储文件名(basename)。 */
  name: string;
  /** 恢复前该文件是否存在(原本缺失的,回滚后必须仍为缺失)。 */
  hadOld: boolean;
}

interface Journal {
  phase: RestorePhase;
  files: JournalFile[];
}

/**
 * 解析恢复日志。结构非法返回 null:调用方按无法可靠判定处理,绝不猜测,
 * 也不清理仍可用于恢复的材料。
 */
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
  // 旧/缺阶段字段按最保守的 committing 处理(只能前滚)。
  let phase: RestorePhase = 'committing';
  if (typeof o.phase === 'string' && (PHASES as string[]).includes(o.phase)) {
    phase = o.phase as RestorePhase;
  }
  const names = new Set<string>();
  const files: JournalFile[] = [];
  for (const f of o.files as Array<Record<string, unknown>>) {
    if (
      f === null ||
      typeof f !== 'object' ||
      typeof f.name !== 'string' ||
      f.name.length === 0 ||
      basename(f.name as string) !== f.name ||
      typeof f.hadOld !== 'boolean' ||
      names.has(f.name as string)
    ) {
      return null;
    }
    names.add(f.name as string);
    files.push({ name: f.name as string, hadOld: f.hadOld as boolean });
  }
  return { phase, files };
}

/** 原子改写日志阶段(先写临时文件再换名)。失败抛错,材料保留。 */
function writeJournalPhase(dir: string, journal: Journal, phase: RestorePhase): void {
  const journalPath = join(dir, JOURNAL_NAME);
  const tmp = `${journalPath}.tmp-${process.pid}`;
  writeFileSync(
    tmp,
    JSON.stringify(
      { format: JOURNAL_FORMAT, version: 1, phase, files: journal.files },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  renameSync(tmp, journalPath);
  journal.phase = phase;
}

// ---------------------------------------------------------------------------
// 回滚(还原完整旧库)——幂等,可跨中断续接
// ---------------------------------------------------------------------------

/**
 * 回滚到恢复前状态。必须在 journal.phase === 'rolling-back' 下调用。
 *
 * 幂等且可在任意一步中断后续接:
 * - 旧文件备份存在:原位若为常规文件则删除,再把备份原子换回(rename 覆盖
 *   已先删除,故不会因 EEXIST 失败);已还原到原位的旧文件不会被误删。
 * - 原本缺失(hadOld=false):旧备份按定义不存在;删除事务换入的新内容,
 *   恢复为缺失。原位不存在时即为已完成,绝不把缺文件当成空库而补写。
 * - hadOld=true 但原位与旧备份同时缺失:状态被外部破坏,无法可靠还原,
 *   抛错并保留全部材料,不猜测。
 * 旧备份与待换入新内容必须是常规文件,否则按被篡改处理,中止回滚。
 */
function rollbackPass(dir: string, journal: Journal): void {
  for (const f of journal.files) {
    const target = join(dir, f.name);
    const oldPath = target + OLD_SUFFIX;
    const newPath = target + NEW_SUFFIX;
    if (isRegularFile(oldPath)) {
      // hadOld=false 的文件按定义从不产生旧备份;若出现则与日志矛盾,不据此
      // 复活内容(否则会把事务造成的缺文件错误还原成某个来历不明的文件)。
      if (!f.hadOld) {
        throw new StoreError(`cannot roll back ${target}: backup exists but the journal records no original file`);
      }
      if (existsSync(target)) {
        if (!isRegularFile(target)) {
          throw new StoreError(`cannot roll back ${target}: target exists but is not a regular file`);
        }
        rmSync(target);
      }
      renameSync(oldPath, target);
    } else if (existsSync(oldPath)) {
      throw new StoreError(`restore backup ${oldPath} is not a regular file`);
    } else if (f.hadOld) {
      if (!existsSync(target)) {
        throw new StoreError(`cannot roll back ${target}: both the original and its backup are missing`);
      }
      if (!isRegularFile(target)) {
        throw new StoreError(`cannot roll back ${target}: restored original is not a regular file`);
      }
      // 原位已是常规文件:上一轮已还原完成,保持不动(绝不误删)。
    } else {
      // 原本缺失:清除事务换入的内容(原位或残留新临时文件),恢复为缺失。
      if (existsSync(newPath)) {
        if (!isRegularFile(newPath)) {
          throw new StoreError(`restore temp file ${newPath} is not a regular file`);
        }
        rmSync(newPath);
      }
      if (existsSync(target)) {
        if (!isRegularFile(target)) {
          throw new StoreError(`cannot restore missing state for ${target}: target is not a regular file`);
        }
        rmSync(target);
      }
    }
  }
}

/** 回滚收尾:删除残留新临时文件,再删日志。旧文件备份已全部换回原位。 */
function rollbackCleanup(dir: string, journal: Journal): void {
  for (const f of journal.files) {
    const newPath = join(dir, f.name) + NEW_SUFFIX;
    if (existsSync(newPath)) {
      // 该名字属于本次事务的临时命名空间;正常产物必为常规文件。即便是异常
      // 占位(如目录),也随回滚一并递归清除,不影响业务存储。
      rmSync(newPath, { recursive: true, force: true });
    }
    const oldPath = join(dir, f.name) + OLD_SUFFIX;
    if (existsSync(oldPath)) {
      // 正常不应残留;若仍在则回滚未完成,保留材料并报错,不删日志。
      throw new StoreError(`restore backup ${oldPath} was not restored; rollback is incomplete`);
    }
  }
  rmSync(join(dir, JOURNAL_NAME));
}

// ---------------------------------------------------------------------------
// 前滚(提交完整快照)——幂等,可跨中断续接
// ---------------------------------------------------------------------------

/**
 * 前滚到完整快照状态,逐文件幂等,可在任意一步中断后续接。每个文件只有崩溃
 * 可达的三种状态:
 *   未动:原位=旧内容(hadOld 时)或原位缺失,新临时在,旧备份无;
 *   旧已移走:原位缺失,新临时在,旧备份在;
 *   已换入:原位=新内容,新临时无,旧备份在(hadOld 时);原本缺失的文件
 *           (hadOld=false)已换入时旧备份按定义不存在。
 * 判据:新临时还在就说明该文件尚未换入——原位若有旧内容先移为旧备份,再把
 * 新临时换入;新临时不在则原位必须已是常规文件。关键不变量:日志仍在时
 * 收尾尚未运行(收尾先删日志再删旧备份),故 hadOld 的已换入文件必仍带旧
 * 备份;原位是常规内容、新临时与旧备份却都不在属于无法可靠判定的状态,
 * 直接抛错并保留材料,绝不把旧内容误当新内容而提交混合状态。
 */
function rollForwardPass(dir: string, journal: Journal): void {
  for (const f of journal.files) {
    const target = join(dir, f.name);
    const newPath = target + NEW_SUFFIX;
    const oldPath = target + OLD_SUFFIX;
    if (existsSync(newPath)) {
      if (!isRegularFile(newPath)) {
        throw new StoreError(`restore temp file ${newPath} is not a regular file`);
      }
      if (existsSync(target)) {
        // 旧内容仍在原位,先移为备份。
        if (!isRegularFile(target)) {
          throw new StoreError(`cannot commit ${target}: target exists but is not a regular file`);
        }
        if (existsSync(oldPath)) {
          throw new StoreError(`cannot commit ${target}: both the original and its backup are present`);
        }
        if (!f.hadOld) {
          // 日志称原本缺失,原位却有内容:与日志矛盾,不猜测。
          throw new StoreError(`cannot commit ${target}: journal says it was originally absent`);
        }
        renameSync(target, oldPath);
      }
      renameSync(newPath, target);
    } else if (isRegularFile(target)) {
      // 新临时已不在:视为已换入。hadOld 的文件此刻必仍有旧备份(日志还在,
      // 收尾未运行);缺失则状态无法可靠判定,中止而不猜。
      if (f.hadOld && !existsSync(oldPath)) {
        throw new StoreError(
          `cannot determine state of ${target}: neither its restore temp nor its backup exists`,
        );
      }
    } else {
      throw new StoreError(`cannot commit ${target}: business store is missing or not a regular file`);
    }
  }
  for (const f of journal.files) {
    if (!isRegularFile(join(dir, f.name))) {
      throw new StoreError(`cannot commit ${join(dir, f.name)}: business store is missing or not a regular file`);
    }
  }
}

/** 前滚收尾:删除日志与旧文件备份(新临时文件已全部换入)。 */
function rollForwardCleanup(dir: string, journal: Journal): void {
  for (const f of journal.files) {
    const newPath = join(dir, f.name) + NEW_SUFFIX;
    if (existsSync(newPath)) {
      throw new StoreError(`restore temp file ${newPath} still present; commit is incomplete`);
    }
  }
  rmSync(join(dir, JOURNAL_NAME));
  for (const f of journal.files) {
    const oldPath = join(dir, f.name) + OLD_SUFFIX;
    if (existsSync(oldPath)) rmSync(oldPath);
  }
}

// ---------------------------------------------------------------------------
// 启动自恢复(持锁调用)
// ---------------------------------------------------------------------------

/**
 * 续接未完成的恢复。依据日志阶段决定方向:
 * - preparing:优先前滚为完整快照;失败再回滚为完整旧库(两方向皆可)。
 * - committing:只能前滚;失败不回滚,保留材料并报错,绝不产生混合判定。
 * - rolling-back:只能继续还原完整旧库,不能改为前滚。
 * - done:完成前滚收尾。
 * 成功返回 null;无法可靠判定或完成时返回错误消息,材料一律保留。
 */
function resumeRestore(dir: string, journal: Journal): string | null {
  try {
    if (journal.phase === 'preparing') {
      rollForwardPass(dir, journal);
      writeJournalPhase(dir, journal, 'committing');
      rollForwardCleanup(dir, journal);
      err('completed an interrupted restore: snapshot state committed');
      return null;
    }
    if (journal.phase === 'committing' || journal.phase === 'done') {
      if (journal.phase === 'committing') {
        rollForwardPass(dir, journal);
        writeJournalPhase(dir, journal, 'done');
      }
      rollForwardCleanup(dir, journal);
      err('completed an interrupted restore: snapshot state committed');
      return null;
    }
    // rolling-back:进入回滚后只能继续还原完整旧库。
    rollbackPass(dir, journal);
    rollbackCleanup(dir, journal);
    err('continued an interrupted rollback: previous state restored');
    return null;
  } catch (e) {
    // preparing 阶段前滚失败时尚未进入失败回滚,可收敛为完整旧库。
    if (journal.phase === 'preparing') {
      try {
        writeJournalPhase(dir, journal, 'rolling-back');
        rollbackPass(dir, journal);
        rollbackCleanup(dir, journal);
        err('rolled back an interrupted restore: previous state restored');
        return null;
      } catch (re) {
        return (
          `cannot recover data directory ${dir} to a consistent state: ${(re as Error).message}; ` +
          `restore materials were kept in the directory; do not delete ${JOURNAL_NAME} or ` +
          `'*${OLD_SUFFIX}'/'*${NEW_SUFFIX}' files, then run any meterwatch command again`
        );
      }
    }
    return (
      `cannot complete interrupted restore for data directory ${dir}: ${(e as Error).message}; ` +
      `restore materials were kept (${JOURNAL_NAME}, '*${OLD_SUFFIX}', '*${NEW_SUFFIX}'); ` +
      `resolve the underlying read/write problem and run any meterwatch command again`
    );
  }
}

/**
 * 任一命令启动时(持锁)调用:若上次恢复被中断,先把数据目录续接为完整
 * 快照状态或完整旧状态,绝不留下或查询混合状态。没有日志时清理可能残留
 * 的临时文件。成功(或无需恢复)返回 null,无法完成返回错误消息。
 */
function recoverIfNeeded(dir: string): string | null {
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
        `the directory may hold restore materials in an unknown state - nothing was deleted; ` +
        `inspect ${JOURNAL_NAME} and '*${OLD_SUFFIX}'/'*${NEW_SUFFIX}' files before retrying`
      );
    }
    return resumeRestore(dir, journal);
  }
  // 无日志:提交未开始(残留新临时文件)或已完整完成(残留旧文件备份)。
  // 这些残留不属于任何活动事务,清理即可;清理失败明确报错,不继续启动。
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
  // 日志阶段翻转时用的临时名(原子换名前被杀会留下死临时),不影响判定。
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(`${JOURNAL_NAME}.tmp-`)) {
      try {
        rmSync(join(dir, entry));
      } catch (e) {
        return `cannot clean up interrupted restore leftover ${join(dir, entry)}: ${(e as Error).message}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 目录操作权 + 自恢复:所有命令的统一入口协调
// ---------------------------------------------------------------------------

/**
 * 取得数据目录的排他操作权并先处理未完成恢复,然后运行业务动作。
 *
 * 任何命令(含无参数、--help/-h 与非法参数入口)都必须先完成本协调:
 * - 目录不存在则创建(数据目录本身可由本工具建立);
 * - 锁被存活进程占用:返回 1,不读写业务存储、不清理对方事务材料;
 * - 自恢复无法可靠完成:返回 1,不运行业务动作;
 * - 成功后运行业务动作并沿用其退出码,释放锁。
 */
export function withDirectoryCoordination<T>(action: () => T): T | number {
  const dir = dataDirPath();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    err(`cannot access data directory ${dir}: ${(e as Error).message}`);
    return 1;
  }
  const lockError = acquireLock(dir);
  if (lockError !== null) {
    err(lockError);
    return 1;
  }
  try {
    const recoveryError = recoverIfNeeded(dir);
    if (recoveryError !== null) {
      err(recoveryError);
      return 1;
    }
    return action();
  } finally {
    releaseLock(dir);
  }
}

/**
 * 把三个业务存储的新内容作为一次恢复提交。调用方已持有目录锁。
 *
 * 阶段:
 *  1. preparing:写全部新内容到临时文件,再原子写日志。失败或中断都不影响
 *     现有业务文件(此阶段中断下次可前滚或回滚)。
 *  2. committing:整体换名(旧文件移为备份,新文件换入)。中断只能前滚。
 *  3. 受控失败:先置 rolling-back(此后只能还原旧库),再幂等回滚。
 *  4. 成功:置 done 并清理日志与旧备份。
 */
function commitRestore(dir: string, files: Array<{ path: string; body: string }>): void {
  const journalPath = join(dir, JOURNAL_NAME);
  const journal: Journal = {
    phase: 'preparing',
    files: files.map((f) => ({ name: basename(f.path), hadOld: existsSync(f.path) })),
  };

  // 阶段一:准备。此阶段失败不改变业务文件;不留日志(下次按残留清理)。
  try {
    for (const f of files) {
      writeFileSync(f.path + NEW_SUFFIX, f.body, 'utf8');
    }
    writeJournalPhase(dir, journal, 'preparing');
  } catch (e) {
    for (const f of files) {
      try {
        if (existsSync(f.path + NEW_SUFFIX)) rmSync(f.path + NEW_SUFFIX);
      } catch {
        // 清理失败不掩盖原始错误;无日志,残留由下次启动清理。
      }
    }
    throw new StoreError(`cannot prepare restore in ${dir}: ${(e as Error).message}; nothing was changed`);
  }

  // 阶段二:整体换名提交。
  try {
    writeJournalPhase(dir, journal, 'committing');
    for (const f of journal.files) {
      const target = join(dir, f.name);
      if (existsSync(target)) {
        renameSync(target, target + OLD_SUFFIX);
      }
    }
    for (const f of journal.files) {
      const target = join(dir, f.name);
      renameSync(target + NEW_SUFFIX, target);
    }
  } catch (e) {
    // 受控失败:进入 rolling-back 后只能继续还原完整旧库(幂等,可中断)。
    try {
      writeJournalPhase(dir, journal, 'rolling-back');
    } catch (we) {
      throw new StoreError(
        `restore failed (${(e as Error).message}) and the rollback could not be started ` +
          `(${ (we as Error).message}); data directory ${dir} keeps its restore materials - ` +
          `run any meterwatch command again to continue the rollback`,
      );
    }
    try {
      rollbackPass(dir, journal);
      rollbackCleanup(dir, journal);
    } catch (re) {
      throw new StoreError(
        `restore failed (${(e as Error).message}); rollback is in progress and could not finish ` +
          `(${ (re as Error).message}); data directory ${dir} keeps all materials needed to continue - ` +
          `run any meterwatch command again to finish restoring the previous state`,
      );
    }
    throw new StoreError(`restore failed: ${(e as Error).message}; previous state restored`);
  }

  // 阶段三:提交已落地,记录完成并清理备份。清理失败不影响快照一致性,
  // 但仍作为错误上报;下次启动会完成收尾。
  try {
    writeJournalPhase(dir, journal, 'done');
    rollForwardCleanup(dir, journal);
  } catch (e) {
    throw new StoreError(
      `snapshot state was committed but post-commit cleanup failed: ${(e as Error).message}; ` +
        `run any meterwatch command again to finish cleanup`,
    );
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
 * 导出全库快照。在目录操作权与自恢复协调之内运行(见
 * withDirectoryCoordination):只读取业务存储,不改写业务数据;输出文件必须
 * 位于数据目录之外且不得已存在。返回进程退出码。
 */
export function cmdBackup(outPath: string): number {
  const dir = dataDirPath();
  if (isInsideDir(dir, outPath)) {
    err(`snapshot file '${outPath}' must be located outside the data directory ${dir}`);
    return 2;
  }

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
}

/**
 * 从快照整库恢复。在目录操作权与自恢复协调之内运行:协调完成后才读取并
 * 校验快照(故损坏的当前库不影响恢复,恢复不以解析旧库为前提)。快照须通过
 * 格式版本与完整性校验,且三个业务存储的结构与关联一致,否则不开始替换。
 * 成功后业务状态完全等于快照。返回进程退出码。
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

  // 快照校验全部通过后才开始替换;调用方已持有目录操作权。
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
  }

  console.log(`restored from snapshot '${snapshotPath}': ${countsReport(data, alerts, groups)}`);
  return 0;
}

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
// - 恢复日志无法解析或含显式未知阶段时,普通命令(含 restore)一律返回 1:
//   保留业务文件与恢复材料,不输出正常结果、不猜测前滚方向。此时唯一出路是
//   显式快照救援(rescue):救援不解析当前库与旧日志,先按与 restore 相同的
//   规则校验快照,再把救援前的三个业务文件、restore.journal 及对应
//   *.restore-old/*.restore-new 的原始字节与缺失状态完整留存到数据目录下的
//   rescue-preserve-*/(留存不完整绝不替换),然后放弃旧事务、把三个业务存储
//   整体替换为快照内容。留存材料不被启动或后续恢复自动清理。救援自身用
//   rescue.journal 记录阶段:被中断后任一命令启动先续接为完整快照或完整退回
//   救援前状态,不开放混合库;已进入回退不得改向。

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

// 显式快照救援(rescue):救援事务日志、留存清单与还原临时文件。
const RESCUE_JOURNAL_NAME = 'rescue.journal';
const RESCUE_JOURNAL_FORMAT = 'meterwatch-rescue-journal';
const PRESERVE_FORMAT = 'meterwatch-rescue-preserve';
const PRESERVE_DIR_PREFIX = 'rescue-preserve-';
const RESCUE_TMP_MARK = '.rescue-tmp-';

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
  // 缺失阶段字段(旧日志)按最保守的 committing 处理(只能前滚);显式写出
  // 却无法识别的阶段视为无效日志:无法可靠判定,绝不猜测前滚方向。
  let phase: RestorePhase = 'committing';
  if (o.phase !== undefined) {
    if (typeof o.phase === 'string' && (PHASES as string[]).includes(o.phase)) {
      phase = o.phase as RestorePhase;
    } else {
      return null;
    }
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
// 显式快照救援(rescue):放弃无法可靠续接的旧事务,整体替换为完好快照
// ---------------------------------------------------------------------------

/**
 * 救援阶段。救援日志只在留存完成、替换开始前才原子创建,故无 preparing
 * 阶段:留存期间被中断时日志尚不存在,业务文件与旧事务材料未被触碰,
 * 不完整的留存目录只是无害残留(不被自动清理,也不影响后续救援)。
 */
type RescuePhase = 'committing' | 'rolling-back' | 'done';
const RESCUE_PHASES: RescuePhase[] = ['committing', 'rolling-back', 'done'];

interface RescueJournal {
  phase: RescuePhase;
  /** 留存目录名(basename,位于数据目录内)。 */
  preserveDir: string;
}

interface PreserveEntry {
  /** 固定文件名(basename)。 */
  name: string;
  /** 救援前该文件是否存在。 */
  present: boolean;
}

/** 三个业务存储文件名(basename,顺序固定)。 */
function storeNames(): string[] {
  return storeFiles().map((p) => basename(p));
}

/**
 * 救援前必须留存的固定文件名:三个业务存储、对应的 *.restore-old /
 * *.restore-new 旧事务材料,以及 restore.journal。一律按固定名操作,
 * 绝不采用(可能已损坏的)日志里记录的文件名。
 */
function preservedNames(): string[] {
  const names: string[] = [];
  for (const n of storeNames()) {
    names.push(n, n + OLD_SUFFIX, n + NEW_SUFFIX);
  }
  names.push(JOURNAL_NAME);
  return names;
}

/**
 * 解析救援日志。结构非法或阶段无法识别返回 null:调用方按无法可靠判定
 * 处理,保留全部材料,绝不猜测。
 */
function parseRescueJournal(data: unknown): RescueJournal | null {
  const o = data as Record<string, unknown>;
  if (
    o === null ||
    typeof o !== 'object' ||
    o.format !== RESCUE_JOURNAL_FORMAT ||
    o.version !== 1 ||
    typeof o.preserveDir !== 'string' ||
    o.preserveDir.length === 0 ||
    basename(o.preserveDir as string) !== o.preserveDir ||
    typeof o.phase !== 'string' ||
    !(RESCUE_PHASES as string[]).includes(o.phase)
  ) {
    return null;
  }
  return { phase: o.phase as RescuePhase, preserveDir: o.preserveDir as string };
}

/** 原子改写救援日志(先写临时文件再换名)。失败抛错,材料保留。 */
function writeRescueJournal(dir: string, journal: RescueJournal, phase: RescuePhase): void {
  const journalPath = join(dir, RESCUE_JOURNAL_NAME);
  const tmp = `${journalPath}.tmp-${process.pid}`;
  writeFileSync(
    tmp,
    JSON.stringify(
      { format: RESCUE_JOURNAL_FORMAT, version: 1, phase, preserveDir: journal.preserveDir },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  renameSync(tmp, journalPath);
  journal.phase = phase;
}

/** 生成数据目录内唯一的留存目录名(时间戳 + 进程号,冲突时追加序号)。 */
function uniquePreserveDirName(dir: string): string {
  const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]/g, '');
  for (let i = 0; ; i++) {
    const name = `${PRESERVE_DIR_PREFIX}${stamp}-${process.pid}${i === 0 ? '' : `-${i}`}`;
    if (!existsSync(join(dir, name))) return name;
  }
}

/**
 * 留存救援前状态:把固定名清单中每个存在的文件按原始字节复制到
 * 留存目录 pre/ 下,缺失状态记入清单;快照新内容写入 incoming/。
 * 清单最后写:只有完整清单才表示留存完整,留存不完整绝不开始替换。
 * 失败抛错;业务文件与旧事务材料此阶段未被触碰。
 */
function writePreservation(
  dir: string,
  preserveDir: string,
  incoming: Array<{ name: string; body: string }>,
): void {
  const pdir = join(dir, preserveDir);
  mkdirSync(pdir);
  mkdirSync(join(pdir, 'pre'));
  mkdirSync(join(pdir, 'incoming'));
  for (const f of incoming) {
    writeFileSync(join(pdir, 'incoming', f.name), f.body, 'utf8');
  }
  const entries: PreserveEntry[] = [];
  for (const name of preservedNames()) {
    const src = join(dir, name);
    if (existsSync(src)) {
      if (!isRegularFile(src)) {
        throw new StoreError(`cannot preserve ${src}: not a regular file`);
      }
      writeFileSync(join(pdir, 'pre', name), readFileSync(src));
      entries.push({ name, present: true });
    } else {
      entries.push({ name, present: false });
    }
  }
  writeFileSync(
    join(pdir, 'manifest.json'),
    JSON.stringify({ format: PRESERVE_FORMAT, version: 1, entries }, null, 2) + '\n',
    'utf8',
  );
}

/**
 * 读取留存清单;缺失、损坏或与固定名清单不符时抛错(无法可靠续接,
 * 保留全部材料,不猜测)。
 */
function readManifest(pdir: string): PreserveEntry[] {
  const manifestPath = join(pdir, 'manifest.json');
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new StoreError(`preserve manifest ${manifestPath} is unreadable: ${(e as Error).message}`);
  }
  const o = data as Record<string, unknown>;
  if (
    o === null ||
    typeof o !== 'object' ||
    o.format !== PRESERVE_FORMAT ||
    o.version !== 1 ||
    !Array.isArray(o.entries)
  ) {
    throw new StoreError(`preserve manifest ${manifestPath} is invalid`);
  }
  const expected = preservedNames();
  const seen = new Set<string>();
  const entries: PreserveEntry[] = [];
  for (const e of o.entries as Array<Record<string, unknown>>) {
    if (
      e === null ||
      typeof e !== 'object' ||
      typeof e.name !== 'string' ||
      typeof e.present !== 'boolean' ||
      !expected.includes(e.name as string) ||
      seen.has(e.name as string)
    ) {
      throw new StoreError(`preserve manifest ${manifestPath} is invalid`);
    }
    seen.add(e.name as string);
    entries.push({ name: e.name as string, present: e.present as boolean });
  }
  if (entries.length !== expected.length) {
    throw new StoreError(`preserve manifest ${manifestPath} is incomplete`);
  }
  return entries;
}

/**
 * 救援前滚为完整快照,逐文件幂等,可在任意一步中断后续接:
 * 先删除已被留存的旧事务材料(restore.journal 与 *.restore-old /
 * *.restore-new),再把 incoming/ 中的快照内容逐个换入业务文件。
 * incoming 文件还在说明该文件尚未换入;不在则原位必须已是常规文件。
 */
function rescueRollForward(dir: string, journal: RescueJournal): void {
  const pdir = join(dir, journal.preserveDir);
  // 进入 committing 前清单必已写妥;读不出即无法可靠续接,中止而不猜。
  readManifest(pdir);
  // 放弃旧事务材料(原始字节已留存在 pre/ 下)。
  const abandoned = [JOURNAL_NAME];
  for (const n of storeNames()) {
    abandoned.push(n + OLD_SUFFIX, n + NEW_SUFFIX);
  }
  for (const name of abandoned) {
    const p = join(dir, name);
    if (existsSync(p)) {
      if (!isRegularFile(p)) {
        throw new StoreError(`cannot abandon old restore material ${p}: not a regular file`);
      }
      rmSync(p);
    }
  }
  // 换入快照内容。
  for (const name of storeNames()) {
    const inc = join(pdir, 'incoming', name);
    const target = join(dir, name);
    if (existsSync(inc)) {
      if (!isRegularFile(inc)) {
        throw new StoreError(`staged snapshot content ${inc} is not a regular file`);
      }
      if (existsSync(target)) {
        if (!isRegularFile(target)) {
          throw new StoreError(`cannot commit ${target}: target exists but is not a regular file`);
        }
        rmSync(target);
      }
      renameSync(inc, target);
    } else if (!isRegularFile(target)) {
      throw new StoreError(
        `cannot determine state of ${target}: neither the store nor its staged content exists`,
      );
    }
  }
}

/** 救援前滚收尾:incoming 应已全部换入,删除救援日志;留存目录永久保留。 */
function rescueRollForwardCleanup(dir: string, journal: RescueJournal): void {
  const pdir = join(dir, journal.preserveDir);
  for (const name of storeNames()) {
    const inc = join(pdir, 'incoming', name);
    if (existsSync(inc)) {
      throw new StoreError(`staged snapshot content ${inc} still present; commit is incomplete`);
    }
  }
  rmSync(join(dir, RESCUE_JOURNAL_NAME));
}

/**
 * 救援回退:按清单把救援前业务文件与旧事务材料的内容与存在状态完整还原
 * (从 pre/ 复制原始字节,不消耗留存;原本缺失的恢复为缺失)。幂等,可在
 * 任意一步中断后续接;进入回退后不得改向前滚。
 */
function rescueRollback(dir: string, journal: RescueJournal): void {
  const pdir = join(dir, journal.preserveDir);
  const entries = readManifest(pdir);
  for (const entry of entries) {
    const target = join(dir, entry.name);
    if (entry.present) {
      const pre = join(pdir, 'pre', entry.name);
      if (!isRegularFile(pre)) {
        throw new StoreError(`preserved copy ${pre} is missing or not a regular file`);
      }
      if (existsSync(target) && !isRegularFile(target)) {
        throw new StoreError(`cannot restore ${target}: target exists but is not a regular file`);
      }
      const tmp = `${target}${RESCUE_TMP_MARK}${process.pid}`;
      writeFileSync(tmp, readFileSync(pre));
      if (existsSync(target)) rmSync(target);
      renameSync(tmp, target);
    } else if (existsSync(target)) {
      if (!isRegularFile(target)) {
        throw new StoreError(`cannot restore missing state for ${target}: not a regular file`);
      }
      rmSync(target);
    }
  }
}

/** 救援回退收尾:清理还原临时文件,删除救援日志;留存目录永久保留。 */
function rescueRollbackCleanup(dir: string, journal: RescueJournal): void {
  for (const entry of readdirSync(dir)) {
    if (entry.includes(RESCUE_TMP_MARK)) {
      rmSync(join(dir, entry), { recursive: true, force: true });
    }
  }
  rmSync(join(dir, RESCUE_JOURNAL_NAME));
}

/**
 * 续接被中断的救援(持锁调用):
 * - committing:优先前滚为完整快照;前滚受阻则完整退回救援前状态
 *   (救援前状态已完整留存,回退总是可行;确定回退后不得改向)。
 * - rolling-back:只能继续还原救援前状态。
 * - done:完成前滚收尾。
 * 成功返回 null;无法可靠判定或完成时返回错误消息,材料一律保留。
 */
function resumeRescue(dir: string, journal: RescueJournal): string | null {
  const kept =
    `rescue materials were kept (${RESCUE_JOURNAL_NAME} and ${journal.preserveDir}/); ` +
    `do not delete them, resolve the underlying read/write problem and run any meterwatch command again`;
  if (journal.phase === 'committing') {
    try {
      rescueRollForward(dir, journal);
      writeRescueJournal(dir, journal, 'done');
      rescueRollForwardCleanup(dir, journal);
      err('completed an interrupted rescue: snapshot state committed');
      return null;
    } catch (e) {
      try {
        writeRescueJournal(dir, journal, 'rolling-back');
        rescueRollback(dir, journal);
        rescueRollbackCleanup(dir, journal);
        err('rolled back an interrupted rescue: pre-rescue state restored');
        return null;
      } catch (re) {
        return `cannot recover data directory ${dir} to a consistent state: ${(re as Error).message}; ${kept}`;
      }
    }
  }
  if (journal.phase === 'done') {
    try {
      rescueRollForwardCleanup(dir, journal);
      err('completed an interrupted rescue: snapshot state committed');
      return null;
    } catch (e) {
      return `cannot finish interrupted rescue for data directory ${dir}: ${(e as Error).message}; ${kept}`;
    }
  }
  // rolling-back:进入回退后只能继续还原救援前状态。
  try {
    rescueRollback(dir, journal);
    rescueRollbackCleanup(dir, journal);
    err('continued an interrupted rescue rollback: pre-rescue state restored');
    return null;
  } catch (e) {
    return `cannot complete interrupted rescue rollback for data directory ${dir}: ${(e as Error).message}; ${kept}`;
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
 * 任一命令启动时(持锁)调用:若上次恢复或救援被中断,先把数据目录续接为
 * 完整快照状态或完整旧状态(救援则续接为完整快照或完整救援前状态),绝不
 * 留下或查询混合状态。没有日志时清理可能残留的临时文件。成功(或无需
 * 恢复)返回 null,无法完成返回错误消息。
 */
function recoverIfNeeded(dir: string): string | null {
  // 救援事务优先:救援进行中旧 restore.journal 可能仍在或已被放弃,一律以
  // 救援日志为准续接。
  const rescueJournalPath = join(dir, RESCUE_JOURNAL_NAME);
  if (existsSync(rescueJournalPath)) {
    let journal: RescueJournal | null = null;
    try {
      journal = parseRescueJournal(JSON.parse(readFileSync(rescueJournalPath, 'utf8')));
    } catch {
      journal = null;
    }
    if (journal === null) {
      return (
        `cannot recover data directory ${dir}: rescue journal ${rescueJournalPath} is unreadable or invalid; ` +
        `the directory may hold rescue materials in an unknown state - nothing was deleted; ` +
        `inspect ${RESCUE_JOURNAL_NAME} and '${PRESERVE_DIR_PREFIX}*' directories before retrying`
      );
    }
    const rescueError = resumeRescue(dir, journal);
    if (rescueError !== null) return rescueError;
    // 救援续接完成后继续常规检查:回退可能刚把损坏的 restore.journal 还原
    // 到位,普通命令必须继续拒绝,不能就此开放受阻状态。
  }
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
        `use 'node app.ts rescue <snapshot>' with a known-good snapshot to explicitly abandon ` +
        `the interrupted restore (the current state will be preserved first), or inspect ` +
        `${JOURNAL_NAME} and '*${OLD_SUFFIX}'/'*${NEW_SUFFIX}' files before retrying`
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
  // 日志阶段翻转时用的临时名与救援还原临时文件(原子换名前被杀会留下死
  // 临时),不影响判定。rescue-preserve-* 留存目录不属于残留,绝不自动清理。
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(`${JOURNAL_NAME}.tmp-`) ||
        entry.startsWith(`${RESCUE_JOURNAL_NAME}.tmp-`) ||
        entry.includes(RESCUE_TMP_MARK)) {
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

interface SnapshotStores {
  data: StoreData;
  alerts: AlertState;
  groups: Group[];
}

/**
 * 读取并校验快照:格式标识、格式版本、SHA-256 完整性校验,以及三个业务
 * 存储的结构与关联(沿用旧快照兼容规则)。任一校验失败打印原因并返回
 * null(调用方返回 1),不开始任何替换、不改动原库与旧事务材料。
 */
function loadValidatedSnapshot(snapshotPath: string): SnapshotStores | null {
  let text: string;
  try {
    text = readFileSync(resolve(snapshotPath), 'utf8');
  } catch (e) {
    err(`cannot read snapshot '${snapshotPath}': ${(e as Error).message}`);
    return null;
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    err(`snapshot '${snapshotPath}' is corrupted (invalid JSON or truncated); nothing was restored`);
    return null;
  }
  const env = envelope as Record<string, unknown>;
  if (env === null || typeof env !== 'object' || env.format !== SNAPSHOT_FORMAT) {
    err(`snapshot '${snapshotPath}' is not a meterwatch snapshot; nothing was restored`);
    return null;
  }
  if (env.version !== SNAPSHOT_VERSION) {
    err(
      `snapshot '${snapshotPath}' has unsupported format version ${String(env.version)} ` +
        `(this build supports version ${SNAPSHOT_VERSION}); nothing was restored`,
    );
    return null;
  }
  const payloadText = JSON.stringify(env.payload) ?? '';
  const checksum = createHash('sha256').update(payloadText, 'utf8').digest('hex');
  if (typeof env.checksum !== 'string' || env.checksum !== `sha256:${checksum}`) {
    err(`snapshot '${snapshotPath}' failed its integrity check; nothing was restored`);
    return null;
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
      return null;
    }
    throw e;
  }
  const problems = validateStores(data, alerts, groups);
  if (problems.length > 0) {
    for (const p of problems) err(p);
    err(`restore rejected: snapshot has ${problems.length} consistency problem(s); nothing was restored`);
    return null;
  }
  return { data, alerts, groups };
}

/** 把校验过的快照内容序列化为三个业务存储文件内容。 */
function snapshotBodies(snap: SnapshotStores): Array<{ name: string; body: string }> {
  return [
    { name: basename(dataFilePath()), body: JSON.stringify(serializeStoreData(snap.data), null, 2) + '\n' },
    { name: basename(alertFilePath()), body: JSON.stringify(serializeAlertState(snap.alerts), null, 2) + '\n' },
    { name: basename(groupFilePath()), body: JSON.stringify(serializeGroups(snap.groups), null, 2) + '\n' },
  ];
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

  const snap = loadValidatedSnapshot(snapshotPath);
  if (snap === null) return 1;

  // 快照校验全部通过后才开始替换;调用方已持有目录操作权。
  const bodies = snapshotBodies(snap);
  try {
    commitRestore(dir, bodies.map((b) => ({ path: join(dir, b.name), body: b.body })));
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  console.log(`restored from snapshot '${snapshotPath}': ${countsReport(snap.data, snap.alerts, snap.groups)}`);
  return 0;
}

/**
 * 救援命令的目录协调:取得数据目录操作权,并先续接被中断的救援事务
 * (rescue.journal),然后运行业务动作。与 withDirectoryCoordination 不同,
 * 不处理旧 restore 事务——救援存在的意义就是显式放弃无法可靠续接的旧
 * 事务(其材料会先被完整留存)。锁被存活进程占用或中断救援无法续接时
 * 返回 1,不读写业务存储、不动任何材料。
 */
function withRescueCoordination<T>(action: () => T): T | number {
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
    const rescueJournalPath = join(dir, RESCUE_JOURNAL_NAME);
    if (existsSync(rescueJournalPath)) {
      let journal: RescueJournal | null = null;
      try {
        journal = parseRescueJournal(JSON.parse(readFileSync(rescueJournalPath, 'utf8')));
      } catch {
        journal = null;
      }
      if (journal === null) {
        err(
          `cannot recover data directory ${dir}: rescue journal ${rescueJournalPath} is unreadable or invalid; ` +
            `the directory may hold rescue materials in an unknown state - nothing was deleted; ` +
            `inspect ${RESCUE_JOURNAL_NAME} and '${PRESERVE_DIR_PREFIX}*' directories before retrying`,
        );
        return 1;
      }
      const resumeError = resumeRescue(dir, journal);
      if (resumeError !== null) {
        err(resumeError);
        return 1;
      }
    }
    return action();
  } finally {
    releaseLock(dir);
  }
}

/**
 * 显式快照救援:当恢复日志损坏、普通入口(含 restore)被阻塞时,显式放弃
 * 旧事务并把三个业务存储整体替换为完好快照。
 *
 * 不解析当前库与旧日志;允许三个业务文件损坏、缺失或混合。先按与 restore
 * 相同的规则校验快照(无效快照返回 1,不改动原库与旧事务材料),再把救援前
 * 的三个业务文件、restore.journal 及对应 *.restore-old/*.restore-new 的原始
 * 字节与缺失状态完整留存到 rescue-preserve-* 目录(留存不完整绝不替换),随后
 * 放弃旧事务材料、整体换入快照内容。留存目录不被启动或后续恢复自动清理,
 * 目录内其他已有文件不变。读写或重命名失败返回 1 并还原救援前状态;还原
 * 受阻则保留全部材料并阻止业务。返回进程退出码。
 */
export function cmdRescue(snapshotPath: string): number {
  return withRescueCoordination<number>(() => {
    const dir = dataDirPath();
    if (isInsideDir(dir, snapshotPath)) {
      err(`snapshot file '${snapshotPath}' must be located outside the data directory ${dir}`);
      return 2;
    }

    const snap = loadValidatedSnapshot(snapshotPath);
    if (snap === null) return 1;
    const bodies = snapshotBodies(snap);

    // 留存救援前状态;留存不完整绝不替换。此阶段不触碰业务文件与旧事务材料。
    const preserveDir = uniquePreserveDirName(dir);
    try {
      writePreservation(dir, preserveDir, bodies);
    } catch (e) {
      err(
        `cannot preserve pre-rescue state in ${join(dir, preserveDir)}: ${(e as Error).message}; ` +
          `nothing was replaced`,
      );
      return 1;
    }

    // 留存完成后才创建救援日志并开始替换;被中断由启动续接(见 resumeRescue)。
    const journal: RescueJournal = { phase: 'committing', preserveDir };
    try {
      writeRescueJournal(dir, journal, 'committing');
    } catch (e) {
      err(
        `cannot start rescue in ${dir}: ${(e as Error).message}; nothing was replaced; ` +
          `pre-rescue state was preserved in ${join(dir, preserveDir)}`,
      );
      return 1;
    }
    try {
      rescueRollForward(dir, journal);
    } catch (e) {
      // 受控失败:进入 rolling-back 后只能继续还原救援前状态(幂等,可中断)。
      let rollbackStarted = true;
      try {
        writeRescueJournal(dir, journal, 'rolling-back');
      } catch (we) {
        rollbackStarted = false;
        err(
          `rescue failed (${(e as Error).message}) and the rollback could not be started ` +
            `(${(we as Error).message}); data directory ${dir} keeps all rescue materials ` +
            `(${RESCUE_JOURNAL_NAME}, ${preserveDir}/) - run any meterwatch command again ` +
            `to continue; nothing else may use the directory until then`,
        );
      }
      if (rollbackStarted) {
        try {
          rescueRollback(dir, journal);
          rescueRollbackCleanup(dir, journal);
          err(`rescue failed: ${(e as Error).message}; pre-rescue state restored`);
          return 1;
        } catch (re) {
          err(
            `rescue failed (${(e as Error).message}); rollback is in progress and could not finish ` +
              `(${(re as Error).message}); data directory ${dir} keeps all materials needed to ` +
              `continue - run any meterwatch command again to finish restoring the pre-rescue state`,
          );
          return 1;
        }
      }
      return 1;
    }
    try {
      writeRescueJournal(dir, journal, 'done');
      rescueRollForwardCleanup(dir, journal);
    } catch (e) {
      err(
        `snapshot state was committed but post-commit cleanup failed: ${(e as Error).message}; ` +
          `run any meterwatch command again to finish cleanup`,
      );
      return 1;
    }

    console.log(
      `rescued from snapshot '${snapshotPath}': ${countsReport(snap.data, snap.alerts, snap.groups)}`,
    );
    console.log(`pre-rescue state preserved in '${join(dir, preserveDir)}' (kept, never auto-cleaned)`);
    return 0;
  });
}

// 每日能耗阈值告警:规则管理、评估、告警历史查询与确认。
//
// 规则分两类,由 targetType 区分:
// - device 规则绑定一个已有设备;
// - group 规则绑定一个已有分组标识(不冻结创建时成员,每天按当时生效的成员
//   版本计算,允许日内切换)。
// 设备与分组即使同名也是不同目标;规则标识在两类规则间统一唯一(去首尾空白、
// 区分大小写)。阈值为非负、最多三位小数的 kWh,绑定目标与阈值创建后固定。
// 每条规则带固定时区(创建时 --tz 指定 IANA 名,省略为 UTC;按运行环境解析后
// 的规范名存储与比较,省略与显式 UTC 等价),评估与历史的日期按规则时区的当地
// 日期解释。规则可带可选的最大采样间隔限制(创建时 --max-interval 指定正整数
// 秒数,省略为无上限,创建后固定):非下降相邻区间的实际时间差超过限制时整个
// 区间视为未知,等于限制仍可信;下降区间即使超过限制仍为异常。相同标识、同
// 目标类型、同目标标识、等价阈值、同时区及同间隔限制重试成功且不重复创建,
// 任一不同即报冲突。
//
// 分组规则另可在创建时用 --schedule 指定本地运行时间表(格式与
// group schedule-report 相同:每周窗口 + 可选日期例外),成为非运行时段告警
// 规则;省略为全天模式,设备规则不接受时间表。创建时把解析后的时间表规范形
// (每周运行窗口并集 + 例外日期映射及各日窗口并集)保存在规则内,原文件后续
// 修改、移动或删除不影响规则;时间表与目标、阈值、时区、采样限制一样创建后
// 固定。同标识重试比较模式、每周运行窗口并集与例外日期映射(不比较文件路径;
// 窗口顺序、重复及等价拆分不影响等价性;明确停运与没有例外不同),其余参数
// 沿用原比较规则,任一不同即报冲突。例外按规则时区的当地日期匹配,整体替换
// 当天运行集合(含上一日每周跨夜窗口的尾段),仅作用于当天。非运行模式每天
// 只取该日期全部实际时段中的非运行部分参与判定:非运行时段全部有效才比较
// 合计消耗(运行时段的异常或未知不阻止判定),严格超阈值才触发,零增长有效;
// 非运行部分有异常或未知则不可判定,不触发也不恢复;没有非运行秒数的日期
// 说明原因(含全天停运例外),不判定、不触发也不恢复。评估与历史显示非运行
// UTC 时段、当前消耗、有效/异常/未知(及过长间隔未知)秒数与所用例外,覆盖
// 合计等于当天非运行时长;触发与恢复记录的消耗为非运行值。列表显示模式及
// 固定时间表(含例外日期及窗口或全天停运);旧规则与旧快照按全天模式或无
// 例外使用,非法已存模式、时间表或例外按损坏数据拒绝。
//
// - 评估针对连续完整的当地日期(起日含、止日不含)。每个日期统计归属该日期的
//   全部实际 UTC 时段,不把当地午夜套用固定偏移:夏令时短日不补未知,回拨
//   重复小时完整计入,日期回退的不连续时段合并为同一天、一次评估只作一次
//   判定;整日被跳过的日期标明跳过,不判定、不创建也不恢复告警。设备规则复用
//   daily 的完整时序、均匀分摊与累计比例向下取整口径;分组规则复用 group daily
//   的联合覆盖口径:每天按当时生效的成员版本切分时段(允许日内切换),任一成员
//   下降为异常,否则任一成员未知为未知,首个版本生效前为未知;成员切换不重置
//   各设备原读数区间的分摊起点。仅全天有效覆盖的日期可判定,消耗严格大于阈值
//   才超限,等于阈值视为正常;有未知或下降覆盖时不可判定,不触发也不恢复;
//   零增长是有效数据。
// - 每条规则的每个日期独立跟踪:首次判定超限创建全局唯一标识的未确认告警,
//   重复超限保留原标识且不新增事件;后续完整评估正常才记录恢复;恢复后再
//   超限创建新的未确认告警,旧记录保留,原确认不转移给新告警。
// - 确认按告警标识,已恢复告警也可确认;重复确认成功且不重复记事;确认不
//   改变超限或恢复状态。
// - 规则与历史存于数据目录的 alerts.json(与 readings.json、groups.json 相互
//   独立,导入与补录成员版本都不会自动评估)。创建、评估、确认都先在内存完成
//   全部计算再一次性原子写入,任何失败不留下部分状态;损坏或不可读存储明确
//   报错,绝不当作空库;存储内非法时区按损坏处理,不能回退为 UTC;存储内非法
//   间隔限制同样按损坏数据拒绝,不能悄悄忽略。旧版仅含 device 字段、无时区、
//   无间隔限制的规则按 UTC、无上限继续使用,无需手工转换。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  alertFilePath,
  dataFilePath,
  groupFilePath,
  loadStore,
  parseStoredMilli,
  StoreError,
  type Reading,
} from './store.ts';
import { computeDay, DAY_SECONDS, formatGapLine, maxIntervalText, mergeGaps, type DayStats, type GapDetail } from './report.ts';
import { computeGroupSegment, loadCheckedSeriesByDevice, loadGroups, type Group } from './groups.ts';
import {
  canonicalizeSchedule,
  classifyPeriods,
  formatException,
  formatSchedule,
  validateStoredSchedule,
  type Schedule,
} from './schedule.ts';
import { formatIsoUtc, parseUtcDate } from './time.ts';
import { canonicalTimezone, loadTimezone, localDateRange, type LocalDay, type LocalDayPeriod } from './tz.ts';
import { formatKwh } from './value.ts';

export type RuleTargetType = 'device' | 'group';

export interface AlertRule {
  /** 规则标识(非空、唯一,已去首尾空白,设备与分组规则间统一唯一)。 */
  id: string;
  /** 目标类型:设备或分组。 */
  targetType: RuleTargetType;
  /** 绑定的设备或分组标识(已去首尾空白,区分大小写),创建后固定。 */
  targetId: string;
  /** 阈值,毫千瓦时 BigInt,创建后固定。 */
  thresholdMilli: bigint;
  /** 评估时区,运行环境解析后的规范 IANA 名(省略为 UTC),创建后固定。 */
  tz: string;
  /** 最大采样间隔限制(正整数秒);省略表示无上限。创建后固定。 */
  maxInterval?: number;
  /** 非运行模式的固定时间表(规范形:每周运行窗口并集 + 日期例外,例外按
   *  当地日期整体替换当天运行集合);省略表示全天模式。仅分组规则可带,创建
   *  时保存解析结果,与原时间表文件后续变化无关;创建后固定。 */
  schedule?: Schedule;
}

export type AlertEventType = 'triggered' | 'recovered' | 'acknowledged';

export interface AlertEvent {
  /** 全局单调递增序号,决定触发/恢复/确认的处理顺序。 */
  seq: number;
  type: AlertEventType;
  /** 触发/恢复时该日的分摊消耗(毫千瓦时十进制字符串,可能超出 Number 安全范围)。 */
  consumptionMilli?: string;
}

export interface AlertRecord {
  /** 告警标识,全局唯一(设备与分组规则共用编号空间)。 */
  id: string;
  ruleId: string;
  /** 规则时区下的当地日期,YYYY-MM-DD(UTC 规则即 UTC 日期)。 */
  date: string;
  /** 检测状态:triggered 超限未恢复;recovered 已恢复。 */
  status: 'triggered' | 'recovered';
  acknowledged: boolean;
  events: AlertEvent[];
}

export interface AlertState {
  nextAlertNum: number;
  nextEventSeq: number;
  rules: AlertRule[];
  alerts: AlertRecord[];
}

function err(message: string): void {
  console.error(`meterwatch: ${message}`);
}

function emptyState(): AlertState {
  return { nextAlertNum: 1, nextEventSeq: 1, rules: [], alerts: [] };
}

/** 目标在输出中的显示形式,如 device=meter-1 / group=floor-1。 */
function targetLabel(rule: Pick<AlertRule, 'targetType' | 'targetId'>): string {
  return `${rule.targetType}=${rule.targetId}`;
}

/** 规则模式:带固定时间表的分组规则为非运行模式,否则为全天模式。 */
function ruleMode(rule: Pick<AlertRule, 'schedule'>): 'all-day' | 'non-running' {
  return rule.schedule === undefined ? 'all-day' : 'non-running';
}

/** 模式与固定时间表的显示形式(非运行模式附规范形窗口列表)。 */
function modeText(rule: Pick<AlertRule, 'schedule'>): string {
  return rule.schedule === undefined
    ? 'mode=all-day'
    : `mode=non-running schedule=${formatSchedule(rule.schedule)}`;
}

/**
 * 时间表等价性:两边都取规范形后比较每周运行窗口并集与例外日期映射(各日
 * 窗口并集与停运标记)。窗口/例外的顺序、重复及等价拆分不影响等价性;明确
 * 停运与没有例外不同;不比较任何文件路径。两边都省略(全天模式)才相等。
 */
function scheduleEquals(a?: Schedule, b?: Schedule): boolean {
  if (a === undefined || b === undefined) return a === b;
  const ca = canonicalizeSchedule(a);
  const cb = canonicalizeSchedule(b);
  if (ca.windows.length !== cb.windows.length) return false;
  for (let i = 0; i < ca.windows.length; i++) {
    const w = ca.windows[i];
    const v = cb.windows[i];
    if (w.startDow !== v.startDow || w.startMin !== v.startMin || w.endMin !== v.endMin) {
      return false;
    }
  }
  if (ca.exceptions.length !== cb.exceptions.length) return false;
  for (let i = 0; i < ca.exceptions.length; i++) {
    const x = ca.exceptions[i];
    const y = cb.exceptions[i];
    if (x.date !== y.date || x.shutdown !== y.shutdown || x.windows.length !== y.windows.length) {
      return false;
    }
    for (let j = 0; j < x.windows.length; j++) {
      if (x.windows[j].startMin !== y.windows[j].startMin || x.windows[j].endMin !== y.windows[j].endMin) {
        return false;
      }
    }
  }
  return true;
}

/**
 * 解析告警存储的 JSON 结构。结构非法抛出 StoreError;source 用于错误消息
 * (如 `storage file <path>`)。旧版仅含 device 字段、无时区的规则按 UTC 读入。
 */
export function parseAlertState(data: unknown, source: string): AlertState {
  const bad = (what: string): StoreError =>
    new StoreError(`${source} is corrupted (${what})`);
  const o = data as Record<string, unknown>;
  if (o === null || typeof o !== 'object') throw bad('not an object');
  if (!Number.isSafeInteger(o.nextAlertNum) || (o.nextAlertNum as number) < 1) {
    throw bad('invalid nextAlertNum');
  }
  if (!Number.isSafeInteger(o.nextEventSeq) || (o.nextEventSeq as number) < 1) {
    throw bad('invalid nextEventSeq');
  }
  if (!Array.isArray(o.rules)) throw bad('missing rules array');
  if (!Array.isArray(o.alerts)) throw bad('missing alerts array');

  const ruleIds = new Set<string>();
  const rules: AlertRule[] = [];
  for (const r of o.rules as Array<Record<string, unknown>>) {
    // 阈值兼容旧格式的安全整数数值;超出安全整数范围的数值型阈值精度已丢失,
    // 按损坏数据拒绝,不猜测原值。
    const thresholdMilli = r !== null && typeof r === 'object' ? parseStoredMilli(r.thresholdMilli) : null;
    if (
      r === null ||
      typeof r !== 'object' ||
      typeof r.id !== 'string' ||
      r.id.length === 0 ||
      thresholdMilli === null
    ) {
      throw bad('invalid rule entry');
    }
    // 目标类型:新版字段 targetType/targetId;旧版只有 device 字段,按 device 规则
    // 读入,已有设备规则无需手工转换即可继续使用。
    let targetType: RuleTargetType;
    let targetId: string;
    if (r.targetType === undefined) {
      if (typeof r.device !== 'string' || r.device.length === 0) throw bad('invalid rule entry');
      targetType = 'device';
      targetId = r.device;
    } else {
      if (r.targetType !== 'device' && r.targetType !== 'group') {
        throw bad(`invalid targetType in rule '${r.id}'`);
      }
      if (typeof r.targetId !== 'string' || r.targetId.length === 0) {
        throw bad(`invalid targetId in rule '${r.id}'`);
      }
      targetType = r.targetType;
      targetId = r.targetId;
    }
    // 时区:新版字段 tz 存规范 IANA 名;旧版无时区的规则按 UTC 使用。存储内
    // 非法时区按损坏数据拒绝,不能回退为 UTC;合法写法统一解析为规范名。
    let tz = 'UTC';
    if (r.tz !== undefined) {
      if (typeof r.tz !== 'string' || r.tz.length === 0) {
        throw bad(`invalid timezone in rule '${r.id}'`);
      }
      const canonical = canonicalTimezone(r.tz);
      if (canonical === null) throw bad(`invalid timezone in rule '${r.id}'`);
      tz = canonical;
    }
    // 采样间隔限制:新版字段 maxInterval 存正整数秒;旧版无该字段的规则按
    // 无上限使用。存储内非法限制按损坏数据拒绝,不能悄悄忽略。
    let maxInterval: number | undefined;
    if (r.maxInterval !== undefined) {
      if (!Number.isSafeInteger(r.maxInterval) || (r.maxInterval as number) < 1) {
        throw bad(`invalid maxInterval in rule '${r.id}'`);
      }
      maxInterval = r.maxInterval as number;
    }
    // 模式与时间表:新版字段 mode/schedule;旧版无该字段的规则按全天模式
    // 使用。非法已存模式或时间表按损坏数据拒绝;非运行模式只适用于分组
    // 规则,全天模式不得带时间表。
    const mode = r.mode === undefined ? 'all-day' : r.mode;
    if (mode !== 'all-day' && mode !== 'non-running') {
      throw bad(`invalid mode in rule '${r.id}'`);
    }
    let schedule: ScheduleWindow[] | undefined;
    if (mode === 'non-running') {
      if (targetType !== 'group') throw bad(`non-running mode on device rule '${r.id}'`);
      const parsed = validateStoredSchedule(r.schedule);
      if (parsed === null) throw bad(`invalid schedule in rule '${r.id}'`);
      schedule = parsed;
    } else if (r.schedule !== undefined) {
      throw bad(`unexpected schedule in all-day rule '${r.id}'`);
    }
    if (ruleIds.has(r.id)) throw bad(`duplicate rule id '${r.id}'`);
    ruleIds.add(r.id);
    rules.push({
      id: r.id,
      targetType,
      targetId,
      thresholdMilli: thresholdMilli as bigint,
      tz,
      maxInterval,
      schedule,
    });
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const alertIds = new Set<string>();
  for (const a of o.alerts as Array<Record<string, unknown>>) {
    const ok =
      a !== null &&
      typeof a === 'object' &&
      typeof a.id === 'string' &&
      a.id.length > 0 &&
      typeof a.ruleId === 'string' &&
      ruleIds.has(a.ruleId) &&
      typeof a.date === 'string' &&
      DATE_RE.test(a.date) &&
      (a.status === 'triggered' || a.status === 'recovered') &&
      typeof a.acknowledged === 'boolean' &&
      Array.isArray(a.events) &&
      (a.events as unknown[]).length > 0;
    if (!ok) throw bad('invalid alert entry');
    if (alertIds.has(a.id)) throw bad(`duplicate alert id '${a.id}'`);
    alertIds.add(a.id);
    const seqs = new Set<number>();
    for (const e of a.events as Array<Record<string, unknown>>) {
      const eok =
        e !== null &&
        typeof e === 'object' &&
        Number.isSafeInteger(e.seq) &&
        (e.seq as number) >= 1 &&
        (e.type === 'triggered' || e.type === 'recovered' || e.type === 'acknowledged') &&
        (e.consumptionMilli === undefined ||
          (typeof e.consumptionMilli === 'string' && /^\d+$/.test(e.consumptionMilli)));
      if (!eok) throw bad('invalid alert event');
      if (seqs.has(e.seq as number)) throw bad(`duplicate event seq in alert '${a.id}'`);
      seqs.add(e.seq as number);
    }
  }
  return {
    nextAlertNum: o.nextAlertNum as number,
    nextEventSeq: o.nextEventSeq as number,
    rules,
    alerts: o.alerts as unknown as AlertRecord[],
  };
}

/** 读取告警存储;文件不存在返回空状态,存在但无法读取或内容损坏抛出 StoreError。 */
export function loadAlertState(path: string): AlertState {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw new StoreError(`cannot read storage file ${path}: ${(e as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StoreError(`storage file ${path} is corrupted (invalid JSON)`);
  }
  return parseAlertState(data, `storage file ${path}`);
}

/** 时间表的存储形式:无例外时沿用旧版窗口数组,有例外时为对象形态。 */
function serializeSchedule(schedule: Schedule): unknown {
  if (schedule.exceptions.length === 0) return schedule.windows;
  return { windows: schedule.windows, exceptions: schedule.exceptions };
}

/** 序列化为告警存储文件的 JSON 结构(阈值为十进制字符串,任意大数精确)。 */
export function serializeAlertState(state: AlertState): Record<string, unknown> {
  return {
    version: 2,
    ...state,
    rules: state.rules.map((r) => ({
      id: r.id,
      targetType: r.targetType,
      targetId: r.targetId,
      thresholdMilli: r.thresholdMilli.toString(),
      tz: r.tz,
      ...(r.maxInterval !== undefined ? { maxInterval: r.maxInterval } : {}),
      ...(r.schedule !== undefined ? { mode: 'non-running', schedule: serializeSchedule(r.schedule) } : {}),
    })),
  };
}

/**
 * 原子写入告警存储;失败抛错,原有数据保持不变。
 * 告警写入不触碰读数与成员版本文件。
 */
function saveAlertState(path: string, state: AlertState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const body = JSON.stringify(serializeAlertState(state), null, 2) + '\n';
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    throw new StoreError(`cannot write storage file ${path}: ${(e as Error).message}`);
  }
}

/**
 * 载入读数并取出指定设备的完整时序(按时刻排序)。
 * 同设备同一实际时刻存在多条存储记录时抛 StoreError。
 */
function deviceSeries(device: string): Reading[] {
  const all = loadStore(dataFilePath());
  const series = all.filter((r) => r.device === device).sort((a, b) => a.ts - b.ts);
  for (let i = 1; i < series.length; i++) {
    if (series[i].ts === series[i - 1].ts) {
      throw new StoreError(
        `storage error: multiple stored readings for device '${device}' at ${formatIsoUtc(series[i].ts)}`,
      );
    }
  }
  return series;
}

/**
 * 分组规则的评估环境:绑定分组与全库设备时序。
 * 读取读数时拒绝全库重复身份,包括不属于该分组的设备。
 */
interface GroupEnv {
  kind: 'group';
  group: Group;
  byDevice: Map<string, Reading[]>;
}

interface DeviceEnv {
  kind: 'device';
  series: Reading[];
}

type RuleEnv = DeviceEnv | GroupEnv;

/** 为规则准备评估环境;未知分组或存储损坏抛 StoreError。 */
function prepareEnv(rule: AlertRule): RuleEnv {
  if (rule.targetType === 'device') {
    return { kind: 'device', series: deviceSeries(rule.targetId) };
  }
  const groups = loadGroups(groupFilePath());
  const group = groups.find((g) => g.id === rule.targetId);
  if (!group) {
    throw new StoreError(
      `unknown group '${rule.targetId}' bound by rule '${rule.id}' (groups storage has no such group)`,
    );
  }
  const byDevice = loadCheckedSeriesByDevice(loadStore(dataFilePath()));
  return { kind: 'group', group, byDevice };
}

/** 一天的有效/异常/未知覆盖秒数后缀;采用间隔限制时附上过长间隔造成的未知秒数。 */
function coverageSuffix(
  stats: Pick<DayStats, 'valid' | 'anomaly' | 'unknown' | 'gapUnknown'>,
  limited: boolean,
): string {
  const base = `valid=${stats.valid}s anomaly=${stats.anomaly}s unknown=${stats.unknown}s`;
  return limited ? `${base} gap=${stats.gapUnknown}s` : base;
}

/**
 * 消耗比较短语:无有效覆盖时明确表示消耗无法计算(不显示 0、也不触发或恢复);
 * 有效(含零增长)时给出固定三位小数消耗及与阈值的比较。
 */
function consumptionCompare(stats: DayStats, threshold: bigint): string {
  if (stats.valid === 0) return 'consumption=n/a (no valid coverage)';
  const exceeded = stats.consumption > threshold;
  return (
    `consumption=${formatKwh(stats.consumption)} kWh ` +
    `${exceeded ? '>' : '<='} threshold=${formatKwh(threshold)} kWh`
  );
}

/** 一天各实际 UTC 时段的展示行(时段按实际时刻升序)。 */
function periodLines(periods: LocalDayPeriod[]): string[] {
  return periods.map((p) => `    period=${formatIsoUtc(p.start)}..${formatIsoUtc(p.end)}`);
}

/** 一天内过长区间明细的展示行(指出相关设备与原始相邻读数时刻)。 */
function gapLines(stats: Pick<DayStats, 'gaps'>, rule: AlertRule): string[] {
  return stats.gaps.map((g) => formatGapLine(g, rule.targetType === 'device' ? rule.targetId : undefined));
}

/** 规则时区的墙钟格式化器;存储载入时已校验,此处不会失败。 */
function ruleFormat(rule: AlertRule): Intl.DateTimeFormat {
  const fmt = loadTimezone(rule.tz);
  if (fmt === null) {
    throw new StoreError(`rule '${rule.id}' has invalid timezone '${rule.tz}' in storage`);
  }
  return fmt;
}

/**
 * 规则在一个当地日期上实际参与判定的 UTC 时段:全天模式为该日期的全部
 * 实际时段;非运行模式为这些时段按规则固定的每周运行时间表分类后的非
 * 运行部分(分类沿用 group schedule-report 的口径:按实际时刻的当地日期
 * 与墙钟,回拨重复小时各自分类,跳过时段不虚构)。同一日期的不连续时段
 * 分别分类后合并在同一日期下参与一次判定。
 */
function ruleDayPeriods(rule: AlertRule, fmt: Intl.DateTimeFormat, day: LocalDay): LocalDayPeriod[] {
  if (rule.schedule === undefined) return day.periods;
  const out: LocalDayPeriod[] = [];
  for (const p of day.periods) {
    out.push(...classifyPeriods(fmt, p.start, p.end, rule.schedule).nonRunning);
  }
  return out;
}

/** 规则固定时间表中适用于某当地日期的例外;无时间表或无该日例外时为 undefined。 */
function exceptionForDate(rule: AlertRule, label: string) {
  return rule.schedule?.exceptions.find((e) => e.date === label);
}

/** 一天所用例外的展示行;无例外时返回 null。 */
function exceptionLine(rule: AlertRule, label: string): string | null {
  const exc = exceptionForDate(rule, label);
  if (exc === undefined) return null;
  return `    exception: ${formatException(exc)} (replaces weekly windows for this local date)`;
}

/** 当天没有非运行秒数的原因(区分全天停运例外、例外窗口覆盖全天与每周窗口覆盖全天)。 */
function noNonRunningReason(rule: AlertRule, label: string): string {
  const exc = exceptionForDate(rule, label);
  if (exc !== undefined) {
    return exc.shutdown
      ? 'date exception: full-day shutdown'
      : 'date exception windows cover the whole local date';
  }
  return 'running windows cover the whole local date';
}

/**
 * 计算规则在给定 UTC 时段集合上的统计(这些时段属于同一当地日期)。
 * 设备规则用 daily 口径,分组规则用 group daily 的联合覆盖口径;
 * 日界线、时间表边界与成员切换都不重置各设备原读数区间的分摊起点。
 * maxInterval 为规则固定的采样间隔限制(省略为无上限)。
 */
function computeRuleDay(env: RuleEnv, periods: LocalDayPeriod[], maxInterval?: number): DayStats {
  let valid = 0;
  let anomaly = 0;
  let unknown = 0;
  let gapUnknown = 0;
  const gaps: GapDetail[] = [];
  let consumption = 0n;
  for (const p of periods) {
    if (env.kind === 'device') {
      const s = computeDay(env.series, p.start, p.end, maxInterval);
      valid += s.valid;
      anomaly += s.anomaly;
      unknown += s.unknown;
      gapUnknown += s.gapUnknown;
      mergeGaps(gaps, s.gaps);
      consumption += s.consumption;
    } else {
      const s = computeGroupSegment(env.group.versions, env.byDevice, p.start, p.end, maxInterval);
      valid += s.valid;
      anomaly += s.anomaly;
      unknown += s.unknown;
      gapUnknown += s.gapUnknown;
      mergeGaps(gaps, s.gaps);
      consumption += s.consumption;
    }
  }
  return { valid, anomaly, unknown, gapUnknown, gaps, consumption };
}

/**
 * 创建规则。相同标识、同目标类型、同目标标识、等价阈值、同时区(规范名)、
 * 同采样间隔限制及同模式(非运行模式比较每周运行窗口并集,不比较文件路径)
 * 重试成功且不重复创建;任一不同即报冲突。设备必须已有存储读数;分组必须
 * 已配置。非运行模式(带固定时间表,仅分组规则)的创建与同参重试都先检查
 * 所用存储与全库重复读数身份。返回进程退出码。
 */
export function cmdRuleCreate(opts: {
  id: string;
  targetType: RuleTargetType;
  targetId: string;
  thresholdMilli: bigint;
  /** 规范 IANA 时区名(调用方已解析;省略时传 'UTC')。 */
  tz: string;
  /** 最大采样间隔限制(正整数秒);省略表示无上限,创建后固定。 */
  maxInterval?: number;
  /** 非运行模式的时间表(已解析并规范化:每周窗口并集 + 日期例外);省略为
   *  全天模式。仅分组规则可带;创建时保存解析结果,与原文件后续变化无关。 */
  schedule?: Schedule;
}): number {
  const statePath = alertFilePath();
  let state: AlertState;
  try {
    state = loadAlertState(statePath);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  // 非运行模式:新模式创建与同参重试都先检查所用存储(分组、读数)及全库
  // 重复读数身份,再比较参数或写入。
  let groups: Group[] | undefined;
  if (opts.schedule !== undefined) {
    try {
      groups = loadGroups(groupFilePath());
      loadCheckedSeriesByDevice(loadStore(dataFilePath()));
    } catch (e) {
      if (e instanceof StoreError) {
        err(e.message);
        return 1;
      }
      throw e;
    }
  }

  const got = `${opts.targetType}=${opts.targetId}`;
  const existing = state.rules.find((r) => r.id === opts.id);
  if (existing) {
    if (
      existing.targetType === opts.targetType &&
      existing.targetId === opts.targetId &&
      existing.thresholdMilli === opts.thresholdMilli &&
      existing.tz === opts.tz &&
      existing.maxInterval === opts.maxInterval &&
      scheduleEquals(existing.schedule, opts.schedule)
    ) {
      console.log(
        `rule '${opts.id}' already exists with identical parameters (${targetLabel(existing)} ` +
          `threshold=${formatKwh(existing.thresholdMilli)} kWh tz=${existing.tz} ` +
          `max-interval=${maxIntervalText(existing.maxInterval)} ${modeText(existing)}); unchanged`,
      );
      return 0;
    }
    err(
      `rule '${opts.id}' already exists with different parameters ` +
        `(stored ${targetLabel(existing)} threshold=${formatKwh(existing.thresholdMilli)} kWh ` +
        `tz=${existing.tz} max-interval=${maxIntervalText(existing.maxInterval)} ${modeText(existing)}, ` +
        `got ${got} threshold=${formatKwh(opts.thresholdMilli)} kWh ` +
        `tz=${opts.tz} max-interval=${maxIntervalText(opts.maxInterval)} ${modeText(opts)}); conflict`,
    );
    return 1;
  }

  // 目标存在性:设备需已有存储读数;分组需已配置(配置时已保证成员设备存在)。
  try {
    if (opts.targetType === 'device') {
      const devices = new Set(loadStore(dataFilePath()).map((r) => r.device));
      if (!devices.has(opts.targetId)) {
        err(`unknown device '${opts.targetId}': no stored readings; import readings before creating a rule`);
        return 1;
      }
    } else {
      const known = groups ?? loadGroups(groupFilePath());
      if (!known.some((g) => g.id === opts.targetId)) {
        err(`unknown group '${opts.targetId}': configure the group before creating a rule`);
        return 1;
      }
    }
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  state.rules.push({
    id: opts.id,
    targetType: opts.targetType,
    targetId: opts.targetId,
    thresholdMilli: opts.thresholdMilli,
    tz: opts.tz,
    maxInterval: opts.maxInterval,
    schedule: opts.schedule,
  });
  try {
    saveAlertState(statePath, state);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  console.log(
    `rule '${opts.id}' created: ${got} threshold=${formatKwh(opts.thresholdMilli)} kWh ` +
      `tz=${opts.tz} max-interval=${maxIntervalText(opts.maxInterval)} ${modeText(opts)}`,
  );
  return 0;
}

/** 列出全部规则(含目标类型、时区、采样间隔限制、模式及固定时间表)。只读。返回进程退出码。 */
export function cmdRuleList(): number {
  let state: AlertState;
  try {
    state = loadAlertState(alertFilePath());
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  if (state.rules.length === 0) {
    console.log('no rules defined');
    return 0;
  }
  const rules = [...state.rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of rules) {
    const open = state.alerts.filter((a) => a.ruleId === r.id && a.status === 'triggered').length;
    console.log(
      `rule ${r.id}  ${targetLabel(r)}  threshold=${formatKwh(r.thresholdMilli)} kWh  ` +
        `tz=${r.tz}  max-interval=${maxIntervalText(r.maxInterval)}  ${modeText(r)}  open alerts=${open}`,
    );
  }
  return 0;
}

/**
 * 评估规则在连续完整当地日期范围 [from, to)(规则时区的 YYYY-MM-DD,起日含、
 * 止日不含)上的超限情况。每个日期统计归属该日期的全部实际 UTC 时段,一次
 * 评估只作一次判定;整日被跳过的日期标明跳过,不判定、不创建也不恢复告警。
 * 非运行模式的规则每天只取这些时段中的非运行部分参与判定(运行时段的异常
 * 或未知不阻止判定);没有非运行秒数的日期标明原因,同样不判定、不创建也
 * 不恢复。全部日期计算并应用到内存状态后一次性原子写入,不部分提交;中途
 * 任一存储或数据错误都在写入前抛出,操作前状态保留。返回进程退出码。
 */
export function cmdEvaluate(opts: { ruleId: string; from: string; to: string }): number {
  const statePath = alertFilePath();
  let state: AlertState;
  let rule: AlertRule;
  let env: RuleEnv;
  let fmt: Intl.DateTimeFormat;
  try {
    state = loadAlertState(statePath);
    const found = state.rules.find((r) => r.id === opts.ruleId);
    if (!found) {
      err(`unknown rule '${opts.ruleId}'`);
      return 1;
    }
    rule = found;
    env = prepareEnv(rule);
    fmt = ruleFormat(rule);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  // 既有告警标识集合:新标识不得与旧告警冲突(正常情况下编号单调递增不可能
  // 碰撞,这里再显式防御,碰撞则整体中止且不写入)。
  const alertIds = new Set(state.alerts.map((a) => a.id));

  const threshold = rule.thresholdMilli;
  const limited = rule.maxInterval !== undefined;
  const lines: string[] = [];
  for (const { label, day } of localDateRange(fmt, opts.from, opts.to)) {
    if (day === null) {
      // 整日被跳过(无实际时段):不判定、不触发也不恢复。
      lines.push(`  ${label}  SKIPPED (no such local date in timezone ${rule.tz})  no alert action`);
      continue;
    }
    // 全天模式为当天全部实际时段;非运行模式只取其中的非运行部分。
    const periods = ruleDayPeriods(rule, fmt, day);
    let periodSeconds = 0;
    for (const p of periods) periodSeconds += p.end - p.start;
    if (periodSeconds === 0) {
      // 非运行模式且当天没有非运行秒数:说明原因(含全天停运例外),不判定、
      // 不触发也不恢复。
      lines.push(`  ${label}  NO NON-RUNNING COVERAGE (${noNonRunningReason(rule, label)})  no alert action`);
      const exc = exceptionLine(rule, label);
      if (exc !== null) lines.push(exc);
      continue;
    }
    const stats = computeRuleDay(env, periods, rule.maxInterval);
    const coverage = coverageSuffix(stats, limited);
    const excLine = exceptionLine(rule, label);
    if (stats.unknown > 0 || stats.anomaly > 0) {
      // 有未知或下降覆盖:不可判定,不触发也不恢复。无有效覆盖时明确显示
      // 消耗无法计算(不显示 0);仍有部分有效覆盖时只给覆盖与原因,不与阈值比较。
      const head =
        stats.valid === 0
          ? `  ${label}  undecidable  ${consumptionCompare(stats, threshold)}  (${coverage})  no alert action`
          : `  ${label}  undecidable (${coverage})  no alert action`;
      lines.push(head);
      if (excLine !== null) lines.push(excLine);
      lines.push(...periodLines(periods));
      lines.push(...gapLines(stats, rule));
      continue;
    }
    const exceeded = stats.consumption > threshold;
    const cmp = consumptionCompare(stats, threshold);
    const open = state.alerts.find(
      (a) => a.ruleId === rule.id && a.date === label && a.status === 'triggered',
    );
    if (exceeded) {
      if (open) {
        // 重复超限:保留原标识,不新增事件。
        lines.push(`  ${label}  ${cmp}  EXCEEDED  alert ${open.id} remains triggered  ${coverage}`);
      } else {
        const id = `alert-${state.nextAlertNum++}`;
        if (alertIds.has(id)) {
          err(`storage error: generated alert id '${id}' already exists; nothing was written`);
          return 1;
        }
        alertIds.add(id);
        state.alerts.push({
          id,
          ruleId: rule.id,
          date: label,
          status: 'triggered',
          acknowledged: false,
          events: [
            { seq: state.nextEventSeq++, type: 'triggered', consumptionMilli: stats.consumption.toString() },
          ],
        });
        lines.push(`  ${label}  ${cmp}  EXCEEDED  alert ${id} triggered (unacknowledged)  ${coverage}`);
      }
    } else {
      if (open) {
        open.status = 'recovered';
        open.events.push({
          seq: state.nextEventSeq++,
          type: 'recovered',
          consumptionMilli: stats.consumption.toString(),
        });
        lines.push(`  ${label}  ${cmp}  NORMAL  alert ${open.id} recovered  ${coverage}`);
      } else {
        lines.push(`  ${label}  ${cmp}  NORMAL  no alert  ${coverage}`);
      }
    }
    if (excLine !== null) lines.push(excLine);
    lines.push(...periodLines(periods));
  }

  try {
    saveAlertState(statePath, state);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  console.log(
    `rule: ${rule.id}  ${targetLabel(rule)}  threshold=${formatKwh(rule.thresholdMilli)} kWh  ` +
      `tz=${rule.tz}  max-interval=${maxIntervalText(rule.maxInterval)}  ${modeText(rule)}`,
  );
  for (const line of lines) console.log(line);
  return 0;
}

/**
 * 查询规则的告警历史。只读,不修改数据,也不会隐式恢复。
 * 给定日期范围时按规则时区的当地日期逐日展示当前计算的消耗或不可判定原因、
 * 实际 UTC 时段与各次告警;省略范围时展示有告警记录的全部日期。触发/恢复
 * 事件中的消耗为评估当时记录,不随后续数据变化改写。返回进程退出码。
 */
export function cmdAlerts(opts: { ruleId: string; from?: string; to?: string }): number {
  let state: AlertState;
  let rule: AlertRule;
  let env: RuleEnv;
  let fmt: Intl.DateTimeFormat;
  try {
    state = loadAlertState(alertFilePath());
    const found = state.rules.find((r) => r.id === opts.ruleId);
    if (!found) {
      err(`unknown rule '${opts.ruleId}'`);
      return 1;
    }
    rule = found;
    env = prepareEnv(rule);
    fmt = ruleFormat(rule);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  // 待展示的当地日期(升序):给定范围时为范围内全部日期;省略范围时为有告警
  // 记录的全部日期。
  let labels: string[];
  if (opts.from !== undefined && opts.to !== undefined) {
    labels = localDateRange(fmt, opts.from, opts.to).map((e) => e.label);
  } else {
    labels = [
      ...new Set(state.alerts.filter((a) => a.ruleId === rule.id).map((a) => a.date)),
    ].sort();
  }

  console.log(
    `rule: ${rule.id}  ${targetLabel(rule)}  threshold=${formatKwh(rule.thresholdMilli)} kWh  ` +
      `tz=${rule.tz}  max-interval=${maxIntervalText(rule.maxInterval)}  ${modeText(rule)}`,
  );
  if (labels.length === 0) {
    console.log(`  no alerts recorded for rule '${rule.id}'`);
    return 0;
  }

  // 各当地日期的实际 UTC 时段;整日被跳过的日期为 null。日历日期逐日递增,
  // 末日后延一天作为切分终点。
  const last = parseUtcDate(labels[labels.length - 1]) as number;
  const endLabel = formatIsoUtc(last + DAY_SECONDS).slice(0, 10);
  const byLabel = new Map<string, LocalDay | null>();
  for (const e of localDateRange(fmt, labels[0], endLabel)) byLabel.set(e.label, e.day);

  const threshold = rule.thresholdMilli;
  const limited = rule.maxInterval !== undefined;
  for (const label of labels) {
    const day = byLabel.get(label) ?? null;
    if (day === null) {
      console.log(`  ${label}  SKIPPED (no such local date in timezone ${rule.tz})`);
    } else {
      // 全天模式为当天全部实际时段;非运行模式只取其中的非运行部分。
      const periods = ruleDayPeriods(rule, fmt, day);
      let periodSeconds = 0;
      for (const p of periods) periodSeconds += p.end - p.start;
      if (periodSeconds === 0) {
        console.log(`  ${label}  NO NON-RUNNING COVERAGE (${noNonRunningReason(rule, label)})`);
        const exc = exceptionLine(rule, label);
        if (exc !== null) console.log(exc);
      } else {
        const stats = computeRuleDay(env, periods, rule.maxInterval);
        if (stats.unknown > 0 || stats.anomaly > 0) {
          // 不可判定;无有效覆盖时明确显示消耗无法计算,不显示 0 或与阈值比较。
          const head =
            stats.valid === 0
              ? `  ${label}  undecidable  ${consumptionCompare(stats, threshold)}  (${coverageSuffix(stats, limited)})`
              : `  ${label}  undecidable (${coverageSuffix(stats, limited)})`;
          console.log(head);
        } else {
          const verdict = stats.consumption > threshold ? 'EXCEEDED' : 'NORMAL';
          console.log(
            `  ${label}  consumption=${formatKwh(stats.consumption)} kWh ` +
              `(${verdict}, threshold=${formatKwh(rule.thresholdMilli)} kWh)  ${coverageSuffix(stats, limited)}`,
          );
        }
        const exc = exceptionLine(rule, label);
        if (exc !== null) console.log(exc);
        for (const line of periodLines(periods)) console.log(line);
        for (const line of gapLines(stats, rule)) console.log(line);
      }
    }
    const alerts = state.alerts
      .filter((a) => a.ruleId === rule.id && a.date === label)
      .sort((a, b) => a.events[0].seq - b.events[0].seq);
    if (alerts.length === 0) {
      console.log('    no alerts');
      continue;
    }
    for (const a of alerts) {
      console.log(
        `    alert ${a.id}  status=${a.status.toUpperCase()}  ` +
          `ack=${a.acknowledged ? 'ACKNOWLEDGED' : 'UNACKNOWLEDGED'}`,
      );
      const events = a.events
        .map((e) => {
          const consumption =
            e.consumptionMilli !== undefined
              ? ` (consumption=${formatKwh(BigInt(e.consumptionMilli))} kWh)`
              : '';
          return `#${e.seq} ${e.type}${consumption}`;
        })
        .join(', ');
      console.log(`      events: ${events}`);
    }
  }
  return 0;
}

/**
 * 按标识确认告警。已恢复告警也可确认;重复确认成功且不重复记事;
 * 确认不改变超限或恢复状态。返回进程退出码。
 */
export function cmdAck(alertId: string): number {
  const statePath = alertFilePath();
  let state: AlertState;
  try {
    state = loadAlertState(statePath);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  const alert = state.alerts.find((a) => a.id === alertId);
  if (!alert) {
    err(`unknown alert '${alertId}'`);
    return 1;
  }
  if (alert.acknowledged) {
    console.log(`alert ${alert.id} already acknowledged; unchanged`);
    return 0;
  }
  alert.acknowledged = true;
  alert.events.push({ seq: state.nextEventSeq++, type: 'acknowledged' });
  try {
    saveAlertState(statePath, state);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  const rule = state.rules.find((r) => r.id === alert.ruleId);
  const target = rule ? ` ${targetLabel(rule)}` : '';
  console.log(
    `alert ${alert.id} acknowledged (rule=${alert.ruleId}${target} date=${alert.date} status=${alert.status})`,
  );
  return 0;
}

// 每日能耗阈值告警:规则管理、评估、告警历史查询与确认。
//
// - 规则由使用者指定非空唯一标识,绑定一个已有设备与非负、最多三位小数的
//   kWh 阈值;创建后设备与阈值固定。相同标识等价参数重试成功且不重复创建,
//   异参重试报冲突。
// - 评估针对连续完整 UTC 日期(起日含、止日不含),复用 daily 的完整时序、
//   均匀分摊与累计比例向下取整口径;仅全天有效覆盖的日期可判定,消耗严格
//   大于阈值才超限,等于阈值视为正常;有未知或下降覆盖时不可判定,不触发
//   也不恢复;零增长是有效数据。
// - 每条规则的每个日期独立跟踪:首次判定超限创建带唯一标识的未确认告警,
//   重复超限保留原标识且不新增事件;后续完整评估正常才记录恢复;恢复后再
//   超限创建新的未确认告警,旧记录保留,原确认不转移给新告警。
// - 确认按告警标识,已恢复告警也可确认;重复确认成功且不重复记事;确认不
//   改变超限或恢复状态。
// - 规则与历史存于数据目录的 alerts.json(与 readings.json 相互独立,导入
//   不触碰本文件,也不会自动评估)。创建、评估、确认都先在内存完成全部计算
//   再一次性原子写入,任何失败不留下部分状态;损坏或不可读存储明确报错,
//   绝不当作空库。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { alertFilePath, dataFilePath, loadStore, StoreError, type Reading } from './store.ts';
import { computeDay, DAY_SECONDS } from './report.ts';
import { formatIsoUtc, parseIso8601 } from './time.ts';
import { formatKwh, milliToJson, parseStoredMilli } from './value.ts';

export interface AlertRule {
  /** 规则标识(非空、唯一,已去首尾空白)。 */
  id: string;
  /** 绑定设备(已去首尾空白,区分大小写),创建后固定。 */
  device: string;
  /** 阈值,毫千瓦时 BigInt 整数(可超出 Number 安全范围),创建后固定。 */
  thresholdMilli: bigint;
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
  /** 告警标识,全局唯一。 */
  id: string;
  ruleId: string;
  /** UTC 日期,YYYY-MM-DD。 */
  date: string;
  /** 检测状态:triggered 超限未恢复;recovered 已恢复。 */
  status: 'triggered' | 'recovered';
  acknowledged: boolean;
  events: AlertEvent[];
}

interface AlertState {
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

/** 读取告警存储;文件不存在返回空状态,存在但无法读取或内容损坏抛出 StoreError。 */
function loadAlertState(path: string): AlertState {
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
  const bad = (what: string): StoreError =>
    new StoreError(`storage file ${path} is corrupted (${what})`);
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
    // thresholdMilli 兼容旧的数值型安全整数与新的十进制字符串;数值型超出
    // 安全整数范围时原值已不可知,按损坏数据拒绝,不猜测原值。
    const thresholdMilli =
      r !== null && typeof r === 'object' ? parseStoredMilli(r.thresholdMilli) : null;
    const ok =
      r !== null &&
      typeof r === 'object' &&
      typeof r.id === 'string' &&
      r.id.length > 0 &&
      typeof r.device === 'string' &&
      r.device.length > 0 &&
      thresholdMilli !== null;
    if (!ok) throw bad('invalid rule entry');
    if (ruleIds.has(r.id as string)) throw bad(`duplicate rule id '${r.id}'`);
    ruleIds.add(r.id as string);
    rules.push({ id: r.id as string, device: r.device as string, thresholdMilli });
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
      Array.isArray(a.events);
    if (!ok) throw bad('invalid alert entry');
    if (alertIds.has(a.id as string)) throw bad(`duplicate alert id '${a.id}'`);
    alertIds.add(a.id as string);
    for (const e of a.events as Array<Record<string, unknown>>) {
      const eok =
        e !== null &&
        typeof e === 'object' &&
        Number.isSafeInteger(e.seq) &&
        (e.type === 'triggered' || e.type === 'recovered' || e.type === 'acknowledged') &&
        (e.consumptionMilli === undefined ||
          (typeof e.consumptionMilli === 'string' && /^\d+$/.test(e.consumptionMilli)));
      if (!eok) throw bad('invalid alert event');
    }
  }
  return {
    nextAlertNum: o.nextAlertNum as number,
    nextEventSeq: o.nextEventSeq as number,
    rules,
    alerts: o.alerts as AlertRecord[],
  };
}

/** 原子写入告警存储;失败抛错,原有数据保持不变。 */
function saveAlertState(path: string, state: AlertState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const body =
    JSON.stringify(
      {
        version: 1,
        ...state,
        rules: state.rules.map((r) => ({
          id: r.id,
          device: r.device,
          thresholdMilli: milliToJson(r.thresholdMilli),
        })),
      },
      null,
      2,
    ) + '\n';
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

/** 不可判定原因(未知/异常覆盖秒数)。 */
function undecidableReason(stats: { unknown: number; anomaly: number }): string {
  return `undecidable (unknown=${stats.unknown}s anomaly=${stats.anomaly}s)`;
}

/**
 * 创建规则。相同标识等价参数(同设备、同阈值)重试成功且不重复创建;
 * 异参重试报冲突。设备必须已有存储读数。返回进程退出码。
 */
export function cmdRuleCreate(opts: {
  id: string;
  device: string;
  thresholdMilli: bigint;
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

  const existing = state.rules.find((r) => r.id === opts.id);
  if (existing) {
    if (existing.device === opts.device && existing.thresholdMilli === opts.thresholdMilli) {
      console.log(
        `rule '${opts.id}' already exists with identical parameters (device=${existing.device} threshold=${formatKwh(existing.thresholdMilli)} kWh); unchanged`,
      );
      return 0;
    }
    err(
      `rule '${opts.id}' already exists with different parameters ` +
        `(stored device=${existing.device} threshold=${formatKwh(existing.thresholdMilli)} kWh, ` +
        `got device=${opts.device} threshold=${formatKwh(opts.thresholdMilli)} kWh); conflict`,
    );
    return 1;
  }

  let devices: Set<string>;
  try {
    devices = new Set(loadStore(dataFilePath()).map((r) => r.device));
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  if (!devices.has(opts.device)) {
    err(`unknown device '${opts.device}': no stored readings; import readings before creating a rule`);
    return 1;
  }

  state.rules.push({ id: opts.id, device: opts.device, thresholdMilli: opts.thresholdMilli });
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
    `rule '${opts.id}' created: device=${opts.device} threshold=${formatKwh(opts.thresholdMilli)} kWh`,
  );
  return 0;
}

/** 列出全部规则。只读。返回进程退出码。 */
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
      `rule ${r.id}  device=${r.device}  threshold=${formatKwh(r.thresholdMilli)} kWh  open alerts=${open}`,
    );
  }
  return 0;
}

/**
 * 评估规则在连续完整 UTC 日期范围 [from, to) 上的超限情况。
 * 全部日期计算并应用到内存状态后一次性原子写入,不部分提交。
 * 返回进程退出码。
 */
export function cmdEvaluate(opts: { ruleId: string; from: number; to: number }): number {
  const statePath = alertFilePath();
  let state: AlertState;
  let rule: AlertRule;
  let series: Reading[];
  try {
    state = loadAlertState(statePath);
    const found = state.rules.find((r) => r.id === opts.ruleId);
    if (!found) {
      err(`unknown rule '${opts.ruleId}'`);
      return 1;
    }
    rule = found;
    series = deviceSeries(rule.device);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  const threshold = rule.thresholdMilli;
  const lines: string[] = [];
  for (let dayStart = opts.from; dayStart < opts.to; dayStart += DAY_SECONDS) {
    const date = formatIsoUtc(dayStart).slice(0, 10);
    const stats = computeDay(series, dayStart, dayStart + DAY_SECONDS);
    if (stats.unknown > 0 || stats.anomaly > 0) {
      // 有未知或下降覆盖:不可判定,不触发也不恢复。
      lines.push(`  ${date}  ${undecidableReason(stats)}  no alert action`);
      continue;
    }
    const exceeded = stats.consumption > threshold;
    const cmp =
      `consumption=${formatKwh(stats.consumption)} kWh ` +
      `${exceeded ? '>' : '<='} threshold=${formatKwh(rule.thresholdMilli)} kWh`;
    const open = state.alerts.find(
      (a) => a.ruleId === rule.id && a.date === date && a.status === 'triggered',
    );
    if (exceeded) {
      if (open) {
        // 重复超限:保留原标识,不新增事件。
        lines.push(`  ${date}  ${cmp}  EXCEEDED  alert ${open.id} remains triggered`);
      } else {
        const id = `alert-${state.nextAlertNum++}`;
        state.alerts.push({
          id,
          ruleId: rule.id,
          date,
          status: 'triggered',
          acknowledged: false,
          events: [
            { seq: state.nextEventSeq++, type: 'triggered', consumptionMilli: stats.consumption.toString() },
          ],
        });
        lines.push(`  ${date}  ${cmp}  EXCEEDED  alert ${id} triggered (unacknowledged)`);
      }
    } else {
      if (open) {
        open.status = 'recovered';
        open.events.push({
          seq: state.nextEventSeq++,
          type: 'recovered',
          consumptionMilli: stats.consumption.toString(),
        });
        lines.push(`  ${date}  ${cmp}  NORMAL  alert ${open.id} recovered`);
      } else {
        lines.push(`  ${date}  ${cmp}  NORMAL  no alert`);
      }
    }
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
    `rule: ${rule.id}  device=${rule.device}  threshold=${formatKwh(rule.thresholdMilli)} kWh`,
  );
  for (const line of lines) console.log(line);
  return 0;
}

/**
 * 查询规则的告警历史。只读,不修改数据。
 * 给定日期范围时逐日展示消耗或不可判定原因及各次告警;省略范围时展示
 * 有告警记录的全部日期。返回进程退出码。
 */
export function cmdAlerts(opts: { ruleId: string; from?: number; to?: number }): number {
  let state: AlertState;
  let rule: AlertRule;
  let series: Reading[];
  try {
    state = loadAlertState(alertFilePath());
    const found = state.rules.find((r) => r.id === opts.ruleId);
    if (!found) {
      err(`unknown rule '${opts.ruleId}'`);
      return 1;
    }
    rule = found;
    series = deviceSeries(rule.device);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  let dayStarts: number[];
  if (opts.from !== undefined && opts.to !== undefined) {
    dayStarts = [];
    for (let d = opts.from; d < opts.to; d += DAY_SECONDS) dayStarts.push(d);
  } else {
    const dates = [
      ...new Set(state.alerts.filter((a) => a.ruleId === rule.id).map((a) => a.date)),
    ].sort();
    dayStarts = dates.map((d) => parseIso8601(`${d}T00:00:00Z`) as number);
  }

  console.log(
    `rule: ${rule.id}  device=${rule.device}  threshold=${formatKwh(rule.thresholdMilli)} kWh`,
  );
  if (dayStarts.length === 0) {
    console.log(`  no alerts recorded for rule '${rule.id}'`);
    return 0;
  }

  const threshold = rule.thresholdMilli;
  for (const dayStart of dayStarts) {
    const date = formatIsoUtc(dayStart).slice(0, 10);
    const stats = computeDay(series, dayStart, dayStart + DAY_SECONDS);
    if (stats.unknown > 0 || stats.anomaly > 0) {
      console.log(`  ${date}  ${undecidableReason(stats)}`);
    } else {
      const verdict = stats.consumption > threshold ? 'EXCEEDED' : 'NORMAL';
      console.log(
        `  ${date}  consumption=${formatKwh(stats.consumption)} kWh ` +
          `(${verdict}, threshold=${formatKwh(rule.thresholdMilli)} kWh)`,
      );
    }
    const alerts = state.alerts
      .filter((a) => a.ruleId === rule.id && a.date === date)
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
  console.log(
    `alert ${alert.id} acknowledged (rule=${alert.ruleId} date=${alert.date} status=${alert.status})`,
  );
  return 0;
}

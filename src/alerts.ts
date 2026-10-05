// 告警子命令:规则创建与查看、按 UTC 日期范围评估、告警历史查询与确认。
//
// 语义要点:
// - 每日消耗与覆盖沿用 daily 口径(完整时序、均匀分摊、累计比例向下取整);
//   仅全天有效覆盖(无未知、无下降)的日期可判定,消耗严格大于阈值才超限,
//   等于阈值视为正常;零增长是有效数据。
// - 有未知或下降覆盖的日期不可判定:不触发也不恢复告警。
// - 每个(规则, 日期)独立跟踪:首次超限创建带唯一标识的未确认告警;重复超限
//   保留原告警标识且不新增事件;后续完整评估正常才记录恢复;恢复后再超限
//   创建新的未确认告警,旧记录(含确认)保留,确认不转移给新告警。
// - 评估结果与告警事件带全局顺序号,查询时按顺序展示触发/恢复/确认。
// - 评估批量提交:全部日期计算完成后一次性原子写入 alerts.json,任一步
//   失败(含存储损坏、重复读数身份)都不落盘,保留操作前全部状态。
// - 比较与显示保持千分之一 kWh 精确度;消耗用 BigInt 计算并以字符串保存,
//   超过 Number 安全整数范围也不舍入。

import { dataFilePath, loadStore, StoreError, type Reading } from './store.ts';
import { computeDay, DAY_SECONDS } from './report.ts';
import { formatIsoUtc, formatUtcDate } from './time.ts';
import { formatKwh, formatKwhBig } from './value.ts';
import {
  alertsFilePath,
  loadAlerts,
  loadRules,
  rulesFilePath,
  saveAlerts,
  saveRules,
  type AlertState,
  type Evaluation,
  type EvalStatus,
  type Rule,
} from './alertstore.ts';

function err(message: string): void {
  console.error(`meterwatch: ${message}`);
}

/** 加载规则;失败打印错误并返回 null。 */
function tryLoadRules(): Rule[] | null {
  try {
    return loadRules(rulesFilePath());
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return null;
    }
    throw e;
  }
}

/** 加载告警状态;失败打印错误并返回 null。 */
function tryLoadAlerts(): AlertState | null {
  try {
    return loadAlerts(alertsFilePath());
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return null;
    }
    throw e;
  }
}

/** 加载读数;失败打印错误并返回 null。 */
function tryLoadReadings(): Reading[] | null {
  try {
    return loadStore(dataFilePath());
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return null;
    }
    throw e;
  }
}

/** 列出全部告警规则。只读。 */
export function cmdRules(): number {
  const rules = tryLoadRules();
  if (rules === null) return 1;
  if (rules.length === 0) {
    console.log('no rules defined');
    return 0;
  }
  const sorted = [...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of sorted) {
    console.log(`rule: ${r.id}  device=${r.device}  threshold=${formatKwh(r.thresholdMilli)} kWh`);
  }
  return 0;
}

/**
 * 创建告警规则。同标识且设备、阈值等价的重试成功且不重复创建;
 * 同标识异参报冲突。设备必须已存在于读数库。失败时不写入任何状态。
 */
export function cmdRuleCreate(id: string, device: string, thresholdMilli: number): number {
  const path = rulesFilePath();
  const rules = tryLoadRules();
  if (rules === null) return 1;

  const existing = rules.find((r) => r.id === id);
  if (existing) {
    if (existing.device === device && existing.thresholdMilli === thresholdMilli) {
      console.log(`rule '${id}' already exists with identical device and threshold (unchanged)`);
      return 0;
    }
    err(
      `rule '${id}' already exists with different parameters ` +
        `(device=${existing.device}, threshold=${formatKwh(existing.thresholdMilli)} kWh); conflict`,
    );
    return 1;
  }

  const readings = tryLoadReadings();
  if (readings === null) return 1;
  if (!readings.some((r) => r.device === device)) {
    err(`unknown device '${device}': no readings stored for this device`);
    return 1;
  }

  try {
    saveRules(path, [...rules, { id, device, thresholdMilli }]);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  console.log(`rule '${id}' created: device=${device}  threshold=${formatKwh(thresholdMilli)} kWh`);
  return 0;
}

export interface EvaluateOptions {
  ruleId: string;
  /** 起始 UTC 日期零点的 epoch 秒(含)。 */
  fromTs: number;
  /** 结束 UTC 日期零点的 epoch 秒(不含),必须晚于起点。 */
  toTs: number;
}

/**
 * 评估规则在连续完整 UTC 日期范围内的每日超限情况。
 * 全部日期在内存中计算完成后一次性原子写入;任何失败都不落盘。
 */
export function cmdEvaluate(opts: EvaluateOptions): number {
  const rules = tryLoadRules();
  if (rules === null) return 1;
  const rule = rules.find((r) => r.id === opts.ruleId);
  if (!rule) {
    err(`unknown rule '${opts.ruleId}'`);
    return 1;
  }

  const all = tryLoadReadings();
  if (all === null) return 1;
  const series = all
    .filter((r) => r.device === rule.device)
    .sort((a, b) => a.ts - b.ts);
  for (let i = 1; i < series.length; i++) {
    if (series[i].ts === series[i - 1].ts) {
      err(
        `storage error: multiple stored readings for device '${rule.device}' at ${formatIsoUtc(series[i].ts)}`,
      );
      return 1;
    }
  }

  const state = tryLoadAlerts();
  if (state === null) return 1;

  const threshold = BigInt(rule.thresholdMilli);
  const lines: string[] = [];
  let judged = 0;
  let undeterminable = 0;
  let triggered = 0;
  let recovered = 0;
  for (let dayStart = opts.fromTs; dayStart < opts.toTs; dayStart += DAY_SECONDS) {
    const date = formatUtcDate(dayStart);
    const stats = computeDay(series, dayStart, dayStart + DAY_SECONDS);
    const seq = state.nextEventSeq++;

    let status: EvalStatus;
    let consumptionText: string;
    if (stats.anomaly > 0 || stats.unknown > 0) {
      status = 'undeterminable';
      undeterminable++;
      consumptionText = `consumption=n/a (undeterminable: unknown=${stats.unknown}s anomaly=${stats.anomaly}s)`;
    } else {
      judged++;
      status = stats.consumption > threshold ? 'exceeded' : 'normal';
      consumptionText = `consumption=${formatKwhBig(stats.consumption)} kWh`;
    }

    const record: Evaluation = {
      ruleId: rule.id,
      date,
      status,
      consumptionMilli: status === 'undeterminable' ? null : stats.consumption.toString(),
      unknownSeconds: stats.unknown,
      anomalySeconds: stats.anomaly,
      seq,
    };
    const ei = state.evaluations.findIndex((e) => e.ruleId === rule.id && e.date === date);
    if (ei >= 0) state.evaluations[ei] = record;
    else state.evaluations.push(record);

    // 告警状态机:仅可判定的日期参与;不可判定不触发也不恢复。
    let action = '';
    const open = state.alerts.find(
      (a) => a.ruleId === rule.id && a.date === date && a.recoveredSeq === null,
    );
    if (status === 'exceeded' && !open) {
      const id = `alert-${state.nextAlertSeq++}`;
      state.alerts.push({
        id,
        ruleId: rule.id,
        date,
        triggeredSeq: seq,
        recoveredSeq: null,
        ackedSeq: null,
      });
      triggered++;
      action = `  TRIGGERED ${id}`;
    } else if (status === 'normal' && open) {
      open.recoveredSeq = seq;
      recovered++;
      action = `  RECOVERED ${open.id}`;
    }
    lines.push(`  ${date}  ${consumptionText}  status=${status.toUpperCase()}${action}`);
  }

  try {
    saveAlerts(alertsFilePath(), state);
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
  console.log(
    `range: ${formatUtcDate(opts.fromTs)}..${formatUtcDate(opts.toTs)} (start inclusive, end exclusive)`,
  );
  for (const line of lines) console.log(line);
  console.log(
    `  summary: evaluated=${lines.length} day(s)  judged=${judged}  undeterminable=${undeterminable}` +
      `  triggered=${triggered}  recovered=${recovered}`,
  );
  return 0;
}

export interface AlertsQuery {
  ruleId: string;
  /** 可选日期过滤,UTC 日期零点的 epoch 秒;from 含、to 不含。 */
  fromTs?: number;
  toTs?: number;
}

/** 查询规则的评估与告警历史。只读,不修改数据。 */
export function cmdAlerts(query: AlertsQuery): number {
  const rules = tryLoadRules();
  if (rules === null) return 1;
  const rule = rules.find((r) => r.id === query.ruleId);
  if (!rule) {
    err(`unknown rule '${query.ruleId}'`);
    return 1;
  }
  const state = tryLoadAlerts();
  if (state === null) return 1;

  const fromDate = query.fromTs !== undefined ? formatUtcDate(query.fromTs) : undefined;
  const toDate = query.toTs !== undefined ? formatUtcDate(query.toTs) : undefined;
  // YYYY-MM-DD 按字典序比较即按时间比较。
  const inRange = (date: string): boolean =>
    (fromDate === undefined || date >= fromDate) && (toDate === undefined || date < toDate);

  const dates = new Set<string>();
  for (const e of state.evaluations) {
    if (e.ruleId === rule.id && inRange(e.date)) dates.add(e.date);
  }
  for (const a of state.alerts) {
    if (a.ruleId === rule.id && inRange(a.date)) dates.add(a.date);
  }
  const sorted = [...dates].sort();

  console.log(
    `rule: ${rule.id}  device=${rule.device}  threshold=${formatKwh(rule.thresholdMilli)} kWh`,
  );
  if (sorted.length === 0) {
    console.log('  no evaluations or alerts recorded');
    return 0;
  }
  for (const date of sorted) {
    const ev = state.evaluations.find((e) => e.ruleId === rule.id && e.date === date);
    let line = `  ${date}`;
    if (ev) {
      if (ev.status === 'undeterminable' || ev.consumptionMilli === null) {
        line +=
          `  consumption=n/a (undeterminable: unknown=${ev.unknownSeconds}s` +
          ` anomaly=${ev.anomalySeconds}s)  status=UNDETERMINABLE`;
      } else {
        line += `  consumption=${formatKwhBig(BigInt(ev.consumptionMilli))} kWh  status=${ev.status.toUpperCase()}`;
      }
    }
    console.log(line);
    const alerts = state.alerts
      .filter((a) => a.ruleId === rule.id && a.date === date)
      .sort((a, b) => a.triggeredSeq - b.triggeredSeq);
    for (const a of alerts) {
      const detection = a.recoveredSeq === null ? 'triggered' : 'recovered';
      const ack = a.ackedSeq === null ? 'unacknowledged' : 'acknowledged';
      const events = [`#${a.triggeredSeq} triggered`];
      if (a.recoveredSeq !== null) events.push(`#${a.recoveredSeq} recovered`);
      if (a.ackedSeq !== null) events.push(`#${a.ackedSeq} acknowledged`);
      console.log(
        `    alert ${a.id}  detection=${detection}  ack=${ack}  events: ${events.join(', ')}`,
      );
    }
  }
  return 0;
}

/**
 * 确认告警。已恢复的告警也可确认;重复确认成功且不重复记事;
 * 确认不改变超限或恢复状态。未知告警标识明确报错。
 */
export function cmdAck(alertId: string): number {
  const path = alertsFilePath();
  const state = tryLoadAlerts();
  if (state === null) return 1;
  const alert = state.alerts.find((a) => a.id === alertId);
  if (!alert) {
    err(`unknown alert '${alertId}'`);
    return 1;
  }
  if (alert.ackedSeq !== null) {
    console.log(`alert '${alertId}' already acknowledged (unchanged)`);
    return 0;
  }
  alert.ackedSeq = state.nextEventSeq++;
  try {
    saveAlerts(path, state);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  console.log(`alert '${alertId}' acknowledged (rule=${alert.ruleId} date=${alert.date})`);
  return 0;
}

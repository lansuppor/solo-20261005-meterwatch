// 告警规则与告警历史的持久化。
// 与 readings.json 同目录(默认 ~/.meterwatch,可用 METERWATCH_DATA_DIR 覆盖):
//   rules.json   告警规则(标识、绑定设备、阈值;创建后设备与阈值固定)
//   alerts.json  每日评估结果与告警记录(触发/恢复/确认,含全局处理顺序号)
// 与读数分文件存放:import 只写 readings.json,不会丢失告警状态;
// 既有 readings.json 文件无需任何迁移即可继续使用。
// 写入采用临时文件 + rename 的原子方式;读取失败或内容损坏抛 StoreError,
// 绝不当作空库。文件不存在视为空(尚无规则/告警)。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir, StoreError } from './store.ts';

export interface Rule {
  /** 规则标识(已去除首尾空白,非空唯一)。 */
  id: string;
  /** 绑定设备(与读数设备同一身份规则:去首尾空白、区分大小写)。 */
  device: string;
  /** 每日能耗阈值,毫千瓦时(千分之一 kWh)整数,非负。 */
  thresholdMilli: number;
}

export type EvalStatus = 'exceeded' | 'normal' | 'undeterminable';

export interface Evaluation {
  ruleId: string;
  /** UTC 日期,YYYY-MM-DD。 */
  date: string;
  status: EvalStatus;
  /** 判定消耗,毫千瓦时;undeterminable 时为 null。
      以十进制字符串保存,超过 Number 安全整数范围也不舍入。 */
  consumptionMilli: string | null;
  /** 不可判定原因:该天的未知覆盖与异常(下降)覆盖秒数。 */
  unknownSeconds: number;
  anomalySeconds: number;
  /** 本次评估的全局处理顺序号。 */
  seq: number;
}

export interface Alert {
  /** 告警标识,全局唯一,形如 alert-1。 */
  id: string;
  ruleId: string;
  /** UTC 日期,YYYY-MM-DD。 */
  date: string;
  /** 触发/恢复/确认的处理顺序号;未发生为 null。 */
  triggeredSeq: number;
  recoveredSeq: number | null;
  ackedSeq: number | null;
}

export interface AlertState {
  /** 下一个告警标识序号。 */
  nextAlertSeq: number;
  /** 下一个全局处理顺序号(评估、触发、恢复、确认共享)。 */
  nextEventSeq: number;
  evaluations: Evaluation[];
  alerts: Alert[];
}

export function rulesFilePath(): string {
  return join(dataDir(), 'rules.json');
}

export function alertsFilePath(): string {
  return join(dataDir(), 'alerts.json');
}

/** 读取 JSON 文件;不存在返回 null,不可读或损坏抛 StoreError。 */
function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StoreError(`cannot read storage file ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new StoreError(`storage file ${path} is corrupted (invalid JSON)`);
  }
}

/** 原子写入 JSON;失败抛 StoreError,原有数据保持不变。 */
function writeJson(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    throw new StoreError(`cannot write storage file ${path}: ${(err as Error).message}`);
  }
}

export function loadRules(path: string): Rule[] {
  const data = readJson(path);
  if (data === null) return [];
  const rules = (data as { rules?: unknown })?.rules;
  if (!Array.isArray(rules)) {
    throw new StoreError(`storage file ${path} is corrupted (missing rules array)`);
  }
  for (const r of rules as Array<Record<string, unknown>>) {
    const ok =
      r !== null &&
      typeof r === 'object' &&
      typeof r.id === 'string' &&
      r.id.length > 0 &&
      typeof r.device === 'string' &&
      r.device.length > 0 &&
      Number.isSafeInteger(r.thresholdMilli) &&
      (r.thresholdMilli as number) >= 0;
    if (!ok) {
      throw new StoreError(`storage file ${path} is corrupted (invalid rule entry)`);
    }
  }
  return rules as Rule[];
}

export function saveRules(path: string, rules: Rule[]): void {
  writeJson(path, { version: 1, rules });
}

const EVAL_STATUSES = new Set(['exceeded', 'normal', 'undeterminable']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS_RE = /^\d+$/;

export function loadAlerts(path: string): AlertState {
  const data = readJson(path);
  if (data === null) {
    return { nextAlertSeq: 1, nextEventSeq: 1, evaluations: [], alerts: [] };
  }
  const o = data as Record<string, unknown>;
  const topOk =
    o !== null &&
    typeof o === 'object' &&
    Number.isSafeInteger(o.nextAlertSeq) &&
    (o.nextAlertSeq as number) >= 1 &&
    Number.isSafeInteger(o.nextEventSeq) &&
    (o.nextEventSeq as number) >= 1 &&
    Array.isArray(o.evaluations) &&
    Array.isArray(o.alerts);
  if (!topOk) {
    throw new StoreError(`storage file ${path} is corrupted (invalid alerts state)`);
  }
  for (const e of o.evaluations as Array<Record<string, unknown>>) {
    const ok =
      e !== null &&
      typeof e === 'object' &&
      typeof e.ruleId === 'string' &&
      typeof e.date === 'string' &&
      DATE_RE.test(e.date) &&
      typeof e.status === 'string' &&
      EVAL_STATUSES.has(e.status) &&
      (e.consumptionMilli === null ||
        (typeof e.consumptionMilli === 'string' && DIGITS_RE.test(e.consumptionMilli))) &&
      (e.status === 'undeterminable') === (e.consumptionMilli === null) &&
      Number.isSafeInteger(e.unknownSeconds) &&
      (e.unknownSeconds as number) >= 0 &&
      Number.isSafeInteger(e.anomalySeconds) &&
      (e.anomalySeconds as number) >= 0 &&
      Number.isSafeInteger(e.seq);
    if (!ok) {
      throw new StoreError(`storage file ${path} is corrupted (invalid evaluation entry)`);
    }
  }
  for (const a of o.alerts as Array<Record<string, unknown>>) {
    const seqOrNull = (v: unknown): boolean => v === null || Number.isSafeInteger(v);
    const ok =
      a !== null &&
      typeof a === 'object' &&
      typeof a.id === 'string' &&
      a.id.length > 0 &&
      typeof a.ruleId === 'string' &&
      typeof a.date === 'string' &&
      DATE_RE.test(a.date) &&
      Number.isSafeInteger(a.triggeredSeq) &&
      seqOrNull(a.recoveredSeq) &&
      seqOrNull(a.ackedSeq);
    if (!ok) {
      throw new StoreError(`storage file ${path} is corrupted (invalid alert entry)`);
    }
  }
  return o as unknown as AlertState;
}

export function saveAlerts(path: string, state: AlertState): void {
  writeJson(path, { version: 1, ...state });
}

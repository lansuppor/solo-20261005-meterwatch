// meterwatch — 建筑能耗监测与告警：本地累计电表读数导入与消耗核查。
// 无外部运行依赖，需要 Node.js 24（直接运行 TypeScript）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const NAME = 'meterwatch';
const CSV_HEADER = 'device,timestamp,reading_kwh';

const HELP = `${NAME}

建筑能耗监测与告警：本地累计电表读数导入与消耗核查。

用法:
  node app.ts                       显示本帮助
  node app.ts --help | -h           显示本帮助
  node app.ts import <file.csv>     导入 CSV 读数（整批成功或整批拒绝）
  node app.ts readings [筛选...]    查询读数、区间与消耗

CSV 格式（表头固定，区分大小写）:
  ${CSV_HEADER}
  device        设备标识；去除首尾空白后不能为空，区分大小写
  timestamp     ISO8601，秒精度，必须带 Z 或 ±HH:MM 数字时区偏移，须为真实日期
  reading_kwh   非负累计读数（kWh），最多三位小数
  支持标准双引号字段、"" 转义双引号以及 CRLF/LF 换行。
  读数身份 = 设备标识 + 实际时刻；不同偏移表示同一时刻视为同一身份。
  相同身份相同数值为重复（跳过并计数），相同身份不同数值为冲突（整批拒绝）。

筛选参数（readings）:
  --device <id>   仅显示指定设备（精确匹配，区分大小写）
  --from <iso>    起始时刻（含），须为带时区的秒精度 ISO8601
  --to <iso>      结束时刻（不含），须为带时区的秒精度 ISO8601
  省略边界表示不限；--from 必须早于 --to。
  区间消耗与同设备紧邻前驱计算，前驱取自完整已存时序（可在范围外）。

数据位置:
  默认 <用户主目录>/.meterwatch/readings.json
  可用环境变量 METERWATCH_DATA_DIR 或参数 --data-dir <dir> 指定数据目录，
  命令行参数优先于环境变量。退出后再次启动仍可查询已导入数据。`;

interface Reading {
  device: string;
  epochMs: number;
  milliKwh: number; // 读数值 × 1000 的整数，避免浮点尾差
}

interface BatchRow extends Reading {
  line: number;
}

class StoreError extends Error {}

class CsvError extends Error {
  line: number;
  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

// ---------- 时间解析：秒精度、必须带 Z 或 ±HH:MM 偏移、须为真实日期 ----------

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;

function parseTimestamp(s: string): number | null {
  const m = TS_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const se = Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  // 用 setUTCFullYear 构造并回读校验，拒绝 2 月 30 日等无效日期（不自动顺延）
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  let offsetMs = 0;
  const off = m[7];
  if (off !== 'Z') {
    const oh = Number(off.slice(1, 3));
    const om = Number(off.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMs = (off[0] === '+' ? 1 : -1) * (oh * 60 + om) * 60_000;
  }
  return dt.getTime() + (h * 3600 + mi * 60 + se) * 1000 - offsetMs;
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('.000Z', 'Z');
}

// ---------- 读数解析：非负、最多三位小数，返回整数 milli-kWh ----------

const VALUE_RE = /^(\d+)(?:\.(\d{1,3}))?$/;

function parseReadingValue(s: string): number | null {
  const m = VALUE_RE.exec(s);
  if (!m) return null;
  const intPart = m[1].replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').padEnd(3, '0');
  const v = Number(intPart) * 1000 + Number(frac);
  return Number.isSafeInteger(v) ? v : null;
}

// 整数 milli-kWh → 十进制字符串，去掉多余的尾零，无浮点尾差
function formatKwh(milliKwh: number): string {
  const sign = milliKwh < 0 ? '-' : '';
  const abs = Math.abs(milliKwh);
  const int = Math.floor(abs / 1000);
  const frac = String(abs % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return sign + int + (frac ? '.' + frac : '');
}

// ---------- CSV 解析：双引号字段、"" 转义、CRLF/LF/CR 换行、引号内换行 ----------

interface CsvRow {
  fields: string[];
  line: number; // 记录起始行号（1 起）
}

function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;
  let hasContent = false;
  let line = 1;
  let recLine = 1;

  const pushRow = () => {
    fields.push(field);
    rows.push({ fields, line: recLine });
    fields = [];
    field = '';
    hasContent = false;
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        afterQuote = true;
        i++;
        continue;
      }
      if (c === '\n') line++;
      field += c;
      i++;
      continue;
    }
    if (afterQuote) {
      if (c === ',') {
        fields.push(field);
        field = '';
        afterQuote = false;
        hasContent = true;
        i++;
        continue;
      }
      if (c === '\r' || c === '\n') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        line++;
        pushRow();
        recLine = line;
        afterQuote = false;
        i++;
        continue;
      }
      throw new CsvError(line, `引号闭合后出现意外字符 ${JSON.stringify(c)}`);
    }
    if (c === '"') {
      inQuotes = true;
      hasContent = true;
      i++;
      continue;
    }
    if (c === ',') {
      fields.push(field);
      field = '';
      hasContent = true;
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      line++;
      if (hasContent || field !== '' || fields.length > 0) pushRow();
      recLine = line;
      i++;
      continue;
    }
    field += c;
    hasContent = true;
    i++;
  }
  if (inQuotes) throw new CsvError(line, '双引号未闭合');
  if (afterQuote || hasContent || field !== '' || fields.length > 0) pushRow();
  return rows;
}

// ---------- 本地存储 ----------

function dataDir(opt: string | undefined): string {
  return opt ?? process.env.METERWATCH_DATA_DIR ?? join(homedir(), '.meterwatch');
}

function storePath(dir: string): string {
  return join(dir, 'readings.json');
}

function loadStore(path: string): Reading[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new StoreError(`无法读取存储文件 ${path}: ${errMsg(e)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StoreError(`存储文件已损坏（不是有效 JSON）: ${path}`);
  }
  const fail = (): never => {
    throw new StoreError(`存储文件已损坏（结构不符合预期）: ${path}`);
  };
  if (typeof data !== 'object' || data === null) fail();
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1 || !Array.isArray(obj.readings)) fail();
  const seen = new Set<string>();
  const out: Reading[] = [];
  for (const item of obj.readings) {
    if (typeof item !== 'object' || item === null) fail();
    const r = item as Record<string, unknown>;
    if (
      typeof r.device !== 'string' ||
      r.device === '' ||
      !Number.isSafeInteger(r.epochMs) ||
      !Number.isSafeInteger(r.milliKwh) ||
      (r.milliKwh as number) < 0
    ) {
      fail();
    }
    const key = idKey(r.device as string, r.epochMs as number);
    if (seen.has(key)) fail();
    seen.add(key);
    out.push({ device: r.device as string, epochMs: r.epochMs as number, milliKwh: r.milliKwh as number });
  }
  return out;
}

function saveStore(path: string, readings: Reading[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const sorted = [...readings].sort(
    (a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0) || a.epochMs - b.epochMs,
  );
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ version: 1, readings: sorted }, null, 2) + '\n', 'utf8');
  renameSync(tmp, path); // 原子替换，写失败时保留此前数据
}

// ---------- 通用 ----------

function idKey(device: string, epochMs: number): string {
  return `${device}\n${epochMs}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fail(code: number, message: string): number {
  console.error(`${NAME}: ${message}`);
  return code;
}

interface ParsedArgs {
  opts: Map<string, string>;
  positional: string[];
}

function parseOptions(args: string[], known: string[]): ParsedArgs | string {
  const knownSet = new Set(known);
  const opts = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (!knownSet.has(name)) return `未知参数: --${name}`;
      let value: string;
      if (eq >= 0) {
        value = a.slice(eq + 1);
      } else {
        if (i + 1 >= args.length) return `参数 --${name} 缺少值`;
        value = args[++i];
      }
      opts.set(name, value);
    } else {
      positional.push(a);
    }
  }
  return { opts, positional };
}

// ---------- import ----------

function cmdImport(args: string[]): number {
  const parsed = parseOptions(args, ['data-dir']);
  if (typeof parsed === 'string') return fail(2, parsed);
  if (parsed.positional.length !== 1) {
    return fail(2, '用法: node app.ts import <file.csv> [--data-dir <dir>]');
  }
  const file = parsed.positional[0];

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return fail(1, `无法读取文件 ${file}: ${errMsg(e)}`);
  }

  let rows: CsvRow[];
  try {
    rows = parseCsv(text);
  } catch (e) {
    if (e instanceof CsvError) return fail(1, `CSV 第 ${e.line} 行: ${e.message}`);
    throw e;
  }
  if (rows.length === 0) return fail(1, `CSV 文件为空，缺少表头: ${CSV_HEADER}`);
  if (rows[0].fields.join(',') !== CSV_HEADER) {
    return fail(1, `第 1 行: 表头必须为 ${CSV_HEADER}`);
  }

  // 逐行校验，收集全部格式错误；任何错误都拒绝整批
  const errors: string[] = [];
  const batch: BatchRow[] = [];
  for (const row of rows.slice(1)) {
    if (row.fields.length !== 3) {
      errors.push(`第 ${row.line} 行: 需要 3 个字段，实际 ${row.fields.length} 个`);
      continue;
    }
    const device = row.fields[0].trim();
    if (device === '') {
      errors.push(`第 ${row.line} 行: 设备标识去除首尾空白后为空`);
      continue;
    }
    const epochMs = parseTimestamp(row.fields[1].trim());
    if (epochMs === null) {
      errors.push(`第 ${row.line} 行: 时间无效（须为真实日期、秒精度、带 Z 或 ±HH:MM 偏移）: ${row.fields[1]}`);
      continue;
    }
    const milliKwh = parseReadingValue(row.fields[2].trim());
    if (milliKwh === null) {
      errors.push(`第 ${row.line} 行: 读数无效（须为非负数、最多三位小数）: ${row.fields[2]}`);
      continue;
    }
    batch.push({ device, epochMs, milliKwh, line: row.line });
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`${NAME}: ${e}`);
    console.error(`${NAME}: 导入被拒绝，未写入任何数据`);
    return 1;
  }

  const path = storePath(dataDir(parsed.opts.get('data-dir')));
  let store: Reading[];
  try {
    store = loadStore(path);
  } catch (e) {
    if (e instanceof StoreError) return fail(1, e.message);
    throw e;
  }

  // 与已存数据及本文件内数据比对身份（设备 + 实际时刻）
  const byId = new Map<string, number>();
  for (const r of store) byId.set(idKey(r.device, r.epochMs), r.milliKwh);

  const added: Reading[] = [];
  let duplicates = 0;
  const conflicts: string[] = [];
  for (const r of batch) {
    const key = idKey(r.device, r.epochMs);
    const existing = byId.get(key);
    if (existing === undefined) {
      byId.set(key, r.milliKwh);
      added.push({ device: r.device, epochMs: r.epochMs, milliKwh: r.milliKwh });
    } else if (existing === r.milliKwh) {
      duplicates++;
    } else {
      conflicts.push(
        `第 ${r.line} 行: 设备 ${r.device} 在 ${formatTime(r.epochMs)} 已存在读数 ` +
          `${formatKwh(existing)} kWh，与导入值 ${formatKwh(r.milliKwh)} kWh 冲突`,
      );
    }
  }
  if (conflicts.length > 0) {
    for (const c of conflicts) console.error(`${NAME}: ${c}`);
    console.error(`${NAME}: 导入被拒绝，未写入任何数据`);
    return 1;
  }

  try {
    saveStore(path, store.concat(added));
  } catch (e) {
    return fail(1, `存储写入失败，已保留此前数据: ${errMsg(e)}`);
  }
  console.log(`导入完成: 新增 ${added.length} 条，重复 ${duplicates} 条（已跳过）。`);
  return 0;
}

// ---------- readings ----------

function cmdReadings(args: string[]): number {
  const parsed = parseOptions(args, ['device', 'from', 'to', 'data-dir']);
  if (typeof parsed === 'string') return fail(2, parsed);
  if (parsed.positional.length !== 0) {
    return fail(2, `readings 不接受位置参数: ${parsed.positional.join(' ')}`);
  }

  let from: number | null = null;
  let to: number | null = null;
  const fromStr = parsed.opts.get('from');
  const toStr = parsed.opts.get('to');
  if (fromStr !== undefined) {
    from = parseTimestamp(fromStr.trim());
    if (from === null) return fail(2, `--from 时间无效（须为真实日期、秒精度、带时区）: ${fromStr}`);
  }
  if (toStr !== undefined) {
    to = parseTimestamp(toStr.trim());
    if (to === null) return fail(2, `--to 时间无效（须为真实日期、秒精度、带时区）: ${toStr}`);
  }
  if (from !== null && to !== null && from >= to) {
    return fail(2, '--from 必须早于 --to（起点含、终点不含）');
  }

  const path = storePath(dataDir(parsed.opts.get('data-dir')));
  let store: Reading[];
  try {
    store = loadStore(path);
  } catch (e) {
    if (e instanceof StoreError) return fail(1, e.message);
    throw e;
  }

  const deviceFilter = parsed.opts.get('device');
  const byDevice = new Map<string, Reading[]>();
  for (const r of store) {
    if (deviceFilter !== undefined && r.device !== deviceFilter) continue;
    let list = byDevice.get(r.device);
    if (!list) byDevice.set(r.device, (list = []));
    list.push(r);
  }

  const devices = [...byDevice.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let anyOutput = false;
  for (const device of devices) {
    // 前驱取自完整已存时序，即使前驱在查询范围外
    const series = byDevice.get(device)!.sort((a, b) => a.epochMs - b.epochMs);
    const lines: string[] = [];
    let sumMilli = 0;
    let intervals = 0;
    for (let i = 0; i < series.length; i++) {
      const r = series[i];
      if (from !== null && r.epochMs < from) continue;
      if (to !== null && r.epochMs >= to) continue;
      let line = `  ${formatTime(r.epochMs)}  累计 ${formatKwh(r.milliKwh)} kWh`;
      const prev = i > 0 ? series[i - 1] : null;
      if (prev === null) {
        line += '  | 无同设备前驱读数，区间消耗无法计算';
      } else {
        const diff = r.milliKwh - prev.milliKwh;
        const interval = `区间 ${formatTime(prev.epochMs)} ~ ${formatTime(r.epochMs)}`;
        if (diff < 0) {
          line += `  | ${interval}  读数下降 ${formatKwh(-diff)} kWh（下降异常，不计入汇总）`;
        } else {
          line += `  | ${interval}  消耗 ${formatKwh(diff)} kWh`;
          sumMilli += diff;
          intervals++;
        }
      }
      lines.push(line);
    }
    if (lines.length === 0) continue;
    anyOutput = true;
    console.log(`设备 ${device}:`);
    for (const l of lines) console.log(l);
    console.log(`  汇总: 有效消耗 ${formatKwh(sumMilli)} kWh（${intervals} 个区间）`);
  }
  if (!anyOutput) console.log('无匹配数据。');
  return 0;
}

// ---------- 入口 ----------

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) {
    console.log(HELP);
    return 0;
  }
  if (cmd === '--help' || cmd === '-h') {
    if (rest.length > 0) return fail(2, `不支持的参数: ${rest.join(' ')}`);
    console.log(HELP);
    return 0;
  }
  if (cmd === 'import') return cmdImport(rest);
  if (cmd === 'readings') return cmdReadings(rest);
  return fail(2, `不支持的参数: ${argv.join(' ')}\n使用 --help 查看用法`);
}

process.exitCode = main(process.argv.slice(2));

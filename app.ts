import { cmdImport, cmdReadings, CSV_HEADER } from './src/commands.ts';
import { cmdDaily } from './src/report.ts';
import { cmdAck, cmdAlerts, cmdEvaluate, cmdRuleCreate, cmdRules } from './src/alerts.ts';
import { parseIso8601, parseUtcDate } from './src/time.ts';
import { parseKwh } from './src/value.ts';

const name = 'meterwatch';

const help = `${name}

建筑能耗监测:本地累计电表读数导入、消耗核查与每日能耗阈值告警。

Usage:
  node app.ts                       显示本帮助
  node app.ts --help | -h           显示本帮助
  node app.ts import <file.csv>     导入 CSV 读数(整批成功或整批拒绝)
  node app.ts readings [筛选...]    查询读数、区间与消耗
  node app.ts daily --from <iso> --to <iso> [--device <id>...]
                                    按 UTC 自然日核查能耗的只读日报
  node app.ts rules                 列出全部告警规则
  node app.ts rule create <id> --device <设备> --threshold <kwh>
                                    创建告警规则
  node app.ts evaluate --rule <id> --from <日期> --to <日期>
                                    评估规则在连续 UTC 日期范围内的每日超限
  node app.ts alerts --rule <id> [--from <日期>] [--to <日期>]
                                    查询规则的评估与告警历史(只读)
  node app.ts ack <告警标识>        确认告警

筛选(readings):
  --device <id>     只显示指定设备(可重复使用,区分大小写)
  --from <iso8601>  起始时刻(含),如 2026-01-01T00:00:00Z
  --to <iso8601>    结束时刻(不含)
  省略边界表示不限;时间必须为秒精度 ISO8601 且带 Z 或数字时区偏移
  (如 +08:00);起点不早于终点时拒绝查询。

日报(daily):
  --from <iso8601>  起始时刻(含),必填
  --to <iso8601>    结束时刻(不含),必填,必须晚于起点
  --device <id>     只统计指定设备(可重复使用);省略时统计库内全部设备
  日期按 UTC 零点划分,首尾日期只统计与查询范围重叠的部分。
  估算口径:由每个设备完整时序的相邻读数构成区间,区间两端读数即使在
  查询范围外也参与;非下降区间把累计值之差按持续时间均匀分摊,以千分之一
  kWh 为单位,从区间起点累计到切点(查询边界与日界线)向下取整,片段消耗
  为两端累计量之差,故完整区间的分摊总量等于原差值,同一区间拆开查询再
  相加结果一致。下降区间不分摊,记为异常覆盖;首条读数之前、末条之后及
  孤立读数时段为未知,不外推。每天输出估算消耗与有效/异常/未知覆盖秒数
  (三者之和等于该天查询时长);存在未知或异常覆盖时日报标记为不完整。
  日报只读,不写入数据。

告警规则(rule/rules):
  规则标识非空唯一(去首尾空白);绑定一个已有设备(去首尾空白、区分
  大小写)与非负、最多三位小数的 kWh 阈值。创建后设备与阈值固定。
  相同标识且参数等价的重试成功且不重复创建;同标识异参报冲突。

评估(evaluate):
  --rule <id>       规则标识,必填
  --from <日期>     起始 UTC 日期(含),YYYY-MM-DD,必填
  --to <日期>       结束 UTC 日期(不含),YYYY-MM-DD,必填,必须晚于起日
  每日消耗与覆盖沿用 daily 口径;仅全天有效覆盖(无未知、无下降)的
  日期可判定,消耗严格大于阈值才超限,等于阈值视为正常,零增长是有效
  数据。有未知或下降覆盖的日期不可判定,不触发也不恢复告警。每个
  (规则,日期)独立跟踪:首次超限创建带唯一标识的未确认告警;重复超限
  保留原告警标识且不新增事件;后续完整评估正常才记录恢复;恢复后再
  超限创建新的未确认告警,旧记录(含确认)保留。导入不自动评估,补导
  后需显式重评才反映新的相邻区间。批量日期评估要么全部提交,要么
  全部不提交。

告警历史(alerts):
  --rule <id>       规则标识,必填
  --from/--to <日期>  可选,按 UTC 日期过滤(from 含、to 不含)
  按日期展示消耗或不可判定原因,以及各次告警的标识、检测状态
  (triggered/recovered)、确认状态与触发、恢复、确认的处理顺序。
  只读,不写入数据。

确认(ack):
  按告警标识确认;已恢复的告警也可确认;重复确认成功且不重复记事;
  确认不改变超限或恢复状态。

CSV 格式:
  表头: ${CSV_HEADER}
  device   设备标识(区分大小写,首尾空白忽略,去空白后不能为空)
  time     秒精度 ISO8601,带 Z 或数字时区偏移;必须是真实日期
  reading  累计电表读数(kWh,非负,最多三位小数)
  支持标准双引号字段与 "" 转义;同一设备同一时刻(按实际时刻判定)
  重复且数值相同记为重复跳过,数值不同视为冲突并拒绝整批。

数据位置($METERWATCH_DATA_DIR,默认 ~/.meterwatch):
  readings.json   读数
  rules.json      告警规则
  alerts.json     评估结果与告警历史

退出码: 0 成功;1 数据或读写错误;2 参数错误`;

function usageError(message: string): number {
  console.error(`${name}: ${message}`);
  console.error(`用法见 'node app.ts --help'`);
  return 2;
}

interface ParsedOptions {
  devices: string[];
  from?: number;
  to?: number;
}

/** 解析 --device/--from/--to 选项;出错返回错误消息字符串。 */
function parseOptions(rest: string[]): ParsedOptions | string {
  const devices: string[] = [];
  let from: number | undefined;
  let to: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    let opt = rest[i];
    let value: string | undefined;
    const eq = opt.indexOf('=');
    if (opt.startsWith('--') && eq !== -1) {
      value = opt.slice(eq + 1);
      opt = opt.slice(0, eq);
    } else if (opt.startsWith('--')) {
      value = rest[i + 1];
      if (value === undefined) return `选项 '${opt}' 缺少值`;
      i++;
    } else {
      return `无法识别的参数 '${opt}'`;
    }
    if (opt === '--device') {
      if (value.trim() === '') return "'--device' 的值不能为空";
      devices.push(value);
    } else if (opt === '--from' || opt === '--to') {
      const ts = parseIso8601(value.trim());
      if (ts === null) {
        return `选项 '${opt}' 的时间无效: '${value}'(需秒精度 ISO8601,带 Z 或数字时区偏移)`;
      }
      if (opt === '--from') from = ts;
      else to = ts;
    } else {
      return `无法识别的选项 '${opt}'`;
    }
  }
  return { devices, from, to };
}

interface ParsedArgs {
  /** 选项名到全部取值(按出现顺序)。 */
  options: Record<string, string[]>;
  positional: string[];
}

/** 通用参数拆分:--opt value 或 --opt=value,其余为位置参数。 */
function parseArgs(rest: string[]): ParsedArgs | string {
  const options: Record<string, string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      let opt = arg;
      let value: string | undefined;
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        value = arg.slice(eq + 1);
        opt = arg.slice(0, eq);
      } else {
        value = rest[i + 1];
        if (value === undefined) return `选项 '${opt}' 缺少值`;
        i++;
      }
      (options[opt] ??= []).push(value);
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

/** 校验选项名都在允许集合内且各恰好出现一次;返回选项值或错误消息。 */
function singleOptions(
  parsed: ParsedArgs,
  allowed: string[],
  required: string[],
): Record<string, string> | string {
  for (const key of Object.keys(parsed.options)) {
    if (!allowed.includes(key)) return `无法识别的选项 '${key}'`;
  }
  const values: Record<string, string> = {};
  for (const key of allowed) {
    const list = parsed.options[key] ?? [];
    if (list.length > 1) return `选项 '${key}' 只能出现一次`;
    if (list.length === 1) values[key] = list[0];
    else if (required.includes(key)) return `缺少必需选项 '${key}'`;
  }
  return values;
}

/** 解析 YYYY-MM-DD 日期选项;失败返回错误消息字符串。 */
function dateOption(value: string, label: string): number | string {
  const ts = parseUtcDate(value.trim());
  if (ts === null) return `${label}无效: '${value.trim()}'(需 YYYY-MM-DD 真实日期)`;
  return ts;
}

function main(args: string[]): number {
  if (args.length === 0) {
    console.log(help);
    return 0;
  }
  const [cmd, ...rest] = args;
  if (rest.length === 0 && (cmd === '--help' || cmd === '-h')) {
    console.log(help);
    return 0;
  }

  if (cmd === 'import') {
    if (rest.length !== 1) return usageError("'import' 需要且仅需要一个 CSV 文件路径");
    return cmdImport(rest[0]);
  }

  if (cmd === 'readings') {
    const parsed = parseOptions(rest);
    if (typeof parsed === 'string') return usageError(parsed);
    if (parsed.from !== undefined && parsed.to !== undefined && parsed.from >= parsed.to) {
      return usageError('查询起点必须早于终点(--from < --to)');
    }
    return cmdReadings(parsed);
  }

  if (cmd === 'daily') {
    const parsed = parseOptions(rest);
    if (typeof parsed === 'string') return usageError(parsed);
    if (parsed.from === undefined || parsed.to === undefined) {
      return usageError("'daily' 必须同时提供 --from 与 --to(起点含、终点不含)");
    }
    if (parsed.from >= parsed.to) {
      return usageError('查询起点必须早于终点(--from < --to)');
    }
    return cmdDaily({ devices: parsed.devices, from: parsed.from, to: parsed.to });
  }

  if (cmd === 'rules') {
    if (rest.length !== 0) return usageError("'rules' 不接受参数");
    return cmdRules();
  }

  if (cmd === 'rule') {
    const [sub, ...subRest] = rest;
    if (sub !== 'create') {
      return usageError(sub === undefined ? "'rule' 需要子命令 'create'" : `无法识别的子命令 '${sub}'`);
    }
    const parsed = parseArgs(subRest);
    if (typeof parsed === 'string') return usageError(parsed);
    if (parsed.positional.length !== 1) {
      return usageError("'rule create' 需要且仅需要一个规则标识位置参数");
    }
    const opts = singleOptions(parsed, ['--device', '--threshold'], ['--device', '--threshold']);
    if (typeof opts === 'string') return usageError(opts);
    const id = parsed.positional[0].trim();
    if (id === '') return usageError('规则标识不能为空');
    const device = opts['--device'].trim();
    if (device === '') return usageError("'--device' 的值不能为空");
    const thresholdMilli = parseKwh(opts['--threshold'].trim());
    if (thresholdMilli === null) {
      return usageError(`阈值值无效: '${opts['--threshold'].trim()}'(需非负、最多三位小数的 kWh)`);
    }
    return cmdRuleCreate(id, device, thresholdMilli);
  }

  if (cmd === 'evaluate') {
    const parsed = parseArgs(rest);
    if (typeof parsed === 'string') return usageError(parsed);
    if (parsed.positional.length !== 0) {
      return usageError(`无法识别的参数 '${parsed.positional[0]}'`);
    }
    const opts = singleOptions(parsed, ['--rule', '--from', '--to'], ['--rule', '--from', '--to']);
    if (typeof opts === 'string') return usageError(opts);
    const ruleId = opts['--rule'].trim();
    if (ruleId === '') return usageError("'--rule' 的值不能为空");
    const fromTs = dateOption(opts['--from'], '起始日期');
    if (typeof fromTs === 'string') return usageError(fromTs);
    const toTs = dateOption(opts['--to'], '结束日期');
    if (typeof toTs === 'string') return usageError(toTs);
    if (fromTs >= toTs) {
      return usageError('评估起日必须早于止日(--from 含、--to 不含)');
    }
    return cmdEvaluate({ ruleId, fromTs, toTs });
  }

  if (cmd === 'alerts') {
    const parsed = parseArgs(rest);
    if (typeof parsed === 'string') return usageError(parsed);
    if (parsed.positional.length !== 0) {
      return usageError(`无法识别的参数 '${parsed.positional[0]}'`);
    }
    const opts = singleOptions(parsed, ['--rule', '--from', '--to'], ['--rule']);
    if (typeof opts === 'string') return usageError(opts);
    const ruleId = opts['--rule'].trim();
    if (ruleId === '') return usageError("'--rule' 的值不能为空");
    let fromTs: number | undefined;
    let toTs: number | undefined;
    if (opts['--from'] !== undefined) {
      const ts = dateOption(opts['--from'], '起始日期');
      if (typeof ts === 'string') return usageError(ts);
      fromTs = ts;
    }
    if (opts['--to'] !== undefined) {
      const ts = dateOption(opts['--to'], '结束日期');
      if (typeof ts === 'string') return usageError(ts);
      toTs = ts;
    }
    if (fromTs !== undefined && toTs !== undefined && fromTs >= toTs) {
      return usageError('查询起日必须早于止日(--from 含、--to 不含)');
    }
    return cmdAlerts({ ruleId, fromTs, toTs });
  }

  if (cmd === 'ack') {
    if (rest.length !== 1) return usageError("'ack' 需要且仅需要一个告警标识");
    const alertId = rest[0].trim();
    if (alertId === '') return usageError('告警标识不能为空');
    return cmdAck(alertId);
  }

  return usageError(`无法识别的参数 '${cmd}'`);
}

process.exitCode = main(process.argv.slice(2));

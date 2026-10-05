import { cmdImport, cmdReadings, CSV_HEADER } from './src/commands.ts';
import { cmdDaily } from './src/report.ts';
import { cmdAck, cmdAlerts, cmdEvaluate, cmdRuleCreate, cmdRuleList } from './src/alerts.ts';
import { parseIso8601, parseUtcDate } from './src/time.ts';
import { parseKwh } from './src/value.ts';

const name = 'meterwatch';

const help = `${name}

建筑能耗监测:本地累计电表读数导入与消耗核查。

Usage:
  node app.ts                       显示本帮助
  node app.ts --help | -h           显示本帮助
  node app.ts import <file.csv>     导入 CSV 读数(整批成功或整批拒绝)
  node app.ts readings [筛选...]    查询读数、区间与消耗
  node app.ts daily --from <iso> --to <iso> [--device <id>...]
                                    按 UTC 自然日核查能耗的只读日报
  node app.ts rule create --id <id> --device <设备> --threshold <kWh>
                                    创建每日能耗阈值告警规则
  node app.ts rule list             查看全部告警规则
  node app.ts evaluate --rule <id> --from <日期> --to <日期>
                                    评估规则在连续完整 UTC 日期上的超限情况
  node app.ts alerts --rule <id> [--from <日期> --to <日期>]
                                    查询规则的告警历史(只读)
  node app.ts ack <告警标识>         确认告警

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

告警规则(rule / evaluate / alerts / ack):
  规则标识非空唯一,绑定的设备必须已有存储读数(去首尾空白、区分大小写);
  阈值非负、最多三位小数 kWh;创建后设备与阈值固定。相同标识等价参数重试
  成功且不重复创建,异参重试报冲突。
  evaluate 的 --from/--to 为 YYYY-MM-DD 的 UTC 日期,起日含、止日不含,
  起日必须更早。评估口径与 daily 相同:仅全天有效覆盖的日期可判定,消耗
  严格大于阈值才超限(等于为正常);有未知或下降覆盖的日期不可判定,不触发
  也不恢复。每个规则每个日期独立跟踪:首次超限创建带唯一标识的未确认告警,
  重复超限保留原标识;完整评估正常才记录恢复;恢复后再超限创建新的未确认
  告警,旧记录保留,原确认不转移。批量日期评估要么全部提交要么不提交。
  ack 按告警标识确认,已恢复告警也可确认;重复确认成功且不重复记事,确认
  不改变超限或恢复状态。alerts 按规则和日期展示消耗或不可判定原因、各次
  告警的标识、检测状态、确认状态及触发/恢复/确认的处理顺序;省略日期范围
  时展示有告警记录的全部日期。导入不自动评估,补导后需显式重评。

CSV 格式:
  表头: ${CSV_HEADER}
  device   设备标识(区分大小写,首尾空白忽略,去空白后不能为空)
  time     秒精度 ISO8601,带 Z 或数字时区偏移;必须是真实日期
  reading  累计电表读数(kWh,非负,最多三位小数)
  支持标准双引号字段与 "" 转义;同一设备同一时刻(按实际时刻判定)
  重复且数值相同记为重复跳过,数值不同视为冲突并拒绝整批。

数据位置:
  $METERWATCH_DATA_DIR/readings.json(默认 ~/.meterwatch/readings.json)
  $METERWATCH_DATA_DIR/alerts.json(告警规则与历史,与读数文件相互独立)

数值精度与兼容:
  读数与阈值为非负、最多三位小数的 kWh,量级不限(不因超过 Number 安全
  整数范围而拒绝);解析、求差、分摊、汇总、比较、保存与显示全程精确,
  输出固定三位小数。旧版文件中以数值型安全整数保存的读数、阈值与历史
  无需转换即可继续使用,并能与新导入的大数值共同计算;大数值在文件中
  以十进制字符串保存,数值型超出安全整数范围的数据按损坏拒绝。

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

/** 解析 --opt value / --opt=value 形式的选项;出错返回错误消息字符串。 */
function parseFlags(rest: string[], allowed: string[]): Map<string, string[]> | string {
  const out = new Map<string, string[]>();
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
    if (!allowed.includes(opt)) return `无法识别的选项 '${opt}'`;
    const list = out.get(opt);
    if (list) list.push(value);
    else out.set(opt, [value]);
  }
  return out;
}

/** 取恰好出现一次的单值选项;缺失或重复返回 null。 */
function oneFlag(flags: Map<string, string[]>, name: string): string | null {
  const list = flags.get(name);
  if (!list || list.length !== 1) return null;
  return list[0];
}

/** 解析 YYYY-MM-DD 日期选项;无效时返回错误消息字符串。 */
function dateFlag(value: string, label: string): number | string {
  const ts = parseUtcDate(value.trim());
  if (ts === null) return `${label}无效: '${value.trim()}'(需 YYYY-MM-DD 的真实 UTC 日期)`;
  return ts;
}

function cmdRule(rest: string[]): number {
  const [sub, ...subrest] = rest;
  if (sub === 'list') {
    if (subrest.length !== 0) return usageError("'rule list' 不接受参数");
    return cmdRuleList();
  }
  if (sub === 'create') {
    const flags = parseFlags(subrest, ['--id', '--device', '--threshold']);
    if (typeof flags === 'string') return usageError(flags);
    const idRaw = oneFlag(flags, '--id');
    const deviceRaw = oneFlag(flags, '--device');
    const thresholdRaw = oneFlag(flags, '--threshold');
    if (idRaw === null || deviceRaw === null || thresholdRaw === null) {
      return usageError("'rule create' 需要 --id、--device、--threshold 各恰好一个");
    }
    const id = idRaw.trim();
    if (id === '') return usageError('规则标识不能为空');
    const device = deviceRaw.trim();
    if (device === '') return usageError("'--device' 的值不能为空");
    const thresholdMilli = parseKwh(thresholdRaw.trim());
    if (thresholdMilli === null) {
      return usageError(`阈值无效: '${thresholdRaw.trim()}'(需非负、最多三位小数的 kWh)`);
    }
    return cmdRuleCreate({ id, device, thresholdMilli });
  }
  if (sub === undefined) return usageError("'rule' 需要子命令 create 或 list");
  return usageError(`无法识别的 rule 子命令 '${sub}'`);
}

function cmdEvaluateEntry(rest: string[]): number {
  const flags = parseFlags(rest, ['--rule', '--from', '--to']);
  if (typeof flags === 'string') return usageError(flags);
  const ruleRaw = oneFlag(flags, '--rule');
  const fromRaw = oneFlag(flags, '--from');
  const toRaw = oneFlag(flags, '--to');
  if (ruleRaw === null || fromRaw === null || toRaw === null) {
    return usageError("'evaluate' 需要 --rule、--from、--to 各恰好一个(日期为 YYYY-MM-DD,起日含、止日不含)");
  }
  const ruleId = ruleRaw.trim();
  if (ruleId === '') return usageError('规则标识不能为空');
  const from = dateFlag(fromRaw, '起始日期');
  if (typeof from === 'string') return usageError(from);
  const to = dateFlag(toRaw, '结束日期');
  if (typeof to === 'string') return usageError(to);
  if (from >= to) return usageError('评估起日必须早于止日(--from < --to)');
  return cmdEvaluate({ ruleId, from, to });
}

function cmdAlertsEntry(rest: string[]): number {
  const flags = parseFlags(rest, ['--rule', '--from', '--to']);
  if (typeof flags === 'string') return usageError(flags);
  const ruleRaw = oneFlag(flags, '--rule');
  if (ruleRaw === null) return usageError("'alerts' 需要 --rule 恰好一个");
  const ruleId = ruleRaw.trim();
  if (ruleId === '') return usageError('规则标识不能为空');
  const fromList = flags.get('--from');
  const toList = flags.get('--to');
  if ((fromList !== undefined) !== (toList !== undefined)) {
    return usageError("'alerts' 的 --from 与 --to 需同时提供或同时省略");
  }
  let from: number | undefined;
  let to: number | undefined;
  if (fromList !== undefined) {
    const fromRaw = oneFlag(flags, '--from');
    const toRaw = oneFlag(flags, '--to');
    if (fromRaw === null || toRaw === null) {
      return usageError("'alerts' 的 --from 与 --to 各只能出现一次");
    }
    const fromParsed = dateFlag(fromRaw, '起始日期');
    if (typeof fromParsed === 'string') return usageError(fromParsed);
    const toParsed = dateFlag(toRaw, '结束日期');
    if (typeof toParsed === 'string') return usageError(toParsed);
    if (fromParsed >= toParsed) return usageError('查询起日必须早于止日(--from < --to)');
    from = fromParsed;
    to = toParsed;
  }
  return cmdAlerts({ ruleId, from, to });
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

  if (cmd === 'rule') return cmdRule(rest);
  if (cmd === 'evaluate') return cmdEvaluateEntry(rest);
  if (cmd === 'alerts') return cmdAlertsEntry(rest);

  if (cmd === 'ack') {
    if (rest.length !== 1) return usageError("'ack' 需要且仅需要一个告警标识");
    const alertId = rest[0].trim();
    if (alertId === '') return usageError('告警标识不能为空');
    return cmdAck(alertId);
  }

  return usageError(`无法识别的参数 '${cmd}'`);
}

process.exitCode = main(process.argv.slice(2));

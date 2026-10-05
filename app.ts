import { cmdImport, cmdReadings, CSV_HEADER } from './src/commands.ts';
import { cmdDaily } from './src/report.ts';
import { parseIso8601 } from './src/time.ts';

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

CSV 格式:
  表头: ${CSV_HEADER}
  device   设备标识(区分大小写,首尾空白忽略,去空白后不能为空)
  time     秒精度 ISO8601,带 Z 或数字时区偏移;必须是真实日期
  reading  累计电表读数(kWh,非负,最多三位小数)
  支持标准双引号字段与 "" 转义;同一设备同一时刻(按实际时刻判定)
  重复且数值相同记为重复跳过,数值不同视为冲突并拒绝整批。

数据位置:
  $METERWATCH_DATA_DIR/readings.json(默认 ~/.meterwatch/readings.json)

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

  return usageError(`无法识别的参数 '${cmd}'`);
}

process.exitCode = main(process.argv.slice(2));

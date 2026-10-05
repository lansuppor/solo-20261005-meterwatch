import { cmdImport, cmdReadings, cmdReport, CSV_HEADER } from './src/commands.ts';
import { parseIso8601 } from './src/time.ts';

const name = 'meterwatch';

const help = `${name}

建筑能耗监测:本地累计电表读数导入与消耗核查。

Usage:
  node app.ts                       显示本帮助
  node app.ts --help | -h           显示本帮助
  node app.ts import <file.csv>     导入 CSV 读数(整批成功或整批拒绝)
  node app.ts readings [筛选...]    查询读数、区间与消耗
  node app.ts report --from <iso8601> --to <iso8601> [--device <id>...]
                                    按 UTC 自然日输出能耗日报(只读)

筛选(readings):
  --device <id>     只显示指定设备(可重复使用,区分大小写)
  --from <iso8601>  起始时刻(含),如 2026-01-01T00:00:00Z
  --to <iso8601>    结束时刻(不含)
  省略边界表示不限;时间必须为秒精度 ISO8601 且带 Z 或数字时区偏移
  (如 +08:00);起点不早于终点时拒绝查询。

日报(report):
  --from 与 --to 均为必填,起点含、终点不含,起点必须早于终点;
  --device 可重复使用以选择多个设备,省略时使用库内全部设备。
  日期按 UTC 零点划分,首尾日期只统计与查询范围重叠的部分。
  估算口径:区间由设备完整时序的相邻读数构成,与范围相交的区间
  其两端读数即使在范围外也参与;非下降区间按持续时间均匀分摊
  累计值之差并标为估算——以千分之一 kWh 为单位,从区间起点累计到
  任一切点(查询边界或日界线)的比例量向下取整,片段消耗为终点与
  起点累计量之差,故完整区间分摊总量等于原差值,拆开查询再相加
  结果一致。下降区间不分摊,记为异常覆盖;首条读数之前、末条之后
  及只有孤立读数的时段为未知,不外推。每天输出估算消耗(固定三位
  小数)、有效覆盖秒数、异常覆盖秒数与未知秒数,三者之和等于该天
  实际查询时长;有未知或异常覆盖时日报标为不完整,无有效覆盖时
  消耗显示无法计算。

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

interface FilterArgs {
  devices: string[];
  from?: number;
  to?: number;
}

/** 解析 --device/--from/--to 选项;出错时打印原因并返回退出码 2。 */
function parseFilterArgs(rest: string[]): FilterArgs | number {
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
      if (value === undefined) return usageError(`选项 '${opt}' 缺少值`);
      i++;
    } else {
      return usageError(`无法识别的参数 '${opt}'`);
    }
    if (opt === '--device') {
      if (value.trim() === '') return usageError("'--device' 的值不能为空");
      devices.push(value);
    } else if (opt === '--from' || opt === '--to') {
      const ts = parseIso8601(value.trim());
      if (ts === null) {
        return usageError(`选项 '${opt}' 的时间无效: '${value}'(需秒精度 ISO8601,带 Z 或数字时区偏移)`);
      }
      if (opt === '--from') from = ts;
      else to = ts;
    } else {
      return usageError(`无法识别的选项 '${opt}'`);
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
    const filter = parseFilterArgs(rest);
    if (typeof filter === 'number') return filter;
    if (filter.from !== undefined && filter.to !== undefined && filter.from >= filter.to) {
      return usageError('查询起点必须早于终点(--from < --to)');
    }
    return cmdReadings(filter);
  }

  if (cmd === 'report') {
    const filter = parseFilterArgs(rest);
    if (typeof filter === 'number') return filter;
    if (filter.from === undefined || filter.to === undefined) {
      return usageError("'report' 需要 --from 与 --to 两个边界");
    }
    if (filter.from >= filter.to) {
      return usageError('查询起点必须早于终点(--from < --to)');
    }
    return cmdReport({ devices: filter.devices, from: filter.from, to: filter.to });
  }

  return usageError(`无法识别的参数 '${cmd}'`);
}

process.exitCode = main(process.argv.slice(2));

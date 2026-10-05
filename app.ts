import { cmdImport, cmdReadings, CSV_HEADER } from './src/commands.ts';
import { cmdDaily } from './src/report.ts';
import { cmdAck, cmdAlerts, cmdEvaluate, cmdRuleCreate, cmdRuleList } from './src/alerts.ts';
import { cmdGroupConfigure, cmdGroupDaily, cmdGroupHistory } from './src/groups.ts';
import { cmdCorrect, cmdCorrections, cmdUndo } from './src/correct.ts';
import { parseIso8601, parseUtcDate } from './src/time.ts';
import { loadTimezone } from './src/tz.ts';
import { parseKwh } from './src/value.ts';
import type { CorrectionItem } from './src/store.ts';

const name = 'meterwatch';

const help = `${name}

建筑能耗监测:本地累计电表读数导入与消耗核查。

Usage:
  node app.ts                       显示本帮助
  node app.ts --help | -h           显示本帮助
  node app.ts import <file.csv>     导入 CSV 读数(整批成功或整批拒绝)
  node app.ts readings [筛选...]    查询读数、区间与消耗
  node app.ts daily --from <iso> --to <iso> [--device <id>...] [--tz <时区>]
                                    按当地自然日核查能耗的只读日报(默认 UTC 分日)
  node app.ts rule create --id <id> (--device <设备> | --group <分组>) --threshold <kWh>
                                    创建每日能耗阈值告警规则(设备或分组)
  node app.ts rule list             查看全部告警规则
  node app.ts evaluate --rule <id> --from <日期> --to <日期>
                                    评估规则在连续完整 UTC 日期上的超限情况
  node app.ts alerts --rule <id> [--from <日期> --to <日期>]
                                    查询规则的告警历史(只读)
  node app.ts ack <告警标识>         确认告警
  node app.ts group configure --id <id> --at <iso> --device <id>...
                                    配置分组成员版本(首次配置即建立分组)
  node app.ts group history --id <id>
                                    查看分组成员版本历史(只读)
  node app.ts group daily --id <id> --from <iso> --to <iso> [--tz <时区>]
                                    按当时生效成员的分组能耗日报(只读,默认 UTC 分日)
  node app.ts correct --request <id> --item --device <设备> --at <iso> --expect <kWh> --set <kWh>
                                    [--item --device ... --at ... --expect ... --set ...]...
                                    批量修正已存读数的累计值(整批成功或整批拒绝)
  node app.ts undo --request <id> --target <修正请求标识>
                                    整批撤销一次已成功修正(恢复实际改变过的读数)
  node app.ts corrections             查看修正与撤销历史(只读)

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
  --tz <时区>       分日时区(IANA 名,如 Asia/Shanghai);省略时按 UTC
  日期按分日时区的当地零点划分,首尾日期只统计与查询范围重叠的部分。
  估算口径:由每个设备完整时序的相邻读数构成区间,区间两端读数即使在
  查询范围外也参与;非下降区间把累计值之差按持续时间均匀分摊,以千分之一
  kWh 为单位,从区间起点累计到切点(查询边界与日界线)向下取整,片段消耗
  为两端累计量之差,故完整区间的分摊总量等于原差值,同一区间拆开查询再
  相加结果一致。下降区间不分摊,记为异常覆盖;首条读数之前、末条之后及
  孤立读数时段为未知,不外推。每天输出估算消耗与有效/异常/未知覆盖秒数
  (三者之和等于该天实际统计的各 UTC 时段总秒数),并标明所用时区与各
  UTC 时段;存在未知或异常覆盖时日报标记为不完整。日报只读,不写入数据。

分日时区(--tz,daily 与 group daily 可选):
  接受运行环境支持的 IANA 时区名(如 Asia/Shanghai、America/New_York);
  未知时区名为参数错误,返回 2。时区只决定分日,不重新解释输入时刻或
  已存读数。日界线按实际时刻的当地日期归属计算,不按固定 86400 秒或
  全年固定偏移推算:夏令时前拨跳过的当天更短(跳过的小时不存在,不补
  为未知),回拨当天更长(重复小时按各自实际时刻完整计入);同一当地
  日期的不连续时段合并统计、分别列出;没有实际时段的当地日期不生成
  日报。日界线不重置分摊起点,拆开查询再相加与整段一致。

分组(group configure / history / daily):
  分组以首次 configure 建立,标识非空唯一(去首尾空白、区分大小写)。
  configure 的 --at 为版本生效时刻(含,秒精度 ISO8601 带 Z 或数字时区
  偏移),--device 给出一整套已有设备(至少一个,可重复;同设备重复列出
  只算一次,成员顺序不影响等价性,设备可属于多个分组);版本从生效时刻起
  生效直到下一版本接替,允许乱序补录历史版本。同组同一实际生效时刻、同
  成员集合重试成功且不新增,异成员集合报冲突;未知设备报错,配置整次成功
  或不提交。history 按生效时刻列出全部版本(只读)。daily 的 --from(含)
  与 --to(不含)必填且起点必须更早,按分日时区的自然日切分(--tz 可选,
  默认 UTC,口径见上文"分日时区"),按当时生效成员计算,首个版本生效前
  记为未知;每个时段只有全部生效成员均处于非下降读数
  区间才是有效覆盖并计入成员消耗之和,任一成员下降为异常,否则任一成员
  未知为未知;异常与未知时段不计任何成员消耗,覆盖秒数按分组实际时间计;
  各设备片段仍以原读数区间起点累计比例向下取整,日界线、查询边界与成员
  切换均不重置分摊起点,拆开查询相加一致。每天显示生效成员及其时段、估算
  消耗与有效/异常/未知秒数(三者之和等于当天查询时长);有异常或未知标为
  不完整,无有效覆盖显示无法计算。配置不改读数、规则和告警,导入不改配置。

修正与撤销(correct / undo / corrections):
  correct 一次提交指定非空请求标识(--request,去首尾空白、区分大小写,在
  数据目录内唯一)及至少一个 --item 修正项;每项 --device、--at、--expect、
  --set 各恰好一个,给出设备、实际时刻(秒精度 ISO8601 带 Z 或数字时区
  偏移)、预期原读数和替换读数(均为非负、最多三位小数 kWh,任意大数精确)。
  只修改已有读数的累计值,不新增或删除读数;同批同一读数身份(设备+实际
  时刻)只允许一项;替换值可等于原值,但仍须核验预期原值。首次提交逐项把
  预期原值与操作前已存值精确比较,全部匹配才整体替换,成功报告请求标识与
  实际改变数;任一项身份不存在或原值不符均指出原因、整批拒绝,不改变其他
  项,也不占用请求标识(失败后可修改内容用同一标识重新提交)。读数替换与
  请求成功记录同时持久化,写入失败保留操作前全部状态。同标识、同修正内容
  重放直接返回原成功结果,不重新校验当前读数、不再次替换(即使这些读数
  后来又被其他请求修正,或本修正后来被撤销);修正项顺序、等价时区及等价
  十进制写法不影响内容等价性;同标识异内容报冲突且保持状态。
  undo 一次提交指定非空撤销请求标识(--request)及目标修正请求标识
  (--target),整批撤销一次已成功修正,不允许挑选部分项;目标只能是成功
  修正,不能是撤销请求,未知或已撤销目标报错。撤销与修正请求共用唯一标识
  空间,成功标识绑定操作类型和内容。首次撤销只恢复目标中实际改变过的读数,
  将其还原为该修正记录的原值,不新增或删除读数;每个待恢复身份必须存在、
  当前值精确等于原替换值,且没有后来尚未撤销、实际改变过该读数的修正
  (后来改回相同数值也不能绕过来源检查,相关后续修正先撤销后才能再撤销
  较早请求)。同值项不恢复、不阻塞;全部为同值项的目标仍可成功撤销,恢复
  数为零。任一项不满足条件指出身份和原因、整次拒绝,不占用撤销标识。同
  撤销标识、同目标重放返回原成功结果,不重新核验、不重复恢复;同标识异
  目标或跨操作类型复用标识均报冲突。读数恢复与撤销成功记录同时原子持久化,
  重启后状态与来源判断一致。成功报告撤销请求、目标和恢复数,原修正内容
  保留并标记已撤销。corrections 按成功提交顺序显示各修正请求及各项设备、
  时刻、原值和替换值,另按成功发生顺序显示撤销请求与目标关系,只读。
  修正与撤销后 readings、daily、group daily 与 alerts 的当前消耗按新相邻
  区间重算;分组成员、规则与告警记录不变,检测状态仍需显式 evaluate 更新;
  后续 import 按当前读数判重与冲突,并保留修正与撤销历史。

告警规则(rule / evaluate / alerts / ack):
  规则标识非空且在设备与分组两类规则间唯一(去首尾空白、区分大小写);用
  --device 绑定一个已有存储读数的设备,或用 --group 绑定一个已有分组(二者
  恰好其一);设备与分组即使同名也是不同目标,列表与历史均显示目标类型。
  阈值非负、最多三位小数 kWh;目标与阈值创建后固定,分组规则绑定分组标识、
  不冻结创建时成员。相同标识、同目标类型、同目标标识及等价阈值重试成功且
  不重复创建,任一不同即报冲突。
  evaluate 的 --from/--to 为 YYYY-MM-DD 的 UTC 日期,起日含、止日不含,
  起日必须更早。设备规则评估口径与 daily 相同;分组规则与 group daily 的
  联合覆盖口径相同:每天按当时生效的成员版本计算,允许日内切换,首个版本
  生效前为未知,任一成员下降为异常,否则任一成员未知为未知;成员切换不
  重置各设备原读数区间的分摊起点。仅全天有效覆盖的日期可判定,消耗严格
  大于阈值才超限(等于为正常),零增长有效;有未知或下降覆盖的日期不可
  判定,不触发也不恢复。每个规则每个日期独立跟踪:首次超限创建带全局
  唯一标识的未确认告警,重复超限保留原标识;完整评估正常才记录恢复;恢复
  后再超限创建新的未确认告警,旧记录保留,原确认不转移。批量日期评估要么
  全部提交要么不提交。
  ack 按告警标识确认,已恢复告警也可确认;重复确认成功且不重复记事,确认
  不改变超限或恢复状态。alerts 按规则和日期展示当前计算的消耗或不可判定
  原因、各次告警的标识、检测状态、确认状态及按发生顺序排列的触发/恢复/
  确认事件(触发、恢复时的消耗为当时记录,不随后续数据改写);省略日期
  范围时展示有告警记录的全部日期;查询只读,不会隐式恢复。导入读数或补录
  成员版本都不自动评估,需显式重评才更新检测状态。

CSV 格式:
  表头: ${CSV_HEADER}
  device   设备标识(区分大小写,首尾空白忽略,去空白后不能为空)
  time     秒精度 ISO8601,带 Z 或数字时区偏移;必须是真实日期
  reading  累计电表读数(kWh,非负,最多三位小数;可超出 Number 安全整数
           范围,任意大的十进制值都精确保存,如 9007199254740.991)
  支持标准双引号字段与 "" 转义;同一设备同一时刻(按实际时刻判定)
  重复且数值相同记为重复跳过,数值不同视为冲突并拒绝整批。

数值精度:
  读数与阈值以毫千瓦时 BigInt 运算,解析、求差、分摊、汇总、比较、保存
  和显示全程精确,输出固定三位小数,不使用科学计数法。
  兼容旧版 readings.json / alerts.json 中以 JSON 数值保存的安全整数
  读数与阈值,无需手工转换;新版以十进制字符串保存。数值型毫千瓦时若
  已超出安全整数范围(精度已丢失)按损坏数据拒绝,不猜测原值。

数据位置:
  $METERWATCH_DATA_DIR/readings.json(默认 ~/.meterwatch/readings.json;
           读数与修正、撤销历史同文件保存,旧版无修正与撤销历史的文件可直接使用)
  $METERWATCH_DATA_DIR/alerts.json(告警规则与历史,与读数文件相互独立)
  $METERWATCH_DATA_DIR/groups.json(分组配置,与读数、告警文件相互独立)

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
  tz?: string;
}

/** 解析 --device/--from/--to(及允许时的 --tz)选项;出错返回错误消息字符串。 */
function parseOptions(rest: string[], allowTz = false): ParsedOptions | string {
  const devices: string[] = [];
  let from: number | undefined;
  let to: number | undefined;
  let tz: string | undefined;
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
    } else if (opt === '--tz' && allowTz) {
      tz = value.trim();
      if (tz === '') return "'--tz' 的值不能为空";
    } else {
      return `无法识别的选项 '${opt}'`;
    }
  }
  return { devices, from, to, tz };
}

/** 校验 IANA 分日时区名;无效时返回错误消息字符串。 */
function checkTz(tz: string): string | null {
  if (loadTimezone(tz) === null) {
    return `未知时区 '${tz}'(需运行环境支持的 IANA 时区名,如 Asia/Shanghai、America/New_York)`;
  }
  return null;
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
    const flags = parseFlags(subrest, ['--id', '--device', '--group', '--threshold']);
    if (typeof flags === 'string') return usageError(flags);
    const idRaw = oneFlag(flags, '--id');
    const deviceList = flags.get('--device');
    const groupList = flags.get('--group');
    const thresholdRaw = oneFlag(flags, '--threshold');
    if (idRaw === null || thresholdRaw === null) {
      return usageError("'rule create' 需要 --id 与 --threshold 各恰好一个");
    }
    const hasDevice = deviceList !== undefined;
    const hasGroup = groupList !== undefined;
    if (hasDevice === hasGroup) {
      return usageError("'rule create' 需恰好提供 --device <设备> 或 --group <分组> 之一");
    }
    if ((deviceList !== undefined && deviceList.length !== 1) ||
      (groupList !== undefined && groupList.length !== 1)) {
      return usageError("'rule create' 的目标选项只能出现一次");
    }
    const id = idRaw.trim();
    if (id === '') return usageError('规则标识不能为空');
    const thresholdMilli = parseKwh(thresholdRaw.trim());
    if (thresholdMilli === null) {
      return usageError(`阈值无效: '${thresholdRaw.trim()}'(需非负、最多三位小数的 kWh)`);
    }
    if (hasDevice) {
      const device = (deviceList as string[])[0].trim();
      if (device === '') return usageError("'--device' 的值不能为空");
      return cmdRuleCreate({ id, targetType: 'device', targetId: device, thresholdMilli });
    }
    const group = (groupList as string[])[0].trim();
    if (group === '') return usageError("'--group' 的值不能为空");
    return cmdRuleCreate({ id, targetType: 'group', targetId: group, thresholdMilli });
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

function cmdGroup(rest: string[]): number {
  const [sub, ...subrest] = rest;
  if (sub === 'configure') {
    const flags = parseFlags(subrest, ['--id', '--at', '--device']);
    if (typeof flags === 'string') return usageError(flags);
    const idRaw = oneFlag(flags, '--id');
    const atRaw = oneFlag(flags, '--at');
    const deviceList = flags.get('--device') ?? [];
    if (idRaw === null || atRaw === null) {
      return usageError("'group configure' 需要 --id 与 --at 各恰好一个");
    }
    if (deviceList.length === 0) {
      return usageError("'group configure' 需要至少一个 --device(成员不能为空)");
    }
    const id = idRaw.trim();
    if (id === '') return usageError('分组标识不能为空');
    const at = parseIso8601(atRaw.trim());
    if (at === null) {
      return usageError(
        `选项 '--at' 的时间无效: '${atRaw.trim()}'(需秒精度 ISO8601,带 Z 或数字时区偏移)`,
      );
    }
    const members: string[] = [];
    for (const d of deviceList) {
      const m = d.trim();
      if (m === '') return usageError("'--device' 的值不能为空");
      members.push(m);
    }
    return cmdGroupConfigure({ id, at, members });
  }
  if (sub === 'history') {
    const flags = parseFlags(subrest, ['--id']);
    if (typeof flags === 'string') return usageError(flags);
    const idRaw = oneFlag(flags, '--id');
    if (idRaw === null) return usageError("'group history' 需要 --id 恰好一个");
    const id = idRaw.trim();
    if (id === '') return usageError('分组标识不能为空');
    return cmdGroupHistory({ id });
  }
  if (sub === 'daily') {
    const flags = parseFlags(subrest, ['--id', '--from', '--to', '--tz']);
    if (typeof flags === 'string') return usageError(flags);
    const idRaw = oneFlag(flags, '--id');
    const fromRaw = oneFlag(flags, '--from');
    const toRaw = oneFlag(flags, '--to');
    if (idRaw === null || fromRaw === null || toRaw === null) {
      return usageError("'group daily' 需要 --id、--from、--to 各恰好一个(起点含、终点不含)");
    }
    const tzList = flags.get('--tz');
    if (tzList !== undefined && tzList.length !== 1) {
      return usageError("'group daily' 的 --tz 只能出现一次");
    }
    const id = idRaw.trim();
    if (id === '') return usageError('分组标识不能为空');
    const from = parseIso8601(fromRaw.trim());
    if (from === null) {
      return usageError(`选项 '--from' 的时间无效: '${fromRaw.trim()}'(需秒精度 ISO8601,带 Z 或数字时区偏移)`);
    }
    const to = parseIso8601(toRaw.trim());
    if (to === null) {
      return usageError(`选项 '--to' 的时间无效: '${toRaw.trim()}'(需秒精度 ISO8601,带 Z 或数字时区偏移)`);
    }
    if (from >= to) return usageError('查询起点必须早于终点(--from < --to)');
    let tz: string | undefined;
    if (tzList !== undefined) {
      tz = tzList[0].trim();
      if (tz === '') return usageError("'--tz' 的值不能为空");
      const bad = checkTz(tz);
      if (bad !== null) return usageError(bad);
    }
    return cmdGroupDaily({ id, from, to, tz });
  }
  if (sub === undefined) return usageError("'group' 需要子命令 configure、history 或 daily");
  return usageError(`无法识别的 group 子命令 '${sub}'`);
}

/**
 * 解析 correct 的修正项:以裸 '--item' 分段,每段需 --device/--at/--expect/--set
 * 各恰好一个。出错返回错误消息字符串。
 */
function parseCorrectItems(rest: string[]): { requestId: string; items: CorrectionItem[] } | string {
  const segments: string[][] = [[]];
  for (const tok of rest) {
    if (tok === '--item') segments.push([]);
    else segments[segments.length - 1].push(tok);
  }
  const headFlags = parseFlags(segments[0], ['--request']);
  if (typeof headFlags === 'string') return headFlags;
  const requestRaw = oneFlag(headFlags, '--request');
  if (requestRaw === null) return "'correct' 需要 --request 恰好一个";
  const requestId = requestRaw.trim();
  if (requestId === '') return '请求标识不能为空';
  const itemSegs = segments.slice(1);
  if (itemSegs.length === 0) {
    return "'correct' 需要至少一个 --item(--item --device <设备> --at <iso> --expect <kWh> --set <kWh>)";
  }
  const items: CorrectionItem[] = [];
  for (const seg of itemSegs) {
    const flags = parseFlags(seg, ['--device', '--at', '--expect', '--set']);
    if (typeof flags === 'string') return flags;
    const deviceRaw = oneFlag(flags, '--device');
    const atRaw = oneFlag(flags, '--at');
    const expectRaw = oneFlag(flags, '--expect');
    const setRaw = oneFlag(flags, '--set');
    if (deviceRaw === null || atRaw === null || expectRaw === null || setRaw === null) {
      return '每个 --item 需要 --device、--at、--expect、--set 各恰好一个';
    }
    const device = deviceRaw.trim();
    if (device === '') return "'--device' 的值不能为空";
    const ts = parseIso8601(atRaw.trim());
    if (ts === null) {
      return `选项 '--at' 的时间无效: '${atRaw.trim()}'(需秒精度 ISO8601,带 Z 或数字时区偏移)`;
    }
    const expectedMilli = parseKwh(expectRaw.trim());
    if (expectedMilli === null) {
      return `预期原读数无效: '${expectRaw.trim()}'(需非负、最多三位小数的 kWh)`;
    }
    const replacementMilli = parseKwh(setRaw.trim());
    if (replacementMilli === null) {
      return `替换读数无效: '${setRaw.trim()}'(需非负、最多三位小数的 kWh)`;
    }
    items.push({ device, ts, expectedMilli, replacementMilli });
  }
  return { requestId, items };
}

function cmdCorrectEntry(rest: string[]): number {
  const parsed = parseCorrectItems(rest);
  if (typeof parsed === 'string') return usageError(parsed);
  return cmdCorrect(parsed.requestId, parsed.items);
}

function cmdUndoEntry(rest: string[]): number {
  const flags = parseFlags(rest, ['--request', '--target']);
  if (typeof flags === 'string') return usageError(flags);
  const requestRaw = oneFlag(flags, '--request');
  const targetRaw = oneFlag(flags, '--target');
  if (requestRaw === null || targetRaw === null) {
    return usageError("'undo' 需要 --request 与 --target 各恰好一个");
  }
  const requestId = requestRaw.trim();
  if (requestId === '') return usageError('撤销请求标识不能为空');
  const targetId = targetRaw.trim();
  if (targetId === '') return usageError('目标修正请求标识不能为空');
  return cmdUndo(requestId, targetId);
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
    const parsed = parseOptions(rest, true);
    if (typeof parsed === 'string') return usageError(parsed);
    if (parsed.from === undefined || parsed.to === undefined) {
      return usageError("'daily' 必须同时提供 --from 与 --to(起点含、终点不含)");
    }
    if (parsed.from >= parsed.to) {
      return usageError('查询起点必须早于终点(--from < --to)');
    }
    if (parsed.tz !== undefined) {
      const bad = checkTz(parsed.tz);
      if (bad !== null) return usageError(bad);
    }
    return cmdDaily({ devices: parsed.devices, from: parsed.from, to: parsed.to, tz: parsed.tz });
  }

  if (cmd === 'rule') return cmdRule(rest);
  if (cmd === 'evaluate') return cmdEvaluateEntry(rest);
  if (cmd === 'alerts') return cmdAlertsEntry(rest);
  if (cmd === 'group') return cmdGroup(rest);
  if (cmd === 'correct') return cmdCorrectEntry(rest);
  if (cmd === 'undo') return cmdUndoEntry(rest);

  if (cmd === 'corrections') {
    if (rest.length !== 0) return usageError("'corrections' 不接受参数");
    return cmdCorrections();
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

import { cmdImport, cmdReadings, CSV_HEADER } from './src/commands.ts';
import { cmdDaily } from './src/report.ts';
import { cmdAck, cmdAlerts, cmdEvaluate, cmdRuleCreate, cmdRuleList } from './src/alerts.ts';
import { cmdGroupConfigure, cmdGroupDaily, cmdGroupHistory } from './src/groups.ts';
import { cmdGroupScheduleReport, parseSchedule, type ScheduleWindow } from './src/schedule.ts';
import { cmdCorrect, cmdCorrections, cmdUndo } from './src/correct.ts';
import { cmdBackup, cmdRestore, withDirectoryCoordination } from './src/backup.ts';
import { readFileSync } from 'node:fs';
import { parseIso8601, parseUtcDate } from './src/time.ts';
import { canonicalTimezone, loadTimezone } from './src/tz.ts';
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
  node app.ts daily --from <iso> --to <iso> [--device <id>...] [--tz <时区>] [--max-interval <秒>]
                                    按当地自然日核查能耗的只读日报(默认 UTC 分日)
  node app.ts rule create --id <id> (--device <设备> | --group <分组>) --threshold <kWh> [--tz <时区>] [--max-interval <秒>] [--schedule <时间表文件>]
                                    创建每日能耗阈值告警规则(设备或分组,时区省略为 UTC;
                                    --schedule 仅分组规则:指定为非运行模式,省略为全天模式)
  node app.ts rule list             查看全部告警规则
  node app.ts evaluate --rule <id> --from <日期> --to <日期>
                                    评估规则在连续完整当地日期(按规则时区)上的超限情况
  node app.ts alerts --rule <id> [--from <日期> --to <日期>]
                                    查询规则的告警历史(只读)
  node app.ts ack <告警标识>         确认告警
  node app.ts group configure --id <id> --at <iso> --device <id>...
                                    配置分组成员版本(首次配置即建立分组)
  node app.ts group history --id <id>
                                    查看分组成员版本历史(只读)
  node app.ts group daily --id <id> --from <iso> --to <iso> [--tz <时区>] [--max-interval <秒>]
                                    按当时生效成员的分组能耗日报(只读,默认 UTC 分日)
  node app.ts group schedule-report --id <id> --schedule <时间表文件> --from <iso> --to <iso>
                                    [--tz <时区>] [--max-interval <秒>]
                                    按每周运行时间表分运行/非运行时段的分组能耗报表(只读)
  node app.ts correct --request <id> --item --device <设备> --at <iso> --expect <kWh> --set <kWh>
                                    [--item --device ... --at ... --expect ... --set ...]...
                                    批量修正已存读数的累计值(整批成功或整批拒绝)
  node app.ts undo --request <id> --target <修正请求标识>
                                    整批撤销一次已成功修正(恢复实际改变过的读数)
  node app.ts corrections             查看修正与撤销历史(只读)
  node app.ts backup <快照文件>       导出全库快照(快照文件须位于数据目录之外,已存在则拒绝)
  node app.ts restore <快照文件>      从快照整库恢复(三个业务存储作为一次提交整体替换)

备份与恢复(backup / restore):
  backup 把当前数据目录的三个业务存储(读数与修正/撤销历史、告警规则与历史、
  分组成员版本)连同后续编号状态完整导出为一个快照文件,任意大数精确保留;
  快照带格式版本与 SHA-256 完整性校验。快照文件必须位于数据目录之外,已存在
  的输出文件拒绝覆盖;备份只读取业务数据,不改写。restore 不解析当前库(可用于
  当前存储已损坏的目录),先校验快照的版本、完整性与三个存储的结构和关联
  (全库重复读数身份、修正项引用缺失读数、撤销引用缺失修正、成员或规则目标
  不存在、告警引用缺失规则,任一问题指出原因并拒绝),再把三个业务存储作为
  一次提交整体替换:成功后业务状态完全等于快照,快照为空的部分清除原数据,
  快照之后新增的读数、请求和告警不保留,目录内其他文件保持不变,不自动评估
  或重新生成历史。读写或重命名失败返回 1 并回退到恢复前文件内容与存在状态。

进程在准备、文件替换、失败回滚或启动自恢复中被终止的处理:
  任一命令(含无参数、--help/-h 与非法参数入口)再次启动,都先取得数据目录
  操作权并续接未完成恢复,然后才执行查询或写入。恢复日志用阶段记录进度:
  尚未进入失败回滚的中断可收敛为完整旧库或完整快照;已经进入失败回滚后
  只能继续还原完整旧库,不能改为前滚;自恢复再次中断仍可续接。回滚中已
  还原的旧文件不会被误删,原本缺失的业务文件恢复为缺失(不把事务造成的
  缺文件当成空库)。无法可靠判定或完成一致恢复时返回 1:不输出正常业务
  结果、不做业务写入,也不删除仍可用于恢复的材料(restore.journal 与
  *.restore-old / *.restore-new),修好底层读写问题后再运行任一命令即可续接。

目录操作权(排他锁,按数据目录隔离):
  每个命令从取得目录操作权起先协调再读写。同目录被其他存活进程占用时
  明确拒绝并返回 1,不读写业务存储,也不清理对方的事务材料;属主退出后
  可安全接管其未完成恢复;不同数据目录互不阻塞。备份、恢复与启动自恢复
  期间,其他命令同样受此限制。锁文件为数据目录内的 meterwatch.lock。

故障处理简述:
  - 命令报 "locked by another live meterwatch process":等占用进程结束,
    或确认其已退出后删除残留的 meterwatch.lock 再重试。
  - 报 "cannot complete interrupted restore ... materials were kept":
    保留目录内 restore.journal 与 *.restore-old/*.restore-new,排除磁盘
    只读/权限/空间问题后,再运行任意命令完成续接;切勿手工删改这些文件。
  - 报 restore journal 不可读或无效:目录处于无法自动判定的状态,需用已知
    完好的快照手工恢复,不要直接在可能混合的目录上继续业务操作。

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
  --max-interval <秒>  最大采样间隔限制(正整数秒);省略表示无上限,只影响本次查询
  日期按分日时区的当地零点划分,首尾日期只统计与查询范围重叠的部分。
  估算口径:由每个设备完整时序的相邻读数构成区间,区间两端读数即使在
  查询范围外也参与;非下降区间把累计值之差按持续时间均匀分摊,以千分之一
  kWh 为单位,从区间起点累计到切点(查询边界与日界线)向下取整,片段消耗
  为两端累计量之差,故完整区间的分摊总量等于原差值,同一区间拆开查询再
  相加结果一致。下降区间不分摊,记为异常覆盖;首条读数之前、末条之后及
  孤立读数时段为未知,不外推。采用 --max-interval 时,非下降相邻区间的
  实际时间差超过限制即把整个区间记为未知(等于限制仍可信;下降区间即使
  超过限制仍为异常),不因查询范围或日界线裁短而变成可信区间。每天输出
  估算消耗与有效/异常/未知覆盖秒数(三者之和等于该天实际统计的各 UTC
  时段总秒数),并标明所用时区、采用的间隔限制与各 UTC 时段;采用限制时
  另显示过长间隔造成的未知秒数(gap)及相关设备与原始相邻读数时刻;
  存在未知或异常覆盖时日报标记为不完整。日报只读,不写入数据。

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
  切换均不重置分摊起点,拆开查询相加一致。daily 接受可选 --max-interval
  <秒>(正整数,省略为无上限,只影响本次查询):成员的非下降相邻区间实际
  时间差超过限制即把整个区间记为未知(等于限制仍可信;下降区间仍为异常,
  不因查询范围、日界线或成员切换裁短);分组的过长间隔未知秒数(gap)只在
  最终未知时段内按实际时间计并集,不叠加成员秒数。每天显示生效成员及其
  时段、估算消耗与有效/异常/未知秒数(三者之和等于当天查询时长),采用
  限制时另显示 gap 秒数及相关设备与原始相邻读数时刻;有异常或未知标为
  不完整,无有效覆盖显示无法计算。配置不改读数、规则和告警,导入不改配置。

运行/非运行时段报表(group schedule-report):
  按本地每周运行时间表把查询范围分为运行与非运行两类时段,分别核查分组
  能耗(只读,用于核查停运消耗)。--id 指定已有分组,--schedule 指定本地
  时间表文件,--from(含)与 --to(不含)必填且起点必须更早(秒精度
  ISO8601,带 Z 或数字时区偏移);--tz 可选(IANA 时区,默认 UTC),只
  解释时间表,不重新解释起止时刻或已存读数;--max-interval 可选(正整数
  秒,默认无上限,只影响本次查询)。能耗口径与 group daily 相同:按当时
  生效成员与完整读数时序,全部成员可信才累加消耗,任一下降优先为异常,
  否则任一未知为未知;首版前、读数首末之外与孤立读数未知,不外推;采样
  限制按原始相邻区间判断,裁切不使过长区间可信,等于限制仍可信;有效
  片段取原区间起点累计比例向下取整的两端差,切分不重置起点。两类分别
  显示实际 UTC 时段、估算消耗与有效/异常/未知秒数(采用限制时另显示
  gap 秒数及相关设备与原始相邻读数时刻);覆盖按时间计,不叠加成员秒数,
  两类覆盖合计等于查询时长,消耗合计等于同范围、同限制的分组日报,拆开
  查询相加一致。无有效覆盖显示无法计算,有效零增长显示零,有未知或异常
  标 INCOMPLETE。报表不改写时间表或业务存储、不自动评估,修正撤销后重查
  使用当前读数。成功(含不可计算结果)返回 0;非法时间表、参数或未知时区
  返回 2;时间表文件不可读、未知分组、所用存储损坏或全库重复读数身份
  返回 1,指出原因,不输出部分报表。

时间表文件格式(每周运行时间表):
  文本文件,每行一个运行窗口:<星期> <开始 HH:mm> <结束 HH:mm>;空行与
  # 之后的注释忽略。星期为 mon tue wed thu fri sat sun(不区分大小写)。
  开始限 00:00-23:59,结束另可 24:00;同值起止拒绝;结束早于开始即跨至
  下一日(尾段沿用开始日规则,周日可跨至周一)。窗口起点含、终点不含,
  重叠或重复取并集;零个窗口(空表)表示全部非运行。窗口按实际时刻的
  当地日期与墙钟分类,每秒只属一类:夏令时跳过时段不虚构覆盖,回拨重复
  时段各自分类,不套固定偏移或日长。group schedule-report 的 --schedule
  与 rule create 的 --schedule 共用本格式;后者在创建时保存解析结果,
  原文件后续变化不影响已建规则。

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
  阈值非负、最多三位小数 kWh;目标、阈值、时区与采样间隔限制创建后固定,
  分组规则绑定分组标识、不冻结创建时成员。--tz 可选,接受运行环境支持的
  IANA 时区名(如 Asia/Shanghai、America/New_York),省略为 UTC(与显式
  UTC 等价);时区按运行环境解析后的规范名存储与比较,未知时区名为参数
  错误,返回 2。--max-interval 可选,为正整数秒数的最大采样间隔限制,
  省略为无上限:非下降相邻区间的实际时间差超过限制即把整个区间记为未知
  (等于限制仍可信;下降区间即使超过限制仍为异常),仅全天有效覆盖的
  日期才与阈值比较。相同标识、同目标类型、同目标标识、等价阈值、同时区
  及同间隔限制重试成功且不重复创建,任一不同即报冲突。规则限制与列表
  显示重启后保留,备份恢复完整保留;旧规则与旧快照未设置限制时按无上限
  使用,已存非法限制按损坏数据拒绝。
  分组规则创建时可加 --schedule <时间表文件> 指定本地每周运行时间表
  (格式见上文"时间表文件格式",与 group schedule-report 相同;非法时间
  表返回 2,文件不可读返回 1):指定即为非运行模式,每天只取该日期全部
  实际时段中的非运行部分核查停运消耗;省略为全天模式。设备规则不接受
  时间表。创建时保存解析后的时间表,原文件后续修改、移动或删除不影响
  规则;模式与时间表创建后固定,标识在全天与非运行模式间统一唯一。
  同标识重试比较模式与每周运行窗口并集(不比较文件路径;窗口顺序、
  重复及等价拆分不影响等价性),其余参数比较不变,任一不同即报冲突且
  保持状态。非运行模式的创建与同参重试都检查所用存储与全库重复读数
  身份。非运行模式评估:每天先取归属该日期的全部实际 UTC 时段,再取
  其中的非运行部分(回拨重复小时各自分类,日期回退的不连续时段合并,
  跳过时段不虚构);整日被跳过或没有非运行秒数的日期说明原因,不触发
  也不恢复。仅非运行部分全部有效才与阈值比较,运行部分的异常或未知
  不阻止判定;非运行部分有异常或未知则不可判定;零增长有效,严格大于
  阈值才超限。评估与历史显示当天非运行 UTC 时段与有效/异常/未知秒数
  (采用限制时另显示过长间隔未知秒数),覆盖合计等于当天非运行时长;
  触发与恢复记录的消耗为当时的非运行值,不随后续数据改写。规则列表
  显示模式与固定时间表;旧规则与旧快照未设置模式时按全天模式,已存
  非法模式或时间表按损坏数据拒绝。
  evaluate 与 alerts 的 --from/--to 为 YYYY-MM-DD 的当地日期(按规则时区
  解释),起日含、止日不含,起日必须更早。每个日期统计归属该日期的全部实际
  UTC 时段(非运行模式只取其中的非运行部分),不把当地午夜套用固定偏移:夏令时短日不补未知,回拨重复小时完整
  计入,日期回退的不连续时段合并为同一天、一次评估只作一次判定;整日被跳过
  的日期标明跳过,不判定、不创建也不恢复告警。设备规则评估口径与 daily 相同;
  分组规则与 group daily 的联合覆盖口径相同:每天按当时生效的成员版本计算,
  允许日内切换,首个版本生效前为未知,任一成员下降为异常,否则任一成员未知
  为未知;成员切换不重置各设备原读数区间的分摊起点。仅全天有效覆盖的日期
  可判定,消耗严格大于阈值才超限(等于为正常),零增长有效;有未知或下降
  覆盖的日期不可判定,不触发也不恢复。每个规则每个日期独立跟踪:首次超限
  创建带全局唯一标识的未确认告警,重复超限保留原标识;完整评估正常才记录
  恢复;恢复后再超限创建新的未确认告警,旧记录保留,原确认不转移。批量日期
  评估要么全部提交要么不提交。
  ack 按告警标识确认,已恢复告警也可确认;重复确认成功且不重复记事,确认
  不改变超限或恢复状态。alerts 按规则和当地日期升序展示当前计算的消耗或不
  可判定原因、实际 UTC 时段及有效/异常/未知秒数(采用间隔限制时另显示过长
  间隔造成的未知秒数及相关设备与原始相邻读数时刻)、各次告警的标识、检测状态、
  确认状态及按发生顺序排列的触发/恢复/确认事件(触发、恢复时的消耗为当时
  记录,不随后续数据改写);省略日期范围时展示有告警记录的全部日期;查询
  只读,不会隐式恢复。导入读数或补录成员版本都不自动评估,需显式重评才更新
  检测状态。规则时区、间隔限制与历史重启后保留;没有时区的旧规则按 UTC 使用,
  未设置间隔限制的旧规则与旧快照按无上限使用,原告警标识、日期、状态和事件
  顺序保留。

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
  maxInterval?: number;
}

/** 解析最大采样间隔限制(正整数秒数);无效返回 null。 */
function parseMaxInterval(raw: string): number | null {
  const v = raw.trim();
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

/** 解析 --device/--from/--to(及允许时的 --tz、--max-interval)选项;出错返回错误消息字符串。 */
function parseOptions(rest: string[], allowTz = false, allowMaxInterval = false): ParsedOptions | string {
  const devices: string[] = [];
  let from: number | undefined;
  let to: number | undefined;
  let tz: string | undefined;
  let maxInterval: number | undefined;
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
    } else if (opt === '--max-interval' && allowMaxInterval) {
      const n = parseMaxInterval(value);
      if (n === null) {
        return `选项 '--max-interval' 的值无效: '${value.trim()}'(需正整数秒数)`;
      }
      maxInterval = n;
    } else {
      return `无法识别的选项 '${opt}'`;
    }
  }
  return { devices, from, to, tz, maxInterval };
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

/** 解析 YYYY-MM-DD 日期选项为当地日期标签;无效时返回错误消息字符串。 */
function dateFlag(value: string, label: string): { date: string } | string {
  const v = value.trim();
  if (parseUtcDate(v) === null) {
    return `${label}无效: '${v}'(需 YYYY-MM-DD 的真实日期)`;
  }
  return { date: v };
}

function cmdRule(rest: string[]): number {
  const [sub, ...subrest] = rest;
  if (sub === 'list') {
    if (subrest.length !== 0) return usageError("'rule list' 不接受参数");
    return cmdRuleList();
  }
  if (sub === 'create') {
    const flags = parseFlags(subrest, ['--id', '--device', '--group', '--threshold', '--tz', '--max-interval', '--schedule']);
    if (typeof flags === 'string') return usageError(flags);
    const idRaw = oneFlag(flags, '--id');
    const deviceList = flags.get('--device');
    const groupList = flags.get('--group');
    const thresholdRaw = oneFlag(flags, '--threshold');
    const tzList = flags.get('--tz');
    const maxIntervalList = flags.get('--max-interval');
    const scheduleList = flags.get('--schedule');
    if (idRaw === null || thresholdRaw === null) {
      return usageError("'rule create' 需要 --id 与 --threshold 各恰好一个");
    }
    if (tzList !== undefined && tzList.length !== 1) {
      return usageError("'rule create' 的 --tz 只能出现一次");
    }
    if (maxIntervalList !== undefined && maxIntervalList.length !== 1) {
      return usageError("'rule create' 的 --max-interval 只能出现一次");
    }
    if (scheduleList !== undefined && scheduleList.length !== 1) {
      return usageError("'rule create' 的 --schedule 只能出现一次");
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
    if (hasDevice && scheduleList !== undefined) {
      return usageError("设备规则不接受时间表:'rule create' 的 --schedule 仅用于分组规则");
    }
    const id = idRaw.trim();
    if (id === '') return usageError('规则标识不能为空');
    const thresholdMilli = parseKwh(thresholdRaw.trim());
    if (thresholdMilli === null) {
      return usageError(`阈值无效: '${thresholdRaw.trim()}'(需非负、最多三位小数的 kWh)`);
    }
    // 时区省略与显式 UTC 等价;按运行环境解析后的规范名存储与比较。
    let tz = 'UTC';
    if (tzList !== undefined) {
      const tzRaw = tzList[0].trim();
      if (tzRaw === '') return usageError("'--tz' 的值不能为空");
      const canonical = canonicalTimezone(tzRaw);
      if (canonical === null) {
        return usageError(`未知时区 '${tzRaw}'(需运行环境支持的 IANA 时区名,如 Asia/Shanghai、America/New_York)`);
      }
      tz = canonical;
    }
    // 采样间隔限制省略为无上限,创建后固定。
    let maxInterval: number | undefined;
    if (maxIntervalList !== undefined) {
      const parsed = parseMaxInterval(maxIntervalList[0]);
      if (parsed === null) {
        return usageError(`选项 '--max-interval' 的值无效: '${maxIntervalList[0].trim()}'(需正整数秒数)`);
      }
      maxInterval = parsed;
    }
    // 可选的每周运行时间表(仅分组规则):指定为非运行模式,省略为全天模式。
    // 创建时保存解析后的时间表,原文件后续修改、移动或删除不影响规则。
    let mode: 'all-day' | 'non-running' = 'all-day';
    let schedule: ScheduleWindow[] | undefined;
    if (scheduleList !== undefined) {
      const schedulePath = scheduleList[0];
      if (schedulePath.trim() === '') return usageError("'--schedule' 的值不能为空");
      let text: string;
      try {
        text = readFileSync(schedulePath, 'utf8');
      } catch (e) {
        console.error(`meterwatch: cannot read schedule file ${schedulePath}: ${(e as Error).message}`);
        return 1;
      }
      const parsed = parseSchedule(text);
      if (typeof parsed === 'string') {
        console.error(`meterwatch: invalid schedule file ${schedulePath}: ${parsed}`);
        return 2;
      }
      mode = 'non-running';
      schedule = parsed;
    }
    if (hasDevice) {
      const device = (deviceList as string[])[0].trim();
      if (device === '') return usageError("'--device' 的值不能为空");
      return cmdRuleCreate({ id, targetType: 'device', targetId: device, thresholdMilli, tz, maxInterval, mode });
    }
    const group = (groupList as string[])[0].trim();
    if (group === '') return usageError("'--group' 的值不能为空");
    return cmdRuleCreate({ id, targetType: 'group', targetId: group, thresholdMilli, tz, maxInterval, mode, schedule });
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
  if (from.date >= to.date) return usageError('评估起日必须早于止日(--from < --to)');
  return cmdEvaluate({ ruleId, from: from.date, to: to.date });
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
  let from: string | undefined;
  let to: string | undefined;
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
    if (fromParsed.date >= toParsed.date) return usageError('查询起日必须早于止日(--from < --to)');
    from = fromParsed.date;
    to = toParsed.date;
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
    const flags = parseFlags(subrest, ['--id', '--from', '--to', '--tz', '--max-interval']);
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
    const maxIntervalList = flags.get('--max-interval');
    if (maxIntervalList !== undefined && maxIntervalList.length !== 1) {
      return usageError("'group daily' 的 --max-interval 只能出现一次");
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
    let maxInterval: number | undefined;
    if (maxIntervalList !== undefined) {
      const parsed = parseMaxInterval(maxIntervalList[0]);
      if (parsed === null) {
        return usageError(`选项 '--max-interval' 的值无效: '${maxIntervalList[0].trim()}'(需正整数秒数)`);
      }
      maxInterval = parsed;
    }
    return cmdGroupDaily({ id, from, to, tz, maxInterval });
  }
  if (sub === 'schedule-report') {
    const flags = parseFlags(subrest, ['--id', '--schedule', '--from', '--to', '--tz', '--max-interval']);
    if (typeof flags === 'string') return usageError(flags);
    const idRaw = oneFlag(flags, '--id');
    const scheduleRaw = oneFlag(flags, '--schedule');
    const fromRaw = oneFlag(flags, '--from');
    const toRaw = oneFlag(flags, '--to');
    if (idRaw === null || scheduleRaw === null || fromRaw === null || toRaw === null) {
      return usageError("'group schedule-report' 需要 --id、--schedule、--from、--to 各恰好一个(起点含、终点不含)");
    }
    const tzList = flags.get('--tz');
    if (tzList !== undefined && tzList.length !== 1) {
      return usageError("'group schedule-report' 的 --tz 只能出现一次");
    }
    const maxIntervalList = flags.get('--max-interval');
    if (maxIntervalList !== undefined && maxIntervalList.length !== 1) {
      return usageError("'group schedule-report' 的 --max-interval 只能出现一次");
    }
    const id = idRaw.trim();
    if (id === '') return usageError('分组标识不能为空');
    if (scheduleRaw.trim() === '') return usageError("'--schedule' 的值不能为空");
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
    let maxInterval: number | undefined;
    if (maxIntervalList !== undefined) {
      const parsed = parseMaxInterval(maxIntervalList[0]);
      if (parsed === null) {
        return usageError(`选项 '--max-interval' 的值无效: '${maxIntervalList[0].trim()}'(需正整数秒数)`);
      }
      maxInterval = parsed;
    }
    return cmdGroupScheduleReport({ id, schedulePath: scheduleRaw, from, to, tz, maxInterval });
  }
  if (sub === undefined) return usageError("'group' 需要子命令 configure、history、daily 或 schedule-report");
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
  // 所有入口(含无参数、--help/-h、非法参数)都先取得数据目录操作权并处理
  // 未完成恢复,再执行查询或写入;协调失败返回 1,不输出正常业务结果。
  const result = withDirectoryCoordination<number>(() => runCommand(args));
  return typeof result === 'number' ? result : 1;
}

function runCommand(args: string[]): number {
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
    const parsed = parseOptions(rest, true, true);
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
    return cmdDaily({
      devices: parsed.devices,
      from: parsed.from,
      to: parsed.to,
      tz: parsed.tz,
      maxInterval: parsed.maxInterval,
    });
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

  if (cmd === 'backup') {
    if (rest.length !== 1) return usageError("'backup' 需要且仅需要一个快照文件路径(须位于数据目录之外)");
    return cmdBackup(rest[0]);
  }

  if (cmd === 'restore') {
    if (rest.length !== 1) return usageError("'restore' 需要且仅需要一个快照文件路径(须位于数据目录之外)");
    return cmdRestore(rest[0]);
  }

  return usageError(`无法识别的参数 '${cmd}'`);
}

process.exitCode = main(process.argv.slice(2));

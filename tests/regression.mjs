#!/usr/bin/env node
// 分组非运行时段告警(rule create --schedule / evaluate / alerts / ack)本地回归测试。
//
// 运行:node tests/regression.mjs(或 npm test)。离线、无外部依赖,需要 Node.js 24。
//
// 测试在独立临时目录中自建数据目录与素材文件,通过现有命令入口(node app.ts)
// 以新进程执行全部场景,核对退出码、业务输出与持久化状态;全部通过返回 0,
// 任一断言失败返回 1 并指出场景名;结束时删除自己创建的临时目录,不触碰
// 用户数据目录(所有子进程都显式设置 METERWATCH_DATA_DIR)。
//
// 预期值独立计算(不调用产品计算函数、不用两份产品输出互比):
// 分摊按"原读数区间起点累计比例向下取整,片段消耗为两端累计量之差",
// 即 cumulative(t) = floor(diff * (t - intervalStart) / duration),消耗 = cum(e) - cum(s)。

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../app.ts', import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), 'meterwatch-regression-'));
const DATA = join(WORK, 'data'); // 数据目录(由应用创建)
const FILES = join(WORK, 'files'); // 测试素材(CSV、时间表)
mkdirSync(FILES, { recursive: true });

// ---------------------------------------------------------------------------
// 断言框架
// ---------------------------------------------------------------------------

let failures = 0;
let current = '(setup)';

function fail(msg) {
  failures++;
  console.error(`FAIL [${current}] ${msg}`);
}
function check(cond, msg) {
  if (!cond) fail(msg);
}
function scenario(name, fn) {
  current = name;
  try {
    fn();
  } catch (e) {
    fail(`uncaught exception: ${(e && e.stack) || e}`);
  }
}

/** 以新进程运行命令入口;METERWATCH_DATA_DIR 始终指向临时数据目录。 */
function run(args) {
  const r = spawnSync(process.execPath, [APP, ...args], {
    env: { ...process.env, METERWATCH_DATA_DIR: DATA },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function expectExit(r, code, what) {
  check(
    r.code === code,
    `${what}: exit code ${String(r.code)} != ${code}; stderr=${JSON.stringify(r.err.trim())}`,
  );
}
function expectOut(r, s) {
  check(
    r.out.includes(s),
    `stdout missing ${JSON.stringify(s)}\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}`,
  );
}
function expectNoOut(r, s) {
  check(!r.out.includes(s), `stdout must not contain ${JSON.stringify(s)}\n--- stdout ---\n${r.out}`);
}
function expectErr(r, s) {
  check(r.err.includes(s), `stderr missing ${JSON.stringify(s)}\n--- stderr ---\n${r.err}`);
}

const readStore = (name) => readFileSync(join(DATA, name), 'utf8');
const readJson = (name) => JSON.parse(readStore(name));

// ---------------------------------------------------------------------------
// 固定样例数据
// ---------------------------------------------------------------------------
//
// 主场景(精确判定):分组 floor-1,成员版本 v1=[meter-1] 自 2026-01-04T00:00:00Z,
// v2=[meter-1,meter-2] 自 2026-01-05T06:00:30Z(秒级成员切换)。规则时区 UTC,
// 运行窗口 mon 08:00-18:00,评估当地日期 2026-01-05(周一)。
//
// 读数:
//   meter-1: 2026-01-04T00:00:00Z 10000000000000.000 → 2026-01-06T00:00:00Z 19007199254741.001
//     区间差 D1 = 9007199254741001 毫千瓦时(超出 Number 安全整数范围 2^53=9007199254740992),
//     时长 172800 秒,不能整除(奇数对偶数)。
//   meter-2: 2026-01-05T00:00:00Z 500.000 → 2026-01-06T00:00:00Z 1500.001
//     区间差 D2 = 1000001 毫千瓦时,时长 86400 秒,不能整除。
//
// 该日期的非运行 UTC 时段(运行窗口边界 08:00/18:00 切开读数区间):
//   P1 = 2026-01-05T00:00:00Z..2026-01-05T08:00:00Z  (28800 秒)
//   P2 = 2026-01-05T18:00:00Z..2026-01-06T00:00:00Z  (21600 秒)
//   合计 50400 秒,全部有效(valid=50400 anomaly=0 unknown=0)。
//
// 精确消耗(毫千瓦时,cum(t)=floor(D*(t-区间起点)/时长),片段=两端累计差;
// 成员切换点 06:00:30 不重置分摊起点):
//   meter-1 [00:00→06:00:30] : cum(108030+86400... 即 t-T0=108030+86400? 否:
//     t-T0 从 86400 到 108030)      = 1127463656713240
//   meter-1 [06:00:30→08:00]  (t-T0 108030→115200) = 373736219076927
//   meter-2 [06:00:30→08:00]  (t-U0 21630→28800)   = 82986
//   meter-1 [18:00→24:00]     (t-T0 151200→172800) = 1125899906842626
//   meter-2 [18:00→24:00]     (t-U0 64800→86400)   = 250001
//   合计 = 2627099782965780 毫千瓦时 = 2627099782965.780 kWh
//
// 阈值断言:规则 nr-eq 阈值 = 2627099782965.780(等于消耗 → 正常);
//           规则 nr-lo 阈值 = 2627099782965.779(低 0.001 kWh → 触发)。
//
// 修正后(meter-2@2026-01-06T00:00:00Z 改为 1500.000,D2'=1000000):
//   meter-2 [06:00:30→08:00] = 82986,[18:00→24:00] = 250000
//   合计 = 2627099782965779 毫千瓦时 = 2627099782965.779 kWh(恰好等于 nr-lo 阈值 → 正常)
//
// 纽约时区样例(规则时区 America/New_York):
//   前拨日 2026-03-08(周日,82800 秒):窗口 sun 02:00-03:00 的墙钟被跳过,
//     不虚构运行覆盖 → 全天为非运行,时段 2026-03-08T05:00:00Z..2026-03-09T04:00:00Z。
//     meter-ny 区间 [2026-03-07T00:00:00Z, 2026-03-10T00:00:00Z] 差 3000 毫千瓦时、
//     259200 秒:消耗 = cum(187200)-cum(104400) = 2166-1208 = 958 → 0.958 kWh。
//   回拨日 2026-11-01(周日,90000 秒):窗口 sun 01:00-02:00 的重复小时按两段
//     实际时刻各自计入运行(UTC 05:00-06:00 与 06:00-07:00)→ 非运行时段
//     2026-11-01T04:00:00Z..2026-11-01T05:00:00Z 与 2026-11-01T07:00:00Z..2026-11-02T05:00:00Z,
//     合计 82800 秒。meter-ny 区间 [2026-10-31T00:00:00Z, 2026-11-03T00:00:00Z]
//     差 3000 毫千瓦时:消耗 = (1208-1166) + (2208-1291) = 42+917 = 959 → 0.959 kWh。

const csvLines = ['device,time,reading'];
const addReading = (d, t, v) => csvLines.push(`${d},${t},${v}`);

// 主场景
addReading('meter-1', '2026-01-04T00:00:00Z', '10000000000000.000');
addReading('meter-1', '2026-01-06T00:00:00Z', '19007199254741.001');
addReading('meter-2', '2026-01-05T00:00:00Z', '500.000');
addReading('meter-2', '2026-01-06T00:00:00Z', '1500.001');
// 纽约时区
addReading('meter-ny', '2026-03-07T00:00:00Z', '0.000');
addReading('meter-ny', '2026-03-10T00:00:00Z', '3.000');
addReading('meter-ny', '2026-10-31T00:00:00Z', '3.000');
addReading('meter-ny', '2026-11-03T00:00:00Z', '6.000');
// blk:运行窗口内的下降不阻止非运行判定(2026-01-06 周二,窗口 tue 08:00-18:00)
addReading('meter-b', '2026-01-05T00:00:00Z', '99.000');
addReading('meter-b', '2026-01-06T08:00:00Z', '100.000');
addReading('meter-b', '2026-01-06T09:00:00Z', '90.000'); // 下降,异常区间 08:00-09:00 全在运行窗口内
addReading('meter-b', '2026-01-06T18:00:00Z', '95.000');
addReading('meter-b', '2026-01-07T00:00:00Z', '96.000');
// blk 非运行消耗:[00:00,08:00] 在区间 [01-05T00:00,01-06T08:00](差1000/115200s)
//   → 1000 - floor(1000*86400/115200)=1000-750=250;[18:00,24:00] 整区间 1000。合计 1250 → 1.250 kWh。
// blk2:运行窗口内的过长间隔(gap)不阻止非运行判定(2026-01-07 周三,窗口 wed 08:00-18:00,
//   规则 max-interval=3600;08:00-17:00 区间 32400 秒超限,落在运行窗口内;其余区间恰为 3600 秒=限制,仍可信)
for (let h = 0; h <= 8; h++) {
  addReading('meter-c', `2026-01-07T${String(h).padStart(2, '0')}:00:00Z`, `10.${String(h).padStart(3, '0')}`);
}
addReading('meter-c', '2026-01-07T17:00:00Z', '10.009');
for (let h = 18; h <= 23; h++) {
  addReading('meter-c', `2026-01-07T${h}:00:00Z`, `10.${String(h - 8).padStart(3, '0')}`);
}
addReading('meter-c', '2026-01-08T00:00:00Z', '10.016');
// blk2 非运行消耗:00:00-08:00 每小时 1 毫千瓦时 ×8 + 18:00-24:00 ×6 = 14 → 0.014 kWh。
// long:长间隔按原区间判断(2026-01-08 周四,窗口 thu 08:00-18:00,max-interval=3600;
//   区间 07:30-08:31 实际 3660 秒超限,其非运行片段 07:30-08:00 仅 1800 秒也不得变可信)
addReading('meter-e', '2026-01-08T07:30:00Z', '20.000');
addReading('meter-e', '2026-01-08T08:31:00Z', '20.001');
addReading('meter-e', '2026-01-08T18:00:00Z', '20.002');
addReading('meter-e', '2026-01-09T00:00:00Z', '20.003');
// long 非运行覆盖:00:00-07:30 首读数前未知(27000s),07:30-08:00 gap(1800s),
//   18:00-24:00 gap(21600s)→ valid=0 unknown=50400 gap=23400。
// gapu:多成员 gap 在最终未知时段内按实际时间计并集(2026-01-09 周五,窗口 fri 08:00-18:00)
addReading('meter-f', '2026-01-09T00:00:00Z', '30.000');
addReading('meter-f', '2026-01-09T05:00:00Z', '30.005');
addReading('meter-f', '2026-01-09T06:00:00Z', '30.006');
addReading('meter-f', '2026-01-09T07:00:00Z', '30.007');
addReading('meter-f', '2026-01-09T08:00:00Z', '30.008');
addReading('meter-f', '2026-01-09T18:00:00Z', '30.009');
addReading('meter-f', '2026-01-10T00:00:00Z', '30.010');
addReading('meter-g', '2026-01-09T02:00:00Z', '40.000');
addReading('meter-g', '2026-01-09T06:00:00Z', '40.004');
addReading('meter-g', '2026-01-09T07:00:00Z', '40.005');
addReading('meter-g', '2026-01-09T08:00:00Z', '40.006');
addReading('meter-g', '2026-01-09T18:00:00Z', '40.007');
addReading('meter-g', '2026-01-10T00:00:00Z', '40.008');
// gapu 非运行覆盖:00:00-06:00 未知(gap 并集:f[00,05]∪g[02,06]=21600s),
//   06:00-08:00 有效 7200s,18:00-24:00 两成员同区间 gap 并集 21600s(不叠加为 43200s)
//   → valid=7200 unknown=43200 gap=43200。
// dec:非运行下降优先于未知(2026-01-10 周六,窗口 sat 08:00-18:00)
addReading('meter-h', '2026-01-10T00:00:00Z', '50.000');
addReading('meter-h', '2026-01-10T04:00:00Z', '49.000'); // 下降,异常区间 00:00-04:00
addReading('meter-h', '2026-01-10T08:00:00Z', '49.500');
addReading('meter-h', '2026-01-10T18:00:00Z', '50.000');
addReading('meter-h', '2026-01-11T00:00:00Z', '50.500');
addReading('meter-i', '2026-01-10T02:00:00Z', '60.000'); // 00:00-02:00 首读数前未知
addReading('meter-i', '2026-01-10T08:00:00Z', '60.006');
addReading('meter-i', '2026-01-10T18:00:00Z', '60.007');
addReading('meter-i', '2026-01-11T00:00:00Z', '60.008');
// dec 非运行覆盖:00:00-04:00 异常(14400s,h 下降优先于 i 未知),
//   04:00-08:00 有效 14400s,18:00-24:00 有效 21600s → valid=36000 anomaly=14400 unknown=0。
// zero:有效零增长(2026-01-11 周日,空时间表=全部非运行)
addReading('meter-j', '2026-01-11T00:00:00Z', '70.000');
addReading('meter-j', '2026-01-12T00:00:00Z', '70.000');
// full:运行窗口覆盖全天(2026-01-11 周日,窗口 sun 00:00-24:00)
addReading('meter-k', '2026-01-11T00:00:00Z', '80.000');
addReading('meter-k', '2026-01-12T00:00:00Z', '81.000');

const READING_COUNT = csvLines.length - 1; // 60

const writeFile = (name, content) => {
  const p = join(FILES, name);
  writeFileSync(p, content, 'utf8');
  return p;
};

const csvPath = writeFile('readings.csv', csvLines.join('\n') + '\n');
const csv2Path = writeFile(
  'more.csv',
  'device,time,reading\nmeter-3,2026-01-01T00:00:00Z,1.000\nmeter-3,2026-01-02T00:00:00Z,2.000\n',
);

const schedSplit = writeFile('sched-split.txt', 'mon 08:00 12:00\nmon 12:00 18:00\n');
const schedMerged = writeFile('sched-merged.txt', 'mon 08:00 18:00\n');
const schedDifferent = writeFile('sched-different.txt', 'mon 09:00 18:00\n');
const schedNySpring = writeFile('sched-ny-spring.txt', 'sun 02:00 03:00\n');
const schedNyFall = writeFile('sched-ny-fall.txt', 'sun 01:00 02:00\n');
const schedTue = writeFile('sched-tue.txt', 'tue 08:00 18:00\n');
const schedWed = writeFile('sched-wed.txt', 'wed 08:00 18:00\n');
const schedThu = writeFile('sched-thu.txt', 'thu 08:00 18:00\n');
const schedFri = writeFile('sched-fri.txt', 'fri 08:00 18:00\n');
const schedSat = writeFile('sched-sat.txt', 'sat 08:00 18:00\n');
const schedEmpty = writeFile('sched-empty.txt', '# 零个窗口:全部非运行\n');
const schedSunFull = writeFile('sched-sun-full.txt', 'sun 00:00 24:00\n');

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

scenario('导入读数与分组配置', () => {
  const imp = run(['import', csvPath]);
  expectExit(imp, 0, 'import');
  expectOut(imp, `imported ${READING_COUNT} new reading(s), 0 duplicate(s) skipped`);

  const groups = [
    ['floor-1', '2026-01-04T00:00:00Z', ['meter-1']],
    ['floor-1', '2026-01-05T06:00:30Z', ['meter-1', 'meter-2']], // 秒级成员切换
    ['ny-g', '2026-03-01T00:00:00Z', ['meter-ny']],
    ['blk-g', '2026-01-05T00:00:00Z', ['meter-b']],
    ['blk2-g', '2026-01-07T00:00:00Z', ['meter-c']],
    ['long-g', '2026-01-08T00:00:00Z', ['meter-e']],
    ['gapu-g', '2026-01-09T00:00:00Z', ['meter-f', 'meter-g']],
    ['dec-g', '2026-01-10T00:00:00Z', ['meter-h', 'meter-i']],
    ['zero-g', '2026-01-11T00:00:00Z', ['meter-j']],
    ['full-g', '2026-01-11T00:00:00Z', ['meter-k']],
  ];
  for (const [id, at, members] of groups) {
    const r = run(['group', 'configure', '--id', id, '--at', at, ...members.flatMap((m) => ['--device', m])]);
    expectExit(r, 0, `group configure ${id}@${at}`);
  }
});

scenario('创建非运行时段告警规则(窗口并集规范化)', () => {
  // nr-eq 用等价拆分窗口(mon 08:00-12:00 + mon 12:00-18:00)创建,
  // 规范形应合并为 mon 08:00-18:00。
  const r1 = run(['rule', 'create', '--id', 'nr-eq', '--group', 'floor-1', '--threshold', '2627099782965.780', '--schedule', schedSplit]);
  expectExit(r1, 0, 'rule create nr-eq');
  expectOut(r1, "rule 'nr-eq' created: group=floor-1 threshold=2627099782965.780 kWh tz=UTC max-interval=none mode=non-running schedule=mon 08:00-18:00");

  const creates = [
    ['nr-lo', 'floor-1', '2627099782965.779', schedMerged, []],
    ['ny-spring', 'ny-g', '0.958', schedNySpring, ['--tz', 'America/New_York']],
    ['ny-fall', 'ny-g', '0.958', schedNyFall, ['--tz', 'America/New_York']],
    ['blk', 'blk-g', '1.000', schedTue, []],
    ['blk2', 'blk2-g', '0.010', schedWed, ['--max-interval', '3600']],
    ['long', 'long-g', '0.001', schedThu, ['--max-interval', '3600']],
    ['gapu', 'gapu-g', '0.001', schedFri, ['--max-interval', '3600']],
    ['dec', 'dec-g', '0.001', schedSat, []],
    ['zero', 'zero-g', '0.000', schedEmpty, []],
    ['full', 'full-g', '0.001', schedSunFull, []],
  ];
  for (const [id, group, threshold, sched, extra] of creates) {
    const r = run(['rule', 'create', '--id', id, '--group', group, '--threshold', threshold, '--schedule', sched, ...extra]);
    expectExit(r, 0, `rule create ${id}`);
    expectOut(r, 'mode=non-running');
  }
});

scenario('窗口并集等价拆分重试不新增,不同窗口报冲突', () => {
  // 等价拆分(mon 08:00-18:00 整段)对比已存的拆分并集:同参重试成功且不新增。
  const retry = run(['rule', 'create', '--id', 'nr-eq', '--group', 'floor-1', '--threshold', '2627099782965.780', '--schedule', schedMerged]);
  expectExit(retry, 0, 'rule create nr-eq retry (equivalent union)');
  expectOut(retry, 'already exists with identical parameters');
  expectOut(retry, 'unchanged');

  // 窗口并集不同:报冲突,返回 1。
  const conflict = run(['rule', 'create', '--id', 'nr-eq', '--group', 'floor-1', '--threshold', '2627099782965.780', '--schedule', schedDifferent]);
  expectExit(conflict, 1, 'rule create nr-eq conflicting schedule');
  expectErr(conflict, 'conflict');

  const list = run(['rule', 'list']);
  expectExit(list, 0, 'rule list');
  const ruleLines = list.out.split('\n').filter((l) => l.startsWith('rule '));
  check(ruleLines.length === 11, `expected 11 rules, got ${ruleLines.length}:\n${list.out}`);
});

scenario('非法星期(constructor/__proto__/toString)返回 2,不创建规则、不改业务文件', () => {
  const before = readStore('alerts.json');
  for (const [i, weekday] of ['constructor', '__proto__', 'toString'].entries()) {
    const badSched = writeFile(`sched-bad-${i}.txt`, `${weekday} 08:00 18:00\n`);
    const r = run(['rule', 'create', '--id', `bad-${i}`, '--group', 'floor-1', '--threshold', '1', '--schedule', badSched]);
    expectExit(r, 2, `rule create with weekday '${weekday}'`);
    expectErr(r, `unknown weekday '${weekday}'`);
  }
  const list = run(['rule', 'list']);
  expectExit(list, 0, 'rule list after illegal weekdays');
  const ruleLines = list.out.split('\n').filter((l) => l.startsWith('rule '));
  check(ruleLines.length === 11, `illegal weekdays must not create rules (got ${ruleLines.length} rules)`);
  check(readStore('alerts.json') === before, 'alerts.json changed by rejected rule create');
});

scenario('删除原时间表文件后规则仍使用固定窗口', () => {
  for (const p of [schedSplit, schedMerged, schedDifferent, schedNySpring, schedNyFall, schedTue, schedWed, schedThu, schedFri, schedSat, schedEmpty, schedSunFull]) {
    unlinkSync(p);
  }
  check(!existsSync(schedSplit) && !existsSync(schedMerged), 'schedule files not deleted');
  // 后续全部评估都依赖规则内保存的固定窗口;此处先用 nr-eq 验证分类仍正确。
  const r = run(['evaluate', '--rule', 'nr-eq', '--from', '2026-01-05', '--to', '2026-01-06']);
  expectExit(r, 0, 'evaluate nr-eq after deleting schedule files');
  expectOut(r, 'mode=non-running schedule=mon 08:00-18:00');
  expectOut(r, 'period=2026-01-05T00:00:00Z..2026-01-05T08:00:00Z');
});

scenario('精确判定:阈值等于消耗正常(nr-eq)', () => {
  const r = run(['evaluate', '--rule', 'nr-eq', '--from', '2026-01-05', '--to', '2026-01-06']);
  expectExit(r, 0, 'evaluate nr-eq');
  expectOut(r, 'rule: nr-eq  group=floor-1  threshold=2627099782965.780 kWh  tz=UTC  max-interval=none  mode=non-running schedule=mon 08:00-18:00');
  expectOut(r, '  2026-01-05  consumption=2627099782965.780 kWh <= threshold=2627099782965.780 kWh  NORMAL  no alert  valid=50400s anomaly=0s unknown=0s');
  expectOut(r, '    period=2026-01-05T00:00:00Z..2026-01-05T08:00:00Z');
  expectOut(r, '    period=2026-01-05T18:00:00Z..2026-01-06T00:00:00Z');
  const state = readJson('alerts.json');
  check(state.alerts.length === 0, `nr-eq must not create alerts, got ${state.alerts.length}`);
});

scenario('精确判定:阈值低 0.001 kWh 触发(nr-lo)', () => {
  const r = run(['evaluate', '--rule', 'nr-lo', '--from', '2026-01-05', '--to', '2026-01-06']);
  expectExit(r, 0, 'evaluate nr-lo');
  expectOut(r, '  2026-01-05  consumption=2627099782965.780 kWh > threshold=2627099782965.779 kWh  EXCEEDED  alert alert-1 triggered (unacknowledged)  valid=50400s anomaly=0s unknown=0s');
  const state = readJson('alerts.json');
  check(state.alerts.length === 1 && state.alerts[0].id === 'alert-1', 'alert-1 not created as expected');
  check(state.alerts[0].acknowledged === false, 'new alert must be unacknowledged');
  check(
    state.alerts[0].events.length === 1 &&
      state.alerts[0].events[0].seq === 1 &&
      state.alerts[0].events[0].type === 'triggered' &&
      state.alerts[0].events[0].consumptionMilli === '2627099782965780',
    `alert-1 events wrong: ${JSON.stringify(state.alerts[0].events)}`,
  );
});

scenario('重复评估保留原标识且不新增事件', () => {
  const r = run(['evaluate', '--rule', 'nr-lo', '--from', '2026-01-05', '--to', '2026-01-06']);
  expectExit(r, 0, 're-evaluate nr-lo');
  expectOut(r, 'EXCEEDED  alert alert-1 remains triggered');
  const state = readJson('alerts.json');
  check(state.alerts.length === 1 && state.alerts[0].events.length === 1, 'repeated evaluation added events or alerts');
  check(state.nextAlertNum === 2 && state.nextEventSeq === 2, `counters moved: ${JSON.stringify({ n: state.nextAlertNum, s: state.nextEventSeq })}`);
});

scenario('重复确认成功且不重复记事', () => {
  const a1 = run(['ack', 'alert-1']);
  expectExit(a1, 0, 'ack alert-1');
  expectOut(a1, 'alert alert-1 acknowledged (rule=nr-lo group=floor-1 date=2026-01-05 status=triggered)');
  const a2 = run(['ack', 'alert-1']);
  expectExit(a2, 0, 're-ack alert-1');
  expectOut(a2, 'alert alert-1 already acknowledged; unchanged');
  const state = readJson('alerts.json');
  check(
    state.alerts[0].acknowledged === true &&
      state.alerts[0].events.length === 2 &&
      state.alerts[0].events[1].type === 'acknowledged' &&
      state.alerts[0].events[1].seq === 2,
    `ack events wrong: ${JSON.stringify(state.alerts[0].events)}`,
  );
  check(state.alerts[0].status === 'triggered', 'ack must not change detection status');
});

scenario('数据操作与查询不自动更新检测状态', () => {
  const before = readStore('alerts.json');
  const imp = run(['import', csv2Path]);
  expectExit(imp, 0, 'import after trigger');
  check(readStore('alerts.json') === before, 'import modified alerts.json');

  const q = run(['alerts', '--rule', 'nr-lo']);
  expectExit(q, 0, 'alerts query');
  expectOut(q, '    alert alert-1  status=TRIGGERED  ack=ACKNOWLEDGED');
  check(readStore('alerts.json') === before, 'alerts query modified alerts.json');
});

scenario('修正后查询:当前消耗重算,检测状态与旧事件保留', () => {
  const alertsBefore = readStore('alerts.json');
  const c = run(['correct', '--request', 'REQ-1', '--item', '--device', 'meter-2', '--at', '2026-01-06T00:00:00Z', '--expect', '1500.001', '--set', '1500.000']);
  expectExit(c, 0, 'correct REQ-1');
  expectOut(c, "correction 'REQ-1' committed: 1 item(s), 1 reading(s) changed");
  check(readStore('alerts.json') === alertsBefore, 'correct modified alerts.json');

  const q = run(['alerts', '--rule', 'nr-lo', '--from', '2026-01-05', '--to', '2026-01-06']);
  expectExit(q, 0, 'alerts after correction');
  // 当前消耗按修正后读数重算为 2627099782965.779(等于阈值,正常)……
  expectOut(q, '  2026-01-05  consumption=2627099782965.779 kWh (NORMAL, threshold=2627099782965.779 kWh)  valid=50400s anomaly=0s unknown=0s');
  // ……但检测状态不自动更新,旧事件消耗与确认保留。
  expectOut(q, '    alert alert-1  status=TRIGGERED  ack=ACKNOWLEDGED');
  expectOut(q, '      events: #1 triggered (consumption=2627099782965.780 kWh), #2 acknowledged');
});

scenario('正常重评记录恢复(消耗为评估当时值)', () => {
  const r = run(['evaluate', '--rule', 'nr-lo', '--from', '2026-01-05', '--to', '2026-01-06']);
  expectExit(r, 0, 're-evaluate after correction');
  expectOut(r, '  2026-01-05  consumption=2627099782965.779 kWh <= threshold=2627099782965.779 kWh  NORMAL  alert alert-1 recovered  valid=50400s anomaly=0s unknown=0s');
  const state = readJson('alerts.json');
  const ev = state.alerts[0].events;
  check(
    state.alerts[0].status === 'recovered' &&
      ev.length === 3 &&
      ev[2].type === 'recovered' &&
      ev[2].seq === 3 &&
      ev[2].consumptionMilli === '2627099782965779',
    `recovery event wrong: ${JSON.stringify(ev)}`,
  );
});

scenario('撤销后再次超限:新告警未确认,旧确认不转移', () => {
  const alertsBefore = readStore('alerts.json');
  const u = run(['undo', '--request', 'UNDO-1', '--target', 'REQ-1']);
  expectExit(u, 0, 'undo UNDO-1');
  expectOut(u, "undo 'UNDO-1' committed: target='REQ-1', 1 reading(s) restored");
  check(readStore('alerts.json') === alertsBefore, 'undo modified alerts.json');

  // 撤销后查询:当前消耗回到超限,但检测状态仍需显式重评。
  const q = run(['alerts', '--rule', 'nr-lo', '--from', '2026-01-05', '--to', '2026-01-06']);
  expectExit(q, 0, 'alerts after undo');
  expectOut(q, '  2026-01-05  consumption=2627099782965.780 kWh (EXCEEDED, threshold=2627099782965.779 kWh)  valid=50400s anomaly=0s unknown=0s');
  expectOut(q, '    alert alert-1  status=RECOVERED  ack=ACKNOWLEDGED');

  const r = run(['evaluate', '--rule', 'nr-lo', '--from', '2026-01-05', '--to', '2026-01-06']);
  expectExit(r, 0, 're-evaluate after undo');
  expectOut(r, '  2026-01-05  consumption=2627099782965.780 kWh > threshold=2627099782965.779 kWh  EXCEEDED  alert alert-2 triggered (unacknowledged)  valid=50400s anomaly=0s unknown=0s');

  const state = readJson('alerts.json');
  check(state.alerts.length === 2, `expected 2 alerts, got ${state.alerts.length}`);
  const a1 = state.alerts.find((a) => a.id === 'alert-1');
  const a2 = state.alerts.find((a) => a.id === 'alert-2');
  check(a1 && a1.status === 'recovered' && a1.acknowledged === true && a1.events.length === 3, 'alert-1 history not preserved');
  check(
    a2 && a2.status === 'triggered' && a2.acknowledged === false &&
      a2.events.length === 1 && a2.events[0].seq === 4 &&
      a2.events[0].consumptionMilli === '2627099782965780',
    `alert-2 wrong: ${JSON.stringify(a2)}`,
  );
});

scenario('跨进程重放修正与撤销请求不再次改值或增历史', () => {
  const c = run(['correct', '--request', 'REQ-1', '--item', '--device', 'meter-2', '--at', '2026-01-06T00:00:00Z', '--expect', '1500.001', '--set', '1500.000']);
  expectExit(c, 0, 'replay correct REQ-1');
  expectOut(c, "correction 'REQ-1' committed: 1 item(s), 1 reading(s) changed");
  const u = run(['undo', '--request', 'UNDO-1', '--target', 'REQ-1']);
  expectExit(u, 0, 'replay undo UNDO-1');
  expectOut(u, "undo 'UNDO-1' committed: target='REQ-1', 1 reading(s) restored");

  const store = readJson('readings.json');
  check(store.corrections.length === 1 && store.undos.length === 1, 'replay added history');
  const correctedTs = Date.parse('2026-01-06T00:00:00Z') / 1000;
  const r = store.readings.find((x) => x.device === 'meter-2' && x.ts === correctedTs);
  check(r && r.milli === '1500001', `replayed correction re-applied value: ${JSON.stringify(r)}`);

  const hist = run(['corrections']);
  expectExit(hist, 0, 'corrections');
  expectOut(hist, "correction 'REQ-1': 1 item(s), 1 reading(s) changed  (undone by 'UNDO-1')");
  expectOut(hist, "undo 'UNDO-1': target='REQ-1', 1 reading(s) restored");
});

scenario('纽约前拨:跳过墙钟不补覆盖(短日 82800 秒)', () => {
  const r = run(['evaluate', '--rule', 'ny-spring', '--from', '2026-03-08', '--to', '2026-03-09']);
  expectExit(r, 0, 'evaluate ny-spring');
  expectOut(r, '  2026-03-08  consumption=0.958 kWh <= threshold=0.958 kWh  NORMAL  no alert  valid=82800s anomaly=0s unknown=0s');
  expectOut(r, '    period=2026-03-08T05:00:00Z..2026-03-09T04:00:00Z');
  const dayLines = r.out.split('\n').filter((l) => l.startsWith('  2026-03-08  '));
  check(dayLines.length === 1, `2026-03-08 judged ${dayLines.length} times`);
});

scenario('纽约回拨:重复小时按两段实际时刻计入,每日期只判定一次', () => {
  const r = run(['evaluate', '--rule', 'ny-fall', '--from', '2026-11-01', '--to', '2026-11-02']);
  expectExit(r, 0, 'evaluate ny-fall');
  expectOut(r, '  2026-11-01  consumption=0.959 kWh > threshold=0.958 kWh  EXCEEDED  alert alert-3 triggered (unacknowledged)  valid=82800s anomaly=0s unknown=0s');
  expectOut(r, '    period=2026-11-01T04:00:00Z..2026-11-01T05:00:00Z');
  expectOut(r, '    period=2026-11-01T07:00:00Z..2026-11-02T05:00:00Z');
  const dayLines = r.out.split('\n').filter((l) => l.startsWith('  2026-11-01  '));
  check(dayLines.length === 1, `2026-11-01 judged ${dayLines.length} times`);
});

scenario('运行窗口内的异常不阻止非运行部分的完整判定', () => {
  const r = run(['evaluate', '--rule', 'blk', '--from', '2026-01-06', '--to', '2026-01-07']);
  expectExit(r, 0, 'evaluate blk');
  // 运行窗口 08:00-18:00 内有下降异常,但非运行部分完整有效:消耗 1.250 kWh 超限。
  expectOut(r, '  2026-01-06  consumption=1.250 kWh > threshold=1.000 kWh  EXCEEDED  alert alert-4 triggered (unacknowledged)  valid=50400s anomaly=0s unknown=0s');
});

scenario('运行窗口内的过长间隔未知不阻止非运行判定,且不向非运行泄漏 gap', () => {
  const r = run(['evaluate', '--rule', 'blk2', '--from', '2026-01-07', '--to', '2026-01-08']);
  expectExit(r, 0, 'evaluate blk2');
  expectOut(r, 'max-interval=3600s');
  expectOut(r, '  2026-01-07  consumption=0.014 kWh > threshold=0.010 kWh  EXCEEDED  alert alert-5 triggered (unacknowledged)  valid=50400s anomaly=0s unknown=0s gap=0s');
});

scenario('长间隔按原区间判断(裁切不使过长区间可信)', () => {
  const r = run(['evaluate', '--rule', 'long', '--from', '2026-01-08', '--to', '2026-01-09']);
  expectExit(r, 0, 'evaluate long');
  // 区间 07:30-08:31 实际 3660 秒超限:其非运行片段 07:30-08:00(1800 秒)同样未知。
  expectOut(r, '  2026-01-08  undecidable (valid=0s anomaly=0s unknown=50400s gap=23400s)  no alert action');
  expectOut(r, '    gap: device=meter-e  interval=2026-01-08T07:30:00Z..2026-01-08T08:31:00Z');
  expectOut(r, '    gap: device=meter-e  interval=2026-01-08T18:00:00Z..2026-01-09T00:00:00Z');
  const state = readJson('alerts.json');
  check(!state.alerts.some((a) => a.ruleId === 'long'), 'undecidable day created an alert');
});

scenario('多个成员的 gap 按最终未知时段计并集(不叠加成员秒数)', () => {
  const r = run(['evaluate', '--rule', 'gapu', '--from', '2026-01-09', '--to', '2026-01-10']);
  expectExit(r, 0, 'evaluate gapu');
  expectOut(r, '  2026-01-09  undecidable (valid=7200s anomaly=0s unknown=43200s gap=43200s)  no alert action');
  expectOut(r, '    gap: device=meter-f  interval=2026-01-09T00:00:00Z..2026-01-09T05:00:00Z');
  expectOut(r, '    gap: device=meter-g  interval=2026-01-09T02:00:00Z..2026-01-09T06:00:00Z');
  expectOut(r, '    gap: device=meter-f  interval=2026-01-09T18:00:00Z..2026-01-10T00:00:00Z');
  expectOut(r, '    gap: device=meter-g  interval=2026-01-09T18:00:00Z..2026-01-10T00:00:00Z');
});

scenario('非运行下降优先于未知;非运行异常不触发也不恢复', () => {
  const r = run(['evaluate', '--rule', 'dec', '--from', '2026-01-10', '--to', '2026-01-11']);
  expectExit(r, 0, 'evaluate dec');
  // 00:00-02:00 meter-h 下降(异常)与 meter-i 未知并存:异常优先。
  expectOut(r, '  2026-01-10  undecidable (valid=36000s anomaly=14400s unknown=0s)  no alert action');
  const state = readJson('alerts.json');
  check(!state.alerts.some((a) => a.ruleId === 'dec'), 'anomaly day created an alert');
});

scenario('有效零增长显示 0.000 且为正常', () => {
  const r = run(['evaluate', '--rule', 'zero', '--from', '2026-01-11', '--to', '2026-01-12']);
  expectExit(r, 0, 'evaluate zero');
  expectOut(r, '  2026-01-11  consumption=0.000 kWh <= threshold=0.000 kWh  NORMAL  no alert  valid=86400s anomaly=0s unknown=0s');
});

scenario('没有非运行秒数说明原因且不作告警动作', () => {
  const r = run(['evaluate', '--rule', 'full', '--from', '2026-01-11', '--to', '2026-01-12']);
  expectExit(r, 0, 'evaluate full');
  expectOut(r, '  2026-01-11  NO NON-RUNNING COVERAGE (running windows cover the whole local date)  no alert action');
  const q = run(['alerts', '--rule', 'full', '--from', '2026-01-11', '--to', '2026-01-12']);
  expectExit(q, 0, 'alerts full');
  expectOut(q, '  2026-01-11  NO NON-RUNNING COVERAGE (running windows cover the whole local date)');
  expectOut(q, '    no alerts');
  const state = readJson('alerts.json');
  check(!state.alerts.some((a) => a.ruleId === 'full'), 'no-non-running day created an alert');
});

scenario('无有效覆盖时 evaluate 与 alerts 显示无法计算(不可判定)', () => {
  // 2026-01-01(周四)无运行窗口 → 全天非运行;读数与成员版本尚未开始 → 全部未知。
  const r = run(['evaluate', '--rule', 'nr-eq', '--from', '2026-01-01', '--to', '2026-01-02']);
  expectExit(r, 0, 'evaluate nr-eq 2026-01-01');
  expectOut(r, '  2026-01-01  undecidable (valid=0s anomaly=0s unknown=86400s)  no alert action');
  const q = run(['alerts', '--rule', 'nr-eq', '--from', '2026-01-01', '--to', '2026-01-02']);
  expectExit(q, 0, 'alerts nr-eq 2026-01-01');
  expectOut(q, '  2026-01-01  undecidable (valid=0s anomaly=0s unknown=86400s)');
  expectOut(q, '    no alerts');
});

scenario('受控故障:批量日期评估写入失败返回 1,状态不变,解除后重试成功', () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log(`  [${current}] skipped: running as root, read-only directory fault cannot be simulated`);
    return;
  }
  const filesBefore = readdirSync(DATA).sort();
  const contentBefore = new Map(filesBefore.map((f) => [f, readStore(f)]));
  chmodSync(DATA, 0o555);
  try {
    const r = run(['evaluate', '--rule', 'nr-lo', '--from', '2026-01-05', '--to', '2026-01-07']);
    expectExit(r, 1, 'evaluate with read-only data directory');
    check(r.out === '', `partial success output leaked to stdout:\n${r.out}`);
    check(r.err.trim() !== '', 'no error reported on stderr');
  } finally {
    chmodSync(DATA, 0o755);
  }
  const filesAfter = readdirSync(DATA).sort();
  check(
    JSON.stringify(filesAfter) === JSON.stringify(filesBefore),
    `data directory file list changed: ${JSON.stringify(filesBefore)} -> ${JSON.stringify(filesAfter)}`,
  );
  for (const f of filesBefore) {
    check(readStore(f) === contentBefore.get(f), `${f} changed by failed evaluation`);
  }

  // 解除故障后重试成功;告警与事件编号不与已有记录冲突。
  const retry = run(['evaluate', '--rule', 'nr-lo', '--from', '2026-01-05', '--to', '2026-01-07']);
  expectExit(retry, 0, 'evaluate retry after fault removed');
  expectOut(retry, '  2026-01-05  consumption=2627099782965.780 kWh > threshold=2627099782965.779 kWh  EXCEEDED  alert alert-2 remains triggered  valid=50400s anomaly=0s unknown=0s');
  const state = readJson('alerts.json');
  const ids = state.alerts.map((a) => a.id);
  check(new Set(ids).size === ids.length, `duplicate alert ids: ${ids.join(',')}`);
  const seqs = state.alerts.flatMap((a) => a.events.map((e) => e.seq));
  check(new Set(seqs).size === seqs.length, `duplicate event seqs: ${seqs.join(',')}`);
});

scenario('最终持久化状态:编号、历史与业务存储一致', () => {
  const state = readJson('alerts.json');
  check(state.rules.length === 11, `expected 11 rules, got ${state.rules.length}`);
  check(state.alerts.length === 5, `expected 5 alerts, got ${state.alerts.length}`);
  check(state.nextAlertNum === 6, `nextAlertNum=${state.nextAlertNum} != 6`);
  check(state.nextEventSeq === 8, `nextEventSeq=${state.nextEventSeq} != 8`);

  const byId = new Map(state.alerts.map((a) => [a.id, a]));
  const expectAlert = (id, ruleId, date, status, ack, seqs) => {
    const a = byId.get(id);
    check(
      a && a.ruleId === ruleId && a.date === date && a.status === status && a.acknowledged === ack &&
        a.events.map((e) => e.seq).join(',') === seqs,
      `alert ${id} mismatch: ${JSON.stringify(a)}`,
    );
  };
  expectAlert('alert-1', 'nr-lo', '2026-01-05', 'recovered', true, '1,2,3');
  expectAlert('alert-2', 'nr-lo', '2026-01-05', 'triggered', false, '4');
  expectAlert('alert-3', 'ny-fall', '2026-11-01', 'triggered', false, '5');
  expectAlert('alert-4', 'blk', '2026-01-06', 'triggered', false, '6');
  expectAlert('alert-5', 'blk2', '2026-01-07', 'triggered', false, '7');

  const readings = readJson('readings.json');
  check(readings.readings.length === READING_COUNT + 2, `readings count ${readings.readings.length}`);
  check(readings.corrections.length === 1 && readings.undos.length === 1, 'correction/undo history wrong');

  const groups = readJson('groups.json');
  check(groups.groups.length === 9, `expected 9 groups, got ${groups.groups.length}`);
});

// ---------------------------------------------------------------------------
// 汇总与清理
// ---------------------------------------------------------------------------

try {
  chmodSync(DATA, 0o755);
} catch {
  // 数据目录可能从未创建;忽略。
}
rmSync(WORK, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log('OK: all non-running-period alert regression scenarios passed');
}

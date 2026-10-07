// 分组非运行时段告警 —— 本地离线回归测试。
//
// 运行(在仓库根目录):
//   node tests/run.mjs
// 要求 Node.js 24,无外部依赖;可重复离线运行。
//
// 测试约定:
// - 每个场景使用独立的 OS 临时数据目录(METERWATCH_DATA_DIR),结束即清理,
//   绝不触碰默认 ~/.meterwatch 或其他使用者数据。
// - 主要场景一律以「新进程」运行现有命令入口 `node app.ts ...`,核对退出码、
//   业务输出(stdout/stderr)与三个业务存储(readings/alerts/groups)的持久化状态。
// - 全部断言通过进程退出码 0;任一失败退出码非零并指出场景名。
//
// 预期值全部在下方 EXPECTED 中按口径手工/独立推导(原读数区间起点累计比例
// 向下取整、BigInt 整数运算),不复用产品的计算函数,也不拿两份产品输出
// 互相比较来充当预期值。

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../app.ts', import.meta.url));

// ---------------------------------------------------------------------------
// 独立推导的预期值(非产品代码):
//
// 主场景 S1,UTC 2026-01-05(周一),运行窗口 mon 12:00-18:00(等价拆分重试
// 使用 mon 12:00-15:00 + mon 15:00-18:00):
//   非运行 UTC 时段 = [00:00,12:00) + [18:00,24:00),共 64800 秒;
//   运行 UTC 时段   = [12:00,18:00),            共 21600 秒。
// 分摊口径 cum(diff,start,dur,t)=floor(diff*(t-start)/dur),片段=两端累计量之差。
//   m1 区间 [周一00:00,周二00:00) dur=86400,diff=9007199254742001 毫千瓦时
//      (超出 Number.MAX_SAFE_INTEGER=9007199254740991;不能被 86400 整除):
//      NR 段1[00,12)=4503599627371000;运行[12,18)=2251799813685500;
//      NR 段2[18,24)=2251799813685501。m1 非运行合计 = 6755399441056501。
//   m2 区间 [00:00,24:00) diff=2000 毫千瓦时:非运行 = 1000(=1.000 kWh)。
//   m3 自 12:00:30(秒级成员切换,落在运行窗内)起为成员,其首条读数在 12:01:00;
//      有效读数区间 [12:01:00,24:00) dur=43140,diff=7:
//      运行窗切点 18:00 的累计量 = floor(7*(64800-43260)/43140)=floor(7*21540/43140)=3;
//      非运行[18,24)=cum(24:00)−cum(18:00)=7−3=4。
//      12:00:30-12:01:00(30 秒)m3 已生效却无读数区间 => 分组未知。
//   分组非运行消耗 = 6755399441056501 + 2006 + 4 = 6755399441058511 毫千瓦时
//                  = 6755399441058.511 kWh;阈值低 0.001 kWh = 6755399441058.510 kWh。
//  (m2 非运行 = [00,12) 的 1000 + [12:04,24:00) 区间落到 [18,24) 的
//    floor(2000*42960/42960)−floor(2000*21360/42960)=2000−994=1006,共 2006。)
// 运行窗内:12:00:00-12:00:30 m3 尚未生效(m1,m2 有效)=> 有效 30 秒;
//           12:00:30-12:01:00 m3 已生效但无读数区间 => 未知 30 秒(成员秒级切换);
//           12:02-12:04 m2 下降 => 异常 120 秒;其余运行时间 21420 秒有效。
//           合计运行窗 21600 秒:有效 21450、异常 120、未知 30。这些都不得阻止非运行判定。
// ---------------------------------------------------------------------------
const EXPECTED = {
  nrKwh: '6755399441058.511',
  nrKwhLow: '6755399441058.510',
  nrMilli: 6755399441058511n,
  nrSeconds: 64800,
  runningSeconds: 21600,
  runningValid: 21450,
  runningAnomaly: 120,
  runningUnknown: 30,
  nrPeriods: ['2026-01-05T00:00:00Z..2026-01-05T12:00:00Z', '2026-01-05T18:00:00Z..2026-01-06T00:00:00Z'],
  runningPeriod: '2026-01-05T12:00:00Z..2026-01-05T18:00:00Z',
};

// S2 独立场景(验证异常优先于未知、长间隔按原区间、多成员 gap 并集),UTC
// 2026-01-13(周二)全天非运行(空表),阈值 1,max-interval=1800,成员 {x,y}。
// 手工切分(以读数时刻为界):
//   [00:00,01:00) x,y 同处长原始区间 [前日23:00,01:00)(7200s>1800)=> 未知 3600;
//                  两成员 gap 并集只计一次 3600(不叠加成 7200)。
//   [01:00,02:00) x 处长区间 [01:00,02:30)(5400s>1800)未知;y 同段下降(2.000->1.000)
//                  => 下降优先,异常 3600,不计 gap。
//   [02:00,02:30) x 仍在同一长区间 => 未知 1800(并集),gap 计 1800;y 下降后有效。
//   [02:30,24:00) 两成员 30 分钟密采样(相邻 1800s == 限制,仍可信)=> 有效 77400。
//   合计:有效 77400、异常 3600、未知 5400(=3600+1800),gap 并集 5400,总和 86400。
//   gap 明细(去重,三条):x 与 y 的 [前日23:00,01:00),以及 x 的 [01:00,02:30);
//   均指向原始相邻读数时刻,不被日界或 02:00 时点裁短。
const S2 = {
  valid: 77400,
  anomaly: 3600,
  unknown: 5400,
  gapUnion: 5400,
  rawGap1: '2026-01-12T23:00:00Z..2026-01-13T01:00:00Z',
  rawGap2: '2026-01-13T01:00:00Z..2026-01-13T02:30:00Z',
};

const failures = [];
let passed = 0;
function check(scenario, cond, detail) {
  if (cond) passed++;
  else failures.push(`[${scenario}] ${detail ?? 'assertion failed'}`);
}

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), 'meterwatch-nr-test-'));
}

function run(dataDir, args, cwd = dataDir) {
  const res = spawnSync(process.execPath, [APP, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, METERWATCH_DATA_DIR: dataDir },
  });
  return { code: res.status, out: res.stdout ?? '', err: res.stderr ?? '', both: (res.stdout ?? '') + (res.stderr ?? '') };
}

function write(path, body) {
  writeFileSync(path, body, 'utf8');
}
function readJson(dataDir, name) {
  const p = join(dataDir, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
function storeSnapshot(dataDir) {
  const snap = {};
  for (const name of ['readings.json', 'alerts.json', 'groups.json']) {
    const p = join(dataDir, name);
    snap[name] = existsSync(p) ? { exists: true, raw: readFileSync(p, 'utf8') } : { exists: false, raw: null };
  }
  return snap;
}
function sameSnapshot(a, b) {
  for (const name of Object.keys(a)) {
    if (a[name].exists !== b[name].exists) return `${name} existence changed`;
    if (a[name].raw !== b[name].raw) return `${name} content changed`;
  }
  return null;
}
function countOccurrences(text, re) {
  return (text.match(re) ?? []).length;
}

// 主场景 S1 的固定读数 / 分组 / 时间表材料。
function writeS1Materials(dir) {
  write(join(dir, 'r.csv'), [
    'device,time,reading',
    // m1:周一全天一个大区间,差值超安全整数且不能被时长整除。
    'm1,2026-01-05T00:00:00Z,9007199254740.000',
    'm1,2026-01-06T00:00:00Z,18014398509482.001',
    // m2:周一全天,运行窗内 12:02 起下降(下降优先于未知)。
    'm2,2026-01-05T00:00:00Z,0.000',
    'm2,2026-01-05T12:00:00Z,1.000',
    'm2,2026-01-05T12:02:00Z,2.000',
    'm2,2026-01-05T12:04:00Z,0.500',
    'm2,2026-01-06T00:00:00Z,2.500',
    // m3:在运行窗内秒级加入(12:00:30),首条读数在 12:01:00 => 加入后前 30 秒未知。
    'm3,2026-01-05T12:01:00Z,0.000',
    'm3,2026-01-06T00:00:00Z,0.007',
    '',
  ].join('\n'));
  // 运行窗 12:00-18:00(周一)。
  write(join(dir, 'win.txt'), 'mon 12:00 18:00\n');
  // 等价拆分(并集相同):12:00-15:00 + 15:00-18:00,另加完全重叠的重复窗口。
  write(join(dir, 'win-split.txt'), 'mon 12:00 15:00\nmon 15:00 18:00\nmon 13:00 14:00\n');
  // 等价但不同顺序/重复排列。
  write(join(dir, 'win-reorder.txt'), 'mon 15:00 18:00\nmon 12:00 15:00\nmon 12:00 15:00\n');
}

function scenarioS1() {
  const S = 'S1 combined exact (big-int / non-divisible / second switch / window boundary)';
  const dir = makeDataDir();
  try {
    writeS1Materials(dir);
    let r = run(dir, ['import', 'r.csv']);
    check(S, r.code === 0, `import rc=${r.code} ${r.err}`);
    r = run(dir, ['group', 'configure', '--id', 'g1', '--at', '2026-01-01T00:00:00Z', '--device', 'm1', '--device', 'm2']);
    check(S, r.code === 0, `group v1 rc=${r.code} ${r.err}`);
    // 秒级成员切换:12:00:30 起 m3 加入(落在运行窗内,非运行部分成员不变)。
    r = run(dir, ['group', 'configure', '--id', 'g1', '--at', '2026-01-05T12:00:30Z', '--device', 'm1', '--device', 'm2', '--device', 'm3']);
    check(S, r.code === 0, `group v2 rc=${r.code} ${r.err}`);

    // 等价拆分重试:同 id、同并集窗口 => 不新增,即使文件不同/顺序不同。
    r = run(dir, ['rule', 'create', '--id', 'nr', '--group', 'g1', '--threshold', EXPECTED.nrKwh, '--schedule', 'win.txt']);
    check(S, r.code === 0, `rule create rc=${r.code} ${r.err}`);
    r = run(dir, ['rule', 'create', '--id', 'nr', '--group', 'g1', '--threshold', EXPECTED.nrKwh, '--schedule', 'win-split.txt']);
    check(S, r.code === 0 && /already exists with identical parameters/.test(r.out) && /unchanged/.test(r.out),
      `equivalent split retry should be unchanged: rc=${r.code} out=${JSON.stringify(r.out)}`);
    r = run(dir, ['rule', 'create', '--id', 'nr', '--group', 'g1', '--threshold', EXPECTED.nrKwh, '--schedule', 'win-reorder.txt']);
    check(S, r.code === 0 && /unchanged/.test(r.out), `reorder/dup retry should be unchanged: rc=${r.code} ${r.out}`);
    const alertsBefore = readJson(dir, 'alerts.json');
    check(S, alertsBefore.rules.length === 1, 'equivalent retries must not add a second rule');

    // 删除原时间表文件后,规则仍使用固定窗口。
    rmSync(join(dir, 'win.txt'));
    rmSync(join(dir, 'win-split.txt'));
    rmSync(join(dir, 'win-reorder.txt'));

    // 阈值 == 消耗:正常,不告警。
    r = run(dir, ['evaluate', '--rule', 'nr', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, r.code === 0, `evaluate equal rc=${r.code} ${r.err}`);
    check(S, r.out.includes(`consumption=${EXPECTED.nrKwh} kWh`),
      `equal: expected consumption ${EXPECTED.nrKwh}, got:\n${r.out}`);
    check(S, r.out.includes(`<= threshold=${EXPECTED.nrKwh} kWh`), 'equal threshold must compare <= (normal)');
    check(S, /NORMAL/.test(r.out) && /no alert/.test(r.out), 'equal must be NORMAL no alert');
    check(S, r.out.includes(`valid=${EXPECTED.nrSeconds}s anomaly=0s unknown=0s`),
      `non-running coverage must be ${EXPECTED.nrSeconds}s valid:\n${r.out}`);
    for (const p of EXPECTED.nrPeriods) check(S, r.out.includes(`period=${p}`), `missing non-running period ${p}`);
    check(S, !/EXCEEDED|alert-\d/.test(r.out), 'equal evaluation must not create an alert');
    check(S, readJson(dir, 'alerts.json').alerts.length === 0, 'no alert may be persisted on equal');

    // schedule-report 交叉核对覆盖(运行段异常/未知不阻止非运行判定):预期秒数手工给出。
    // 需要一个时间表文件(规则内固定窗已删,报表显式传文件)。
    write(join(dir, 'win2.txt'), 'mon 12:00 18:00\n');
    r = run(dir, ['group', 'schedule-report', '--id', 'g1', '--schedule', 'win2.txt',
      '--from', '2026-01-05T00:00:00Z', '--to', '2026-01-06T00:00:00Z']);
    check(S, r.code === 0, `schedule-report rc=${r.code} ${r.err}`);
    check(S, r.out.includes(`class=running`) && r.out.includes(`class=non-running`), 'report must show both classes');
    check(S, r.out.includes(`valid=${EXPECTED.runningValid}s  anomaly=${EXPECTED.runningAnomaly}s  unknown=${EXPECTED.runningUnknown}s`),
      `running class must carry valid ${EXPECTED.runningValid}s anomaly ${EXPECTED.runningAnomaly}s unknown ${EXPECTED.runningUnknown}s:\n${r.out}`);
    check(S, r.out.includes(`period=2026-01-05T12:00:00Z..2026-01-05T18:00:00Z`), 'missing running period');
    check(S, /class=non-running[^\n]*valid=64800s  anomaly=0s  unknown=0s/.test(r.out),
      `non-running class must be fully valid 64800s:\n${r.out}`);
    check(S, new RegExp(`class=non-running[^\\n]*consumption=${EXPECTED.nrKwh.replace('.', '\\.')} kWh`).test(r.out),
      `non-running class consumption must equal hand-derived value:\n${r.out}`);
    check(S, /running=21600s  non-running=64800s  total=86400s/.test(r.out), 'class seconds must sum to query length');

    // 阈值低 0.001 kWh:严格大于 => 触发新的未确认告警。
    r = run(dir, ['rule', 'create', '--id', 'nr-low', '--group', 'g1', '--threshold', EXPECTED.nrKwhLow, '--schedule', 'win2.txt']);
    check(S, r.code === 0, `create low rule rc=${r.code} ${r.err}`);
    r = run(dir, ['evaluate', '--rule', 'nr-low', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, r.code === 0, `evaluate low rc=${r.code} ${r.err}`);
    check(S, r.out.includes(`> threshold=${EXPECTED.nrKwhLow} kWh`), '0.001 lower must compare > (exceeded)');
    check(S, /EXCEEDED  alert alert-1 triggered \(unacknowledged\)/.test(r.out), `must trigger alert-1:\n${r.out}`);
    const persisted = readJson(dir, 'alerts.json');
    const a1 = persisted.alerts.find((a) => a.id === 'alert-1');
    check(S, !!a1 && a1.status === 'triggered' && a1.acknowledged === false, 'alert-1 persisted triggered/unack');
    check(S, BigInt(a1.events[0].consumptionMilli) === EXPECTED.nrMilli,
      `triggered event must record hand-derived non-running consumption, got ${a1?.events?.[0]?.consumptionMilli}`);
    rmSync(join(dir, 'win2.txt'));

    // alerts 历史显示同一固定窗口下的精确消耗与 UTC 时段(文件已删)。
    r = run(dir, ['alerts', '--rule', 'nr-low', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, r.code === 0 && r.out.includes(`consumption=${EXPECTED.nrKwh} kWh (EXCEEDED`),
      `alerts history must show exact current consumption:\n${r.out}`);
    for (const p of EXPECTED.nrPeriods) check(S, r.out.includes(`period=${p}`), `alerts history missing period ${p}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 纽约前拨(2026-03-08)与回拨(2026-11-01):跳过墙钟不补覆盖,重复小时按两段
// 实际时刻计入,每个日期只判定一次。
function scenarioDst() {
  const S = 'DST America/New_York spring-forward / fall-back non-running';
  const dir = makeDataDir();
  try {
    // 全天非运行(空时间表);两设备均匀读数覆盖整年,阈值故意设为不可达 => 全部 NORMAL。
    write(join(dir, 'r.csv'), [
      'device,time,reading',
      'd,2026-03-01T00:00:00Z,0.000',
      'd,2026-03-09T00:00:00Z,192.000', // 8 天
      'd,2026-10-31T00:00:00Z,192.000',
      'd,2026-11-02T00:00:00Z,192.000', // 回拨日有增长:区间 10-31..11-02
      'd,2026-11-02T06:00:00Z,192.000', // 覆盖回拨日终点(11-02T05:00)之后,零增长
      '',
    ].join('\n'));
    write(join(dir, 'empty.txt'), '# only a comment\n\n');
    let r = run(dir, ['import', 'r.csv']);
    check(S, r.code === 0, `import rc=${r.code} ${r.err}`);
    r = run(dir, ['group', 'configure', '--id', 'g', '--at', '2026-01-01T00:00:00Z', '--device', 'd']);
    check(S, r.code === 0, `group rc=${r.code} ${r.err}`);
    r = run(dir, ['rule', 'create', '--id', 'ny', '--group', 'g', '--threshold', '1000000', '--tz', 'America/New_York', '--schedule', 'empty.txt']);
    check(S, r.code === 0, `rule rc=${r.code} ${r.err}`);
    rmSync(join(dir, 'empty.txt'));

    // 前拨日 2026-03-08:当地 00:00(EST)=UTC 05:00;日末午夜按新偏移 EDT 计算 =
    // 2026-03-09T04:00。当日总长 82800 秒,跳过的当地 02:00-03:00 不虚构、不补未知。
    r = run(dir, ['evaluate', '--rule', 'ny', '--from', '2026-03-08', '--to', '2026-03-09']);
    check(S, r.code === 0, `spring evaluate rc=${r.code} ${r.err}`);
    check(S, /2026-03-08[^\n]*NORMAL/.test(r.out), `spring day must be decidable NORMAL:\n${r.out}`);
    check(S, r.out.includes('period=2026-03-08T05:00:00Z..2026-03-09T04:00:00Z'),
      `spring day must be one real UTC period of 82800s:\n${r.out}`);
    check(S, r.out.includes('valid=82800s anomaly=0s unknown=0s'),
      `skipped wall hour must not be added as coverage:\n${r.out}`);
    check(S, countOccurrences(r.out, /2026-03-08/g) >= 1 && countOccurrences(r.out, /NORMAL/g) === 1,
      'spring date judged exactly once');

    // 回拨日 2026-11-01:当地时长 90000 秒,UTC 04:00..2026-11-02T05:00;
    // 重复的 01:00 墙钟(EDT 与 EST 各一段)都按实际时刻计入,仍是一个日期一次判定。
    r = run(dir, ['evaluate', '--rule', 'ny', '--from', '2026-11-01', '--to', '2026-11-02']);
    check(S, r.code === 0, `fall evaluate rc=${r.code} ${r.err}`);
    check(S, r.out.includes('period=2026-11-01T04:00:00Z..2026-11-02T05:00:00Z'),
      `fall-back day must span real 90000s UTC period:\n${r.out}`);
    check(S, r.out.includes('valid=90000s anomaly=0s unknown=0s'),
      `repeated hour must be counted by both real instants (90000s):\n${r.out}`);
    check(S, countOccurrences(r.out, /\bNORMAL\b/g) === 1, 'fall-back date judged exactly once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// S2:异常优先于未知、长间隔按原区间判断、多成员 gap 在最终未知时段计并集;
// 非运行未知/异常不触发也不恢复。
function scenarioS2() {
  const S = 'S2 anomaly-over-unknown, long raw interval, multi-member gap union';
  const dir = makeDataDir();
  try {
    // 30 分钟密采样尾部(自 03:00 起每 1800s 一个,恰等于限制 => 可信,至次日00:00)。
    const dense = [];
    for (let total = 3 * 60; total <= 24 * 60; total += 30) {
      const h = Math.floor(total / 60);
      const mi = total % 60;
      if (h === 24) {
        dense.push(['x', '2026-01-14T00:00:00Z'], ['y', '2026-01-14T00:00:00Z']);
      } else {
        const ts = `2026-01-13T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00Z`;
        dense.push(['x', ts], ['y', ts]);
      }
    }
    const rows = ['device,time,reading',
      // 长原始区间 [前日23:00,01:00)(7200s>1800),两成员共有,覆盖 [00,01)。
      'x,2026-01-12T23:00:00Z,0.000',
      'x,2026-01-13T01:00:00Z,0.000',
      // x 的 [01:00,02:30) 长 5400s>1800(与 y 的下降重叠:验证按原区间判断与并集)。
      'x,2026-01-13T02:30:00Z,0.000',
      // y:[01:00,02:00) 下降(2.000->1.000);下降后继续。
      'y,2026-01-12T23:00:00Z,0.000',
      'y,2026-01-13T01:00:00Z,2.000',
      'y,2026-01-13T02:00:00Z,1.000',
      'y,2026-01-13T02:30:00Z,1.000'];
    for (const [dev, ts] of dense) rows.push(`${dev},${ts},1.500`);
    write(join(dir, 'r.csv'), rows.join('\n') + '\n');
    write(join(dir, 'empty.txt'), '# non-running all day\n');
    let r = run(dir, ['import', 'r.csv']);
    check(S, r.code === 0, `import rc=${r.code} ${r.err}`);
    r = run(dir, ['group', 'configure', '--id', 'g2', '--at', '2026-01-01T00:00:00Z', '--device', 'x', '--device', 'y']);
    check(S, r.code === 0, `group rc=${r.code} ${r.err}`);
    r = run(dir, ['rule', 'create', '--id', 'nr2', '--group', 'g2', '--threshold', '1', '--max-interval', '1800', '--schedule', 'empty.txt']);
    check(S, r.code === 0, `rule rc=${r.code} ${r.err}`);
    rmSync(join(dir, 'empty.txt'));

    r = run(dir, ['evaluate', '--rule', 'nr2', '--from', '2026-01-13', '--to', '2026-01-14']);
    check(S, r.code === 0, `evaluate rc=${r.code} ${r.err}`);
    check(S, /2026-01-13[^\n]*undecidable/.test(r.out), `mixed day must be undecidable:\n${r.out}`);
    check(S, new RegExp(`valid=${S2.valid}s anomaly=${S2.anomaly}s unknown=${S2.unknown}s gap=${S2.gapUnion}s`).test(r.out),
      `expect valid=${S2.valid} anomaly=${S2.anomaly} unknown=${S2.unknown} gap union=${S2.gapUnion}:\n${r.out}`);
    check(S, /no alert action/.test(r.out), 'non-running unknown/anomaly must not trigger or recover');
    // 多成员 gap 并集不叠加:同一 [23:00,01:00) 两成员只计一次 3600(union 已并入 5400)。
    check(S, countOccurrences(r.out, /gap: device=x/g) === 2, `x gap details listed for its two raw intervals:\n${r.out}`);
    check(S, countOccurrences(r.out, /gap: device=y/g) === 1, `y gap detail listed once:\n${r.out}`);
    // gap 明细指向原始相邻读数时刻,不被日界或 02:00 时点裁短。
    check(S, r.out.includes(S2.rawGap1), `gap must reference raw interval ${S2.rawGap1}:\n${r.out}`);
    check(S, r.out.includes(S2.rawGap2), `x gap must span the un-clipped raw interval ${S2.rawGap2}:\n${r.out}`);
    check(S, readJson(dir, 'alerts.json').alerts.length === 0, 'undecidable day must not persist an alert');

    // 同一日重复评估:仍不可判定,不写入任何状态/编号。
    const before = readJson(dir, 'alerts.json');
    r = run(dir, ['evaluate', '--rule', 'nr2', '--from', '2026-01-13', '--to', '2026-01-14']);
    const after = readJson(dir, 'alerts.json');
    check(S, JSON.stringify(before) === JSON.stringify(after), 'repeat undecidable evaluation writes nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 无有效覆盖:evaluate 与 alerts 必须明确显示“消耗无法计算”;有效零增长显示 0.000;
// 没有非运行秒数说明原因且不告警。
function scenarioNoCoverage() {
  const S = 'no valid coverage -> consumption n/a; zero growth -> 0.000; no non-running seconds';
  const dir = makeDataDir();
  try {
    write(join(dir, 'r.csv'), ['device,time,reading',
      'p,2026-01-05T03:00:00Z,0.000', // 孤立读数 => 周一全天未知(独立成员)
      'q,2026-01-06T00:00:00Z,5.000', // 周二单成员全天,零增长
      'q,2026-01-07T00:00:00Z,5.000',
      '',
    ].join('\n'));
    write(join(dir, 'empty.txt'), '\n');
    write(join(dir, 'full.txt'), 'mon 00:00 24:00\ntue 00:00 24:00\n');
    let r = run(dir, ['import', 'r.csv']);
    check(S, r.code === 0, `import rc=${r.code} ${r.err}`);
    // g={p}:周一孤立读数,用于“无有效覆盖”;gz={q}:周二有效零增长。
    r = run(dir, ['group', 'configure', '--id', 'g', '--at', '2026-01-01T00:00:00Z', '--device', 'p']);
    check(S, r.code === 0, `group g rc=${r.code} ${r.err}`);
    r = run(dir, ['group', 'configure', '--id', 'gz', '--at', '2026-01-01T00:00:00Z', '--device', 'q']);
    check(S, r.code === 0, `group gz rc=${r.code} ${r.err}`);
    r = run(dir, ['rule', 'create', '--id', 'nr', '--group', 'g', '--threshold', '1', '--schedule', 'empty.txt']);
    check(S, r.code === 0, `rule nr rc=${r.code} ${r.err}`);
    r = run(dir, ['rule', 'create', '--id', 'nrz', '--group', 'gz', '--threshold', '1', '--schedule', 'empty.txt']);
    check(S, r.code === 0, `rule nrz rc=${r.code} ${r.err}`);

    // 周一:孤立读数 => 非运行全天未知,消耗必须明确“无法计算”。
    r = run(dir, ['evaluate', '--rule', 'nr', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, r.code === 0, `evaluate nr rc=${r.code} ${r.err}`);
    const monLine = r.out.split('\n').find((l) => l.includes('2026-01-05'));
    check(S, !!monLine && /undecidable/.test(monLine) && /consumption=n\/a \(no valid coverage\)/.test(monLine),
      `evaluate must explicitly state consumption cannot be computed:\n${r.out}`);
    // 周二:单成员有效零增长 => 0.000 且 NORMAL。
    r = run(dir, ['evaluate', '--rule', 'nrz', '--from', '2026-01-06', '--to', '2026-01-07']);
    check(S, r.code === 0, `evaluate nrz rc=${r.code} ${r.err}`);
    const tueLine = r.out.split('\n').find((l) => l.includes('2026-01-06'));
    check(S, !!tueLine && /consumption=0\.000 kWh/.test(tueLine) && /NORMAL/.test(tueLine),
      `valid zero growth must show 0.000 and be normal:\n${r.out}`);

    // alerts 历史同样明确无法计算 / 显示 0.000。
    r = run(dir, ['alerts', '--rule', 'nr', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, /2026-01-05[^\n]*consumption=n\/a \(no valid coverage\)/.test(r.out),
      `alerts must explicitly state consumption n/a:\n${r.out}`);
    r = run(dir, ['alerts', '--rule', 'nrz', '--from', '2026-01-06', '--to', '2026-01-07']);
    check(S, /2026-01-06[^\n]*consumption=0\.000 kWh/.test(r.out),
      `alerts must show 0.000 on zero growth:\n${r.out}`);
    check(S, readJson(dir, 'alerts.json').alerts.length === 0, 'no alert for n/a or zero days');

    // 没有非运行秒数:运行窗覆盖全天 => 说明原因,不判定不告警。
    r = run(dir, ['rule', 'create', '--id', 'full', '--group', 'gz', '--threshold', '1', '--schedule', 'full.txt']);
    check(S, r.code === 0, `full rule rc=${r.code} ${r.err}`);
    r = run(dir, ['evaluate', '--rule', 'full', '--from', '2026-01-05', '--to', '2026-01-07']);
    check(S, r.code === 0 && countOccurrences(r.out, /NO NON-RUNNING COVERAGE/g) === 2 && /no alert action/.test(r.out),
      `both all-running days must explain why and take no action:\n${r.out}`);
    r = run(dir, ['alerts', '--rule', 'full', '--from', '2026-01-05', '--to', '2026-01-07']);
    check(S, countOccurrences(r.out, /NO NON-RUNNING COVERAGE/g) === 2,
      `alerts must explain no non-running coverage for both days:\n${r.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 非法星期(constructor / __proto__ / 任意名字)必须返回 2,不创建规则、不改业务文件。
function scenarioBadWeekday() {
  const S = 'illegal weekday (constructor/__proto__) rejected with rc 2';
  const dir = makeDataDir();
  try {
    write(join(dir, 'r.csv'), 'device,time,reading\nz,2026-01-05T00:00:00Z,0.000\nz,2026-01-06T00:00:00Z,1.000\n');
    let r = run(dir, ['import', 'r.csv']);
    check(S, r.code === 0, `import rc=${r.code} ${r.err}`);
    r = run(dir, ['group', 'configure', '--id', 'g', '--at', '2026-01-01T00:00:00Z', '--device', 'z']);
    check(S, r.code === 0, `group rc=${r.code} ${r.err}`);

    const before = storeSnapshot(dir);
    for (const bad of ['constructor', '__proto__', 'toString', 'xyz']) {
      write(join(dir, 'bad.txt'), `${bad} 08:00 18:00\n`);
      r = run(dir, ['rule', 'create', '--id', `bad-${bad}`, '--group', 'g', '--threshold', '1', '--schedule', 'bad.txt']);
      check(S, r.code === 2, `weekday '${bad}' must be rc=2, got ${r.code} (${r.both.trim()})`);
      check(S, /invalid schedule|unknown weekday/.test(r.err), `weekday '${bad}' must report invalid schedule`);
      const diff = sameSnapshot(before, storeSnapshot(dir));
      check(S, diff === null, `rejected '${bad}' must not change business files (${diff})`);
    }
    r = run(dir, ['rule', 'list']);
    check(S, r.code === 0 && /no rules defined/.test(r.out), 'no rule may be created from illegal weekdays');
    check(S, !/constructor|__proto__/.test(readJson(dir, 'groups.json') ? JSON.stringify(readJson(dir, 'groups.json')) : ''),
      'groups store must not be polluted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 生命周期:超限→重复评估→重复确认→修正后查询→正常重评→撤销→再次超限。
// 数据操作/查询不自动更新检测状态;旧事件消耗与确认保留;新告警未确认;
// 跨进程重放修正/撤销不再次改值或增历史。
function scenarioLifecycle() {
  const S = 'lifecycle trigger/dup/ack/correct/reeval/undo/re-trigger with replay idempotence';
  const dir = makeDataDir();
  try {
    // 单设备分组,空表全天非运行;周一 NR 消耗 2.000,阈值 1。
    write(join(dir, 'r.csv'), ['device,time,reading',
      'm,2026-01-05T00:00:00Z,0.000',
      'm,2026-01-06T00:00:00Z,2.000',
      'm,2026-01-07T00:00:00Z,4.000',
      '',
    ].join('\n'));
    write(join(dir, 'empty.txt'), '\n');
    let r = run(dir, ['import', 'r.csv']);
    check(S, r.code === 0, `import rc=${r.code} ${r.err}`);
    r = run(dir, ['group', 'configure', '--id', 'g', '--at', '2026-01-01T00:00:00Z', '--device', 'm']);
    check(S, r.code === 0, `group rc=${r.code} ${r.err}`);
    r = run(dir, ['rule', 'create', '--id', 'nr', '--group', 'g', '--threshold', '1', '--schedule', 'empty.txt']);
    check(S, r.code === 0, `rule rc=${r.code} ${r.err}`);

    // 1) 超限:alert-1,事件 seq1=triggered 消耗 2.000。
    r = run(dir, ['evaluate', '--rule', 'nr', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, /alert alert-1 triggered \(unacknowledged\)/.test(r.out), `first exceed triggers alert-1:\n${r.out}`);
    let state = readJson(dir, 'alerts.json');
    check(S, state.alerts.length === 1 && state.alerts[0].events.length === 1 &&
      state.alerts[0].events[0].consumptionMilli === '2000', 'trigger event records 2.000');

    // 2) 重复评估(仍超限):保留原标识,不新增事件。
    r = run(dir, ['evaluate', '--rule', 'nr', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, /alert alert-1 remains triggered/.test(r.out), `repeat exceed keeps same id:\n${r.out}`);
    state = readJson(dir, 'alerts.json');
    check(S, state.alerts.length === 1 && state.alerts[0].events.length === 1, 'repeat evaluate adds no event');

    // 3) 重复确认:只记一次 acknowledged 事件。
    r = run(dir, ['ack', 'alert-1']);
    check(S, r.code === 0 && /acknowledged/.test(r.out), `first ack rc=${r.code}`);
    r = run(dir, ['ack', 'alert-1']);
    check(S, r.code === 0 && /already acknowledged; unchanged/.test(r.out), 'duplicate ack unchanged');
    state = readJson(dir, 'alerts.json');
    check(S, state.alerts[0].acknowledged === true &&
      state.alerts[0].events.filter((e) => e.type === 'acknowledged').length === 1, 'exactly one ack event');

    // 4) 修正(跨进程)把周一终点读数 2.000 -> 0.500,使周一 NR=0.500(正常)。
    r = run(dir, ['correct', '--request', 'REQ-A',
      '--item', '--device', 'm', '--at', '2026-01-06T00:00:00Z', '--expect', '2.000', '--set', '0.500']);
    check(S, r.code === 0 && /1 reading\(s\) changed/.test(r.out), `correct rc=${r.code} ${r.err}`);
    // 跨进程重放同一修正:不再次改值、不增历史。
    r = run(dir, ['correct', '--request', 'REQ-A',
      '--item', '--device', 'm', '--at', '2026-01-06T00:00:00Z', '--expect', '2.000', '--set', '0.500']);
    check(S, r.code === 0, `replay correct rc=${r.code}`);
    let data = readJson(dir, 'readings.json');
    check(S, data.corrections.length === 1, 'replay correct adds no history');
    check(S, data.readings.find((x) => x.device === 'm' && x.ts === Date.parse('2026-01-06T00:00:00Z') / 1000).milli === '500',
      'replay does not change value again');

    // 5) 修正后“查询”当前消耗立即变为 0.500,但检测状态不变(仍 triggered/已确认)。
    r = run(dir, ['alerts', '--rule', 'nr', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, /2026-01-05[^\n]*consumption=0\.500 kWh \(NORMAL/.test(r.out),
      `query recomputes current consumption after correct:\n${r.out}`);
    state = readJson(dir, 'alerts.json');
    const a1 = state.alerts[0];
    check(S, a1.status === 'triggered' && a1.acknowledged === true,
      'query/data op must not auto-update detection status');
    check(S, a1.events[0].consumptionMilli === '2000', 'old triggered consumption must be preserved');

    // 6) 显式正常重评 => 恢复(recovered),记录恢复时消耗 0.500;确认保留。
    r = run(dir, ['evaluate', '--rule', 'nr', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, /alert alert-1 recovered/.test(r.out), `normal re-eval recovers alert-1:\n${r.out}`);
    state = readJson(dir, 'alerts.json');
    const rec = state.alerts[0].events.find((e) => e.type === 'recovered');
    check(S, !!rec && rec.consumptionMilli === '500', 'recovery event records 0.500');
    check(S, state.alerts[0].acknowledged === true, 'ack survives recovery');

    // 7) 撤销修正(跨进程)恢复读数为 2.000;重放撤销不再次改值/增历史。
    r = run(dir, ['undo', '--request', 'UNDO-A', '--target', 'REQ-A']);
    check(S, r.code === 0 && /1 reading\(s\) restored/.test(r.out), `undo rc=${r.code} ${r.err}`);
    r = run(dir, ['undo', '--request', 'UNDO-A', '--target', 'REQ-A']);
    check(S, r.code === 0, `replay undo rc=${r.code}`);
    data = readJson(dir, 'readings.json');
    check(S, data.undos.length === 1, 'replay undo adds no history');
    check(S, data.readings.find((x) => x.device === 'm' && x.ts === Date.parse('2026-01-06T00:00:00Z') / 1000).milli === '2000',
      'undo restores 2.000; replay does not re-change');
    // 已撤销修正再“重放”仍返回原成功结果,不重新应用(值保持 2.000)。
    r = run(dir, ['correct', '--request', 'REQ-A',
      '--item', '--device', 'm', '--at', '2026-01-06T00:00:00Z', '--expect', '2.000', '--set', '0.500']);
    check(S, r.code === 0, `replay of undone correction still rc=0`);
    check(S, readJson(dir, 'readings.json').readings.find(
      (x) => x.device === 'm' && x.ts === Date.parse('2026-01-06T00:00:00Z') / 1000).milli === '2000',
      'replay of undone correction must not re-apply');

    // 撤销是数据操作,不自动改检测状态:仍 recovered。
    state = readJson(dir, 'alerts.json');
    check(S, state.alerts[0].status === 'recovered', 'undo must not auto-change detection status');

    // 8) 显式重评再次超限 => 创建“新的未确认”告警 alert-2;旧记录与确认保留。
    r = run(dir, ['evaluate', '--rule', 'nr', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, /alert alert-2 triggered \(unacknowledged\)/.test(r.out), `re-exceed creates new alert-2:\n${r.out}`);
    state = readJson(dir, 'alerts.json');
    check(S, state.alerts.length === 2, 'old and new alerts both retained');
    const old = state.alerts.find((a) => a.id === 'alert-1');
    const neu = state.alerts.find((a) => a.id === 'alert-2');
    check(S, old.status === 'recovered' && old.acknowledged === true, 'old alert stays recovered+acked');
    check(S, neu.status === 'triggered' && neu.acknowledged === false && neu.events.length === 1,
      'new alert is triggered/unacknowledged with its own event');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 批量日期评估写入失败 => 返回 1、无部分成功输出、三个业务存储内容与存在状态不变;
// 解除故障后重试成功,告警与事件编号不冲突。
function scenarioWriteFailure() {
  const S = 'batch evaluate write failure atomicity + id/seq non-collision on retry';
  const dir = makeDataDir();
  try {
    // 两个可判定且超限的日期(周一、周二),空表全天非运行,阈值 1。
    write(join(dir, 'r.csv'), ['device,time,reading',
      'm,2026-01-05T00:00:00Z,0.000',
      'm,2026-01-06T00:00:00Z,2.000', // 周一 +2.000
      'm,2026-01-07T00:00:00Z,4.000', // 周二 +2.000
      '',
    ].join('\n'));
    write(join(dir, 'empty.txt'), '\n');
    let r = run(dir, ['import', 'r.csv']);
    check(S, r.code === 0, `import rc=${r.code} ${r.err}`);
    r = run(dir, ['group', 'configure', '--id', 'g', '--at', '2026-01-01T00:00:00Z', '--device', 'm']);
    check(S, r.code === 0, `group rc=${r.code} ${r.err}`);
    r = run(dir, ['rule', 'create', '--id', 'nr', '--group', 'g', '--threshold', '1', '--schedule', 'empty.txt']);
    check(S, r.code === 0, `rule rc=${r.code} ${r.err}`);

    const before = storeSnapshot(dir);
    const alertsPath = join(dir, 'alerts.json');
    // 可控本地故障:把目标业务存储置为不可更改(chflags uchg),使临时文件 rename 失败。
    execFileSync('chflags', ['uchg', alertsPath]);
    try {
      r = run(dir, ['evaluate', '--rule', 'nr', '--from', '2026-01-05', '--to', '2026-01-07']);
      check(S, r.code === 1, `failed batch evaluate must be rc=1, got ${r.code}`);
      check(S, !/EXCEEDED|alert-\d|recovered/i.test(r.out), `failed evaluate must print no partial success:\n${r.out}`);
      check(S, /cannot write storage file/.test(r.err), `must report write failure: ${r.err}`);
    } finally {
      execFileSync('chflags', ['nouchg', alertsPath]);
    }
    const diff = sameSnapshot(before, storeSnapshot(dir));
    check(S, diff === null, `all three business stores must be unchanged on failure (${diff})`);
    // 失败不得占用任何编号:重试成功 => 周一新建 alert-1(不是 alert-3),周二 alert-2。
    r = run(dir, ['evaluate', '--rule', 'nr', '--from', '2026-01-05', '--to', '2026-01-07']);
    check(S, r.code === 0, `retry after fault cleared rc=${r.code} ${r.err}`);
    check(S, /2026-01-05[^\n]*alert alert-1 triggered/.test(r.out) &&
      /2026-01-06[^\n]*alert alert-2 triggered/.test(r.out),
      `retry must mint alert-1 and alert-2 without collision:\n${r.out}`);
    let state = readJson(dir, 'alerts.json');
    const seqs = state.alerts.flatMap((a) => a.events.map((e) => e.seq));
    check(S, state.alerts.length === 2 && new Set(seqs).size === 2 && seqs.join(',') === '1,2',
      `event seqs must be unique 1,2 got ${seqs.join(',')}`);
    check(S, state.alerts.every((a) => a.acknowledged === false), 'retry alerts are unacknowledged');

    // 再来一个超限日期,确认编号继续不冲突(alert-3 / seq3)。
    write(join(dir, 'r2.csv'), 'device,time,reading\nm,2026-01-08T00:00:00Z,6.001\n');
    r = run(dir, ['import', 'r2.csv']);
    check(S, r.code === 0, `import wed rc=${r.code} ${r.err}`);
    r = run(dir, ['evaluate', '--rule', 'nr', '--from', '2026-01-07', '--to', '2026-01-08']);
    check(S, /alert alert-3 triggered \(unacknowledged\)/.test(r.out), `third exceed mints alert-3:\n${r.out}`);
    state = readJson(dir, 'alerts.json');
    check(S, state.nextAlertNum === 4 && state.nextEventSeq === 4, 'counters continue without collision');
  } finally {
    // 确保故障标志一定解除,再清理临时目录。
    try { execFileSync('chflags', ['nouchg', join(dir, 'alerts.json')]); } catch { /* may not exist */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

// 同一规则、同一日期:非运行先超限(打开告警),随后数据使非运行变为异常/未知,
// 再次评估必须“不恢复”也不新增事件;恢复只发生在之后重新完整评估正常时。
function scenarioNoRecoverOnUndecidable() {
  const S = 'undecidable non-running neither triggers nor recovers an open alert (same rule/date)';
  const dir = makeDataDir();
  try {
    // 窗口 mon 12:00-18:00。初始非运行两段都有效:[00,12)+2.000、[18,24)+2.000 = 4.000。
    write(join(dir, 'r.csv'), ['device,time,reading',
      'm,2026-01-05T00:00:00Z,0.000',
      'm,2026-01-05T12:00:00Z,2.000',
      'm,2026-01-05T18:00:00Z,2.000',
      'm,2026-01-06T00:00:00Z,4.000',
      '',
    ].join('\n'));
    write(join(dir, 'win.txt'), 'mon 12:00 18:00\n');
    let r = run(dir, ['import', 'r.csv']);
    check(S, r.code === 0, `import rc=${r.code} ${r.err}`);
    r = run(dir, ['group', 'configure', '--id', 'g', '--at', '2026-01-01T00:00:00Z', '--device', 'm']);
    check(S, r.code === 0, `group rc=${r.code} ${r.err}`);
    r = run(dir, ['rule', 'create', '--id', 'nr', '--group', 'g', '--threshold', '3', '--schedule', 'win.txt']);
    check(S, r.code === 0, `rule rc=${r.code} ${r.err}`);

    // 4.000 > 3 => 打开 alert-1。
    r = run(dir, ['evaluate', '--rule', 'nr', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, /alert alert-1 triggered \(unacknowledged\)/.test(r.out), `initial exceed opens alert-1:\n${r.out}`);

    // 把周二00:00 读数 4.000 改成 1.000:[周一18:00,周二00:00) 变为下降(2.000->1.000),
    // 非运行 [18,24) 出现异常 => 当日非运行不可判定。
    r = run(dir, ['correct', '--request', 'REQ-DROP',
      '--item', '--device', 'm', '--at', '2026-01-06T00:00:00Z', '--expect', '4.000', '--set', '1.000']);
    check(S, r.code === 0, `correction to induce decline rc=${r.code} ${r.err}`);

    // 再次评估同一日期:不可判定,打开的 alert-1 必须保持 triggered、不新增恢复事件。
    r = run(dir, ['evaluate', '--rule', 'nr', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, /undecidable/.test(r.out) && /no alert action/.test(r.out),
      `undecidable non-running must take no action:\n${r.out}`);
    let state = readJson(dir, 'alerts.json');
    let a1 = state.alerts.find((a) => a.id === 'alert-1');
    check(S, !!a1 && a1.status === 'triggered' && a1.events.length === 1 &&
      a1.events[0].type === 'triggered',
      'open alert must not recover and must gain no event on undecidable re-eval');

    // alerts 历史:当前不可判定,但告警状态仍为 TRIGGERED,触发时消耗 4.000 保留。
    r = run(dir, ['alerts', '--rule', 'nr', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, /2026-01-05[^\n]*undecidable/.test(r.out), `alerts shows undecidable current state:\n${r.out}`);
    check(S, /alert alert-1  status=TRIGGERED/.test(r.out), `alert stays TRIGGERED in history:\n${r.out}`);
    check(S, /#1 triggered \(consumption=4\.000 kWh\)/.test(r.out), `trigger consumption 4.000 preserved:\n${r.out}`);

    // 撤销修正,读数恢复 4.000;数据操作本身仍不自动恢复。
    r = run(dir, ['undo', '--request', 'UNDO-DROP', '--target', 'REQ-DROP']);
    check(S, r.code === 0, `undo rc=${r.code} ${r.err}`);
    state = readJson(dir, 'alerts.json');
    a1 = state.alerts.find((a) => a.id === 'alert-1');
    check(S, a1.status === 'triggered', 'undo (data op) must not auto-recover');

    // 显式重新完整评估且仍超限(4.000>3)=> 保留原告警,不新增。
    r = run(dir, ['evaluate', '--rule', 'nr', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, /alert alert-1 remains triggered/.test(r.out), `re-exceeded after undo keeps alert-1:\n${r.out}`);

    // 正面对照:把读数改为有效且非运行消耗恰等于阈值(3.000):将周二00:00 设为 3.000,
    // [18,24) 从下降后的当前值需要再修正。先撤销已不存在——直接对 4.000 再做一次修正。
    r = run(dir, ['correct', '--request', 'REQ-NORM',
      '--item', '--device', 'm', '--at', '2026-01-06T00:00:00Z', '--expect', '4.000', '--set', '3.000']);
    check(S, r.code === 0, `correction to normal value rc=${r.code} ${r.err}`);
    // 数据操作仍不自动恢复。
    state = readJson(dir, 'alerts.json');
    check(S, state.alerts[0].status === 'triggered', 'second correction also must not auto-recover');
    // 显式完整评估且正常(NR=2.000+1.000=3.000 == 阈值)=> 此刻才恢复,记录恢复消耗 3.000。
    r = run(dir, ['evaluate', '--rule', 'nr', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, /alert alert-1 recovered/.test(r.out), `complete normal re-eval must recover:\n${r.out}`);
    state = readJson(dir, 'alerts.json');
    a1 = state.alerts.find((a) => a.id === 'alert-1');
    const rec = a1.events.find((e) => e.type === 'recovered');
    check(S, a1.status === 'recovered' && !!rec && rec.consumptionMilli === '3000' && a1.events.length === 2,
      'recovery recorded at 3.000 only after complete normal evaluation');
    rmSync(join(dir, 'win.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// E1:日期例外语义(UTC)——off 替换当天全部运行集合(含上一日每周跨夜尾段)、
// 临时运行窗口、例外仅作用当天(次日的每周跨夜尾段仍生效)、等价重试与异参冲突。
// 读数速率恒为 1 毫千瓦时/秒(864000 秒 / 864.000 kWh),消耗 = 秒数/1000 kWh。
// 每周表:sun 22:00-02:00(跨至周一)、mon 12:00-18:00、mon 23:00-01:00(跨至周二)。
// 例外:2026-01-05(周一)off、2026-01-06(周二)09:00-11:00、2026-01-12(周一)off。
//   周日 2026-01-04:运行 22:00-24:00(7200s)=> NR 79200s = 79.200 kWh。
//   周一 2026-01-05 off:全天非运行 86400s = 86.400 kWh(周日跨夜尾段 00:00-02:00
//     与 mon 12:00-18:00、mon 23:00-01:00 均被替换)。
//   周二 2026-01-06 例外 09:00-11:00:运行 7200s => NR 79200s = 79.200 kWh
//     (周一 mon 23:00-01:00 的尾段 00:00-01:00 被周二例外替换)。
//   周一 2026-01-12 off:NR 86400s = 86.400 kWh。
//   周二 2026-01-13 无例外:仍用每周表,mon 23:00-01:00 尾段 00:00-01:00 运行
//     (周一的 off 仅作用当天)=> NR 82800s = 82.800 kWh。
// 阈值 83.000:01-05、01-12 超限(alert-1、alert-2),其余正常。
function scenarioExceptions() {
  const S = 'E1 date exceptions replace weekly set / same-day-only / retry equality';
  const dir = makeDataDir();
  try {
    write(join(dir, 'r.csv'), ['device,time,reading',
      'm,2026-01-04T00:00:00Z,0.000',
      'm,2026-01-14T00:00:00Z,864.000',
      '',
    ].join('\n'));
    const weekly = 'sun 22:00 02:00\nmon 12:00 18:00\nmon 23:00 01:00\n';
    write(join(dir, 'exc.txt'), weekly +
      '2026-01-05 off\n2026-01-06 09:00 11:00\n2026-01-12 off\n');
    // 等价:顺序不同、例外窗口等价拆分、每周窗口重复。
    write(join(dir, 'exc-equiv.txt'),
      '2026-01-12 off\nmon 23:00 01:00\n2026-01-06 09:00 10:00\n2026-01-06 10:00 11:00\n' +
      'mon 12:00 18:00\nsun 22:00 02:00\nsun 22:00 02:00\n2026-01-05 off\n');
    // 异参:周二改全天停运 / 少一个例外 / 多一个例外。
    write(join(dir, 'exc-off.txt'), weekly +
      '2026-01-05 off\n2026-01-06 off\n2026-01-12 off\n');
    write(join(dir, 'exc-missing.txt'), weekly + '2026-01-05 off\n2026-01-06 09:00 11:00\n');
    write(join(dir, 'exc-extra.txt'), weekly +
      '2026-01-05 off\n2026-01-06 09:00 11:00\n2026-01-12 off\n2026-02-01 off\n');

    let r = run(dir, ['import', 'r.csv']);
    check(S, r.code === 0, `import rc=${r.code} ${r.err}`);
    r = run(dir, ['group', 'configure', '--id', 'g', '--at', '2026-01-01T00:00:00Z', '--device', 'm']);
    check(S, r.code === 0, `group rc=${r.code} ${r.err}`);
    r = run(dir, ['rule', 'create', '--id', 'exc', '--group', 'g', '--threshold', '83', '--schedule', 'exc.txt']);
    check(S, r.code === 0, `rule create rc=${r.code} ${r.err}`);

    // 等价重试(顺序/拆分/重复不同):unchanged,不新增。
    r = run(dir, ['rule', 'create', '--id', 'exc', '--group', 'g', '--threshold', '83', '--schedule', 'exc-equiv.txt']);
    check(S, r.code === 0 && /already exists with identical parameters/.test(r.out) && /unchanged/.test(r.out),
      `equivalent exception retry must be unchanged: rc=${r.code} out=${JSON.stringify(r.out)}`);
    // 异参冲突:明确停运与窗口不同、例外日期映射不同,均 rc=1 且不改状态。
    for (const f of ['exc-off.txt', 'exc-missing.txt', 'exc-extra.txt']) {
      r = run(dir, ['rule', 'create', '--id', 'exc', '--group', 'g', '--threshold', '83', '--schedule', f]);
      check(S, r.code === 1 && /conflict/.test(r.err), `${f} must conflict: rc=${r.code} ${r.err}`);
    }
    check(S, readJson(dir, 'alerts.json').rules.length === 1, 'conflicts must not add rules');

    // rule list 显示例外日期及窗口或全天停运。
    r = run(dir, ['rule', 'list']);
    check(S, r.code === 0 &&
      r.out.includes('exceptions: 2026-01-05 off, 2026-01-06 09:00-11:00, 2026-01-12 off'),
      `rule list must show exception dates with windows or off:\n${r.out}`);

    // 报表(删除源文件前):运行仅周二 09:00-11:00(7200s),非运行 165600s。
    write(join(dir, 'rep.txt'), weekly + '2026-01-05 off\n2026-01-06 09:00 11:00\n2026-01-12 off\n');
    r = run(dir, ['group', 'schedule-report', '--id', 'g', '--schedule', 'rep.txt',
      '--from', '2026-01-05T00:00:00Z', '--to', '2026-01-07T00:00:00Z']);
    check(S, r.code === 0, `schedule-report rc=${r.code} ${r.err}`);
    check(S, r.out.includes('(3 weekly window(s), 3 exception(s))'),
      `report header must count weekly windows and exceptions:\n${r.out}`);
    check(S, /class=running  consumption=7\.200 kWh \(estimate\)  valid=7200s  anomaly=0s  unknown=0s/.test(r.out),
      `running class must be the Tuesday exception window only:\n${r.out}`);
    check(S, r.out.includes('period=2026-01-06T09:00:00Z..2026-01-06T11:00:00Z'), 'missing running period');
    check(S, /class=non-running  consumption=165\.600 kWh \(estimate\)  valid=165600s  anomaly=0s  unknown=0s/.test(r.out),
      `non-running class must cover the rest:\n${r.out}`);
    check(S, /running=7200s  non-running=165600s  total=172800s/.test(r.out), 'class seconds must sum to query length');
    rmSync(join(dir, 'rep.txt'));

    // 源文件删除后规则仍用固定时间表与例外。
    for (const f of ['exc.txt', 'exc-equiv.txt', 'exc-off.txt', 'exc-missing.txt', 'exc-extra.txt']) {
      rmSync(join(dir, f));
    }

    // 评估 01-04..01-07:周日正常(79.200)、周一 off 超限(alert-1)、周二例外正常(79.200)。
    r = run(dir, ['evaluate', '--rule', 'exc', '--from', '2026-01-04', '--to', '2026-01-07']);
    check(S, r.code === 0, `evaluate w1 rc=${r.code} ${r.err}`);
    check(S, /2026-01-04[^\n]*consumption=79\.200 kWh <= threshold=83\.000 kWh  NORMAL  no alert  valid=79200s anomaly=0s unknown=0s/.test(r.out),
      `Sunday must use weekly table (NR 79200s):\n${r.out}`);
    check(S, /2026-01-05[^\n]*consumption=86\.400 kWh > threshold=83\.000 kWh  EXCEEDED  alert alert-1 triggered \(unacknowledged\)  valid=86400s anomaly=0s unknown=0s/.test(r.out),
      `Monday off must be all non-running and exceed:\n${r.out}`);
    check(S, r.out.includes('period=2026-01-05T00:00:00Z..2026-01-06T00:00:00Z'),
      `Monday off must replace the Sunday overnight tail:\n${r.out}`);
    check(S, r.out.includes('exception=2026-01-05 off (replaces weekly schedule for this date)'),
      `evaluate must show the exception used:\n${r.out}`);
    check(S, /2026-01-06[^\n]*consumption=79\.200 kWh <= threshold=83\.000 kWh  NORMAL  no alert  valid=79200s anomaly=0s unknown=0s/.test(r.out),
      `Tuesday exception windows must replace weekly set (incl. Monday tail):\n${r.out}`);
    check(S, r.out.includes('period=2026-01-06T00:00:00Z..2026-01-06T09:00:00Z') &&
      r.out.includes('period=2026-01-06T11:00:00Z..2026-01-07T00:00:00Z'),
      `Tuesday non-running periods:\n${r.out}`);
    check(S, r.out.includes('exception=2026-01-06 09:00-11:00 (replaces weekly schedule for this date)'),
      `evaluate must show the Tuesday exception:\n${r.out}`);

    // 评估 01-12..01-14:周一 off 超限(alert-2);周二无例外,每周跨夜尾段仍运行。
    r = run(dir, ['evaluate', '--rule', 'exc', '--from', '2026-01-12', '--to', '2026-01-14']);
    check(S, r.code === 0, `evaluate w2 rc=${r.code} ${r.err}`);
    check(S, /2026-01-12[^\n]*EXCEEDED  alert alert-2 triggered \(unacknowledged\)  valid=86400s/.test(r.out),
      `second Monday off must exceed with a new alert:\n${r.out}`);
    check(S, /2026-01-13[^\n]*consumption=82\.800 kWh <= threshold=83\.000 kWh  NORMAL  no alert  valid=82800s anomaly=0s unknown=0s/.test(r.out),
      `Tuesday without exception must keep the weekly overnight tail (NR 82800s):\n${r.out}`);
    check(S, !r.out.includes('exception=2026-01-13'), 'no exception line for a date without exception');

    // alerts 历史显示所用例外与当前消耗。
    r = run(dir, ['alerts', '--rule', 'exc', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, r.code === 0 &&
      /2026-01-05[^\n]*consumption=86\.400 kWh \(EXCEEDED, threshold=83\.000 kWh\)/.test(r.out) &&
      r.out.includes('exception=2026-01-05 off (replaces weekly schedule for this date)'),
      `alerts history must show consumption and the exception used:\n${r.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// E2:只有例外的时间表、全天运行例外导致无非运行秒数、非法例外一律 rc=2 且不改业务文件。
function scenarioExceptionParsing() {
  const S = 'E2 exceptions-only schedule / all-day-running exception / invalid exceptions rc=2';
  const dir = makeDataDir();
  try {
    write(join(dir, 'r.csv'), ['device,time,reading',
      'q,2026-01-05T00:00:00Z,0.000',
      'q,2026-01-08T00:00:00Z,259.200', // 1 毫千瓦时/秒
      '',
    ].join('\n'));
    let r = run(dir, ['import', 'r.csv']);
    check(S, r.code === 0, `import rc=${r.code} ${r.err}`);
    r = run(dir, ['group', 'configure', '--id', 'g', '--at', '2026-01-01T00:00:00Z', '--device', 'q']);
    check(S, r.code === 0, `group rc=${r.code} ${r.err}`);

    // 只有例外(无每周窗口):周一 off => 全天非运行;其余日期无每周表也全非运行。
    write(join(dir, 'only.txt'), '2026-01-05 off\n');
    r = run(dir, ['rule', 'create', '--id', 'eo', '--group', 'g', '--threshold', '1000', '--schedule', 'only.txt']);
    check(S, r.code === 0, `exceptions-only rule rc=${r.code} ${r.err}`);
    r = run(dir, ['rule', 'list']);
    check(S, r.out.includes('schedule=(no running windows); exceptions: 2026-01-05 off'),
      `exceptions-only rule list:\n${r.out}`);
    r = run(dir, ['evaluate', '--rule', 'eo', '--from', '2026-01-05', '--to', '2026-01-07']);
    check(S, r.code === 0 &&
      /2026-01-05[^\n]*valid=86400s anomaly=0s unknown=0s/.test(r.out) &&
      /2026-01-06[^\n]*valid=86400s anomaly=0s unknown=0s/.test(r.out),
      `exceptions-only schedule must evaluate both days as fully non-running:\n${r.out}`);

    // 全天运行例外:周二 00:00-24:00 => 没有非运行秒数,说明原因,不触发也不恢复。
    write(join(dir, 'full.txt'), '2026-01-06 00:00 24:00\n');
    r = run(dir, ['rule', 'create', '--id', 'fd', '--group', 'g', '--threshold', '1', '--schedule', 'full.txt']);
    check(S, r.code === 0, `full-day exception rule rc=${r.code} ${r.err}`);
    r = run(dir, ['evaluate', '--rule', 'fd', '--from', '2026-01-06', '--to', '2026-01-07']);
    check(S, r.code === 0 &&
      /NO NON-RUNNING COVERAGE \(exception 2026-01-06 00:00-24:00 covers the whole local date\)  no alert action/.test(r.out),
      `all-day-running exception must explain no non-running coverage:\n${r.out}`);
    check(S, readJson(dir, 'alerts.json').alerts.length === 0, 'no alert may be persisted');
    r = run(dir, ['alerts', '--rule', 'fd', '--from', '2026-01-06', '--to', '2026-01-07']);
    check(S, /NO NON-RUNNING COVERAGE \(exception 2026-01-06 00:00-24:00 covers the whole local date\)/.test(r.out),
      `alerts must explain the exception-driven full coverage:\n${r.out}`);

    // 非法例外:off 与窗口并存(两种顺序)、非真实日期、跨夜/同值起止、残缺行、非法起点。
    const before = storeSnapshot(dir);
    const badCases = [
      '2026-01-05 off\n2026-01-05 09:00 10:00\n',
      '2026-01-05 09:00 10:00\n2026-01-05 off\n',
      '2026-02-30 off\n',
      '2026-01-05 10:00 09:00\n',
      '2026-01-05 09:00 09:00\n',
      '2026-01-05 09:00\n',
      '2026-01-05 24:00 24:00\n',
    ];
    for (let i = 0; i < badCases.length; i++) {
      write(join(dir, 'bad.txt'), badCases[i]);
      r = run(dir, ['rule', 'create', '--id', `bad-${i}`, '--group', 'g', '--threshold', '1', '--schedule', 'bad.txt']);
      check(S, r.code === 2, `bad exception #${i} must be rc=2, got ${r.code} (${r.both.trim()})`);
      check(S, /invalid schedule file/.test(r.err), `bad exception #${i} must report invalid schedule: ${r.err}`);
      const diff = sameSnapshot(before, storeSnapshot(dir));
      check(S, diff === null, `bad exception #${i} must not change business files (${diff})`);
    }
    // 报表入口同样拒绝非法例外(rc=2)。
    write(join(dir, 'bad.txt'), badCases[0]);
    r = run(dir, ['group', 'schedule-report', '--id', 'g', '--schedule', 'bad.txt',
      '--from', '2026-01-05T00:00:00Z', '--to', '2026-01-06T00:00:00Z']);
    check(S, r.code === 2 && /invalid schedule file/.test(r.err),
      `report must reject invalid exceptions with rc=2: rc=${r.code} ${r.err}`);
    rmSync(join(dir, 'bad.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// E3:例外随规则持久化,备份恢复完整保留;旧格式(无 exceptions 字段)按无例外使用;
// 非法已存例外按损坏拒绝。
function scenarioExceptionPersistence() {
  const S = 'E3 exceptions persist across restart/backup/restore; legacy and corrupted storage';
  const dir = makeDataDir();
  const snapDir = makeDataDir();
  const dir2 = makeDataDir();
  try {
    write(join(dir, 'r.csv'), ['device,time,reading',
      'm,2026-01-05T00:00:00Z,0.000',
      'm,2026-01-07T00:00:00Z,172.800',
      '',
    ].join('\n'));
    write(join(dir, 'exc.txt'), 'mon 12:00 18:00\n2026-01-05 off\n2026-01-06 09:00 11:00\n');
    let r = run(dir, ['import', 'r.csv']);
    check(S, r.code === 0, `import rc=${r.code} ${r.err}`);
    r = run(dir, ['group', 'configure', '--id', 'g', '--at', '2026-01-01T00:00:00Z', '--device', 'm']);
    check(S, r.code === 0, `group rc=${r.code} ${r.err}`);
    r = run(dir, ['rule', 'create', '--id', 'exc', '--group', 'g', '--threshold', '83', '--schedule', 'exc.txt']);
    check(S, r.code === 0, `rule rc=${r.code} ${r.err}`);
    rmSync(join(dir, 'exc.txt'));

    // 重启(新进程)后例外仍在。
    r = run(dir, ['rule', 'list']);
    check(S, r.code === 0 && r.out.includes('exceptions: 2026-01-05 off, 2026-01-06 09:00-11:00'),
      `exceptions must survive restart:\n${r.out}`);

    // 备份并恢复到全新目录:例外完整保留,评估一致(周一 off 超限)。
    const snap = join(snapDir, 'snap.json');
    r = run(dir, ['backup', snap]);
    check(S, r.code === 0, `backup rc=${r.code} ${r.err}`);
    r = run(dir2, ['restore', snap]);
    check(S, r.code === 0, `restore rc=${r.code} ${r.err}`);
    r = run(dir2, ['rule', 'list']);
    check(S, r.code === 0 && r.out.includes('exceptions: 2026-01-05 off, 2026-01-06 09:00-11:00'),
      `exceptions must survive backup/restore:\n${r.out}`);
    r = run(dir2, ['evaluate', '--rule', 'exc', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, r.code === 0 && /2026-01-05[^\n]*EXCEEDED  alert alert-1 triggered/.test(r.out) &&
      r.out.includes('exception=2026-01-05 off (replaces weekly schedule for this date)'),
      `restored rule must evaluate with exceptions:\n${r.out}`);

    // 旧格式:删除 exceptions 字段 => 按无例外使用(周一 12:00-18:00 运行,
    // 非运行 64800s = 64.800 kWh <= 83,原 alert-1 正常恢复)。
    const alertsPath = join(dir2, 'alerts.json');
    const legacy = readJson(dir2, 'alerts.json');
    delete legacy.rules[0].exceptions;
    write(alertsPath, JSON.stringify(legacy, null, 2) + '\n');
    r = run(dir2, ['rule', 'list']);
    check(S, r.code === 0 && !r.out.includes('exceptions:'),
      `legacy rule without exceptions field must list cleanly:\n${r.out}`);
    r = run(dir2, ['evaluate', '--rule', 'exc', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, r.code === 0 && /2026-01-05[^\n]*valid=64800s anomaly=0s unknown=0s/.test(r.out),
      `legacy rule must evaluate with weekly windows only (NR 64800s):\n${r.out}`);

    // 非法已存例外:按损坏拒绝(rc=1),不悄悄忽略。
    const corrupted = readJson(dir2, 'alerts.json');
    corrupted.rules[0].exceptions = [{ date: '2026-13-01', windows: [] }];
    write(alertsPath, JSON.stringify(corrupted, null, 2) + '\n');
    r = run(dir2, ['rule', 'list']);
    check(S, r.code === 1 && /corrupted \(invalid exceptions/.test(r.err),
      `invalid stored exceptions must be rejected as corrupted: rc=${r.code} ${r.err}`);
    r = run(dir2, ['evaluate', '--rule', 'exc', '--from', '2026-01-05', '--to', '2026-01-06']);
    check(S, r.code === 1 && /corrupted \(invalid exceptions/.test(r.err),
      `evaluate must also reject corrupted exceptions: rc=${r.code} ${r.err}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(snapDir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
}

// E4:夏令时下的例外窗口——前拨跳过的墙钟不补覆盖,回拨重复墙钟两段分别分类。
// America/New_York,读数速率 1 毫千瓦时/秒:
//   2026-03-08(前拨,82800s):例外 01:00-04:00 => 跳过的 02:00-03:00 不存在,
//     运行仅 UTC 06:00-08:00(7200s)=> NR 75600s = 75.600 kWh。
//   2026-11-01(回拨,90000s):例外 01:00-02:00 => 重复墙钟两段都算,
//     运行 UTC 05:00-07:00(7200s)=> NR 82800s = 82.800 kWh。
function scenarioExceptionDst() {
  const S = 'E4 exception windows across DST spring-forward / fall-back';
  const dir = makeDataDir();
  try {
    write(join(dir, 'r.csv'), ['device,time,reading',
      'd,2026-03-07T00:00:00Z,0.000',
      'd,2026-03-10T00:00:00Z,259.200',
      'd,2026-10-31T00:00:00Z,259.200',
      'd,2026-11-03T00:00:00Z,518.400',
      '',
    ].join('\n'));
    write(join(dir, 'exc.txt'), '2026-03-08 01:00 04:00\n2026-11-01 01:00 02:00\n');
    let r = run(dir, ['import', 'r.csv']);
    check(S, r.code === 0, `import rc=${r.code} ${r.err}`);
    r = run(dir, ['group', 'configure', '--id', 'g', '--at', '2026-01-01T00:00:00Z', '--device', 'd']);
    check(S, r.code === 0, `group rc=${r.code} ${r.err}`);
    r = run(dir, ['rule', 'create', '--id', 'ny', '--group', 'g', '--threshold', '1000',
      '--tz', 'America/New_York', '--schedule', 'exc.txt']);
    check(S, r.code === 0, `rule rc=${r.code} ${r.err}`);
    rmSync(join(dir, 'exc.txt'));

    r = run(dir, ['evaluate', '--rule', 'ny', '--from', '2026-03-08', '--to', '2026-03-09']);
    check(S, r.code === 0, `spring evaluate rc=${r.code} ${r.err}`);
    check(S, /2026-03-08[^\n]*consumption=75\.600 kWh <= threshold=1000\.000 kWh  NORMAL  no alert  valid=75600s anomaly=0s unknown=0s/.test(r.out),
      `skipped wall hour must not be covered (NR 75600s):\n${r.out}`);
    check(S, r.out.includes('period=2026-03-08T05:00:00Z..2026-03-08T06:00:00Z') &&
      r.out.includes('period=2026-03-08T08:00:00Z..2026-03-09T04:00:00Z'),
      `spring non-running periods must straddle the real running segments:\n${r.out}`);
    check(S, r.out.includes('exception=2026-03-08 01:00-04:00 (replaces weekly schedule for this date)'),
      `spring exception line:\n${r.out}`);

    r = run(dir, ['evaluate', '--rule', 'ny', '--from', '2026-11-01', '--to', '2026-11-02']);
    check(S, r.code === 0, `fall evaluate rc=${r.code} ${r.err}`);
    check(S, /2026-11-01[^\n]*consumption=82\.800 kWh <= threshold=1000\.000 kWh  NORMAL  no alert  valid=82800s anomaly=0s unknown=0s/.test(r.out),
      `repeated wall hour must count both real segments (NR 82800s):\n${r.out}`);
    check(S, r.out.includes('period=2026-11-01T04:00:00Z..2026-11-01T05:00:00Z') &&
      r.out.includes('period=2026-11-01T07:00:00Z..2026-11-02T05:00:00Z'),
      `fall non-running periods must straddle both repeated segments:\n${r.out}`);
    check(S, r.out.includes('exception=2026-11-01 01:00-02:00 (replaces weekly schedule for this date)'),
      `fall exception line:\n${r.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// R1:恢复日志损坏后普通命令(含 restore)一律拒绝,只有显式 rescue 能放弃旧事务;
// 留存原始字节与缺失状态、序号递增不丢材料、快照/参数/锁的前置校验不改动现场。
function scenarioRescue() {
  const S = 'R1 explicit rescue after unrecoverable restore journal';
  const dir = makeDataDir();
  const snapDir = makeDataDir();
  try {
    write(join(dir, 'r.csv'), ['device,time,reading',
      'm,2026-01-05T00:00:00Z,0.000',
      'm,2026-01-06T00:00:00Z,2.000',
      '',
    ].join('\n'));
    let r = run(dir, ['import', 'r.csv']);
    check(S, r.code === 0, `import rc=${r.code} ${r.err}`);
    r = run(dir, ['correct', '--request', 'REQ1',
      '--item', '--device', 'm', '--at', '2026-01-06T00:00:00Z', '--expect', '2.000', '--set', '3.000']);
    check(S, r.code === 0, `correct rc=${r.code} ${r.err}`);
    r = run(dir, ['group', 'configure', '--id', 'g', '--at', '2026-01-01T00:00:00Z', '--device', 'm']);
    check(S, r.code === 0, `group rc=${r.code} ${r.err}`);
    r = run(dir, ['rule', 'create', '--id', 'nr', '--group', 'g', '--threshold', '1']);
    check(S, r.code === 0, `rule rc=${r.code} ${r.err}`);
    const snap = join(snapDir, 'snap.json');
    r = run(dir, ['backup', snap]);
    check(S, r.code === 0, `backup rc=${r.code} ${r.err}`);

    // 损坏恢复日志 + 旧事务材料 + 损坏业务文件(混合现场)。
    const junkJournal = 'not json {{';
    write(join(dir, 'restore.journal'), junkJournal);
    write(join(dir, 'readings.json.restore-old'), 'junk-old');
    write(join(dir, 'groups.json.restore-new'), 'junk-new');
    write(join(dir, 'alerts.json'), 'corrupt-business');
    const before = storeSnapshot(dir);

    // 普通命令拒绝(返回 1),业务文件与恢复材料原样保留。
    r = run(dir, ['readings']);
    check(S, r.code === 1 && /restore journal/.test(r.err) && !/device: /.test(r.out),
      `normal command must refuse without business output: rc=${r.code}\n${r.out}`);
    check(S, sameSnapshot(before, storeSnapshot(dir)) === null, 'business files untouched after refusal');
    check(S, readFileSync(join(dir, 'restore.journal'), 'utf8') === junkJournal, 'corrupt journal kept');

    // 普通 restore 不得隐式绕过恢复。
    r = run(dir, ['restore', snap]);
    check(S, r.code === 1 && /restore journal/.test(r.err), `plain restore must not bypass recovery: rc=${r.code}`);
    check(S, sameSnapshot(before, storeSnapshot(dir)) === null, 'plain restore changed nothing');

    // 显式未知阶段同样无法自动判定,普通命令拒绝。
    write(join(dir, 'restore.journal'), JSON.stringify({
      format: 'meterwatch-restore-journal', version: 1, phase: 'exploding',
      files: [{ name: 'readings.json', hadOld: true }],
    }));
    r = run(dir, ['readings']);
    check(S, r.code === 1 && /restore journal/.test(r.err), `explicit unknown phase must refuse: rc=${r.code}`);
    write(join(dir, 'restore.journal'), junkJournal);

    // 无效快照:返回 1,不改动原库及旧事务材料,也不产生留存。
    const badSnap = join(snapDir, 'bad.json');
    write(badSnap, '{"format":"meterwatch-snapshot","version":1,"checksum":"sha256:0","payload":{}}');
    r = run(dir, ['rescue', badSnap]);
    check(S, r.code === 1 && /integrity check/.test(r.err), `invalid snapshot rc=${r.code}`);
    check(S, sameSnapshot(before, storeSnapshot(dir)) === null &&
      readFileSync(join(dir, 'restore.journal'), 'utf8') === junkJournal,
    'invalid snapshot changed nothing');
    check(S, !existsSync(join(dir, 'rescue-preserved-1')), 'no preservation on invalid snapshot');

    // 快照位于数据目录内 / 缺参数:返回 2。
    r = run(dir, ['rescue', join(dir, 'inside.json')]);
    check(S, r.code === 2, `snapshot inside data dir must be rc=2, got ${r.code}`);
    r = run(dir, ['rescue']);
    check(S, r.code === 2, `missing snapshot arg must be rc=2, got ${r.code}`);

    // 目录被其他存活进程占用:返回 1,不动其材料。
    write(join(dir, 'meterwatch.lock'), `${process.pid}\n`);
    r = run(dir, ['rescue', snap]);
    check(S, r.code === 1 && /locked by another live/.test(r.err), `locked dir rc=${r.code}: ${r.err}`);
    check(S, readFileSync(join(dir, 'restore.journal'), 'utf8') === junkJournal, 'locked: materials untouched');
    rmSync(join(dir, 'meterwatch.lock'));

    // 显式救援成功:三个存储整体等于快照,旧事务材料从活动位置移除。
    r = run(dir, ['rescue', snap]);
    check(S, r.code === 0 && /rescued from snapshot/.test(r.out), `rescue rc=${r.code} ${r.err}`);
    check(S, /pre-rescue state preserved in '[^']*rescue-preserved-1'/.test(r.out),
      `rescue reports preserved location:\n${r.out}`);
    const restored = readJson(dir, 'readings.json');
    check(S, restored.readings.length === 2 && restored.corrections.length === 1 &&
      restored.corrections[0].requestId === 'REQ1',
    'stores wholly equal snapshot (readings + correction history)');
    check(S, !existsSync(join(dir, 'restore.journal')) &&
      !existsSync(join(dir, 'readings.json.restore-old')) &&
      !existsSync(join(dir, 'groups.json.restore-new')),
    'abandoned transaction materials removed from live locations');

    // 留存完整:原始字节与缺失状态,且不按坏日志里的文件名操作。
    const p1 = join(dir, 'rescue-preserved-1');
    check(S, readFileSync(join(p1, 'restore.journal'), 'utf8') === junkJournal, 'preserved journal bytes');
    check(S, readFileSync(join(p1, 'readings.json.restore-old'), 'utf8') === 'junk-old',
      'preserved .restore-old bytes');
    check(S, readFileSync(join(p1, 'groups.json.restore-new'), 'utf8') === 'junk-new',
      'preserved .restore-new bytes');
    check(S, readFileSync(join(p1, 'alerts.json'), 'utf8') === 'corrupt-business',
      'preserved corrupt business bytes');
    check(S, !existsSync(join(p1, 'alerts.json.restore-old')), 'missing-state preserved as absence');
    const manifest = JSON.parse(readFileSync(join(p1, 'rescue-manifest.json'), 'utf8'));
    check(S, manifest.preserved.length === 10 &&
      manifest.preserved.find((e) => e.name === 'alerts.json.restore-old').hadOld === false &&
      manifest.preserved.find((e) => e.name === 'restore.journal').hadOld === true,
    'manifest records raw missing-state for the fixed name set');

    // 业务可用:精确读数、修正重放返回原成功结果、规则与分组历史可用。
    r = run(dir, ['readings']);
    check(S, r.code === 0 && /3\.000/.test(r.out), `readings usable after rescue:\n${r.out}`);
    r = run(dir, ['correct', '--request', 'REQ1',
      '--item', '--device', 'm', '--at', '2026-01-06T00:00:00Z', '--expect', '2.000', '--set', '3.000']);
    check(S, r.code === 0 && /committed: 1 item\(s\), 1 reading\(s\) changed/.test(r.out),
      `correction replay returns the original recorded result:\n${r.out}`);
    r = run(dir, ['rule', 'list']);
    check(S, r.code === 0 && /\bnr\b/.test(r.out), `rules usable after rescue:\n${r.out}`);
    r = run(dir, ['group', 'history', '--id', 'g']);
    check(S, r.code === 0 && /g/.test(r.out), `group history usable after rescue:\n${r.out}`);

    // 留存材料不被启动或后续命令自动清理。
    check(S, existsSync(p1) && existsSync(join(p1, 'restore.journal')),
      'preserved materials are not auto-cleaned by later commands');

    // 重复救援(业务文件缺失 + 日志再次损坏):序号递增,不丢材料、不改写历史。
    rmSync(join(dir, 'groups.json'));
    write(join(dir, 'restore.journal'), 'garbage-again');
    r = run(dir, ['rescue', snap]);
    check(S, r.code === 0, `second rescue rc=${r.code} ${r.err}`);
    check(S, existsSync(join(dir, 'rescue-preserved-2')) && existsSync(join(p1, 'restore.journal')),
      'repeated rescue keeps earlier materials');
    check(S, !existsSync(join(dir, 'rescue-preserved-2', 'groups.json')),
      'second preservation records the missing business file');
    r = run(dir, ['group', 'history', '--id', 'g']);
    check(S, r.code === 0, `business usable after second rescue:\n${r.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(snapDir, { recursive: true, force: true });
  }
}

// R2:救援在留存/替换/回退中被中断后,任一命令启动先续接为完整快照或完整退回
// 救援前状态,不开放混合库;确定回退后不得改向,退回后普通命令继续拒绝。
function scenarioRescueInterrupted() {
  const S = 'R2 interrupted rescue continuation (preserving/committing/rolling-back)';
  const mkJournal = (phase, preservedDir, preserved) => JSON.stringify({
    format: 'meterwatch-rescue-journal', version: 1, phase, preservedDir,
    stores: ['readings.json', 'alerts.json', 'groups.json'], preserved,
  }, null, 2) + '\n';
  const fixedRecord = (d) => {
    const names = [];
    for (const n of ['readings.json', 'alerts.json', 'groups.json']) {
      names.push(n, `${n}.restore-old`, `${n}.restore-new`);
    }
    names.push('restore.journal');
    return names.map((name) => ({ name, hadOld: existsSync(join(d, name)) }));
  };

  // (a) preserving 阶段中断:替换尚未开始,退回救援前状态,业务文件不变。
  const dirA = makeDataDir();
  try {
    write(join(dirA, 'r.csv'), 'device,time,reading\na,2026-01-05T00:00:00Z,1.000\n');
    let r = run(dirA, ['import', 'r.csv']);
    check(S, r.code === 0, `A import rc=${r.code} ${r.err}`);
    const before = storeSnapshot(dirA);
    write(join(dirA, 'readings.json.rescue-new'), 'junk-new');
    write(join(dirA, 'alerts.json.rescue-new'), 'junk-new');
    write(join(dirA, 'groups.json.rescue-new'), 'junk-new');
    mkdirSync(join(dirA, 'rescue-preserved-1')); // 部分留存(中断)
    write(join(dirA, 'rescue.journal'), mkJournal('preserving', 'rescue-preserved-1', fixedRecord(dirA)));
    r = run(dirA, ['readings']);
    check(S, r.code === 0 && /device: a/.test(r.out),
      `A: preserving interruption must roll back to pre-rescue state: rc=${r.code} ${r.err}`);
    check(S, sameSnapshot(before, storeSnapshot(dirA)) === null, 'A: business files untouched');
    check(S, !existsSync(join(dirA, 'rescue.journal')) && !existsSync(join(dirA, 'readings.json.rescue-new')),
      'A: rescue temps and journal cleaned');
    check(S, existsSync(join(dirA, 'rescue-preserved-1')), 'A: preserved dir is not auto-cleaned');
  } finally {
    rmSync(dirA, { recursive: true, force: true });
  }

  // (b) committing 阶段中断:只能前滚为完整快照,旧事务材料随收尾移除。
  const dirB = makeDataDir();
  const dirC = makeDataDir();
  try {
    write(join(dirB, 'r.csv'), 'device,time,reading\nm2,2026-01-05T00:00:00Z,5.000\n');
    let r = run(dirB, ['import', 'r.csv']);
    check(S, r.code === 0, `B import rc=${r.code} ${r.err}`);
    r = run(dirB, ['rule', 'create', '--id', 'd1', '--device', 'm2', '--threshold', '1']);
    check(S, r.code === 0, `B rule rc=${r.code} ${r.err}`);
    r = run(dirB, ['group', 'configure', '--id', 'gb', '--at', '2026-01-01T00:00:00Z', '--device', 'm2']);
    check(S, r.code === 0, `B group rc=${r.code} ${r.err}`);
    write(join(dirC, 'r.csv'), 'device,time,reading\nx,2026-01-05T00:00:00Z,1.000\n');
    r = run(dirC, ['import', 'r.csv']);
    check(S, r.code === 0, `C import rc=${r.code} ${r.err}`);
    // 损坏旧事务材料 + 提交中途的现场:新内容已在 *.rescue-new。
    write(join(dirC, 'restore.journal'), 'corrupt');
    write(join(dirC, 'readings.json.restore-old'), 'junk');
    for (const n of ['readings.json', 'alerts.json', 'groups.json']) {
      copyFileSync(join(dirB, n), join(dirC, `${n}.rescue-new`));
    }
    mkdirSync(join(dirC, 'rescue-preserved-1'));
    write(join(dirC, 'rescue.journal'), mkJournal('committing', 'rescue-preserved-1', fixedRecord(dirC)));
    r = run(dirC, ['readings']);
    check(S, r.code === 0 && /device: m2/.test(r.out) && !/device: x/.test(r.out),
      `B: interrupted commit must complete to the full snapshot:\n${r.out}\n${r.err}`);
    check(S, !existsSync(join(dirC, 'rescue.journal')) && !existsSync(join(dirC, 'restore.journal')) &&
      !existsSync(join(dirC, 'readings.json.restore-old')) && !existsSync(join(dirC, 'readings.json.rescue-new')),
    'B: journals, temps and abandoned materials cleaned after commit');
    check(S, existsSync(join(dirC, 'rescue-preserved-1')), 'B: preserved dir kept');
    r = run(dirC, ['rule', 'list']);
    check(S, r.code === 0 && /\bd1\b/.test(r.out), `B: rules from snapshot usable:\n${r.out}`);
  } finally {
    rmSync(dirB, { recursive: true, force: true });
    rmSync(dirC, { recursive: true, force: true });
  }

  // (c) rolling-back 阶段中断:只能继续还原救援前状态;原损坏日志恢复到位后
  // 普通命令继续拒绝,仍可显式救援。
  const dirD = makeDataDir();
  const snapDir = makeDataDir();
  try {
    write(join(dirD, 'r.csv'), 'device,time,reading\ny,2026-01-05T00:00:00Z,7.000\n');
    let r = run(dirD, ['import', 'r.csv']);
    check(S, r.code === 0, `D import rc=${r.code} ${r.err}`);
    const snap = join(snapDir, 'snap.json');
    r = run(dirD, ['backup', snap]);
    check(S, r.code === 0, `D backup rc=${r.code} ${r.err}`);
    const origReadings = readFileSync(join(dirD, 'readings.json'), 'utf8');
    // 回退中途的现场:业务文件已被换入的新内容替换,旧事务材料已被移除。
    write(join(dirD, 'readings.json'), '{"readings":[],"corrections":[],"undos":[]}\n');
    mkdirSync(join(dirD, 'rescue-preserved-1'));
    write(join(dirD, 'rescue-preserved-1', 'readings.json'), origReadings);
    write(join(dirD, 'rescue-preserved-1', 'restore.journal'), 'corrupt-journal');
    const record = [
      { name: 'readings.json', hadOld: true },
      { name: 'readings.json.restore-old', hadOld: false },
      { name: 'readings.json.restore-new', hadOld: false },
      { name: 'alerts.json', hadOld: false },
      { name: 'alerts.json.restore-old', hadOld: false },
      { name: 'alerts.json.restore-new', hadOld: false },
      { name: 'groups.json', hadOld: false },
      { name: 'groups.json.restore-old', hadOld: false },
      { name: 'groups.json.restore-new', hadOld: false },
      { name: 'restore.journal', hadOld: true },
    ];
    write(join(dirD, 'rescue.journal'), mkJournal('rolling-back', 'rescue-preserved-1', record));
    r = run(dirD, ['readings']);
    check(S, r.code === 1 && /restore journal/.test(r.err),
      `C: after rollback the restored corrupt journal must keep refusing: rc=${r.code}\n${r.out}`);
    check(S, readFileSync(join(dirD, 'readings.json'), 'utf8') === origReadings,
      'C: pre-rescue business bytes restored');
    check(S, readFileSync(join(dirD, 'restore.journal'), 'utf8') === 'corrupt-journal',
      'C: corrupt journal restored in place');
    check(S, !existsSync(join(dirD, 'rescue.journal')), 'C: rescue journal removed after rollback');
    check(S, existsSync(join(dirD, 'rescue-preserved-1')), 'C: preserved materials kept');
    // 显式救援仍可用,成功后业务恢复。
    r = run(dirD, ['rescue', snap]);
    check(S, r.code === 0, `C: explicit rescue after rollback rc=${r.code} ${r.err}`);
    r = run(dirD, ['readings']);
    check(S, r.code === 0 && /device: y/.test(r.out), `C: business usable after rescue:\n${r.out}`);
  } finally {
    rmSync(dirD, { recursive: true, force: true });
    rmSync(snapDir, { recursive: true, force: true });
  }
}

// R3:救援替换阶段受控失败 → 确定回退不得改向;回退受阻(文件锁定)时保留全部
// 材料并阻止业务,故障排除后任一命令续接还原救援前状态,普通命令继续拒绝。
function scenarioRescueFailureRollback() {
  const S = 'R3 rescue commit failure rolls back; blocked rollback keeps materials';
  const dir = makeDataDir();
  const snapDir = makeDataDir();
  try {
    write(join(dir, 'r.csv'), 'device,time,reading\nz,2026-01-05T00:00:00Z,9.000\n');
    let r = run(dir, ['import', 'r.csv']);
    check(S, r.code === 0, `import rc=${r.code} ${r.err}`);
    const snap = join(snapDir, 'snap.json');
    r = run(dir, ['backup', snap]);
    check(S, r.code === 0, `backup rc=${r.code} ${r.err}`);
    const origReadings = readFileSync(join(dir, 'readings.json'), 'utf8');
    write(join(dir, 'restore.journal'), 'corrupt-journal');

    // 可控本地故障:锁定业务文件,使替换与回滚的删除都失败。
    const readingsPath = join(dir, 'readings.json');
    execFileSync('chflags', ['uchg', readingsPath]);
    try {
      r = run(dir, ['rescue', snap]);
      check(S, r.code === 1 && /keeps all materials|keeps its rescue materials/.test(r.err),
        `rescue with blocked rollback must fail rc=1 and keep materials: rc=${r.code} ${r.err}`);
      // 材料全部保留:救援日志(rolling-back)、新临时、留存目录、原损坏日志。
      const rj = readJson(dir, 'rescue.journal');
      check(S, rj !== null && rj.phase === 'rolling-back',
        `rescue journal must pin rolling-back (no direction change): ${JSON.stringify(rj)}`);
      check(S, existsSync(join(dir, 'readings.json.rescue-new')), 'rescue temp kept');
      check(S, existsSync(join(dir, 'rescue-preserved-1', 'readings.json')), 'preserved copy kept');
      check(S, readFileSync(join(dir, 'restore.journal'), 'utf8') === 'corrupt-journal',
        'old corrupt journal untouched');
      check(S, readFileSync(readingsPath, 'utf8') === origReadings, 'business file untouched');
      // 故障未排除时任一命令启动仍受阻,不开放混合库。
      r = run(dir, ['readings']);
      check(S, r.code === 1 && /cannot complete interrupted rescue/.test(r.err),
        `startup must stay blocked while rollback is stuck: rc=${r.code}`);
    } finally {
      execFileSync('chflags', ['nouchg', readingsPath]);
    }
    // 故障排除后任一命令续接回退:还原救援前状态(含原损坏日志),普通命令继续拒绝。
    r = run(dir, ['readings']);
    check(S, r.code === 1 && /restore journal/.test(r.err),
      `after rollback the restored corrupt journal keeps refusing: rc=${r.code}`);
    check(S, readFileSync(readingsPath, 'utf8') === origReadings, 'pre-rescue business bytes restored');
    check(S, readFileSync(join(dir, 'restore.journal'), 'utf8') === 'corrupt-journal',
      'pre-rescue corrupt journal restored');
    check(S, !existsSync(join(dir, 'rescue.journal')) && !existsSync(join(dir, 'readings.json.rescue-new')),
      'rescue journal and temps cleaned after rollback');
    check(S, existsSync(join(dir, 'rescue-preserved-1')), 'preserved materials survive rollback');
    // 显式救援仍可用并成功。
    r = run(dir, ['rescue', snap]);
    check(S, r.code === 0, `rescue after fault cleared rc=${r.code} ${r.err}`);
    r = run(dir, ['readings']);
    check(S, r.code === 0 && /device: z/.test(r.out), `business usable after rescue:\n${r.out}`);
  } finally {
    try { execFileSync('chflags', ['nouchg', join(dir, 'readings.json')]); } catch { /* may not exist */ }
    rmSync(dir, { recursive: true, force: true });
    rmSync(snapDir, { recursive: true, force: true });
  }
}

const scenarios = [
  scenarioS1,
  scenarioDst,
  scenarioS2,
  scenarioNoCoverage,
  scenarioNoRecoverOnUndecidable,
  scenarioBadWeekday,
  scenarioLifecycle,
  scenarioWriteFailure,
  scenarioExceptions,
  scenarioExceptionParsing,
  scenarioExceptionPersistence,
  scenarioExceptionDst,
  scenarioRescue,
  scenarioRescueInterrupted,
  scenarioRescueFailureRollback,
];

for (const sc of scenarios) {
  try {
    sc();
  } catch (e) {
    failures.push(`[${sc.name}] harness error: ${e?.stack ?? e}`);
  }
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} assertion(s) failed, ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS: all ${passed} assertions across ${scenarios.length} scenarios`);

// 显式快照救援收尾失败 —— 本地离线回归测试。
//
// 运行(在仓库根目录):
//   node tests/rescue-failure.mjs
// 要求 Node.js 24,无外部依赖;可重复离线运行。
//
// 覆盖(故障均通过仅测试用的环境变量 METERWATCH_RESCUE_FAULT 注入,正常构建
// 该变量为空时全部为空操作;故障都被送到救援收尾/回退环节,而不是以获取锁
// 失败代替):
//   1. 三个存储换入后的“完成记录写入”失败(rc=1、不输出成功、同步整体回退);
//   2. “旧事务材料清理”失败,且日志一度到达 done —— 下次启动不得前滚提交;
//   3. “回退方向记录”写入失败(换入前标记失败,什么都不替换);
//   4. 回退在还原首个名字后被再次中断、跨进程重试:方向不改、已还原文件不误删;
//   5. 解除故障后的跨进程完整回退;回退后原损坏日志恢复到位,普通命令继续
//      拒绝,仍可再次显式救援;
//   6. 正常救援成功:整库字节等于快照、留存字节/缺失状态精确、无关文件不变。
// 每个场景使用独立 OS 临时数据目录,核对退出码、stdout/stderr、全部 10 个
// 固定文件(readings/alerts/groups 的 .restore-old/.restore-new 与 restore.journal)
// 的原始字节与存在状态。

import { spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../app.ts', import.meta.url));

const STORES = ['readings.json', 'alerts.json', 'groups.json'];
// 救援留存/回退必须逐项负责的固定名字集(与产品 preservedNames() 同序同集)。
const FIXED = [];
for (const n of STORES) FIXED.push(n, `${n}.restore-old`, `${n}.restore-new`);
FIXED.push('restore.journal');

const UNRELATED = 'unrelated.txt';
const UNRELATED_BYTES = 'leave-me-alone\n';

const failures = [];
let passed = 0;
function check(scenario, cond, detail) {
  if (cond) passed++;
  else failures.push(`[${scenario}] ${detail ?? 'assertion failed'}`);
}

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), 'meterwatch-rescue-fail-'));
}

// fault 为 undefined 时不注入故障(续接/普通命令一律干净环境)。
function run(dataDir, args, fault) {
  const env = { ...process.env, METERWATCH_DATA_DIR: dataDir };
  if (fault !== undefined) env.METERWATCH_RESCUE_FAULT = fault;
  else delete env.METERWATCH_RESCUE_FAULT;
  const res = spawnSync(process.execPath, [APP, ...args], { encoding: 'utf8', cwd: dataDir, env });
  return { code: res.status, out: res.stdout ?? '', err: res.stderr ?? '' };
}

function write(path, body) {
  writeFileSync(path, body, 'utf8');
}
function raw(dir, name) {
  const p = join(dir, name);
  return existsSync(p) ? { exists: true, bytes: readFileSync(p) } : { exists: false, bytes: null };
}
// 全部固定文件 + 无关文件的字节/存在状态快照( ground truth 直接读盘)。
function stateOf(dir) {
  const s = {};
  for (const name of FIXED) s[name] = raw(dir, name);
  s[UNRELATED] = raw(dir, UNRELATED);
  return s;
}
function sameBytes(a, b) {
  return a.exists === b.exists && (a.bytes === null || a.bytes.equals(b.bytes));
}
function diffStates(a, b, names = [...FIXED, UNRELATED]) {
  for (const name of names) {
    if (!sameBytes(a[name], b[name])) {
      return `${name}: ${a[name].exists ? 'bytes' : 'absent'} -> ${b[name].exists ? 'bytes' : 'absent'}`;
    }
  }
  return null;
}
function fixedOnly(a, b) {
  return diffStates(a, b, FIXED);
}

// 建好含读数/修正/分组/规则的库,备份;再布置损坏旧事务材料与无关文件。
// 返回 { snap, pre } ,pre 为救援前应被逐字节还原的完整状态。
function setupCorruptRescueScene(dir, snapDir) {
  write(join(dir, 'r.csv'), [
    'device,time,reading',
    'm,2026-01-05T00:00:00Z,0.000',
    'm,2026-01-06T00:00:00Z,2.000',
    '',
  ].join('\n'));
  let r = run(dir, ['import', 'r.csv']);
  if (r.code !== 0) throw new Error(`setup import failed: ${r.err}`);
  r = run(dir, ['correct', '--request', 'REQ1',
    '--item', '--device', 'm', '--at', '2026-01-06T00:00:00Z', '--expect', '2.000', '--set', '3.000']);
  if (r.code !== 0) throw new Error(`setup correct failed: ${r.err}`);
  r = run(dir, ['group', 'configure', '--id', 'g', '--at', '2026-01-01T00:00:00Z', '--device', 'm']);
  if (r.code !== 0) throw new Error(`setup group failed: ${r.err}`);
  r = run(dir, ['rule', 'create', '--id', 'nr', '--group', 'g', '--threshold', '1']);
  if (r.code !== 0) throw new Error(`setup rule failed: ${r.err}`);
  const snap = join(snapDir, 'snap.json');
  r = run(dir, ['backup', snap]);
  if (r.code !== 0) throw new Error(`setup backup failed: ${r.err}`);

  // 损坏的旧恢复事务:坏日志 + old/new 材料 + 损坏业务文件。
  write(join(dir, 'restore.journal'), 'corrupt-journal-xyz');
  write(join(dir, 'readings.json.restore-old'), 'junk-old-aaa');
  write(join(dir, 'groups.json.restore-new'), 'junk-new-bbb');
  write(join(dir, 'alerts.json'), 'corrupt-business-ccc');
  // 无关文件:任何结局都不得改变。
  write(join(dir, UNRELATED), UNRELATED_BYTES);
  return { snap, pre: stateOf(dir) };
}

// 快照整库提交后的三个业务存储字节(在独立目录 restore,作为精确对照,
// 不依赖救援自身的输出)。
function referenceSnapshotStores(snap) {
  const ref = makeDataDir();
  const r = run(ref, ['restore', snap]);
  if (r.code !== 0) {
    rmSync(ref, { recursive: true, force: true });
    throw new Error(`reference restore failed: ${r.err}`);
  }
  const s = {};
  for (const n of STORES) s[n] = raw(ref, n);
  rmSync(ref, { recursive: true, force: true });
  return s;
}

function assertPreservationIntact(S, dir, seq, pre) {
  const p = join(dir, `rescue-preserved-${seq}`);
  check(S, existsSync(p), `preserved dir #${seq} must persist`);
  for (const name of FIXED) {
    const kept = raw(p, name);
    const want = pre[name];
    check(S, sameBytes(kept, want),
      `preserved #${seq} ${name} must hold exact pre-rescue bytes/existence ` +
      `(kept=${kept.exists}, want=${want.exists})`);
  }
  const manifest = JSON.parse(readFileSync(join(p, 'rescue-manifest.json'), 'utf8'));
  check(S, manifest.format === 'meterwatch-rescue-manifest' &&
    manifest.version === 1 && manifest.preserved.length === 10,
    `preserved #${seq} manifest must list exactly the fixed name set`);
  check(S, !existsSync(join(p, UNRELATED)), 'preservation must not copy unrelated files');
}

// F1:完成记录写入失败 —— rc=1、无成功输出,同步完整回退;跨进程普通命令
// 仍拒绝(损坏日志复原),再次显式救援成功。
function scenarioDoneRecordFailure() {
  const S = 'F1 done-record write failure after swap -> rc1, full synchronous rollback';
  const dir = makeDataDir();
  const snapDir = makeDataDir();
  try {
    const { snap, pre } = setupCorruptRescueScene(dir, snapDir);
    const r = run(dir, ['rescue', snap], 'rescue-done');
    check(S, r.code === 1, `failed rescue must be rc=1, got ${r.code}`);
    check(S, !/rescued from snapshot/.test(r.out), `must print no success output:\n${r.out}`);
    check(S, /rescue failed/.test(r.err) && /pre-rescue state restored/.test(r.err),
      `must report failure + rollback: ${r.err}`);
    // 同步回退已完成:全部固定文件逐字节/存在状态等于救援前。
    check(S, fixedOnly(pre, stateOf(dir)) === null,
      `all fixed files must equal pre-rescue state (${fixedOnly(pre, stateOf(dir))})`);
    check(S, sameBytes(pre[UNRELATED], raw(dir, UNRELATED)), 'unrelated file unchanged');
    check(S, !existsSync(join(dir, 'rescue.journal')) &&
      !existsSync(join(dir, 'rescue-rollback')) &&
      !existsSync(join(dir, 'readings.json.rescue-new')),
      'rescue journal, rollback marker and temps cleaned after rollback');
    assertPreservationIntact(S, dir, 1, pre);

    // 跨进程:原损坏日志已复原,普通命令继续拒绝、不输出业务结果。
    let q = run(dir, ['readings']);
    check(S, q.code === 1 && /restore journal/.test(q.err) && !/device: /.test(q.out),
      `normal command must keep refusing after rollback: rc=${q.code}\n${q.out}`);
    check(S, fixedOnly(pre, stateOf(dir)) === null, 'state still exactly pre-rescue after refusal');

    // 仍可再次显式救援,成功后整库等于快照。
    q = run(dir, ['rescue', snap]);
    check(S, q.code === 0 && /rescued from snapshot/.test(q.out), `retry rescue rc=${q.code} ${q.err}`);
    const ref = referenceSnapshotStores(snap);
    for (const n of STORES) check(S, sameBytes(raw(dir, n), ref[n]), `committed ${n} must byte-equal snapshot`);
    check(S, !existsSync(join(dir, 'restore.journal')) &&
      !existsSync(join(dir, 'readings.json.restore-old')) &&
      !existsSync(join(dir, 'groups.json.restore-new')),
      'abandoned materials removed after successful rescue');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(snapDir, { recursive: true, force: true });
  }
}

// F2:收尾清理失败(日志一度到达 done)—— 下次启动不得据 done/committing 前滚,
// 只能完成回退。
function scenarioCleanupFailureNoRollForward() {
  const S = 'F2 cleanup failure (journal reached done) -> continuation rolls back, never commits';
  const dir = makeDataDir();
  const snapDir = makeDataDir();
  try {
    const { snap, pre } = setupCorruptRescueScene(dir, snapDir);
    // 清理失败;回退阶段翻转也失败(日志永久停在 done);回退在还原首个名字后
    // 中断:进程退出时现场为半回退,但方向标记已落地。
    const r = run(dir, ['rescue', snap], 'rescue-cleanup,rescue-rollback-phase,rescue-rollback-step');
    check(S, r.code === 1 && !/rescued from snapshot/.test(r.out),
      `cleanup failure must be rc=1 without success output: rc=${r.code}`);
    check(S, /rollback is in progress/.test(r.err), `must report in-progress rollback: ${r.err}`);
    // 关键现场:回退标记在,救援日志停在 done(收尾曾抵达完成阶段),旧材料
    // 尚未删除。下次启动绝不能据 done 前滚提交——这正是本次修复的缺陷。
    check(S, existsSync(join(dir, 'rescue-rollback')), 'rollback direction marker must be present');
    const j = JSON.parse(readFileSync(join(dir, 'rescue.journal'), 'utf8'));
    check(S, j.phase === 'done',
      `rescue journal must remain at done when the rollback-phase write fails, got ${j.phase}`);
    check(S, readFileSync(join(dir, 'restore.journal'), 'utf8') === 'corrupt-journal-xyz',
      'old corrupt journal still present (cleanup never finished)');
    // readings.json 已被回退还原为救援前(方向朝后,不是快照)。
    check(S, sameBytes(raw(dir, 'readings.json'), pre['readings.json']),
      'first rollback step restored readings backwards, never forward');

    // 故障仍在(半回退点):普通命令被阻止业务,无法完成回退。
    let q = run(dir, ['readings'], 'rescue-rollback-step');
    check(S, q.code === 1 && /cannot complete interrupted rescue rollback/.test(q.err) &&
      !/device: /.test(q.out),
      `business must stay blocked while rollback stuck: rc=${q.code}`);
    check(S, JSON.parse(readFileSync(join(dir, 'rescue.journal'), 'utf8')).phase === 'done',
      'retry must never roll forward despite the done journal');

    // 解除故障:跨进程只能完成回退(即使存在过 done 日志也绝不提交快照)。
    q = run(dir, ['readings']);
    check(S, q.code === 1 && /restore journal/.test(q.err),
      `after cross-process rollback the restored corrupt journal refuses: rc=${q.code}`);
    check(S, fixedOnly(pre, stateOf(dir)) === null,
      `cross-process rollback must restore every fixed file (${fixedOnly(pre, stateOf(dir))})`);
    check(S, sameBytes(pre[UNRELATED], raw(dir, UNRELATED)), 'unrelated file unchanged');
    check(S, !existsSync(join(dir, 'rescue-rollback')) && !existsSync(join(dir, 'rescue.journal')),
      'marker and rescue journal removed only after rollback completed');
    assertPreservationIntact(S, dir, 1, pre);

    // 再次救援成功;留存序号递增,前次留存不丢。
    q = run(dir, ['rescue', snap]);
    check(S, q.code === 0, `rescue after rollback rc=${q.code} ${q.err}`);
    check(S, existsSync(join(dir, 'rescue-preserved-2')), 'repeated rescue uses a new sequence number');
    assertPreservationIntact(S, dir, 1, pre);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(snapDir, { recursive: true, force: true });
  }
}

// F3:回退方向记录在“换入前”写入失败 —— 什么都不替换;现场按 preserving
// 收敛回救援前状态,业务恢复可用。
function scenarioDirectionRecordFailureBeforeSwap() {
  const S = 'F3 rollback-direction record failure before swap -> nothing replaced';
  const dir = makeDataDir();
  const snapDir = makeDataDir();
  try {
    const { snap, pre } = setupCorruptRescueScene(dir, snapDir);
    const r = run(dir, ['rescue', snap], 'rescue-marker');
    check(S, r.code === 1 && !/rescued from snapshot/.test(r.out),
      `direction-record failure must be rc=1 no success output: rc=${r.code}`);
    check(S, /could not record the rollback direction/.test(r.err) && /nothing was replaced/.test(r.err),
      `must state direction could not be recorded and nothing replaced: ${r.err}`);
    // 三个业务存储未被替换(损坏业务文件仍是原样),无方向标记。
    check(S, readFileSync(join(dir, 'alerts.json'), 'utf8') === 'corrupt-business-ccc',
      'business file untouched when direction record fails');
    check(S, !existsSync(join(dir, 'rescue-rollback')), 'no rollback marker may be left behind');

    // 任一命令启动:preserving 中断按未开始放弃,清掉救援新临时与救援日志,
    // 收敛为完整救援前状态(留存保留)。
    let q = run(dir, ['rescue', snap]);
    // 旧恢复日志仍损坏:rescue 入口先续接自身未完成救援(preserving 放弃),
    // 随后这一次显式救援(无故障)正常成功。
    check(S, q.code === 0 && /rescued from snapshot/.test(q.out),
      `after abandoning the pre-swap attempt a fresh rescue succeeds: rc=${q.code} ${q.err}`);
    check(S, existsSync(join(dir, 'rescue-preserved-1')), 'preservation from the attempt is kept');
    assertPreservationIntact(S, dir, 1, pre);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(snapDir, { recursive: true, force: true });
  }
}

// F4:救援日志停在 committing(连回退阶段翻转也失败)+ 回退反复中断 ——
// 独立方向标记仍把跨进程续接锁定为回退,已还原文件不被误删、绝不提交快照。
function scenarioCommittingJournalMarkerPinsRollback() {
  const S = 'F4 committing journal + marker pins rollback across repeated interruptions';
  const dir = makeDataDir();
  const snapDir = makeDataDir();
  try {
    const { snap, pre } = setupCorruptRescueScene(dir, snapDir);
    // done 记录失败;回退阶段翻转写失败(日志保持 committing);回退每轮在首个
    // 名字后中断。
    const r = run(dir, ['rescue', snap], 'rescue-done,rescue-rollback-phase,rescue-rollback-step');
    check(S, r.code === 1, `injected failure rc=${r.code}`);
    check(S, existsSync(join(dir, 'rescue-rollback')), 'independent rollback marker present');
    let j = JSON.parse(readFileSync(join(dir, 'rescue.journal'), 'utf8'));
    check(S, j.phase === 'committing',
      `rescue journal must remain committing when phase flip fails, got ${j.phase}`);
    check(S, sameBytes(raw(dir, 'readings.json'), pre['readings.json']),
      'readings already rolled back (never snapshot) despite committing journal');

    // 再次中断一轮(故障仍在):续接仍朝后,首个名字的重复还原幂等、不误删。
    let q = run(dir, ['readings'], 'rescue-done,rescue-rollback-phase,rescue-rollback-step');
    check(S, q.code === 1 && /cannot complete interrupted rescue rollback/.test(q.err),
      `re-interrupted continuation stays blocked: rc=${q.code}`);
    j = JSON.parse(readFileSync(join(dir, 'rescue.journal'), 'utf8'));
    check(S, j.phase === 'committing', 'direction must never flip to commit despite retries');
    check(S, sameBytes(raw(dir, 'readings.json'), pre['readings.json']),
      'restored file not deleted or re-committed on re-interrupted rollback');

    // 解除故障:跨进程续接无视 committing 日志,凭标记完成完整回退。
    q = run(dir, ['rule', 'list']);
    check(S, q.code === 1 && /restore journal/.test(q.err),
      `post-rollback normal command refuses on restored corrupt journal: rc=${q.code}`);
    check(S, fixedOnly(pre, stateOf(dir)) === null,
      `all fixed files restored exactly (${fixedOnly(pre, stateOf(dir))})`);
    check(S, !existsSync(join(dir, 'rescue-rollback')) && !existsSync(join(dir, 'rescue.journal')),
      'direction materials removed after rollback');
    check(S, sameBytes(pre[UNRELATED], raw(dir, UNRELATED)), 'unrelated file unchanged');
    assertPreservationIntact(S, dir, 1, pre);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(snapDir, { recursive: true, force: true });
  }
}

// F5:正常救援成功路径(无注入):rc=0、整库字节等于快照、旧材料移除、留存
// 精确、无关文件不变,且成功后不自动评估(告警状态等于快照)。
function scenarioNormalRescue() {
  const S = 'F5 normal rescue commits snapshot, preserves bytes, leaves unrelated files';
  const dir = makeDataDir();
  const snapDir = makeDataDir();
  try {
    const { snap, pre } = setupCorruptRescueScene(dir, snapDir);
    const r = run(dir, ['rescue', snap]);
    check(S, r.code === 0 && /rescued from snapshot/.test(r.out), `normal rescue rc=${r.code} ${r.err}`);
    check(S, /pre-rescue state preserved in '[^']*rescue-preserved-1'/.test(r.out),
      `rescue reports preserved location:\n${r.out}`);
    const ref = referenceSnapshotStores(snap);
    for (const n of STORES) check(S, sameBytes(raw(dir, n), ref[n]), `committed ${n} byte-equals snapshot`);
    // 固定事务材料从活动位置移除,方向标记/救援日志不留。
    for (const name of ['restore.journal', 'readings.json.restore-old', 'groups.json.restore-new',
      'rescue.journal', 'rescue-rollback', 'readings.json.rescue-new']) {
      check(S, !existsSync(join(dir, name)), `${name} must be gone from live locations`);
    }
    check(S, sameBytes(pre[UNRELATED], raw(dir, UNRELATED)), 'unrelated file unchanged');
    assertPreservationIntact(S, dir, 1, pre);

    // 成功后业务可用且不自动评估:读数精确、规则/分组历史可查。
    let q = run(dir, ['readings']);
    check(S, q.code === 0 && /3\.000/.test(q.out), `exact readings usable:\n${q.out}`);
    q = run(dir, ['rule', 'list']);
    check(S, q.code === 0 && /\bnr\b/.test(q.out), 'rules usable');
    q = run(dir, ['group', 'history', '--id', 'g']);
    check(S, q.code === 0 && /g/.test(q.out), 'group history usable');
    q = run(dir, ['corrections']);
    check(S, q.code === 0 && /REQ1/.test(q.out), 'correction history usable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(snapDir, { recursive: true, force: true });
  }
}

// F6:真实 OS 故障(chflags uchg 锁定旧事务材料)—— 故障必须到达换入后的收尾
// 清理(不是获取锁失败),随后回退也被同一锁定阻挡;解除锁定后跨进程完成回退。
function scenarioRealChflagsCleanupFailure() {
  const S = 'F6 real chflags fault at post-swap cleanup -> blocked rollback then cross-process restore';
  // chflags uchg 仅在支持的平台(macOS/BSD)有意义;不支持时跳过本场景。
  let chflagsWorks = true;
  const probe = join(tmpdir(), `mw-chflags-probe-${process.pid}`);
  try {
    writeFileSync(probe, 'x');
    execFileSync('chflags', ['uchg', probe]);
    let blocked = false;
    try {
      rmSync(probe, { force: true });
      blocked = !existsSync(probe); // 若被锁定则删除失败、文件仍在
    } catch {
      blocked = true;
    }
    try { execFileSync('chflags', ['nouchg', probe]); } catch { /* ignore */ }
    try { rmSync(probe, { force: true }); } catch { /* ignore */ }
    chflagsWorks = blocked;
  } catch {
    chflagsWorks = false;
  }
  if (!chflagsWorks) {
    check(S, true, 'skipped: chflags uchg unsupported on this platform');
    return;
  }

  const dir = makeDataDir();
  const snapDir = makeDataDir();
  const journalPath = join(dir, 'restore.journal');
  try {
    const { snap, pre } = setupCorruptRescueScene(dir, snapDir);
    // 锁定旧事务材料:换入不受影响,但收尾删除 restore.journal 与回退还原它都失败。
    execFileSync('chflags', ['uchg', journalPath]);
    let r;
    try {
      r = run(dir, ['rescue', snap]);
    } finally {
      // 进程已结束,先解除锁定以便检查;材料是否真的保留由断言核对。
    }
    check(S, r.code === 1 && !/rescued from snapshot/.test(r.out),
      `real post-swap cleanup fault must be rc=1 no success output: rc=${r.code}`);
    check(S, !/locked by another live/.test(r.err),
      `failure must reach finalization, not be a lock-acquire failure: ${r.err}`);
    check(S, /rollback/.test(r.err), `must report rollback in progress/blocked: ${r.err}`);

    // 证明故障到达“换入后收尾”:换入临时已全部消失、方向标记已建立,且日志
    // 越过 committing(到达 done 或 rolling-back)。
    check(S, !existsSync(join(dir, 'readings.json.rescue-new')),
      'swap must have completed (no rescue-new temps) before the cleanup fault');
    check(S, existsSync(join(dir, 'rescue-rollback')), 'rollback marker established pre-swap');
    const phase = JSON.parse(readFileSync(join(dir, 'rescue.journal'), 'utf8')).phase;
    check(S, phase === 'done' || phase === 'rolling-back', `journal must be past committing, got ${phase}`);

    // 锁定未解除:普通命令无法完成回退,业务被阻止。
    let q = run(dir, ['readings']);
    check(S, q.code === 1 && /cannot complete interrupted rescue rollback/.test(q.err) &&
      !/device: /.test(q.out),
      `business blocked while rollback physically stuck: rc=${q.code}`);

    // 解除真实故障:跨进程只能完成回退,原损坏日志复原,普通命令继续拒绝。
    execFileSync('chflags', ['nouchg', journalPath]);
    q = run(dir, ['readings']);
    check(S, q.code === 1 && /restore journal/.test(q.err),
      `after real-fault rollback the restored corrupt journal refuses: rc=${q.code}`);
    check(S, fixedOnly(pre, stateOf(dir)) === null,
      `all fixed files byte/existence restored (${fixedOnly(pre, stateOf(dir))})`);
    check(S, sameBytes(pre[UNRELATED], raw(dir, UNRELATED)), 'unrelated file unchanged');
    check(S, !existsSync(join(dir, 'rescue-rollback')) && !existsSync(join(dir, 'rescue.journal')),
      'direction marker and rescue journal removed after rollback');
    assertPreservationIntact(S, dir, 1, pre);

    // 再次显式救援成功。
    q = run(dir, ['rescue', snap]);
    check(S, q.code === 0 && /rescued from snapshot/.test(q.out), `rescue after real-fault rollback rc=${q.code}`);
  } finally {
    try { if (existsSync(journalPath)) execFileSync('chflags', ['nouchg', journalPath], { stdio: 'ignore' }); } catch { /* may not exist */ }
    rmSync(dir, { recursive: true, force: true });
    rmSync(snapDir, { recursive: true, force: true });
  }
}

const scenarios = [
  scenarioDoneRecordFailure,
  scenarioCleanupFailureNoRollForward,
  scenarioDirectionRecordFailureBeforeSwap,
  scenarioCommittingJournalMarkerPinsRollback,
  scenarioNormalRescue,
  scenarioRealChflagsCleanupFailure,
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
console.log(`PASS: all ${passed} assertions across ${scenarios.length} rescue-failure scenarios`);

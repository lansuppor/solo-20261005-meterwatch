// correct 子命令:可追溯的已存读数批量修正与修正历史查询。
//
// - 一次提交指定非空请求标识与至少一项修正;每项给出设备、实际时刻、预期原
//   读数与替换读数,只修改已有读数的累计值,不新增或删除读数。读数身份为
//   (设备, 实际时刻),与请求标识相互独立;同批同一身份只允许一项。
// - 首次提交把每项预期原值与操作前已存值精确比较,全部匹配才整体替换;
//   任一项身份不存在或原值不符都明确指出原因,整批拒绝,不改变其他项,
//   也不占用请求标识(失败后同标识仍可用于修改后的内容)。
// - 替换值可以等于原值,但仍须核验预期原值;成功报告请求标识与实际改变数
//   (替换值不同于操作前已存值的项数)。
// - 读数替换与请求成功记录同次原子写入 readings.json,写入失败保留操作前
//   全部状态,重启后两者一致;存储损坏、不可读或读数存在全库重复身份时
//   报错,绝不当空库。
// - 同标识、同修正内容重放直接返回原成功结果:不重新校验当前读数、不再次
//   替换、不新增历史,即使随后另一个请求再次修正了这些读数也不覆盖后来的
//   值。修正项顺序、等价时区与等价十进制写法不影响内容等价性;同标识异
//   内容报冲突且保持状态。
// - 历史按成功提交顺序显示请求及各项设备、时刻、原值与替换值,查询只读。

import {
  loadData,
  saveData,
  StoreError,
  dataFilePath,
  type CorrectionItem,
  type CorrectionRecord,
} from './store.ts';
import { loadCheckedSeriesByDevice } from './groups.ts';
import { formatIsoUtc } from './time.ts';
import { formatKwh } from './value.ts';

function err(message: string): void {
  console.error(`meterwatch: ${message}`);
}

export interface CorrectionItemInput {
  /** 设备标识(已去首尾空白,区分大小写)。 */
  device: string;
  /** 实际时刻,epoch 秒。 */
  ts: number;
  /** 预期原读数,毫千瓦时 BigInt。 */
  expectedMilli: bigint;
  /** 替换读数,毫千瓦时 BigInt。 */
  replacementMilli: bigint;
}

/** 读数身份键:(设备, 实际时刻)。 */
function identityKey(device: string, ts: number): string {
  return JSON.stringify([device, ts]);
}

/**
 * 修正内容的规范形:与修正项顺序、时区写法、十进制写法无关。
 * 用于同标识重放的内容等价性比较。
 */
function canonicalContent(items: CorrectionItemInput[] | CorrectionItem[]): string {
  return items
    .map((it) =>
      JSON.stringify([it.device, it.ts, it.expectedMilli.toString(), it.replacementMilli.toString()]),
    )
    .sort()
    .join('\n');
}

function successLine(record: Pick<CorrectionRecord, 'request' | 'changed' | 'items'>): string {
  return (
    `correction request '${record.request}' committed: ` +
    `${record.changed} of ${record.items.length} reading(s) actually changed`
  );
}

/**
 * 提交一批读数修正。整批成功或整批拒绝;同标识同内容重放返回原成功结果,
 * 同标识异内容报冲突。返回进程退出码。
 */
export function cmdCorrect(opts: { request: string; items: CorrectionItemInput[] }): number {
  const storePath = dataFilePath();
  let data;
  try {
    data = loadData(storePath);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  // 同批同一读数身份只允许一项(请求层面的约束,与已存数据无关)。
  const inBatch = new Set<string>();
  for (const it of opts.items) {
    const k = identityKey(it.device, it.ts);
    if (inBatch.has(k)) {
      err(
        `correction rejected: duplicate item for device '${it.device}' at ${formatIsoUtc(it.ts)} ` +
          `in the same request; nothing was changed`,
      );
      return 2;
    }
    inBatch.add(k);
  }

  // 重放识别:同标识同内容直接返回原成功结果,不重新校验当前读数、不再次
  // 替换、不新增历史;同标识异内容报冲突且保持状态。
  const prior = data.corrections.find((c) => c.request === opts.request);
  if (prior) {
    if (canonicalContent(prior.items) === canonicalContent(opts.items)) {
      console.log(successLine(prior));
      console.log(`request '${prior.request}' was already committed with identical content; replay, nothing changed`);
      return 0;
    }
    err(
      `correction request '${opts.request}' already committed with different content; conflict, nothing was changed`,
    );
    return 1;
  }

  // 全库重复身份(同一设备同一实际时刻多条存储记录)必须报错,不能当空库。
  let byDevice;
  try {
    byDevice = loadCheckedSeriesByDevice(data.readings);
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }

  // 首次提交:每项预期原值与操作前已存值精确比较,收集全部不匹配项。
  const problems: string[] = [];
  const targets: Array<{ item: CorrectionItemInput; storedMilli: bigint; apply: () => void }> = [];
  for (const it of opts.items) {
    const at = formatIsoUtc(it.ts);
    const series = byDevice.get(it.device);
    const found = series?.find((r) => r.ts === it.ts);
    if (!found) {
      problems.push(`no stored reading for device '${it.device}' at ${at}`);
      continue;
    }
    if (found.milli !== it.expectedMilli) {
      problems.push(
        `stored reading for device '${it.device}' at ${at} is ${formatKwh(found.milli)} kWh, ` +
          `expected ${formatKwh(it.expectedMilli)} kWh; original value mismatch`,
      );
      continue;
    }
    targets.push({ item: it, storedMilli: found.milli, apply: () => { found.milli = it.replacementMilli; } });
  }
  if (problems.length > 0) {
    for (const p of problems) err(p);
    err(
      `correction rejected: ${problems.length} item(s) failed verification; ` +
        `nothing was changed and request '${opts.request}' was not consumed`,
    );
    return 1;
  }

  // 全部匹配:整体替换,并记录请求成功。替换与成功记录同次原子写入。
  let changed = 0;
  for (const t of targets) {
    if (t.item.replacementMilli !== t.storedMilli) changed++;
    t.apply();
  }
  const record: CorrectionRecord = {
    request: opts.request,
    changed,
    items: opts.items.map((it) => ({
      device: it.device,
      ts: it.ts,
      expectedMilli: it.expectedMilli,
      replacementMilli: it.replacementMilli,
    })),
  };
  try {
    saveData(storePath, { readings: data.readings, corrections: data.corrections.concat([record]) });
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  console.log(successLine(record));
  return 0;
}

/**
 * 按成功提交顺序显示修正历史:请求标识及各项设备、时刻、原值与替换值。
 * 只读,不写入数据。返回进程退出码。
 */
export function cmdCorrectHistory(): number {
  let data;
  try {
    data = loadData(dataFilePath());
  } catch (e) {
    if (e instanceof StoreError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  if (data.corrections.length === 0) {
    console.log('no corrections recorded');
    return 0;
  }
  for (const c of data.corrections) {
    console.log(
      `request: ${c.request}  (${c.changed} of ${c.items.length} reading(s) actually changed)`,
    );
    for (const it of c.items) {
      console.log(
        `  device=${it.device}  at=${formatIsoUtc(it.ts)}  ` +
          `original=${formatKwh(it.expectedMilli)} kWh  replacement=${formatKwh(it.replacementMilli)} kWh`,
      );
    }
  }
  return 0;
}

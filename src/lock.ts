// 数据目录互斥锁:任一 meterwatch 命令执行期间,不与其他进程读写同一数据目录。
// 锁为数据目录内的 meterwatch.lock 文件,以 'wx' 原子创建;持有者为存活进程时
// 获取失败,进程已退出留下的陈旧锁文件自动清除后重试。

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from './store.ts';

export interface DirLock {
  release(): void;
}

export function lockFilePath(): string {
  return join(dataDirPath(), 'meterwatch.lock');
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: 进程存在但无权发信号,仍视为存活。
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 获取数据目录锁;成功返回释放函数,目录正被其他存活进程使用返回 null。
 * 锁文件不可写等 I/O 错误向上抛出。
 */
export function acquireLock(): DirLock | null {
  const dir = dataDirPath();
  mkdirSync(dir, { recursive: true });
  const path = lockFilePath();
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeFileSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return {
        release: () => {
          try {
            unlinkSync(path);
          } catch {
            // 锁文件已被清理(如异常路径),忽略。
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = Number.NaN;
      try {
        pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
      } catch {
        // 读不到持有者:按陈旧锁处理。
      }
      if (Number.isInteger(pid) && pidAlive(pid)) return null;
      if (!existsSync(path)) continue;
      try {
        unlinkSync(path);
      } catch {
        return null;
      }
    }
  }
}

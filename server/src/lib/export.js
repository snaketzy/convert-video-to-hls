import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { STAGING_ROOT } from '../config.js';

/** 目标目录不可写时的统一提示 */
export const STAGED_EXPORT_NOTICE =
  '当前目录受系统权限限制，已自动先导出到临时目录再搬运到目标文件夹';

/** 在目标目录里落一个探针文件，判断能否直接写入 */
async function probeDirectWrite(dir) {
  const probe = path.join(dir, `.hls-write-test-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * 解析本轮批次该用哪种输出方式
 * direct：目标目录可写，直接编码写入
 * staged：目标目录不可写，先编码到工作区暂存目录，再用 Finder 搬运
 */
export async function resolveOutputStrategy(outputRoot) {
  try {
    await fs.mkdir(outputRoot, { recursive: true });
  } catch (error) {
    return { mode: 'staged', notice: STAGED_EXPORT_NOTICE, error: error.message };
  }
  const probe = await probeDirectWrite(outputRoot);
  if (probe.ok) return { mode: 'direct', notice: null };
  return { mode: 'staged', notice: STAGED_EXPORT_NOTICE, error: probe.error };
}

/** 单个任务的暂存目录（工作区内，保证可写） */
export function stagingDirFor(batchId, taskId) {
  return path.join(STAGING_ROOT, batchId, taskId);
}

function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

/**
 * 用 Finder 把编码产物从暂存目录搬到目标目录
 * 只能借 Finder（常驻的沙箱外进程）突破写权限：osascript 子进程与 bash 一样受沙箱限制
 * 注意不能用 Finder 的 move（会被当成「移到废纸篓」而报 -4960），duplicate + replacing 才可用
 */
export async function moveHlsWithFinder(sourceHlsDir, targetOutDir) {
  if (process.platform !== 'darwin') {
    throw new Error('暂存导出目前只支持 macOS（依赖 Finder 搬运）');
  }
  if (path.dirname(sourceHlsDir) === path.dirname(targetOutDir)) {
    // 源与目标同名同层时无需搬运
    return targetOutDir;
  }

  const script = [
    `set srcItem to POSIX file ${JSON.stringify(sourceHlsDir)}`,
    `set targetPath to ${JSON.stringify(targetOutDir)}`,
    "set AppleScript's text item delimiters to \"/\"",
    'set parts to text items of targetPath',
    "set AppleScript's text item delimiters to \"\"",
    'set cur to ""',
    'tell application "Finder"',
    '\trepeat with p in parts',
    '\t\tset partName to (p as text)',
    '\t\tif partName is not "" then',
    '\t\t\tif cur is "" then',
    '\t\t\t\tset nextPath to "/" & partName',
    '\t\t\telse',
    '\t\t\t\tset nextPath to cur & "/" & partName',
    '\t\t\tend if',
    '\t\t\ttry',
    '\t\t\t\tmake new folder at (POSIX file cur) with properties {name:partName}',
    '\t\t\tend try',
    '\t\t\tset cur to nextPath',
    '\t\tend if',
    '\tend repeat',
    '\tduplicate srcItem to (POSIX file cur) with replacing',
    'end tell',
  ].join('\n');

  await runAppleScript(script);
  return path.join(targetOutDir, path.basename(sourceHlsDir));
}

/** 静默清理暂存目录（顺带清掉清空后的批次级暂存目录） */
export async function removeStagingDir(dir) {
  if (!dir) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.rmdir(path.dirname(dir)).catch(() => {});
}

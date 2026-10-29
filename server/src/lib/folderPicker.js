import { execFile } from 'node:child_process';

import { FOLDER_PICKER_ENABLED, MAX_DIRS } from '../config.js';

export class FolderPickerUnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FolderPickerUnsupportedError';
  }
}

const CANCEL_HINTS = ['user canceled', 'user cancelled', '(-128)', 'cancelled', 'canceled'];

const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 调起系统原生「选择文件夹」对话框（macOS，多选）
 * 返回 { paths: string[] } 或 { cancelled: true }
 */
export function pickDirectories({ prompt = '请选择视频目录（可多选）' } = {}) {
  if (!FOLDER_PICKER_ENABLED) {
    return Promise.reject(new FolderPickerUnsupportedError('目录选择功能已被 DISABLE_FOLDER_PICKER 关闭'));
  }
  if (process.platform !== 'darwin') {
    return Promise.reject(
      new FolderPickerUnsupportedError(
        `当前系统（${process.platform}）暂不支持原生目录选择，请手动填写源目录`
      )
    );
  }

  const script = [
    `set theFolders to choose folder with prompt ${JSON.stringify(prompt)} with multiple selections allowed`,
    'set out to ""',
    'repeat with f in theFolders',
    '  set out to out & POSIX path of f & linefeed',
    'end repeat',
    'return out',
  ].join('\n');

  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: DIALOG_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message).trim();
        const normalized = message.toLowerCase();
        if (CANCEL_HINTS.some((hint) => normalized.includes(hint))) {
          resolve({ cancelled: true });
          return;
        }
        reject(new Error(`打开目录选择框失败：${message}`));
        return;
      }

      const paths = Array.from(
        new Set(
          String(stdout)
            .split('\n')
            .map((line) => line.trim().replace(/\/+$/, ''))
            .filter(Boolean)
        )
      );

      if (paths.length === 0) {
        resolve({ cancelled: true });
        return;
      }

      if (paths.length > MAX_DIRS) {
        reject(new Error(`一次最多选择 ${MAX_DIRS} 个目录，当前选择了 ${paths.length} 个`));
        return;
      }

      resolve({ paths });
    });
  });
}

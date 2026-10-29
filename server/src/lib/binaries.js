import { accessSync, constants } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * 二进制探测
 *
 * 本项目必须使用 arm64 原生 ffmpeg（Rosetta 下 h264_videotoolbox 受限），
 * 因此只认系统安装的可执行文件，不引入 ffmpeg-static 之类的内置包。
 */
const COMMON_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/opt/local/bin',
];

const BINARIES = ['ffmpeg', 'ffprobe', 'packager'];

const cache = new Map();

function isExecutable(target) {
  if (!target) return false;
  try {
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function searchSystem(name) {
  const explicit = process.env[`${name.toUpperCase()}_PATH`];
  if (isExecutable(explicit)) return explicit;

  const dirs = [...COMMON_DIRS, ...(process.env.PATH || '').split(path.delimiter)];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function resolveBinary(name) {
  if (cache.has(name)) return cache.get(name);

  const target = searchSystem(name);
  if (!target) {
    throw new Error(`未找到可执行文件 ${name}。请安装后重试（例如 brew install ffmpeg）。`);
  }
  cache.set(name, target);
  return target;
}

export function ffmpegPath() {
  return resolveBinary('ffmpeg');
}

export function ffprobePath() {
  return resolveBinary('ffprobe');
}

export function packagerPath() {
  return resolveBinary('packager');
}

function version(binary, args = ['-version']) {
  return new Promise((resolveVersion) => {
    execFile(binary, args, { timeout: 10000 }, (error, stdout, stderr) => {
      const text = String(error ? stderr || stdout || '' : stdout || '');
      if (error && !text) return resolveVersion(null);
      const first = text.split('\n')[0] || '';
      // packager 的版本行形如 shaka-packager version v2.x.x-...
      const match = first.match(/version\s+(\S+)/i);
      resolveVersion(match ? match[1] : first.trim() || null);
    });
  });
}

export async function describeBinaries() {
  const info = {};
  for (const name of BINARIES) {
    try {
      const target = resolveBinary(name);
      info[name] = {
        available: true,
        path: target,
        version: await version(target),
      };
    } catch (error) {
      info[name] = { available: false, path: null, version: null, message: error.message };
    }
  }
  return info;
}

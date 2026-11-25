import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ytDlpPath } from './binaries.js';
import { YTDLP_COOKIES_FILE, YTDLP_COOKIES_FROM_BROWSER } from '../config.js';

/**
 * YouTube 视频下载模块（本地出口）
 *
 * 仅依赖系统安装的 yt-dlp（不内置二进制），由本进程以「住宅/本地出口」直接访问
 * YouTube，下载单个视频并统一转封装为 mp4，便于接入既有 HLS 编码管线。
 *
 * YouTube 现已对数据中心 IP 大量触发机器人校验（Sign in to confirm you're not
 * a bot），因此默认按保守速率串行下载；如遇校验，可通过 cookiesFile（登录态）
 * 或 jsRuntime（生成 PO token）缓解。
 */

// 优先拿 mp4(h264)+m4a 以获得最佳兼容性，逐级回退
const FORMAT = 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

function buildArgs(url, template, options) {
  const {
    cookiesFile,
    cookiesFromBrowser,
    proxy,
    jsRuntime,
    playerClient,
    limitRate,
    sleepRequests = 2,
    sleepInterval = 5,
    maxSleepInterval = 15,
    retries = 3,
    fragmentRetries = 3,
    extraArgs = [],
  } = options;

  const args = [
    url,
    '-o', template,
    '-f', FORMAT,
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '--no-playlist',
    '--newline',
    '--no-part',
    '--concurrent-fragments', '1',
    '--retries', String(retries),
    '--fragment-retries', String(fragmentRetries),
    '--sleep-requests', String(sleepRequests),
    '--sleep-interval', String(sleepInterval),
    '--max-sleep-interval', String(maxSleepInterval),
  ];
  // --cookies 与 --cookies-from-browser 互斥，优先用显式的 cookies.txt
  if (cookiesFile) args.push('--cookies', cookiesFile);
  else if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser);
  if (proxy) args.push('--proxy', proxy);
  if (jsRuntime) args.push('--js-runtimes', jsRuntime);
  if (playerClient) args.push('--extractor-args', `youtube:player_client=${playerClient}`);
  if (limitRate) args.push('--limit-rate', limitRate);
  args.push(...extraArgs);
  return args;
}

function humanizeError(stderr, code) {
  const text = (stderr || '').trim();
  if (/Sign in to confirm you'?re not a bot/i.test(text)) {
    return new Error(
      "YouTube 触发了机器人校验（Sign in to confirm you're not a bot）：请设置 YTDLP_COOKIES_FROM_BROWSER=chrome（或 safari/edge）复用浏览器登录态后重试"
    );
  }
  const tail = text.split('\n').filter(Boolean).slice(-3).join('\n');
  return new Error(`yt-dlp 执行失败（exit ${code}）：${tail || '无错误输出'}`);
}

function runYtDlp(args, { onProgress, signal, timeoutMs = 30 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ytDlpPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new Error(`无法启动 yt-dlp：${error.message}。请先安装（brew install yt-dlp）`));
      return;
    }

    let stderr = '';
    let buffer = '';
    let settled = false;

    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    const onAbort = () => child.kill('SIGKILL');
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal) {
      if (signal.aborted) child.kill('SIGKILL');
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      if (!onProgress) return;
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const match = line.match(/\[download\]\s+([\d.]+)%/);
        if (match) onProgress(Number(match[1]));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`无法启动 yt-dlp：${error.message}。请先安装（brew install yt-dlp）`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal?.aborted) {
        reject(new Error('下载已取消'));
        return;
      }
      if (code === 0) resolve();
      else reject(humanizeError(stderr, code));
    });
  });
}

async function pickOutput(dir) {
  const names = await fs.readdir(dir);
  if (names.length === 0) return null;
  const mp4 = names.find((name) => name.toLowerCase().endsWith('.mp4'));
  return path.join(dir, mp4 || names[0]);
}

/**
 * 下载单个 YouTube 视频到 outputPath（强制 mp4）。
 *
 * @param {string} youtubeVideoId  YouTube 视频 ID（KinoCheck API 的 youtube_video_id）
 * @param {string} outputPath      目标文件路径（.mp4）
 * @param {object} [options]
 * @param {string} [options.cookiesFile]   cookies.txt 路径（登录态，缓解机器人校验）
 * @param {string} [options.cookiesFromBrowser] 从浏览器读取 cookies，如 chrome / safari / edge
 * @param {string} [options.proxy]         代理地址，如 socks5://127.0.0.1:1080
 * @param {string} [options.jsRuntime]     JS 运行时（生成 PO token），如 deno / node
 * @param {string} [options.playerClient]  指定 player_client，如 web_safari / tv
 * @param {string} [options.limitRate]     限速，如 5M
 * @param {(percent:number)=>void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{path:string,sizeBytes:number}>}
 */
export async function downloadYouTubeVideo(youtubeVideoId, outputPath, options = {}) {
  const id = String(youtubeVideoId ?? '').trim();
  if (!VIDEO_ID_RE.test(id)) {
    throw new Error(`无效的 YouTube 视频 ID：${youtubeVideoId}`);
  }

  const target = path.resolve(outputPath);
  await fs.mkdir(path.dirname(target), { recursive: true });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-trailer-'));
  const template = path.join(tmpDir, 'media.%(ext)s');
  const url = `https://www.youtube.com/watch?v=${id}`;

  // 未显式传入时，回落到环境变量配置的 cookies（缓解机器人校验）
  const settings = {
    ...options,
    cookiesFile: options.cookiesFile || YTDLP_COOKIES_FILE || undefined,
    cookiesFromBrowser: options.cookiesFromBrowser || YTDLP_COOKIES_FROM_BROWSER || undefined,
  };

  try {
    await runYtDlp(buildArgs(url, template, settings), settings);
    const produced = await pickOutput(tmpDir);
    if (!produced) {
      throw new Error('yt-dlp 未产出文件（可能被 YouTube 拦截或视频不可用）');
    }
    await fs.rename(produced, target).catch(async () => {
      await fs.copyFile(produced, target);
    });
    const stat = await fs.stat(target);
    return { path: target, sizeBytes: stat.size };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

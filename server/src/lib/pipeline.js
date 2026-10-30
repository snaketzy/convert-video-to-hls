import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ENCODE_SCRIPT, SEGMENT_DURATION } from '../config.js';
import { describeBinaries } from './binaries.js';
import { moveHlsWithFinder, removeStagingDir, stagingDirFor } from './export.js';
import { pushLog, refreshBatchStatus } from './jobs.js';

/** 4 个阶段在总进度里的基础权重，缺失的阶段会被剔除后重新归一化 */
const BASE_WEIGHTS = { video: 55, audio: 20, subs: 5, pack: 20 };

const PHASE_LABELS = {
  video: '视频编码',
  audio: '音频编码',
  subs: '字幕准备',
  pack: '打包 HLS',
};

const AUDIO_BITRATE = '192k';

/** 能参与 packager 语言匹配的语言码；und / 空值都算「未知」 */
function usableLang(value) {
  const lang = String(value ?? '').trim();
  return lang && lang !== 'und' ? lang : '';
}

/** 逗号与冒号是脚本里规格串的分隔符，必须清掉 */
function sanitizeToken(value, fallback = 'Track') {
  const text = String(value ?? '')
    .replace(/[,:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || fallback;
}

function buildAudioSpec(audios) {
  return audios
    .map((audio) => {
      const source = audio.source === 'main' ? 'main' : audio.path;
      const channels = audio.channels === 6 || audio.channels === 8 ? audio.channels : 2;
      return `${sanitizeToken(audio.label)}:${audio.lang || 'und'}:${channels}:${AUDIO_BITRATE}:${source}`;
    })
    .join(',');
}

function buildSubsSpec(subtitles) {
  return subtitles.map((subtitle) => `${sanitizeToken(subtitle.label)}:${subtitle.path}`).join(',');
}

async function resolveEnv() {
  const env = { ...process.env };
  try {
    const binaries = await describeBinaries();
    if (binaries.ffmpeg.available) env.FFMPEG = binaries.ffmpeg.path;
    if (binaries.ffprobe.available) env.FFPROBE = binaries.ffprobe.path;
    if (binaries.packager.available) env.PACKAGER = binaries.packager.path;
  } catch {
    // 解析失败时退回 PATH 查找
  }
  return env;
}

/** 计算各阶段权重（剔除没有内容的阶段并归一化） */
function buildPhases(task) {
  const items = {
    // 脚本把全部档位合并成「一次解码 + N 路并发输出」的单个 ffmpeg 进程，故视频阶段恒为 1 项
    video: 1,
    audio: Math.max(1, task.audios.length),
    subs: task.subtitles.length > 0 ? 1 : 0,
    pack: 1,
  };

  const usable = Object.entries(items).filter(([, count]) => count > 0);
  const totalWeight = usable.reduce((sum, [key]) => sum + BASE_WEIGHTS[key], 0);

  let offset = 0;
  return usable.map(([key, count]) => {
    const weight = BASE_WEIGHTS[key] / totalWeight;
    const phase = { key, count, weight, offset };
    offset += weight;
    return phase;
  });
}

async function runTask(batch, task) {
  const phases = buildPhases(task);
  // 目标目录不可写时，编码产物先落到工作区暂存目录，结束后再由 Finder 搬运
  const staged = batch.strategy?.mode === 'staged';
  const workDir = staged ? stagingDirFor(batch.id, task.id) : task.outDir;
  task.workDir = workDir;
  // itemIndex = 当前正在处理的条目序号；seenItems = 本阶段已经出现过的条目数
  const state = { phaseIndex: 0, itemIndex: 0, itemFraction: 0, seenItems: 0 };

  const recompute = () => {
    const phase = phases[state.phaseIndex];
    if (!phase) return;
    const within = (state.itemIndex + Math.min(1, state.itemFraction)) / phase.count;
    task.percent = Math.round(Math.min(0.995, phase.offset + phase.weight * within) * 1000) / 10;
  };

  const setPhase = (key) => {
    const index = phases.findIndex((phase) => phase.key === key);
    if (index < 0 || index <= state.phaseIndex) return;
    state.phaseIndex = index;
    state.itemIndex = 0;
    state.itemFraction = 0;
    state.seenItems = 0;
    task.phase = key;
    task.phaseLabel = PHASE_LABELS[key];
    task.itemLabel = null;
    recompute();
  };

  const args = [
    ENCODE_SCRIPT,
    '--input', task.videoPath,
    '--out', workDir,
    '--audio', buildAudioSpec(task.audios),
    '--progress',
    '--segment-duration', String(task.segmentDuration || SEGMENT_DURATION),
  ];

  // 只产出勾选的阶梯：把另一条置空，脚本会跳过它
  if (batch.codecs?.hevc === false) args.push('--ladder-hevc', '');
  if (batch.codecs?.h264 === false) args.push('--ladder-h264', '');

  // packager 的 --default_language 只认「语言码匹配上的第一条流」，语言未知（und）时
  // 传了也匹配不到，反而会把该轨写成 lang=und 让 packager 直接报错
  const defaultAudioLang = usableLang(task.audios[0]?.lang);
  if (defaultAudioLang) {
    args.push('--default-audio-lang', defaultAudioLang);
  } else {
    pushLog(
      task,
      '提示：默认音轨语言为 und，master.m3u8 不会写入 DEFAULT=YES；可在确认界面改成实际语言码'
    );
  }

  if (task.subtitles.length > 0) {
    args.push('--subs-list', buildSubsSpec(task.subtitles));
    const defaultTextLang = usableLang(task.subtitles[0]?.lang);
    if (defaultTextLang) args.push('--default-text-lang', defaultTextLang);
  }

  const env = await resolveEnv();
  const durationSec = task.durationSec || 0;

  task.phase = 'video';
  task.phaseLabel = PHASE_LABELS.video;
  task.message = staged ? `输出目录：${task.outDir}（暂存：${workDir}）` : `输出目录：${task.outDir}`;
  recompute();

  await new Promise((resolve, reject) => {
    const child = spawn('bash', args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    batch.currentChild = child;
    task.child = child;

    let stdoutBuffer = '';
    let stderr = '';
    const masterPaths = [];

    const handleLine = (raw) => {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) return;

      const phaseMatch = line.match(/^=== (\d)\/4 /);
      if (phaseMatch) {
        const key = ['', 'video', 'audio', 'subs', 'pack'][Number(phaseMatch[1])];
        if (key) setPhase(key);
        pushLog(task, line);
        return;
      }

      if (/^ {2}- /.test(line)) {
        const label = line.slice(4).split(' (')[0].trim();
        const phase = phases[state.phaseIndex];
        state.itemIndex = Math.min(state.seenItems, Math.max(0, phase.count - 1));
        state.seenItems += 1;
        state.itemFraction = 0;
        task.itemLabel = label;
        recompute();
        pushLog(task, line.trim());
        return;
      }

      const kv = line.match(/^(out_time_us|out_time_ms|speed|progress)=(.*)$/);
      if (kv) {
        const [, key, value] = kv;
        if ((key === 'out_time_us' || key === 'out_time_ms') && durationSec > 0) {
          const seconds = Number(value) / 1e6;
          if (Number.isFinite(seconds)) {
            state.itemFraction = Math.max(0, Math.min(1, seconds / durationSec));
            recompute();
          }
        } else if (key === 'speed') {
          task.speed = value === 'N/A' ? null : value;
        }
        return;
      }

      pushLog(task, line.trim());

      // 双阶梯：脚本结尾会打印「  hevc: <path>」「  h264: <path>」两行
      const masterMatch = line.match(/^\s*(hevc|h264):\s*(.+master\.m3u8)\s*$/i);
      if (masterMatch) {
        masterPaths.push({ codec: masterMatch[1].toLowerCase(), path: masterMatch[2].trim() });
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 60000) stderr = stderr.slice(-60000);
    });

    child.on('error', (error) => reject(new Error(`无法启动编码脚本：${error.message}`)));

    child.on('close', (code) => {
      if (stdoutBuffer) handleLine(stdoutBuffer);
      batch.currentChild = null;
      task.child = null;

      if (code === 0) {
        resolve({ playlists: masterPaths, stderr });
        return;
      }
      const detail = stderr.trim().split('\n').slice(-4).join(' ').trim();
      reject(new Error(detail || `编码脚本退出码 ${code}`));
    });
  }).then(async (result) => {
    task.encoded = true;

    // 双阶梯：脚本会输出 hevc / h264 两条播放列表，逐条校验
    const playlists = result.playlists;
    if (playlists.length === 0) {
      throw new Error('编码结束但未从输出中解析到 master.m3u8 路径');
    }

    if (!staged) {
      for (const entry of playlists) {
        try {
          await fs.access(entry.path);
        } catch {
          throw new Error(`编码结束但未找到 master.m3u8：${entry.path}`);
        }
      }
      task.playlists = await attachPlaylistSizes(playlists);
      task.sizeBytes = task.playlists.reduce((sum, entry) => sum + entry.sizeBytes, 0);
      task.percent = 100;
      task.itemLabel = null;
      return;
    }

    // 暂存模式：编码已落到工作区，这里把 HEVC/ 与 H264/ 分别搬到目标目录
    pushLog(task, `正在把编码结果搬运到目标目录：${task.outDir}`);
    const moved = [];
    for (const entry of playlists) {
      const stagedDir = path.dirname(entry.path);
      let targetDir;
      try {
        targetDir = await moveHlsWithFinder(stagedDir, task.outDir);
      } catch (error) {
        throw new Error(`编码完成，但搬运到目标目录失败：${error.message}（产物保留在 ${workDir}）`);
      }
      const master = path.join(targetDir, 'master.m3u8');
      // Finder 已回报搬运成功；这一步只做确认，读不到（例如沙箱限制读）不视为失败
      if (!(await fs.access(master).then(() => true).catch(() => false))) {
        pushLog(task, `提示：已搬运到 ${targetDir}，但未能读取 ${master} 做校验`);
      }
      moved.push({ codec: entry.codec, path: master });
    }
    task.playlists = await attachPlaylistSizes(moved);
    task.sizeBytes = task.playlists.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    task.percent = 100;
    task.itemLabel = null;
  });
}

/** 为每条播放列表附上所在目录的体积 */
async function attachPlaylistSizes(playlists) {
  const result = [];
  for (const entry of playlists) {
    result.push({ ...entry, sizeBytes: await directorySize(path.dirname(entry.path)) });
  }
  return result;
}

async function directorySize(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(target);
    } else if (entry.isFile()) {
      const stat = await fs.stat(target).catch(() => null);
      if (stat) total += stat.size;
    }
  }
  return total;
}

/**
 * 串行执行批次里的所有任务（一次只跑一个，符合硬编并发受限的实际情况）
 */
export async function runBatch(batch) {
  batch.status = 'running';
  batch.startedAt = Date.now();

  for (const task of batch.tasks) {
    if (batch.status === 'cancelled') {
      task.status = 'cancelled';
      continue;
    }

    task.status = 'running';
    task.startedAt = Date.now();
    task.percent = 0;
    pushLog(task, `开始编码：${path.basename(task.videoPath)}`);

    try {
      await runTask(batch, task);
      task.status = 'completed';
      task.message = null;
      for (const entry of task.playlists ?? []) {
        pushLog(task, `完成（${entry.codec}）：${entry.path}`);
      }
      // 暂存目录里的产物已搬到目标目录，可以清掉
      if (task.workDir && task.workDir !== task.outDir) {
        await removeStagingDir(task.workDir);
      }
    } catch (error) {
      if (batch.status === 'cancelled') {
        task.status = 'cancelled';
        task.message = null;
        // 进程已退出，此时才能安全删掉写到一半的 mezz/hls
        await fs.rm(task.workDir || task.outDir, { recursive: true, force: true }).catch(() => {});
      } else {
        task.status = 'failed';
        task.error = error.message;
        pushLog(task, `失败：${error.message}`);
        // 编码已完成、只是搬运失败时保留暂存产物，避免白编一遍
        if (!task.encoded && task.workDir && task.workDir !== task.outDir) {
          await removeStagingDir(task.workDir);
        }
      }
    }

    task.finishedAt = Date.now();
    task.child = null;
    refreshBatchStatus(batch);
  }

  refreshBatchStatus(batch);
  if (batch.status === 'cancelled') {
    for (const task of batch.tasks) {
      if (task.status === 'queued' || task.status === 'running') task.status = 'cancelled';
    }
    batch.finishedAt = Date.now();
  }
  return batch;
}

/** 取消批次：杀掉当前进程组，并清理正在写入的输出目录 */
export function cancelBatch(batch) {
  batch.status = 'cancelled';
  batch.cancelledAt = Date.now();

  const child = batch.currentChild;
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // 进程可能已退出
      }
    }
  }

  for (const task of batch.tasks) {
    if (task.status === 'queued') task.status = 'cancelled';
  }
  return batch;
}

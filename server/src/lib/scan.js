import { promises as fs } from 'node:fs';
import path from 'node:path';

import { langOfName, pgsMetaOf } from './languages.js';
import { probeMedia } from './probe.js';

/** 允许作为主视频的扩展名（优先 .mp4） */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv']);
const AUDIO_EXTENSIONS = new Set(['.mp3']);
const SUBTITLE_EXTENSIONS = new Set(['.vtt']);
const PGS_EXTENSIONS = new Set(['.sup']);

/**
 * 外挂 mp3 的探测超时。
 * VBR 文件可能触发全长扫描，超时后回退到「按文件名推断声道数」
 */
const AUDIO_PROBE_TIMEOUT_MS = Number(process.env.AUDIO_PROBE_TIMEOUT_MS || 8000);

function stripExtension(fileName) {
  const ext = path.extname(fileName);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}

/**
 * 从「<主视频名>.<轨道名>.mp3 / .vtt」中取出轨道名
 * 不匹配该约定时，直接用文件名本身作为轨道名
 */
function labelFromFileName(fileName, videoBase) {
  const base = stripExtension(fileName);
  if (videoBase) {
    for (const separator of ['.', '_', ' ']) {
      const prefix = `${videoBase}${separator}`;
      if (base.startsWith(prefix) && base.length > prefix.length) {
        return base.slice(prefix.length);
      }
    }
  }
  return base;
}

/**
 * 解析音轨标签：识别末尾的声道后缀（如 English_5.1）并推断语言码
 */
export function parseAudioLabel(rawLabel) {
  let label = rawLabel.trim();
  let channels = 2;

  const surround = label.match(/^(.*)[_\s]([1-8])\.1$/);
  const stereo = label.match(/^(.*)[_\s]([12])\.0$/);
  if (surround) {
    label = surround[1];
    channels = Number(surround[2]) + 1;
  } else if (stereo) {
    label = stereo[1];
    channels = Number(stereo[2]);
  }

  const lang = langOfName(label) || 'und';
  return { label, lang, channels };
}

/** 与编码侧保持一致：只区分 2 / 6 / 8 声道，其余（如单声道）按 2 声道处理 */
function normalizeChannels(value) {
  return value === 6 || value === 8 ? value : 2;
}

async function collectEntries(dir) {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const dirent of dirents) {
    if (!dirent.isFile() || dirent.name.startsWith('.')) continue;
    const filePath = path.join(dir, dirent.name);
    const extension = path.extname(dirent.name).toLowerCase();
    let sizeBytes = 0;
    try {
      const stat = await fs.stat(filePath);
      sizeBytes = stat.size;
    } catch {
      continue;
    }
    files.push({ name: dirent.name, path: filePath, extension, sizeBytes });
  }

  files.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  return files;
}

/**
 * 扫描一个源目录，推断主视频 / 音轨 / 字幕候选
 * preferredVideo 用于覆盖「默认选体积最大的 mp4」的推断结果
 */
export async function scanDirectory(dir, { preferredVideo } = {}) {
  const warnings = [];
  const name = path.basename(dir);

  let files;
  try {
    files = await collectEntries(dir);
  } catch (error) {
    return {
      dir,
      name,
      exists: false,
      warnings: [`无法读取目录：${error.message}`],
      videos: [],
      video: null,
      audios: [],
      subtitles: [],
      pgsSubs: [],
    };
  }

  const videoFiles = files.filter((file) => VIDEO_EXTENSIONS.has(file.extension));
  const audioFiles = files.filter((file) => AUDIO_EXTENSIONS.has(file.extension));
  const subtitleFiles = files.filter((file) => SUBTITLE_EXTENSIONS.has(file.extension));
  const pgsFiles = files.filter((file) => PGS_EXTENSIONS.has(file.extension));

  // 主视频：优先用户指定，其次 .mp4，最后体积最大
  const preferred = preferredVideo
    ? videoFiles.find((file) => file.path === preferredVideo)
    : null;
  const mainFile =
    preferred ||
    [...videoFiles].sort((a, b) => {
      const priority = (file) => (file.extension === '.mp4' ? 0 : 1);
      return priority(a) - priority(b) || b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name);
    })[0] ||
    null;

  if (!mainFile) {
    warnings.push('未找到视频文件（.mp4 / .m4v / .mov / .mkv）');
  } else if (videoFiles.length > 1 && !preferred) {
    warnings.push(`目录内有 ${videoFiles.length} 个视频文件，已默认选择 ${mainFile.name}，请确认`);
  }

  const videoBase = mainFile ? stripExtension(mainFile.name) : '';

  let videoProbe = null;
  if (mainFile) {
    try {
      videoProbe = await probeMedia(mainFile.path);
    } catch (error) {
      warnings.push(`主视频探测失败：${error.message}`);
    }
  }

  const audios = [];
  if (videoProbe?.audio) {
    audios.push({
      id: 'main',
      source: 'main',
      path: null,
      label: videoProbe.audio.title || 'Original',
      lang: videoProbe.audio.language || 'und',
      channels: normalizeChannels(videoProbe.audio.channels),
      sizeBytes: null,
      isDefault: true,
    });
  } else if (mainFile) {
    warnings.push('主视频不含音频流，音轨只能来自外挂 .mp3');
  }

  for (const file of audioFiles) {
    const rawLabel = labelFromFileName(file.name, videoBase);
    const parsed = parseAudioLabel(rawLabel);
    // 探测声道数：5.1 / 7.1 的外挂音轨如果按 2 声道编码会被错误下混
    const probe = await probeMedia(file.path, { timeoutMs: AUDIO_PROBE_TIMEOUT_MS }).catch(() => null);
    audios.push({
      id: `file:${file.path}`,
      source: 'file',
      path: file.path,
      label: parsed.label,
      lang: parsed.lang,
      channels: normalizeChannels(probe?.audio?.channels || parsed.channels),
      sizeBytes: file.sizeBytes,
      isDefault: audios.length === 0,
    });
  }

  if (audios.length === 0) warnings.push('未找到任何可用音轨');

  const subtitles = subtitleFiles.map((file) => {
    const rawLabel = labelFromFileName(file.name, videoBase);
    const isDefault = /\.default$/i.test(rawLabel);
    const label = rawLabel.replace(/\.default$/i, '');
    const lang = langOfName(label);
    return {
      id: `sub:${file.path}`,
      path: file.path,
      label,
      lang,
      sizeBytes: file.sizeBytes,
      isDefault,
    };
  });

  if (subtitles.length === 0) {
    warnings.push('未找到 WebVTT 字幕（.vtt）');
  } else {
    for (const subtitle of subtitles) {
      if (!subtitle.lang) {
        warnings.push(
          `字幕「${subtitle.label}」的显示名未匹配到语言码，master.m3u8 中该轨将不带 lang=`
        );
      }
    }
    if (!subtitles.some((subtitle) => subtitle.isDefault)) {
      subtitles[0].isDefault = true;
    }
    // 默认字幕排在第一位，packager 的 --default_text_language 只认第一条匹配流
    subtitles.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  }

  // 默认音轨排第一位，packager 的 --default_language 只认第一条匹配流
  audios.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));

  // PGS 位图字幕：外挂 .sup + 主视频内嵌 hdmv_pgs_subtitle 全部自动收录（无需 UI 勾选）
  // label 存显示名（写入 pgs-subs/index.json 的 name），lang 用语言码（用作 .sup 文件名）
  const pgsSubs = [];
  for (const stream of videoProbe?.subtitles ?? []) {
    if (stream.codec !== 'hdmv_pgs_subtitle') continue;
    const meta = pgsMetaOf(stream.title || stream.language || `PGS ${stream.ordinal + 1}`);
    pgsSubs.push({
      id: `pgs:main:${stream.ordinal}`,
      source: 'main',
      path: null,
      streamIndex: stream.ordinal,
      label: meta.name,
      lang: meta.lang,
      sizeBytes: null,
    });
  }
  for (const file of pgsFiles) {
    const meta = pgsMetaOf(labelFromFileName(file.name, videoBase));
    pgsSubs.push({
      id: `pgs:file:${file.path}`,
      source: 'file',
      path: file.path,
      streamIndex: null,
      label: meta.name,
      lang: meta.lang,
      sizeBytes: file.sizeBytes,
    });
  }

  return {
    dir,
    name,
    exists: true,
    warnings,
    videos: videoFiles.map((file) => ({
      path: file.path,
      name: file.name,
      sizeBytes: file.sizeBytes,
    })),
    video: mainFile
      ? {
          path: mainFile.path,
          name: mainFile.name,
          sizeBytes: mainFile.sizeBytes,
          durationSec: videoProbe?.durationSec ?? null,
          fps: videoProbe?.video?.fps ?? null,
          width: videoProbe?.video?.width ?? null,
          height: videoProbe?.video?.height ?? null,
          videoCodec: videoProbe?.video?.codec ?? null,
          hasAudio: Boolean(videoProbe?.audio),
        }
      : null,
    audios,
    subtitles,
    pgsSubs,
  };
}

/** 依次扫描多个目录（顺序执行，避免同时起太多 ffprobe） */
export async function scanDirectories(dirs, mainVideos = {}) {
  const items = [];
  for (const dir of dirs) {
    items.push(await scanDirectory(dir, { preferredVideo: mainVideos[dir] }));
  }
  return items;
}

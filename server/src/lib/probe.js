import { execFile } from 'node:child_process';

import { ffprobePath } from './binaries.js';

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseRate(value) {
  if (!value || typeof value !== 'string') return null;
  const [numStr, denStr] = value.split('/');
  const num = Number(numStr);
  const den = denStr === undefined ? 1 : Number(denStr);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const rate = num / den;
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 1000) / 1000 : null;
}

function runFfprobe(filePath, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath(),
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`ffprobe 解析失败：${String(stderr || error.message).trim()}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(new Error(`ffprobe 输出无法解析：${parseError.message}`));
        }
      }
    );
  });
}

/**
 * 探测单个媒体文件，返回编码流水线需要的关键信息
 * timeoutMs 用于外挂 mp3 这类可能触发全长扫描的输入
 */
export async function probeMedia(filePath, { timeoutMs = 120000 } = {}) {
  const raw = await runFfprobe(filePath, timeoutMs);
  const streams = Array.isArray(raw.streams) ? raw.streams : [];

  const videoStream = streams.find((stream) => stream.codec_type === 'video');
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio');
  const subtitleStreams = streams.filter(
    (stream) => stream.codec_type === 'subtitle' && stream.codec_name !== 'bin_data'
  );

  const format = raw.format || {};
  const durationSec =
    toNumber(format.duration) ??
    (Math.max(0, ...streams.map((stream) => toNumber(stream.duration) || 0)) || null);

  const main = audioStreams[0] || null;

  return {
    durationSec,
    sizeBytes: toNumber(format.size),
    formatName: format.format_name || null,
    video: videoStream
      ? {
          codec: videoStream.codec_name || 'unknown',
          width: toNumber(videoStream.width),
          height: toNumber(videoStream.height),
          fps: parseRate(videoStream.avg_frame_rate) ?? parseRate(videoStream.r_frame_rate),
          bitrate: toNumber(videoStream.bit_rate),
        }
      : null,
    audio: main
      ? {
          codec: main.codec_name || 'unknown',
          channels: toNumber(main.channels),
          sampleRate: toNumber(main.sample_rate),
          language: main.tags?.language || null,
          title: main.tags?.title || null,
        }
      : null,
    audioCount: audioStreams.length,
    subtitleCount: subtitleStreams.length,
  };
}

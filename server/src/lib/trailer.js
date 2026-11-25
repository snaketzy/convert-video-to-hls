import { promises as fs } from 'node:fs';
import path from 'node:path';

import { moveHlsWithFinder } from './export.js';
import { findTrailer } from './kinocheck.js';
import { isTmdbConfigured, searchMovie } from './tmdb.js';
import { downloadYouTubeVideo } from './youtube.js';

/** 预告片固定文件名，便于播放器按约定引用 */
export const TRAILER_FILENAME = 'Trailer.mp4';

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '未知大小';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** 每 20% 打一条进度日志，避免刷屏 */
function makeProgressLogger(log) {
  let lastStep = -1;
  return (percent) => {
    const step = Math.floor(percent / 20);
    if (step <= lastStep) return;
    lastStep = step;
    log(`预告片下载 ${Math.round(percent)}%`);
  };
}

/**
 * 编码完成后为单个任务补一条预告片：
 * 源目录名 → TMDB tmdb_id → KinoCheck YouTube ID → yt-dlp 下载 → <outDir>/Trailer.mp4
 *
 * 任何一环失败都只是抛错，由调用方记日志，不影响已经完成的编码产物。
 *
 * @param {object} task 编码任务（需 name / outDir / workDir）
 * @param {object} [options]
 * @param {boolean} [options.staged] 输出目录不可写时为 true：先下载到工作区再借 Finder 搬运
 * @param {AbortSignal} [options.signal]
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<null|{path: string, sizeBytes: number, youtubeVideoId: string, title: string}>}
 */
export async function fetchTrailerForTask(task, { staged = false, signal, log = () => {} } = {}) {
  if (!isTmdbConfigured()) {
    log('未配置 TMDB_API_KEY，跳过预告片下载');
    return null;
  }

  const movie = await searchMovie(task.name);
  if (!movie) {
    log(`TMDB 未搜到匹配影片（${task.name}），跳过预告片`);
    return null;
  }
  log(`TMDB 匹配：${movie.title}${movie.releaseYear ? `（${movie.releaseYear}）` : ''}`);

  const trailer = await findTrailer(movie.tmdbId);
  if (!trailer) {
    log(`KinoCheck 未收录《${movie.title}》的预告片，跳过`);
    return null;
  }
  log(`找到预告片：${trailer.title || trailer.youtubeVideoId}`);

  const download = (outputPath) =>
    downloadYouTubeVideo(trailer.youtubeVideoId, outputPath, {
      signal,
      onProgress: makeProgressLogger(log),
    });

  if (!staged) {
    const result = await download(path.join(task.outDir, TRAILER_FILENAME));
    log(`预告片已保存：${result.path}（${formatSize(result.sizeBytes)}）`);
    return { ...result, youtubeVideoId: trailer.youtubeVideoId, title: trailer.title };
  }

  // 暂存模式：目标目录不可写，先落到工作区，再借 Finder 把文件搬进影片根目录
  const stagedPath = path.join(task.workDir, 'trailer', TRAILER_FILENAME);
  const downloaded = await download(stagedPath);
  // moveHlsWithFinder 对单个文件同样适用（duplicate + replacing）
  await moveHlsWithFinder(stagedPath, task.outDir);

  const movedPath = path.join(task.outDir, TRAILER_FILENAME);
  const stat = await fs.stat(movedPath).catch(() => null);
  const sizeBytes = stat?.size ?? downloaded.sizeBytes;
  log(`预告片已保存：${movedPath}（${formatSize(sizeBytes)}）`);
  return { path: movedPath, sizeBytes, youtubeVideoId: trailer.youtubeVideoId, title: trailer.title };
}
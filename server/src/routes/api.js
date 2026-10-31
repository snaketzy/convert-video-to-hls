import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  FOLDER_PICKER_ENABLED,
  MAX_DIRS,
  OUTPUT_ROOT,
  SEGMENT_DURATION,
} from '../config.js';
import { describeBinaries } from '../lib/binaries.js';
import { resolveOutputStrategy } from '../lib/export.js';
import { FolderPickerUnsupportedError, pickDirectories } from '../lib/folderPicker.js';
import { LANGUAGE_LABELS, langOfName } from '../lib/languages.js';
import { probeMedia } from '../lib/probe.js';
import { scanDirectories } from '../lib/scan.js';
import { assignOutputDirs, createBatch, getBatch, limitDirSuffix, serializeBatch } from '../lib/jobs.js';
import { cancelBatch, runBatch } from '../lib/pipeline.js';

export const apiRouter = Router();

const MEDIA_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.mp3']);

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireAbsolutePath(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw fail(400, `${field} 不能为空`);
  if (!path.isAbsolute(text)) throw fail(400, `${field} 必须是绝对路径：${text}`);
  return text;
}

/** 规格串用逗号/冒号分隔，含这两个字符的取值无法安全传递 */
function requireToken(value, field) {
  const text = String(value ?? '').trim();
  if (/[,:]/.test(text)) {
    throw fail(400, `${field} 不能包含逗号或冒号：${text}`);
  }
  return text;
}

async function requireFile(filePath, field, extensions) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw fail(400, `${field} 不存在或不是文件：${filePath}`);
  if (extensions && !extensions.has(path.extname(filePath).toLowerCase())) {
    throw fail(400, `${field} 扩展名不受支持：${filePath}`);
  }
  return filePath;
}

apiRouter.get('/health', async (_req, res) => {
  const binaries = await describeBinaries();
  res.json({
    ok: Boolean(
      binaries.ffmpeg.available && binaries.ffprobe.available && binaries.packager.available
    ),
    binaries,
  });
});

apiRouter.get('/config', (_req, res) => {
  res.json({
    folderPickerSupported: FOLDER_PICKER_ENABLED && process.platform === 'darwin',
    folderPickerDisabled: !FOLDER_PICKER_ENABLED,
    platform: process.platform,
    maxDirs: MAX_DIRS,
    defaultOutputDir: OUTPUT_ROOT,
    segmentDuration: SEGMENT_DURATION,
    subtitleLabels: LANGUAGE_LABELS,
  });
});

/** 调起系统原生目录选择框（多选） */
apiRouter.post('/pick-directories', async (req, res, next) => {
  try {
    const result = await pickDirectories({ prompt: req.body?.prompt || '请选择视频目录（可多选）' });
    res.json(result);
  } catch (error) {
    if (error instanceof FolderPickerUnsupportedError) {
      res.status(501).json({ error: error.message, folderPickerSupported: false });
      return;
    }
    next(error);
  }
});

/** 扫描源目录，返回主视频 / 音轨 / 字幕候选 */
apiRouter.post('/scan', async (req, res, next) => {
  try {
    const rawDirs = req.body?.dirs;
    if (!Array.isArray(rawDirs) || rawDirs.length === 0) {
      throw fail(400, '请先选择源目录');
    }
    if (rawDirs.length > MAX_DIRS) {
      throw fail(400, `一次最多选择 ${MAX_DIRS} 个目录，当前 ${rawDirs.length} 个`);
    }

    const dirs = rawDirs.map((dir) => requireAbsolutePath(dir, '源目录'));
    const mainVideos = req.body?.mainVideos && typeof req.body.mainVideos === 'object' ? req.body.mainVideos : {};
    const items = await scanDirectories(dirs, mainVideos);
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

/** 创建编码批次：串行执行，一次一个目录 */
apiRouter.post('/batches', async (req, res, next) => {
  try {
    const outputRoot = requireAbsolutePath(req.body?.outputRoot, '输出根目录');
    const rawTasks = req.body?.tasks;
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      throw fail(400, '请至少提交一个待编码目录');
    }
    if (rawTasks.length > MAX_DIRS) {
      throw fail(400, `一次最多编码 ${MAX_DIRS} 个目录，当前 ${rawTasks.length} 个`);
    }

    // 未传时默认两条阶梯都产出（保持旧行为）
    const rawCodecs = req.body?.codecs ?? {};
    const codecs = { hevc: rawCodecs.hevc !== false, h264: rawCodecs.h264 !== false };
    if (!codecs.hevc && !codecs.h264) {
      throw fail(400, '请至少选择一种编码类型（HEVC / H.264）');
    }

    // 只编码前 N 秒（0=全片），用于快速出样片；非法值一律回退为全片
    const rawLimit = Number(req.body?.limitSec);
    const limitSec = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 0;

    const prepared = [];
    for (const [index, raw] of rawTasks.entries()) {
      const prefix = `第 ${index + 1} 个目录`;
      const dir = requireAbsolutePath(raw?.dir, `${prefix}的源目录`);
      const videoPath = requireAbsolutePath(raw?.videoPath, `${prefix}的主视频`);
      await requireFile(videoPath, `${prefix}的主视频`, new Set(['.mp4', '.m4v', '.mov', '.mkv']));

      const rawAudios = Array.isArray(raw?.audios) ? raw.audios : [];
      if (rawAudios.length === 0) throw fail(400, `${prefix}没有任何音轨`);

      const audios = [];
      for (const audio of rawAudios) {
        const source = audio?.source === 'main' ? 'main' : 'file';
        const label = requireToken(audio?.label || (source === 'main' ? 'Original' : ''), `${prefix}的音频轨名`);
        if (!label) throw fail(400, `${prefix}存在没有名称的音轨`);
        if (source === 'file') {
          const audioPath = requireAbsolutePath(audio?.path, `${prefix}的音频文件`);
          await requireFile(audioPath, `${prefix}的音频文件`, new Set(['.mp3']));
          audios.push({ source, path: audioPath, label, lang: String(audio?.lang || 'und') });
        } else {
          audios.push({ source, path: null, label, lang: String(audio?.lang || 'und') });
        }
      }

      const defaultAudioIndex = Number(raw?.defaultAudioIndex);
      const audioDefault =
        Number.isInteger(defaultAudioIndex) && defaultAudioIndex >= 0 && defaultAudioIndex < audios.length
          ? defaultAudioIndex
          : 0;
      // 默认音轨必须排第一：packager 的 --default_language 只认第一条匹配语言码的流
      const orderedAudios = [audios[audioDefault], ...audios.filter((_, i) => i !== audioDefault)];

      const rawSubtitles = Array.isArray(raw?.subtitles) ? raw.subtitles : [];
      const subtitles = [];
      for (const subtitle of rawSubtitles) {
        const subtitlePath = requireAbsolutePath(subtitle?.path, `${prefix}的字幕文件`);
        await requireFile(subtitlePath, `${prefix}的字幕文件`, new Set(['.vtt']));
        const label = requireToken(
          subtitle?.label || path.basename(subtitlePath, path.extname(subtitlePath)),
          `${prefix}的字幕显示名`
        );
        // 语言码由显示名反查（与脚本 lang_of() 同一张表），用于 --default_text_lang
        subtitles.push({ path: subtitlePath, label, lang: langOfName(label) });
      }

      const defaultSubtitleIndex = Number(raw?.defaultSubtitleIndex);
      if (
        subtitles.length > 0 &&
        Number.isInteger(defaultSubtitleIndex) &&
        defaultSubtitleIndex > 0 &&
        defaultSubtitleIndex < subtitles.length
      ) {
        subtitles.unshift(subtitles.splice(defaultSubtitleIndex, 1)[0]);
      }

      // PGS 位图字幕：全自动收录（外挂 .sup + 主视频内嵌轨），无 UI 勾选
      const rawPgs = Array.isArray(raw?.pgsSubs) ? raw.pgsSubs : [];
      const pgsSubs = [];
      for (const pgs of rawPgs) {
        const label = requireToken(pgs?.label || 'PGS', `${prefix}的 PGS 字幕名`);
        const lang = String(pgs?.lang || '').trim();
        if (pgs?.source === 'main') {
          const streamIndex = Number(pgs?.streamIndex);
          if (!Number.isInteger(streamIndex) || streamIndex < 0) {
            throw fail(400, `${prefix}的 PGS 内嵌轨序号非法`);
          }
          pgsSubs.push({ source: 'main', path: null, streamIndex, label, lang });
        } else {
          const pgsPath = requireAbsolutePath(pgs?.path, `${prefix}的 PGS 字幕文件`);
          await requireFile(pgsPath, `${prefix}的 PGS 字幕文件`, new Set(['.sup']));
          pgsSubs.push({ source: 'file', path: pgsPath, streamIndex: null, label, lang });
        }
      }

      let durationSec = Number(raw?.durationSec) || 0;
      if (!durationSec) {
        const probe = await probeMedia(videoPath).catch(() => null);
        durationSec = probe?.durationSec || 0;
      }

      prepared.push({
        name: path.basename(dir),
        dir,
        videoPath,
        durationSec,
        audios: orderedAudios,
        subtitles,
        pgsSubs,
      });
    }

    // 目标根目录不可写时（如 macOS 权限限制），改为先编码到工作区暂存目录再搬运
    const strategy = await resolveOutputStrategy(outputRoot);
    const outDirs = assignOutputDirs(
      outputRoot,
      prepared.map((task) => task.dir),
      limitDirSuffix(limitSec)
    );
    prepared.forEach((task, index) => {
      task.outDir = outDirs[index];
    });

    const batch = createBatch({ outputRoot, tasks: prepared, strategy, codecs, limitSec });
    runBatch(batch).catch((error) => {
      batch.status = 'failed';
      batch.error = error.message;
      batch.finishedAt = Date.now();
      batch.tasks.forEach((task) => {
        if (task.status === 'running' || task.status === 'queued') {
          task.status = 'failed';
          task.error = error.message;
        }
      });
    });

    res.status(202).json(serializeBatch(batch));
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/batches/:id', (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch) {
    res.status(404).json({ error: '批次不存在或已过期' });
    return;
  }
  res.json(serializeBatch(batch));
});

apiRouter.post('/batches/:id/cancel', (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch) {
    res.status(404).json({ error: '批次不存在' });
    return;
  }
  if (batch.status === 'running' || batch.status === 'queued') {
    cancelBatch(batch);
  }
  res.json(serializeBatch(batch));
});

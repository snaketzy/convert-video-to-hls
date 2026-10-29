import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_ROOT = path.resolve(currentDir, '..');
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');
export const WEB_DIST = path.join(PROJECT_ROOT, 'web', 'dist');

// 8090 常被本机其他项目（如 Flutter 应用）占用，这里固定用 8091
export const PORT = Number(process.env.PORT || 8091);
export const HOST = process.env.HOST || '127.0.0.1';

/** 单批次允许选择的源目录数量上限 */
export const MAX_DIRS = Number(process.env.MAX_DIRS || 10);

/** 编码输出根目录兜底值 */
export const OUTPUT_ROOT = process.env.OUTPUT_ROOT
  ? path.resolve(process.env.OUTPUT_ROOT)
  : path.join(PROJECT_ROOT, 'output');

/**
 * 目标目录不可写时的暂存根目录
 * 必须落在工作区内 —— 沙箱只对工作区（及 /tmp）放行写权限
 */
export const STAGING_ROOT = process.env.STAGING_ROOT
  ? path.resolve(process.env.STAGING_ROOT)
  : path.join(PROJECT_ROOT, 'output', '.staging');

/** 编码流水线脚本（skill 内，保持唯一事实来源） */
export const ENCODE_SCRIPT = process.env.ENCODE_SCRIPT
  ? path.resolve(process.env.ENCODE_SCRIPT)
  : path.join(PROJECT_ROOT, '.trae', 'skills', 'encode-video-to-hls-pipeline', 'scripts', 'encode_hls.sh');

/** 是否允许调用系统原生目录选择框（DISABLE_FOLDER_PICKER=1 关闭） */
export const FOLDER_PICKER_ENABLED = process.env.DISABLE_FOLDER_PICKER !== '1';

/** 分片时长（秒），与脚本默认值保持一致 */
export const SEGMENT_DURATION = Number(process.env.SEGMENT_DURATION || 6);

/** 单任务进度快照里保留的日志行数 */
export const LOG_TAIL_LINES = 60;

/** 任务记录保留时长，默认 12 小时 */
export const BATCH_TTL_MS = Number(process.env.BATCH_TTL_MS || 12 * 60 * 60 * 1000);

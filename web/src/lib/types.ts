export interface BinaryInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  message?: string;
}

export interface HealthPayload {
  ok: boolean;
  binaries: {
    ffmpeg: BinaryInfo;
    ffprobe: BinaryInfo;
    packager: BinaryInfo;
  };
}

export interface SubtitleLabel {
  label: string;
  lang: string;
}

export interface AppConfig {
  folderPickerSupported: boolean;
  folderPickerDisabled: boolean;
  platform: string;
  maxDirs: number;
  defaultOutputDir: string;
  segmentDuration: number;
  subtitleLabels: SubtitleLabel[];
}

export interface VideoCandidate {
  path: string;
  name: string;
  sizeBytes: number;
}

export interface ScanVideoInfo {
  path: string;
  name: string;
  sizeBytes: number;
  durationSec: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  hasAudio: boolean;
}

export type AudioSource = 'main' | 'file';

export interface ScanAudio {
  id: string;
  source: AudioSource;
  path: string | null;
  label: string;
  lang: string;
  channels: number;
  sizeBytes: number | null;
  isDefault: boolean;
}

export interface ScanSubtitle {
  id: string;
  path: string;
  label: string;
  lang: string;
  sizeBytes: number;
  isDefault: boolean;
}

/** PGS 位图字幕轨：外挂 .sup 或主视频内嵌轨，编码时自动收录 */
export interface ScanPgsSub {
  id: string;
  source: 'main' | 'file';
  /** 外挂 .sup 的路径；内嵌轨为 null */
  path: string | null;
  /** 内嵌轨在 -map 0:s:N 里的 N；外挂为 null */
  streamIndex: number | null;
  /** 显示名，写入 pgs-subs/index.json 的 name */
  label: string;
  /** 语言码，用作 pgs-subs 下的 .sup 文件名 */
  lang: string;
  sizeBytes: number | null;
}

export interface ScanItem {
  dir: string;
  name: string;
  exists: boolean;
  warnings: string[];
  videos: VideoCandidate[];
  video: ScanVideoInfo | null;
  audios: ScanAudio[];
  subtitles: ScanSubtitle[];
  pgsSubs: ScanPgsSub[];
}

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type BatchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskPlaylist {
  /** 编码档位：hevc / h264 */
  codec: string;
  /** master.m3u8 绝对路径 */
  path: string;
  /** master.m3u8 所在目录 */
  dir: string;
  sizeBytes: number | null;
}

export interface BatchTask {
  id: string;
  name: string;
  dir: string;
  outDir: string;
  /** 输出目录不可写时的提示（暂存导出） */
  notice: string | null;
  videoName: string;
  videoPath: string;
  audioCount: number;
  subtitleCount: number;
  audioLabels: string[];
  subtitleLabels: string[];
  status: TaskStatus;
  percent: number;
  phase: string | null;
  phaseLabel: string | null;
  itemLabel: string | null;
  speed: string | null;
  message: string | null;
  error: string | null;
  logTail: string[];
  playlists: TaskPlaylist[];
  sizeBytes: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Batch {
  id: string;
  outputRoot: string;
  /** 输出根目录不可写时的提示（暂存导出） */
  notice: string | null;
  status: BatchStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  completed: number;
  failed: number;
  finished: number;
  tasks: BatchTask[];
}

/** 本次批次要产出的编码阶梯 */
export interface CodecSelection {
  hevc: boolean;
  h264: boolean;
}

/** 提交给后端的单个任务 */
export interface SubmitTask {
  dir: string;
  videoPath: string;
  durationSec: number | null;
  audios: Array<{ source: AudioSource; path: string | null; label: string; lang: string; channels: number }>;
  defaultAudioIndex: number;
  subtitles: Array<{ path: string; label: string }>;
  defaultSubtitleIndex: number;
  pgsSubs: Array<{
    source: 'main' | 'file';
    path: string | null;
    streamIndex: number | null;
    label: string;
    lang: string;
  }>;
}

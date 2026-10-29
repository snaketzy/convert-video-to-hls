import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { BATCH_TTL_MS, LOG_TAIL_LINES, LADDER_NAMES, SEGMENT_DURATION } from '../config.js';

/** batchId -> 批次记录 */
const batches = new Map();

export const TASK_STATUS = ['queued', 'running', 'completed', 'failed', 'cancelled'];

/** 为批次里的每个任务分配唯一的输出子目录名 */
export function assignOutputDirs(outputRoot, dirs) {
  const used = new Set();
  return dirs.map((dir) => {
    const base = path.basename(dir) || 'output';
    let candidate = base;
    let index = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${base}-${index}`;
      index += 1;
    }
    used.add(candidate.toLowerCase());
    return path.join(outputRoot, candidate);
  });
}

/**
 * 创建批次记录（此时任务尚未开始执行）
 */
export function createBatch({ outputRoot, tasks, strategy = { mode: 'direct', notice: null } }) {
  const id = randomUUID();
  const notice = strategy.mode === 'staged' ? strategy.notice : null;
  const batch = {
    id,
    outputRoot,
    strategy,
    notice,
    status: 'queued',
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    cancelledAt: null,
    currentChild: null,
    tasks: tasks.map((task) => ({
      ...task,
      id: randomUUID(),
      notice,
      workDir: null,
      status: 'queued',
      percent: 0,
      phase: null,
      phaseLabel: null,
      itemLabel: null,
      speed: null,
      message: null,
      error: null,
      logTail: [],
      masterPath: null,
      sizeBytes: null,
      startedAt: null,
      finishedAt: null,
      ladderNames: LADDER_NAMES,
      segmentDuration: SEGMENT_DURATION,
    })),
  };
  batches.set(id, batch);
  return batch;
}

export function getBatch(id) {
  return batches.get(id) || null;
}

export function pushLog(task, line) {
  if (!line) return;
  task.logTail.push(line);
  if (task.logTail.length > LOG_TAIL_LINES) {
    task.logTail.splice(0, task.logTail.length - LOG_TAIL_LINES);
  }
}

function serializeTask(task) {
  return {
    id: task.id,
    name: task.name,
    dir: task.dir,
    outDir: task.outDir,
    notice: task.notice,
    videoName: path.basename(task.videoPath),
    videoPath: task.videoPath,
    audioCount: task.audios.length,
    subtitleCount: task.subtitles.length,
    audioLabels: task.audios.map((audio) => audio.label),
    subtitleLabels: task.subtitles.map((subtitle) => subtitle.label),
    status: task.status,
    percent: task.percent,
    phase: task.phase,
    phaseLabel: task.phaseLabel,
    itemLabel: task.itemLabel,
    speed: task.speed,
    message: task.message,
    error: task.error,
    logTail: task.logTail.slice(-12),
    hlsDir: task.masterPath ? path.dirname(task.masterPath) : null,
    masterPath: task.masterPath,
    sizeBytes: task.sizeBytes,
    startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
    finishedAt: task.finishedAt ? new Date(task.finishedAt).toISOString() : null,
  };
}

export function serializeBatch(batch) {
  const tasks = batch.tasks.map(serializeTask);
  return {
    id: batch.id,
    outputRoot: batch.outputRoot,
    notice: batch.notice ?? null,
    status: batch.status,
    error: batch.error,
    createdAt: new Date(batch.createdAt).toISOString(),
    startedAt: batch.startedAt ? new Date(batch.startedAt).toISOString() : null,
    finishedAt: batch.finishedAt ? new Date(batch.finishedAt).toISOString() : null,
    total: tasks.length,
    completed: tasks.filter((task) => task.status === 'completed').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    finished: tasks.filter((task) => task.status === 'completed' || task.status === 'failed').length,
    tasks,
  };
}

/** 汇总批次状态（在任务流转后调用） */
export function refreshBatchStatus(batch) {
  if (batch.status === 'cancelled') return;
  const running = batch.tasks.some((task) => task.status === 'running' || task.status === 'queued');
  if (running) {
    batch.status = 'running';
    return;
  }
  batch.status = batch.tasks.some((task) => task.status === 'failed') ? 'failed' : 'completed';
  batch.finishedAt = Date.now();
}

export function sweepExpiredBatches() {
  const deadline = Date.now() - BATCH_TTL_MS;
  for (const [id, batch] of batches) {
    if (batch.status === 'running' || batch.status === 'queued') continue;
    if (batch.createdAt < deadline) batches.delete(id);
  }
}

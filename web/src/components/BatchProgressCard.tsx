import { useEffect, useState } from 'react';
import { Ban, Check, Copy, Info, Loader2 } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatBytes, formatElapsed } from '@/lib/format';
import type { Batch, BatchStatus, BatchTask, TaskStatus } from '@/lib/types';
import { batchReset, cancelBatch } from '@/store/batchSlice';
import { useAppDispatch } from '@/store/hooks';

const TASK_STATUS_TEXT: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '编码中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const BATCH_STATUS_TEXT: Record<BatchStatus, string> = {
  queued: '排队中',
  running: '编码中',
  completed: '全部完成',
  failed: '存在失败',
  cancelled: '已取消',
};

function taskBadgeVariant(status: TaskStatus) {
  if (status === 'completed') return 'success' as const;
  if (status === 'failed') return 'destructive' as const;
  if (status === 'running') return 'secondary' as const;
  return 'outline' as const;
}

function batchBadgeVariant(status: BatchStatus) {
  if (status === 'completed') return 'success' as const;
  if (status === 'failed') return 'destructive' as const;
  if (status === 'running') return 'secondary' as const;
  return 'outline' as const;
}

/** 已完成/失败的任务按 100% 计入总量 */
function overallPercent(batch: Batch): number {
  if (batch.tasks.length === 0) return 0;
  const total = batch.tasks.reduce((sum, task) => {
    if (task.status === 'completed' || task.status === 'failed') return sum + 100;
    return sum + task.percent;
  }, 0);
  return Math.round(total / batch.tasks.length);
}

function TaskRow({ task }: { task: BatchTask }) {
  const [copiedCodec, setCopiedCodec] = useState<string | null>(null);

  useEffect(() => {
    if (!copiedCodec) return undefined;
    const timer = window.setTimeout(() => setCopiedCodec(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedCodec]);

  const active = task.status === 'running';

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{task.name}</span>
        <Badge variant={taskBadgeVariant(task.status)}>
          {active && <Loader2 className="animate-spin" />}
          {TASK_STATUS_TEXT[task.status]}
        </Badge>
        <Badge variant="outline">音 {task.audioCount}</Badge>
        <Badge variant="outline">字 {task.subtitleCount}</Badge>
        {task.speed && active && (
          <span className="text-muted-foreground text-xs">速度 {task.speed}</span>
        )}
        <span className="text-muted-foreground text-xs">
          耗时 {formatElapsed(task.startedAt, task.finishedAt)}
        </span>
        {task.sizeBytes !== null && (
          <span className="text-muted-foreground text-xs">{formatBytes(task.sizeBytes)}</span>
        )}
        <span className="text-muted-foreground ml-auto text-xs">{task.percent.toFixed(0)}%</span>
      </div>

      {(active || task.status === 'queued') && <Progress value={task.percent} className="h-1.5" />}

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs break-all">
        {task.phaseLabel && <span>{task.phaseLabel}</span>}
        {task.itemLabel && <span>· {task.itemLabel}</span>}
        <span className="text-muted-foreground/70">→ {task.outDir}</span>
      </div>

      {task.videoName && (
        <p className="text-muted-foreground text-xs">
          主视频 <span className="font-mono">{task.videoName}</span>
        </p>
      )}

      {task.error && <p className="text-destructive text-xs break-all">失败原因：{task.error}</p>}

      {task.playlists.map((entry) => (
        <div key={entry.codec} className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{entry.codec.toUpperCase()}</Badge>
          {entry.sizeBytes !== null && (
            <span className="text-muted-foreground text-xs">{formatBytes(entry.sizeBytes)}</span>
          )}
          <span className="font-mono text-xs break-all">{entry.path}</span>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => {
              void navigator.clipboard
                .writeText(entry.path)
                .then(() => setCopiedCodec(entry.codec))
                .catch(() => undefined);
            }}
          >
            {copiedCodec === entry.codec ? <Check className="text-emerald-600" /> : <Copy />}
            {copiedCodec === entry.codec ? '已复制' : '复制路径'}
          </Button>
        </div>
      ))}

      {(active || task.status === 'failed') && task.logTail.length > 0 && (
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer select-none">查看日志</summary>
          <pre className="bg-muted/40 mt-2 max-h-56 overflow-auto rounded-md p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {task.logTail.join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}

export function BatchProgressCard({ batch }: { batch: Batch }) {
  const dispatch = useAppDispatch();
  const active = batch.status === 'running' || batch.status === 'queued';
  const percent = overallPercent(batch);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>3. 编码进度</CardTitle>
            <CardDescription className="font-mono text-xs break-all">
              {batch.outputRoot}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={batchBadgeVariant(batch.status)}>
              {active && <Loader2 className="animate-spin" />}
              {BATCH_STATUS_TEXT[batch.status]}
            </Badge>
            <Badge variant="outline">
              {batch.completed + batch.failed} / {batch.total}
              {batch.failed > 0 ? ` · 失败 ${batch.failed}` : ''}
            </Badge>
            {active ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void dispatch(cancelBatch(batch.id))}
              >
                <Ban />
                取消批次
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => dispatch(batchReset())}>
                重置批次
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              总进度 · 串行执行，一次只编一个目录
            </span>
            <span className="font-medium">{percent}%</span>
          </div>
          <Progress value={percent} />
        </div>

        {batch.notice && (
          <Alert>
            <Info />
            <AlertDescription>{batch.notice}</AlertDescription>
          </Alert>
        )}

        {batch.error && (
          <Alert variant="destructive">
            <AlertDescription>{batch.error}</AlertDescription>
          </Alert>
        )}

        <div className="divide-y rounded-lg border">
          {batch.tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

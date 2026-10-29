import { FolderOpen, Loader2, Play } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  outputRootChanged,
  pickerErrorCleared,
  pickOutputRoot,
  startBatch,
} from '@/store/batchSlice';
import { useAppDispatch, useAppSelector } from '@/store/hooks';

function baseName(dir: string): string {
  const parts = dir.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || dir;
}

/** 拼接最终输出路径：输出根目录 / 源目录名（去掉根目录末尾多余的 /） */
function joinOutPath(root: string, name: string): string {
  return `${root.replace(/\/+$/, '')}/${name}`;
}

export function OutputCard() {
  const dispatch = useAppDispatch();
  const { items, outputRoot, pickerStatus, pickerError, startStatus, startError, batch, config } =
    useAppSelector((state) => state.batch);

  const pickerSupported = config?.folderPickerSupported !== false && pickerStatus !== 'unsupported';
  const encodable = items.filter((item) => item.exists && item.video);
  const batchActive = batch?.status === 'running' || batch?.status === 'queued';
  const starting = startStatus === 'starting';

  const canStart = encodable.length > 0 && outputRoot.trim().length > 0 && !batchActive && !starting;

  return (
    <Card>
      <CardHeader>
        <CardTitle>2. 输出目录</CardTitle>
        <CardDescription>
          HLS 会写入「输出根目录 / 源目录名」下；同名目录会自动追加 -2 后缀，不会互相覆盖。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm font-medium">输出根目录</p>
          <div className="flex flex-wrap items-center gap-2">
            {pickerSupported && (
              <Button
                variant="outline"
                disabled={pickerStatus === 'opening'}
                onClick={() => void dispatch(pickOutputRoot())}
              >
                {pickerStatus === 'opening' ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                {pickerStatus === 'opening' ? '等待选择…' : '选择文件夹'}
              </Button>
            )}
            <Input
              value={outputRoot}
              onChange={(event) => dispatch(outputRootChanged(event.target.value))}
              placeholder="也可粘贴绝对路径，例如 /Users/you/Movies/hls-output"
              className="min-w-[16rem] flex-1 font-mono text-xs"
            />
          </div>
          {pickerError && (
            <p className="text-destructive text-xs">
              {pickerError}
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => dispatch(pickerErrorCleared())}
              >
                知道了
              </button>
            </p>
          )}
          {encodable.length > 0 && outputRoot.trim().length > 0 && (
            <p className="text-muted-foreground font-mono text-xs break-all">
              将写入：{encodable.map((item) => joinOutPath(outputRoot, baseName(item.dir))).join('、')}
            </p>
          )}
        </div>

        <Separator />

        <div className="space-y-2">
          <p className="text-sm font-medium">
            待编码目录
            <span className="text-muted-foreground ml-2 text-xs">
              共 {encodable.length} 个{items.length !== encodable.length ? `（${items.length - encodable.length} 个缺少主视频，已跳过）` : ''}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            {encodable.map((item) => (
              <Badge key={item.dir} variant="secondary" className="font-mono">
                {baseName(item.dir)}
                <span className="text-muted-foreground">
                  · 音 {item.audios.length} / 字 {item.subtitles.length}
                </span>
              </Badge>
            ))}
          </div>
        </div>

        {startError && (
          <Alert variant="destructive">
            <AlertDescription>{startError}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" disabled={!canStart} onClick={() => void dispatch(startBatch())}>
            {starting ? <Loader2 className="animate-spin" /> : <Play />}
            {starting ? '正在提交…' : batchActive ? '编码进行中…' : '开始编码'}
          </Button>
          {encodable.length === 0 && (
            <span className="text-muted-foreground text-xs">请先选择包含主视频的源目录</span>
          )}
          {encodable.length > 0 && !outputRoot.trim() && (
            <span className="text-muted-foreground text-xs">请先选择输出根目录</span>
          )}
          {batchActive && (
            <span className="text-muted-foreground text-xs">当前批次结束后才能提交新批次</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

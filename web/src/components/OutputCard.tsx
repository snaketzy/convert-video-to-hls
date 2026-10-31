import { FolderOpen, Loader2, Play } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  codecToggled,
  encodeLimitChanged,
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

/** 限时样片的目录后缀，需与后端 assignOutputDirs 的规则一致 */
function limitSuffix(seconds: number): string {
  return seconds > 0 ? `-${Math.round(seconds / 60)}min` : '';
}

const ENCODE_LIMITS: Array<{ seconds: number; label: string }> = [
  { seconds: 300, label: '5分钟' },
  { seconds: 0, label: '全片' },
];

export function OutputCard() {
  const dispatch = useAppDispatch();
  const {
    items,
    outputRoot,
    pickerStatus,
    pickerError,
    startStatus,
    startError,
    batch,
    config,
    codecs,
    encodeLimitSec,
  } = useAppSelector((state) => state.batch);

  const pickerSupported = config?.folderPickerSupported !== false && pickerStatus !== 'unsupported';
  const encodable = items.filter((item) => item.exists && item.video);
  const batchActive = batch?.status === 'running' || batch?.status === 'queued';
  const starting = startStatus === 'starting';
  const hasCodec = codecs.hevc || codecs.h264;

  const canStart =
    encodable.length > 0 && outputRoot.trim().length > 0 && !batchActive && !starting && hasCodec;

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
              将写入：
              {encodable
                .map((item) => joinOutPath(outputRoot, baseName(item.dir) + limitSuffix(encodeLimitSec)))
                .join('、')}
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

          <div className="border-input flex items-center gap-4 rounded-lg border px-3 py-2">
            <span className="text-muted-foreground text-xs">编码类型</span>
            {(['hevc', 'h264'] as const).map((codec) => (
              <Label key={codec} className="cursor-pointer gap-2 font-normal">
                <Checkbox
                  checked={codecs[codec]}
                  disabled={batchActive || starting}
                  onCheckedChange={(checked) =>
                    dispatch(codecToggled({ codec, enabled: checked === true }))
                  }
                />
                {codec === 'hevc' ? 'HEVC' : 'H264'}
              </Label>
            ))}
          </div>

          <div className="border-input flex items-center gap-2 rounded-lg border px-3 py-2">
            <span className="text-muted-foreground text-xs">编码时长</span>
            {ENCODE_LIMITS.map((option) => (
              <Button
                key={option.seconds}
                type="button"
                size="sm"
                variant={encodeLimitSec === option.seconds ? 'default' : 'outline'}
                disabled={batchActive || starting}
                onClick={() => dispatch(encodeLimitChanged(option.seconds))}
              >
                {option.label}
              </Button>
            ))}
          </div>

          {encodable.length === 0 && (
            <span className="text-muted-foreground text-xs">请先选择包含主视频的源目录</span>
          )}
          {encodable.length > 0 && !outputRoot.trim() && (
            <span className="text-muted-foreground text-xs">请先选择输出根目录</span>
          )}
          {encodable.length > 0 && !hasCodec && (
            <span className="text-muted-foreground text-xs">请至少勾选一种编码类型</span>
          )}
          {batchActive && (
            <span className="text-muted-foreground text-xs">当前批次结束后才能提交新批次</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

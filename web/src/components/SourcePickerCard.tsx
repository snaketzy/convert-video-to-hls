import { useState } from 'react';
import { FolderOpen, ListPlus, Loader2, Trash2 } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  allItemsCleared,
  manualInputChanged,
  pickErrorCleared,
  pickSourceDirs,
  scanDirs,
  scanErrorCleared,
} from '@/store/batchSlice';
import { useAppDispatch, useAppSelector } from '@/store/hooks';

/** 手填路径：按行拆分，顺手剥掉粘贴时常带的引号 */
function parseManualDirs(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

export function SourcePickerCard() {
  const dispatch = useAppDispatch();
  const {
    items,
    scanStatus,
    scanError,
    pickingStatus,
    pickError,
    manualInput,
    config,
  } = useAppSelector((state) => state.batch);

  const [manualOpen, setManualOpen] = useState(false);

  const maxDirs = config?.maxDirs ?? 10;
  const pickerSupported = config?.folderPickerSupported !== false && pickingStatus !== 'unsupported';

  const manualDirs = parseManualDirs(manualInput);
  const scanning = scanStatus === 'scanning';
  const overLimit = items.length + manualDirs.length > maxDirs;

  const submitManual = () => {
    if (manualDirs.length === 0) return;
    dispatch(pickErrorCleared());
    void dispatch(scanDirs(manualDirs.slice(0, maxDirs)));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>1. 选择源目录</CardTitle>
        <CardDescription>
          每个目录放一个主视频（mp4/mkv/mov）、若干外挂音轨（mp3）与字幕（vtt）；一次最多选 {maxDirs} 个，
          扫描后可在下方逐个确认轨道。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {pickerSupported && (
            <Button
              disabled={pickingStatus === 'opening' || scanning}
              onClick={() => void dispatch(pickSourceDirs())}
            >
              {pickingStatus === 'opening' ? <Loader2 className="animate-spin" /> : <FolderOpen />}
              {pickingStatus === 'opening' ? '等待选择…' : '选择源目录'}
            </Button>
          )}
          <Button variant="outline" onClick={() => setManualOpen((value) => !value)}>
            <ListPlus />
            {manualOpen ? '收起手动输入' : '手动输入路径'}
          </Button>
          {items.length > 0 && (
            <Button
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => dispatch(allItemsCleared())}
            >
              <Trash2 />
              清空已选
            </Button>
          )}
          <Badge variant={items.length > 0 ? 'secondary' : 'outline'}>
            已选 {items.length} / {maxDirs}
          </Badge>
          {scanning && (
            <Badge variant="secondary">
              <Loader2 className="animate-spin" />
              扫描中
            </Badge>
          )}
        </div>

        {manualOpen && (
          <div className="space-y-2">
            <textarea
              value={manualInput}
              onChange={(event) => dispatch(manualInputChanged(event.target.value))}
              rows={3}
              spellCheck={false}
              placeholder={'每行一个绝对路径，例如：\n/Users/you/Movies/Some.Movie.2011.1080P'}
              className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:ring-[3px]"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={manualDirs.length === 0 || scanning}
                onClick={submitManual}
              >
                {scanning ? <Loader2 className="animate-spin" /> : <ListPlus />}
                扫描这些目录
              </Button>
              <span className="text-muted-foreground text-xs">
                已识别 {manualDirs.length} 条路径
                {manualDirs.length > maxDirs ? `，只会取前 ${maxDirs} 条` : ''}
              </span>
            </div>
          </div>
        )}

        {!pickerSupported && (
          <Alert>
            <AlertDescription>
              当前环境不支持原生目录对话框（仅 macOS 本地运行可用），请使用「手动输入路径」。
            </AlertDescription>
          </Alert>
        )}

        {overLimit && (
          <Alert variant="warning">
            <AlertDescription>
              已超过上限 {maxDirs} 个目录，提交时将只处理前 {maxDirs} 个。
            </AlertDescription>
          </Alert>
        )}

        {pickError && (
          <Alert variant="destructive">
            <AlertDescription className="flex items-start justify-between gap-3">
              <span>{pickError}</span>
              <button
                type="button"
                className="shrink-0 underline"
                onClick={() => dispatch(pickErrorCleared())}
              >
                知道了
              </button>
            </AlertDescription>
          </Alert>
        )}

        {scanError && (
          <Alert variant="destructive">
            <AlertDescription className="flex items-start justify-between gap-3">
              <span>{scanError}</span>
              <button
                type="button"
                className="shrink-0 underline"
                onClick={() => dispatch(scanErrorCleared())}
              >
                知道了
              </button>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

import { useEffect } from 'react';
import { ChevronsDown, ChevronsUp, Film, Loader2, TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BatchProgressCard } from '@/components/BatchProgressCard';
import { DirReviewCard } from '@/components/DirReviewCard';
import { OutputCard } from '@/components/OutputCard';
import { SourcePickerCard } from '@/components/SourcePickerCard';
import { bootstrap, refreshBatch } from '@/store/batchSlice';
import { useAppDispatch, useAppSelector } from '@/store/hooks';

function BinaryStatus() {
  const { bootstrapStatus, health } = useAppSelector((state) => state.batch);

  if (bootstrapStatus === 'loading' || bootstrapStatus === 'idle') {
    return (
      <Badge variant="outline">
        <Loader2 className="animate-spin" />
        检测编码工具链
      </Badge>
    );
  }

  if (!health?.ok) {
    const missing = health
      ? (['ffmpeg', 'ffprobe', 'packager'] as const).filter((name) => !health.binaries[name].available)
      : [];
    return (
      <Badge variant="destructive" title={missing.join('、') || undefined}>
        <TriangleAlert />
        {missing.length > 0 ? `缺少 ${missing.join(' / ')}` : '未检测到编码工具链'}
      </Badge>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary" title={health.binaries.ffmpeg.path ?? undefined}>
        FFmpeg {health.binaries.ffmpeg.version}
      </Badge>
      <Badge variant="secondary" title={health.binaries.packager.path ?? undefined}>
        Shaka Packager {health.binaries.packager.version}
      </Badge>
    </div>
  );
}

function ScrollPins() {
  const toTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  const toBottom = () =>
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });

  return (
    <div className="pointer-events-none fixed inset-y-0 left-1/2 z-20 w-full max-w-6xl -translate-x-1/2">
      <div className="pointer-events-auto absolute left-full top-1/2 ml-4 flex -translate-y-1/2 flex-col gap-2">
        <Button variant="outline" size="icon" title="跳转顶部" aria-label="跳转顶部" onClick={toTop}>
          <ChevronsUp />
        </Button>
        <Button
          variant="outline"
          size="icon"
          title="跳转底部"
          aria-label="跳转底部"
          onClick={toBottom}
        >
          <ChevronsDown />
        </Button>
      </div>
    </div>
  );
}

export default function App() {
  const dispatch = useAppDispatch();
  const { bootstrapStatus, bootstrapError, health, items, batch } = useAppSelector(
    (state) => state.batch
  );

  useEffect(() => {
    void dispatch(bootstrap());
  }, [dispatch]);

  const batchId = batch?.id ?? null;
  const batchActive = batch?.status === 'running' || batch?.status === 'queued';

  useEffect(() => {
    if (!batchId || !batchActive) return undefined;
    const timer = window.setInterval(() => {
      void dispatch(refreshBatch(batchId));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [batchId, batchActive, dispatch]);

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="bg-background sticky top-0 z-10 border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-lg">
              <Film className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold">视频批量转 HLS</h1>
              <p className="text-muted-foreground text-xs">
                一次最多 10 个目录，串行硬编出多码率 / 多音轨 / 多字幕 HLS
              </p>
            </div>
          </div>
          <BinaryStatus />
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-6">
        {bootstrapStatus === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>
              {bootstrapError || '无法连接后端服务'}；请确认后端已启动（npm run dev / npm start）。
            </AlertDescription>
          </Alert>
        )}

        {bootstrapStatus === 'ready' && health && !health.ok && (
          <Alert variant="destructive">
            <AlertDescription>
              编码依赖缺失：
              {(['ffmpeg', 'ffprobe', 'packager'] as const)
                .filter((name) => !health.binaries[name].available)
                .map((name) => health.binaries[name].message || name)
                .join('；')}
            </AlertDescription>
          </Alert>
        )}

        <SourcePickerCard />

        {items.length > 0 && <OutputCard />}

        {items.map((item, index) => (
          <DirReviewCard key={item.dir} item={item} index={index} />
        ))}

        {batch && <BatchProgressCard batch={batch} />}
      </main>

      <ScrollPins />
    </div>
  );
}

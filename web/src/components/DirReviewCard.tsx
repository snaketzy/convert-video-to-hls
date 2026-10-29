import { useState } from 'react';
import { Loader2, Trash2, TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBytes, formatDuration, formatFps, formatResolution } from '@/lib/format';
import type { ScanItem } from '@/lib/types';
import {
  audioChannelsChanged,
  audioLabelChanged,
  audioLangChanged,
  defaultAudioChanged,
  defaultSubtitleChanged,
  itemRemoved,
  rescanDir,
  subtitleLabelChanged,
  subtitleRemoved,
} from '@/store/batchSlice';
import { useAppDispatch, useAppSelector } from '@/store/hooks';

/** 常用语言码，供音轨语言下拉提示 */
const AUDIO_LANG_OPTIONS = [
  'und',
  'en',
  'yue',
  'zh',
  'zh-Hans',
  'zh-Hant',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'ru',
  'th',
  'vi',
];

const CHANNEL_OPTIONS = [
  { value: 2, label: '2 声道（立体声）' },
  { value: 6, label: '6 声道（5.1）' },
  { value: 8, label: '8 声道（7.1）' },
];

function baseName(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

interface DirReviewCardProps {
  item: ScanItem;
  index: number;
}

export function DirReviewCard({ item, index }: DirReviewCardProps) {
  const dispatch = useAppDispatch();
  const config = useAppSelector((state) => state.batch.config);
  const [switching, setSwitching] = useState(false);

  // 与服务端 langOfName 一致：转小写后精确匹配
  const subtitleLangOf = (label: string) => {
    const key = label.trim().toLowerCase();
    return config?.subtitleLabels.find((entry) => entry.label.toLowerCase() === key)?.lang ?? '';
  };

  const handleVideoChange = async (videoPath: string) => {
    setSwitching(true);
    try {
      await dispatch(rescanDir({ dir: item.dir, videoPath })).unwrap();
    } catch {
      // 错误已写入 scanError，由上方卡片展示
    } finally {
      setSwitching(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>
              目录 {index + 1} · {item.name}
            </CardTitle>
            <CardDescription className="font-mono text-xs break-all">{item.dir}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={item.video ? 'secondary' : 'destructive'}>
              主视频 {item.video ? 1 : 0}
            </Badge>
            <Badge variant={item.audios.length > 0 ? 'secondary' : 'destructive'}>
              音轨 {item.audios.length}
            </Badge>
            <Badge variant={item.subtitles.length > 0 ? 'secondary' : 'outline'}>
              字幕 {item.subtitles.length}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => dispatch(itemRemoved(index))}
            >
              <Trash2 />
              移除
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {item.warnings.length > 0 && (
          <Alert variant="warning">
            <TriangleAlert />
            <AlertDescription>
              <ul className="list-disc space-y-0.5 pl-4">
                {item.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {!item.exists && (
          <Alert variant="destructive">
            <AlertDescription>目录无法读取，已跳过该目录。</AlertDescription>
          </Alert>
        )}

        {item.exists && (
          <>
            <div className="space-y-2">
              <p className="text-sm font-medium">主视频</p>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={item.video?.path}
                  onValueChange={(value) => void handleVideoChange(value)}
                  disabled={switching || item.videos.length === 0}
                >
                  <SelectTrigger className="w-full max-w-xl">
                    <SelectValue placeholder="目录内没有找到视频文件" />
                  </SelectTrigger>
                  <SelectContent>
                    {item.videos.map((video) => (
                      <SelectItem key={video.path} value={video.path}>
                        {video.name}
                        <span className="text-muted-foreground ml-2 text-xs">
                          {formatBytes(video.sizeBytes)}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {switching && <Loader2 className="animate-spin text-muted-foreground" />}
                {item.video && (
                  <>
                    <Badge variant="outline">{formatDuration(item.video.durationSec)}</Badge>
                    <Badge variant="outline">
                      {formatResolution(item.video.width, item.video.height)}
                    </Badge>
                    <Badge variant="outline">{formatFps(item.video.fps)}</Badge>
                    {item.video.videoCodec && (
                      <Badge variant="outline">{item.video.videoCodec}</Badge>
                    )}
                  </>
                )}
              </div>
              <p className="text-muted-foreground text-xs">
                主视频的 HLS 阶梯按 skill 默认档位（240P / 360P / 480P / 720P / 1080P）硬编，分片
                {config ? ` ${config.segmentDuration}s` : ''}。
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">音轨</p>
                <p className="text-muted-foreground text-xs">
                  选中的「默认」必须排第一位（packager 只认第一条匹配语言码的流）。
                </p>
              </div>
              {item.audios.length === 0 ? (
                <p className="text-muted-foreground py-4 text-center text-sm">没有可用音轨</p>
              ) : (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-16">默认</TableHead>
                        <TableHead>音轨名</TableHead>
                        <TableHead className="w-32">语言码</TableHead>
                        <TableHead className="w-44">声道</TableHead>
                        <TableHead>来源</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {item.audios.map((audio) => (
                        <TableRow key={audio.id}>
                          <TableCell>
                            <input
                              type="radio"
                              name={`default-audio-${index}`}
                              className="size-4 accent-primary"
                              checked={audio.isDefault}
                              onChange={() =>
                                dispatch(defaultAudioChanged({ itemIndex: index, audioId: audio.id }))
                              }
                              aria-label={`把「${audio.label}」设为默认音轨`}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              value={audio.label}
                              onChange={(event) =>
                                dispatch(
                                  audioLabelChanged({
                                    itemIndex: index,
                                    audioId: audio.id,
                                    label: event.target.value,
                                  })
                                )
                              }
                              className="min-w-[10rem]"
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              value={audio.lang}
                              list={`audio-lang-${index}`}
                              onChange={(event) =>
                                dispatch(
                                  audioLangChanged({
                                    itemIndex: index,
                                    audioId: audio.id,
                                    lang: event.target.value,
                                  })
                                )
                              }
                              placeholder="und"
                              className="font-mono text-xs"
                            />
                          </TableCell>
                          <TableCell>
                            <Select
                              value={String(audio.channels)}
                              onValueChange={(value) =>
                                dispatch(
                                  audioChannelsChanged({
                                    itemIndex: index,
                                    audioId: audio.id,
                                    channels: Number(value),
                                  })
                                )
                              }
                            >
                              <SelectTrigger size="sm" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {CHANNEL_OPTIONS.map((option) => (
                                  <SelectItem key={option.value} value={String(option.value)}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell className="text-muted-foreground font-mono text-xs break-all">
                            {audio.source === 'main' ? (
                              <Badge variant="outline">主视频内嵌</Badge>
                            ) : (
                              <>
                                {baseName(audio.path ?? '')}
                                {audio.sizeBytes !== null && (
                                  <span className="ml-2">{formatBytes(audio.sizeBytes)}</span>
                                )}
                              </>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">字幕</p>
                <p className="text-muted-foreground text-xs">
                  显示名需与 skill 的语言表一致才能带上 lang=；不匹配时该轨仍保留但不带 lang。
                </p>
              </div>
              {item.subtitles.length === 0 ? (
                <p className="text-muted-foreground py-4 text-center text-sm">
                  没有 WebVTT 字幕（.vtt）
                </p>
              ) : (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-16">默认</TableHead>
                        <TableHead>显示名</TableHead>
                        <TableHead className="w-28">语言码</TableHead>
                        <TableHead>文件</TableHead>
                        <TableHead className="w-16" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {item.subtitles.map((subtitle) => {
                        const lang = subtitleLangOf(subtitle.label);
                        return (
                          <TableRow key={subtitle.id}>
                            <TableCell>
                              <input
                                type="radio"
                                name={`default-subtitle-${index}`}
                                className="size-4 accent-primary"
                                checked={subtitle.isDefault}
                                onChange={() =>
                                  dispatch(
                                    defaultSubtitleChanged({
                                      itemIndex: index,
                                      subtitleId: subtitle.id,
                                    })
                                  )
                                }
                                aria-label={`把「${subtitle.label}」设为默认字幕`}
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                value={subtitle.label}
                                list={`subtitle-labels-${index}`}
                                onChange={(event) =>
                                  dispatch(
                                    subtitleLabelChanged({
                                      itemIndex: index,
                                      subtitleId: subtitle.id,
                                      label: event.target.value,
                                    })
                                  )
                                }
                                className="min-w-[12rem]"
                              />
                            </TableCell>
                            <TableCell>
                              {lang ? (
                                <Badge variant="secondary" className="font-mono">
                                  {lang}
                                </Badge>
                              ) : (
                                <Badge variant="warning">无 lang</Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground font-mono text-xs break-all">
                              {baseName(subtitle.path)}
                              <span className="ml-2">{formatBytes(subtitle.sizeBytes)}</span>
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-muted-foreground"
                                title="移除该字幕"
                                onClick={() =>
                                  dispatch(
                                    subtitleRemoved({
                                      itemIndex: index,
                                      subtitleId: subtitle.id,
                                    })
                                  )
                                }
                              >
                                <Trash2 />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>

            <datalist id={`audio-lang-${index}`}>
              {AUDIO_LANG_OPTIONS.map((lang) => (
                <option key={lang} value={lang} />
              ))}
            </datalist>
            <datalist id={`subtitle-labels-${index}`}>
              {(config?.subtitleLabels ?? []).map((entry) => (
                <option key={entry.label} value={entry.label} />
              ))}
            </datalist>
          </>
        )}
      </CardContent>
    </Card>
  );
}

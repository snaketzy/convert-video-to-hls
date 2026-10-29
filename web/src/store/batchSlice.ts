import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';

import { api } from '@/lib/api';
import type { AppConfig, Batch, HealthPayload, ScanItem, SubmitTask } from '@/lib/types';
import type { RootState } from '@/store';

export interface BatchSliceState {
  bootstrapStatus: 'idle' | 'loading' | 'ready' | 'error';
  health: HealthPayload | null;
  config: AppConfig | null;
  bootstrapError: string | null;

  /** 当前已选中并扫描的源目录 */
  items: ScanItem[];
  scanStatus: 'idle' | 'scanning' | 'ready' | 'error';
  scanError: string | null;
  pickingStatus: 'idle' | 'opening' | 'unsupported' | 'error';
  pickError: string | null;
  manualInput: string;

  outputRoot: string;
  pickerStatus: 'idle' | 'opening' | 'unsupported' | 'error';
  pickerError: string | null;

  batch: Batch | null;
  startStatus: 'idle' | 'starting' | 'error';
  startError: string | null;
  cancelStatus: 'idle' | 'cancelling';
}

const initialState: BatchSliceState = {
  bootstrapStatus: 'idle',
  health: null,
  config: null,
  bootstrapError: null,

  items: [],
  scanStatus: 'idle',
  scanError: null,
  pickingStatus: 'idle',
  pickError: null,
  manualInput: '',

  outputRoot: '',
  pickerStatus: 'idle',
  pickerError: null,

  batch: null,
  startStatus: 'idle',
  startError: null,
  cancelStatus: 'idle',
};

/** 已经选中过的目录不再重复加入 */
function mergeScannedItems(existing: ScanItem[], incoming: ScanItem[]): ScanItem[] {
  const merged = [...existing];
  for (const item of incoming) {
    const index = merged.findIndex((candidate) => candidate.dir === item.dir);
    if (index >= 0) merged[index] = item;
    else merged.push(item);
  }
  return merged;
}

export function buildSubmitTasks(state: BatchSliceState): SubmitTask[] {
  return state.items
    .filter((item) => item.exists && item.video)
    .map((item) => {
      const defaultAudioIndex = Math.max(
        0,
        item.audios.findIndex((audio) => audio.isDefault)
      );
      const defaultSubtitleIndex = Math.max(
        0,
        item.subtitles.findIndex((subtitle) => subtitle.isDefault)
      );
      return {
        dir: item.dir,
        videoPath: item.video!.path,
        durationSec: item.video!.durationSec,
        audios: item.audios.map((audio) => ({
          source: audio.source,
          path: audio.path,
          label: audio.label,
          lang: audio.lang,
          channels: audio.channels,
        })),
        defaultAudioIndex,
        subtitles: item.subtitles.map((subtitle) => ({ path: subtitle.path, label: subtitle.label })),
        defaultSubtitleIndex,
      };
    });
}

export const bootstrap = createAsyncThunk('batch/bootstrap', async () => {
  const [health, config] = await Promise.all([api.health(), api.config()]);
  return { health, config };
});

export const scanDirs = createAsyncThunk<ScanItem[], string[], { rejectValue: string }>(
  'batch/scanDirs',
  async (dirs, { rejectWithValue }) => {
    if (dirs.length === 0) return rejectWithValue('请先选择源目录');
    try {
      const { items } = await api.scan(dirs);
      return items;
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '扫描失败');
    }
  }
);

export const pickSourceDirs = createAsyncThunk<
  void,
  void,
  { state: RootState; rejectValue: { message: string; unsupported: boolean } }
>('batch/pickSourceDirs', async (_arg, { dispatch, getState, rejectWithValue }) => {
  try {
    const result = await api.pickDirectories();
    if (!result.cancelled && result.paths?.length) {
      const { config } = getState().batch;
      const selected = result.paths.slice(0, config?.maxDirs ?? 10);
      await dispatch(scanDirs(selected)).unwrap();
    }
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    return rejectWithValue({
      message: error instanceof Error ? error.message : '打开目录选择框失败',
      unsupported: status === 501,
    });
  }
});

export const rescanDir = createAsyncThunk<
  ScanItem[],
  { dir: string; videoPath?: string },
  { rejectValue: string }
>('batch/rescanDir', async ({ dir, videoPath }, { rejectWithValue }) => {
  try {
    const { items } = await api.scan([dir], videoPath ? { [dir]: videoPath } : undefined);
    return items;
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '重新扫描失败');
  }
});

export const pickOutputRoot = createAsyncThunk<
  { paths?: string[]; cancelled?: boolean },
  void,
  { rejectValue: { message: string; unsupported: boolean } }
>('batch/pickOutputRoot', async (_arg, { rejectWithValue }) => {
  try {
    return await api.pickDirectories('请选择输出根目录');
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    return rejectWithValue({
      message: error instanceof Error ? error.message : '打开目录选择框失败',
      unsupported: status === 501,
    });
  }
});

export const startBatch = createAsyncThunk<Batch, void, { state: RootState; rejectValue: string }>(
  'batch/startBatch',
  async (_arg, { getState, rejectWithValue }) => {
    const state = getState().batch;
    const outputRoot = state.outputRoot.trim();
    if (!outputRoot) return rejectWithValue('请先选择输出根目录');

    const tasks = buildSubmitTasks(state);
    if (tasks.length === 0) return rejectWithValue('没有可编码的目录（缺少主视频）');

    try {
      return await api.createBatch(outputRoot, tasks);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '创建批次失败');
    }
  }
);

export const refreshBatch = createAsyncThunk<Batch, string, { rejectValue: string }>(
  'batch/refreshBatch',
  async (batchId, { rejectWithValue }) => {
    try {
      return await api.getBatch(batchId);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '获取进度失败');
    }
  }
);

export const cancelBatch = createAsyncThunk<Batch, string, { rejectValue: string }>(
  'batch/cancelBatch',
  async (batchId, { rejectWithValue }) => {
    try {
      return await api.cancelBatch(batchId);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '取消失败');
    }
  }
);

const batchSlice = createSlice({
  name: 'batch',
  initialState,
  reducers: {
    manualInputChanged(state, action: PayloadAction<string>) {
      state.manualInput = action.payload;
    },
    scanErrorCleared(state) {
      state.scanError = null;
      if (state.scanStatus === 'error') state.scanStatus = 'idle';
    },
    pickErrorCleared(state) {
      state.pickError = null;
      if (state.pickingStatus === 'error' || state.pickingStatus === 'unsupported') {
        state.pickingStatus = 'idle';
      }
    },
    itemRemoved(state, action: PayloadAction<number>) {
      state.items.splice(action.payload, 1);
    },
    allItemsCleared(state) {
      state.items = [];
      state.scanStatus = 'idle';
      state.scanError = null;
    },
    outputRootChanged(state, action: PayloadAction<string>) {
      state.outputRoot = action.payload;
      state.pickerError = null;
      if (state.pickerStatus === 'error' || state.pickerStatus === 'unsupported') {
        state.pickerStatus = 'idle';
      }
    },
    pickerErrorCleared(state) {
      state.pickerError = null;
      if (state.pickerStatus === 'error' || state.pickerStatus === 'unsupported') {
        state.pickerStatus = 'idle';
      }
    },
    audioLabelChanged(
      state,
      action: PayloadAction<{ itemIndex: number; audioId: string; label: string }>
    ) {
      const audio = state.items[action.payload.itemIndex]?.audios.find(
        (candidate) => candidate.id === action.payload.audioId
      );
      if (audio) audio.label = action.payload.label;
    },
    audioLangChanged(
      state,
      action: PayloadAction<{ itemIndex: number; audioId: string; lang: string }>
    ) {
      const audio = state.items[action.payload.itemIndex]?.audios.find(
        (candidate) => candidate.id === action.payload.audioId
      );
      if (audio) audio.lang = action.payload.lang;
    },
    audioChannelsChanged(
      state,
      action: PayloadAction<{ itemIndex: number; audioId: string; channels: number }>
    ) {
      const audio = state.items[action.payload.itemIndex]?.audios.find(
        (candidate) => candidate.id === action.payload.audioId
      );
      if (audio) audio.channels = action.payload.channels;
    },
    defaultAudioChanged(
      state,
      action: PayloadAction<{ itemIndex: number; audioId: string }>
    ) {
      const item = state.items[action.payload.itemIndex];
      if (!item) return;
      for (const audio of item.audios) audio.isDefault = audio.id === action.payload.audioId;
    },
    subtitleLabelChanged(
      state,
      action: PayloadAction<{ itemIndex: number; subtitleId: string; label: string }>
    ) {
      const item = state.items[action.payload.itemIndex];
      const subtitle = item?.subtitles.find(
        (candidate) => candidate.id === action.payload.subtitleId
      );
      if (!subtitle) return;
      subtitle.label = action.payload.label;
    },
    defaultSubtitleChanged(
      state,
      action: PayloadAction<{ itemIndex: number; subtitleId: string }>
    ) {
      const item = state.items[action.payload.itemIndex];
      if (!item) return;
      for (const subtitle of item.subtitles) {
        subtitle.isDefault = subtitle.id === action.payload.subtitleId;
      }
    },
    subtitleRemoved(
      state,
      action: PayloadAction<{ itemIndex: number; subtitleId: string }>
    ) {
      const item = state.items[action.payload.itemIndex];
      if (!item) return;
      const index = item.subtitles.findIndex(
        (candidate) => candidate.id === action.payload.subtitleId
      );
      if (index < 0) return;
      const [removed] = item.subtitles.splice(index, 1);
      if (removed.isDefault && item.subtitles.length > 0) item.subtitles[0].isDefault = true;
    },
    startErrorCleared(state) {
      state.startError = null;
      if (state.startStatus === 'error') state.startStatus = 'idle';
    },
    batchReset(state) {
      state.batch = null;
      state.startStatus = 'idle';
      state.startError = null;
      state.cancelStatus = 'idle';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(bootstrap.pending, (state) => {
        state.bootstrapStatus = 'loading';
      })
      .addCase(bootstrap.fulfilled, (state, action) => {
        state.bootstrapStatus = 'ready';
        state.health = action.payload.health;
        state.config = action.payload.config;
        state.bootstrapError = null;
        if (!state.outputRoot) state.outputRoot = '';
      })
      .addCase(bootstrap.rejected, (state, action) => {
        state.bootstrapStatus = 'error';
        state.bootstrapError = action.error.message || '初始化失败';
      })

      .addCase(scanDirs.pending, (state) => {
        state.scanStatus = 'scanning';
        state.scanError = null;
      })
      .addCase(scanDirs.fulfilled, (state, action) => {
        state.scanStatus = 'ready';
        state.items = mergeScannedItems(state.items, action.payload);
        state.scanError = null;
      })
      .addCase(scanDirs.rejected, (state, action) => {
        state.scanStatus = 'error';
        state.scanError = action.payload || action.error.message || '扫描失败';
      })

      .addCase(pickSourceDirs.pending, (state) => {
        state.pickingStatus = 'opening';
        state.pickError = null;
      })
      .addCase(pickSourceDirs.fulfilled, (state) => {
        state.pickingStatus = 'idle';
      })
      .addCase(pickSourceDirs.rejected, (state, action) => {
        const payload = action.payload;
        state.pickingStatus = payload?.unsupported ? 'unsupported' : 'error';
        state.pickError = payload?.message || action.error.message || '打开目录选择框失败';
      })

      .addCase(rescanDir.fulfilled, (state, action) => {
        state.items = mergeScannedItems(state.items, action.payload);
      })
      .addCase(rescanDir.rejected, (state, action) => {
        state.scanError = action.payload || action.error.message || '重新扫描失败';
        state.scanStatus = 'error';
      })

      .addCase(pickOutputRoot.pending, (state) => {
        state.pickerStatus = 'opening';
        state.pickerError = null;
      })
      .addCase(pickOutputRoot.fulfilled, (state, action) => {
        state.pickerStatus = 'idle';
        if (action.payload.paths?.length) state.outputRoot = action.payload.paths[0];
      })
      .addCase(pickOutputRoot.rejected, (state, action) => {
        const payload = action.payload;
        state.pickerStatus = payload?.unsupported ? 'unsupported' : 'error';
        state.pickerError = payload?.message || action.error.message || '打开目录选择框失败';
      })

      .addCase(startBatch.pending, (state) => {
        state.startStatus = 'starting';
        state.startError = null;
      })
      .addCase(startBatch.fulfilled, (state, action) => {
        state.startStatus = 'idle';
        state.batch = action.payload;
      })
      .addCase(startBatch.rejected, (state, action) => {
        state.startStatus = 'error';
        state.startError = action.payload || action.error.message || '创建批次失败';
      })

      .addCase(refreshBatch.fulfilled, (state, action) => {
        if (action.payload && state.batch?.id === action.payload.id) {
          state.batch = action.payload;
        }
      })

      .addCase(cancelBatch.pending, (state) => {
        state.cancelStatus = 'cancelling';
      })
      .addCase(cancelBatch.fulfilled, (state, action) => {
        state.cancelStatus = 'idle';
        if (state.batch?.id === action.payload.id) state.batch = action.payload;
      })
      .addCase(cancelBatch.rejected, (state, action) => {
        state.cancelStatus = 'idle';
        state.startError = action.payload || action.error.message || '取消失败';
      });
  },
});

export const {
  manualInputChanged,
  scanErrorCleared,
  pickErrorCleared,
  itemRemoved,
  allItemsCleared,
  outputRootChanged,
  pickerErrorCleared,
  audioLabelChanged,
  audioLangChanged,
  audioChannelsChanged,
  defaultAudioChanged,
  subtitleLabelChanged,
  defaultSubtitleChanged,
  subtitleRemoved,
  startErrorCleared,
  batchReset,
} = batchSlice.actions;

export default batchSlice.reducer;

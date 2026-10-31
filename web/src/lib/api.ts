import type {
  AppConfig,
  Batch,
  CodecSelection,
  HealthPayload,
  ScanItem,
  SubmitTask,
} from '@/lib/types';

const API_BASE = '/api';

function errorMessageFrom(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === 'string' && value) return value;
  }
  return fallback;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = new Error(errorMessageFrom(payload, `请求失败（HTTP ${response.status}）`)) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }

  return payload as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  return parseResponse<T>(response);
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
}

export const api = {
  health: () => request<HealthPayload>('/health'),

  config: () => request<AppConfig>('/config'),

  pickDirectories: (prompt = '请选择视频目录（可多选）') =>
    post<{ paths?: string[]; cancelled?: boolean }>('/pick-directories', { prompt }),

  scan: (dirs: string[], mainVideos?: Record<string, string>) =>
    post<{ items: ScanItem[] }>('/scan', { dirs, mainVideos }),

  createBatch: (outputRoot: string, tasks: SubmitTask[], codecs: CodecSelection, limitSec: number) =>
    post<Batch>('/batches', { outputRoot, tasks, codecs, limitSec }),

  getBatch: (batchId: string) => request<Batch>(`/batches/${batchId}`),

  cancelBatch: (batchId: string) => post<Batch>(`/batches/${batchId}/cancel`, {}),
};

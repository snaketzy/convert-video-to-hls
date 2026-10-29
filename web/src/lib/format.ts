export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

/** 把两个 ISO 时间之间的间隔格式化成 1h02m03s / 02m03s / 03s */
export function formatElapsed(startIso: string | null, endIso?: string | null): string {
  if (!startIso) return '—';
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  if (hours > 0) return `${hours}h${pad(minutes)}m${pad(rest)}s`;
  if (minutes > 0) return `${minutes}m${pad(rest)}s`;
  return `${rest}s`;
}

export function formatFps(fps: number | null | undefined): string {
  if (!fps || !Number.isFinite(fps)) return '—';
  return `${Number.isInteger(fps) ? fps : fps.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} fps`;
}

export function formatResolution(width: number | null, height: number | null): string {
  if (!width || !height) return '—';
  return `${width} × ${height}`;
}

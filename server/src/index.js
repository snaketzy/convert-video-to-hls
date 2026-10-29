import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { BATCH_TTL_MS, HOST, PORT, WEB_DIST } from './config.js';
import { apiRouter } from './routes/api.js';
import { describeBinaries } from './lib/binaries.js';
import { sweepExpiredBatches } from './lib/jobs.js';

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use('/api', apiRouter);

if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
}

app.use((_req, res) => {
  res.status(404).json({ error: '资源不存在' });
});

// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  const status = error.status || (error.name === 'PayloadTooLargeError' ? 413 : 500);
  if (status >= 500) {
    console.error('[api]', error);
  } else {
    console.warn('[api]', error.message);
  }
  res.status(status).json({ error: error.message || '服务端内部错误' });
});

setInterval(
  () => sweepExpiredBatches(),
  Math.min(BATCH_TTL_MS, 30 * 60 * 1000)
).unref();

const binaries = await describeBinaries();
const missing = ['ffmpeg', 'ffprobe', 'packager'].filter((name) => !binaries[name].available);
if (missing.length > 0) {
  console.warn('[警告] 缺少可执行文件：', missing.map((name) => `${name}（${binaries[name].message}）`).join('、'));
} else {
  console.log(`[ffmpeg]   版本 ${binaries.ffmpeg.version} → ${binaries.ffmpeg.path}`);
  console.log(`[ffprobe]  版本 ${binaries.ffprobe.version}`);
  console.log(`[packager] 版本 ${binaries.packager.version} → ${binaries.packager.path}`);
}

app.listen(PORT, HOST, () => {
  console.log(`[server] http://${HOST}:${PORT}`);
  if (!existsSync(WEB_DIST)) {
    console.log('[server] 尚未构建前端，开发时请运行：npm run dev');
  }
});

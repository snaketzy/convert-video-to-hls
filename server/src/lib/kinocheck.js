/**
 * KinoCheck 预告片查询
 *
 * 接口按 tmdb_id / imdb_id 查片，返回自动挑选的主预告（trailer）与全部关联视频
 * （videos[]），每条都带 youtube_video_id，可直接交给 yt-dlp 下载。
 * 语言只有 en / de，中文站点不收录，这里统一要英文预告。
 */

const BASE = process.env.KINOCHECK_API_BASE || 'https://api.kinocheck.com';
const TIMEOUT_MS = 15000;
const LANGUAGE = 'en';

function toTrailer(video) {
  const youtubeVideoId = String(video?.youtube_video_id ?? '').trim();
  if (!youtubeVideoId) return null;
  return {
    youtubeVideoId,
    title: String(video.title ?? ''),
    language: String(video.language ?? ''),
    categories: Array.isArray(video.categories) ? video.categories : [],
    published: video.published ?? null,
  };
}

const hasTrailerCategory = (trailer) => trailer.categories.includes('Trailer');

/** 优先用 KinoCheck 自动挑的主预告，其次取分类含 Trailer 的第一条 */
function selectTrailer(payload) {
  const primary = toTrailer(payload?.trailer);
  if (primary && (hasTrailerCategory(primary) || primary.categories.length === 0)) return primary;

  const videos = Array.isArray(payload?.videos) ? payload.videos : [];
  for (const video of videos) {
    const candidate = toTrailer(video);
    if (candidate && hasTrailerCategory(candidate)) return candidate;
  }
  return primary;
}

async function fetchEntry(tmdbId) {
  const params = new URLSearchParams({
    tmdb_id: String(tmdbId),
    language: LANGUAGE,
    categories: 'Trailer',
  });

  let response;
  try {
    response = await fetch(`${BASE}/movies?${params}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`KinoCheck 请求失败：${error.message}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`KinoCheck 请求失败（HTTP ${response.status}）`);

  const payload = await response.json().catch(() => null);
  // 未收录时返回 200 + {error, message}，按「没查到」处理
  return payload && !payload.error ? payload : null;
}

/**
 * 查询某部电影的预告片
 * @param {number} tmdbId
 * @returns {Promise<null|{youtubeVideoId: string, title: string, language: string, categories: string[], published: string|null}>}
 */
export async function findTrailer(tmdbId) {
  const id = Number(tmdbId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const payload = await fetchEntry(id);
  return payload ? selectTrailer(payload) : null;
}
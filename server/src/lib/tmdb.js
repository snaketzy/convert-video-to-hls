import { TMDB_API_KEY } from '../config.js';

/**
 * TMDB 片名搜索
 *
 * KinoCheck 只接受 tmdb_id / imdb_id、不能按片名查，所以先用 TMDB 把源目录名
 * 解析成 tmdb_id，再交给 KinoCheck 取预告片。
 */

const BASE = 'https://api.themoviedb.org/3';
const TIMEOUT_MS = 15000;

/** 压制组/蓝光命名的常见噪声，搜片名前先剔掉 */
const NOISE_RE =
  /(2160p|1080p|720p|480p|4k|uhd|hdr(10)?|dolby\s?vision|blu-?ray|bdrip|brrip|web-?dl|webrip|hdtv|hdrip|remux|h\.?26[45]|x\.?26[45]|hevc|avc|10bit|8bit|aac|ac3|eac3|dts(-hd)?|truehd|atmos|ddp?5[.\s]?1|flac|proper|repack|internal|extended|unrated|imax|multi|dual|国语|国英|中英|中字|内嵌|简繁|简体|繁体|高清|蓝光|粤语)/gi;

/** 年份必须独立成词，避免把片名里的数字当成年份 */
const YEAR_RE = /(?:^|[\s.(\[])((?:19|20)\d{2})(?=[\s.)\]]|$)/;

export function isTmdbConfigured() {
  return Boolean(TMDB_API_KEY);
}

/**
 * 把「Avengers.Endgame.2019.2160p.BluRay.x265」这类目录名还原成可搜索的片名
 * @returns {{query: string, year: number|null}}
 */
export function cleanTitle(rawName) {
  const original = String(rawName ?? '').trim();
  if (!original) return { query: '', year: null };

  let text = original
    .replace(/\.[a-z0-9]{2,4}$/i, '') // 去掉可能的扩展名
    .replace(/[[\]【】]/g, ' ') // 方括号直接拆掉
    .replace(/[._]+/g, ' ');

  let year = null;
  const yearMatch = text.match(YEAR_RE);
  if (yearMatch) {
    year = Number(yearMatch[1]);
    text = text.replace(YEAR_RE, ' ');
  }

  const cleaned = text.replace(NOISE_RE, ' ').replace(/\s+/g, ' ').trim();
  // 全部被当成噪声剔掉时退回原始名，避免搜出空串
  return { query: cleaned || original, year };
}

async function requestJson(url) {
  const headers = { accept: 'application/json' };
  let target = url;
  // v4 Read Access Token 是 JWT（含点号），用 Bearer；v3 key 走 api_key 参数
  if (TMDB_API_KEY.includes('.')) {
    headers.authorization = `Bearer ${TMDB_API_KEY}`;
  } else {
    target += `${target.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(TMDB_API_KEY)}`;
  }

  const response = await fetch(target, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`TMDB 请求失败（HTTP ${response.status}），请检查 TMDB_API_KEY`);
  }
  return response.json();
}

/**
 * 按片名搜索电影，取第一条结果
 * @param {string} name 源目录名或片名
 * @returns {Promise<null|{tmdbId: number, title: string, releaseYear: number|null}>}
 */
export async function searchMovie(name) {
  if (!isTmdbConfigured()) return null;

  const { query, year } = cleanTitle(name);
  if (!query) return null;

  const params = new URLSearchParams({ query, include_adult: 'false', language: 'zh-CN' });
  if (year) params.set('year', String(year));

  const payload = await requestJson(`${BASE}/search/movie?${params}`);
  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (results.length === 0) return null;

  const best = results[0];
  return {
    tmdbId: best.id,
    title: best.title || best.original_title || query,
    releaseYear: best.release_date ? Number(String(best.release_date).slice(0, 4)) : null,
  };
}
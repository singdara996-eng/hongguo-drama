const { searchApp } = require('../src/native/hongguo-app-search');
const { searchHongguo } = require('../src/native/hongguo-search');
const media = require('./media.cjs');
const cursors = new Map();

async function search(keyword, options = {}) {
  const kw = String(keyword || '').trim();
  const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
  const opts = { ...options, page };

  // 1. Direct ID or Link Detection
  const idMatch = kw.match(/(?:series_id=|\/detail\/|\b)(\d{6,30})\b/);
  if (idMatch) {
    try {
      const series = await media.series(idMatch[1]);
      if (series && series.series_title) {
        return {
          success: true,
          results: [{
            series_id: String(series.series_id),
            series_title: String(series.series_title),
            cover: String(series.cover || ''),
            total: series.total || series.episodes?.length || 0
          }],
          page: 1,
          hasMore: false
        };
      }
    } catch (_) {}
  }

  // 2. Try Hongguo Web Search (very reliable and returns full details)
  try {
    const webResult = await searchHongguo(kw, opts);
    if (webResult && Array.isArray(webResult.results) && webResult.results.length > 0) {
      return webResult;
    }
  } catch (err) {
    console.warn('[Search] webSearch fallback due to:', err.message);
  }

  // 3. Try Hongguo App Search
  try {
    const key = `${kw}:${page}`;
    const cached = cursors.get(key);
    const appResult = await searchApp(kw, { ...opts, cursor: cached?.expires > Date.now() ? cached.cursor : null });
    if (appResult?.hasMore && appResult.cursor) {
      cursors.set(`${kw}:${page + 1}`, { cursor: appResult.cursor, expires: Date.now() + 300000 });
    }
    while (cursors.size > 100) cursors.delete(cursors.keys().next().value);
    if (appResult && Array.isArray(appResult.results) && appResult.results.length > 0) {
      return appResult;
    }
  } catch (err) {
    console.warn('[Search] appSearch error:', err.message);
  }

  return { success: true, results: [], page, hasMore: false };
}

module.exports = { search };

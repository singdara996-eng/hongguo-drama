// Hongguo Drama 8.2: server entry.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Storage, fail, safeError, assertFields, numericId } = require('./storage.cjs');
const defaultMedia = require('./media.cjs');
const { search: searchHongguo } = require('./search.cjs');
const PUBLIC = path.join(__dirname, 'public');

function makeTask(fields) {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), ...fields, status: 'queued', progress: 0, createdAt: now, updatedAt: now };
}
function pausesDownloads(error) {
  if ([403, 429].includes(Number(error?.response?.status))) return true;
  return ['BUSINESS_REJECTED', 'DEVICE_REGISTRATION_FAILED'].includes(error?.code)
    || error?.code === 'SOURCE_UNAVAILABLE' && error.sources?.some(item => item.source === 'app' && /^(?:BUSINESS_REJECTED|DEVICE_REGISTRATION_FAILED|HTTP_(?:403|429))$/.test(item.code));
}
async function body(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw fail('请求必须使用 application/json', 415);
  let bytes = 0, chunks = [];
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 65536) throw fail('请求过大', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('JSON 格式无效'); }
}
function createApp({ token, dataRoot, downloadRoot, media = defaultMedia, search = searchHongguo, autoStart = true }) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256 || /\s/.test(token)) throw fail('必须配置 32 至 256 字符的 HONGGUO_TOKEN，不得含空白');
  const digest = crypto.createHash('sha256').update(`Bearer ${token}`).digest();
  const store = new Storage(dataRoot, downloadRoot);
  let active, stopped = false, reading = 0, shuttingDown, nextDownloadAt = 0, downloadTimer;
  const controllerById = new Map();
  const authorized = request => crypto.timingSafeEqual(digest, crypto.createHash('sha256').update(String(request.headers.authorization || '')).digest());
  function drain() {
    if (active || stopped) return;
    try { store.checkRoot(); } catch (error) {
      if (error.code !== 'MOUNT_CHANGED') return;
      try { store.interruptQueued('下载挂载已变化，已暂停剩余任务；请恢复原挂载后手动重试'); } catch { stopped = true; }
      return;
    }
    const task = store.tasks.find(item => item.status === 'queued');
    if (!task) return;
    if (task.type === 'download' && nextDownloadAt > Date.now()) {
      clearTimeout(downloadTimer);
      downloadTimer = setTimeout(drain, nextDownloadAt - Date.now());
      return;
    }
    const controller = new AbortController();
    controllerById.set(task.id, controller);
    try { store.update(task, { status: 'running', error: '', progress: 0 }); } catch { stopped = true; return; }
    let lastUpdate = 0, storageFailed = false;
    const update = progress => {
      if (task.status !== 'running' || Date.now() - lastUpdate < 500 || storageFailed) return;
      lastUpdate = Date.now();
      try { store.update(task, { progress }); } catch { storageFailed = true; stopped = true; controller.abort(); }
    };
    active = (async () => {
      try {
        await media[task.type](task, store, controller.signal, update);
        if (task.status === 'running' && !storageFailed) store.complete(task);
      } catch (error) {
        if (task.status === 'running' && !storageFailed) store.update(task, { status: 'failed', error: safeError(error) });
        if (!storageFailed && error.code === 'MOUNT_CHANGED') store.interruptQueued('下载挂载已变化，已暂停剩余任务；请恢复原挂载后手动重试');
        else if (!storageFailed && pausesDownloads(error)) store.interruptQueued('来源拒绝请求，已暂停队列；请稍后手动重试');
      } finally {
        if (task.type === 'download') nextDownloadAt = Date.now() + 1000;
        controllerById.delete(task.id); active = null; if (!stopped) setImmediate(drain);
      }
    })().catch(() => { stopped = true; });
  }
  const server = http.createServer(async (request, response) => {
    const send = (status, value) => { if (!response.headersSent) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); } };
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') { response.writeHead(204); return response.end(); }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health' && request.method === 'GET') return send(stopped ? 503 : 200, { status: stopped ? 'stopping' : 'ok' });
      if (!url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(request.method)) throw fail('方法不允许', 405);
        const distRoot = path.join(__dirname, '../dist-react');
        let filePath = path.join(distRoot, decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1)));
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          const fallback = path.join(distRoot, 'index.html');
          if (fs.existsSync(fallback)) filePath = fallback;
        }
        if (!fs.existsSync(filePath)) {
          filePath = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        }
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) throw fail('页面不存在', 404);
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.mjs': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.wasm': 'application/wasm'
        };
        response.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
        return response.end(request.method === 'HEAD' ? undefined : fs.readFileSync(filePath));
      }
      if (request.method === 'GET' && url.pathname === '/api/proxy-image') {
        const imgUrl = url.searchParams.get('url');
        if (!imgUrl || !/^https?:\/\//i.test(imgUrl)) throw fail('图片地址无效', 400);
        const https = require('https');
        const imgReq = https.get(imgUrl, { headers: { 'Referer': 'https://hongguoduanju.com/', 'User-Agent': 'Mozilla/5.0' } }, imgRes => {
          response.writeHead(imgRes.statusCode, { 'Content-Type': imgRes.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
          imgRes.pipe(response);
        });
        imgReq.on('error', () => { if (!response.headersSent) send(404, { success: false }); });
        return;
      }
      const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
      if (!isLocal && !authorized(request)) throw fail('访问令牌无效', 401);
      if (stopped) throw fail('服务正在停止或持久化失败，请检查存储后重启', 503);
      if (request.headers.origin) {
        let origin; try { origin = new URL(request.headers.origin); } catch { throw fail('来源无效', 403); }
        const isLocalOrigin = ['localhost', '127.0.0.1'].includes(origin.hostname);
        if (!isLocalOrigin && (origin.host !== request.headers.host || !['http:', 'https:'].includes(origin.protocol))) throw fail('只允许同源请求', 403);
      }
      const route = url.pathname;
      if (request.method === 'GET' && route === '/api/browse-categories') {
        const BROWSE_CATEGORIES = [
          { slug: 'real-drama', label: '真人剧' },
          { slug: 'comic-drama', label: '漫剧' },
          { slug: 'ai-drama', label: 'AI剧' },
          { slug: 'comic', label: '漫画' },
          { slug: 'hot-drama', label: '综合热播榜', group: 'rank' },
          { slug: 'hot-real-drama', label: '真人热播榜', group: 'rank' },
          { slug: 'hot-comic-drama', label: '漫剧热播榜', group: 'rank' },
          { slug: 'hot-ai-drama', label: 'AI 热播榜', group: 'rank' }
        ];
        return send(200, BROWSE_CATEGORIES);
      }
      if (request.method === 'GET' && (route === '/api/browse-list' || route === '/api/discover')) {
        const category = url.searchParams.get('category') || url.searchParams.get('ranking') || 'real-drama';
        const genre = url.searchParams.get('genre') || '';
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
        try {
          const { browseList } = require('../src/native/catalog.js');
          let catalog = await browseList({ category, genre, page });
          if (!catalog || !catalog.results || !catalog.results.length) {
            const appCat = require('../src/native/hongguo-app-catalog.js');
            catalog = await appCat.browseList({ category, genre, page });
          }
          if (catalog && Array.isArray(catalog.results)) {
            catalog.results = catalog.results.map(item => ({
              ...item,
              cover: item.cover ? (item.cover.includes('/api/proxy-image') ? item.cover : ('http://localhost:3000/api/proxy-image?url=' + encodeURIComponent(item.cover))) : ''
            }));
          }
          return send(200, catalog);
        } catch (e) {
          try {
            const appCat = require('../src/native/hongguo-app-catalog.js');
            const catalog = await appCat.browseList({ category, genre, page });
            if (catalog && Array.isArray(catalog.results)) {
              catalog.results = catalog.results.map(item => ({
                ...item,
                cover: item.cover ? (item.cover.includes('/api/proxy-image') ? item.cover : ('http://localhost:3000/api/proxy-image?url=' + encodeURIComponent(item.cover))) : ''
              }));
            }
            return send(200, catalog);
          } catch (err2) {
            return send(500, { success: false, error: String(e) });
          }
        }
      }
      if (request.method === 'GET' && route === '/api/status') return send(200, { success: true, version: require('../package.json').version, downloadRoot: '/downloads', concurrency: 1 });
      if (request.method === 'GET' && route === '/api/tasks') {
        store.checkRoot(); store.reconcileCompleted();
        return send(200, { success: true, tasks: store.tasks.map(task => store.publicTask(task)).reverse() });
      }
      if (request.method === 'GET' && (route === '/api/search' || /^\/api\/series\/[^/]+$/.test(route))) {
        if (reading >= 2) throw fail('上游查询繁忙，请稍后重试', 429);
        reading++;
        try {
          if (route === '/api/search') {
            const q = (url.searchParams.get('q') || '').trim();
            const rawPage = parseInt(url.searchParams.get('page'), 10);
            const page = Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 50 ? rawPage : 1;
            if (!q || q.length > 200) throw fail('搜索词无效', 400);
            const result = await search(q, { page, retries: 1, deadline: Date.now() + 20000 });
            const results = (result.results || []).filter(item => /^\d{1,30}$/.test(String(item.series_id))).map(item => ({
              series_id: String(item.series_id),
              series_title: String(item.series_title || ''),
              cover: item.cover ? (item.cover.includes('/api/proxy-image') ? item.cover : ('http://localhost:3000/api/proxy-image?url=' + encodeURIComponent(item.cover))) : '',
              total: item.total || item.episode_count || 0
            }));
            return send(200, { success: true, results, page, hasMore: result.hasMore === true || result.has_more === true });
          }
          return send(200, { success: true, series: await media.series(numericId(route.split('/').pop())) });
        } finally { reading--; }
      }
      const fileRoute = /^\/api\/files\/([a-f0-9-]{36})$/.exec(route);
      if (fileRoute && request.method === 'GET') {
        const task = store.get(fileRoute[1]); if (task.status !== 'completed') throw fail('文件尚未完成', 409);
        const file = store.artifact(task).file, fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size < 1) { fs.closeSync(fd); throw fail('文件不可用', 409, 'ARTIFACT_INVALID'); }
        response.setHeader('Content-Type', 'video/mp4'); response.setHeader('Content-Length', stat.size);
        response.setHeader('Content-Disposition', `attachment; filename="${task.id}.mp4"`);
        const stream = fs.createReadStream(file, { fd, autoClose: true });
        response.once('close', () => stream.destroy()); stream.on('error', () => response.destroy()); return stream.pipe(response);
      }
      if (request.method !== 'POST') throw fail('接口不存在', 404);
      const payload = await body(request);
      if (route === '/api/downloads') {
        if (!payload.episodeIds && Array.isArray(payload.episodes)) {
          payload.episodeIds = payload.episodes.map(e => String(e.vid || e.id));
        }
        if (!payload.quality) payload.quality = 'auto';
        assertFields(payload, ['seriesId', 'episodeIds', 'quality']); numericId(payload.seriesId);
        store.checkRoot();
        if (!Array.isArray(payload.episodeIds) || !payload.episodeIds.length || payload.episodeIds.length > 1000 || payload.episodeIds.some(id => typeof id !== 'string' || !/^\d{1,30}$/.test(id)) || new Set(payload.episodeIds).size !== payload.episodeIds.length) throw fail('请选择有效且不重复的分集');
        const quality = payload.quality || 'auto'; if (!['auto', '720p', '1080p'].includes(quality)) throw fail('画质无效');
        if (reading >= 2) throw fail('上游查询繁忙，请稍后重试', 429);
        let detail; reading++; try { detail = await media.series(payload.seriesId); } finally { reading--; }
        const selected = detail.episodes.filter(item => payload.episodeIds.includes(item.vid));
        if (selected.length !== payload.episodeIds.length) throw fail('选择包含不属于本剧的分集');
        // Resolve duplicates after the awaited catalogue so concurrent submissions remain idempotent.
        const tasks = [], added = [];
        for (const episode of selected) {
          let existing = store.tasks.find(item => item.type === 'download' && item.seriesId === payload.seriesId && item.vid === episode.vid && item.quality === quality && ['queued', 'running', 'completed'].includes(item.status));
          if (existing?.status === 'completed') {
            try { store.artifact(existing); } catch (error) {
              if (error.code !== 'ARTIFACT_INVALID') throw error;
              store.quarantineArtifact(existing);
              store.update(existing, { status: 'queued', progress: 0, error: '', artifact: null });
            }
          }
          const task = existing || makeTask({ type: 'download', seriesId: detail.series_id, seriesTitle: detail.series_title, vid: episode.vid, episodeIndex: episode.vid_index, episodeTitle: episode.title, quality });
          tasks.push(task); if (!existing) added.push(task);
        }
        if (added.length) store.add(added);
        stopped = false;
        send(202, { success: true, tasks: tasks.map(task => store.publicTask(task)) }); drain(); return;
      }
      if (route === '/api/merge') {
        assertFields(payload, ['taskIds']);
        if (!Array.isArray(payload.taskIds) || payload.taskIds.length < 2 || payload.taskIds.length > 1000 || new Set(payload.taskIds).size !== payload.taskIds.length) throw fail('请至少选择两个不同的已完成分集');
        const inputs = payload.taskIds.map(id => store.get(id)).sort((a, b) => a.episodeIndex - b.episodeIndex), first = inputs[0];
        if (inputs.some(input => input.type !== 'download' || input.status !== 'completed' || input.seriesId !== first.seriesId) || new Set(inputs.map(input => input.episodeIndex)).size !== inputs.length) throw fail('只允许同剧且集号不重复的已完成分集合并');
        for (const input of inputs) {
          try { store.artifact(input); } catch (error) {
            if (error.code === 'MOUNT_CHANGED') throw error;
            if (error.code === 'ARTIFACT_INVALID') throw fail('分集文件不可用，请重新下载', 409, 'ARTIFACT_INVALID');
            throw error;
          }
        }
        const task = makeTask({ type: 'merge', seriesId: first.seriesId, seriesTitle: first.seriesTitle, taskIds: inputs.map(input => input.id) });
        store.add([task]); stopped = false; send(202, { success: true, task: store.publicTask(task) }); drain(); return;
      }
      const action = /^\/api\/tasks\/([a-f0-9-]{36})\/(retry|cancel)$/.exec(route);
      if (action) {
        assertFields(payload, []); const task = store.get(action[1]);
        if (action[2] === 'retry') {
          if (!['failed', 'cancelled', 'interrupted'].includes(task.status) || controllerById.has(task.id)) throw fail('当前任务不能重试，请等待停止完成', 409);
          if (task.type === 'download' && store.tasks.some(other => other.id !== task.id && other.type === 'download' && other.seriesId === task.seriesId && other.vid === task.vid && other.quality === task.quality && ['queued', 'running', 'completed'].includes(other.status))) throw fail('同集同画质已有有效任务，请使用现有任务', 409);
          store.update(task, { status: 'queued', progress: 0, error: '' });
          stopped = false;
        } else {
          if (!['queued', 'running'].includes(task.status)) throw fail('当前任务不能取消', 409);
          store.update(task, { status: 'cancelled', error: '已取消；已完成文件保留' }); controllerById.get(task.id)?.abort();
        }
        send(200, { success: true, task: store.publicTask(task) }); drain(); return;
      }
      if (route === '/api/queue/pause') {
        stopped = true;
        clearTimeout(downloadTimer);
        for (const controller of controllerById.values()) controller.abort();
        let count = 0;
        for (const t of store.tasks) {
          if (['queued', 'running'].includes(t.status)) {
            t.status = 'stopped';
            count++;
          }
        }
        store.save();
        return send(200, { success: true, count });
      }
      if (route === '/api/queue/resume') {
        stopped = false;
        let count = 0;
        for (const t of store.tasks) {
          if (['stopped', 'failed', 'interrupted', 'cancelled'].includes(t.status)) {
            t.status = 'queued';
            t.error = '';
            count++;
          }
        }
        store.save();
        setImmediate(drain);
        return send(200, { success: true, count });
      }
      if (route === '/api/tasks/delete' || route === '/api/delete-tasks') {
        const payload = await body(request);
        const ids = new Set(payload.taskIds || (payload.taskId ? [payload.taskId] : []));
        store.tasks = store.tasks.filter(t => !ids.has(t.id));
        store.save();
        return send(200, { success: true, count: ids.size });
      }
      throw fail('接口不存在', 404);
    } catch (error) {
      if (error.code === 'MOUNT_CHANGED') {
        try { store.interruptQueued('下载挂载已变化，已暂停剩余任务；请恢复原挂载后手动重试'); } catch { stopped = true; }
        return send(409, { success: false, code: 'MOUNT_CHANGED', error: safeError(error) });
      }
      send(error.status || 500, { success: false, error: safeError(error) });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.maxConnections = 64;
  if (autoStart) setImmediate(drain);
  async function close() {
    if (shuttingDown) return shuttingDown;
    stopped = true;
    clearTimeout(downloadTimer);
    shuttingDown = (async () => {
      try {
        for (const task of store.tasks.filter(item => item.status === 'running')) store.update(task, { status: 'interrupted', error: '服务已停止，请手动重试' });
      } catch {} finally { for (const controller of controllerById.values()) controller.abort(); }
      const closed = new Promise(resolve => server.listening ? server.close(resolve) : resolve());
      server.closeIdleConnections();
      await active; await closed;
    })();
    return shuttingDown;
  }
  return { server, store, close, drain };
}
if (require.main === module) {
  try {
    const defaultDataDir = path.join(__dirname, '../server_data');
    const defaultDownloadDir = path.join(__dirname, '../downloads');
    if (!fs.existsSync(defaultDataDir)) fs.mkdirSync(defaultDataDir, { recursive: true });
    if (!fs.existsSync(defaultDownloadDir)) fs.mkdirSync(defaultDownloadDir, { recursive: true });
    const token = process.env.HONGGUO_TOKEN || '1234567890abcdef1234567890abcdef';
    const dataRoot = process.env.DATA_DIR || defaultDataDir;
    const downloadRoot = process.env.DOWNLOAD_DIR || defaultDownloadDir;
    const app = createApp({ token, dataRoot, downloadRoot, autoStart: false });
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('端口无效');
    app.server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Hongguo Web listening on port ${port}`));
    app.server.on('error', error => { console.error(`服务启动失败：${error.code || '未知'}`); process.exit(1); });
    for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => { app.close().then(() => process.exit(0), () => process.exit(1)); });
  } catch (error) { console.error(safeError(error)); process.exitCode = 1; }
}
module.exports = { createApp, makeTask };

const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { Readable } = require('stream');
const { execFile } = require('child_process');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, 'public');
const LOCAL_PYTHON = 'C:\\Users\\Junda Mou\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
const PYTHON = process.env.PYTHON_BIN || (fs.existsSync(LOCAL_PYTHON) ? LOCAL_PYTHON : process.platform === 'win32' ? 'python' : 'python3');
const YOUTUBE_WORKER = path.join(__dirname, 'scripts', 'youtube_worker.py');
const MEDIA_CACHE = path.join(__dirname, 'media-cache');
const YOUTUBE_COOKIES_PATH = path.join(MEDIA_CACHE, 'youtube-cookies.txt');
const APP_USERNAME = process.env.APP_USERNAME || '111';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (!APP_PASSWORD) {
  throw new Error('APP_PASSWORD is required');
}
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const jobs = new Map();
const loginAttempts = new Map();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  try {
    return Object.fromEntries((req.headers.cookie || '').split(';').map(item => item.trim().split('=').map(decodeURIComponent)).filter(parts => parts.length === 2));
  } catch { return {}; }
}

function createSessionToken(username) {
  const payload = Buffer.from(JSON.stringify({ username, expires: Date.now() + SESSION_MAX_AGE * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function isAuthenticated(req) {
  const token = parseCookies(req).echo_session || '';
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.username === APP_USERNAME && data.expires > Date.now();
  } catch { return false; }
}

function sessionCookie(req, token, maxAge = SESSION_MAX_AGE) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `echo_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function authApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    return json(res, isAuthenticated(req) ? 200 : 401, { authenticated: isAuthenticated(req) });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const client = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const record = loginAttempts.get(client) || { count: 0, blockedUntil: 0 };
    if (record.blockedUntil > Date.now()) return json(res, 429, { error: '尝试次数过多，请稍后再试' });
    const body = await readBody(req);
    if (!safeEqual(body.username || '', APP_USERNAME) || !safeEqual(body.password || '', APP_PASSWORD)) {
      record.count += 1;
      if (record.count >= 5) { record.count = 0; record.blockedUntil = Date.now() + 5 * 60 * 1000; }
      loginAttempts.set(client, record);
      return json(res, 401, { error: '账号或密码错误' });
    }
    loginAttempts.delete(client);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': sessionCookie(req, createSessionToken(APP_USERNAME)) });
    return res.end(JSON.stringify({ authenticated: true }));
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': sessionCookie(req, '', 0) });
    return res.end(JSON.stringify({ authenticated: false }));
  }
  return json(res, 404, { error: '登录接口不存在' });
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168);
  }
  return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80');
}

async function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('链接格式不正确'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP/HTTPS 链接');
  const records = await dns.lookup(url.hostname, { all: true });
  if (!records.length || records.some(r => isPrivateIp(r.address))) throw new Error('不允许访问本机或内网地址');
  return url;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > 1_000_000) reject(new Error('请求过大'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function validateYoutubeCookies(content) {
  const normalized = String(content || '').replace(/\r\n/g, '\n').trim() + '\n';
  if (normalized.length > 500_000) throw new Error('Cookie 文件过大');
  const firstLine = normalized.split('\n', 1)[0];
  if (!/^# (?:Netscape )?HTTP Cookie File/i.test(firstLine)) {
    throw new Error('请上传 Netscape cookies.txt 文件');
  }
  if (!/(?:^|\n)(?:#HttpOnly_)?\.?youtube\.com\t/im.test(normalized) && !/(?:^|\n)(?:#HttpOnly_)?\.?google\.com\t/im.test(normalized)) {
    throw new Error('Cookie 文件中没有 YouTube/Google 登录记录');
  }
  return normalized;
}

function decodeHtml(s = '') {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function stripTags(s = '') {
  return decodeHtml(String(s).replace(/<[^>]*>/g, '')).trim();
}

function absolute(candidate, base) {
  try { return new URL(decodeHtml(candidate), base).href; } catch { return null; }
}

async function extractPage(pageUrl) {
  const url = await safeUrl(pageUrl);
  const biliId = url.href.match(/(?:video\/|bvid=)(BV[\w]+)/i)?.[1];
  if (biliId) {
    return { title: `哔哩哔哩 · ${biliId}`, bilibiliId: biliId, captions: [] };
  }
  const youtubeId = url.href.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{6,})/i)?.[1];
  if (youtubeId) {
    return { title: `YouTube · ${youtubeId}`, youtubeId, captions: [] };
  }
  const direct = /\.(mp4|webm|ogg|m3u8)(\?.*)?$/i.test(url.pathname + url.search);
  if (direct) return { title: path.basename(url.pathname), videoUrl: url.href, captions: [] };

  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'EchoStudy/1.0 (+local learning tool)', accept: 'text/html,*/*' },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`网页返回 ${response.status}`);
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) throw new Error('该链接不是网页或可播放的视频直链');
  const html = (await response.text()).slice(0, 5_000_000);
  const pick = patterns => {
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return absolute(match[1], response.url);
    }
    return null;
  };
  const videoUrl = pick([
    /<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::url)?["']/i,
    /<video[^>]+src=["']([^"']+)/i,
    /<source[^>]+src=["']([^"']+)/i
  ]);
  const titleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || html.match(/<title[^>]*>([^<]+)/i);
  const captions = [...html.matchAll(/<track[^>]+(?:kind=["']subtitles["'][^>]+)?src=["']([^"']+)["'][^>]*>/gi)]
    .map(m => absolute(m[1], response.url)).filter(Boolean).slice(0, 8);
  if (!videoUrl) throw new Error('页面没有公开的可播放视频地址。受保护平台请使用其允许的下载文件或视频直链。');
  return { title: decodeHtml(titleMatch?.[1] || url.hostname), videoUrl, captions };
}

async function searchArchive(query) {
  const params = new URLSearchParams({
    q: `mediatype:movies AND (${query})`,
    fl: 'identifier,title,description,creator,date,downloads',
    rows: '12', page: '1', output: 'json', sort: 'downloads desc'
  });
  const response = await fetch(`https://archive.org/advancedsearch.php?${params}`, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`搜索服务返回 ${response.status}`);
  const data = await response.json();
  return (data.response?.docs || []).map(item => ({
    id: item.identifier,
    title: item.title || item.identifier,
    creator: Array.isArray(item.creator) ? item.creator[0] : item.creator || 'Internet Archive',
    year: String(item.date || '').slice(0, 4),
    downloads: item.downloads || 0,
    thumb: `https://archive.org/services/img/${encodeURIComponent(item.identifier)}`
  }));
}

async function searchBilibili(query) {
  const params = new URLSearchParams({ search_type: 'video', keyword: query, pn: '1' });
  const response = await fetch(`https://api.bilibili.com/x/web-interface/search/type?${params}`, {
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://search.bilibili.com/' },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`搜索服务返回 ${response.status}`);
  const data = await response.json();
  if (data.code !== 0) throw new Error(data.message || '搜索服务暂不可用');
  return (data.data?.result || []).filter(item => item.type === 'video' && item.bvid).slice(0, 12).map(item => ({
    id: item.bvid,
    provider: 'bilibili',
    title: stripTags(item.title),
    creator: item.author || '哔哩哔哩',
    year: item.pubdate ? String(new Date(item.pubdate * 1000).getFullYear()) : '',
    downloads: item.play || 0,
    thumb: item.pic?.startsWith('//') ? `https:${item.pic}` : item.pic,
    embedUrl: `https://player.bilibili.com/player.html?bvid=${item.bvid}&page=1&high_quality=1&danmaku=0`
  }));
}

async function searchYouTube(query) {
  const data = await runPython(['search', query], 60 * 1000);
  return data.items || [];
}

const BILI_HEADERS = { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' };

async function biliJson(url) {
  const response = await fetch(url, { headers: BILI_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`哔哩哔哩接口返回 ${response.status}`);
  const data = await response.json();
  if (data.code !== 0) throw new Error(data.message || '视频信息读取失败');
  return data.data;
}

function combineBiliSubtitles(tracks) {
  if (!tracks.length) return [];
  const english = tracks.find(t => /^en/i.test(t.lan));
  if (!english) return [];
  const chinese = tracks.find(t => /^zh|ai-zh/i.test(t.lan));
  return english.body.map(item => {
    const translation = chinese?.body.find(x => x.from < item.to && x.to > item.from)?.content || '';
    return { start: item.from, end: item.to, en: item.content, zh: translation };
  });
}

async function bilibiliMedia(bvid) {
  if (!/^BV[\w]{8,14}$/i.test(bvid)) throw new Error('视频 BV 号无效');
  const view = await biliJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  const cid = view.cid || view.pages?.[0]?.cid;
  if (!cid) throw new Error('没有找到视频分P信息');
  const play = await biliJson(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=64&fnval=0&platform=html5`);
  const direct = play.durl?.[0]?.url;
  if (!direct) throw new Error('平台没有返回可播放的视频流');

  let subtitles = [];
  try {
    const player = await biliJson(`https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`);
    const metadata = player.subtitle?.subtitles || [];
    const tracks = await Promise.all(metadata.slice(0, 4).map(async track => {
      const source = track.subtitle_url?.startsWith('//') ? `https:${track.subtitle_url}` : track.subtitle_url;
      const response = await fetch(source, { headers: BILI_HEADERS, signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      return { lan: track.lan || '', body: data.body || [] };
    }));
    subtitles = combineBiliSubtitles(tracks.filter(t => t.body.length));
  } catch { subtitles = []; }

  const result = {
    title: view.title || bvid,
    videoUrl: `/api/media?url=${encodeURIComponent(direct)}`,
    cues: subtitles,
    subtitleStatus: subtitles.length ? `已加载 ${subtitles.length} 条平台字幕` : '平台未提供英文字幕，正在使用本地 Whisper 识别音频。'
  };
  if (!subtitles.length) {
    result.jobId = startTranscription(`bilibili-${bvid}`, `https://www.bilibili.com/video/${bvid}`);
  } else if (subtitles.some(cue => !cue.zh)) {
    result.translationJobId = startTranslation(`bilibili-${bvid}`, subtitles);
  }
  return result;
}

function runPython(args, timeout = 90000) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [YOUTUBE_WORKER, ...args], {
      cwd: __dirname,
      timeout,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    }, (error, stdout, stderr) => {
      let data;
      try { data = JSON.parse(stdout.trim()); } catch { data = null; }
      if (error || data?.error) return reject(new Error(data?.error || stderr.trim() || error.message));
      if (!data) return reject(new Error('本地处理程序没有返回有效结果，请重试'));
      resolve(data);
    });
  });
}

function startTranscription(videoId, url) {
  const jobId = crypto.randomUUID();
  const cacheDir = path.join(MEDIA_CACHE, videoId);
  const cachedPath = path.join(cacheDir, 'translated-cues.json');
  try {
    const cached = JSON.parse(fs.readFileSync(cachedPath, 'utf8'));
    if (cached.source && cached.cues?.length) {
      jobs.set(jobId, { id: jobId, status: 'complete', progress: '已加载本地双语字幕缓存', cues: cached.cues, source: cached.source });
      return jobId;
    }
  } catch { /* No complete cache yet. */ }
  jobs.set(jobId, { id: jobId, status: 'transcribing', progress: '正在下载音频并启动本地 Whisper…' });
  runPython(['transcribe', url, cacheDir], 60 * 60 * 1000).then(async data => {
    let cues = data.cues || [];
    let source = data.source;
    if (cues.length && cues.some(cue => !cue.zh)) {
      jobs.set(jobId, { id: jobId, status: 'translating', progress: '语音识别完成，正在生成中文翻译…' });
      fs.mkdirSync(cacheDir, { recursive: true });
      const inputPath = path.join(cacheDir, 'translation-input.json');
      const outputPath = path.join(cacheDir, 'translated-cues.json');
      fs.writeFileSync(inputPath, JSON.stringify(cues), 'utf8');
      const translated = await runPython(['translate', inputPath, outputPath], 60 * 60 * 1000);
      cues = translated.cues || cues;
      source = `${source}+${translated.source}`;
    }
    jobs.set(jobId, { id: jobId, status: 'complete', progress: '双语字幕生成完成', cues, source });
  }).catch(error => {
    jobs.set(jobId, { id: jobId, status: 'error', progress: error.message || '自动识别失败' });
  });
  return jobId;
}

function startTranslation(videoId, cues) {
  const jobId = crypto.randomUUID();
  const cacheDir = path.join(MEDIA_CACHE, videoId);
  const inputPath = path.join(cacheDir, 'translation-input.json');
  const outputPath = path.join(cacheDir, 'translated-cues.json');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(inputPath, JSON.stringify(cues), 'utf8');
  jobs.set(jobId, { id: jobId, status: 'translating', progress: '正在使用本地模型生成中文翻译…' });
  runPython(['translate', inputPath, outputPath], 60 * 60 * 1000).then(data => {
    jobs.set(jobId, { id: jobId, status: 'complete', progress: '中文翻译生成完成', cues: data.cues || [], source: data.source });
  }).catch(error => {
    jobs.set(jobId, { id: jobId, status: 'error', progress: error.message || '中文翻译失败' });
  });
  return jobId;
}

async function youtubeMedia(id) {
  if (!/^[\w-]{6,20}$/.test(id)) throw new Error('YouTube 视频 ID 无效');
  const url = `https://www.youtube.com/watch?v=${id}`;
  const data = await runPython(['inspect', url]);
  const result = {
    title: data.title,
    duration: data.duration,
    videoUrl: data.videoUrl,
    cues: data.cues || [],
    subtitleSource: data.subtitleSource
  };
  if (!result.cues.length) {
    result.jobId = startTranscription(id, url);
  } else if (result.cues.some(cue => !cue.zh)) {
    result.translationJobId = startTranslation(id, result.cues);
  }
  return result;
}

async function proxyBiliMedia(req, res, source) {
  const url = await safeUrl(source);
  const host = url.hostname.toLowerCase();
  if (!(host.endsWith('.bilivideo.com') || host.endsWith('.bilivideo.net') || host.endsWith('.akamaized.net') || host.endsWith('.googlevideo.com'))) {
    throw new Error('媒体来源不在允许列表中');
  }
  let suppliedHeaders = {};
  try {
    const token = new URL(req.url, 'http://localhost').searchParams.get('headers');
    if (token) suppliedHeaders = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch { suppliedHeaders = {}; }
  const headers = host.endsWith('.googlevideo.com')
    ? { 'user-agent': suppliedHeaders['User-Agent'] || suppliedHeaders['user-agent'] || 'Mozilla/5.0', referer: 'https://www.youtube.com/' }
    : { ...BILI_HEADERS };
  if (req.headers.range) headers.range = req.headers.range;
  const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!response.ok && response.status !== 206) throw new Error(`视频流返回 ${response.status}`);
  const outputHeaders = {
    'content-type': response.headers.get('content-type') || 'video/mp4',
    'accept-ranges': response.headers.get('accept-ranges') || 'bytes',
    'cache-control': 'private, max-age=600'
  };
  ['content-length', 'content-range'].forEach(name => {
    const value = response.headers.get(name);
    if (value) outputHeaders[name] = value;
  });
  res.writeHead(response.status, outputHeaders);
  Readable.fromWeb(response.body).pipe(res);
}

async function archiveMedia(id) {
  if (!/^[\w.-]+$/.test(id)) throw new Error('资源标识无效');
  const response = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`资源服务返回 ${response.status}`);
  const data = await response.json();
  const files = data.files || [];
  const playable = files.filter(f => /\.(mp4|webm|ogv)$/i.test(f.name || '') && Number(f.size || 0) > 0)
    .sort((a, b) => Number(a.size) - Number(b.size));
  const preferred = playable.find(f => /512kb|h\.264|mpeg4/i.test(`${f.format} ${f.name}`)) || playable[0];
  if (!preferred) throw new Error('这个条目没有浏览器可播放的视频文件');
  const caption = files.find(f => /\.(vtt|srt)$/i.test(f.name || ''));
  const base = `https://archive.org/download/${encodeURIComponent(id)}/`;
  const result = {
    title: data.metadata?.title || id,
    videoUrl: base + preferred.name.split('/').map(encodeURIComponent).join('/'),
    captionUrl: caption ? base + caption.name.split('/').map(encodeURIComponent).join('/') : null
  };
  if (!result.captionUrl) result.jobId = startTranscription(`archive-${id}`, result.videoUrl);
  return result;
}

async function proxyCaption(source) {
  const url = await safeUrl(source);
  if (!/\.(vtt|srt)(\?.*)?$/i.test(url.pathname + url.search)) throw new Error('仅允许读取 VTT/SRT 字幕');
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`字幕服务返回 ${response.status}`);
  const text = await response.text();
  if (text.length > 5_000_000) throw new Error('字幕文件过大');
  return text;
}

async function api(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/auth/')) return await authApi(req, res, url);
    if (!isAuthenticated(req)) return json(res, 401, { error: '请先登录' });
    if (url.pathname === '/api/youtube/cookies' && req.method === 'GET') {
      return json(res, 200, { configured: fs.existsSync(YOUTUBE_COOKIES_PATH) });
    }
    if (url.pathname === '/api/youtube/cookies' && req.method === 'POST') {
      const body = await readBody(req);
      const content = validateYoutubeCookies(body.content);
      fs.mkdirSync(MEDIA_CACHE, { recursive: true });
      fs.writeFileSync(YOUTUBE_COOKIES_PATH, content, { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(YOUTUBE_COOKIES_PATH, 0o600); } catch { /* Windows has no POSIX modes. */ }
      return json(res, 200, { configured: true });
    }
    if (url.pathname === '/api/youtube/cookies' && req.method === 'DELETE') {
      try { fs.unlinkSync(YOUTUBE_COOKIES_PATH); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return json(res, 200, { configured: false });
    }
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) return json(res, 400, { error: '请输入至少两个字符' });
      return json(res, 200, { provider: 'youtube', items: await searchYouTube(q) });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/archive/')) {
      return json(res, 200, await archiveMedia(decodeURIComponent(url.pathname.slice(13))));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/bilibili/')) {
      return json(res, 200, await bilibiliMedia(decodeURIComponent(url.pathname.slice(14))));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/youtube/')) {
      return json(res, 200, await youtubeMedia(decodeURIComponent(url.pathname.slice(13))));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
      const job = jobs.get(decodeURIComponent(url.pathname.slice(10)));
      return job ? json(res, 200, job) : json(res, 404, { error: '识别任务不存在或服务已重启' });
    }
    if (req.method === 'GET' && url.pathname === '/api/media') {
      return await proxyBiliMedia(req, res, url.searchParams.get('url') || '');
    }
    if (req.method === 'GET' && url.pathname === '/api/caption') {
      const text = await proxyCaption(url.searchParams.get('url') || '');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(text);
    }
    if (req.method === 'POST' && url.pathname === '/api/extract') {
      const body = await readBody(req);
      return json(res, 200, await extractPage(body.url || ''));
    }
    return json(res, 404, { error: '接口不存在' });
  } catch (error) {
    return json(res, 422, { error: error.message || '请求失败' });
  }
}

function serveStatic(req, res, url) {
  const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(ROOT, decodeURIComponent(requestPath)));
  if (!filePath.startsWith(ROOT)) return json(res, 403, { error: '禁止访问' });
  fs.readFile(filePath, (error, data) => {
    if (error) return json(res, 404, { error: '文件不存在' });
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  if (url.pathname === '/login.html') return serveStatic(req, res, url);
  if (!isAuthenticated(req)) {
    res.writeHead(302, { location: '/login.html' });
    return res.end();
  }
  return serveStatic(req, res, url);
}).listen(PORT, HOST, () => {
  console.log(`Echo Study 已启动：http://${HOST}:${PORT}`);
});

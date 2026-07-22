const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const video = $('#video');
const list = $('#transcriptList');
const dialog = $('#sourceDialog');
const narrowScreen = window.matchMedia('(max-width: 900px)');
const state = {
  cues: [
    { start: 0, end: 4, en: 'Choose a video and make every sentence count.', zh: '选择一个视频，认真听懂每一句。' },
    { start: 4, end: 8, en: 'Listen, repeat, and move at your own pace.', zh: '按照自己的节奏听、重复，再继续前进。' },
    { start: 8, end: 12, en: 'Small steps turn into real progress.', zh: '每一个小步骤，都会变成真正的进步。' }
  ],
  current: 0,
  favorites: new Set(JSON.parse(localStorage.getItem('echo:favorites') || '[]')),
  filter: 'all',
  showCaptions: true,
  showTranslation: true,
  fontScale: 0,
  sentenceLoop: false,
  objectUrl: null,
  title: '第 1 期',
  secondsStudied: Number(localStorage.getItem('echo:seconds') || 0)
};

function updateStickyPlayerHeight() {
  const height = narrowScreen.matches ? Math.ceil($('.player-pane').getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--sticky-player-height', `${height}px`);
}

new ResizeObserver(updateStickyPlayerHeight).observe($('.player-pane'));
narrowScreen.addEventListener('change', updateStickyPlayerHeight);

function esc(value = '') {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function fmt(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const PHRASE_PATTERNS = [
  'look forward to', 'looking forward to', 'take good care of', 'take care of', 'took care of',
  'get back to', 'got back to', 'go out with', 'run out of', 'I was just like',
  'be about to', 'in store for', 'as far as', 'find out', 'figure out', 'give up',
  'end up', 'work out', 'hang out', 'grow up', 'calm down', 'show up', 'come on',
  'get along', 'make sure', 'turn back', 'move out', 'leave out', 'check out'
];
const CET6_PHRASE_PATTERNS = [
  'account for', 'adapt to', 'adhere to', 'attribute to', 'be bound to', 'be inclined to',
  'be subject to', 'bring about', 'come up with', 'contribute to', 'cope with', 'derive from',
  'distinguish from', 'give rise to', 'resort to', 'result in', 'stem from', 'take into account',
  'with regard to', 'in terms of', 'on behalf of', 'in response to', 'be consistent with'
];
const COLLOCATION_PATTERNS = [
  'as a matter of fact', 'at the moment', 'a couple of', 'a little bit', 'would like to',
  'be able to', 'used to', 'have to', 'going to', 'want to', 'need to', 'a lot of',
  'kind of', 'sort of', 'all right', 'of course', 'right now', 'each other', 'how long',
  'more than', 'less than', 'instead of', 'because of', 'no longer', 'even though',
  'so much', 'one of', 'a bit of', 'for a while', 'impulse decision', 'frosted tips'
];
const CET6_COLLOCATION_PATTERNS = [
  'a wide range of', 'to a large extent', 'in contrast to', 'in accordance with',
  'in the long run', 'on the grounds that', 'play a crucial role', 'pose a threat to',
  'reach a consensus', 'bear in mind', 'attach importance to', 'be exposed to',
  'from the perspective of', 'have access to', 'take precedence over'
];

const CET4_CORE_WORDS = new Set(`
  ability accept achieve advantage affect appreciate approach argue assure avoid benefit challenge
  communicate compare concern consider conversation correct contribute culture decision develop difference
  education effect encourage environment experience explain fantastic improve include increase influence
  information knowledge local opportunity organize particular perform prevent provide realize reason reduce
  require research respond result schedule situation society solution suggest support surprise technology
  tradition understand value various volunteer coast roommate sightseeing
`.trim().split(/\s+/));
const CET6_CORE_WORDS = new Set(`
  abstract accumulate acknowledge adapt advocate anticipate appropriate arbitrary assess assumption authentic
  capacity clarify coherent coincide compelling comprehensive compromise conceive concentrate contradict
  controversy conventional crucial decline demonstrate derive diminish discriminate dispose diverse eliminate
  emerge empirical enhance equivalent ethical evaluate evident exceed explicit extraordinary facilitate
  fundamental hypothesis inevitable inhibit innovation interpret justify maintain manipulate mechanism modify
  notion objective perceive persist phenomenon potential preliminary priority profound promote reinforce relevant
  reluctant significant simulate sophisticated specify stable substitute sustain transform undergo valid vulnerable
`.trim().split(/\s+/));
const IRREGULAR_BASES = {
  went: 'go', gone: 'go', got: 'get', gotten: 'get', made: 'make', took: 'take', taken: 'take',
  thought: 'think', found: 'find', became: 'become', gave: 'give', given: 'give', wrote: 'write',
  written: 'write', spoke: 'speak', spoken: 'speak', knew: 'know', known: 'know', grew: 'grow',
  grown: 'grow', chose: 'choose', chosen: 'choose', left: 'leave', felt: 'feel'
};

function phraseRegex(value) {
  return new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}\\b`, 'gi');
}

const PHRASE_REGEXES = [...PHRASE_PATTERNS].sort((a, b) => b.length - a.length).map(phraseRegex);
const CET6_PHRASE_REGEXES = [...CET6_PHRASE_PATTERNS].sort((a, b) => b.length - a.length).map(phraseRegex);
const COLLOCATION_REGEXES = [...COLLOCATION_PATTERNS].sort((a, b) => b.length - a.length).map(phraseRegex);
const CET6_COLLOCATION_REGEXES = [...CET6_COLLOCATION_PATTERNS].sort((a, b) => b.length - a.length).map(phraseRegex);

function vocabularyLevel(value) {
  const word = value.toLowerCase().replace(/^'+|'+$/g, '');
  const candidates = new Set([word, IRREGULAR_BASES[word]]);
  if (word.endsWith('ies')) candidates.add(`${word.slice(0, -3)}y`);
  if (word.endsWith('ing')) {
    const stem = word.slice(0, -3);
    candidates.add(stem); candidates.add(`${stem}e`);
    if (/(.)\1$/.test(stem)) candidates.add(stem.slice(0, -1));
  }
  if (word.endsWith('ed')) {
    const stem = word.slice(0, -2);
    candidates.add(stem); candidates.add(`${stem}e`);
    if (/(.)\1$/.test(stem)) candidates.add(stem.slice(0, -1));
  }
  if (word.endsWith('es')) candidates.add(word.slice(0, -2));
  if (word.endsWith('s')) candidates.add(word.slice(0, -1));
  for (const candidate of candidates) {
    if (candidate && CET6_CORE_WORDS.has(candidate)) return 'cet6';
  }
  for (const candidate of candidates) {
    if (candidate && CET4_CORE_WORDS.has(candidate)) return 'cet4';
  }
  return '';
}

function highlight(text) {
  const source = String(text || '');
  const ranges = [];
  const overlaps = (start, end) => ranges.some(range => start < range.end && end > range.start);
  const collect = (patterns, className, label, levelClass) => {
    patterns.forEach(pattern => {
      for (const match of source.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        if (!overlaps(start, end)) ranges.push({ start, end, className, label, levelClass });
      }
    });
  };
  collect(CET6_PHRASE_REGEXES, 'hl-phrase', '六级短语 / 短语动词', 'cet6');
  collect(PHRASE_REGEXES, 'hl-phrase', '四级短语 / 短语动词', 'cet4');
  collect(CET6_COLLOCATION_REGEXES, 'hl-collocation', '六级常考词组', 'cet6');
  collect(COLLOCATION_REGEXES, 'hl-collocation', '四级常考词组', 'cet4');

  let keywordCount = 0;
  for (const match of source.matchAll(/\b[A-Za-z][A-Za-z'-]{2,}\b/g)) {
    const start = match.index;
    const end = start + match[0].length;
    const levelClass = vocabularyLevel(match[0]);
    if (keywordCount < 3 && levelClass && !overlaps(start, end)) {
      ranges.push({ start, end, className: 'hl-keyword', levelClass, label: `${levelClass === 'cet6' ? '六级' : '四级'}重点单词` });
      keywordCount += 1;
    }
  }

  ranges.sort((a, b) => a.start - b.start);
  let cursor = 0;
  let output = '';
  for (const range of ranges) {
    output += esc(source.slice(cursor, range.start));
    output += `<mark class="${range.className} ${range.levelClass}" title="${range.label}">${esc(source.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  }
  return output + esc(source.slice(cursor));
}

function currentCueIndex(time = video.currentTime) {
  const current = state.cues[state.current];
  if (current && time >= current.start && time < current.end) return state.current;
  const exact = state.cues.findIndex(c => time >= c.start && time < c.end);
  if (exact >= 0) return exact;
  for (let i = state.cues.length - 1; i >= 0; i--) if (time >= state.cues[i].start) return i;
  return 0;
}

function renderFocus() {
  const cue = state.cues[state.current] || state.cues[0];
  if (!cue) return;
  $('#focusNumber').textContent = String(state.current + 1).padStart(2, '0');
  $('#focusTime').textContent = `${fmt(cue.start)} — ${fmt(cue.end)}`;
  $('#focusEnglish').innerHTML = highlight(cue.en);
  $('#focusChinese').textContent = cue.zh || '暂无翻译';
  $('#focusChinese').hidden = !state.showTranslation;
  $('#videoCaption').innerHTML = state.showTranslation && cue.zh
    ? `<span class="caption-en">${highlight(cue.en)}</span><span class="caption-zh">${esc(cue.zh)}</span>`
    : `<span class="caption-en">${highlight(cue.en)}</span>`;
  $('#videoCaption').hidden = !video.src || !state.showCaptions;
  const scales = ['1rem', '1.12rem', '.9rem'];
  list.style.fontSize = scales[state.fontScale];
}

function showMediaNotice(title, message) {
  $('#mediaNoticeTitle').textContent = title;
  $('#mediaNoticeText').textContent = message;
  $('#mediaNotice').hidden = false;
}

function hideMediaNotice() {
  $('#mediaNotice').hidden = true;
}

async function detectFileCodec(file) {
  const chunkSize = 6 * 1024 * 1024;
  const parts = [file.slice(0, Math.min(file.size, chunkSize))];
  if (file.size > chunkSize) parts.push(file.slice(Math.max(0, file.size - chunkSize)));
  const buffers = await Promise.all(parts.map(part => part.arrayBuffer()));
  const signatures = new Set();
  for (const buffer of buffers) {
    const bytes = new Uint8Array(buffer);
    let ascii = '';
    for (let i = 0; i < bytes.length; i += 65536) {
      ascii += String.fromCharCode(...bytes.subarray(i, Math.min(i + 65536, bytes.length)));
    }
    ['hvc1', 'hev1', 'avc1', 'av01', 'vp09'].forEach(codec => { if (ascii.includes(codec)) signatures.add(codec); });
  }
  return [...signatures];
}

function renderList(keepScroll = true) {
  const scroll = list.scrollTop;
  list.classList.toggle('hide-translation', !state.showTranslation);
  const items = state.cues.map((cue, index) => ({ cue, index }))
    .filter(x => state.filter === 'all' || state.favorites.has(x.index));
  if (!items.length) {
    list.innerHTML = '<div class="no-results">还没有收藏的句子</div>';
    return;
  }
  list.innerHTML = items.map(({ cue, index }) => `
    <article class="line-item ${index === state.current ? 'current' : ''}" data-index="${index}">
      <span class="line-index">${String(index + 1).padStart(2, '0')}</span>
      <p class="line-en">${highlight(cue.en)}</p>
      <span class="line-zh">${esc(cue.zh || '暂无翻译')}</span>
      <div class="line-tools">
        <button class="mini-button play-line" aria-label="播放本句">▶</button>
        <button class="mini-button speak-line" aria-label="朗读本句">◉</button>
        <button class="mini-button favorite-line ${state.favorites.has(index) ? 'favorited' : ''}" aria-label="收藏本句">♥</button>
        <span class="timecode">${fmt(cue.start)} — ${fmt(cue.end)}</span>
      </div>
    </article>`).join('');
  if (keepScroll) list.scrollTop = scroll;
}

function setCurrent(index, seek = false) {
  const previous = state.current;
  state.current = Math.max(0, Math.min(index, state.cues.length - 1));
  if (seek && video.src) video.currentTime = state.cues[state.current].start;
  renderFocus();
  if (previous !== state.current) {
    list.querySelector(`[data-index="${previous}"]`)?.classList.remove('current');
    list.querySelector(`[data-index="${state.current}"]`)?.classList.add('current');
  }
  const row = list.querySelector(`[data-index="${state.current}"]`);
  if (row && !row.matches(':hover')) {
    const rowBox = row.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    const outsideView = rowBox.top < listBox.top || rowBox.bottom > listBox.bottom;
    if (seek || outsideView) row.scrollIntoView({ block: 'nearest', behavior: seek ? 'smooth' : 'auto' });
  }
}

function loadVideo(src, title) {
  if (state.objectUrl && state.objectUrl !== src) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }
  $('#embedPlayer').src = 'about:blank';
  $('#embedPlayer').hidden = true;
  video.hidden = false;
  hideMediaNotice();
  video.src = src;
  video.load();
  $('#videoProgressControl').hidden = false;
  $('#videoSeek').value = 0;
  $('#videoSeek').style.setProperty('--seek-progress', '0%');
  $('#videoCurrentTime').textContent = '00:00';
  $('#videoDuration').textContent = '00:00';
  $('#emptyState').hidden = true;
  $('#lessonTitle').textContent = title || '我的视频';
  state.title = title || '我的视频';
  localStorage.setItem('echo:lastTitle', state.title);
  dialog.close();
  setStatus('');
  setCurrent(0);
}

async function loadBilibili(bvid) {
  setStatus('正在获取原生视频流与公开字幕…');
  const data = await request(`/api/bilibili/${encodeURIComponent(bvid)}`);
  loadVideo(data.videoUrl, data.title);
  if (data.cues?.length) {
    state.cues = data.cues;
    renderList(false);
    setCurrent(0);
    if (data.translationJobId) {
      pollTranslation(data.translationJobId).catch(error => showMediaNotice('中文翻译生成失败', error.message));
    }
  } else if (data.jobId) {
    state.cues = [];
    renderList(false);
    $('#focusNumber').textContent = '--';
    $('#focusTime').textContent = '正在识别';
    $('#focusEnglish').textContent = '正在从视频音频生成英文字幕…';
    $('#focusChinese').textContent = '识别完成后将自动生成中文翻译。';
    $('#videoCaption').hidden = true;
    pollTranscription(data.jobId).catch(error => showMediaNotice('自动字幕生成失败', error.message));
  } else {
    state.cues = [];
    renderList(false);
    $('#focusNumber').textContent = '--';
    $('#focusTime').textContent = '无可用字幕';
    $('#focusEnglish').textContent = '这段视频没有可提取的独立字幕。';
    $('#focusChinese').textContent = '点击“字幕”导入 SRT/VTT 文件后即可启动逐句精听。';
    $('#videoCaption').hidden = true;
    showMediaNotice('视频已加载，未找到独立字幕', data.subtitleStatus || '可点击下方“字幕”按钮导入 SRT/VTT 文件。');
  }
}

function applyGeneratedCues(cues) {
  state.cues = cues;
  hideMediaNotice();
  renderList(false);
  setCurrent(0);
}

async function pollTranscription(jobId) {
  showMediaNotice('正在生成字幕', '本地 Whisper 正在下载音频并识别。首次使用还需要下载语音模型，请保持页面打开。');
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const job = await request(`/api/jobs/${encodeURIComponent(jobId)}`);
    $('#mediaNoticeText').textContent = job.progress || '正在识别…';
    if (job.status === 'complete') {
      if (!job.cues?.length) throw new Error('识别完成，但没有检测到有效语音。');
      applyGeneratedCues(job.cues);
      return;
    }
    if (job.status === 'error') throw new Error(job.progress || '自动识别失败');
  }
}

async function pollTranslation(jobId) {
  showMediaNotice('正在生成中文翻译', '英文字幕已经可以使用；本地翻译模型正在后台生成中文，完成后会自动显示。');
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const job = await request(`/api/jobs/${encodeURIComponent(jobId)}`);
    $('#mediaNoticeText').textContent = job.progress || '正在翻译…';
    if (job.status === 'complete') {
      if (!job.cues?.length) throw new Error('翻译完成，但没有返回有效字幕。');
      state.cues = job.cues;
      renderFocus();
      renderList(false);
      showMediaNotice('中文翻译已生成', '点击下方“翻译开 / 翻译关”可随时显示或隐藏中文。');
      setTimeout(hideMediaNotice, 4000);
      return;
    }
    if (job.status === 'error') throw new Error(job.progress || '中文翻译失败');
  }
}

async function loadYouTube(videoId) {
  setStatus('正在解析 YouTube 视频与字幕…');
  const data = await request(`/api/youtube/${encodeURIComponent(videoId)}`);
  loadVideo(data.videoUrl, data.title);
  if (data.cues?.length) {
    applyGeneratedCues(data.cues);
    if (data.translationJobId) {
      pollTranslation(data.translationJobId).catch(error => showMediaNotice('中文翻译生成失败', error.message));
    } else {
      showMediaNotice('双语字幕已自动加载', data.subtitleSource === 'youtube-asr' ? '使用 YouTube 自动字幕；中英文字幕已与视频同步。' : '使用视频作者提供的字幕；中英文字幕已与视频同步。');
      setTimeout(hideMediaNotice, 4500);
    }
  } else if (data.jobId) {
    pollTranscription(data.jobId).catch(error => showMediaNotice('自动字幕生成失败', error.message));
  }
}

function loadEmbed(src, title) {
  if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.hidden = true;
  $('#embedPlayer').src = src;
  $('#embedPlayer').hidden = false;
  $('#emptyState').hidden = true;
  $('#videoCaption').hidden = true;
  $('#videoProgressControl').hidden = true;
  hideMediaNotice();
  $('#lessonTitle').textContent = title || '公开视频';
  state.title = title || '公开视频';
  dialog.close();
  setStatus('');
}

function parseTimestamp(value) {
  const p = value.trim().replace(',', '.').split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

function parseCaptions(text) {
  const normalized = text.replace(/^WEBVTT[^\n]*\n+/, '').replace(/\r/g, '').trim();
  const blocks = normalized.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    const timingIndex = lines.findIndex(line => line.includes('-->'));
    if (timingIndex < 0) continue;
    const times = lines[timingIndex].split('-->').map(v => v.trim().split(/\s/)[0]);
    const body = lines.slice(timingIndex + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!body) continue;
    const [first, ...rest] = body.split(/\s*[｜|]\s*|\s+\/\s+/);
    cues.push({ start: parseTimestamp(times[0]), end: parseTimestamp(times[1]), en: first, zh: rest.join(' ') });
  }
  return cues;
}

function setStatus(message, error = false) {
  $('#dialogStatus').textContent = message;
  $('#dialogStatus').classList.toggle('error', error);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (response.status === 401) {
    location.href = '/login.html';
    throw new Error('登录已失效');
  }
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function loadRemoteCaptions(url) {
  if (!url) return;
  try {
    const response = await fetch(`/api/caption?url=${encodeURIComponent(url)}`);
    if (!response.ok) throw new Error('字幕读取失败');
    const parsed = parseCaptions(await response.text());
    if (parsed.length) { state.cues = parsed; renderList(false); setCurrent(0); }
  } catch { setStatus('视频已加载，但远程字幕无法读取，请手动导入字幕。'); }
}

function openDialog(tab = 'local') {
  dialog.showModal();
  $$('.source-tab').find(x => x.dataset.source === tab)?.click();
}

$('#openSource').addEventListener('click', () => openDialog());
$('#logoutButton').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
});
$('#emptyAdd').addEventListener('click', () => openDialog());
$$('.source-tab').forEach(button => button.addEventListener('click', () => {
  $$('.source-tab').forEach(x => x.classList.toggle('active', x === button));
  $$('.source-panel').forEach(x => x.classList.toggle('active', x.dataset.panel === button.dataset.source));
  setStatus('');
}));

$('#videoInput').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  state.objectUrl = URL.createObjectURL(file);
  loadVideo(state.objectUrl, file.name.replace(/\.[^.]+$/, ''));
  const codecs = await detectFileCodec(file).catch(() => []);
  if (codecs.includes('hvc1') || codecs.includes('hev1')) {
    showMediaNotice('检测到 H.265 / HEVC 视频', '当前 Chrome 可能只有声音或显示白屏。请先转换为 H.264（AVC）MP4，再重新上传。');
  } else if (codecs.includes('av01')) {
    showMediaNotice('检测到 AV1 视频', '如果画面为空，请转换为 H.264（AVC）MP4 后重新上传。');
  }
});

const dropZone = $('#dropZone');
['dragenter', 'dragover'].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', async event => {
  const file = [...event.dataTransfer.files].find(x => x.type.startsWith('video/'));
  if (!file) return setStatus('请拖入视频文件。', true);
  state.objectUrl = URL.createObjectURL(file);
  loadVideo(state.objectUrl, file.name.replace(/\.[^.]+$/, ''));
  const codecs = await detectFileCodec(file).catch(() => []);
  if (codecs.includes('hvc1') || codecs.includes('hev1')) {
    showMediaNotice('检测到 H.265 / HEVC 视频', '当前 Chrome 可能只有声音或显示白屏。请先转换为 H.264（AVC）MP4，再重新上传。');
  } else if (codecs.includes('av01')) {
    showMediaNotice('检测到 AV1 视频', '如果画面为空，请转换为 H.264（AVC）MP4 后重新上传。');
  }
});

video.addEventListener('error', () => {
  const code = video.error?.code;
  const messages = { 1: '视频加载被中止。', 2: '读取视频文件失败。', 3: '浏览器无法解码该视频。', 4: '浏览器不支持这种视频格式。' };
  showMediaNotice('视频加载失败', `${messages[code] || '无法播放当前视频。'} 建议使用 H.264 视频编码和 AAC 音频编码的 MP4 文件。`);
});

$('#extractButton').addEventListener('click', async () => {
  const button = $('#extractButton');
  button.disabled = true; setStatus('正在读取页面中的公开媒体信息…');
  try {
    const enteredUrl = $('#urlInput').value.trim();
    if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(enteredUrl)) {
      loadVideo(enteredUrl, decodeURIComponent(enteredUrl.split('/').pop().split('?')[0] || '视频直链'));
      return;
    }
    const data = await request('/api/extract', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: enteredUrl }) });
    if (data.bilibiliId) await loadBilibili(data.bilibiliId);
    else if (data.youtubeId) await loadYouTube(data.youtubeId);
    else if (data.embedUrl) loadEmbed(data.embedUrl, data.title);
    else loadVideo(data.videoUrl, data.title);
    if (data.captions?.[0]) loadRemoteCaptions(data.captions[0]);
  } catch (error) { setStatus(error.message, true); }
  finally { button.disabled = false; }
});

async function search() {
  const q = $('#searchInput').value.trim();
  const button = $('#searchButton');
  button.disabled = true; setStatus('正在检索公共影像…'); $('#searchResults').innerHTML = '';
  try {
    const data = await request(`/api/search?q=${encodeURIComponent(q)}`);
    $('#searchResults').innerHTML = data.items.map(item => `
      <button class="result-item" data-id="${esc(item.id)}" data-provider="${esc(item.provider || 'archive')}">
        <img src="${esc(item.thumb)}" alt="" loading="lazy">
        <span><strong>${esc(item.title)}</strong><span>${esc(item.creator)}${item.year ? ` · ${esc(item.year)}` : ''}</span></span>
      </button>`).join('') || '<p class="no-results">没有找到相关公开视频</p>';
    setStatus(`找到 ${data.items.length} 条可用素材`);
  } catch (error) { setStatus(error.message, true); }
  finally { button.disabled = false; }
}
$('#searchButton').addEventListener('click', search);
$('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
$('#searchResults').addEventListener('click', async event => {
  const item = event.target.closest('[data-id]');
  if (!item) return;
  setStatus('正在选择适合浏览器播放的视频文件…');
  try {
    if (item.dataset.provider === 'youtube') {
      await loadYouTube(item.dataset.id);
      return;
    }
    if (item.dataset.provider === 'bilibili') {
      await loadBilibili(item.dataset.id);
      return;
    }
    const data = await request(`/api/archive/${encodeURIComponent(item.dataset.id)}`);
    loadVideo(data.videoUrl, data.title);
    if (data.captionUrl) loadRemoteCaptions(data.captionUrl);
    else if (data.jobId) pollTranscription(data.jobId).catch(error => showMediaNotice('自动字幕生成失败', error.message));
  } catch (error) { setStatus(error.message, true); }
});

$('#captionImport').addEventListener('click', () => $('#captionInput').click());
$('#captionInput').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  const parsed = parseCaptions(await file.text());
  if (!parsed.length) return alert('没有识别到有效的 SRT/VTT 字幕。');
  state.cues = parsed; renderList(false); setCurrent(0);
});

let pausedOnPointerDown = false;
$('#playButton').addEventListener('pointerdown', () => {
  pausedOnPointerDown = !video.paused;
  if (pausedOnPointerDown) video.pause();
});
$('#playButton').addEventListener('click', () => {
  if (!video.src) return openDialog();
  if (pausedOnPointerDown) {
    pausedOnPointerDown = false;
    return;
  }
  if (video.paused) video.play().catch(error => showMediaNotice('无法继续播放', error.message));
  else video.pause();
});
video.addEventListener('play', () => { $('#playButton span').textContent = 'Ⅱ'; $('#playButton small').textContent = '暂停'; });
video.addEventListener('pause', () => { $('#playButton span').textContent = '▶'; $('#playButton small').textContent = '播放'; });
function updateVideoProgress() {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const ratio = duration ? Math.min(1, Math.max(0, video.currentTime / duration)) : 0;
  const seek = $('#videoSeek');
  seek.value = Math.round(ratio * 1000);
  seek.style.setProperty('--seek-progress', `${ratio * 100}%`);
  $('#videoCurrentTime').textContent = fmt(video.currentTime);
  $('#videoDuration').textContent = fmt(duration);
}
video.addEventListener('loadedmetadata', updateVideoProgress);
video.addEventListener('durationchange', updateVideoProgress);
$('#videoSeek').addEventListener('input', event => {
  if (!Number.isFinite(video.duration) || !video.duration) return;
  video.currentTime = Number(event.currentTarget.value) / 1000 * video.duration;
  updateVideoProgress();
});
video.addEventListener('timeupdate', () => {
  const index = currentCueIndex();
  if (index !== state.current) setCurrent(index);
  if (state.sentenceLoop) {
    const cue = state.cues[state.current];
    if (cue && video.currentTime >= cue.end) video.currentTime = cue.start;
  }
  const duration = video.duration || 0;
  $('#progressBar').style.width = duration ? `${video.currentTime / duration * 100}%` : '0%';
  updateVideoProgress();
});
$('#previousButton').addEventListener('click', () => setCurrent(state.current - 1, true));
$('#nextButton').addEventListener('click', () => setCurrent(state.current + 1, true));
$('#repeatButton').addEventListener('click', () => { if (video.src) { video.currentTime = state.cues[state.current].start; video.play(); } });
$('#loopButton').addEventListener('click', event => {
  state.sentenceLoop = !state.sentenceLoop;
  event.currentTarget.classList.toggle('active', state.sentenceLoop);
  event.currentTarget.setAttribute('aria-pressed', state.sentenceLoop);
});
$('#speedButton').addEventListener('click', () => {
  const speeds = [.75, 1, 1.25, 1.5, 2];
  video.playbackRate = speeds[(speeds.indexOf(video.playbackRate) + 1) % speeds.length];
  $('#speedLabel').textContent = `${video.playbackRate}×`;
});
$('#captionToggleButton').addEventListener('click', event => {
  state.showCaptions = !state.showCaptions;
  event.currentTarget.classList.toggle('active', state.showCaptions);
  event.currentTarget.setAttribute('aria-pressed', state.showCaptions);
  event.currentTarget.querySelector('small').textContent = state.showCaptions ? '字幕开' : '字幕关';
  $('#videoCaption').hidden = !state.showCaptions || !video.src || !state.cues.length;
});
$('#translationButton').addEventListener('click', event => {
  state.showTranslation = !state.showTranslation;
  event.currentTarget.classList.toggle('active', state.showTranslation);
  event.currentTarget.setAttribute('aria-pressed', state.showTranslation);
  event.currentTarget.querySelector('small').textContent = state.showTranslation ? '翻译开' : '翻译关';
  list.classList.toggle('hide-translation', !state.showTranslation);
  renderFocus();
});
$('#fontButton').addEventListener('click', () => { state.fontScale = (state.fontScale + 1) % 3; renderFocus(); });

list.addEventListener('click', event => {
  const row = event.target.closest('[data-index]');
  if (!row) return;
  const index = Number(row.dataset.index);
  if (event.target.closest('.favorite-line')) {
    state.favorites.has(index) ? state.favorites.delete(index) : state.favorites.add(index);
    localStorage.setItem('echo:favorites', JSON.stringify([...state.favorites]));
    return renderList();
  }
  if (event.target.closest('.speak-line')) {
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(state.cues[index].en));
    return;
  }
  setCurrent(index, true);
  if (event.target.closest('.play-line')) video.play();
});

$$('.tab').forEach(button => button.addEventListener('click', () => {
  state.filter = button.dataset.filter;
  $$('.tab').forEach(x => { x.classList.toggle('active', x === button); x.setAttribute('aria-selected', x === button); });
  renderList(false);
}));

document.addEventListener('keydown', event => {
  if (dialog.open || /INPUT|TEXTAREA/.test(event.target.tagName)) return;
  if (event.code === 'Space') { event.preventDefault(); $('#playButton').click(); }
  if (event.key === 'ArrowLeft') $('#previousButton').click();
  if (event.key === 'ArrowRight') $('#nextButton').click();
});

setInterval(() => {
  if (!video.paused && !video.ended) {
    state.secondsStudied += 1;
    $('#studyMinutes').textContent = Math.floor(state.secondsStudied / 60);
    if (state.secondsStudied % 10 === 0) localStorage.setItem('echo:seconds', state.secondsStudied);
  }
}, 1000);

$('#lastStudied').textContent = localStorage.getItem('echo:lastDate') || '首次学习';
window.addEventListener('beforeunload', () => localStorage.setItem('echo:lastDate', new Date().toLocaleDateString('zh-CN')));
$('#studyMinutes').textContent = Math.floor(state.secondsStudied / 60);
renderFocus(); renderList(false);

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile, spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const axios = require('axios');
const hongguo = require('../src/native/hongguo');
const { remuxHls } = require('../src/native/hls-media');
const { webMediaRequestOptions } = require('../src/native/web-media-guard');
const { normalizeDownloadQuality, meetsDownloadQuality } = require('../src/native/download-quality');
const { readMergeInfo } = require('../src/native/merge-plan');
const { publishMergedOutput } = require('../src/native/merge-runner');

const execFileAsync = promisify(execFile);
const RETRY_DELAYS = [1000, 2000, 4000];
const TERMINAL_CODES = new Set([
  'EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'EROFS', 'EIO', 'ENOENT', 'EEXIST', 'ENOTDIR',
  'EISDIR', 'EMFILE', 'ENFILE', 'EBUSY', 'ENAMETOOLONG', 'EMLINK', 'EFBIG',
  'LOCAL_MEDIA_TOOL_ERROR', 'SECURITY_BLOCKED', 'LOCKED', 'PREVIEW_ONLY',
]);
const warned = new Set();

function abortError() {
  return Object.assign(new Error('已取消'), { code: 'ABORT_ERR' });
}

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function formatBytes(value) {
  if (!value || value < 0) return '未知大小';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sanitizeFolderName(name) {
  let cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/^ +/, '');
  const chars = Array.from(cleaned);
  if (chars.length > 80) cleaned = chars.slice(0, 80).join('');
  cleaned = cleaned.replace(/[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(cleaned)) {
    cleaned = `_${cleaned}`.replace(/[. ]+$/g, '');
  }
  return cleaned;
}

function renderName(format, seriesTitle, vidIndex, epTitle) {
  const fmt = String(format || '').trim();
  if (!fmt) return null;
  const vars = {
    series_title: String(seriesTitle || '').trim(),
    vid_index: String(vidIndex).padStart(3, '0'),
    ep_title: String(epTitle || '').trim(),
  };
  const zhMap = { 剧名: 'series_title', 集数: 'vid_index', 标题: 'ep_title' };
  const zhRe = /剧名|集数|标题/g;
  let name = fmt
    .replace(zhRe, word => zhMap[word] || word)
    .replace(/([A-Za-z]+(?:_[A-Za-z]+)*)/g, token => (vars[token] !== undefined ? (vars[token] || '') : token));
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  return name || null;
}

function uniqueEpisodeFilename(seriesTitle, episode) {
  const format = '剧名 集数';
  const index = String(episode.index).padStart(3, '0');
  const rendered = renderName(format, seriesTitle, episode.index, episode.title) || seriesTitle;
  return `${rendered}${/集数|vid_index/.test(format) ? '' : `_第${index}集`}.mp4`;
}

function seriesDownloadDir(root, seriesId, seriesTitle) {
  const title = sanitizeFolderName(seriesTitle) || '未命名短剧';
  const suffix = crypto.createHash('sha256').update(String(seriesId)).digest('hex').slice(0, 12);
  const group = String(seriesId).startsWith('hema:') ? '河马短剧'
    : String(seriesId).startsWith('xifan:') ? '西饭短剧' : '红果短剧';
  return path.join(root, group, `${title}-${suffix}`);
}

function resolveTool(name, root) {
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [
    path.join(root, 'build', 'ffmpeg', `${process.platform}-${process.arch}`, executable),
    path.join(root, 'build', 'ffmpeg', executable),
  ];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const bare = process.platform === 'win32' ? dir.replace(/^"(.*)"$/, '$1') : dir;
    if (bare) candidates.push(path.join(bare, executable));
  }
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {}
  }
  return null;
}

function parseEpisodeSelection(value) {
  const selected = new Set();
  for (const raw of String(value || '').split(/[,，]/)) {
    const part = raw.trim();
    if (!part) continue;
    if (/^\d+$/.test(part)) {
      const index = Number(part);
      if (index > 0) selected.add(index);
      continue;
    }
    const match = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (!match) throw new Error(`无法识别的集数范围：${part}`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start < 1 || end < start || end - start > 10000) throw new Error(`集数范围无效：${part}`);
    for (let index = start; index <= end; index++) selected.add(index);
  }
  if (!selected.size) throw new Error('未指定有效集数');
  return selected;
}

function printUsage() {
  console.log(`红果短剧下载脚本

用法:
  node scripts/download.cjs <分享链接|剧集ID> [选项]

选项:
  --all                 下载全部集数（默认）
  --episodes 1-3,5      只下载指定集数
  --quality auto        清晰度：auto、1080p 或 720p（默认 auto）
  --out <目录>          输出目录（默认 ./downloads）
  --concurrency 3       并发数，1-10（默认 3）
  --overwrite           覆盖已存在的同名文件
  --dry-run             只列出剧集与目标文件，不下载
  --help                显示帮助

说明:
  auto 优先使用官网公开 MP4 直链，通常无需 FFmpeg。
  指定 1080p/720p、HLS 或加密片源时需要内置 FFmpeg。
  macOS 首次使用前执行：npm run setup:ffmpeg:mac
  Windows 首次使用前执行：node scripts/setup-ffmpeg.js`);
}

function parseArgs(argv) {
  const options = {
    input: '',
    all: false,
    episodes: null,
    quality: 'auto',
    out: '',
    concurrency: 3,
    overwrite: false,
    dryRun: false,
    help: false,
  };
  const valueOf = (name, inline, index) => {
    if (inline !== undefined) return { value: inline, index };
    if (index + 1 >= argv.length) throw new Error(`${name} 缺少参数值`);
    return { value: argv[index + 1], index: index + 1 };
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--all') {
      options.all = true;
      continue;
    }
    if (arg === '--overwrite') {
      options.overwrite = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const split = arg.indexOf('=');
      const name = split === -1 ? arg : arg.slice(0, split);
      const inline = split === -1 ? undefined : arg.slice(split + 1);
      const read = () => {
        const result = valueOf(name, inline, index);
        index = result.index;
        return result.value;
      };
      if (name === '--episodes') {
        options.episodes = parseEpisodeSelection(read());
        continue;
      }
      if (name === '--quality') {
        options.quality = read();
        continue;
      }
      if (name === '--out') {
        options.out = read();
        continue;
      }
      if (name === '--concurrency') {
        const value = Number(read());
        if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error('并发数需为 1 至 10 的整数');
        options.concurrency = value;
        continue;
      }
      throw new Error(`未知选项：${name}`);
    }
    if (arg.startsWith('-')) throw new Error(`未知选项：${arg}`);
    if (options.input) throw new Error(`多余的参数：${arg}`);
    options.input = arg;
  }
  if (options.help) return options;
  if (!options.input) throw new Error('缺少分享链接或剧集 ID');
  if (options.all && options.episodes) throw new Error('--all 与 --episodes 不能同时使用');
  options.quality = normalizeDownloadQuality(options.quality);
  options.out = path.resolve(options.out || path.join(process.cwd(), 'downloads'));
  return options;
}

function isHls(info) {
  if (info?.format === 'hls') return true;
  try { return /\.m3u8$/i.test(new URL(info.url).pathname); }
  catch (_) { return false; }
}

function isTerminal(error) {
  if (error?.code === 'ABORT_ERR') return true;
  return TERMINAL_CODES.has(String(error?.code || ''));
}

function mediaHeaders(info) {
  const web = info.source === 'web' || info.source === 'custom';
  const headers = {
    'User-Agent': info.userAgent || (web ? hongguo.WEB_UA : hongguo.UA),
    'Accept-Encoding': 'identity',
  };
  if (info.referer || web) headers.Referer = info.referer || hongguo.WEB_REFERER;
  return headers;
}

function mediaTransferError(message, status) {
  return Object.assign(new Error(message), {
    code: 'MEDIA_TRANSFER_ERROR',
    mediaRetryable: true,
    ...(status ? { mediaStatus: status } : {}),
  });
}

function validateMediaResponse(response) {
  if (![200, 206].includes(response.status)) {
    response.data?.destroy?.();
    throw mediaTransferError(`片源请求失败（HTTP ${response.status}）`, response.status);
  }
  if (/(?:text\/html|application\/json)/i.test(String(response.headers['content-type'] || ''))) {
    response.data?.destroy?.();
    throw mediaTransferError('片源返回了错误页面');
  }
  if (response.status === 206) {
    const range = /^bytes 0-(\d+)\/(\d+)$/.exec(String(response.headers['content-range'] || ''));
    if (!range || Number(range[1]) + 1 !== Number(range[2])) {
      response.data?.destroy?.();
      throw mediaTransferError('视频响应不完整，请重新获取片源');
    }
    response.headers['content-length'] = range[2];
  }
}

async function requestMediaStream(info, signal) {
  const url = new URL(info.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('无效播放地址');
  const web = info.source === 'web' || info.source === 'custom';
  const baseHeaders = mediaHeaders(info);
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { ...baseHeaders };
    if (attempt && ['app', 'api'].includes(info.source)) {
      if (headers.Referer) delete headers.Referer;
      else headers.Referer = hongguo.VIDEO_REFERER;
    }
    const config = {
      method: 'GET',
      url: url.href,
      responseType: 'stream',
      timeout: 60000,
      signal,
      headers,
    };
    if (web) Object.assign(config, webMediaRequestOptions(url.href));
    try {
      const response = await axios(config);
      validateMediaResponse(response);
      return response;
    } catch (error) {
      error.response?.data?.destroy?.();
      if (signal?.aborted || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') throw abortError();
      const status = Number(error?.response?.status || error?.mediaStatus || 0);
      const retryable = web ? [404, 410].includes(status) || status >= 500 && status <= 599 : status === 403;
      if (attempt === 0 && retryable) continue;
      if (status) throw mediaTransferError(`片源请求失败（HTTP ${status}），请重新连接片源`, status);
      throw error;
    }
  }
  throw mediaTransferError('片源请求失败，请重新获取片源');
}

function progressReporter(label) {
  let nextPercent = 10;
  let lastAt = 0;
  let lastBytes = 0;
  return (received, total) => {
    const now = Date.now();
    if (total > 0) {
      const percent = Math.min(100, Math.floor(received / total * 100));
      if (percent < nextPercent) return;
      console.log(`${label} ${percent}% (${formatBytes(received)}/${formatBytes(total)})`);
      nextPercent = percent >= 100 ? 101 : Math.floor(percent / 10) * 10 + 10;
      return;
    }
    if (now - lastAt < 3000) return;
    lastAt = now;
    const delta = received - lastBytes;
    lastBytes = received;
    console.log(`${label} ${formatBytes(received)} (${formatBytes(delta)}/s)`);
  };
}

async function downloadDirect(info, output, signal, report) {
  const response = await requestMediaStream(info, signal);
  const totalLength = Number(response.headers['content-length']) || 0;
  const writer = fs.createWriteStream(output);
  let received = 0;
  response.data.on('data', chunk => {
    received += chunk.length;
    report(received, totalLength);
  });
  try {
    await pipeline(response.data, writer, { signal });
  } catch (error) {
    writer.destroy();
    if (signal?.aborted) throw abortError();
    throw Object.assign(mediaTransferError('视频下载中断，请重试'), { cause: error });
  }
  if (!received) throw mediaTransferError('片源返回空内容，请重新获取片源');
  if (totalLength && received !== totalLength) throw mediaTransferError('视频下载不完整，请重试');
  return { received, totalLength };
}

async function probeMedia(file) {
  const args = [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,codec_tag_string,profile,level,width,height,pix_fmt,sample_aspect_ratio,r_frame_rate,time_base,extradata_hash,sample_rate,channels,channel_layout,bit_rate,color_range,color_space,color_transfer,color_primaries,field_order:format=duration,bit_rate,size',
    '-of', 'json',
    file,
  ];
  try {
    const { stdout } = await execFileAsync(probeMedia.ffprobe, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    return readMergeInfo(JSON.parse(stdout));
  } catch (error) {
    throw Object.assign(new Error(`媒体检查失败：${error.message}`), { code: 'LOCAL_MEDIA_TOOL_ERROR', cause: error });
  }
}

async function verifyMedia(file, quality, allowLowerQuality) {
  if (!probeMedia.ffprobe) {
    warnOnce('no-ffprobe', '未找到 ffprobe，跳过媒体有效性检查');
    const stat = await fsp.stat(file);
    if (stat.size < 100 * 1024) throw new Error('文件过小，可能不是有效视频');
    return null;
  }
  const info = await probeMedia(file);
  if (!info || !(info.w > 0) || !(info.h > 0) || !(info.duration > 0)) {
    throw new Error('文件缺少有效视频轨、分辨率或时长');
  }
  const pixels = Math.min(info.w, info.h);
  if (!allowLowerQuality && !meetsDownloadQuality(info, quality)) {
    throw new Error(`实际为 ${pixels}P（${info.w}×${info.h}），不满足 ${quality.toUpperCase()}`);
  }
  return pixels;
}

function decryptContentKeyFile(input, output, contentKey, ffmpeg, signal) {
  if (!ffmpeg) throw Object.assign(new Error('未找到 FFmpeg，无法解密片源'), { code: 'LOCAL_MEDIA_TOOL_ERROR' });
  if (!/^[a-f\d]{32}$/i.test(String(contentKey))) throw new Error('片源解密密钥格式无效');
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-decryption_key', contentKey,
      '-i', input,
      '-map', '0:v:0', '-map', '0:a?',
      '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output,
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let settled = false;
    let killTimer;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      child.stderr.destroy();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    child.stderr.on('data', () => {});
    child.once('error', () => finish(new Error('无法启动 FFmpeg')));
    child.once('close', code => {
      if (signal?.aborted) finish(abortError());
      else if (code !== 0) finish(Object.assign(new Error(`媒体解密失败（FFmpeg 退出码 ${code}）`), { code: 'LOCAL_MEDIA_TOOL_ERROR' }));
      else finish();
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function publishFile(source, destination) {
  publishMergedOutput(source, destination);
  await fsp.unlink(source).catch(() => {});
}

async function finalizeMedia(info, temporary, finalPath, context) {
  let output = temporary;
  if (info.contentKey) {
    const decoded = temporary + '.decoded';
    await decryptContentKeyFile(temporary, decoded, info.contentKey, context.ffmpeg, context.signal);
    output = decoded;
  } else if (info.spadeA) {
    const key = hongguo.deriveKey(info.spadeA);
    if (!key) throw new Error('视频密钥派生失败');
    const decoded = temporary + '.decoded';
    hongguo.decryptMp4File(temporary, decoded, key);
    output = decoded;
  }
  const pixels = await verifyMedia(output, context.quality, context.allowLowerQuality);
  if (pixels && context.allowLowerQuality && context.quality !== 'auto' && pixels < Number.parseInt(context.quality, 10)) {
    console.warn(`${context.label} 实际清晰度为 ${pixels}P，低于所选 ${context.quality.toUpperCase()}`);
  }
  if (context.overwrite) await fsp.rm(finalPath, { force: true });
  await publishFile(output, finalPath);
  return pixels;
}

async function downloadCandidate(info, finalPath, context) {
  const temporary = finalPath + '.part';
  const decoded = temporary + '.decoded';
  await fsp.rm(temporary, { force: true });
  await fsp.rm(decoded, { force: true });
  if (info.contentKey && !context.ffmpeg) {
    throw Object.assign(new Error('未找到 FFmpeg，无法解密该片源'), { code: 'LOCAL_MEDIA_TOOL_ERROR' });
  }
  if (isHls(info)) {
    if (!context.ffmpeg) throw Object.assign(new Error('未找到 FFmpeg，无法处理 HLS 片源'), { code: 'LOCAL_MEDIA_TOOL_ERROR' });
    await remuxHls({
      url: info.url,
      output: temporary,
      ffmpeg: context.ffmpeg,
      headers: mediaHeaders(info),
      signal: context.signal,
      onProgress: received => context.report(received, 0),
    });
  } else {
    await downloadDirect(info, temporary, context.signal, context.report);
  }
  return finalizeMedia(info, temporary, finalPath, context);
}

function candidateList(info) {
  const rows = [info, ...(Array.isArray(info?.variants) ? info.variants : [])];
  const seen = new Set();
  return rows.filter(candidate => {
    if (!candidate?.url) return false;
    const identity = JSON.stringify([candidate.url, candidate.contentKey || '', candidate.spadeA || '', candidate.userAgent || '', candidate.referer || '']);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

async function existingFileState(finalPath, quality, allowLowerQuality) {
  try {
    const stat = await fsp.stat(finalPath);
    if (!stat.isFile()) return false;
    if (!probeMedia.ffprobe) return stat.size > 100 * 1024;
    await verifyMedia(finalPath, quality, allowLowerQuality);
    return true;
  } catch (_) {
    return false;
  }
}

async function downloadEpisode(episode, context) {
  const finalPath = path.join(context.dir, uniqueEpisodeFilename(context.seriesTitle, episode));
  if (fs.existsSync(finalPath) && !context.overwrite) {
    const valid = await existingFileState(finalPath, context.quality, context.allowLowerQuality);
    if (valid) {
      console.log(`${context.label} 已存在，跳过：${finalPath}`);
      return 'skipped';
    }
    console.warn(`${context.label} 已存在但未通过检查，跳过（使用 --overwrite 可覆盖）：${finalPath}`);
    return 'skipped';
  }
  console.log(`${context.label} 开始 ${finalPath}`);
  const temporary = finalPath + '.part';
  let lastError;
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    if (context.signal?.aborted) throw abortError();
    if (attempt) {
      console.warn(`${context.label} 第 ${attempt + 1} 次尝试`);
      await sleep(RETRY_DELAYS[attempt - 1], context.signal);
    }
    try {
      const info = await hongguo.fetchPlayUrlSingle(episode.vid, context.seriesId, {
        quality: context.quality,
        allowLowerQuality: context.allowLowerQuality,
        force: attempt > 0,
      });
      if (!info?.url) {
        throw Object.assign(new Error(info?.error || '未获取到有效播放地址'), {
          code: info?.locked ? 'LOCKED' : info?.code,
          sources: info?.sources,
        });
      }
      let transferError;
      for (const candidate of candidateList(info)) {
        if (context.signal?.aborted) throw abortError();
        try {
          const pixels = await downloadCandidate(candidate, finalPath, context);
          console.log(`${context.label} 完成${pixels ? ` ${pixels}P` : ''}`);
          return 'completed';
        } catch (error) {
          transferError = error;
          if (context.signal?.aborted || isTerminal(error)) throw error;
          if (candidate.source === 'web') hongguo.markWebMediaFailure(candidate);
        }
      }
      throw transferError || new Error('没有可用片源');
    } catch (error) {
      lastError = error;
      if (context.signal?.aborted || isTerminal(error)) throw error;
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      await fsp.rm(temporary + '.decoded', { force: true }).catch(() => {});
    }
  }
  throw lastError || new Error('下载失败');
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  const root = path.resolve(__dirname, '..');
  const controller = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error('\n正在取消，请稍候...');
    controller.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const seriesId = await hongguo.resolveSeriesId(options.input);
    const series = await hongguo.fetchEpisodeList(seriesId);
    const episodes = series.episodes.map((episode, index) => ({
      ...episode,
      index: Number(episode.vid_index) || index + 1,
    })).sort((a, b) => a.index - b.index);
    const selected = options.episodes
      ? episodes.filter(episode => options.episodes.has(episode.index))
      : episodes;
    const missing = options.episodes
      ? [...options.episodes].filter(index => !episodes.some(episode => episode.index === index))
      : [];
    if (missing.length) console.warn(`未找到集数：${missing.join(', ')}`);
    if (!selected.length) throw new Error('没有可下载的集数');
    const seriesTitle = sanitizeFolderName(series.series_title) || '未命名短剧';
    const dir = seriesDownloadDir(options.out, seriesId, seriesTitle);
    const ffmpeg = resolveTool('ffmpeg', root);
    const ffprobe = resolveTool('ffprobe', root);
    probeMedia.ffprobe = ffprobe;
    console.log(`《${series.series_title || seriesTitle}》 共 ${episodes.length} 集，本次 ${selected.length} 集`);
    console.log(`输出目录：${dir}`);
    console.log(`FFmpeg：${ffmpeg || '未找到（HLS/加密片源不可用）'}`);
    console.log(`ffprobe：${ffprobe || '未找到（跳过媒体检查）'}`);
    if (options.dryRun) {
      for (const episode of selected) {
        console.log(`${String(episode.index).padStart(3, '0')}  ${episode.vid}  ${episode.title || ''}`.trimEnd());
        console.log(`     ${path.join(dir, uniqueEpisodeFilename(seriesTitle, episode))}`);
      }
      return;
    }
    await fsp.mkdir(dir, { recursive: true });
    const results = await runPool(selected, options.concurrency, async episode => {
      const label = `[${String(episode.index).padStart(3, '0')}]`;
      try {
        const status = await downloadEpisode(episode, {
          seriesId,
          seriesTitle,
          dir,
          quality: options.quality,
          allowLowerQuality: options.quality !== 'auto',
          overwrite: options.overwrite,
          ffmpeg,
          signal: controller.signal,
          label,
          report: progressReporter(label),
        });
        return { episode, status };
      } catch (error) {
        if (error?.code === 'ABORT_ERR') return { episode, status: 'aborted' };
        console.error(`${label} 失败：${error.message}`);
        return { episode, status: 'failed', error };
      }
    });
    const count = status => results.filter(result => result.status === status).length;
    console.log(`完成 ${count('completed')} 集，跳过 ${count('skipped')} 集，失败 ${count('failed')} 集${count('aborted') ? '，已取消' : ''}`);
    if (count('failed') || count('aborted')) process.exitCode = count('aborted') ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

if (require.main === module) {
  main().catch(error => {
    if (error?.code === 'ABORT_ERR') {
      process.exitCode = 130;
      return;
    }
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  parseEpisodeSelection,
  sanitizeFolderName,
  renderName,
  uniqueEpisodeFilename,
  seriesDownloadDir,
  isHls,
};

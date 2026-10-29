#!/usr/bin/env node
/**
 * BiliIDM Bridge —— B站 → IDM 下载桥接服务
 *
 * 解决的核心问题：B站 CDN（*.bilivideo.com / *.mountaintoys.cn 等）强制校验
 * Referer / UA / Cookie，IDM 拿到的裸 URL 一律 403。本服务在 127.0.0.1 起一个
 * 反向代理，把防盗链头补齐后再让 IDM 去下载，于是 IDM 的多线程/Range 分段
 * 全部可用，日志里也看不到 403。
 *
 * 端点：
 *   GET  /health                 服务状态 / IDM / ffmpeg / 下载目录
 *   POST /api/add                单个文件入队
 *   POST /api/add-batch          多文件（DASH 音视频）入队，可自动合并
 *   GET  /f/:id/:name            代理流（支持 Range / HEAD）
 *   GET  /api/jobs               任务列表
 *   POST /api/merge              手动触发合并
 *   POST /api/open               打开下载目录
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { resolveOptions as resolvePage } from './bili.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.BILIIDM_CONFIG || path.join(__dirname, 'config.json');
const LOG_PATH = path.join(__dirname, 'bridge.log');
const VERSION = '1.0.0';

// ---------------------------------------------------------------- config ----

const DEFAULT_CONFIG = {
  port: 12788,
  host: '127.0.0.1',
  downloadDir: path.join(os.homedir(), 'Downloads', 'BiliIDM'),
  idmanPath: '',
  ffmpegPath: '',
  mergeAutoDelete: true,
};

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    } else {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    }
  } catch (e) {
    log('config load failed: ' + e.message);
  }
  if (process.env.BILIIDM_PORT) cfg.port = Number(process.env.BILIIDM_PORT);
  if (process.env.BILIIDM_DOWNLOAD_DIR) cfg.downloadDir = process.env.BILIIDM_DOWNLOAD_DIR;
  if (process.env.BILIIDM_IDMAN) cfg.idmanPath = process.env.BILIIDM_IDMAN;
  if (process.env.BILIIDM_FFMPEG) cfg.ffmpegPath = process.env.BILIIDM_FFMPEG;
  return cfg;
}

const cfg = loadConfig();
try {
  fs.mkdirSync(cfg.downloadDir, { recursive: true });
} catch (e) {
  console.error(`无法创建下载目录 ${cfg.downloadDir}: ${e.message}`);
  console.error('请修改 config.json 里的 downloadDir，或设置环境变量 BILIIDM_DOWNLOAD_DIR');
  process.exit(1);
}

// ------------------------------------------------------------------ log ----

let logStream = null;
try { logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' }); } catch { /* ignore */ }
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { logStream?.write(line + '\n'); } catch { /* ignore */ }
}

// ------------------------------------------------------------- discovery ----

function firstExisting(list) {
  for (const p of list) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return '';
}

function findIdman() {
  if (cfg.idmanPath && fs.existsSync(cfg.idmanPath)) return cfg.idmanPath;
  const found = firstExisting([
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Internet Download Manager', 'IDMan.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Internet Download Manager', 'IDMan.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Internet Download Manager', 'IDMan.exe'),
  ]);
  if (found) return found;
  // 注册表兜底
  const r = spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\DownloadManager', '/v', 'ExePath'], { encoding: 'utf8' });
  const m = /REG_SZ\s+(.+?)\s*$/m.exec(r.stdout || '');
  if (m && fs.existsSync(m[1].trim())) return m[1].trim();
  return '';
}

/** 扫一遍常见位置：项目内、用户目录、Program Files、最后才兜底桌面 */
function scanForFfmpeg() {
  const bases = [
    __dirname,                                   // 项目里自带的 ffmpeg
    path.join(__dirname, '..', 'tools'),         // tools/ffmpeg/...
    os.homedir(),                                // ~/ffmpeg-*-full_build
    process.env.ProgramFiles || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    process.env.LOCALAPPDATA || '',
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Desktop'),          // 放最后：桌面是临时堆放点，随时会被清掉
  ];
  for (const base of bases) {
    let entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !/ffmpeg/i.test(e.name)) continue;
      for (const rel of [['bin', 'ffmpeg.exe'], ['ffmpeg.exe'], ['bin', 'ffmpeg']]) {
        const p = path.join(base, e.name, ...rel);
        try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
      }
    }
  }
  return '';
}

function findFfmpeg() {
  if (cfg.ffmpegPath && fs.existsSync(cfg.ffmpegPath)) return cfg.ffmpegPath;
  if (cfg.ffmpegPath) log(`config.ffmpegPath 不存在，回退自动探测：${cfg.ffmpegPath}`);
  const found = firstExisting([
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'shims', 'ffmpeg.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  ]);
  if (found) return found;
  const r = spawnSync('where', ['ffmpeg'], { encoding: 'utf8' });
  const line = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
  if (line) return line;
  return scanForFfmpeg();
}

let IDMAN = findIdman();
let FFMPEG = findFfmpeg();

// ----------------------------------------------------------------- jobs ----

/** @type {Map<string, Job>} */
const jobs = new Map();

function newId() { return crypto.randomBytes(8).toString('hex'); }

function sanitizeName(name, fallback = 'video.mp4') {
  let s = String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .replace(/^\.+/, '');
  if (!s) s = fallback;
  if (s.length > 120) {
    const ext = path.extname(s).slice(0, 10);
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s;
}

/** 探测文件总大小（Range: bytes=0-0 → Content-Range: bytes 0-0/总长） */
async function probeSize(url, headers) {
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-0', 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(15000),
    });
    const cr = r.headers.get('content-range');
    try { r.body?.cancel(); } catch { /* ignore */ }
    if (cr) {
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) return Number(m[1]);
    }
    const cl = r.headers.get('content-length');
    if (cl && r.status === 200) return Number(cl);
  } catch { /* ignore */ }
  return 0;
}

// ---------------------------------------------------------------- relay ----

const probeCache = new Map();

/** 确保 job.expect 有值（惰性探测，供 HEAD 与 IDM 任务用） */
function ensureExpect(job) {
  if (job.expect) return Promise.resolve(job.expect);
  if (probeCache.has(job.id)) return probeCache.get(job.id);
  const p = probeSize(job.url, {
    'User-Agent': job.ua || 'Mozilla/5.0',
    Referer: job.referer || 'https://www.bilibili.com/',
    ...(job.cookie ? { Cookie: job.cookie } : {}),
  }).then((n) => {
    if (n) job.expect = n;
    probeCache.delete(job.id);
    return n || 0;
  }).catch(() => 0);
  probeCache.set(job.id, p);
  return p;
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie',
]);

async function handleRelay(req, res, job) {
  const upstreamHeaders = {
    'User-Agent': job.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    Referer: job.referer || 'https://www.bilibili.com/',
    'Accept-Encoding': 'identity',
    Accept: '*/*',
  };
  if (job.cookie) upstreamHeaders.Cookie = job.cookie;
  if (req.headers.range) upstreamHeaders.Range = req.headers.range;

  // IDM 会先发 HEAD 探长度，这里本地直接答，避免上游不支持 HEAD 时误判
  if (req.method === 'HEAD') {
    const total = await ensureExpect(job);
    res.writeHead(200, {
      'Content-Type': job.mime || 'video/mp4',
      'Content-Length': String(total || 0),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(job.filename)}`,
    });
    return res.end();
  }

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });

  let up;
  try {
    up = await fetch(job.url, { method: 'GET', headers: upstreamHeaders, redirect: 'follow', signal: ac.signal });
  } catch (e) {
    // IDM 下完/断开时中止上游是正常现象，别把日志刷满
    if (e.name !== 'AbortError') log(`relay fetch failed id=${job.id}: ${e.message}`);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    return res.end('upstream error: ' + e.message);
  }

  const out = {};
  for (const [k, v] of up.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  out['Accept-Ranges'] = 'bytes';
  if (!out['content-type'] || out['content-type'] === 'application/octet-stream') {
    out['content-type'] = job.mime || 'video/mp4';
  }
  if (!out['content-disposition']) {
    out['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(job.filename)}`;
  }
  if (up.status >= 400) {
    const text = await up.text().catch(() => '');
    log(`relay upstream ${up.status} id=${job.id} body=${text.slice(0, 120)}`);
    res.writeHead(up.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`upstream returned ${up.status}: ${text.slice(0, 500)}`);
  }

  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  const stream = Readable.fromWeb(up.body);
  stream.on('error', (e) => { if (e.name !== 'AbortError') log(`relay stream error id=${job.id}: ${e.message}`); res.destroy(); });
  stream.pipe(res);
}

// ---------------------------------------------------------------- merge ----

function runFfmpeg(args, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve({ ok: false, err: 'timeout' }); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, err: e.message }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, err }); });
  });
}

async function tryMerge(groupId, manual = false) {
  const g = jobs.get(groupId);
  if (!g || g.type !== 'group') return { ok: false, err: 'no such group' };
  if (g.merging) return { ok: false, err: 'merging' };

  const files = g.items.map((it) => it.path);
  for (const f of files) {
    if (!fs.existsSync(f)) return { ok: false, err: 'not ready: ' + path.basename(f) };
  }
  if (!FFMPEG) return { ok: false, err: 'ffmpeg not found' };

  g.merging = true;
  g.status = 'merging';
  const out = g.outPath;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const f of files) args.push('-i', f);
  args.push('-map', '0:v:0?', '-map', '1:a:0?', '-c', 'copy', out);
  log(`merge start ${groupId} -> ${out}`);
  const r = await runFfmpeg(args);
  g.merging = false;
  if (r.ok) {
    g.status = 'done';
    g.mergedAt = Date.now();
    for (const it of g.items) it.status = 'done';
    log(`merge ok ${groupId}`);
    if (cfg.mergeAutoDelete) {
      for (const f of files) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
      // 扫掉同名残留分片：重复任务（同一视频点了两次 / 兜底补发）会在合并后继续写回分片
      const base = path.basename(out, path.extname(out));
      try {
        for (const e of fs.readdirSync(g.dir)) {
          if (!e.startsWith(base + '.') || !/\.m4s$/i.test(e)) continue;
          if (files.some((f) => path.basename(f) === e)) continue;
          try { fs.unlinkSync(path.join(g.dir, e)); log(`清理残留分片 ${e}`); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      g.cleaned = true;
    }
    return { ok: true, out };
  }
  g.status = 'merge-failed';
  g.error = (r.err || '').split('\n').filter(Boolean).slice(-4).join(' | ');
  log(`merge failed ${groupId}: ${g.error}`);
  return { ok: false, err: g.error };
}

/** 后台守候：两个分片下载完（大小匹配）后自动合并 */
function watchGroup(groupId) {
  const g = jobs.get(groupId);
  if (!g) return;
  const started = Date.now();
  const timer = setInterval(async () => {
    const job = jobs.get(groupId);
    if (!job || job.status === 'done' || job.status === 'merge-failed') return clearInterval(timer);
    if (Date.now() - started > 6 * 3600 * 1000) return clearInterval(timer);
    let ready = true;
    for (const it of job.items) {
      let st;
      try { st = fs.statSync(it.path); } catch { ready = false; break; }
      if (it.expect && st.size !== it.expect) { ready = false; break; }
      if (!it.expect && st.size === 0) { ready = false; break; }
    }
    if (!ready) return;
    // 稳定 1.2s 再确认一次，避免 IDM 刚 rename 就合并
    clearInterval(timer);
    setTimeout(async () => {
      const cur = jobs.get(groupId);
      if (!cur || cur.status === 'done') return;
      for (const it of cur.items) {
        try { if (it.expect && fs.statSync(it.path).size !== it.expect) return; } catch { return; }
      }
      await tryMerge(groupId);
    }, 1200);
  }, 1500);
}

// ------------------------------------------------------------- idm spawn ----

/**
 * IDM 命令行参数（官方语义，别乱加）：
 *   /d URL      要下载的地址
 *   /p 目录     保存目录
 *   /f 文件名   保存的文件名
 *   /n          不弹任何对话框（包括「开始下载」确认框）
 *   /a          只把任务加进主队列，**【不会开始下载】**
 *   /s          启动主队列（会把队列里所有任务一起放行）
 *
 * 所以这里绝对不能用 /a：它进的是主队列（queueID=1），主队列停着就永远不动，
 * 而且要靠 /s 才会跑 —— /s 又会顺带启动用户队列里其他被暂停的下载。
 * 用 /n 则是直接下载（注册表里 queueID=0，和浏览器扩展下发的一致），既不进队列也不用 /s。
 */
function launchIdm(url, dir, filename) {
  IDMAN = IDMAN || findIdman();
  if (!IDMAN) return { ok: false, err: 'IDMan.exe not found' };
  fs.mkdirSync(dir, { recursive: true });
  const args = ['/d', url, '/p', dir + path.sep, '/f', filename, '/n'];
  log(`idman ${args.join(' ')}`);
  try {
    const p = spawn(IDMAN, args, { detached: true, stdio: 'ignore', windowsHide: false });
    p.on('error', (e) => log('idman spawn error: ' + e.message));
    p.unref();
    return { ok: true, args };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 IDM 把这个任务真正开始（目标文件出现）。IDM 冷启动时偶尔会吞掉一两条 /d 命令。 */
async function waitForStart(filePath, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { fs.statSync(filePath); return true; } catch { /* 还没出现 */ }
    await sleep(400);
  }
  return false;
}

/**
 * IDM 的下载列表存在 HKCU\Software\DownloadManager\<id> 下，Url0 就是我们给的中继地址。
 * 补发前先查一下：如果 IDM 已经登记了这个 URL，说明只是慢，再发一条就会变成两个任务
 * 往同一个文件写 —— 合并删掉分片后还会被另一个任务写回来（用户看到的「多一个 .m4s」）。
 */
function idmKnowsUrl(url) {
  if (process.platform !== 'win32') return false;
  try {
    const list = spawnSync('reg', ['query', 'HKCU\\Software\\DownloadManager'], { encoding: 'utf8' });
    const ids = [...String(list.stdout || '').matchAll(/DownloadManager\\(\d+)\s*$/gm)].map((m) => m[1]);
    for (const id of ids) {
      const r = spawnSync('reg', ['query', `HKCU\\Software\\DownloadManager\\${id}`, '/v', 'Url0'], { encoding: 'utf8' });
      const m = /REG_SZ\s+(.+?)\s*$/m.exec(r.stdout || '');
      if (m && m[1].trim() === url) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** 后台兜底：迟迟没开始、且 IDM 里也没有该任务时才补发一次 /d */
function ensureStarted(job) {
  (async () => {
    if (await waitForStart(job.path, 30000)) return;
    if (job.status === 'done' || job.status === 'merge-failed') return;
    const localUrl = `http://${cfg.host}:${cfg.port}/f/${job.id}/${encodeURIComponent(job.filename)}`;
    if (idmKnowsUrl(localUrl)) {
      log(`30s 未落盘，但 IDM 里已登记该任务，不重复下发：${job.filename}`);
      return;
    }
    log(`30s 内没开始，补发一次：${job.filename}`);
    const r = launchIdm(localUrl, cfg.downloadDir, job.filename);
    job.status = r.ok ? 'sending' : 'idm-failed';
    if (r.ok) await waitForStart(job.path, 30000);
  })().catch((e) => log('ensureStarted error: ' + e.message));
}

// ---------------------------------------------------------------- server ----

function cors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = /^chrome-extension:\/\//.test(origin) || /^moz-extension:\/\//.test(origin) ||
    /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) || origin === '';
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  return allowed;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw new Error('body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  const allowed = cors(req, res);
  if (req.method === 'OPTIONS') return res.writeHead(allowed ? 204 : 403).end();

  let url;
  try { url = new URL(req.url, `http://${cfg.host}:${cfg.port}`); }
  catch { return json(res, 400, { ok: false, err: 'bad url' }); }

  const p = url.pathname;

  try {
    if (p === '/health') {
      return json(res, 200, {
        ok: true, version: VERSION,
        idman: IDMAN || findIdman(), ffmpeg: FFMPEG || findFfmpeg(),
        downloadDir: cfg.downloadDir, jobs: jobs.size,
      });
    }

    if (p === '/api/jobs') {
      return json(res, 200, {
        ok: true,
        jobs: [...jobs.values()].map((j) => ({
          id: j.id, type: j.type, status: j.status, name: j.filename || path.basename(j.outPath || ''),
          dir: j.dir, expect: j.expect, items: j.items?.map((i) => ({ path: i.path, expect: i.expect })), error: j.error,
        })),
      });
    }

    if (p === '/api/resolve' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.pageUrl) return json(res, 400, { ok: false, err: 'pageUrl required' });
      const r = await resolvePage(body.pageUrl, { cookie: body.cookie, ua: body.ua });
      log(`resolve ${body.pageUrl} -> ${r.ok ? r.options.length + ' options' : r.err}`);
      return json(res, 200, r);
    }

    if (p === '/api/add' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.url) return json(res, 400, { ok: false, err: 'url required' });
      const filename = sanitizeName(body.filename);
      // 同一个文件正在下就别再开一个任务（两个任务写同一路径会互相踩）
      for (const j of jobs.values()) {
        if (j.type === 'single' && j.dir === cfg.downloadDir && j.filename === filename &&
            j.status !== 'done' && j.status !== 'idm-failed') {
          return json(res, 200, { ok: true, duplicate: true, id: j.id, dir: cfg.downloadDir });
        }
      }
      const id = newId();
      const job = {
        id, type: 'single', status: 'queued',
        url: body.url, filename, dir: cfg.downloadDir,
        referer: body.referer, ua: body.ua, cookie: body.cookie,
        mime: body.mime || 'video/mp4', expect: Number(body.size) || 0,
        createdAt: Date.now(),
      };
      jobs.set(id, job);
      const localUrl = `http://${cfg.host}:${cfg.port}/f/${id}/${encodeURIComponent(filename)}`;
      if (body.dryRun) {
        await ensureExpect(job).catch(() => 0); // 探好长度，供 HEAD 自查
        return json(res, 200, { ok: true, id, localUrl, dryRun: true, dir: cfg.downloadDir });
      }
      await ensureExpect(job).catch(() => 0); // 让 IDM 拿到准确文件大小
      const r = launchIdm(localUrl, cfg.downloadDir, filename);
      job.status = r.ok ? 'sending' : 'idm-failed';
      job.path = path.join(cfg.downloadDir, filename);
      if (!r.ok) job.error = r.err;
      else ensureStarted(job);
      return json(res, 200, { ok: r.ok, id, localUrl, size: job.expect, err: r.err, dir: cfg.downloadDir });
    }

    if (p === '/api/add-batch' && req.method === 'POST') {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json(res, 400, { ok: false, err: 'items required' });
      const base = sanitizeName(body.filename || 'video.mp4').replace(/\.(mp4|m4s|flv)$/i, '');
      const outPath = path.join(cfg.downloadDir, `${base}.mp4`);
      // 同一个输出文件正在下就别再开一组（重复点击 / 两个标签页同时点）
      for (const j of jobs.values()) {
        if (j.type === 'group' && j.outPath === outPath && j.status !== 'done' && j.status !== 'merge-failed') {
          log(`重复请求，复用已有任务 ${j.id}: ${path.basename(outPath)}`);
          return json(res, 200, { ok: true, duplicate: true, groupId: j.id, out: outPath, sent: [] });
        }
      }
      const groupId = newId();
      const group = {
        id: groupId, type: 'group', status: 'queued', dir: cfg.downloadDir,
        outPath, filename: `${base}.mp4`, merge: body.merge !== false, items: [], createdAt: Date.now(),
      };
      const sent = [];
      for (const it of items) {
        if (!it || !it.url) continue;
        const suffix = it.suffix || 'part';
        const fname = sanitizeName(`${base}.${suffix}`);
        const part = {
          id: newId(), type: 'part', status: 'queued', groupId,
          url: it.url, filename: fname,
          path: path.join(cfg.downloadDir, fname),
          referer: body.referer, ua: body.ua, cookie: body.cookie,
          mime: it.mime || 'video/mp4', expect: Number(it.size) || 0,
        };
        group.items.push(part); // 同一对象引用：探到的 expect 会同步回 group
        jobs.set(part.id, part);
        const localUrl = `http://${cfg.host}:${cfg.port}/f/${part.id}/${encodeURIComponent(fname)}`;
        ensureExpect(part).catch(() => 0);
        // IDM 冷启动时两条命令挨太近会丢一条，这里串行发，留一点消化时间
        if (sent.length) await sleep(1200);
        const r = launchIdm(localUrl, cfg.downloadDir, fname);
        if (!r.ok) group.error = r.err;
        part.status = r.ok ? 'sending' : 'idm-failed';
        sent.push({ id: part.id, name: fname, ok: r.ok });
      }
      jobs.set(groupId, group);
      if (group.merge) watchGroup(groupId);
      for (const p of group.items) ensureStarted(p);
      return json(res, 200, { ok: sent.every((s) => s.ok), groupId, out: outPath, sent, err: group.error });
    }

    if (p === '/api/merge' && req.method === 'POST') {
      const body = await readBody(req);
      const r = await tryMerge(body.groupId, true);
      return json(res, r.ok ? 200 : 400, r);
    }

    if (p === '/api/open' && req.method === 'POST') {
      try { spawn('explorer.exe', [cfg.downloadDir], { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
      return json(res, 200, { ok: true, dir: cfg.downloadDir });
    }

    const m = /^\/f\/([0-9a-f]{16})\//.exec(p);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job || !job.url) return json(res, 404, { ok: false, err: 'job not found' });
      return handleRelay(req, res, job);
    }

    return json(res, 404, { ok: false, err: 'not found' });
  } catch (e) {
    log('handler error: ' + (e.stack || e.message));
    if (!res.headersSent) return json(res, 500, { ok: false, err: e.message });
    try { res.end(); } catch { /* ignore */ }
  }
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') log(`端口 ${cfg.port} 被占用，改 config.json 里的 port 后重启`);
  else log('server error: ' + e.message);
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  log(`BiliIDM Bridge v${VERSION} listening on http://${cfg.host}:${cfg.port}`);
  log(`IDM    : ${IDMAN || '(未找到)'}`);
  log(`ffmpeg : ${FFMPEG || '(未找到 — DASH 模式将无法自动合并)'}`);
  log(`下载目录: ${cfg.downloadDir}`);
});

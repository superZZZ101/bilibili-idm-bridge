/* bg.js —— 扩展与本地桥接服务之间的唯一出口 */

const DEFAULT_BRIDGE = 'http://127.0.0.1:12788';

async function getBridge() {
  const { bridgeUrl } = await chrome.storage.local.get('bridgeUrl');
  return (bridgeUrl || DEFAULT_BRIDGE).replace(/\/+$/, '');
}

/** 汇总 bilibili 域下所有 cookie（含 SESSDATA / buvid3 / bili_jct） */
async function biliCookie() {
  const map = new Map();
  const filters = [
    { domain: '.bilibili.com' },
    { url: 'https://www.bilibili.com/' },
    { url: 'https://api.bilibili.com/' },
  ];
  for (const f of filters) {
    try {
      for (const c of await chrome.cookies.getAll(f)) map.set(c.name, c.value);
    } catch (_) { /* 忽略 */ }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function post(path, body) {
  const base = await getBridge();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({ ok: false, err: `HTTP ${r.status}` }));
    return j;
  } catch (e) {
    return { ok: false, err: '连不上本地服务：' + (e.name === 'AbortError' ? '超时' : e.message), offline: true };
  } finally {
    clearTimeout(timer);
  }
}

async function health() {
  try {
    const base = await getBridge();
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(4000) });
    return await r.json();
  } catch (e) {
    return { ok: false, err: '连不上本地服务', offline: true };
  }
}

function safeName(s) {
  return String(s || 'video').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 90) || 'video';
}

/** 把用户选中的清晰度交给桥接服务 → IDM */
async function sendToIdm(option, title, pageUrl) {
  const cookie = await biliCookie();
  const ua = navigator.userAgent;
  const referer = 'https://www.bilibili.com/';
  const base = safeName(title);

  if (option.kind === 'file') {
    const filename = `${base} ${option.label.replace(/\s*·.*$/, '')}.mp4`.replace(/\s+/g, ' ');
    return post('/api/add', { url: option.url, filename, referer, ua, cookie, mime: 'video/mp4' });
  }

  const filename = `${base} ${option.label.replace(/\s*·.*$/, '')}.mp4`.replace(/\s+/g, ' ');
  return post('/api/add-batch', {
    filename,
    merge: true,
    referer,
    ua,
    cookie,
    items: [
      { url: option.video.url, suffix: 'video.m4s', mime: 'video/mp4' },
      { url: option.audio.url, suffix: 'audio.m4s', mime: 'audio/mp4' },
    ],
  });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'health':
          return reply(await health());
        case 'resolve': {
          const cookie = await biliCookie();
          return reply(await post('/api/resolve', { pageUrl: msg.url, cookie, ua: navigator.userAgent }));
        }
        case 'send':
          return reply(await sendToIdm(msg.option, msg.title, msg.pageUrl));
        case 'openFolder': {
          const r = await post('/api/open', {});
          return reply(r);
        }
        case 'getBridge':
          return reply({ ok: true, bridge: await getBridge() });
        case 'setBridge': {
          await chrome.storage.local.set({ bridgeUrl: msg.bridge });
          return reply({ ok: true, bridge: msg.bridge });
        }
        default:
          return reply({ ok: false, err: 'unknown message' });
      }
    } catch (e) {
      reply({ ok: false, err: e.message || String(e) });
    }
  })();
  return true; // 异步回复
});

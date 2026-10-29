/* popup.js */
const $ = (id) => document.getElementById(id);
const main = $('main');
const dot = $('dot');
const statusEl = $('status');
const bridgeInput = $('bridge');

const send = (msg) => new Promise((res) => {
  try { chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false, err: '无响应' })); }
  catch (e) { res({ ok: false, err: e.message }); }
});

function isVideoUrl(u) {
  try {
    const { hostname, pathname } = new URL(u);
    if (!/(^|\.)bilibili\.com$/.test(hostname)) return false;
    return /^\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i.test(pathname) || /^\/bangumi\/play\/(ep|ss)\d+/i.test(pathname);
  } catch { return false; }
}

function setStatus(ok, text) {
  dot.className = 'dot ' + (ok ? 'on' : 'off');
  statusEl.textContent = text;
}

function renderHint(html) { main.innerHTML = `<div class="hint">${html}</div>`; }

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function boot() {
  const { bridge } = await send({ type: 'getBridge' });
  bridgeInput.value = bridge || '';

  const h = await send({ type: 'health' });
  if (h?.ok) setStatus(true, `服务在线 · IDM ${h.idman ? 'OK' : '未找到'}`);
  else setStatus(false, '服务未启动');

  const tab = await getCurrentTab();
  const url = tab?.url || '';

  if (!isVideoUrl(url)) {
    renderHint('打开 B站<b>视频</b>或<b>番剧</b>页面后再点这里。<br><br>页面右下角也有悬浮的 <b>IDM</b> 按钮，作用和这里一样。');
    return;
  }

  renderHint('解析中…');
  const data = await send({ type: 'resolve', url });
  if (!data?.ok) {
    renderHint(`<span class="err">${data?.offline ? '本地服务没启动，先双击 start-bridge.cmd' : (data?.err || '解析失败')}</span>`);
    return;
  }

  main.innerHTML = '';
  const t = document.createElement('div');
  t.className = 'title-line';
  t.textContent = data.title;
  main.appendChild(t);

  for (const opt of data.options) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="lab">${opt.label}<div class="note">${opt.note || ''}</div></span><span class="go">下载</span>`;
    row.addEventListener('click', async () => {
      row.classList.add('busy');
      row.querySelector('.go').textContent = '发送中';
      const r = await send({ type: 'send', option: opt, title: data.title, pageUrl: url });
      if (r?.ok) {
        row.querySelector('.go').textContent = r.duplicate ? '已在下载' : '已发送';
        if (r.duplicate) renderHint('这个文件正在下载中，不用再点一次');
        setTimeout(() => window.close(), r.duplicate ? 1500 : 900);
      } else {
        row.classList.remove('busy');
        row.querySelector('.go').textContent = '重试';
        renderHint(`<span class="err">失败：${r?.err || '未知错误'}</span>`);
      }
    });
    main.appendChild(row);
  }
}

$('save').addEventListener('click', async () => {
  const v = bridgeInput.value.trim() || 'http://127.0.0.1:12788';
  await send({ type: 'setBridge', bridge: v });
  const h = await send({ type: 'health' });
  setStatus(!!h?.ok, h?.ok ? '服务在线' : '连不上');
});

$('folder').addEventListener('click', () => send({ type: 'openFolder' }));

boot();

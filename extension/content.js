/* content.js —— 视频页右下角悬浮按钮 + 清晰度面板（Shadow DOM 隔离样式） */
(() => {
  if (window.__BILI_IDM_LOADED__) return;
  window.__BILI_IDM_LOADED__ = true;

  const isVideoPage = () =>
    /^\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i.test(location.pathname) ||
    /^\/bangumi\/play\/(ep|ss)\d+/i.test(location.pathname);

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .btn {
    position: fixed; right: 18px; bottom: 150px; z-index: 2147483000;
    width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
    background: linear-gradient(135deg, #00aeec, #fb7299); color: #fff;
    font-size: 13px; font-weight: 700; letter-spacing: .5px;
    box-shadow: 0 4px 16px rgba(0,0,0,.28); transition: transform .15s;
  }
  .btn:hover { transform: scale(1.08); }
  .btn:active { transform: scale(.96); }
  .panel {
    position: fixed; right: 18px; bottom: 214px; z-index: 2147483000;
    width: 336px; max-height: 62vh; overflow: auto;
    background: #1f2126; color: #e8eaee; border-radius: 12px;
    box-shadow: 0 10px 40px rgba(0,0,0,.45); border: 1px solid #303339;
    padding: 12px; font-size: 13px; line-height: 1.5;
  }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .title { font-weight: 600; font-size: 13px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #666; flex: none; }
  .dot.on { background: #35c46a; }
  .dot.off { background: #e05555; }
  .row {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px;
    background: #272a30; margin-bottom: 6px; cursor: pointer; border: 1px solid transparent;
  }
  .row:hover { border-color: #00aeec; background: #2c3038; }
  .row.busy { opacity: .55; pointer-events: none; }
  .row .lab { flex: 1; }
  .row .note { font-size: 11px; color: #8b929e; }
  .row .go { font-size: 12px; color: #00aeec; }
  .msg { color: #9aa1ad; padding: 6px 2px; }
  .msg.err { color: #ff8b8b; }
  .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; padding-top: 8px; border-top: 1px solid #303339; }
  .link { color: #8b929e; font-size: 12px; cursor: pointer; text-decoration: none; }
  .link:hover { color: #00aeec; }
  .toast {
    position: fixed; right: 18px; bottom: 214px; z-index: 2147483001;
    background: #2b7d4b; color: #fff; padding: 10px 14px; border-radius: 8px;
    font-size: 13px; box-shadow: 0 6px 20px rgba(0,0,0,.4); max-width: 340px;
  }
  .toast.err { background: #a33; }
  `;

  let host = null;
  let shadow = null;
  let panel = null;
  let toastEl = null;

  function send(msg) {
    return new Promise((res) => {
      try { chrome.runtime.sendMessage(msg, (r) => { res(r || { ok: false, err: '无响应' }); }); }
      catch (e) { res({ ok: false, err: e.message }); }
    });
  }

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'bili-idm-host';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'IDM';
    btn.title = 'B站 → IDM 下载';
    btn.addEventListener('click', () => (panel ? closePanel() : openPanel()));
    shadow.append(style, btn);
    document.documentElement.appendChild(host);
  }

  function unmount() {
    closePanel();
    host?.remove();
    host = null;
    shadow = null;
  }

  function closePanel() {
    panel?.remove();
    panel = null;
  }

  function showToast(text, isErr) {
    toastEl?.remove();
    toastEl = document.createElement('div');
    toastEl.className = 'toast' + (isErr ? ' err' : '');
    toastEl.textContent = text;
    shadow.appendChild(toastEl);
    setTimeout(() => { toastEl?.remove(); toastEl = null; }, 4000);
  }

  async function openPanel() {
    closePanel();
    panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `<div class="head"><span class="dot"></span><span class="title">解析中…</span></div><div class="msg">正在向本地服务请求清晰度列表</div>`;
    shadow.appendChild(panel);

    const [data, h] = await Promise.all([
      send({ type: 'resolve', url: location.href }),
      send({ type: 'health' }),
    ]);
    if (!panel) return;

    const dot = panel.querySelector('.dot');
    dot.className = 'dot ' + (h?.ok ? 'on' : 'off');
    dot.title = h?.ok ? '本地服务在线' : '本地服务未运行';

    if (!data?.ok) {
      panel.querySelector('.title').textContent = '解析失败';
      const msg = panel.querySelector('.msg');
      msg.className = 'msg err';
      msg.textContent = data?.offline
        ? '本地服务没启动：双击 bili-idm\\start-bridge.cmd，或运行 install.ps1 装自启'
        : (data?.err || '未知错误');
      const foot = document.createElement('div');
      foot.className = 'foot';
      foot.innerHTML = `<span class="link" data-act="open">打开下载目录</span><span class="link" data-act="retry">重试</span>`;
      panel.appendChild(foot);
      foot.addEventListener('click', (e) => {
        const act = e.target.dataset.act;
        if (act === 'open') send({ type: 'openFolder' });
        if (act === 'retry') openPanel();
      });
      return;
    }

    const titleEl = panel.querySelector('.title');
    titleEl.textContent = data.title || '当前视频';
    titleEl.title = data.title || '';
    panel.querySelector('.msg')?.remove();

    for (const opt of data.options) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="lab">${opt.label}<div class="note">${opt.note || ''}</div></span><span class="go">下载</span>`;
      row.addEventListener('click', async () => {
        row.classList.add('busy');
        row.querySelector('.go').textContent = '发送中';
        const r = await send({ type: 'send', option: opt, title: data.title, pageUrl: location.href });
        if (r?.ok) {
          row.querySelector('.go').textContent = r.duplicate ? '已在下' : '已发送';
          showToast(
            r.duplicate
              ? '这个文件正在下载中，不用再点一次'
              : '已交给 IDM 下载' + (r.dir ? `：${r.dir}` : ''),
            false,
          );
          setTimeout(closePanel, 1200);
        } else {
          row.classList.remove('busy');
          row.querySelector('.go').textContent = '重试';
          showToast('失败：' + (r?.err || '未知错误'), true);
        }
      });
      panel.appendChild(row);
    }

    const foot = document.createElement('div');
    foot.className = 'foot';
    foot.innerHTML = `<span class="link" data-act="open">打开下载目录</span><span class="link" data-act="refresh">刷新</span>`;
    panel.appendChild(foot);
    foot.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (act === 'open') send({ type: 'openFolder' });
      if (act === 'refresh') openPanel();
    });
  }

  // 路由变化（B站是 SPA）时自动挂载/卸载
  let lastState = null;
  setInterval(() => {
    const want = isVideoPage();
    if (want === lastState) return;
    lastState = want;
    if (want) mount();
    else unmount();
  }, 1200);

  if (isVideoPage()) { mount(); lastState = true; }
})();

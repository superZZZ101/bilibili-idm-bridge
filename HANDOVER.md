# BiliIDM 交接文档

> **B站视频 → IDM 下载桥接**：MV3 浏览器扩展 + 本地 Node 服务
> 最近更新：2026-11-03 · 状态：**可用，端到端已验证**（详见 §9）
> 代码仓库：<https://github.com/superZZZ101/bili-idm-bridge>

---

## 1. 这个项目解决什么问题

B站网页播放走 **DASH + MSE**：页面里的 `<video>` 是 `blob:` 地址，真正的分片在
`*.bilivideo.com` / `*.mountaintoys.cn` 等 CDN 上，而且**强制校验
`Referer: https://www.bilibili.com/`、User-Agent、Cookie**，裸链接一律 403。

所以「右键 → 用 IDM 下载」拿不到地址，拿到也下不动。**这不是 IDM 设置问题，是机制问题。**

本工具的解法：

1. 扩展读登录 Cookie，调 B站接口拿直链；
2. 本地起一个反向代理（中继），把防盗链头补齐；
3. 把中继 URL 交给 `IDMan.exe`，IDM 的多线程 / Range 分段照常工作；
4. DASH 的音视频两路都下完后，用 ffmpeg `-c copy` 合并成一个 mp4。

原始参照：Chrome 商店「B站视频下载助手」`nlhgchhigkpbiefockjkoocnjgbdmpkl`（v1.0.18，
混淆 webpack，用 `playurl` 取直链 + `chrome.downloads`）。本项目复刻其机制、重写为可维护代码，出口换成 IDM。

---

## 2. 快速上手（三步）

1. **起服务**
   - 临时：双击 `start-bridge.cmd`（黑窗口别关；关掉即停）
   - 常驻：`powershell -ExecutionPolicy Bypass -File install.ps1`
     会在启动文件夹写 `BiliIDM Bridge.vbs`（隐藏窗口、**不需要管理员权限**）
   - 卸载自启：`install.ps1 -Remove`
2. **装扩展**：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension\` 目录
3. **用**：打开 B站视频 / 番剧页 → 右下角圆形 **IDM** 按钮 → 选清晰度 → 下载

自检：浏览器打开 `http://127.0.0.1:12788/health`，返回 `{"ok":true,...}` 即正常。

---

## 3. 架构与数据流

```
B站视频页
   │  content.js 注入「IDM」悬浮按钮（Shadow DOM）
   │  chrome.runtime.sendMessage
   ▼
bg.js（扩展 service worker）
   │  chrome.cookies 汇总 SESSDATA/buvid3/… ；带 navigator.userAgent
   │  POST /api/resolve · /api/add · /api/add-batch
   ▼
bridge/server.mjs（127.0.0.1:12788）
   │  bili.mjs：view + playurl 解析直链（fnval=4048 DASH / fnval=1 单文件）
   │  IDMan.exe /d <中继URL> /p <目录> /f <文件名> /n
   ▼
IDM ──Range──▶ /f/<token>/<name> 中继（补 Referer/UA/Cookie）──▶ CDN
   ▼
IDM 落盘 ▶（DASH）watchGroup 等到两个分片 size==expect ▶ ffmpeg -c copy 合并 ▶ 清分片
```

---

## 4. 目录结构与文件职责

| 路径 | 职责 |
|---|---|
| `bridge/server.mjs` | HTTP 服务：中继代理、IDM 拉起、合并看护、任务管理、去重 |
| `bridge/bili.mjs` | B站接口解析：页面 URL → 清晰度列表；防盗链头；buvid3 引导 |
| `bridge/config.json` | 端口 / 下载目录 / IDM / ffmpeg 路径（首次启动自动生成，已被 .gitignore） |
| `bridge/config.example.json` | 配置模板（仓库里只放这个） |
| `extension/manifest.json` | MV3 声明，权限 `storage/cookies/activeTab` |
| `extension/bg.js` | 扩展与桥接的唯一出口：cookie 汇总、resolve、send、health |
| `extension/content.js` | 页面右下角悬浮按钮 + 清晰度面板 |
| `extension/popup.html` / `popup.js` | 工具栏弹窗 UI（与悬浮按钮同功能） |
| `extension/icons/` | 图标（System.Drawing 生成，纯渐变无文字） |
| `start-bridge.cmd` | 前台启动（带黑窗口，双击用） |
| `install.ps1` | 检查环境、生成 config、写启动项自启；`-Remove` 卸载 |
| `tools/test-relay.mjs` | 中继 Range / HEAD / 流式自测（10 项） |
| `tools/test-resolve.mjs` | `/api/resolve` 自测（普通视频 / 分P / 番剧 / 非视频页） |
| `tools/test-idm.mjs` | 端到端：桥接 → 中继 → IDM 落盘（下载目录取自 `/health`） |
| `tools/e2e-merge.mjs` | 全链路：解析 → 双路 IDM → ffmpeg 合并 |
| `tools/idm-probe.mjs` | 只测 IDM 本身（自带本地 HTTP 源，可对比 `/a`、`/n` 等写法） |
| `tools/test-config.json` | 测试用配置（下载目录 `C:\BiliIDM-test`，避免写用户的 Downloads） |
| `HANDOVER.md` | 本文档 |

---

## 5. 桥接服务接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, version, idman, ffmpeg, downloadDir, jobs}` |
| POST | `/api/resolve` | `{pageUrl, cookie?, ua?}` → `{ok, title, options[]}` |
| POST | `/api/add` | 单文件：`{url, filename, referer, ua, cookie}` |
| POST | `/api/add-batch` | 音视频分管 + 自动合并：`{items:[{url,suffix}], filename, merge}` |
| GET | `/f/<token>/<name>` | 中继（支持 Range / HEAD） |
| GET | `/api/jobs` | 任务列表 |
| POST | `/api/merge` | 手动合并 `{groupId}` |
| POST | `/api/open` | 打开下载目录 |

- 重复请求（同名且仍在跑）不会新建任务，直接返回 `{ok:true, duplicate:true, groupId|id}`
- 跨域只放行 `chrome-extension://` / `moz-extension://` / `localhost` / `127.0.0.1`

---

## 6. 配置项（`bridge/config.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | 12788 | 服务端口；扩展弹窗里可改桥接地址 |
| `host` | 127.0.0.1 | 只绑本机 |
| `downloadDir` | `~/Downloads/BiliIDM` | IDM 落盘目录（换 D 盘就改这里，已实测可用） |
| `idmanPath` | 空 = 自动探测 | `IDMan.exe` 绝对路径 |
| `ffmpegPath` | 空 = 自动探测 | `ffmpeg.exe` 绝对路径 |
| `mergeAutoDelete` | true | 合并后删 `.m4s` 分片 |

环境变量覆盖：`BILIIDM_CONFIG` / `BILIIDM_PORT` / `BILIIDM_DOWNLOAD_DIR` / `BILIIDM_IDMAN` / `BILIIDM_FFMPEG`。

---

## 7. 关键实现细节

### 7.1 防盗链与抗风控（`bili.mjs`）
- 直链必须带 `Referer: https://www.bilibili.com/` + 真实 UA + Cookie。
- **`-412 request was banned` 的根因是 UA 过旧**：`Chrome/126` 会被拦，`Chrome/156` 通过。
  当前 `UA_DEFAULT` 是 156，扩展会用浏览器真实 `navigator.userAgent` 覆盖。
- 没有 `buvid3` 时用 `https://api.bilibili.com/x/frontend/finger/spi` 现取指纹补上。

### 7.2 清晰度来源
- DASH：`/x/player/playurl?avid&cid&qn=127&fnver=0&fourk=1&fnval=4048`（视频+音频分离）
- 单文件：同接口 `fnval=1`（直接 mp4，上限 720P）
- 番剧：`/pgc/player/web/playurl?...&ep_id=` + `/pgc/view/web/season`
- 同一清晰度按 codec 优先 `avc`；标签 8K/4K/1080P60/…/360P

### 7.3 中继代理（`handleRelay`）
- 透传 `Range`，返 206 + `Content-Range`，IDM 多线程分段正常。
- `HEAD` 本地处理：`probeSize()` 用 `Range: bytes=0-0` 取总长，`ensureExpect()` 缓存。
- 去掉 hop-by-hop 头；`Accept-Encoding: identity` 防 gzip；客户端断开则 abort 上游。
- 客户端主动断开的 `AbortError` 不写日志（正常现象，别刷屏）。

### 7.4 IDM 拉起 —— **参数语义有坑，必看**
```
IDMan.exe /d <中继URL> /p <下载目录> /f <文件名> /n
```

| 参数 | 官方真实含义 |
|---|---|
| `/d` | 要下载的地址 |
| `/p` `/f` | 保存目录 / 文件名 |
| `/n` | 不弹任何对话框（含「开始下载」确认框） |
| `/a` | **只加入主队列，不开始下载**（`queueID=1`） |
| `/s` | 启动主队列（会连带放行队列里**所有**被暂停的任务） |

上一版用了 `/a`，任务只建目录就永远不动（主队列停着），这也是旧文档里
「90 秒没落盘」的真因。中间曾用「补发 `/s`」救活，但 `/s` 会启动用户自己的队列，副作用明显。
**现在用 `/n`**：直接下载、不进队列（`queueID=0`，与浏览器扩展下发一致）、不弹框。

配套的三处工程处理：

- **串行下发**：IDM 冷启动时两条 `/d` 挨太近（实测 20ms）会丢一条 → 音视频只下一个。
  `add-batch` 里两条之间等 1.2s。
- **兜底重试**：`ensureStarted()` 后台盯 30s，目标文件没出现才补发一次。
  补发前先用 `idmKnowsUrl()` 查 `HKCU\Software\DownloadManager\<id>\Url0`：
  已登记说明只是慢，**不再重复下发**。
- **防重复**：`/api/add`、`/api/add-batch` 对同名在跑的任务直接返回 `duplicate`；
  合并成功后还会扫掉同名 `*.m4s` 残留（历史重复任务留下的）。

`findIdman()` 优先 `Program Files (x86)\Internet Download Manager\IDMan.exe`，
兜底查 `HKLM\SOFTWARE\WOW6432Node\DownloadManager\ExePath`。

### 7.5 DASH 合并（`watchGroup` / `tryMerge`）
- 两个分片都交给 IDM，后台每 1.5s 检查是否 `size == expect`。
- 就绪后：`ffmpeg -hide_banner -loglevel error -y -i v.m4s -i a.m4s -map 0:v:0? -map 1:a:0? -c copy out.mp4`
- `mergeAutoDelete` 控制合并后删不删分片；合并完成会把 part 标 `done`。

### 7.6 ffmpeg 探测
- 顺序：`config.ffmpegPath` → 项目目录 → `~/ffmpeg-*` → Program Files / LOCALAPPDATA
  → `Downloads` / `Documents` → **桌面放最后** → winget/scoop/choco → `where ffmpeg` → `scanForFfmpeg()`
- 配置路径失效时打日志 `config.ffmpegPath 不存在，回退自动探测：...`，不会静默变空。
- `install.ps1` 也会扫 `$env:USERPROFILE`、`Downloads`、`Documents`、`Desktop` 下的 `ffmpeg*\bin\ffmpeg.exe`。

### 7.7 页面识别（**当前局限所在**，见 §10.1）
三处各自维护一份「什么算视频页」的判断，目前都只认两种路径：

| 文件 | 位置 | 现规则 |
|---|---|---|
| `extension/content.js` | `isVideoPage()`，第 6–8 行 | pathname `/video/(BV[0-9A-Za-z]{10}\|av\d+)` 或 `/bangumi/play/(ep\|ss)\d+` |
| `extension/popup.js` | `isVideoUrl()`，第 13–18 行 | 同上 |
| `bridge/bili.mjs` | `parsePage()`，第 33–46 行 | 同上；不匹配返回 `null` → resolve 报「不是 B站视频 / 番剧页面」 |

---

## 8. 仓库

- <https://github.com/superZZZ101/bili-idm-bridge>（public，`main`）
- 已 gitignore：`bridge/config.json`、`bridge/bridge.log`、`downloads/`、`tmp/`、`*.m4s`
- 本机推代码：仓库已配 `http.proxy=http://127.0.0.1:7890`（直连 GitHub 会被 RST）

```powershell
cd C:\Users\mingy\Documents\ds_harness\bili-idm
git add -A
git commit -m "说明改了什么"
git push
```

---

## 9. 已完成的验证

| 项 | 结果 |
|---|---|
| 防盗链确认 | 裸请求 403 / 带 Referer 206 ✅ |
| 中继 Range / HEAD / 流式 | `tools/test-relay.mjs` 10/10 ✅ |
| 解析（视频 / 分P / 番剧 / 非视频页） | 匿名可列 480P DASH + 720P 单文件 ✅ |
| IDM 落盘（单文件） | `tools/test-idm.mjs`：封面图 276514 字节精确落盘，IDM 冷启动也通过 ✅ |
| DASH 全链路 | `tools/e2e-merge.mjs`：BV1PsxT68E5J 480P/360P → 两路下载 → 合并成 25.5MB / 18.6MB mp4，ffprobe 确认 h264 852×480 + aac、343s ✅ |
| 防重复下发 | 同名任务连发两次，第二次返回 `duplicate:true`，不新建 IDM 任务 ✅ |
| 真实使用 | 用户实测 1080P《鸣人VS佐助》：mp4 238,673,848 字节，h264+aac，1161s ✅ |
| 语法 | 全部 `.mjs` / `.js` 过 `node --check`，`install.ps1` 过 PowerShell 解析器 ✅ |

---

## 10. 已知问题 / 待办

### 10.1 稍后再看 / 收藏夹等「内嵌播放」页面没有下载按钮（**当前唯一未修的功能缺口**）

现象：在「稍后再看」里点开视频播放时，右下角不出现 IDM 按钮；工具栏弹窗也提示
「打开 B站视频或番剧页面后再点这里」。

原因：这些页面的 URL 不是 `/video/...`，而是形如

```
https://www.bilibili.com/list/watchlater?bvid=BV1xxxxxxxxx&oid=170001234&mode=0
https://www.bilibili.com/list/ml1234567?bvid=BV1xxxxxxxxx&oid=...
https://www.bilibili.com/medialist/play/ml1234567?oid=...
旧版：https://www.bilibili.com/watchlater/#/BV1xxxxxxxxx
```

`media` 页 `pathname` 是 `/list/...` / `/watchlater/`，于是：

1. `content.js` 的 `isVideoPage()` 不匹配 → 不注入按钮；
2. `popup.js` 的 `isVideoUrl()` 不匹配 → 直接提示换页面；
3. `bili.mjs` 的 `parsePage()` 返回 `null` → 即使手动调 `/api/resolve` 也报「不是 B站视频 / 番剧页面」。

修复方案（三处一起改，约 30 行）：

- 从 `URL` 里补提取：query 的 `bvid`、`oid`（= avid）；hash 里的 `BV[0-9A-Za-z]{10}`；分P 仍取 `p`
- 先匹配番剧路径（番剧语境下 `oid` 是 ep_id，别误当 aid）
- `parsePage()` 里保留一个兜底：常规路径不匹配时，再按「query/hash 中有 bvid 或纯数字 oid」判定为 video
- 建议抽一个共用的 `isVideoUrl()` 逻辑（目前三份拷贝，改三遍容易漏）

验证方式：

```powershell
# 改完先确认桥接能解析
curl.exe -s -X POST http://127.0.0.1:12788/api/resolve -H "Content-Type: application/json" `
  -d "{\"pageUrl\":\"https://www.bilibili.com/list/watchlater?bvid=BV1PsxT68E5J\"}"
# 再在浏览器里打开该页面，确认右下角按钮出现、能列清晰度
```

### 10.2 其它

1. **IDM 旧任务会“诈尸”**：IDM 重启会续下上次没下完的任务。若历史任务的目标路径已失效，
   每次启动会弹「您需要有管理员权限才能将文件保存到选定的路径」，看着像插件坏了。
   → 在 IDM 列表里删掉那条任务即可。（2026-10-29 已清理过一条 9/20 遗留的测试任务）
2. **画质上限**：匿名 720P 单文件 / 480P DASH；登录（SESSDATA）才有 1080P+，大会员才有 4K/8K。
   （1080P 已由用户实测通过）
3. **扩展是未打包开发版**：Chrome 每次开机的「开发者模式」提示视策略而定；上架需打包 crx（超出范围）。
4. **DSH 沙箱里 IDM 不可用**：沙箱拦 `%APPDATA%` 写入，且给工作区加的 ACL 里有
   `Everyone:(DENY)(DC)`，IDM 保存会报权限错误。真机（无沙箱）无此问题。
5. **IDM 列表会残留已合并条目**：分片合并后被删，IDM 列表里那两条仍显示已完成（`Status=3`）。
   不影响使用，属正常现象。

---

## 11. 排错手册

| 现象 | 处理 |
|---|---|
| 面板报「本地服务没启动」 | `start-bridge.cmd` 重启，或先测 `http://127.0.0.1:12788/health` |
| 提示已发送但 IDM 没动静 | 看 `bridge\bridge.log` 有无 `30s 内没开始，补发一次`；IDM 是否被杀软拦 |
| 目录里多出 `.m4s` 残留 | 同名任务被下发两次。现版本已去重 + 合并后清残留；历史残留手动删 |
| 音视频只下了一个 | 冷启动丢命令。已串行化（1.2s）；看日志有无补发记录 |
| IDM 弹「需要管理员权限才能保存」 | 列表里有目标路径失效的旧任务，删掉它 |
| 下载 403 | 中继没带 Referer/UA —— 看日志确认走的是 `/f/<token>` 而不是裸 URL |
| 只有 m4s 没合并 | `/health` 里 `ffmpeg` 是否为空；空则修 `ffmpegPath` |
| `/health` 里 ffmpeg 为空 | 看日志有无 `config.ffmpegPath 不存在，回退自动探测` |
| 解析 `request was banned` | UA 太旧，更新 `bili.mjs` 的 `UA_DEFAULT` |
| 端口被占 | 改 `config.json` 的 `port`，扩展弹窗底部同步改地址 |
| 右下角没按钮 | 确认当前页是 `/video/BV…` 或 `/bangumi/play/…`；其它页见 §10.1 |

---

## 12. 环境快照（2026-11-03）

- OS：Windows（用户 `mingy`），Node.js v24.18.0（`C:\Program Files\nodejs\node.exe`）
- IDM：6.43.16（`C:\Program Files (x86)\Internet Download Manager\IDMan.exe`），走系统代理 `127.0.0.1:7890`
- ffmpeg：gyn.dev portable 8.1.2（`C:\Users\mingy\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe`，config 指向它）；
  桌面那份 9.0.2 已不存在
- 浏览器：Chrome 156 / Edge 156
- 服务：`127.0.0.1:12788`，自启项 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\BiliIDM Bridge.vbs`

---

## 13. 改动记录

### 2026-11-03
- 文档重整；登记「稍后再看等内嵌播放页无按钮」缺口与修复方案（§10.1）
- 代码未改

### 2026-10-29（一次性大修，均已验证）

| 文件 | 改动 |
|---|---|
| `bridge/config.json` | `ffmpegPath` 从桌面死路径改为用户目录 8.1.2 |
| `bridge/server.mjs` | `launchIdm()` 改用 `/n`（直接下载、不进队列、不弹框），弃用 `/a` + `/s` |
| `bridge/server.mjs` | `add-batch` 两条 `/d` 串行化（1.2s），避免 IDM 冷启动丢命令 |
| `bridge/server.mjs` | 新增 `ensureStarted()` + `idmKnowsUrl()`：30s 未开始时才补发，且补发前查 IDM 列表防重复 |
| `bridge/server.mjs` | 防重复：同名在跑的任务返回 `duplicate`；合并后清同名残留分片；part 标 `done`；`AbortError` 不再刷日志 |
| `bridge/server.mjs` | `scanForFfmpeg()` 顺序调整（项目内 → 用户目录 → 程序目录 → Downloads/Documents → 桌面最后），失效时打日志 |
| `bridge/bili.mjs` | 修 `pick()` 的格式错位 |
| `extension/content.js`、`popup.js` | 收到 `duplicate` 时提示「这个文件正在下载中，不用再点一次」 |
| `install.ps1` | ffmpeg 探测增加用户目录扫描 |
| `install.ps1` | 修三个会跑挂的 bug：①改存 **UTF-8 with BOM**（PS 5.1 否则按 ANSI 读，中文乱码→语法错误）；②`schtasks` 在 `Stop` 策略下把 stderr 当异常，包了 `Invoke-SchTasks`；③ffmpeg 扫描循环变量原名 `$root`，覆盖了脚本根目录 |
| `install.ps1` | 自启从 `schtasks /SC ONLOGON`（普通权限「拒绝访问」）改为启动文件夹 `.vbs` |
| `tools/test-idm.mjs` | 下载目录改为从 `/health` 读 |
| `tools/idm-probe.mjs`、`tools/e2e-merge.mjs` | 新增 |
| `README.md`、`LICENSE`、`.gitignore` | 新增；发布到 GitHub |
# BiliIDM 交接文档

> B站视频 → IDM 下载桥接工具：浏览器扩展（MV3）+ 本地 Node 桥接服务。
> 交接日期：2026-10-29 · 状态：**可用，端到端已验证**（单文件、DASH 音视频合并都实测落盘，见 §8）

---

## 1. 这个项目解决什么问题

B站网页播放走 **DASH + MSE**，播放器的 `<video>` 是 `blob:` 地址，页面里没有直达媒体文件；真正的分片在 `*.bilivideo.com` / `*.mountaintoys.cn` 等 CDN 上，且 **强制校验 `Referer: https://www.bilibili.com/`、User-Agent、Cookie**，裸链接一律 403。

所以 IDM 右键「用 IDM 下载」拿不到地址、或拿到也 403 —— **不是设置问题，是机制问题**。

本工具的解法：扩展负责读登录 Cookie + 调 B站接口拿直链；一个**本地反向代理**把防盗链头补齐，再把 URL 交给 `IDMan.exe /d ...`，IDM 的多线程 Range 下载完全照常。

原始参照插件：Chrome 商店「B站视频下载助手」，ID `nlhgchhigkpbiefockjkoocnjgbdmpkl`（v1.0.18，混淆 webpack，用 `playurl` 取直链 + `chrome.downloads`）。本项目复刻其机制、重写为可维护代码，并把出口换成 IDM。

---

## 2. 快速上手（三步）

1. **起服务**：双击 `start-bridge.cmd`（黑窗口别关），或跑一次 `install.ps1` 装「登录时自启」
   （会在启动文件夹写 `BiliIDM Bridge.vbs`，隐藏窗口、**不需要管理员权限**；`install.ps1 -Remove` 取消自启并停服务）。
2. **装扩展**：`chrome://extensions` → 开「开发者模式」→「加载已解压的扩展程序」→ 选 `extension\` 目录。
3. **用**：打开任意 B站视频/番剧页 → 右下角圆形 **IDM** 按钮 → 选清晰度 → 点下载 → IDM 自动开始。

> 健康自检：浏览器打开 `http://127.0.0.1:12788/health`，返回 `{"ok":true,...}` 即正常。

---

## 3. 架构与数据流

```
B站视频页
   │  content.js 注入「IDM」按钮（Shadow DOM）
   │  chrome.runtime.sendMessage
   ▼
bg.js（扩展 service worker）
   │  read B站 cookie (SESSDATA/buvid3/…) via chrome.cookies
   │  POST /api/resolve · /api/add · /api/add-batch
   ▼
bridge/server.mjs（本地 127.0.0.1:12788）
   │  bili.mjs：view + playurl(fnval=4048 DASH / fnval=1 单文件) 直链解析
   │  启动 IDMan.exe /d "http://127.0.0.1:12788/f/<token>/<name>" /p <dir> /f <name> /n
   │  （/n = 不弹框、直接下载、不进队列；详见 §5.4）
   ▼
IDM 发 Range 请求 → /f/<token>/ 中继补 Referer/UA/Cookie → 回源 CDN
   ▼
IDM 落盘 → （DASH）watchGroup 大小匹配后 → ffmpeg -c copy 合并音视频
```

---

## 4. 目录结构与文件职责

| 路径 | 职责 |
|---|---|
| `bridge/server.mjs` | HTTP 服务：中继代理、IDM 拉起、合并看护、任务管理 |
| `bridge/bili.mjs` | B站接口解析：URL→清晰度列表、防盗链头、buvid3 引导 |
| `bridge/config.json` | 端口 / 下载目录 / IDM / ffmpeg 路径（自动生成可手改） |
| `extension/manifest.json` | MV3 声明，权限 `storage/cookies/activeTab` |
| `extension/bg.js` | 扩展与桥接的唯一出口：cookie 汇总、resolve、send、health |
| `extension/content.js` | 页面右下角悬浮「IDM」按钮 + 清晰度面板 |
| `extension/popup.html` + `popup.js` | 工具栏弹窗 UI（与悬浮按钮同功能） |
| `extension/icons/` | 生成的图标（System.Drawing，纯渐变无文字） |
| `start-bridge.cmd` | 前台启动服务（双击用） |
| `install.ps1` | 检查环境、生成 config、写启动项自启（不需要管理员；`-Remove` 卸载） |
| `tools/*.mjs` | 探针与测试脚本 |
| `tools/test-idm.mjs` | 端到端：桥接 → 中继 → IDM 落盘（从 `/health` 取下载目录） |
| `tools/e2e-merge.mjs` | 全链路：解析 → 音视频入队 IDM → ffmpeg 自动合并成 mp4 |
| `tools/idm-probe.mjs` | 只测 IDM 本身（自带本地 HTTP 源，可对比 `/a`、`/a,/s` 等写法） |
| `tools/test-config.json` | 测试用配置（下载目录指向工作区，避免写 `Downloads`） |

---

## 5. 关键实现细节

### 5.1 防盗链与抗风控（桥接层，`bili.mjs`）
- 直链请求必须带 `Referer: https://www.bilibili.com/` + 真实 UA + Cookie。
- **`-412 request was banned` 的根因是 UA 过旧**：`Chrome/126.0.0.0` 被风控拦截，`Chrome/156.0.0.0` 通过。当前 `UA_DEFAULT` 已设为 156，扩展会传浏览器真实 `navigator.userAgent` 覆盖。
- 无 `buvid3` 时用 `https://api.bilibili.com/x/frontend/finger/spi` 现取指纹补上。

### 5.2 清晰度来源
- DASH：`/x/player/playurl?avid&cid&qn=127&fnver=0&fourk=1&fnval=4048`（视频+音频分离）
- 单文件：同接口 `fnval=1`（直接 mp4，画质上限 720P）
- 番剧：`/pgc/player/web/playurl?...&ep_id=` + `/pgc/view/web/season`
- 分组：同一清晰度按 codec 优先 `avc`，画质标签 8K/4K/1080P60/…/360P。

### 5.3 中继代理（`server.mjs` 的 `handleRelay`）
- 透传 `Range`，返 206 + `Content-Range`，IDM 多线程分段正常。
- 本地处理 `HEAD`（避免上游不支持 HEAD 误判）：先 `probeSize()` 用 `Range: bytes=0-0` 拿总长，经 `ensureExpect()` 缓存。
- 去除 hop-by-hop 头，`Accept-Encoding: identity` 防 gzip 干扰，客户端断开时 abort 上游。

### 5.4 IDM 拉起（参数语义有坑，必看）
```
IDMan.exe /d <中继URL> /p <下载目录> /f <文件名> /n
```
IDM 官方参数语义（别想当然）：

| 参数 | 真实含义 |
|---|---|
| `/d` | 要下载的地址 |
| `/p` `/f` | 保存目录 / 文件名 |
| `/n` | 不弹任何对话框（含「开始下载」确认框） |
| `/a` | **只把任务加进主队列，不开始下载**（`queueID=1`） |
| `/s` | 启动主队列（会把队列里**所有**被暂停的任务一起放行） |

上一版用的是 `/a`，所以任务只建了任务目录就永远不动——主队列停着，谁也不会去点开始。
当时临时用「补发 `/s`」救活，但 `/s` 会顺带启动用户自己暂停的队列任务，副作用明显。

现在改用 **`/n`**：直接下载，不进队列（注册表里 `queueID=0`，和浏览器扩展下发的完全一致），
既不弹框也不用 `/s`，对用户已有的队列零影响。

两个工程细节：
- **串行下发**：IDM 冷启动时，两条 `/d` 命令挨太近（实测间隔 20ms）会丢一条，
  音视频这种双任务就会只下一个。`add-batch` 里两条之间等 1.2s。
- **兜底重试**：`ensureStarted()` 在后台盯 30s，目标文件还没出现才补发一次 `/d`。
  补发前会先用 `idmKnowsUrl()` 查一遍 IDM 的下载列表（`HKCU\Software\DownloadManager\<id>\Url0`）：
  如果 IDM 里已经登记了这个中继地址，说明只是慢，**不再重复下发**（否则两个任务写同一个文件，
  合并删掉分片后还会被另一个任务写回来，目录里就多出一个 `.m4s`）。

### 5.4.1 防重复下载
同一路径同时开两个任务会互相踩，所以：
- `/api/add` 和 `/api/add-batch` 都会先查有没有**同名且在跑**的任务，有就直接返回 `{duplicate:true, groupId/id}`，不重复下发；
- 扩展侧收到 `duplicate` 会提示「这个文件正在下载中，不用再点一次」；
- 合并成功后除了删自己那两个分片，还会扫掉同名的 `*.m4s` 残留（历史重复任务留下的）。

`findIdman()` 自动找 `Program Files (x86)\Internet Download Manager\IDMan.exe`，兜底查注册表 `HKLM\SOFTWARE\WOW6432Node\DownloadManager\ExePath`。

### 5.5 DASH 合并（`watchGroup` / `tryMerge`）
- 音视频两个任务都发给 IDM，后台每 1.5s 检查两个文件是否 `size == expect`。
- 都就绪后：`ffmpeg -i v.m4s -i a.m4s -map 0:v:0? -map 1:a:0? -c copy out.mp4`。
- `mergeAutoDelete` 控制合并后删不删 m4s 分片。

### 5.6 ffmpeg 探测
- 顺序：`config.json.ffmpegPath` → 项目目录 → `~/ffmpeg-*`（用户目录）→ Program Files / LOCALAPPDATA → `Downloads`/`Documents` → **桌面放最后** → winget/scoop/choco → `where ffmpeg` → `scanForFfmpeg()`。
- 配置里的路径失效时会打日志 `config.ffmpegPath 不存在，回退自动探测：...`，不会静默变成空。
- 本机实际情况（2026-10-29）：桌面那份 `ffmpeg-9.0.2-full_build` **已经不存在**（旧交接里的死路径），
  当前可用的是 `C:\Users\mingy\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe`，config 已指向它。
- `install.ps1` 也会扫 `$env:USERPROFILE`、`Downloads`、`Documents`、`Desktop` 下的 `ffmpeg*\bin\ffmpeg.exe`。

---

## 6. 桥接服务接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, version, idman, ffmpeg, downloadDir, jobs}` |
| POST | `/api/resolve` | `{pageUrl, cookie?, ua?}` → 清晰度列表 |
| POST | `/api/add` | 单文件入队并拉起 IDM：`{url, filename, referer, ua, cookie}` |
| POST | `/api/add-batch` | 音视频分片入队 + 自动合并：`{items:[{url,suffix}], filename, merge}` |
| GET | `/f/<token>/<name>` | 中继（支持 Range/HEAD） |
| GET | `/api/jobs` | 任务列表 |
| POST | `/api/merge` | 手动触发合并 `{groupId}` |
| POST | `/api/open` | 打开下载目录 |

只有 `chrome-extension://` / `moz-extension://` / `localhost` 来源允许跨域。

---

## 7. 配置项（`bridge/config.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | 12788 | 服务端口，扩展里可改 |
| `host` | 127.0.0.1 | 只绑本机 |
| `downloadDir` | `~/Downloads/BiliIDM` | IDM 落盘目录 |
| `idmanPath` | 空=自动探测 | IDMan.exe 绝对路径 |
| `ffmpegPath` | 空=自动探测 | ffmpeg.exe 绝对路径（本机填 `C:\Users\mingy\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe`） |
| `mergeAutoDelete` | true | 合并后删 m4s 分片 |

环境变量可覆盖：`BILIIDM_CONFIG` / `BILIIDM_PORT` / `BILIIDM_DOWNLOAD_DIR` / `BILIIDM_IDMAN` / `BILIIDM_FFMPEG`。

想换到 D 盘就把 `downloadDir` 改成 `D:\BiliIDM`（IDM 读写都没问题，已实测）。

---

## 8. 已完成的验证

| 项 | 结果 |
|---|---|
| 防盗链确认 | durl 裸请求 403 / 带 Referer 206 ✅ |
| 中继 Range/HEAD/流式 | `tools/test-relay.mjs` 10/10 通过 ✅ |
| 解析（视频/分P/番剧/非视频页） | 匿名可列 480P DASH + 720P 单文件 ✅ |
| **IDM 落盘（单文件）** | `tools/test-idm.mjs`：封面图 276514 字节，中继 → IDM 精确落盘 ✅（冷启动 IDM 也通过） |
| **DASH 全链路** | `tools/e2e-merge.mjs`：BV1PsxT68E5J 480P/360P，音视频两路 IDM 下载完 → ffmpeg 自动合并 → 25.5MB / 18.6MB mp4，ffprobe 确认 h264 852×480 + aac，时长 343s ✅ |
| ffmpeg 合并 | 用用户目录 8.1.2 真实做 `-c copy` ✅ |
| 防重复下发 | 同名任务连发两次，第二次返回 `{"ok":true,"duplicate":true,...}`，不再起第二个 IDM 任务 ✅ |
| 真实使用 | 用户实测下载 1080P《鸣人VS佐助》：mp4 238,673,848 字节，ffprobe 确认 h264+aac、时长 1161s ✅ |
| 扩展脚本语法 | bg/content/popup/server/bili 全部 `node --check` 通过 ✅ |

---

## 9. 已知问题 / 待办

1. ~~**IDM 实际落盘未端到端跑通**~~ **已解决（2026-10-29）**：真因不是「确认框等人点」，而是
   `/a` 的语义是「只加入主队列、不开始下载」（`queueID=1`），主队列停着任务就永远不动；
   浏览器扩展下发的是 `queueID=0`（直接下载），所以手动用 IDM 一直正常。
   修法：改用 `/n`（直接下载、不弹框、不进队列），配合双任务串行下发 + 兜底重试。详见 §5.4。

2. **旧任务会“诈尸”**：IDM 重启时会把上次没下完的任务续下。如果历史遗留的坏任务（例如 `idm_box_min_2`）
   目标路径已失效，就会每次启动弹「您需要有管理员权限才能将文件保存到选定的路径」，看起来像是插件坏了。
   处理：在 IDM 列表里删掉那条任务。本次已清理 9 月 20 日遗留的那条测试任务，以及我们自己测试产生的条目
   （键值 `HKCU\Software\DownloadManager\65` 等，43/61 是用户自己的下载，已保留）。

3. **DSH 沙箱里 IDM 不可用**：沙箱会拦住 `%APPDATA%` 写入，IDM 起不来/存不了。真机（无沙箱）无此问题。
   另外沙箱给工作区加的 ACL 里有 `Everyone:(DENY)(DC)`（拒绝删除子项），IDM 保存时也会因此报权限错误。

4. **画质上限**：匿名 720P 单文件 / 480P DASH；登录（SESSDATA）才有 1080P+，大会员才有 4K/8K——未用账号实测。

5. ~~`install.ps1` 用了 `$x ?? $y`（PowerShell 7 语法）~~ 已改为 `[string]$x`，Windows PowerShell 5.1 也能跑。

6. 扩展为未打包开发版，Chrome 每次开机「开发者模式/被停用」提示视政策而定；要彻底上架需打包 crx/发布商店（超出当前范围）。

7. ~~`/s` 会启动整个主队列~~ 已不再使用 `/s`：改走 `/n` 直接下载（`queueID=0`），不碰用户的队列。
   代价是多了一个「冷启动时两条 `/d` 太近会丢一条」的坑，已用串行下发 + `ensureStarted()` 兜底重试解决。

---

## 10. 排错手册

| 现象 | 处理 |
|---|---|
| 按钮面板报「本地服务没启动」 | 重新双击 `start-bridge.cmd`，或 `http://127.0.0.1:12788/health` 验证 |
| 提示已发送但 IDM 没动静 | 看 `bridge\bridge.log`，有没有 `30s 内没开始，补发一次` |
| 目录里多出一个 `.xxx.m4s` | 同名任务被下发了两次（重复点击 / 旧版兜底重试）。现已去重 + 合并后清残留；历史残留手动删掉即可 |
| 音视频只下了一个 | IDM 冷启动时两条命令太近会丢，桥接已串行化（1.2s 间隔）；若仍出现看日志里的重试记录 |
| IDM 弹「您需要有管理员权限才能将文件保存到选定的路径」 | 多半是列表里有条目标路径已失效的旧任务（IDM 启动时会自动续），在 IDM 里删掉它 |
| IDM 弹确认框 | 点「开始下载」；或 IDM 选项关掉对话框 |
| 下载 403 | 中继没带 Referer/UA —— 看 `bridge.log`，确认走的是 `/f/<token>` 不是裸 URL |
| 只有 m4s 没合并 | 看 `/health` 里 `ffmpeg` 是否为空；空的改 config 里 `ffmpegPath`（本机指 `C:\Users\mingy\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe`） |
| `/health` 里 ffmpeg 为空 | 看 `bridge.log` 有没有 `config.ffmpegPath 不存在，回退自动探测` |
| 解析 `request was banned` | UA 太旧，更新 `bili.mjs` 的 `UA_DEFAULT` 为当前 Chrome 版本 |
| 端口被占 | 改 `config.json` 的 `port`，扩展弹窗底部同步改桥接地址 |

---

## 11. 环境快照（交接时）

- OS：Windows（用户 `mingy`）
- Node.js：v24.18.0（`C:\Program Files\nodejs\node.exe`）
- IDM：6.43.16（`C:\Program Files (x86)\Internet Download Manager\IDMan.exe`），走系统代理 127.0.0.1:7890
- ffmpeg：gyn.dev portable 8.1.2（`C:\Users\mingy\ffmpeg-8.1.2-full_build`，config 指向它）；桌面那份 9.0.2 已不存在
- 浏览器：Chrome 156.0.8078.48 / Edge 156.0.4314.42

---

## 12. 2026-10-29 这次改了什么

| 文件 | 改动 |
|---|---|
| `bridge/config.json` | `ffmpegPath` 从桌面死路径改为 `C:\Users\mingy\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe` |
| `bridge/server.mjs` | `launchIdm()` 改用 `/n`（直接下载、不进队列、不弹框），不再用 `/a` + `/s`，对用户已有队列零影响 |
| `bridge/server.mjs` | `scanForFfmpeg()` 扫描顺序调整（项目内 → 用户目录 → 程序目录 → Downloads/Documents → 桌面最后）；配置路径失效时打日志 |
| `bridge/server.mjs` | `add-batch` 两条 `/d` 之间串行化（1.2s），避免 IDM 冷启动丢命令 |
| `bridge/server.mjs` | 新增 `ensureStarted()`：30s 内目标文件没出现才补发，且补发前用 `idmKnowsUrl()` 查 IDM 列表避免重复下发；客户端断开的 `AbortError` 不再刷日志 |
| `bridge/server.mjs` | 防重复：`/api/add`、`/api/add-batch` 对同名在跑的任务返回 `{duplicate:true}`；合并后清理同名残留分片；合并完成把 part 标记 `done` |
| `extension/content.js`、`popup.js` | 收到 `duplicate` 时提示「这个文件正在下载中，不用再点一次」 |
| `bridge/bili.mjs` | 顺手修了 `pick()` 的格式错位（`{  let best`） |
| `install.ps1` | ffmpeg 探测增加对 `$env:USERPROFILE` 等目录的 `ffmpeg*` 扫描 |
| `install.ps1` | 修了三个会让脚本直接跑挂的 bug：①文件改存 **UTF-8 with BOM**（PowerShell 5.1 否则按 ANSI 读，中文乱码→语法错误）；②`schtasks` 在 `Stop` 策略下把 stderr 当异常，包了 `Invoke-SchTasks`；③ffmpeg 扫描循环变量原先叫 `$root`，把脚本根目录覆盖了，导致提示里的扩展路径变成 `Downloads\extension` |
| `install.ps1` | 自启方式从 `schtasks /SC ONLOGON`（普通权限下被「拒绝访问」）改为启动文件夹里的 `.vbs` 隐藏启动器 |
| `tools/test-config.json` | 同步新的 ffmpeg 路径 |
| `tools/test-idm.mjs` | 下载目录改为从 `/health` 的 `downloadDir` 读，不再写死工作区 |
| `tools/idm-probe.mjs` | 新增：自带 HTTP 源的 IDM 落盘探针（可对比 `/a`、`/a,/s`） |
| `tools/e2e-merge.mjs` | 新增：解析 → 双路 IDM → ffmpeg 合并的全链路测试 |
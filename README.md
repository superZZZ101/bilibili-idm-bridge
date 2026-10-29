# bilibili-idm-bridge

把 B 站视频一键交给 **Internet Download Manager (IDM)** 下载：浏览器扩展（MV3）+ 本地 Node 桥接服务。

B 站网页播放走 **DASH + MSE**，页面里的 `<video>` 是 `blob:`，真正的分片在 CDN 上且强制校验
`Referer` / `User-Agent` / `Cookie`——裸链接直接 403。所以「右键用 IDM 下载」拿不到地址，
拿到也下不动，**不是设置问题**。

本工具的思路：扩展读登录 Cookie + 调 B 站接口拿直链；本地起一个反向代理把防盗链头补齐，
再把 URL 交给 `IDMan.exe`。IDM 的多线程 / Range 分段完全照常，日志里也不会有 403。

```
B站视频页
   │  content.js 注入「IDM」悬浮按钮（Shadow DOM）
   ▼
bg.js（扩展 service worker）  ── 读 cookie、调接口
   ▼
bridge/server.mjs（127.0.0.1:12788）
   │  bili.mjs：view + playurl 解析直链
   │  IDMan.exe /d <中继URL> /p <目录> /f <文件名> /n
   ▼
IDM ──Range──▶ /f/<token> 中继（补 Referer/UA/Cookie）──▶ CDN
   ▼
IDM 落盘 ──(DASH)──▶ ffmpeg -c copy 合并音视频 ──▶ 单个 mp4
```

## 特性

- 一键把视频 / 番剧清晰度列表交给 IDM，支持 8K/4K/1080P60/…/360P 标签
- 中继自动补齐防盗链头，IDM 直接吃 206 分段下载
- DASH 音视频分离下载后自动用 ffmpeg 合并成 mp4，并清理分片
- 全程本地 `127.0.0.1`，不需要任何第三方解析服务
- 对 IDM 队列**零侵入**：用 `/n` 直接下载，不会动你已暂停的队列任务
- 同名任务自动去重，重复点击不会生成两个任务写同一个文件

## 环境要求

- Windows（用到 `IDMan.exe` 与 `reg`）
- Node.js ≥ 18（开发验证于 v24）
- Internet Download Manager 6.x（验证于 6.43）
- ffmpeg（可选；没有的话 DASH 只会得到两个 `.m4s` 分片）

## 快速开始

### 1. 起桥接服务

```powershell
# 双击也行；黑窗口别关
start-bridge.cmd

# 或装「登录自启」（会在启动文件夹写一个隐藏启动器，不需要管理员权限）
powershell -ExecutionPolicy Bypass -File install.ps1
# 取消自启并停服务
powershell -ExecutionPolicy Bypass -File install.ps1 -Remove
```

自检：浏览器打开 <http://127.0.0.1:12788/health>，返回 `{"ok":true,...}` 即正常。

### 2. 装扩展

1. `chrome://extensions`（Edge 用 `edge://extensions`）
2. 右上角打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选本仓库的 `extension` 目录

### 3. 用

打开任意 B 站视频 / 番剧页 → 右下角 **IDM** 圆钮 → 选清晰度 → 下载。
文件落在 `downloadDir`（默认 `~/Downloads/BiliIDM`）。工具栏弹窗与悬浮按钮功能相同。

## 配置

首次启动会自动生成 `bridge/config.json`（参考 `bridge/config.example.json`，该文件已被 `.gitignore`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | 12788 | 服务端口，扩展弹窗里可改桥接地址 |
| `host` | 127.0.0.1 | 只绑本机 |
| `downloadDir` | `~/Downloads/BiliIDM` | IDM 落盘目录 |
| `idmanPath` | 空 = 自动探测 | `IDMan.exe` 绝对路径 |
| `ffmpegPath` | 空 = 自动探测 | `ffmpeg.exe` 绝对路径 |
| `mergeAutoDelete` | true | 合并后删掉 `.m4s` 分片 |

环境变量可覆盖：`BILIIDM_CONFIG` / `BILIIDM_PORT` / `BILIIDM_DOWNLOAD_DIR` / `BILIIDM_IDMAN` / `BILIIDM_FFMPEG`。

## 桥接接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, version, idman, ffmpeg, downloadDir, jobs}` |
| POST | `/api/resolve` | `{pageUrl, cookie?, ua?}` → 清晰度列表 |
| POST | `/api/add` | 单文件下单：`{url, filename, referer, ua, cookie}` |
| POST | `/api/add-batch` | 音视频分管下单 + 自动合并：`{items:[{url,suffix}], filename, merge}` |
| GET | `/f/<token>/<name>` | 中继（支持 Range / HEAD） |
| GET | `/api/jobs` | 任务列表 |
| POST | `/api/merge` | 手动合并 `{groupId}` |
| POST | `/api/open` | 打开下载目录 |

只有 `chrome-extension://` / `moz-extension://` / `localhost` 来源允许跨域。

## 踩过的坑（都已在代码里处理）

| 现象 | 原因 | 处理 |
|---|---|---|
| 任务只建了目录、永远不开始 | `/a` 的官方语义是「加入主队列但**不**开始下载」（`queueID=1`） | 改用 `/n`：直接下载、不弹框、不进队列（`queueID=0`） |
| 音视频只下了一个 | IDM 冷启动时两条 `/d` 挨太近会丢一条 | `add-batch` 两条之间串行等 1.2s |
| 目录里多出 `.m4s` 残留 | 同名任务被下发两次，合并删片后又被另一个任务写回 | 同名任务去重 + 补发前先查 IDM 列表 + 合并后清残留 |
| 每次启动 IDM 弹「需要管理员权限」 | 列表里有目标路径已失效的旧任务，IDM 会自动续下 | 在 IDM 列表里删掉那条任务 |
| `/health` 里 ffmpeg 为空 | 配置的路径失效 | 自动回退探测并打日志，改为可用路径即可 |

## 开发

```powershell
node tools/test-relay.mjs            # 中继 Range/HEAD/流式自测
node tools/idm-probe.mjs --flags=n   # 单独验证 IDM 落盘（自带 HTTP 源）
node tools/test-idm.mjs              # 桥接 → 中继 → IDM 端到端
node tools/e2e-merge.mjs "<页面URL>" 480P   # 解析 → 双路 IDM → ffmpeg 合并
```

更多实现细节见 [HANDOVER.md](HANDOVER.md)。

## 已知限制

- 仅 Windows；只做了 Chrome / Edge 的 MV3 扩展
- 匿名只能列到 480P DASH / 720P 单文件；1080P+ 需要登录 Cookie，4K/8K 需要大会员
- 扩展是未打包的开发版，Chrome 每次开机的「开发者模式」提示视策略而定

## 免责声明

仅供个人学习与**自己观看的离线备份**使用。请遵守 B 站用户协议与当地法律，
不要用于二次分发、搬运或任何商业用途。下载内容的版权归原作者所有。

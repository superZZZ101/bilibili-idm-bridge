/**
 * IDM 落盘探针 —— 隔离验证「IDMan.exe 命令行下发后是否真的下载」
 *
 * 用法：
 *   node tools/idm-probe.mjs                # 默认 /a（交接文档里的写法）
 *   node tools/idm-probe.mjs --flags=a,n    # 加 /n（静默模式）
 *   node tools/idm-probe.mjs --flags=a --wait=30 --size=8
 *
 * 做的事：
 *   1. 起一个本地 HTTP 服务（127.0.0.1:18999）供 IDM 下载，完全绕开中继/防盗链
 *   2. 用指定参数拉起 IDMan.exe
 *   3. 轮询目标文件是否出现、大小是否等于源文件
 *   4. 打印结果，便于判断「是 IDM 弹框等人点」还是「IDM 根本没下」
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 18999;

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=?([\s\S]*)$/.exec(a);
  return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
}));
const flags = String(argv.flags || 'a').split(',').filter(Boolean);
const waitSec = Number(argv.wait || 45);
const sizeMb = Number(argv.size || 8);
const DL = argv.dir ? path.resolve(String(argv.dir)) : path.join(ROOT, 'downloads');
const name = `idm_probe_${SizeTag()}${flags.join('')}.bin`;

function SizeTag() { return `${Date.now().toString(36)}_`; }

fs.mkdirSync(DL, { recursive: true });
const srcPath = path.join(DL, name);
const size = sizeMb * 1024 * 1024;
fs.writeFileSync(srcPath, Buffer.alloc(size, 0x41));
const target = path.join(DL, `dl_${name}`);

const server = http.createServer((req, res) => {
  // IDM 会先 HEAD/GET 探长度
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Length': String(size), 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' });
    return res.end();
  }
  res.writeHead(200, {
    'Content-Length': String(size), 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
  });
  fs.createReadStream(srcPath).pipe(res);
});

function findIdman() {
  const cands = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Internet Download Manager', 'IDMan.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Internet Download Manager', 'IDMan.exe'),
  ];
  return cands.find((p) => fs.existsSync(p)) || '';
}

function idmRunning() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq IDMan.exe', '/NH'], { encoding: 'utf8' });
  return /IDMan\.exe/i.test(r.stdout || '');
}

server.listen(PORT, '127.0.0.1', async () => {
  const idman = findIdman();
  console.log(`source : ${srcPath} (${(size / 1048576).toFixed(1)} MB)`);
  console.log(`target : ${target}`);
  console.log(`idman  : ${idman || '(未找到)'}`);
  console.log(`flags  : /${flags.join(' /')}`);
  if (!idman) { server.close(); process.exit(1); }

  const args = ['/d', `http://127.0.0.1:${PORT}/${name}`, '/p', DL + path.sep, '/f', path.basename(target)];
  for (const f of flags) args.push('/' + f);

  const before = idmRunning();
  console.log(`IDM 预先在跑: ${before}`);
  const p = spawn(idman, args, { detached: true, stdio: 'ignore' });
  p.unref();

  const t0 = Date.now();
  const deadline = t0 + waitSec * 1000;
  let last = -1;
  let done = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    let sz = 0;
    try { sz = fs.statSync(target).size; } catch { /* 还没出现 */ }
    if (sz !== last) {
      console.log(`  +${((Date.now() - t0) / 1000).toFixed(0)}s size=${sz}/${size} (${((sz / size) * 100).toFixed(0)}%)`);
      last = sz;
    }
    if (sz === size) { done = true; break; }
  }

  console.log(`结果: ${done ? 'PASS 落盘完成' : 'FAIL 未完成'}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`IDM 进程在跑: ${idmRunning()}`);
  try { fs.unlinkSync(srcPath); } catch { /* ignore */ }
  server.close();
  process.exit(done ? 0 : 2);
});

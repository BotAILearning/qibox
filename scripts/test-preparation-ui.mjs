import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const captureDir = path.join(root, 'local', 'preparation-ui-captures');
const port = Number(process.env.PREP_UI_PORT || 4178);
const key = process.env.PREP_UI_KEY || randomBytes(12).toString('hex');
const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const page = `<!doctype html>
<html lang="zh-CN" data-qi-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>栖盒 · 本机准备界面预览</title>
<link rel="stylesheet" href="/web/preparation.css">
<style>
:root{color-scheme:light;--qi-bg:#f5f6fa;--qi-surface:#fff;--qi-surface-muted:#f6f8fd;--qi-text:#24283a;--qi-text-secondary:#626a7e;--qi-border:#dce1ec;--qi-primary:#4058d3;--qi-error:#bd3a4b;--qi-success:#24835a;--qi-radius-lg:16px;--qi-radius-md:10px;--qi-shadow-subtle:0 2px 10px #18264a0a;--qi-font-title:20px;--qi-font-body:14px;--qi-font-caption:12px}
:root[data-qi-theme=dark]{color-scheme:dark;--qi-bg:#17151c;--qi-surface:#201d27;--qi-surface-muted:#292530;--qi-text:#f0ecf5;--qi-text-secondary:#b9b0c5;--qi-border:#393341;--qi-primary:#9bbcff;--qi-error:#ff9da7;--qi-success:#83d7ac;--qi-shadow-subtle:0 2px 10px #0003}
*{box-sizing:border-box}body{margin:0;background:var(--qi-bg);color:var(--qi-text);font:14px/1.5 system-ui,sans-serif}.preview{max-width:900px;margin:0 auto;padding:28px 24px 60px}.preview header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}.preview h1{margin:0;font-size:20px}.preview-controls{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}.preview button,.preview select{min-height:40px;padding:8px 12px;border:1px solid var(--qi-border);border-radius:8px;background:var(--qi-surface);color:var(--qi-text);font:inherit}.preview button{cursor:pointer}.preview button[aria-pressed=true]{border-color:var(--qi-primary);color:var(--qi-primary)}.preview-note{margin:0 0 18px;color:var(--qi-text-secondary)}.market-panel{min-width:0}.wechat-preparation button.primary{border-color:var(--qi-primary);background:var(--qi-primary);color:#fff;font-weight:600}.wechat-preparation button.quiet{background:transparent;color:var(--qi-primary)}.phone-preview{display:none;justify-content:center;margin-top:20px}.phone-preview[data-visible=true]{display:flex}.phone-preview iframe{width:min(390px,100%);height:740px;border:1px solid var(--qi-border);border-radius:24px;background:var(--qi-bg);box-shadow:0 8px 28px #10182822}
</style></head><body><main class="preview"><header><h1>栖盒本机准备界面</h1><button id="theme" type="button">切换深色模式</button></header>
<p class="preview-note">隔离预览数据：仅演示 UI 状态，不连接 NAS、微信账号或运行资源服务。</p>
<nav class="preview-controls" aria-label="预览状态">
<button data-state="idle">待准备</button><button data-state="working">本机校验中</button><button data-state="error">自检失败</button><button data-state="import-error">离线导入失败</button><button data-state="ready">环境就绪</button><button data-state="installed">客户端已安装</button><button id="mobile">手机视口 390 × 740</button>
</nav><section class="market-panel" id="preview"></section><section class="phone-preview" id="phone-preview"><iframe id="phone-frame" title="手机预览 390 × 740"></iframe></section></main>
<script type="module">
import { preparationMarkup } from '/web/preparation-view.mjs';
const params = new URLSearchParams(location.search), valid = params.get('key') === ${JSON.stringify(key)};
if (!valid) { document.body.innerHTML = '<main style="padding:40px;font:16px system-ui">预览地址无效</main>'; throw new Error('invalid preview key'); }
const base={bytes:0,total:193273528,remaining:38797312,architecture:'x64',details:{reusedFiles:18,missingResources:2}};
let currentState=params.get('state')||'idle';
function render(name=params.get('state')||'idle'){
 currentState=name;
 const button=document.querySelector('[data-state="'+name+'"]'); document.querySelectorAll('[data-state]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
 let state={...base,status:'idle',stage:'checking'}; let library={installed:null,downloadSize:154140672,remainingDownloadSize:67108864}; let options={};
 if(name==='working') state={...state,status:'working',stage:'verifying',bytes:38535168,remaining:128738360};
 if(name==='error') state={...state,status:'error',stage:'selftest',error:'运行环境自检未通过，请重新校验或导入离线环境包。'};
 if(name==='import-error') {state={...state,status:'error',stage:'checking',error:'本机准备尚未启动'};options={importError:'离线包内部资源校验失败'};}
 if(name==='ready') state={...state,status:'ready',stage:'ready',remaining:0};
 if(name==='installed') {state={...state,status:'ready',stage:'ready',remaining:0};library={installed:{version:'3.9.12'},downloadSize:154140672,remainingDownloadSize:0};}
 document.querySelector('#preview').innerHTML=preparationMarkup(state,library,options);
 params.set('state',name); history.replaceState(null,'',location.pathname+'?'+params.toString());
 if(document.querySelector('#phone-preview').dataset.visible==='true') showPhone();
}
function showPhone(){const theme=document.documentElement.dataset.qiTheme||'light';document.querySelector('#phone-preview').dataset.visible='true';document.querySelector('#phone-frame').src='/mobile?key='+encodeURIComponent(params.get('key'))+'&state='+encodeURIComponent(currentState)+'&theme='+theme;}
document.querySelectorAll('[data-state]').forEach(button=>button.addEventListener('click',()=>render(button.dataset.state)));
document.querySelector('#theme').addEventListener('click',()=>{const dark=document.documentElement.dataset.qiTheme!=='dark';document.documentElement.dataset.qiTheme=dark?'dark':'light';document.querySelector('#theme').textContent=dark?'切换浅色模式':'切换深色模式';if(document.querySelector('#phone-preview').dataset.visible==='true')showPhone();});
document.querySelector('#mobile').addEventListener('click',showPhone);
render();
</script></body></html>`;

const mobilePage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>手机视口预览</title><link rel="stylesheet" href="/web/preparation.css"><style>
:root{color-scheme:light;--qi-bg:#f5f6fa;--qi-surface:#fff;--qi-surface-muted:#f6f8fd;--qi-text:#24283a;--qi-text-secondary:#626a7e;--qi-border:#dce1ec;--qi-primary:#4058d3;--qi-error:#bd3a4b;--qi-success:#24835a;--qi-radius-lg:16px;--qi-radius-md:10px;--qi-font-title:20px;--qi-font-body:14px;--qi-font-caption:12px}
:root[data-qi-theme=dark]{color-scheme:dark;--qi-bg:#17151c;--qi-surface:#201d27;--qi-surface-muted:#292530;--qi-text:#f0ecf5;--qi-text-secondary:#b9b0c5;--qi-border:#393341;--qi-primary:#9bbcff;--qi-error:#ff9da7;--qi-success:#83d7ac}
*{box-sizing:border-box}body{margin:0;padding:14px 12px;background:var(--qi-bg);color:var(--qi-text);font:14px/1.5 system-ui,sans-serif}.wechat-preparation button.primary{border-color:var(--qi-primary);background:var(--qi-primary);color:#fff;font-weight:600}.wechat-preparation button.quiet{background:transparent;color:var(--qi-primary)}
</style></head><body><main id="preview"></main><script type="module">
import {preparationMarkup} from '/web/preparation-view.mjs';const params=new URLSearchParams(location.search);if(params.get('key')!==${JSON.stringify(key)}){document.body.textContent='预览地址无效';throw Error('invalid key');}
document.documentElement.dataset.qiTheme=params.get('theme')==='dark'?'dark':'light';const name=params.get('state')||'idle';const base={bytes:0,total:193273528,remaining:38797312,architecture:'x64',details:{reusedFiles:18,missingResources:2}};let state={...base,status:'idle',stage:'checking'};let library={installed:null,downloadSize:154140672,remainingDownloadSize:67108864};let options={};if(name==='working')state={...state,status:'working',stage:'verifying',bytes:38535168,remaining:128738360};if(name==='error')state={...state,status:'error',stage:'selftest',error:'运行环境自检未通过，请重新校验或导入离线环境包。'};if(name==='import-error'){state={...state,status:'error',stage:'checking',error:'本机准备尚未启动'};options={importError:'离线包内部资源校验失败'};}if(name==='ready')state={...state,status:'ready',stage:'ready',remaining:0};if(name==='installed'){state={...state,status:'ready',stage:'ready',remaining:0};library={installed:{version:'3.9.12'},downloadSize:154140672,remainingDownloadSize:0};}document.querySelector('#preview').innerHTML=preparationMarkup(state,library,options);
</script></body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/__capture' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' }).end(); return;
  }
  if (url.pathname === '/__capture' && req.method === 'POST') {
    if (url.searchParams.get('key') !== key || !/^(desktop-light|desktop-dark|mobile-light|mobile-dark|import-failure|runtime-error)\.jpg$/.test(url.searchParams.get('name') || '')) { res.writeHead(403).end('Forbidden'); return; }
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 8 * 1024 * 1024) { res.writeHead(413).end('Screenshot too large'); return; } chunks.push(chunk); }
    const image = Buffer.concat(chunks);
    if (image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) { res.writeHead(415).end('JPEG required'); return; }
    await mkdir(captureDir, { recursive: true });
    const file = path.join(captureDir, url.searchParams.get('name'));
    await writeFile(file, image, { mode: 0o600 });
    res.writeHead(201, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify({ path: file })); return;
  }
  if (url.pathname !== '/' && url.pathname !== '/mobile' && !url.pathname.startsWith('/web/')) { res.writeHead(404).end('Not found'); return; }
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': mime['.html'], 'cache-control': 'no-store' }).end(page); return; }
  if (url.pathname === '/mobile') { res.writeHead(200, { 'content-type': mime['.html'], 'cache-control': 'no-store' }).end(mobilePage); return; }
  const relative = url.pathname.slice(1);
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.join(root, 'web') + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': mime[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch { res.writeHead(404).end('Not found'); }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Preparation UI preview: http://127.0.0.1:${port}/?key=${key}`);
  console.log('Fixture only; press Ctrl+C to stop.');
});

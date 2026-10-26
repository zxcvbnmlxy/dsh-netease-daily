import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { MusicService } from '../src/service.js';

const service = new MusicService();
const command = process.argv[2] || 'status';

function open_browser(url) {
  const executable = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore', shell: false });
  child.on('error', () => console.log('请手动打开上面的本机登录地址。'));
  child.unref();
}

async function login() {
  const result = await service.login_start();
  const qr_image = service.qr_session.qr_image;
  const token = randomBytes(24).toString('hex');
  let checking;
  let shutdown;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (request.method !== 'GET' || ![ `/${token}`, `/${token}/status` ].includes(request.url)) {
      response.writeHead(404).end(); return;
    }
    if (request.url.endsWith('/status')) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        checking ||= service.login_check().finally(() => { checking = null; });
        const state = await checking;
        response.end(JSON.stringify(state));
        if (state.status === 'logged_in') {
          console.log('已登录。凭证保存在本机，不会显示到终端或对话中。');
          shutdown ||= setTimeout(() => { server.close(); server.closeAllConnections(); }, 2000);
        }
      } catch { response.writeHead(502).end(JSON.stringify({ status: 'error', message: '登录检查失败，请重新运行 npm run login。' })); }
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>网易云扫码登录 · 每日听歌</title>
<style>body{font:17px system-ui;margin:8vh auto;padding:24px;max-width:480px;text-align:center;color:#252525;background:#faf7f2}img{width:260px;max-width:90%;border:16px solid white;border-radius:16px}p{line-height:1.7;color:#555}h1{font-size:28px}</style>
<h1>让每日推荐从你的喜好开始</h1><p>用网易云音乐 App 扫码，并在手机上确认登录。</p><img alt="网易云登录二维码" src="${qr_image}"><p id="state">等待扫码…</p><p>登录成功后可关闭此页，回到 Harness 启用每日任务。</p>
<script>let pending=false;const timer=setInterval(async()=>{if(pending)return;pending=true;try{const response=await fetch(location.pathname+'/status');const data=await response.json();document.getElementById('state').textContent=({waiting_scan:'等待扫码…',waiting_confirmation:'请在手机上确认登录',logged_in:'登录成功，可以关闭此页',expired:'二维码已过期，请重新运行 npm run login',error:'网络暂不可用，请重新运行登录命令'})[data.status]||'登录失败，请重试';if(['logged_in','expired','failed'].includes(data.status))clearInterval(timer)}catch{document.getElementById('state').textContent='连接中断，请回终端查看状态'}finally{pending=false}},3000)</script></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/${token}`;
  console.log(`请打开本机登录页：${url}`);
  console.log(`二维码文件：${result.qr_path}`);
  if (!process.argv.includes('--no-open')) open_browser(url);
  const deadline = setTimeout(() => { console.log('登录窗口已超时，必要时请重新运行。'); server.close(); server.closeAllConnections(); }, 240_000);
  server.on('close', () => { clearTimeout(deadline); clearTimeout(shutdown); });
  process.once('SIGINT', () => { server.close(); server.closeAllConnections(); });
}

try {
  if (command === 'login') await login();
  else if (command === 'status') console.log(JSON.stringify(await service.status(), null, 2));
  else if (command === 'prepare') console.log(JSON.stringify(await service.prepare(), null, 2));
  else throw new Error('可用命令：login、status、prepare。');
} catch (error) {
  console.error(`每日听歌：${error.message}`);
  process.exitCode = 1;
}

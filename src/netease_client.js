import { existsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';

/**
 * 网易云音乐客户端的唤起与降级。
 *
 * 两种常见安装形态：
 *   1. 经典桌面版：安装时注册 `orpheus://` 自定义协议，可直接用深链定位歌曲。
 *   2. Microsoft Store（MSIX）版：整包运行在 WindowsApps 下，清单里没有协议扩展，
 *      不能直接执行 exe（Access denied），只能用 `shell:AppsFolder\<AppID>` 启动应用，
 *      无法定位到某一首歌——此时如实降级并提示。
 *
 * 是否安装靠外部证据判断：协议注册项、经典路径、运行中的 cloudmusic 进程、Store 应用清单。
 * 未安装时回退网页 https://music.163.com/#/song?id=<id>。
 */

const IS_WIN = process.platform === 'win32';
const PROTOCOL = 'orpheus';
const CACHE_MS = 60_000;

let cache = { at: 0, value: null };

function run(command, args, timeout_ms = 12_000) {
  return new Promise(resolve => {
    execFile(command, args, { windowsHide: true, timeout: timeout_ms, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function powershell(script, timeout_ms = 20_000) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeout_ms);
}

export function deep_link(track_id) { return `${PROTOCOL}://song/${track_id}/?autoplay=1`; }
export function web_link(track_id) { return `https://music.163.com/#/song?id=${track_id}`; }

function exe_candidates() {
  if (!IS_WIN) return [];
  const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], 'D:\\Program Files']
    .filter(Boolean);
  const relative = [
    ['Netease', 'CloudMusic', 'cloudmusic.exe'],
    ['Netease', 'CloudMusic', 'CloudMusic.exe'],
    ['CloudMusic', 'cloudmusic.exe'],
    ['NetEase', 'CloudMusic', 'cloudmusic.exe'],
  ];
  const list = [];
  for (const root of roots) for (const parts of relative) list.push(join(root, ...parts));
  return list;
}

/** 运行中的客户端：经典版给 exe 路径；Store 版路径含 WindowsApps。 */
async function running_client() {
  const result = await powershell("$p = Get-Process cloudmusic -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1; if ($p) { $p.Path }");
  const path = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  return path || '';
}

/** Store（MSIX）应用：用开始菜单里的 AppID 启动，无法传歌曲参数。 */
async function store_client() {
  const result = await powershell("$a = Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.AppID -like '*!CLOUDMUSIC' } | Select-Object -First 1; if ($a) { $a.AppID }");
  const appid = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  return appid ? { appid } : null;
}

/** 返回 { ready, kind, detail, tried, hint }；结果缓存 60 秒避免面板轮询反复查注册表。 */
export async function detect_client({ force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  const tried = [];

  if (IS_WIN) {
    for (const key of [`HKCR\\${PROTOCOL}`, `HKCU\\Software\\Classes\\${PROTOCOL}`]) {
      const result = await run('reg', ['query', key]);
      tried.push(`${key}=${result.ok ? 'found' : 'missing'}`);
      if (result.ok) {
        const command = (result.stdout.match(/\(Default\)\s+REG_SZ\s+(.+)/) ?? [])[1]?.trim() ?? '';
        cache = { at: Date.now(), value: { ready: true, kind: 'protocol', detail: key, command, tried } };
        return cache.value;
      }
    }
    for (const path of exe_candidates()) {
      tried.push(path);
      if (existsSync(path)) {
        cache = { at: Date.now(), value: { ready: true, kind: 'exe', detail: path, tried } };
        return cache.value;
      }
    }
    const running = await running_client();
    tried.push(`running=${running || 'none'}`);
    if (running && /cloudmusic\.exe$/i.test(running)) {
      const store = /\\WindowsApps\\/i.test(running);
      cache = {
        at: Date.now(),
        value: store
          ? { ready: true, kind: 'store', detail: running, tried }
          : { ready: true, kind: 'exe', detail: running, tried },
      };
      return cache.value;
    }
    const store = await store_client();
    tried.push(`start-app=${store ? store.appid : 'missing'}`);
    if (store) {
      cache = { at: Date.now(), value: { ready: true, kind: 'store', detail: store.appid, tried } };
      return cache.value;
    }
  } else {
    for (const bin of ['/Applications/NeteaseMusic.app', '/usr/bin/netease-cloud-music']) {
      tried.push(bin);
      if (existsSync(bin)) {
        cache = { at: Date.now(), value: { ready: true, kind: 'exe', detail: bin, tried } };
        return cache.value;
      }
    }
  }

  const value = {
    ready: false,
    kind: 'missing',
    tried,
    hint: IS_WIN
      ? '未检测到网易云音乐客户端。点击歌曲会回退到网页版（VIP 歌曲可能无法播放）；安装客户端后即可直接唤起。'
      : '未检测到网易云音乐客户端，点击歌曲会回退到网页版。',
  };
  cache = { at: Date.now(), value };
  return value;
}

/** 用系统默认处理器打开 URL（不经过 shell，避免参数注入）。 */
export function open_url(url) {
  let child;
  try {
    if (IS_WIN) child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, detached: true, stdio: 'ignore' });
    else if (process.platform === 'darwin') child = spawn('open', [url], { windowsHide: true, detached: true, stdio: 'ignore' });
    else child = spawn('xdg-open', [url], { windowsHide: true, detached: true, stdio: 'ignore' });
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
  child.once('error', () => {});
  child.unref();
  return { ok: true };
}

/** 经典版：exe 支持直接以深链参数启动（协议未注册时用这条路径）。 */
function launch_exe(exe, url) {
  try {
    const child = spawn(exe, [url], { windowsHide: true, detached: true, stdio: 'ignore', shell: false });
    child.once('error', () => {});
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 把歌名写到剪贴板（等待 PowerShell 完成，避免竞态）。 */
function set_clipboard(label) {
  return new Promise(resolve => {
    try {
      const safe = String(label).replace(/'/g, "''").slice(0, 200);
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -Value '${safe}'`], { windowsHide: true, stdio: 'ignore' });
      child.once('close', code => resolve(code === 0));
      child.once('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/** Store 版：只能启动应用本身，无法定位歌曲；顺手把歌名复制到剪贴板。 */
async function launch_store(appid, label) {
  if (label) await set_clipboard(label);
  try {
    const child = spawn('explorer.exe', [`shell:AppsFolder\\${appid}`], { windowsHide: true, detached: true, stdio: 'ignore', shell: false });
    child.once('error', () => {});
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 打开一首歌：经典版优先深链；Store 版只能打开应用本身并如实说明；
 * 完全未安装时回退网页。返回 { opened, url, reason, ok, client, message }。
 */
export async function open_track(track_id, { mode = 'app', label = '' } = {}) {
  const id = String(track_id);
  if (!/^[1-9]\d{0,16}$/.test(id)) throw Object.assign(new Error('歌曲 ID 必须是正整数。'), { code: 'INVALID_ID' });
  const client = await detect_client({ force: true });

  if (mode === 'web' || !client.ready) {
    const url = web_link(id);
    const opened = open_url(url);
    return {
      opened: 'web',
      url,
      reason: mode === 'web' ? 'EXPLICIT_WEB' : 'CLIENT_NOT_INSTALLED',
      ok: opened.ok,
      client,
      message: mode === 'web' ? '已用浏览器打开网页版。' : (client.hint ?? '未检测到客户端，已回退网页版。'),
    };
  }

  const url = deep_link(id);
  if (client.kind === 'protocol') {
    const opened = open_url(url);
    return { opened: 'app', url, reason: opened.ok ? 'APP_LAUNCHED' : 'APP_LAUNCH_FAILED', ok: opened.ok, client, message: opened.ok ? '已唤起网易云音乐客户端。' : `唤起客户端失败：${opened.error ?? '未知原因'}，可改用「网页」打开。` };
  }
  if (client.kind === 'exe') {
    const launched = launch_exe(client.detail, url);
    if (launched.ok) return { opened: 'app', url, reason: 'APP_LAUNCHED_WITH_ARG', ok: true, client, message: '已用客户端程序打开该歌曲。' };
    const opened = open_url(web_link(id));
    return { opened: 'web', url: web_link(id), reason: 'APP_LAUNCH_FAILED', ok: opened.ok, client, message: '客户端启动失败，已回退网页版。' };
  }
  // Store（MSIX）版：没有注册 orpheus 协议，只能打开应用；顺手复制歌名方便粘贴搜索。
  const launched = await launch_store(client.detail, label);
  return {
    opened: 'app-degraded',
    url,
    reason: launched.ok ? 'STORE_APP_ONLY' : 'STORE_LAUNCH_FAILED',
    ok: launched.ok,
    client,
    message: launched.ok
      ? `已打开网易云音乐（Microsoft Store 版不支持按歌曲深链定位${label ? '，歌名已复制到剪贴板' : ''}；在客户端里粘贴搜索即可。想要点击即播放请安装经典桌面版）。`
      : `打开 Store 版客户端失败：${launched.error ?? '未知原因'}，可改用「网页」打开。`,
  };
}

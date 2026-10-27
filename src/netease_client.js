import { existsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';

/**
 * 网易云音乐客户端的唤起与降级。
 *
 * 客户端注册的自定义协议是 `orpheus://song/<id>/`（社区通用，加 `?autoplay=1` 可直接播放）。
 * 是否安装只能靠外部证据判断：协议注册表项或客户端可执行文件。
 * 未安装时回退到网页版 https://music.163.com/#/song?id=<id>，并把原因返回给调用方。
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
    const uninstall = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'CloudMusic', '/d']);
    tried.push(`uninstall=CloudMusic:${uninstall.ok ? 'found' : 'missing'}`);
    if (uninstall.ok && /CloudMusic/i.test(uninstall.stdout)) {
      cache = { at: Date.now(), value: { ready: true, kind: 'uninstall-entry', detail: 'uninstall registry', tried } };
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

/**
 * 打开一首歌：默认优先唤起客户端，没有客户端或显式 mode:'web' 时回退网页。
 * 返回 { opened: 'app'|'web', url, reason, message, client }。
 */
export async function open_track(track_id, { mode = 'app' } = {}) {
  const id = String(track_id);
  if (!/^[1-9]\d{0,16}$/.test(id)) throw Object.assign(new Error('歌曲 ID 必须是正整数。'), { code: 'INVALID_ID' });
  const client = await detect_client();
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
  const opened = open_url(url);
  return {
    opened: 'app',
    url,
    reason: opened.ok ? 'APP_LAUNCHED' : 'APP_LAUNCH_FAILED',
    ok: opened.ok,
    client,
    message: opened.ok ? '已唤起网易云音乐客户端。' : `唤起客户端失败：${opened.error ?? '未知原因'}，可再点“网页版”打开。`,
  };
}

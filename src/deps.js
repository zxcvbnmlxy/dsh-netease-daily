import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';

const is_windows = process.platform === 'win32';

function run(command, args, timeout_ms = 20_000) {
  return new Promise(resolve => {
    execFile(command, args, { windowsHide: true, timeout: timeout_ms, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: error?.message });
    });
  });
}

async function probe(binary) {
  if (!binary) return null;
  const result = await run(binary, ['--version']);
  if (!result.ok) return null;
  const version = result.stdout.split(/\r?\n/).find(line => line.trim()) ?? '';
  return { path: binary, version: version.trim().slice(0, 120) };
}

export function candidate_paths(settings, data_dir) {
  const list = [];
  if (settings?.player_path) list.push({ path: settings.player_path, source: 'panel' });
  if (is_windows) {
    list.push({ path: join(data_dir, 'bin', 'mpv.exe'), source: 'bundled' });
    list.push({ path: 'C:\\Program Files\\MPV Player\\mpv.exe', source: 'system' });
    list.push({ path: 'C:\\Program Files\\mpv\\mpv.exe', source: 'system' });
    list.push({ path: join(process.env.LOCALAPPDATA ?? '', 'Programs', 'mpv', 'mpv.exe'), source: 'system' });
  } else {
    list.push({ path: join(data_dir, 'bin', 'mpv'), source: 'bundled' });
    list.push({ path: '/usr/bin/mpv', source: 'system' });
    list.push({ path: '/usr/local/bin/mpv', source: 'system' });
    list.push({ path: '/opt/homebrew/bin/mpv', source: 'system' });
  }
  return list;
}

async function on_path() {
  const result = is_windows ? await run('where', ['mpv']) : await run('which', ['mpv']);
  if (!result.ok) return null;
  const first = result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  return first ? { path: first, source: 'PATH' } : null;
}

/** Report whether the silent player is usable, and where it comes from. */
export async function detect_player(settings, data_dir) {
  const tried = [];
  for (const candidate of candidate_paths(settings, data_dir)) {
    if (!candidate.path) continue;
    tried.push(candidate.path);
    if (!existsSync(candidate.path)) continue;
    const found = await probe(candidate.path);
    if (found) return { ready: true, path: found.path, version: found.version, source: candidate.source, tried };
  }
  const from_path = await on_path();
  if (from_path) {
    const found = await probe(from_path.path);
    if (found) return { ready: true, path: found.path, version: found.version, source: from_path.source, tried };
  }
  return {
    ready: false, path: '', version: '', tried,
    hint: is_windows
      ? '未找到 mpv。可以点“安装 mpv”（用 winget 安装 shinchiro.mpv），或手动安装后把路径填到“播放器路径”。'
      : '未找到 mpv。请用系统包管理器安装 mpv，或把路径填到“播放器路径”。',
  };
}

/** Install mpv through the OS package manager; results are reported, never assumed. */
export async function install_player({ data_dir }) {
  if (!is_windows) {
    return { ok: false, code: 'UNSUPPORTED', message: '本插件目前只自动安装 Windows 上的 mpv，请手动安装后填入播放器路径。' };
  }
  const winget = await run('where', ['winget']);
  if (!winget.ok) {
    return { ok: false, code: 'WINGET_MISSING', message: '系统里没有 winget，无法自动安装。请手动安装 mpv（https://mpv.io/installation/）。' };
  }
  const install = await new Promise(resolve => {
    const child = spawn('winget', ['install', '--id', 'shinchiro.mpv', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements'], {
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = chunk => { output = (output + String(chunk)).slice(-8000); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 400_000);
    child.once('error', error => { clearTimeout(timer); resolve({ ok: false, output: `${output}\n${error.message}` }); });
    child.once('close', code => { clearTimeout(timer); resolve({ ok: code === 0, code, output }); });
  });
  const detected = await detect_player({ player_path: '' }, data_dir);
  if (!install.ok && !detected.ready) {
    return { ok: false, code: 'INSTALL_FAILED', message: install.output.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300) || 'winget 安装失败。' };
  }
  return { ok: detected.ready, ...detected, output: install.output.trim().slice(-500) };
}

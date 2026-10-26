import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

/**
 * Silent playback: mpv decodes the track in real time but writes to the null
 * audio output and mutes the mixer, so nothing reaches a sound device and no
 * window is created. Progress is proven by wall-clock time plus a clean exit.
 */
export function play_silent(url, { player_path = 'mpv', seconds = 30, signal, timeout_ms = seconds * 1000 + 30_000 } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('invalid');
  } catch {
    return Promise.resolve({ status: 'failed', elapsed_seconds: 0, reason: 'invalid_url' });
  }
  if (typeof player_path !== 'string' || !player_path.trim() || player_path.includes('\0')
      || !Number.isFinite(seconds) || seconds < 1 || seconds > 600) {
    return Promise.resolve({ status: 'failed', elapsed_seconds: 0, reason: 'invalid_options' });
  }
  if (signal?.aborted) return Promise.resolve({ status: 'failed', elapsed_seconds: 0, reason: 'aborted' });

  const args = [
    '--no-config', '--load-scripts=no', '--ytdl=no', '--no-video', '--no-audio-display',
    // The whole point: no audio device is opened and the mixer is muted.
    '--ao=null', '--volume=0', '--mute=yes',
    '--really-quiet', '--terminal=no', '--input-terminal=no',
    `--length=${seconds}`, '--', parsed.href,
  ];
  return new Promise(resolve => {
    const started_at = performance.now();
    let child;
    let finished = false;
    let timer;
    const elapsed = () => Math.round(Math.min(seconds, (performance.now() - started_at) / 1000) * 100) / 100;
    const finish = (status, reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', on_abort);
      resolve({ status, elapsed_seconds: elapsed(), silent: true, ...(reason ? { reason } : {}) });
    };
    const stop = reason => { try { child?.kill('SIGKILL'); } catch {} finish('failed', reason); };
    const on_abort = () => stop('aborted');
    try {
      child = spawn(player_path, args, { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
      child.once('error', error => finish(
        error?.code === 'ENOENT' ? 'unavailable' : 'failed',
        error?.code === 'ENOENT' ? 'player_not_found' : 'player_error',
      ));
      child.once('close', (code, exit_signal) => {
        if (code !== 0 || exit_signal) return finish('failed', 'player_error');
        const wall = (performance.now() - started_at) / 1000;
        const required = Math.max(1, seconds - 1.5);
        if (wall < required) return finish('failed', 'incomplete_playback');
        finish('played');
      });
      signal?.addEventListener('abort', on_abort, { once: true });
      if (signal?.aborted) return on_abort();
      timer = setTimeout(() => stop('timeout'), timeout_ms);
    } catch (error) {
      finish(error?.code === 'ENOENT' ? 'unavailable' : 'failed', 'player_error');
    }
  });
}

export const silent_player_reasons = {
  player_not_found: '未找到 mpv 播放器，请到设置页安装或指定路径。',
  player_error: '播放器未能播放这首歌。',
  invalid_url: '没有可用的安全播放地址。',
  invalid_options: '播放器配置无效。',
  incomplete_playback: '播放提前结束，没有完成预定试听。',
  aborted: '播放已取消。',
  timeout: '播放器超时，已停止。',
};

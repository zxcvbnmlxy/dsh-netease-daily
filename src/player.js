import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

// mpv reports actual audio device and playback time; resolving a URL or exiting
// successfully alone is never treated as a completed preview.
export async function play_preview(url, {
  player_path = 'mpv', preview_seconds = 30, volume = 25, signal,
  spawn_impl = spawn, timeout_ms = preview_seconds * 1000 + 20_000,
} = {}) {
  let parsed_url;
  try {
    parsed_url = new URL(url);
    const trusted_cdn = /(?:^|\.)music\.126\.net$/i.test(parsed_url.hostname)
      || /(?:^|\.)music\.163\.com$/i.test(parsed_url.hostname);
    if (parsed_url.protocol === 'http:' && trusted_cdn && !parsed_url.port) {
      parsed_url.protocol = 'https:';
    }
    if (parsed_url.protocol !== 'https:' || parsed_url.username || parsed_url.password) {
      throw new Error('invalid');
    }
  } catch {
    return { status: 'failed', elapsed_seconds: 0, reason: 'invalid_url' };
  }
  if (typeof player_path !== 'string' || !player_path.trim() || player_path.includes('\0')
      || !Number.isFinite(preview_seconds) || preview_seconds < 1 || preview_seconds > 600
      || !Number.isFinite(volume) || volume < 0 || volume > 100
      || !Number.isFinite(timeout_ms) || timeout_ms <= 0) {
    return { status: 'failed', elapsed_seconds: 0, reason: 'invalid_options' };
  }
  if (signal?.aborted) return { status: 'failed', elapsed_seconds: 0, reason: 'aborted' };

  const args = [
    '--no-config', '--load-scripts=no', '--ytdl=no', '--no-video',
    '--audio-display=no', '--audio-fallback-to-null=no', '--input-terminal=no',
    '--terminal=yes', '--term-osd=force', '--term-osd-bar=no',
    '--msg-level=all=info',
    '--term-playing-msg=DSH_AUDIO_STARTED:${current-ao}:${audio-out-params/samplerate}',
    '--term-status-msg=DSH_AUDIO_PROGRESS:${=time-pos}:${current-ao}:${audio-out-params/samplerate}',
    `--length=${preview_seconds}`, `--volume=${volume}`, '--', parsed_url.href,
  ];
  return new Promise((resolve) => {
    const started_at = performance.now();
    let child, timer;
    let finished = false, audio_seen = false, max_time = 0, output_tail = '';
    const elapsed = () => {
      const wall_seconds = (performance.now() - started_at) / 1000;
      const played = max_time > 0 ? max_time : wall_seconds;
      return Math.round(Math.min(played, preview_seconds, wall_seconds) * 100) / 100;
    };
    const finish = (status, reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', on_abort);
      resolve({ status, elapsed_seconds: elapsed(), ...(reason ? { reason } : {}) });
    };
    const stop = (reason) => {
      try { child?.kill('SIGKILL'); } catch { /* Return only a safe, bounded result. */ }
      finish('failed', reason);
    };
    const on_abort = () => stop('aborted');
    const on_data = (chunk) => {
      // Raw logs and stream URLs are neither returned nor persisted.
      output_tail = (output_tail + String(chunk)).slice(-16_384);
      for (const match of output_tail.matchAll(/DSH_AUDIO_STARTED:([a-zA-Z0-9_-]+):(\d+)/g)) {
        if (match[1] !== 'null' && Number(match[2]) >= 1000) audio_seen = true;
      }
      for (const match of output_tail.matchAll(/DSH_AUDIO_PROGRESS:(\d+(?:\.\d+)?):([a-zA-Z0-9_-]+):(\d+)/g)) {
        if (match[2] !== 'null' && Number(match[3]) >= 1000) {
          audio_seen = true;
          max_time = Math.max(max_time, Number(match[1]));
        }
      }
    };
    try {
      child = spawn_impl(player_path, args, {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', on_data);
      child.stderr?.on('data', on_data);
      child.once('error', (error) => finish(
        error?.code === 'ENOENT' ? 'unavailable' : 'failed',
        error?.code === 'ENOENT' ? 'player_not_found' : 'player_error',
      ));
      child.once('close', (exit_code, exit_signal) => {
        if (exit_code !== 0 || exit_signal) return finish('failed', 'player_error');
        // mpv renders the status line only on a real terminal, so a piped stderr
        // carries the one-off playing message (audio device + sample rate) but no
        // progress lines. Fall back to the wall clock, which --length bounds.
        const wall_seconds = (performance.now() - started_at) / 1000;
        if (!audio_seen) return finish('failed', 'no_playback_evidence');
        const played_seconds = max_time > 0 ? max_time : wall_seconds;
        const required_seconds = Math.max(0.8, preview_seconds - 1);
        if (played_seconds < required_seconds || wall_seconds < required_seconds) {
          return finish('failed', 'incomplete_preview');
        }
        finish('played');
      });
      signal?.addEventListener('abort', on_abort, { once: true });
      if (signal?.aborted) return on_abort();
      timer = setTimeout(() => stop('timeout'), timeout_ms);
    } catch (error) {
      finish(error?.code === 'ENOENT' ? 'unavailable' : 'failed',
        error?.code === 'ENOENT' ? 'player_not_found' : 'player_error');
    }
  });
}


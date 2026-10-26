import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { play_preview } from '../src/player.js';

function fake_child() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill_calls = [];
  child.kill = (signal) => { child.kill_calls.push(signal); return true; };
  return child;
}
function fake_spawn(child, action) {
  return (...args) => {
    child.spawn_args = args;
    queueMicrotask(() => action?.(child));
    return child;
  };
}
const audio_url = 'https://m10.music.126.net/test.mp3';

test('invalid URLs do not spawn a process', async () => {
  for (const url of ['file:///secret', 'http://example.com/song.mp3',
    'https://name:secret@example.com/song.mp3', 'http://music.126.net.evil.test/song.mp3']) {
    const result = await play_preview(url, { spawn_impl: () => assert.fail('spawned') });
    assert.equal(result.reason, 'invalid_url');
  }
});

test('known NetEase HTTP CDN URLs upgrade to HTTPS and spawn without a shell', async () => {
  const child = fake_child();
  const result = await play_preview('http://m10.music.126.net/song.mp3?token=private', {
    spawn_impl: fake_spawn(child, (process) => process.emit('close', 0)),
  });
  assert.equal(result.status, 'failed');
  assert.equal(child.spawn_args[1].at(-1), 'https://m10.music.126.net/song.mp3?token=private');
  assert.equal(child.spawn_args[2].shell, false);
  assert.equal(child.spawn_args[2].windowsHide, true);
  assert.ok(child.spawn_args[1].includes('--audio-fallback-to-null=no'));
  assert.ok(child.spawn_args[1].includes('--no-config'));
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('a missing player is reported as unavailable without leaking errors', async () => {
  const child = fake_child();
  const result = await play_preview(audio_url, {
    spawn_impl: fake_spawn(child, (process) => process.emit('error',
      Object.assign(new Error('private URL and cookie'), { code: 'ENOENT' }))),
  });
  assert.deepEqual(result, { status: 'unavailable', elapsed_seconds: 0, reason: 'player_not_found' });
});

test('a start marker followed by an immediate exit is not a completed preview', async () => {
  const child = fake_child();
  const result = await play_preview(audio_url, {
    spawn_impl: fake_spawn(child, (process) => {
      process.stdout.emit('data', 'DSH_AUDIO_STARTED:wasapi:44100\n');
      process.emit('close', 0);
    }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'incomplete_preview');
});

test('early successful exit with a progress marker is not a completed preview', async () => {
  const child = fake_child();
  const result = await play_preview(audio_url, {
    spawn_impl: fake_spawn(child, (process) => {
      process.stdout.emit('data', 'DSH_AUDIO_PROGRESS:0.3:wasapi:44100\n');
      process.emit('close', 0);
    }),
  });
  assert.equal(result.reason, 'incomplete_preview');
});

test('null audio output never counts as audible playback', async () => {
  const child = fake_child();
  const result = await play_preview(audio_url, {
    spawn_impl: fake_spawn(child, (process) => {
      process.stdout.emit('data', 'DSH_AUDIO_STARTED:null:44100\nDSH_AUDIO_PROGRESS:30:null:44100\n');
      process.emit('close', 0);
    }),
  });
  assert.equal(result.reason, 'no_playback_evidence');
});

test('successful preview requires real audio output and sufficient progress/time', async () => {
  const child = fake_child();
  const result = await play_preview(audio_url, {
    preview_seconds: 1,
    spawn_impl: fake_spawn(child, (process) => {
      process.stdout.emit('data', 'DSH_AUDIO_STARTED:wasapi:44100\n');
      setTimeout(() => {
        // A marker may span output chunks.
        process.stdout.emit('data', 'DSH_AUDIO_PRO');
        process.stdout.emit('data', 'GRESS:0.95:wasapi:44100\n');
        process.emit('close', 0);
      }, 950);
    }),
  });
  assert.equal(result.status, 'played');
  assert.ok(result.elapsed_seconds >= 0.8 && result.elapsed_seconds <= 1);
});

test('nonzero process exit does not count as played even with progress', async () => {
  const child = fake_child();
  const result = await play_preview(audio_url, {
    spawn_impl: fake_spawn(child, (process) => {
      process.stderr.emit('data', 'DSH_AUDIO_PROGRESS:30:wasapi:44100\nhttps://private');
      process.emit('close', 1);
    }),
  });
  assert.equal(result.reason, 'player_error');
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('cancellation terminates the process and reports failure', async () => {
  const controller = new AbortController();
  const child = fake_child();
  const pending = play_preview(audio_url, {
    signal: controller.signal,
    spawn_impl: fake_spawn(child, () => controller.abort()),
  });
  const result = await pending;
  assert.equal(result.reason, 'aborted');
  assert.deepEqual(child.kill_calls, ['SIGKILL']);
});

test('timeout terminates the player', async () => {
  const child = fake_child();
  const result = await play_preview(audio_url, { timeout_ms: 10, spawn_impl: fake_spawn(child) });
  assert.equal(result.reason, 'timeout');
  assert.deepEqual(child.kill_calls, ['SIGKILL']);
});

test('already aborted or invalid settings do not start playback', async () => {
  const signal = AbortSignal.abort();
  assert.equal((await play_preview(audio_url, {
    signal, spawn_impl: () => assert.fail('spawned'),
  })).reason, 'aborted');
  assert.equal((await play_preview(audio_url, {
    preview_seconds: -1, spawn_impl: () => assert.fail('spawned'),
  })).reason, 'invalid_options');
});

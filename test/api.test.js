import test from 'node:test';
import assert from 'node:assert/strict';
import { NeteaseApi } from '../src/netease_api.js';

test('API unwraps library responses and sends credentials only to the private adapter', async () => {
  let captured;
  const api = new NeteaseApi({ cookie: 'MUSIC_U=private', api_module: { recommend_songs: async args => {
    captured = args;
    return { status: 200, body: { code: 200, data: { dailySongs: [{ id: 1 }] } }, cookie: ['secret-wrapper-cookie'] };
  } } });
  const body = await api.call('/recommend/songs', { cookie: 'untrusted', unblock: true });
  assert.equal(captured.cookie, 'MUSIC_U=private');
  assert.equal(captured.unblock, undefined);
  assert.deepEqual(body.data.dailySongs, [{ id: 1 }]);
  assert.equal(JSON.stringify(body).includes('secret-wrapper-cookie'), false);
});

test('QR state codes are domain values while expired credentials cause actionable errors', async () => {
  for (const code of [800, 801, 802, 803]) {
    const api = new NeteaseApi({ api_module: { login_qr_check: async () => ({ status: 200, body: { code } }) } });
    assert.equal((await api.call('login_qr_check')).code, code);
  }
  const api = new NeteaseApi({ api_module: { recommend_songs: async () => ({ status: 200, body: { code: 301, message: 'MUSIC_U=secret' } }) } });
  await assert.rejects(api.call('recommend_songs'), error => error.code === 'AUTH_REQUIRED' && !error.message.includes('secret'));
});

test('request exceptions cannot leak upstream credentials', async () => {
  const api = new NeteaseApi({ api_module: { lyric: async () => { throw new Error('MUSIC_U=secret; __csrf=secret'); } } });
  await assert.rejects(api.call('lyric'), error => error.code === 'NETWORK_FAILED' && !error.message.includes('secret'));
  await assert.rejects(api.call('playlist_tracks'), error => error.code === 'UNKNOWN_ROUTE');
});

test('a hanging request can time out or be cancelled', async () => {
  const api_module = { lyric: () => new Promise(() => {}) };
  await assert.rejects(new NeteaseApi({ api_module, timeout_ms: 10 }).call('lyric'), error => error.code === 'TIMEOUT');
  const controller = new AbortController();
  const request = new NeteaseApi({ api_module }).call('lyric', {}, controller.signal);
  controller.abort();
  await assert.rejects(request, error => error.name === 'AbortError');
  await assert.rejects(new NeteaseApi({ api_module }).call('lyric', {}, controller.signal), error => error.name === 'AbortError');
});

test('the real isolated dependency generates a QR code without network or account access', async () => {
  const body = await new NeteaseApi().call('login_qr_create', { key: 'offline-test-key', qrimg: true, platform: 'web' });
  assert.match(body.data.qrimg, /^data:image\/png;base64,/);
  assert.match(body.data.qrurl, /offline-test-key/);
});

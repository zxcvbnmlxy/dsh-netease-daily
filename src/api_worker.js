// Isolated process: NetEase's own logging is discarded by the parent stdio settings.
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const routes = new Set(['login_qr_key', 'login_qr_create', 'login_qr_check', 'login_status', 'recommend_songs', 'lyric', 'song_url_v1']);

// song_url_v1 encrypts with xeapi, which needs a public key the upstream package
// normally fetches during its own server start-up. Direct library use skips that
// step, so run that bootstrap once when the cache is missing; other routes and
// failures are unaffected, and caller errors stay bounded as before.
async function ensure_xeapi_public_key() {
  const key_path = resolve(tmpdir(), 'xeapi_public_key');
  if (existsSync(key_path)) return;
  try {
    const generate_config = (await import('@neteasecloudmusicapienhanced/api/generateConfig.js')).default;
    await generate_config();
  } catch { /* song_url_v1 then reports the same bounded API error as before. */ }
}

process.once('message', async message => {
  const send = payload => { if (process.connected) process.send(payload, () => process.exit(0)); else process.exit(0); };
  if (!routes.has(message?.route)) { send({ ok: false }); return; }
  try {
    if (message.route === 'song_url_v1') await ensure_xeapi_public_key();
    const api = (await import('@neteasecloudmusicapienhanced/api')).default;
    const response = await api[message.route]({ ...message.args, cookie: message.cookie || '', unblock: false });
    send({ ok: true, response: { status: response.status, body: response.body } });
  } catch (error) {
    const dependency_missing = error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND';
    // Exclude upstream messages/stack traces/Set-Cookie from errors.
    send({ ok: false, dependency_missing, ...(error?.body ? { response: { status: Number(error.status) || 500, body: { code: Number(error.body.code) || 500 } } } : {}) });
  }
});
process.once('disconnect', () => process.exit(0));

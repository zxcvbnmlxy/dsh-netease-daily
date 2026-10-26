import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const routes = new Set(['login_qr_key', 'login_qr_create', 'login_qr_check', 'login_status', 'recommend_songs', 'lyric', 'song_url_v1']);

function api_error(code, message) { return Object.assign(new Error(message), { code }); }
function abort_error() { return Object.assign(new Error('网易云请求已取消。'), { name: 'AbortError', code: 'ABORT_ERR' }); }

function unwrap(response, route) {
  const body = response?.body;
  const status = Number(response?.status ?? 200);
  const code = Number(body?.code ?? 200);
  if (code === 301 || status === 301) throw api_error('AUTH_REQUIRED', '网易云登录已失效，请重新扫码登录。');
  if (status === 429 || [429, 405, 460].includes(code)) throw api_error('RATE_LIMITED', '网易云暂时限制了请求，请稍后重试。');
  const qr_state = route === 'login_qr_check' && [800, 801, 802, 803].includes(code);
  if (!body || typeof body !== 'object' || status < 200 || status >= 300 || (!qr_state && code !== 200)) {
    throw api_error('API_FAILED', '网易云接口暂不可用，请检查网络或登录状态后重试。');
  }
  return body;
}

/** Real requests run in a disposable worker: upstream console logs never reach Harness. */
export class NeteaseApi {
  constructor({ cookie = '', timeout_ms = 20_000, api_module } = {}) {
    if (!Number.isInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 120_000) throw new Error('网易云请求超时应为 1 到 120000 毫秒。');
    this.cookie = cookie;
    this.timeout_ms = timeout_ms;
    this.api_module = api_module;
  }

  async call(route, args = {}, signal) {
    route = String(route).replace(/^\//, '').replaceAll('/', '_');
    if (!routes.has(route)) throw api_error('UNKNOWN_ROUTE', '插件不支持这个网易云接口。');
    if (signal?.aborted) throw abort_error();
    const safe_args = { ...args };
    delete safe_args.cookie;
    delete safe_args.unblock;
    const response = this.api_module
      ? await this.call_fake(route, safe_args, signal)
      : await this.call_worker(route, safe_args, signal);
    return unwrap(response, route);
  }

  call_worker(route, args, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let child;
      let timer;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', on_abort);
        if (child) {
          try { if (child.connected) child.disconnect(); } catch {}
          child.kill();
        }
        if (error) reject(error); else resolve(response);
      };
      const on_abort = () => finish(abort_error());
      try {
        child = fork(fileURLToPath(new URL('./api_worker.js', import.meta.url)), [], {
          execArgv: [],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
        child.once('error', () => finish(api_error('WORKER_FAILED', '网易云请求进程启动失败，请重新加载插件。')));
        child.once('exit', () => finish(api_error('WORKER_FAILED', '网易云请求进程意外退出，请稍后重试。')));
        child.on('message', message => {
          if (message?.ok) finish(null, message.response);
          else if (message?.dependency_missing) finish(api_error('DEPENDENCY_MISSING', '网易云依赖未安装，请在插件目录运行 npm ci --ignore-scripts。'));
          else if (message?.response) finish(null, message.response);
          else finish(api_error('NETWORK_FAILED', '网易云请求失败，请检查网络后重试。'));
        });
        timer = setTimeout(() => finish(api_error('TIMEOUT', '网易云请求超时，请稍后重试。')), this.timeout_ms);
        signal?.addEventListener('abort', on_abort, { once: true });
        if (signal?.aborted) { on_abort(); return; }
        // Credentials travel over local IPC, never through argv, env, stdout or stderr.
        child.send({ route, args, cookie: this.cookie }, error => {
          if (error) finish(api_error('WORKER_FAILED', '网易云请求进程通信失败，请稍后重试。'));
        });
      } catch { finish(api_error('WORKER_FAILED', '网易云请求进程启动失败，请重新加载插件。')); }
    });
  }

  // Injection is reserved for controlled unit-test adapters; production always uses the worker.
  call_fake(route, args, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', on_abort);
        if (error) reject(error); else resolve(response);
      };
      const on_abort = () => finish(abort_error());
      timer = setTimeout(() => finish(api_error('TIMEOUT', '网易云请求超时，请稍后重试。')), this.timeout_ms);
      signal?.addEventListener('abort', on_abort, { once: true });
      Promise.resolve().then(() => this.api_module[route]({ ...args, cookie: this.cookie }))
        .then(response => finish(null, response), () => finish(api_error('NETWORK_FAILED', '网易云请求失败，请检查网络后重试。')));
    });
  }
}

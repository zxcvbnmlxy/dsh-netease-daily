import http from 'node:http';

/**
 * 通过网易云客户端的本地调试通道（Chromium DevTools Protocol）控制播放。
 *
 * 背景：客户端 3.1.42 不响应 `orpheus://song/<id>` 深链（实测手动粘贴也不播放），
 * 但它以 Electron/CEF 运行，带 `--remote-debugging-port` 启动时会开放 127.0.0.1 的 CDP。
 * 这里用 CDP 驱动客户端自己的搜索框和「播放」按钮，效果等同于用户在客户端里点歌。
 *
 * 只在本机回环地址通信，不发送任何账号凭证。
 */

export const DEFAULT_PORT = 9223;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function get_json(url, timeout_ms = 2500) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
    });
    request.setTimeout(timeout_ms, () => { request.destroy(new Error('timeout')); });
    request.on('error', reject);
  });
}

/** 探测调试端口；返回当前页面 target 或 null。 */
export async function probe(port = DEFAULT_PORT) {
  try {
    const targets = await get_json(`http://127.0.0.1:${port}/json/list`);
    if (!Array.isArray(targets)) return null;
    return targets.find(target => target.type === 'page' && String(target.url).includes('orpheus')) ?? targets.find(target => target.type === 'page') ?? null;
  } catch {
    return null;
  }
}

async function connect(ws_url) {
  const ws = new WebSocket(ws_url);
  let next_id = 1;
  const pending = new Map();
  ws.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); };
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next_id++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, 8000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    async evaluate(expression) {
      const message = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      const result = message.result?.result;
      if (result?.subtype === 'error' || message.result?.exceptionDetails) return undefined;
      return result?.value ?? result?.description;
    },
    input(method, params) { return send(method, params); },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

/** 在客户端里搜索并点击播放；成功返回 true。 */
export async function play_by_name({ name, artist = '', port = DEFAULT_PORT }) {
  const page = await probe(port);
  if (!page) return { ok: false, reason: 'NO_DEBUG_CHANNEL' };
  const client = await connect(page.webSocketDebuggerUrl);
  const label = [name, artist].filter(Boolean).join(' ');
  try {
    // 冷启动时页面可能还没渲染出搜索框，先等它就绪（最多 8 秒）
    let ready = false;
    for (let i = 0; i < 20; i += 1) {
      ready = Boolean(await client.evaluate(`Boolean(document.querySelector('input.cmd-input'))`));
      if (ready) break;
      await sleep(400);
    }
    if (!ready) return { ok: false, reason: 'NOT_READY' };
    const before = await client.evaluate('localStorage.getItem("lastPlaying")');
    const filled = await client.evaluate(`(() => {
      const input = document.querySelector('input.cmd-input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(label)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return true;
    })()`);
    if (!filled) return { ok: false, reason: 'NO_SEARCH_BOX' };
    for (const type of ['keyDown', 'keyUp']) {
      await client.input('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
    // 等搜索结果里出现歌名，并且出现可点击的「播放」按钮
    let found = false;
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      const state = await client.evaluate(`(() => {
        const text = document.body.innerText || '';
        const buttons = [...document.querySelectorAll('*')].filter(element =>
          element.children.length === 0 && (element.textContent || '').trim() === '播放' &&
          !element.closest('[class*=PlayerContainer]') && element.getBoundingClientRect().width > 0);
        return { hasName: text.includes(${JSON.stringify(name)}), hasButton: buttons.length > 0 };
      })()`);
      if (state?.hasName) found = true;
      if (state?.hasName && state?.hasButton) break;
    }
    const wait_changed = async (limit) => {
      for (let i = 0; i < limit; i += 1) {
        await sleep(300);
        const after = await client.evaluate('localStorage.getItem("lastPlaying")');
        if (before !== after) return true;
      }
      return false;
    };
    // 首选 JS 点击（快）；点完确认没有切换播放再用真实鼠标兜底
    const clicked = Boolean(await client.evaluate(`(() => {
      const button = [...document.querySelectorAll('*')].find(element =>
        element.children.length === 0 && (element.textContent || '').trim() === '播放' &&
        !element.closest('[class*=PlayerContainer]') && element.getBoundingClientRect().width > 0);
      if (!button) return false;
      button.click();
      return true;
    })()`));
    let changed = clicked ? await wait_changed(6) : false; // 最多 1.8 秒
    if (!changed) {
      const box = await client.evaluate(`(() => {
        const button = [...document.querySelectorAll('*')].find(element =>
          element.children.length === 0 && (element.textContent || '').trim() === '播放' &&
          !element.closest('[class*=PlayerContainer]') && element.getBoundingClientRect().width > 0);
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      if (box) {
        await client.input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
        await client.input('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
        await client.input('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
        changed = await wait_changed(10);
      }
    }
    return { ok: clicked || changed, found, changed, clicked };
  } finally {
    client.close();
  }
}

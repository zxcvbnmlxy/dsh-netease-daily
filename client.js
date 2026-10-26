/**
 * dsh-netease-daily — 设置页面板（浏览器半侧）。
 *
 * client bundle 不是 ESM，而是自注册脚本：window.__ModuleLoader__.load({ id, factory })。
 * id 必须等于 package.json 的 name，漏注册会报 "loaded without registering dsh-netease-daily"。
 * 配置读写走宿主插件自己的 HTTP 接口 /api/netease-daily（与设置页同源）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-netease-daily',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const API = '/api/netease-daily';
    const asJson = async (response) => {
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
      if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
      return data;
    };
    const jget = (path) => fetch(API + path, { credentials: 'same-origin' }).then(asJson);
    const jpost = (path, body) => fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).then(asJson);

    const CSS = `
[data-nd-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 10px;max-width:680px;font-size:13px;color:var(--dsw-alias-label-primary)}
[data-nd-card]{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1,transparent)}
[data-nd-h]{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}
[data-nd-sec]{display:flex;flex-direction:column;gap:8px}
[data-nd-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
[data-nd-label]{font-size:13px;min-width:96px}
[data-nd-note]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}
[data-nd-input]{flex:1;min-width:180px;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;font:inherit}
[data-nd-textarea]{width:100%;min-height:74px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;font:inherit;resize:vertical}
[data-nd-btn]{padding:7px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;font:inherit;cursor:pointer}
[data-nd-btn][disabled]{opacity:.5;cursor:default}
[data-nd-btn][data-primary]{background:var(--dsw-alias-accent-bg,#3b6ef6);border-color:transparent;color:#fff}
[data-nd-badge]{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:11px}
[data-nd-ok]{background:rgba(52,168,83,.14);color:#2e9e50}
[data-nd-err]{background:rgba(217,48,37,.14);color:#d93025}
[data-nd-warn]{background:rgba(240,160,0,.16);color:#b26b00}
[data-nd-msg]{padding:8px 12px;border-radius:8px;font-size:12px;line-height:18px}
[data-nd-msg][data-kind=ok]{background:rgba(52,168,83,.12);color:#2e9e50}
[data-nd-msg][data-kind=err]{background:rgba(217,48,37,.12);color:#d93025}
[data-nd-qr]{width:190px;height:190px;border-radius:10px;background:#fff;padding:8px;border:1px solid rgba(128,128,128,.25)}
[data-nd-grid]{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}
`;

    const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    const INPUT = { 'data-nd-input': '' };

    function Badge({ ok, text }) {
      const style = ok
        ? { background: 'rgba(52,168,83,.14)', color: '#2e9e50' }
        : { background: 'rgba(217,48,37,.14)', color: '#d93025' };
      return h('span', { 'data-nd-badge': '', style }, `${ok ? '✓' : '!'} ${text}`);
    }

    function Panel() {
      const [state, setState] = React.useState(null);
      const [form, setForm] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [message, setMessage] = React.useState(null);
      const [qrUrl, setQrUrl] = React.useState('');
      const [depText, setDepText] = React.useState('');

      const applyState = (next) => {
        setState(next);
        // Only seed the form once: the 15s poll must not overwrite unsaved edits.
        setForm((current) => current ?? {
          enabled: next.settings.enabled,
          daily_time: next.settings.daily_time.slice(0, 5),
          time_zone: next.settings.time_zone,
          description: next.settings.description,
          preview_seconds: next.settings.preview_seconds,
          log_dir: next.settings.log_dir,
          player_path: next.settings.player_path,
        });
        if (next.dep) setDepText(next.dep.ready ? `${next.dep.version || 'mpv'}（${next.dep.path}）` : (next.dep.hint || '未就绪'));
      };

      const refresh = React.useCallback(async (silent) => {
        try {
          const next = await jget('/state');
          applyState(next);
        } catch (error) {
          if (!silent) setMessage({ kind: 'err', text: `读取失败：${error.message}` });
        }
      }, []);

      React.useEffect(() => {
        refresh(false);
        const timer = setInterval(() => refresh(true), 15000);
        return () => clearInterval(timer);
      }, [refresh]);

      const set = (key) => (event) => setForm({ ...form, [key]: event.target ? event.target.value : event });

      const action = async (name, call, okText) => {
        setBusy(name);
        setMessage(null);
        try {
          const result = await call();
          if (okText) setMessage({ kind: 'ok', text: okText });
          return result;
        } catch (error) {
          setMessage({ kind: 'err', text: error.message || String(error) });
          return null;
        } finally {
          setBusy('');
        }
      };

      const save = () => action('save', async () => {
        const result = await jpost('/settings', {
          enabled: Boolean(form.enabled),
          daily_time: form.daily_time,
          time_zone: form.time_zone,
          description: form.description,
          preview_seconds: num(form.preview_seconds, 30),
          log_dir: form.log_dir,
          player_path: form.player_path,
        });
        await refresh(true);
        if (result.schedule && result.schedule.error) throw new Error(`设置已保存，但任务同步失败：${result.schedule.error}`);
        return result;
      }, '设置已保存并立即生效。');

      const checkDep = () => action('dep', async () => {
        const result = await jpost('/deps/check', {});
        await refresh(true);
        return result;
      }, '依赖检测完成。');

      const installDep = () => action('install', async () => {
        const result = await jpost('/deps/install', {});
        await refresh(true);
        if (!result.ok) throw new Error(result.result?.message || '安装失败');
        return result;
      }, 'mpv 安装完成。');

      const loginStart = () => action('login', async () => {
        const result = await jpost('/login/start', {});
        setQrUrl(result.qr_url || '');
        return result;
      }, '二维码已生成，请用网易云 App 扫码。');

      const loginCheck = () => action('check', async () => {
        const result = await jpost('/login/check', {});
        await refresh(true);
        if (result.status === 'logged_in') setMessage({ kind: 'ok', text: '登录成功。' });
        else if (result.status === 'expired') throw new Error('二维码已过期，请重新生成。');
        else throw new Error(`尚未登录：${result.status === 'waiting_scan' ? '等待扫码' : result.status === 'waiting_confirmation' ? '等待手机确认' : result.status}`);
        return result;
      });

      const toggleSchedule = (enable) => action('schedule', async () => {
        const result = await jpost(enable ? '/schedule/enable' : '/schedule/disable', {});
        await refresh(true);
        return result;
      }, enable ? '每日任务已开启。' : '每日任务已停止。');

      if (!form || !state) {
        return h('div', { 'data-nd-page': '' }, h('div', { 'data-nd-note': '' }, '正在读取插件状态…'));
      }

      const status = state.status || {};
      const dep = state.dep || {};
      const log = state.log || {};
      const schedule = state.schedule || {};
      const badge = (ok, okText, errText) => h(Badge, { ok, text: ok ? okText : errText });

      return h('div', { 'data-nd-page': '' },

        h('div', { 'data-nd-card': '' },
          h('div', { 'data-nd-h': '' }, '每日听歌 · 状态'),
          h('div', { 'data-nd-grid': '' },
            h('div', null, badge(Boolean(status.logged_in), `已登录${status.nickname ? '：' + status.nickname : ''}`, '未登录')),
            h('div', null, badge(Boolean(dep.ready), 'mpv 就绪', 'mpv 未就绪')),
            h('div', null, badge(Boolean(log.ok), '日志目录可写', `日志目录不可写：${log.error || ''}`)),
            h('div', null, badge(Boolean(schedule.active), `任务已开启（${schedule.time || ''}）`, '任务未开启')),
            h('div', null, badge(Boolean(state.session_bound), '会话已绑定', '会话未绑定：先在对话里调用一次 netease_status')),
          ),
          status.message ? h('div', { 'data-nd-note': '' }, status.message) : null,
          h('div', { 'data-nd-note': '' }, `今日候选：${status.today_prepared ? '已准备' : '未准备'} · 已评价 ${status.today_evaluations || 0} 首 · 播放方式：静默（无声音输出）`),
        ),

        h('div', { 'data-nd-card': '' },
          h('div', { 'data-nd-h': '' }, '运行时间与描述'),
          h('div', { 'data-nd-row': '' },
            h('span', { 'data-nd-label': '' }, '每日运行时间'),
            h('input', { type: 'time', ...INPUT, value: form.daily_time, onChange: set('daily_time'), style: { maxWidth: '140px' } }),
            h('label', { 'data-nd-row': '' },
              h('input', { type: 'checkbox', checked: Boolean(form.enabled), onChange: (e) => setForm({ ...form, enabled: e.target.checked }) }),
              h('span', null, '启用每日任务'),
            ),
          ),
          h('div', { 'data-nd-note': '' }, `时区：${form.time_zone}（到点后由 Harness 的原生排程触发，需要 Harness 和电脑保持运行）`),
          h('div', { 'data-nd-sec': '' },
            h('span', { 'data-nd-label': '' }, '推荐描述'),
            h('textarea', {
              'data-nd-textarea': '', maxLength: 2000, value: form.description,
              placeholder: '例如：下雨天写代码，想要安静、有空间感的后摇，不要太吵',
              onChange: set('description'),
            }),
            h('div', { 'data-nd-note': '' }, 'AI 会按这段描述从每日推荐和搜索候选里挑歌；评价只基于歌曲资料与歌词，模型听不到音频。'),
          ),
        ),

        h('div', { 'data-nd-card': '' },
          h('div', { 'data-nd-h': '' }, '依赖与日志'),
          h('div', { 'data-nd-row': '' },
            h('span', { 'data-nd-label': '' }, 'mpv 状态'),
            h('span', { 'data-nd-grow': '', style: { flex: 1, minWidth: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#9aa0a6)' } }, depText || '未检测'),
            h('button', { 'data-nd-btn': '', disabled: busy === 'dep', onClick: checkDep }, busy === 'dep' ? '检测中…' : '重新检测'),
            h('button', { 'data-nd-btn': '', disabled: busy === 'install', onClick: installDep }, busy === 'install' ? '安装中…' : '安装 mpv'),
          ),
          h('div', { 'data-nd-row': '' },
            h('span', { 'data-nd-label': '' }, '播放器路径'),
            h('input', { ...INPUT, value: form.player_path, placeholder: '留空则自动查找（PATH / Program Files / 插件目录）', onChange: set('player_path') }),
          ),
          h('div', { 'data-nd-row': '' },
            h('span', { 'data-nd-label': '' }, '日志目录'),
            h('input', { ...INPUT, value: form.log_dir, onChange: set('log_dir') }),
          ),
          h('div', { 'data-nd-row': '' },
            h('span', { 'data-nd-label': '' }, '试听时长'),
            h('input', { ...INPUT, type: 'number', min: 5, max: 120, step: 5, value: form.preview_seconds, onChange: set('preview_seconds'), style: { maxWidth: '110px' } }),
            h('span', { 'data-nd-note': '' }, '秒（静默播放，不发出声音）'),
          ),
        ),

        h('div', { 'data-nd-card': '' },
          h('div', { 'data-nd-h': '' }, '扫码登录'),
          h('div', { 'data-nd-row': '' },
            h('button', { 'data-nd-btn': '', disabled: busy === 'login', onClick: loginStart }, busy === 'login' ? '生成中…' : '生成二维码'),
            h('button', { 'data-nd-btn': '', disabled: busy === 'check', onClick: loginCheck }, busy === 'check' ? '检查中…' : '检查登录结果'),
          ),
          qrUrl ? h('div', { 'data-nd-sec': '' }, h('img', { 'data-nd-qr': '', src: qrUrl, alt: '网易云登录二维码' }), h('div', { 'data-nd-note': '' }, '二维码约两分钟失效；确认后点“检查登录结果”。')) : null,
          h('div', { 'data-nd-note': '' }, status.logged_in ? `当前账号：${status.nickname || '已登录'}，凭证只保存在本机。` : '未登录时每日任务会直接报告失败，不会静默跳过。'),
        ),

        h('div', { 'data-nd-card': '' },
          h('div', { 'data-nd-h': '' }, '任务'),
          h('div', { 'data-nd-row': '' },
            h('button', { 'data-nd-btn': '', 'data-primary': '', disabled: busy === 'save', onClick: save }, busy === 'save' ? '保存中…' : '保存设置'),
            h('button', { 'data-nd-btn': '', disabled: busy === 'schedule' || !state.session_bound, onClick: () => toggleSchedule(!schedule.active) }, schedule.active ? '停止每日任务' : '开启每日任务'),
            h('button', { 'data-nd-btn': '', disabled: busy !== '', onClick: () => refresh(false) }, '刷新状态'),
          ),
          h('div', { 'data-nd-note': '' }, `日志写入：${form.log_dir}（events.jsonl + 每日 YYYY-MM-DD.md）`),
          h('div', { 'data-nd-note': '' }, `下次运行：${schedule.next || '—'} · 任务 ID：${schedule.id || '—'}`),
        ),

        message ? h('div', { 'data-nd-msg': '', 'data-kind': message.kind }, message.text) : null,

        h('div', { 'data-nd-note': '' }, '所有可变项都在这里配置，立即生效并保存到本机；重启 Harness 后仍然保留。'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style');
        style.setAttribute('data-plugin-css', 'dsh-netease-daily');
        style.textContent = CSS;
        document.head.appendChild(style);
        ctx.effect(() => () => style.remove(), 'dsh-netease-daily: settings styles');

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
        if (!slots) return;
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'netease-daily', order: 36, label: '每日听歌' },
          () => h(Panel),
        ));
      },
    };
  },
});

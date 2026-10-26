import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { NeteaseApi } from './netease_api.js';
import { play_silent, silent_player_reasons } from './silent_player.js';
import { local_day, markdown_text } from './logger.js';

export const default_data_dir = () => process.env.DSH_NETEASE_DATA_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'netease-daily');

export function local_date(now = new Date(), time_zone = 'Asia/Shanghai') {
  return local_day(now, time_zone);
}

export async function write_private(path, content) {
  const temporary_path = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary_path, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary_path, path);
}

async function read_json(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error('本地音乐数据无法读取，请先备份数据目录并检查 JSON 文件。');
  }
}

function valid_id(value) {
  const id = String(value);
  if (!/^[1-9]\d{0,16}$/.test(id)) throw new Error('歌曲 ID 必须是正整数。');
  return id;
}

function normalize_song(song, source_reason = '来自网易云') {
  const id = valid_id(song.id);
  return {
    id,
    name: String(song.name || '未知歌曲').slice(0, 200),
    artists: (song.ar || song.artists || []).map(artist => String(artist.name || '')).filter(Boolean).slice(0, 10),
    album: String((song.al || song.album || {}).name || '').slice(0, 200),
    duration_seconds: Math.max(0, Math.round(Number(song.dt || song.duration || 0) / 1000) || 0),
    url: `https://music.163.com/#/song?id=${id}`,
    source_reason,
    lyric_excerpt: '',
  };
}

/** All account credentials stay in credentials.json; every run writes into the configured log dir. */
export class MusicService {
  constructor({ data_dir = default_data_dir(), preview_seconds = 30, player_path = '', volume = 0,
    avoid_days = 14, time_zone = 'Asia/Shanghai', api_factory, player = play_silent, now = () => new Date(),
    get_settings = null, get_player_path = null, logger = null } = {}) {
    this.data_dir = resolve(data_dir);
    this.preview_seconds = preview_seconds;
    this.player_path = player_path;
    this.volume = volume;
    this.avoid_days = avoid_days;
    this.time_zone = time_zone;
    this.api_factory = api_factory || (cookie => new NeteaseApi({ cookie }));
    this.player = player;
    this.now = now;
    this.get_settings = get_settings;
    this.get_player_path = get_player_path;
    this.logger = logger;
    this.queue = Promise.resolve();
    this.qr_session = null;
    this.cache = new Map();
  }

  settings() {
    const values = this.get_settings?.() ?? {};
    return {
      preview_seconds: Number.isInteger(values.preview_seconds) ? values.preview_seconds : this.preview_seconds,
      player_path: values.player_path || this.get_player_path?.() || this.player_path,
      time_zone: values.time_zone || this.time_zone,
      description: typeof values.description === 'string' ? values.description : '',
    };
  }

  async exclusive(action) {
    const pending = this.queue.then(action);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async load() {
    await mkdir(this.data_dir, { recursive: true, mode: 0o700 });
    const state = await read_json(join(this.data_dir, 'history.json'), { version: 1, days: {}, preferences: {} });
    if (state.version !== 1 || !state.days || !state.preferences) throw new Error('本地音乐数据版本不支持，请保留数据并升级插件。');
    return state;
  }

  async persist(state) { await write_private(join(this.data_dir, 'history.json'), JSON.stringify(state, null, 2)); }
  async auth() { return read_json(join(this.data_dir, 'credentials.json'), {}); }
  async api() {
    const auth = await this.auth();
    if (!auth.cookie) throw Object.assign(new Error('尚未登录网易云。请在设置页扫码登录后再运行。'), { code: 'NOT_LOGGED_IN' });
    return this.api_factory(auth.cookie);
  }

  async cached(track) { if (track) this.cache.set(String(track.id), track); return track; }

  async status(signal) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const state = await this.load();
      const auth = await this.auth();
      const cfg = this.settings();
      const today = state.days[local_date(this.now(), cfg.time_zone)];
      const result = {
        has_credentials: Boolean(auth.cookie), logged_in: false, data_dir: this.data_dir,
        today_prepared: Boolean(today), today_completed: Boolean(today?.completed_at),
        today_evaluations: Object.keys(today?.evaluations ?? {}).length,
        preview_seconds: cfg.preview_seconds, player_path: cfg.player_path,
        silent_playback: true,
        log_dir: this.logger?.dir?.() ?? '',
      };
      if (!auth.cookie) { result.message = '尚未登录网易云，请在设置页扫码登录。'; return result; }
      try {
        const body = await this.api_factory(auth.cookie).call('login_status', {}, signal);
        const profile = body.data?.profile || body.profile;
        result.logged_in = Boolean(profile?.userId);
        if (result.logged_in) result.nickname = String(profile.nickname || '网易云用户');
        else result.message = '登录已失效，请重新扫码。';
      } catch { signal?.throwIfAborted(); result.message = '无法验证登录状态，请检查网络后重试。'; }
      return result;
    });
  }

  async login_start(signal) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      await this.load();
      const api = this.api_factory('');
      const key_body = await api.call('login_qr_key', { timestamp: Date.now() }, signal);
      const key = key_body.data?.unikey;
      if (!key) throw new Error('网易云没有返回扫码密钥，请稍后重试。');
      const qr_body = await api.call('login_qr_create', { key, qrimg: true, platform: 'web', timestamp: Date.now() }, signal);
      const qr = qr_body.data || {};
      if (typeof qr.qrimg !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(qr.qrimg) || qr.qrimg.length > 2_000_000) {
        throw new Error('网易云没有返回有效的扫码图片，请重试。');
      }
      const qr_path = join(this.data_dir, 'login-qr.png');
      await writeFile(qr_path, Buffer.from(qr.qrimg.split(',')[1], 'base64'), { mode: 0o600 });
      this.qr_session = { key, created_at: Date.now(), qr_image: qr.qrimg };
      try {
        const png = join(this.data_dir, 'login-qr.png');
        const data = await readFile(png);
        this.qr_session.qr_png = data;
      } catch {}
      return { status: 'waiting_scan', qr_path, expires_in_seconds: 180, message: '用网易云音乐 App 扫码并确认，然后回到设置页点“检查登录”。' };
    });
  }

  async login_check(signal) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      if (!this.qr_session || Date.now() - this.qr_session.created_at > 180_000) {
        this.qr_session = null;
        return { status: 'expired', message: '二维码已失效，请重新生成。' };
      }
      const body = await this.api_factory('').call('login_qr_check', { key: this.qr_session.key, timestamp: Date.now() }, signal);
      const statuses = { 800: 'expired', 801: 'waiting_scan', 802: 'waiting_confirmation' };
      if (body.code !== 803) {
        if (body.code === 800) this.qr_session = null;
        return { status: statuses[body.code] || 'failed' };
      }
      if (typeof body.cookie !== 'string' || !body.cookie.includes('MUSIC_U=')) throw new Error('登录确认没有返回有效登录信息，请重试。');
      await write_private(join(this.data_dir, 'credentials.json'), JSON.stringify({ cookie: body.cookie }, null, 2));
      this.qr_session = null;
      await this.logger?.event('login', { ok: true });
      return { status: 'logged_in', message: '已登录，凭证只保存在本机。' };
    });
  }

  /** Daily recommendations filtered by the usual de-duplication rules. */
  async prepare(signal) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const state = await this.load();
      const cfg = this.settings();
      const date = local_date(this.now(), cfg.time_zone);
      if (state.days[date]) return { ...state.days[date], recommendation_count: Math.min(3, state.days[date].tracks.length), cached: true };
      const api = await this.api();
      const body = await api.call('recommend_songs', {}, signal);
      const raw_songs = body.data?.dailySongs || body.recommend;
      if (!Array.isArray(raw_songs)) throw new Error('每日推荐返回格式异常，请确认账号登录状态。');
      const recent_ids = new Set(Object.entries(state.days)
        .filter(([day]) => { const days = (Date.parse(date) - Date.parse(day)) / 86_400_000; return days >= 0 && days < this.avoid_days; })
        .flatMap(([, day]) => (day.recommendations || []).map(song => song.id)));
      const unique = new Map();
      for (const song of raw_songs) {
        try {
          const track = normalize_song(song, '来自你的网易云每日推荐');
          if (!recent_ids.has(track.id) && state.preferences[track.id] !== 'dislike') unique.set(track.id, track);
        } catch { /* Ignore malformed track ids. */ }
      }
      const tracks = [...unique.values()].slice(0, 5);
      for (const track of tracks) await this.cached(track);
      const day = { date, created_at: this.now().toISOString(), source: '网易云每日推荐', tracks, recommendations: [], evaluations: {} };
      state.days[date] = day;
      await this.persist(state);
      return { ...day, recommendation_count: Math.min(3, tracks.length), cached: false };
    });
  }

  /** Text-driven search used when the user describes a mood or scene. */
  async search(keyword, limit, signal) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const text = String(keyword ?? '').trim();
      if (!text) throw new Error('搜索关键词不能为空。');
      const api = await this.api();
      const body = await api.call('cloudsearch', { keywords: text, type: 1, limit: Math.min(20, Math.max(1, Number(limit) || 8)) }, signal);
      const raw = body.result?.songs ?? body.data?.songs ?? [];
      if (!Array.isArray(raw)) throw new Error('搜索返回格式异常。');
      const tracks = [];
      for (const song of raw) {
        try { tracks.push(await this.cached(normalize_song(song, `搜索：${text}`))); } catch {}
      }
      return { keyword: text, tracks };
    });
  }

  /**
   * Candidate plan for one run: daily recommendations plus optional keyword hits
   * derived from the user's description. Lyrics are attached for the evaluation.
   */
  async plan(description, signal) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const cfg = this.settings();
      const state = await this.load();
      const date = local_date(this.now(), cfg.time_zone);
      const api = await this.api();
      const tracks = [];
      const seen = new Set();
      const push = track => { if (track && !seen.has(track.id)) { seen.add(track.id); tracks.push(track); } };

      const daily = state.days[date]?.tracks ?? [];
      for (const track of daily) push(track);
      if (!daily.length) {
        try {
          const body = await api.call('recommend_songs', {}, signal);
          for (const song of (body.data?.dailySongs ?? body.recommend ?? []).slice(0, 4)) {
            try { push(await this.cached(normalize_song(song, '来自你的网易云每日推荐'))); } catch {}
          }
        } catch (error) { signal?.throwIfAborted(); }
      }
      const text = String(description ?? cfg.description ?? '').trim();
      if (text) {
        try {
          const found = await api.call('cloudsearch', { keywords: text, type: 1, limit: 6 }, signal);
          for (const song of (found.result?.songs ?? found.data?.songs ?? [])) {
            try { push(await this.cached(normalize_song(song, `按描述搜索：${text}`))); } catch {}
          }
        } catch (error) { signal?.throwIfAborted(); throw error; }
      }
      const picked = tracks.slice(0, 6);
      const day = state.days[date] ?? (state.days[date] = { date, created_at: this.now().toISOString(), source: text ? '按描述推荐' : '网易云每日推荐', tracks: [], recommendations: [], evaluations: {} });
      const known = new Set((day.tracks ?? []).map(track => track.id));
      for (const track of picked) if (!known.has(track.id)) day.tracks.push(track);
      if (!day.source) day.source = text ? '按描述推荐' : '网易云每日推荐';
      await this.persist(state);
      for (const track of picked) {
        signal?.throwIfAborted();
        if (track.lyric_excerpt) continue;
        try {
          const lyrics = await api.call('lyric', { id: track.id }, signal);
          track.lyric_excerpt = String(lyrics.lrc?.lyric || '').replace(/\[[^\]]*\]/g, '').trim().slice(0, 400);
        } catch { track.lyric_note = '歌词暂不可用。'; }
        await this.cached(track);
      }
      return { date, description: text, tracks: picked, log_dir: this.logger?.dir?.() ?? '', silent: true };
    });
  }

  /** Silent playback of one candidate, with the evaluation metadata attached. */
  async listen(track_id, signal) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const id = valid_id(track_id);
      const cfg = this.settings();
      let track = this.cache.get(id);
      if (!track) {
        const state = await this.load();
        const date = local_date(this.now(), cfg.time_zone);
        track = state.days[date]?.tracks.find(song => song.id === id);
      }
      if (!track) {
        const api = await this.api();
        const body = await api.call('song_detail', { ids: id }, signal);
        const raw = body.songs?.[0];
        if (!raw) throw new Error('找不到这首歌，请先调用 netease_plan 或 netease_search 获取候选。');
        track = await this.cached(normalize_song(raw, '按歌曲 ID 查询'));
      }
      const api = await this.api();
      const body = await api.call('song_url_v1', { id, level: 'standard' }, signal);
      const audio = body.data?.find(item => String(item.id) === id);
      let playback;
      if (!audio?.url) playback = { status: 'unavailable', elapsed_seconds: 0, reason: '这首歌没有可用播放地址，可能有版权或会员限制。' };
      else {
        playback = await this.player(audio.url, { player_path: cfg.player_path, seconds: cfg.preview_seconds, signal });
        if (playback.reason && silent_player_reasons[playback.reason]) playback.reason = silent_player_reasons[playback.reason];
        if (audio.freeTrialInfo) playback.license_trial = true;
      }
      const record = { ...playback, attempted_at: this.now().toISOString(), silent: true, player_path: cfg.player_path };
      await this.logger?.event('playback', { track_id: id, name: track.name, status: record.status, elapsed_seconds: record.elapsed_seconds, silent: true });
      return { id, name: track.name, artists: track.artists, album: track.album, lyric_excerpt: track.lyric_excerpt ?? '', ...record };
    });
  }

  /** Store one AI evaluation into today's report, the event log and the local history. */
  async evaluate(track_id, rating, evaluation, signal) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const id = valid_id(track_id);
      const text = String(evaluation ?? '').trim();
      if (!text) throw new Error('评价内容不能为空。');
      if (text.length > 1200) throw new Error('评价最多 1200 字。');
      const score = rating === undefined || rating === null ? null : Number(rating);
      if (score !== null && (!Number.isFinite(score) || score < 1 || score > 5)) throw new Error('评分必须是 1 到 5。');
      const cfg = this.settings();
      const state = await this.load();
      const date = local_date(this.now(), cfg.time_zone);
      const track = this.cache.get(id) ?? state.days[date]?.tracks.find(song => song.id === id);
      const day = state.days[date] ?? (state.days[date] = { date, created_at: this.now().toISOString(), source: '按描述推荐', tracks: [], recommendations: [], evaluations: {} });
      const entry = { id, name: track?.name ?? id, artists: track?.artists ?? [], score, evaluation: text, at: this.now().toISOString(), silent_playback: true };
      day.evaluations = { ...(day.evaluations ?? {}), [id]: entry };
      await this.persist(state);
      let log_path = '';
      try {
        log_path = await this.logger.append_section(`听歌评价 · ${entry.name}${score === null ? '' : `（${score}/5）`}`, [
          `- 曲目：${markdown_text(entry.name)}${entry.artists.length ? ` — ${markdown_text(entry.artists.join(' / '))}` : ''}`,
          `- 歌曲链接：${track?.url ?? `https://music.163.com/#/song?id=${id}`}`,
          `- 播放方式：静默播放（ao=null，无音频输出），${cfg.preview_seconds} 秒`,
          '',
          text,
        ]);
        await this.logger.event('evaluation', { track_id: id, name: entry.name, score, chars: text.length, log_path });
      } catch (error) {
        await this.logger?.event('error', { where: 'evaluate', message: error?.message ?? String(error) });
        throw Object.assign(new Error(`评价已保存到本地历史，但写入日志目录失败：${error?.message ?? error}`), { code: 'LOG_WRITE_FAILED' });
      }
      return { ok: true, id, log_path, log_dir: this.logger.dir(), message: '评价已写入日志。' };
    });
  }

  async feedback(track_id, preference) {
    const id = valid_id(track_id);
    if (!['like', 'dislike', 'neutral'].includes(preference)) throw new Error('偏好必须是 like、dislike 或 neutral。');
    const state = await this.load();
    const known = Object.values(state.days).some(day => day.tracks.some(song => song.id === id));
    if (!known) throw new Error('只能为插件选过的歌曲记录偏好。');
    if (preference === 'neutral') delete state.preferences[id];
    else state.preferences[id] = preference;
    await this.persist(state);
    return { id, preference, message: '已保存到本机偏好；没有修改网易云收藏。' };
  }

  async save_recommendations(recommendations, signal) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const cfg = this.settings();
      const state = await this.load();
      const date = local_date(this.now(), cfg.time_zone);
      const day = state.days[date];
      if (!day?.tracks.length) throw new Error('请先准备今日候选歌曲。');
      if (day.completed_at) return { date, report_path: day.report_path, recommendations: day.recommendations, cached: true };
      const count = Math.min(3, day.tracks.length);
      if (!Array.isArray(recommendations) || recommendations.length !== count) throw new Error(`今天需要选出 ${count} 首歌曲。`);
      const ids = new Set();
      const cleaned = recommendations.map(item => {
        const id = valid_id(item.id);
        if (ids.has(id) || !day.tracks.some(track => track.id === id)) throw new Error('推荐歌曲必须来自今日候选且不能重复。');
        if (typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 500) throw new Error('推荐理由需要 1 到 500 个字符。');
        ids.add(id);
        return { id, reason: item.reason.trim() };
      });
      day.recommendations = cleaned;
      day.completed_at = this.now().toISOString();
      await this.persist(state);
      const body = [`- 日期：${date}`, `- 推荐依据：${markdown_text(cfg.description || '你的网易云每日推荐')}`, ''];
      for (const item of cleaned) {
        const track = day.tracks.find(song => song.id === item.id);
        body.push(`- [${markdown_text(track.name)}](${track.url}) — ${markdown_text(track.artists.join(' / '))}`, `  ${markdown_text(item.reason)}`, '');
      }
      try {
        const log_path = await this.logger.append_section('今日推荐', body);
        day.report_path = log_path;
        await this.persist(state);
        await this.logger.event('recommendation', { date, ids: cleaned.map(item => item.id), log_path });
        return { date, report_path: log_path, log_dir: this.logger.dir(), recommendations: cleaned, cached: false };
      } catch (error) {
        await this.logger?.event('error', { where: 'save', message: error?.message ?? String(error) });
        throw Object.assign(new Error(`推荐已记录，但写入日志目录失败：${error?.message ?? error}`), { code: 'LOG_WRITE_FAILED' });
      }
    });
  }
}

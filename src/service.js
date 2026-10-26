import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { NeteaseApi } from './netease_api.js';
import { play_preview } from './player.js';

export const default_data_dir = () => process.env.DSH_NETEASE_DATA_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'netease-daily');

export function local_date(now = new Date(), time_zone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: time_zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
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

function normalize_song(song) {
  const id = valid_id(song.id);
  return {
    id,
    name: String(song.name || '未知歌曲').slice(0, 200),
    artists: (song.ar || song.artists || []).map(artist => String(artist.name || '')).filter(Boolean).slice(0, 10),
    album: String((song.al || song.album || {}).name || '').slice(0, 200),
    duration_seconds: Math.max(0, Math.round(Number(song.dt || song.duration || 0) / 1000) || 0),
    url: `https://music.163.com/#/song?id=${id}`,
    source_reason: '来自你的网易云每日推荐',
    lyric_excerpt: '',
    playback: { status: 'not_attempted', elapsed_seconds: 0 },
  };
}

function markdown_text(value) { return String(value).replace(/[\\`*_[\]<>]/g, '\\$&').replace(/[\r\n]+/g, ' '); }

const playback_reasons = {
  player_not_found: '未找到 mpv 播放器，请安装播放器或检查配置路径。',
  player_error: '播放器未能播放这首歌。',
  invalid_url: '没有可用的安全播放地址。',
  invalid_options: '播放器配置无效，请检查试听时长和音量。',
  no_playback_evidence: '播放器未返回有效音频播放记录。',
  incomplete_preview: '播放提前结束，没有完成预定试听。',
  aborted: '试听已取消。',
  timeout: '播放器超时，试听已停止。',
};

/** All account credentials stay in credentials.json, never in tool results or reports. */
export class MusicService {
  constructor({ data_dir = default_data_dir(), preview_seconds = 30, player_path = 'mpv', volume = 25,
    avoid_days = 14, time_zone = 'Asia/Shanghai', api_factory, player = play_preview, now = () => new Date() } = {}) {
    this.data_dir = resolve(data_dir);
    this.preview_seconds = preview_seconds;
    this.player_path = player_path;
    this.volume = volume;
    this.avoid_days = avoid_days;
    this.time_zone = time_zone;
    this.api_factory = api_factory || (cookie => new NeteaseApi({ cookie }));
    this.player = player;
    this.now = now;
    this.queue = Promise.resolve();
    this.qr_session = null;
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
    if (!auth.cookie) throw new Error('尚未登录网易云。请先调用 netease_login_start 扫码，再调用 netease_login_check。');
    return this.api_factory(auth.cookie);
  }

  async status(signal) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const state = await this.load();
      const auth = await this.auth();
      const today = state.days[local_date(this.now(), this.time_zone)];
      const result = {
        has_credentials: Boolean(auth.cookie), logged_in: false, data_dir: this.data_dir,
        today_prepared: Boolean(today), today_completed: Boolean(today?.completed_at),
        preview_seconds: this.preview_seconds, player_path: this.player_path,
      };
      if (!auth.cookie) return result;
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
      return { status: 'waiting_scan', qr_path, message: '用网易云音乐 App 扫码并确认，然后调用 netease_login_check。二维码约两分钟失效。' };
    });
  }

  async login_check(signal) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      if (!this.qr_session || Date.now() - this.qr_session.created_at > 180_000) {
        this.qr_session = null;
        return { status: 'expired', message: '二维码已失效，请重新调用 netease_login_start。' };
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
      return { status: 'logged_in', message: '已登录，凭证只保存在本机。可以启用每天 21:00 的音乐任务了。' };
    });
  }

  async prepare(signal) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const state = await this.load();
      const date = local_date(this.now(), this.time_zone);
      if (state.days[date]) return { ...state.days[date], recommendation_count: Math.min(3, state.days[date].tracks.length), cached: true };
      const api = await this.api();
      const body = await api.call('recommend_songs', {}, signal);
      const raw_songs = body.data?.dailySongs || body.recommend;
      if (!Array.isArray(raw_songs)) throw new Error('每日推荐返回格式异常，请确认账号登录状态。');
      const recent_ids = new Set(Object.entries(state.days)
        .filter(([day]) => { const days = (Date.parse(date) - Date.parse(day)) / 86_400_000; return days >= 0 && days < this.avoid_days; })
        .flatMap(([, day]) => (day.recommendations || []).map(song => song.id)));
      const liked_artists = new Set(Object.entries(state.preferences).filter(([, preference]) => preference === 'like')
        .flatMap(([id]) => Object.values(state.days).flatMap(day => day.tracks.filter(track => track.id === id).flatMap(track => track.artists))));
      const unique = new Map();
      for (const song of raw_songs) {
        try {
          const track = normalize_song(song);
          if (!recent_ids.has(track.id) && state.preferences[track.id] !== 'dislike') unique.set(track.id, track);
        } catch { /* Ignore malformed track ids, rather than generating invalid links. */ }
      }
      const candidates = [...unique.values()].sort((left, right) =>
        Number(right.artists.some(artist => liked_artists.has(artist))) - Number(left.artists.some(artist => liked_artists.has(artist))));
      const tracks = [];
      const used_artists = new Set();
      for (const track of candidates) {
        if (tracks.length >= 5) break;
        if (track.artists.length && track.artists.some(artist => used_artists.has(artist))) continue;
        tracks.push(track);
        track.artists.forEach(artist => used_artists.add(artist));
      }
      for (const track of candidates) {
        if (tracks.length >= 5) break;
        if (!tracks.some(selected => selected.id === track.id)) tracks.push(track);
      }
      if (!tracks.length) return { date, tracks: [], recommendation_count: 0, message: '今日没有符合去重和偏好条件的新歌，未生成空日报。' };
      for (const track of tracks) {
        signal?.throwIfAborted();
        try {
          const lyrics = await api.call('lyric', { id: track.id }, signal);
          track.lyric_excerpt = String(lyrics.lrc?.lyric || '').replace(/\[[^\]]*\]/g, '').trim().slice(0, 400);
        } catch (error) {
          signal?.throwIfAborted();
          track.lyric_note = '歌词暂不可用，请只依据已返回的歌曲信息推荐。';
        }
      }
      signal?.throwIfAborted();
      const day = { date, created_at: this.now().toISOString(), source: '网易云每日推荐', tracks, recommendations: [] };
      state.days[date] = day;
      await this.persist(state);
      return { ...day, recommendation_count: Math.min(3, tracks.length), cached: false };
    });
  }

  async preview(track_id, signal) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const id = valid_id(track_id);
      const state = await this.load();
      const date = local_date(this.now(), this.time_zone);
      const track = state.days[date]?.tracks.find(song => song.id === id);
      if (!track) throw new Error('请先准备今日候选歌曲，然后只试听候选歌曲 ID。');
      if (track.playback.status === 'played') return { id, ...track.playback, cached: true };
      const api = await this.api();
      const body = await api.call('song_url_v1', { id, level: 'standard' }, signal);
      const audio = body.data?.find(item => String(item.id) === id);
      let playback;
      if (!audio?.url) playback = { status: 'unavailable', elapsed_seconds: 0, reason: '歌曲没有可用播放地址，可能有版权或会员限制。' };
      else {
        playback = await this.player(audio.url, { player_path: this.player_path, preview_seconds: this.preview_seconds, volume: this.volume, signal });
        if (playback_reasons[playback.reason]) playback = { ...playback, reason: playback_reasons[playback.reason] };
        if (audio.freeTrialInfo) playback.license_trial = true;
      }
      track.playback = { ...playback, attempted_at: this.now().toISOString() };
      await this.persist(state);
      return { id, ...track.playback };
    });
  }

  async feedback(track_id, preference) {
    return this.exclusive(async () => {
      const id = valid_id(track_id);
      if (!['like', 'dislike', 'neutral'].includes(preference)) throw new Error('偏好必须是 like、dislike 或 neutral。');
      const state = await this.load();
      if (!Object.values(state.days).some(day => day.tracks.some(song => song.id === id))) throw new Error('只能为插件选过的歌曲记录偏好。');
      if (preference === 'neutral') delete state.preferences[id];
      else state.preferences[id] = preference;
      await this.persist(state);
      return { id, preference, message: '已保存到本机偏好；没有修改网易云收藏。' };
    });
  }

  async save_recommendations(recommendations, signal) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const state = await this.load();
      const date = local_date(this.now(), this.time_zone);
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
      const report_path = join(this.data_dir, 'reports', `${date}.md`);
      await mkdir(join(this.data_dir, 'reports'), { recursive: true, mode: 0o700 });
      const lines = [`# ${date} · 每日听歌推荐`, '', '来源：网易云每日推荐。推荐基于歌曲资料、可用歌词和本地偏好。播放器试听不代表模型理解了音频。', ''];
      for (const item of cleaned) {
        const track = day.tracks.find(song => song.id === item.id);
        lines.push(`- [${markdown_text(track.name)}](${track.url}) — ${markdown_text(track.artists.join(' / '))}`, `  ${markdown_text(item.reason)}`, '');
      }
      lines.push('## 试听记录', '');
      for (const track of day.tracks) {
        const playback = track.playback;
        const playback_text = playback.status === 'played' ? `已播放约 ${playback.elapsed_seconds} 秒` : `未完成试听：${playback.reason || '没有运行播放器'}`;
        lines.push(`- ${markdown_text(track.name)}：${markdown_text(playback_text)}${playback.license_trial ? '（平台试听片段）' : ''}`);
      }
      await write_private(report_path, `${lines.join('\n')}\n`);
      day.recommendations = cleaned;
      day.completed_at = this.now().toISOString();
      day.report_path = report_path;
      await this.persist(state);
      return { date, report_path, recommendations: cleaned, cached: false };
    });
  }
}

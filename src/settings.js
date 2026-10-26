import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/** Defaults live here and nowhere else; the settings panel overrides every one of them. */
export function default_settings(data_dir) {
  return {
    version: 1,
    enabled: true,
    daily_time: '21:00:00',
    time_zone: DEFAULT_TIME_ZONE,
    description: '',
    preview_seconds: 30,
    log_dir: join(data_dir, 'logs'),
    player_path: '',
    session_id: '',
    schedule_id: '',
  };
}

function invalid(message, code = 'INVALID_SETTINGS') {
  return Object.assign(new Error(message), { code });
}

export function normalize_time(value) {
  if (typeof value !== 'string') throw invalid('运行时间必须是 HH:MM 或 HH:MM:SS。');
  const match = value.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) throw invalid('运行时间必须是 HH:MM 或 HH:MM:SS，例如 21:00。');
  return `${match[1].padStart(2, '0')}:${match[2]}:${match[3] ?? '00'}`;
}

export function normalize_time_zone(value) {
  const zone = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format();
  } catch {
    throw invalid(`时区不可用：${zone}`);
  }
  return zone;
}

/** Probe that a directory can be created and written; returns the resolved absolute path. */
export async function ensure_writable_dir(dir) {
  const target = resolve(dir);
  try {
    await mkdir(target, { recursive: true });
    const probe = join(target, `.write-probe-${process.pid}-${Date.now()}`);
    await writeFile(probe, 'ok', 'utf8');
    await access(probe);
    await import('node:fs/promises').then(fs => fs.rm(probe, { force: true }));
    return target;
  } catch (error) {
    throw invalid(`日志目录不可写：${target}（${error?.code || error?.message || 'error'}）`, 'LOG_DIR_UNWRITABLE');
  }
}

/** Patch validation: unknown keys rejected, every accepted field normalized. */
export function sanitize_patch(patch, current) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('设置必须是对象。');
  const allowed = ['enabled', 'daily_time', 'time_zone', 'description', 'preview_seconds', 'log_dir', 'player_path'];
  const unknown = Object.keys(patch).filter(key => !allowed.includes(key));
  if (unknown.length) throw invalid(`不支持的设置项：${unknown.join('、')}`);
  const next = { ...current };
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') throw invalid('enabled 必须是布尔值。');
    next.enabled = patch.enabled;
  }
  if ('daily_time' in patch) next.daily_time = normalize_time(patch.daily_time);
  if ('time_zone' in patch) next.time_zone = normalize_time_zone(patch.time_zone);
  if ('description' in patch) {
    if (typeof patch.description !== 'string') throw invalid('推荐描述必须是文本。');
    if (patch.description.length > 2000) throw invalid('推荐描述最多 2000 字。');
    next.description = patch.description.trim();
  }
  if ('preview_seconds' in patch) {
    const seconds = Number(patch.preview_seconds);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 120) throw invalid('试听时长必须是 5 到 120 秒的整数。');
    next.preview_seconds = seconds;
  }
  if ('log_dir' in patch) {
    if (typeof patch.log_dir !== 'string' || !patch.log_dir.trim() || patch.log_dir.includes('\0')) throw invalid('日志目录必须是有效路径。');
    next.log_dir = resolve(patch.log_dir.trim());
  }
  if ('player_path' in patch) {
    if (typeof patch.player_path !== 'string' || patch.player_path.includes('\0')) throw invalid('播放器路径必须是文本。');
    next.player_path = patch.player_path.trim();
  }
  return next;
}

/** Own JSON store: immediate effect and survives restarts without touching profile config. */
export class SettingsStore {
  constructor(data_dir) {
    this.data_dir = data_dir;
    this.path = join(data_dir, 'settings.json');
    this.state = null;
  }

  async load() {
    await mkdir(this.data_dir, { recursive: true, mode: 0o700 });
    let stored = {};
    try {
      stored = JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') stored = {};
    }
    const merged = { ...default_settings(this.data_dir), ...stored };
    // The log dir may be an old default; normalize it without failing boot.
    try { merged.log_dir = await ensure_writable_dir(merged.log_dir); } catch { merged.log_dir = resolve(merged.log_dir || join(this.data_dir, 'logs')); }
    merged.daily_time = (() => { try { return normalize_time(merged.daily_time); } catch { return '21:00:00'; } })();
    merged.time_zone = (() => { try { return normalize_time_zone(merged.time_zone); } catch { return DEFAULT_TIME_ZONE; } })();
    this.state = merged;
    return merged;
  }

  get() { return this.state; }

  async save(patch) {
    const current = this.state ?? await this.load();
    const next = sanitize_patch(patch, current);
    if (next.log_dir !== current.log_dir) next.log_dir = await ensure_writable_dir(next.log_dir);
    else await ensure_writable_dir(next.log_dir);
    next.version = 1;
    this.state = next;
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.path);
    return next;
  }

  /** Host-side bookkeeping the panel never edits. */
  async remember(fields) {
    const current = this.state ?? await this.load();
    this.state = { ...current, ...fields };
    return this.save({});
  }
}

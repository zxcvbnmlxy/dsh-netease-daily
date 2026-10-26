import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Reports and events older than this are pruned on the next write. */
const RETAIN_DAYS = 30;

function stamp(date = new Date()) {
  return date.toISOString();
}

function local_day(date = new Date(), time_zone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: time_zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function markdown_text(value) {
  return String(value ?? '').replace(/[\\`*_[\]<>]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

/**
 * Everything the plugin writes lives in the configured log directory:
 *   YYYY-MM-DD.md   that day's recommendations and evaluations (human report)
 *   latest.md       mirror of the newest day, for bookmarking
 *   index.html      clickable overview of retained days
 *   events.jsonl    append-only machine log (status, errors, playback, evaluations)
 * Reports and events older than 30 days are pruned. A non-writable directory
 * throws LOG_DIR_UNWRITABLE instead of failing silently.
 */
export class RunLogger {
  constructor({ get_settings, data_dir }) {
    this.get_settings = get_settings;
    this.data_dir = data_dir;
  }

  dir() { return resolve(this.get_settings().log_dir || join(this.data_dir, 'logs')); }
  day() { return local_day(new Date(), this.get_settings().time_zone); }

  async ensure() {
    const dir = this.dir();
    try {
      await mkdir(dir, { recursive: true });
      await access(dir);
      return dir;
    } catch (error) {
      throw Object.assign(new Error(`日志目录不可写：${dir}`), { code: 'LOG_DIR_UNWRITABLE' });
    }
  }

  async probe() {
    const dir = this.dir();
    try {
      await mkdir(dir, { recursive: true });
      const probe = join(dir, `.probe-${process.pid}-${Date.now()}`);
      await writeFile(probe, 'ok', 'utf8');
      await unlink(probe).catch(() => {});
      return { ok: true, dir };
    } catch (error) {
      return { ok: false, dir, error: error?.code || error?.message || 'error' };
    }
  }

  /** Append one structured event. Never throws: the caller decides how visible the failure is. */
  async event(type, detail = {}) {
    try {
      const dir = await this.ensure();
      const record = { ts: stamp(), date: this.day(), type, ...detail };
      await appendFile(join(dir, 'events.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
      return { ok: true, path: join(dir, 'events.jsonl') };
    } catch (error) {
      this.last_error = error?.message ?? String(error);
      return { ok: false, error: this.last_error };
    }
  }

  async report(lines) {
    const dir = await this.ensure();
    const path = join(dir, `${this.day()}.md`);
    await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
    await this.housekeeping();
    return path;
  }

  /** Append a section to today's markdown report, creating it with a title when new. */
  async append_section(title, lines) {
    const dir = await this.ensure();
    const path = join(dir, `${this.day()}.md`);
    let existing = '';
    try { existing = await readFile(path, 'utf8'); } catch {}
    const head = existing ? existing.replace(/\s*$/, '\n') : `# ${this.day()} · 每日听歌\n\n`;
    await writeFile(path, `${head}## ${markdown_text(title)}\n\n${lines.join('\n')}\n\n`, 'utf8');
    await this.housekeeping();
    return path;
  }

  /**
   * Keep the log directory readable instead of growing forever: prune old
   * reports/events, mirror the newest day into latest.md, and rebuild index.html.
   */
  async housekeeping() {
    const dir = await this.ensure().catch(() => null);
    if (!dir) return { ok: false };
    const cutoff = Date.now() - RETAIN_DAYS * 86_400_000;
    let names = [];
    try { names = await readdir(dir); } catch { return { ok: false }; }

    const removed = [];
    const days = [];
    for (const name of names) {
      const match = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name);
      if (!match) continue;
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      if (info.mtimeMs < cutoff) {
        await unlink(path).catch(() => {});
        removed.push(name);
      } else {
        days.push({ date: match[1], size: info.size });
      }
    }
    days.sort((left, right) => right.date.localeCompare(left.date));

    const today = `${this.day()}.md`;
    if (days.some(entry => `${entry.date}.md` === today)) {
      try { await writeFile(join(dir, 'latest.md'), await readFile(join(dir, today), 'utf8'), 'utf8'); } catch {}
    }

    const rows = days.map(entry => `      <li><a href="./${entry.date}.md">${entry.date}</a></li>`).join('\n');
    const html = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>每日听歌 · 日志索引</title>
<style>body{font:14px/1.7 system-ui;margin:40px auto;max-width:640px;color:#222}li{margin:2px 0}a{color:#3b6ef6;text-decoration:none}a:hover{text-decoration:underline}p{color:#666}</style>
<h1>每日听歌 · 日志索引</h1>
<p>保留最近 ${RETAIN_DAYS} 天；最新一次见 <a href="./latest.md">latest.md</a>。</p>
<ul>
${rows || '      <li>暂无记录</li>'}
</ul>
</html>
`;
    await writeFile(join(dir, 'index.html'), html, 'utf8').catch(() => {});

    try {
      const events_path = join(dir, 'events.jsonl');
      const raw = await readFile(events_path, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const kept = lines.filter(line => {
        try { return Date.parse(JSON.parse(line).ts) >= cutoff; } catch { return false; }
      });
      if (kept.length !== lines.length) await writeFile(events_path, `${kept.join('\n')}\n`, 'utf8');
    } catch {}

    return { ok: true, removed, days: days.length };
  }
}

export { local_day, stamp, RETAIN_DAYS };

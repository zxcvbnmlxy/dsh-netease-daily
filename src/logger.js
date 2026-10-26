import { appendFile, mkdir, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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
 * Every log line goes to the configured directory:
 *   events.jsonl          append-only machine log (status, errors, playback, evaluations)
 *   YYYY-MM-DD.md         human report of that day's recommendations and evaluations
 * A non-writable directory throws LOG_DIR_UNWRITABLE instead of failing silently.
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
      await import('node:fs/promises').then(fs => fs.rm(probe, { force: true }));
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
    return path;
  }

  /** Append a section to today's markdown report, creating it with a title when new. */
  async append_section(title, lines) {
    const dir = await this.ensure();
    const path = join(dir, `${this.day()}.md`);
    let existing = '';
    try { existing = await import('node:fs/promises').then(fs => fs.readFile(path, 'utf8')); } catch {}
    const head = existing ? existing.replace(/\s*$/, '\n') : `# ${this.day()} · 每日听歌\n\n`;
    await writeFile(path, `${head}## ${markdown_text(title)}\n\n${lines.join('\n')}\n\n`, 'utf8');
    return path;
  }
}

export { local_day, stamp };

/**
 * dsh-netease-daily 0.2.0 · settings.js / logger.js 单元测试
 *
 * 只读引用插件源码：默认 D:\deepseek插件，可用环境变量 NETEASE_PLUGIN_DIR 覆盖。
 * 全部使用 fs.mkdtemp 临时目录，不联网、不触碰用户真实数据目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, access } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const plugin_dir = resolve(process.env.NETEASE_PLUGIN_DIR || 'D:/deepseek插件');
const import_src = name => import(pathToFileURL(join(plugin_dir, 'src', name)).href);

const {
  DEFAULT_TIME_ZONE,
  default_settings,
  sanitize_patch,
  normalize_time,
  normalize_time_zone,
  ensure_writable_dir,
  SettingsStore,
} = await import_src('settings.js');
const { RunLogger, markdown_text, local_day } = await import_src('logger.js');

async function temp_dir(t, prefix = 'netease-settings-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    const target = resolve(dir);
    assert.ok(basename(target).startsWith(prefix), 'cleanup target must be a fixture temp dir');
    await rm(target, { recursive: true, force: true });
  });
  return dir;
}

const invalid_settings = error => error.code === 'INVALID_SETTINGS';

test('normalize_time accepts HH:MM or HH:MM:SS and pads to a stable form', () => {
  assert.equal(normalize_time('9:05'), '09:05:00');
  assert.equal(normalize_time('21:00'), '21:00:00');
  assert.equal(normalize_time('21:00:30'), '21:00:30');
  assert.equal(normalize_time(' 23:59:59 '), '23:59:59');
  assert.equal(normalize_time('00:00'), '00:00:00');

  for (const value of ['24:00', '7:5', '12:60', '12:00:60', '', 'evening', null, 2100]) {
    assert.throws(() => normalize_time(value), invalid_settings, `should reject ${String(value)}`);
    assert.throws(() => normalize_time(value), /运行时间必须是 HH:MM/);
  }
});

test('normalize_time_zone keeps valid IANA zones and rejects unknown ones', () => {
  assert.equal(normalize_time_zone('Asia/Shanghai'), 'Asia/Shanghai');
  assert.equal(normalize_time_zone('  UTC  '), 'UTC');
  assert.equal(normalize_time_zone(''), DEFAULT_TIME_ZONE);
  assert.equal(normalize_time_zone(undefined), DEFAULT_TIME_ZONE);
  assert.throws(() => normalize_time_zone('Mars/Olympus'), invalid_settings);
  assert.throws(() => normalize_time_zone('Mars/Olympus'), /时区不可用/);
});

test('sanitize_patch normalizes accepted fields and never mutates the current settings', () => {
  const current = default_settings('C:/tmp/netease-data');
  const snapshot = JSON.parse(JSON.stringify(current));

  const next = sanitize_patch({
    enabled: false,
    daily_time: '9:05',
    time_zone: ' UTC ',
    description: '  下雨天的后摇  ',
    preview_seconds: '45',
    log_dir: 'D:/tmp/netease-logs',
    player_path: '  D:/tools/mpv.exe  ',
  }, current);

  assert.equal(next.enabled, false);
  assert.equal(next.daily_time, '09:05:00');
  assert.equal(next.time_zone, 'UTC');
  assert.equal(next.description, '下雨天的后摇');
  assert.equal(next.preview_seconds, 45);
  assert.equal(next.log_dir, resolve('D:/tmp/netease-logs'));
  assert.equal(next.player_path, 'D:/tools/mpv.exe');
  assert.equal(next.version, 1);
  assert.deepEqual(current, snapshot, 'current settings must not be mutated');

  assert.equal(sanitize_patch({}, current).daily_time, current.daily_time);
  assert.equal(sanitize_patch({ description: '' }, current).description, '');
  assert.equal(sanitize_patch({ preview_seconds: 5 }, current).preview_seconds, 5);
  assert.equal(sanitize_patch({ preview_seconds: 120 }, current).preview_seconds, 120);
});

test('sanitize_patch rejects unknown keys and out-of-range values', () => {
  const current = default_settings('C:/tmp/netease-data');

  for (const patch of [null, undefined, 'patch', ['enabled'], 42]) {
    assert.throws(() => sanitize_patch(patch, current), /设置必须是对象/);
  }
  assert.throws(() => sanitize_patch({ unknown: true }, current), /不支持的设置项：unknown/);
  assert.throws(() => sanitize_patch({ enabled: 'yes' }, current), /enabled 必须是布尔值/);
  assert.throws(() => sanitize_patch({ description: 42 }, current), /推荐描述必须是文本/);
  assert.throws(() => sanitize_patch({ description: '字'.repeat(2001) }, current), /最多 2000 字/);
  for (const seconds of [4, 121, 30.5, 'abc', null]) {
    assert.throws(() => sanitize_patch({ preview_seconds: seconds }, current), /5 到 120 秒的整数/);
  }
  for (const log_dir of ['', '   ', 42, 'bad\0path']) {
    assert.throws(() => sanitize_patch({ log_dir }, current), /日志目录必须是有效路径/);
  }
  assert.throws(() => sanitize_patch({ player_path: 42 }, current), /播放器路径必须是文本/);
  assert.throws(() => sanitize_patch({ time_zone: 'Mars/Olympus' }, current), /时区不可用/);
});

test('ensure_writable_dir creates nested directories and reports unwritable paths', async t => {
  const data_dir = await temp_dir(t);
  const nested = join(data_dir, 'deep', 'logs');
  assert.equal(await ensure_writable_dir(nested), resolve(nested));
  await access(nested);
  assert.deepEqual((await readdir(nested)).filter(name => name.startsWith('.write-probe-')), [],
    'the write probe must clean itself up');

  const blocker = join(data_dir, 'blocker');
  await writeFile(blocker, 'not a directory');
  await assert.rejects(
    ensure_writable_dir(join(blocker, 'logs')),
    error => error.code === 'LOG_DIR_UNWRITABLE' && /日志目录不可写/.test(error.message),
  );
});

test('SettingsStore loads defaults, creates the log dir and persists patches', async t => {
  const data_dir = await temp_dir(t);
  const store = new SettingsStore(data_dir);
  const initial = await store.load();

  assert.equal(initial.version, 1);
  assert.equal(initial.enabled, true);
  assert.equal(initial.daily_time, '21:00:00');
  assert.equal(initial.time_zone, DEFAULT_TIME_ZONE);
  assert.equal(initial.description, '');
  assert.equal(initial.preview_seconds, 30);
  assert.equal(initial.log_dir, resolve(join(data_dir, 'logs')));
  await access(initial.log_dir);
  assert.equal(store.get(), initial);

  const saved = await store.save({ daily_time: '9:05', preview_seconds: 45, description: '  雨天通勤  ' });
  assert.equal(saved.daily_time, '09:05:00');
  assert.equal(saved.preview_seconds, 45);
  assert.equal(saved.description, '雨天通勤');

  const alt_logs = join(data_dir, 'alt-logs');
  const with_logs = await store.save({ log_dir: alt_logs });
  assert.equal(with_logs.log_dir, alt_logs);
  await access(alt_logs);

  const disk = JSON.parse(await readFile(join(data_dir, 'settings.json'), 'utf8'));
  assert.equal(disk.daily_time, '09:05:00');
  assert.equal(disk.preview_seconds, 45);
  assert.equal(disk.log_dir, alt_logs);

  const reloaded = await new SettingsStore(data_dir).load();
  assert.equal(reloaded.daily_time, '09:05:00');
  assert.equal(reloaded.preview_seconds, 45);
  assert.equal(reloaded.description, '雨天通勤');
  assert.equal(reloaded.log_dir, alt_logs);
});

test('SettingsStore refuses an unwritable log_dir and does not persist the rejected patch', async t => {
  const data_dir = await temp_dir(t);
  const store = new SettingsStore(data_dir);
  const initial = await store.load();
  const saved = await store.save({ description: '先保存一次' });
  assert.equal(saved.description, '先保存一次');

  const blocker = join(data_dir, 'blocker');
  await writeFile(blocker, 'not a directory');

  await assert.rejects(
    store.save({ log_dir: join(blocker, 'logs') }),
    error => error.code === 'LOG_DIR_UNWRITABLE',
  );

  const disk = JSON.parse(await readFile(join(data_dir, 'settings.json'), 'utf8'));
  assert.equal(disk.log_dir, initial.log_dir, 'rejected log_dir must not be persisted');
  assert.equal(disk.description, '先保存一次');
  assert.equal(store.get().log_dir, initial.log_dir);
});

test('SettingsStore.remember stores host-side bookkeeping and tolerates corrupt settings.json', async t => {
  const data_dir = await temp_dir(t);
  const store = new SettingsStore(data_dir);
  await store.load();

  const remembered = await store.remember({ session_id: 'session-1', schedule_id: 'task-9' });
  assert.equal(remembered.session_id, 'session-1');
  assert.equal(remembered.schedule_id, 'task-9');
  const disk = JSON.parse(await readFile(join(data_dir, 'settings.json'), 'utf8'));
  assert.equal(disk.session_id, 'session-1');
  assert.equal(disk.schedule_id, 'task-9');

  await writeFile(join(data_dir, 'settings.json'), '{broken-json');
  const recovered = await new SettingsStore(data_dir).load();
  assert.equal(recovered.version, 1);
  assert.equal(recovered.daily_time, '21:00:00');
  assert.equal(recovered.description, '');
});

test('logger.probe creates the log dir, writes a removable probe and reports failures', async t => {
  const data_dir = await temp_dir(t);
  const log_dir = join(data_dir, 'logs');
  const logger = new RunLogger({ get_settings: () => ({ log_dir }), data_dir });

  assert.deepEqual(await logger.probe(), { ok: true, dir: resolve(log_dir) });
  await access(log_dir);
  assert.deepEqual((await readdir(log_dir)).filter(name => name.startsWith('.probe-')), []);

  const blocker = join(data_dir, 'blocker');
  await writeFile(blocker, 'not a directory');
  const failing = new RunLogger({ get_settings: () => ({ log_dir: join(blocker, 'logs') }), data_dir });
  const result = await failing.probe();
  assert.equal(result.ok, false);
  assert.equal(result.dir, resolve(join(blocker, 'logs')));
  assert.equal(typeof result.error, 'string');
});

test('RunLogger.event appends structured JSON lines', async t => {
  const data_dir = await temp_dir(t);
  const log_dir = join(data_dir, 'logs');
  const logger = new RunLogger({ get_settings: () => ({ log_dir }), data_dir });

  const first = await logger.event('login', { ok: true });
  assert.equal(first.ok, true);
  assert.equal(first.path, join(resolve(log_dir), 'events.jsonl'));
  await logger.event('playback', { track_id: '1', silent: true });

  const lines = (await readFile(join(log_dir, 'events.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  const login = JSON.parse(lines[0]);
  assert.equal(login.type, 'login');
  assert.equal(login.ok, true);
  assert.match(login.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(login.date, /^\d{4}-\d{2}-\d{2}$/);
  const playback = JSON.parse(lines[1]);
  assert.equal(playback.type, 'playback');
  assert.equal(playback.track_id, '1');
  assert.equal(playback.silent, true);
});

test('RunLogger.report and append_section write the day markdown without duplicating the heading', async t => {
  const data_dir = await temp_dir(t);
  const report_dir = join(data_dir, 'reports');
  const logger = new RunLogger({ get_settings: () => ({ log_dir: report_dir, time_zone: 'Asia/Shanghai' }), data_dir });
  const day = logger.day();
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);

  const report_path = await logger.report(['# 标题', '- 一行']);
  assert.equal(report_path, join(resolve(report_dir), `${day}.md`));
  assert.equal(await readFile(report_path, 'utf8'), '# 标题\n- 一行\n');

  // append_section 单独用一个空目录，验证它自己创建日标题且不重复。
  const sections_dir = join(data_dir, 'sections');
  const section_logger = new RunLogger({ get_settings: () => ({ log_dir: sections_dir, time_zone: 'Asia/Shanghai' }), data_dir });
  const first = await section_logger.append_section('今日推荐', ['- 歌曲 A']);
  let text = await readFile(first, 'utf8');
  assert.match(text, new RegExp(`^# ${day} · 每日听歌`));
  assert.match(text, /## 今日推荐/);
  assert.match(text, /- 歌曲 A/);

  await section_logger.append_section('听歌评价 · 歌曲 A', ['- 评价 A']);
  text = await readFile(first, 'utf8');
  assert.equal(text.match(/^# /gm).length, 1, 'append must not duplicate the day heading');
  assert.match(text, /## 今日推荐[\s\S]*## 听歌评价/);
  assert.match(text, /- 评价 A/);
});

test('RunLogger never throws from event() and ensure() reports LOG_DIR_UNWRITABLE', async t => {
  const data_dir = await temp_dir(t);
  const blocker = join(data_dir, 'blocker');
  await writeFile(blocker, 'not a directory');
  const logger = new RunLogger({ get_settings: () => ({ log_dir: join(blocker, 'logs') }), data_dir });

  const result = await logger.event('error', { where: 'test' });
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.equal(logger.last_error, result.error);

  await assert.rejects(logger.ensure(), error => error.code === 'LOG_DIR_UNWRITABLE');
});

test('markdown_text escapes markup and local_day respects the configured zone', () => {
  assert.equal(markdown_text('a[b]c*d_e`f<g>'), 'a\\[b\\]c\\*d\\_e\\`f\\<g\\>');
  assert.equal(markdown_text('line1\nline2\r\nline3'), 'line1 line2 line3');
  assert.equal(markdown_text(null), '');

  assert.equal(local_day(new Date('2026-10-25T16:10:00Z'), 'Asia/Shanghai'), '2026-10-26');
  assert.equal(local_day(new Date('2026-10-26T15:59:59Z'), 'Asia/Shanghai'), '2026-10-26');
  assert.equal(local_day(new Date('2026-10-25T16:10:00Z'), 'UTC'), '2026-10-25');
});

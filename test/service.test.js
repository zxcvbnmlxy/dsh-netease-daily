import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { MusicService, local_date } from '../src/service.js';

const secret_cookie = 'MUSIC_U=private-test-token; __csrf=private-csrf';
const fixed_now = new Date('2026-10-26T13:00:00.000Z');
const sample_songs = (count = 10) => Array.from({ length: count }, (_, index) => ({
  id: index + 1,
  name: `歌曲 ${index + 1}`,
  ar: [{ name: `歌手 ${index + 1}` }],
  al: { name: `专辑 ${index + 1}` },
  dt: 180_000,
}));

async function fixture(t, options = {}) {
  const workspace = resolve(process.cwd());
  const data_dir = await mkdtemp(join(workspace, '.test-data-service-'));
  t.after(async () => {
    const target = resolve(data_dir);
    const within_workspace = relative(workspace, target);
    assert.ok(within_workspace && !within_workspace.startsWith('..') && !isAbsolute(within_workspace), 'cleanup target must remain inside workspace');
    assert.match(within_workspace, /^\.test-data-service-/);
    await rm(target, { recursive: true, force: true });
  });
  const calls = [];
  const player_calls = [];
  let now = fixed_now;
  const api_factory = cookie => ({
    async call(route, args, signal) {
      calls.push({ route, args, cookie });
      if (options.respond) {
        const answer = await options.respond(route, args, signal, cookie);
        if (answer !== undefined) return answer;
      }
      signal?.throwIfAborted();
      if (route === 'recommend_songs') return { code: 200, data: { dailySongs: options.songs || sample_songs() } };
      if (route === 'lyric') return { code: 200, lrc: { lyric: '[00:01.00]测试歌词主题\n[00:03.00]第二句' } };
      if (route === 'song_url_v1') return { code: 200, data: [{ id: args.id, url: `https://music.example.invalid/${args.id}.mp3` }] };
      if (route === 'login_status') return { code: 200, data: { profile: { userId: 123, nickname: '测试听众' } } };
      throw new Error(`Unexpected fake route: ${route}`);
    },
  });
  const player = async (url, playback_options) => {
    player_calls.push({ url, options: playback_options });
    return options.playback || { status: 'played', elapsed_seconds: 30 };
  };
  const service_options = { data_dir, api_factory, player, now: () => now };
  const service = new MusicService(service_options);
  if (options.authenticated !== false) await writeFile(join(data_dir, 'credentials.json'), JSON.stringify({ cookie: secret_cookie }));
  return { service, data_dir, calls, player_calls, service_options, set_now: value => { now = new Date(value); } };
}

const recommendations_for = tracks => tracks.slice(0, Math.min(3, tracks.length)).map(track => ({ id: track.id, reason: '来自每日推荐，适合作为今天的新歌探索。' }));

test('Shanghai calendar date remains correct across the UTC date boundary', () => {
  assert.equal(local_date(new Date('2026-10-25T16:10:00Z')), '2026-10-26');
  assert.equal(local_date(new Date('2026-10-26T15:59:59Z')), '2026-10-26');
});

test('QR login exposes no account credentials and persists them only locally', async t => {
  const qr_codes = [801, 802, 803];
  const { service, data_dir, calls } = await fixture(t, {
    authenticated: false,
    respond(route) {
      if (route === 'login_qr_key') return { code: 200, data: { unikey: 'private-qr-key' } };
      if (route === 'login_qr_create') return { code: 200, data: { qrimg: 'data:image/png;base64,iVBORw0KGgo=' } };
      if (route === 'login_qr_check') return { code: qr_codes.shift(), cookie: secret_cookie };
    },
  });
  const start = await service.login_start();
  assert.equal(start.status, 'waiting_scan');
  assert.equal(start.qr_path, join(data_dir, 'login-qr.png'));
  assert.ok((await readFile(start.qr_path)).length > 0);
  const results = [start, await service.login_check(), await service.login_check(), await service.login_check(), await service.status()];
  assert.deepEqual(results.slice(1, 4).map(result => result.status), ['waiting_scan', 'waiting_confirmation', 'logged_in']);
  assert.equal(results.at(-1).logged_in, true);
  const public_json = JSON.stringify(results);
  for (const secret of ['private-test-token', 'private-csrf', 'private-qr-key', 'MUSIC_U=']) assert.equal(public_json.includes(secret), false);
  assert.equal(JSON.parse(await readFile(join(data_dir, 'credentials.json'), 'utf8')).cookie, secret_cookie);
  assert.equal(calls.find(call => call.route === 'login_status').cookie, secret_cookie);
  assert.equal(JSON.stringify(await service.load()).includes('MUSIC_U'), false);
});

test('daily preparation is stable for concurrent calls and after a service restart', async t => {
  const { service, calls, service_options } = await fixture(t);
  const [first, second] = await Promise.all([service.prepare(), service.prepare()]);
  assert.equal(first.tracks.length, 5);
  assert.equal(first.recommendation_count, 3);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.deepEqual(first.tracks, second.tracks);
  assert.equal(new Set(first.tracks.map(track => track.id)).size, 5);
  assert.equal(calls.filter(call => call.route === 'recommend_songs').length, 1);
  assert.equal(calls.filter(call => call.route === 'lyric').length, 5);
  assert.ok(first.tracks.every(track => track.playback.status === 'not_attempted'));
  const restarted = await new MusicService(service_options).prepare();
  assert.equal(restarted.cached, true);
  assert.deepEqual(restarted.tracks, first.tracks);
  assert.equal(calls.filter(call => call.route === 'recommend_songs').length, 1);
});

test('recent recommendations and disliked tracks are excluded on the next day', async t => {
  const { service, set_now } = await fixture(t);
  const day_one = await service.prepare();
  await service.feedback(day_one.tracks[0].id, 'dislike');
  const selected = day_one.tracks.slice(1, 4).map(track => ({ id: track.id, reason: '今天推荐这首歌。' }));
  await service.save_recommendations(selected);
  set_now('2026-10-27T13:00:00Z');
  const day_two = await service.prepare();
  const excluded = new Set([day_one.tracks[0].id, ...selected.map(track => track.id)]);
  assert.equal(day_two.tracks.length, 5);
  assert.ok(day_two.tracks.every(track => !excluded.has(track.id)));
  assert.equal(day_two.date, '2026-10-27');
});

test('the fourteen-day recommendation window has a calendar-day boundary', async t => {
  const { service, data_dir } = await fixture(t);
  await writeFile(join(data_dir, 'history.json'), JSON.stringify({
    version: 1,
    days: {
      '2026-10-13': { tracks: [], recommendations: [{ id: '1', reason: 'recent' }] },
      '2026-10-12': { tracks: [], recommendations: [{ id: '2', reason: 'old enough' }] },
    },
    preferences: { '3': 'dislike' },
  }));
  const day = await service.prepare();
  assert.ok(!day.tracks.some(track => track.id === '1'));
  assert.ok(!day.tracks.some(track => track.id === '3'));
  assert.ok(day.tracks.some(track => track.id === '2'));
});

test('report rejects invalid selections before creating a report and is idempotent once saved', async t => {
  const { service, data_dir, service_options } = await fixture(t);
  const day = await service.prepare();
  const selected = recommendations_for(day.tracks);
  await assert.rejects(service.save_recommendations(selected.slice(0, 2)), /3/);
  await assert.rejects(service.save_recommendations([{ ...selected[0], id: '999' }, ...selected.slice(1)]), /候选/);
  await assert.rejects(service.save_recommendations([selected[0], selected[0], selected[2]]), /重复/);
  await assert.rejects(service.save_recommendations([{ ...selected[0], reason: '   ' }, ...selected.slice(1)]), /理由/);
  await assert.rejects(access(join(data_dir, 'reports', '2026-10-26.md')));
  const first = await service.save_recommendations(selected);
  const initial_report = await readFile(first.report_path, 'utf8');
  assert.match(initial_report, /未完成试听/);
  assert.equal(initial_report.includes('已播放约'), false);
  assert.equal(initial_report.includes('测试歌词'), false, 'report should not reproduce the lyric excerpt');
  assert.equal(initial_report.includes(secret_cookie), false);
  const second = await new MusicService(service_options).save_recommendations([]);
  assert.equal(second.cached, true);
  assert.deepEqual(second.recommendations, selected);
  assert.equal(await readFile(second.report_path, 'utf8'), initial_report);
});

test('successful preview is persisted and never replayed for a duplicate daily invocation', async t => {
  const { service, service_options, calls, player_calls } = await fixture(t);
  const day = await service.prepare();
  const first = await service.preview(day.tracks[0].id);
  const second = await new MusicService(service_options).preview(day.tracks[0].id);
  assert.equal(first.status, 'played');
  assert.equal(first.elapsed_seconds, 30);
  assert.equal(second.cached, true);
  assert.equal(player_calls.length, 1);
  assert.equal(calls.filter(call => call.route === 'song_url_v1').length, 1);
  const stored = await service.load();
  assert.equal(stored.days[day.date].tracks[0].playback.status, 'played');
  assert.equal(JSON.stringify(stored).includes('music.example.invalid'), false, 'temporary audio URL should not be persisted');
});

test('missing player and unavailable media remain truthful in the saved report', async t => {
  const { service, player_calls } = await fixture(t, {
    playback: { status: 'unavailable', elapsed_seconds: 0, reason: '未安装 mpv' },
    respond(route, args) {
      if (route === 'song_url_v1' && args.id === '2') return { code: 200, data: [{ id: 2, url: null }] };
      if (route === 'song_url_v1' && args.id === '3') return { code: 200, data: [{ id: 3, url: 'https://music.example.invalid/trial.mp3', freeTrialInfo: { start: 0, end: 30_000 } }] };
    },
  });
  const day = await service.prepare();
  const missing_player = await service.preview('1');
  const no_media = await service.preview('2');
  const trial = await service.preview('3');
  assert.equal(missing_player.status, 'unavailable');
  assert.equal(no_media.status, 'unavailable');
  assert.equal(no_media.elapsed_seconds, 0);
  assert.equal(trial.license_trial, true);
  assert.equal(player_calls.length, 2, 'unavailable media should not start the player');
  const report = await service.save_recommendations(recommendations_for(day.tracks));
  const text = await readFile(report.report_path, 'utf8');
  assert.match(text, /未安装 mpv/);
  assert.match(text, /版权或会员限制/);
  assert.equal(text.includes('已播放约'), false);
});

test('lyric failure permits metadata recommendations without claiming lyrics were available', async t => {
  const { service } = await fixture(t, {
    respond(route) { if (route === 'lyric') throw new Error('temporary lyric failure'); },
  });
  const day = await service.prepare();
  assert.equal(day.tracks.length, 5);
  assert.ok(day.tracks.every(track => track.lyric_excerpt === '' && track.lyric_note.includes('暂不可用')));
});

test('cancellation during preparation leaves no partial daily selection or report', async t => {
  const controller = new AbortController();
  const { service } = await fixture(t, {
    respond(route) { if (route === 'lyric') { controller.abort(); throw controller.signal.reason; } },
  });
  await assert.rejects(service.prepare(controller.signal), { name: 'AbortError' });
  assert.deepEqual((await service.load()).days, {});
  await assert.rejects(service.save_recommendations([], controller.signal), { name: 'AbortError' });
});

test('an aborted Harness invocation cannot reuse cached data or cached playback', async t => {
  const { service, calls, player_calls } = await fixture(t);
  const day = await service.prepare();
  await service.preview(day.tracks[0].id);
  const controller = new AbortController();
  controller.abort();
  const previous_calls = calls.length;
  await assert.rejects(service.prepare(controller.signal), { name: 'AbortError' });
  await assert.rejects(service.preview(day.tracks[0].id, controller.signal), { name: 'AbortError' });
  await assert.rejects(service.status(controller.signal), { name: 'AbortError' });
  assert.equal(calls.length, previous_calls);
  assert.equal(player_calls.length, 1);
});

test('invalid local data is reported without silently replacing the original history', async t => {
  const { service, data_dir } = await fixture(t);
  const history_path = join(data_dir, 'history.json');
  await writeFile(history_path, '{broken-json');
  await assert.rejects(service.prepare(), /本地音乐数据无法读取/);
  assert.equal(await readFile(history_path, 'utf8'), '{broken-json');
});

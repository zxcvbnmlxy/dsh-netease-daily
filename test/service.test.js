/**
 * dsh-netease-daily 0.2.0 · MusicService 单元测试
 *
 * 只读引用插件源码：默认 D:\deepseek插件，可用环境变量 NETEASE_PLUGIN_DIR 覆盖。
 * 全部使用 fs.mkdtemp 临时目录；不联网、不真正播放音频（player 为 mock）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const plugin_dir = resolve(process.env.NETEASE_PLUGIN_DIR || 'D:/deepseek插件');
const import_src = name => import(pathToFileURL(join(plugin_dir, 'src', name)).href);

const { MusicService, local_date } = await import_src('service.js');
const { RunLogger } = await import_src('logger.js');
const { silent_player_reasons } = await import_src('silent_player.js');

const secret_cookie = 'MUSIC_U=private-test-token; __csrf=private-csrf';
const fixed_now = new Date('2026-10-26T13:00:00.000Z');

const make_song = (id, label = String(id)) => ({
  id,
  name: `歌曲 ${label}`,
  ar: [{ name: `歌手 ${label}` }],
  al: { name: `专辑 ${label}` },
  dt: 180_000,
});
const make_songs = (count, start = 1) => Array.from({ length: count }, (_, index) => make_song(start + index));

const recommendations_for = tracks => tracks.slice(0, Math.min(3, tracks.length)).map(track => ({
  id: track.id,
  reason: '来自每日推荐，适合作为今天的新歌探索。',
}));

async function read_events(log_dir) {
  try {
    const text = await readFile(join(log_dir, 'events.jsonl'), 'utf8');
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

async function list_md(log_dir) {
  try {
    return (await readdir(log_dir)).filter(name => name.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

/**
 * fake api_factory + fake player + 临时 data_dir / log_dir。
 * settings 对象可被测试直接修改（get_settings 是按引用读取的）。
 */
async function fixture(t, options = {}) {
  const data_dir = await mkdtemp(join(tmpdir(), 'netease-service-'));
  t.after(async () => {
    const target = resolve(data_dir);
    assert.ok(basename(target).startsWith('netease-service-'), 'cleanup target must be a fixture temp dir');
    await rm(target, { recursive: true, force: true });
  });

  const settings = {
    description: '',
    preview_seconds: 30,
    time_zone: 'Asia/Shanghai',
    player_path: '',
    log_dir: join(data_dir, 'logs'),
    ...(options.settings || {}),
  };

  const calls = [];
  const player_calls = [];
  let now = fixed_now;

  const api_factory = cookie => ({
    async call(route, args = {}, signal) {
      calls.push({ route, args, cookie });
      if (options.respond) {
        const answer = await options.respond(route, args, signal, cookie);
        if (answer !== undefined) return answer;
      }
      signal?.throwIfAborted();
      switch (route) {
        case 'recommend_songs':
          return { code: 200, data: { dailySongs: options.songs ?? make_songs(8) } };
        case 'cloudsearch':
          return { code: 200, result: { songs: options.search_songs ?? make_songs(3, 20) } };
        case 'lyric':
          return { code: 200, lrc: { lyric: '[00:01.00]测试歌词主题\n[00:03.00]第二句' } };
        case 'song_url_v1':
          return { code: 200, data: [{ id: Number(args.id), url: `https://music.example.invalid/${args.id}.mp3` }] };
        case 'song_detail':
          return { code: 200, songs: [make_song(Number(args.ids))] };
        case 'login_status':
          return { code: 200, data: { profile: { userId: 123, nickname: '测试听众' } } };
        default:
          throw new Error(`Unexpected fake route: ${route}`);
      }
    },
  });

  const player = async (url, playback_options) => {
    player_calls.push({ url, options: playback_options });
    // 每次返回一份拷贝：service 会把 reason 翻译成中文提示，不能污染 fixture。
    return options.playback ? { ...options.playback } : { status: 'played', elapsed_seconds: 30 };
  };

  const logger = new RunLogger({ get_settings: () => settings, data_dir });
  const service_options = {
    data_dir,
    api_factory,
    player,
    now: () => now,
    get_settings: () => settings,
    logger,
  };
  const service = new MusicService(service_options);

  if (options.authenticated !== false) {
    await writeFile(join(data_dir, 'credentials.json'), JSON.stringify({ cookie: secret_cookie }));
  }

  return {
    service,
    service_options,
    data_dir,
    settings,
    logger,
    calls,
    player_calls,
    log_dir: logger.dir(),
    set_now: value => { now = new Date(value); },
  };
}

test('Shanghai calendar date stays correct across the UTC date boundary', () => {
  assert.equal(local_date(new Date('2026-10-25T16:10:00Z')), '2026-10-26');
  assert.equal(local_date(new Date('2026-10-26T15:59:59Z')), '2026-10-26');
  assert.equal(local_date(new Date('2026-10-26T15:59:59Z'), 'UTC'), '2026-10-26');
});

test('status reports a signed-out account without probing the network', async t => {
  const { service, calls, data_dir, log_dir } = await fixture(t, { authenticated: false });
  const result = await service.status();

  assert.equal(result.has_credentials, false);
  assert.equal(result.logged_in, false);
  assert.equal(result.message, '尚未登录网易云，请在设置页扫码登录。');
  assert.equal(result.data_dir, data_dir);
  assert.equal(result.today_prepared, false);
  assert.equal(result.today_completed, false);
  assert.equal(result.today_evaluations, 0);
  assert.equal(result.preview_seconds, 30);
  assert.equal(result.player_path, '');
  assert.equal(result.silent_playback, true);
  assert.equal(result.log_dir, log_dir);
  assert.equal(result.nickname, undefined);
  assert.equal(calls.length, 0, 'signed-out status must not call the api');
  assert.equal(JSON.stringify(result).includes('MUSIC_U'), false);
});

test('status reports a signed-in account, expired sessions and network failures truthfully', async t => {
  const signed_in = await fixture(t);
  const ok = await signed_in.service.status();
  assert.equal(ok.has_credentials, true);
  assert.equal(ok.logged_in, true);
  assert.equal(ok.nickname, '测试听众');
  assert.equal(ok.message, undefined);
  assert.equal(signed_in.calls[0].route, 'login_status');
  assert.equal(signed_in.calls[0].cookie, secret_cookie);
  assert.equal(JSON.stringify(ok).includes(secret_cookie), false);

  const expired = await fixture(t, {
    respond(route) { if (route === 'login_status') return { code: 200, data: {} }; },
  });
  const expired_result = await expired.service.status();
  assert.equal(expired_result.logged_in, false);
  assert.equal(expired_result.message, '登录已失效，请重新扫码。');

  const broken = await fixture(t, {
    respond(route) { if (route === 'login_status') throw new Error('network down'); },
  });
  const broken_result = await broken.service.status();
  assert.equal(broken_result.logged_in, false);
  assert.equal(broken_result.message, '无法验证登录状态，请检查网络后重试。');
});

test('status reflects today-preparation, evaluations and completion state', async t => {
  const { service } = await fixture(t);
  await service.prepare();
  let status = await service.status();
  assert.equal(status.today_prepared, true);
  assert.equal(status.today_completed, false);
  assert.equal(status.today_evaluations, 0);

  const day = await service.prepare();
  assert.equal(day.cached, true);
  await service.evaluate(day.tracks[0].id, 4, '今天的评价');
  status = await service.status();
  assert.equal(status.today_evaluations, 1);

  await service.save_recommendations(recommendations_for(day.tracks));
  status = await service.status();
  assert.equal(status.today_completed, true);
});

test('listen without credentials reports NOT_LOGGED_IN and never starts the player', async t => {
  const { service, player_calls } = await fixture(t, { authenticated: false });
  await assert.rejects(service.listen('1'), error => error.code === 'NOT_LOGGED_IN');
  assert.equal(player_calls.length, 0);
  await assert.rejects(service.listen('../etc'), /歌曲 ID 必须是正整数/);
  assert.equal(player_calls.length, 0);
});

test('plan uses the description from settings and merges daily + cloudsearch with de-duplication', async t => {
  const { service, calls, log_dir } = await fixture(t, {
    settings: { description: '下雨天的后摇' },
    search_songs: [make_song(3), make_song(4), make_song(20), make_song(21), make_song(22)],
  });
  const plan = await service.plan();

  assert.equal(plan.date, '2026-10-26');
  assert.equal(plan.description, '下雨天的后摇');
  assert.equal(plan.silent, true);
  assert.equal(plan.log_dir, log_dir);
  assert.deepEqual(plan.tracks.map(track => track.id), ['1', '2', '3', '4', '20', '21']);
  assert.equal(new Set(plan.tracks.map(track => track.id)).size, plan.tracks.length);

  const search = calls.filter(call => call.route === 'cloudsearch');
  assert.equal(search.length, 1);
  assert.equal(search[0].args.keywords, '下雨天的后摇');
  assert.equal(search[0].args.type, 1);
  assert.equal(search[0].args.limit, 6);
  assert.equal(calls.filter(call => call.route === 'recommend_songs').length, 1);

  const daily = plan.tracks.filter(track => track.source_reason === '来自你的网易云每日推荐');
  assert.deepEqual(daily.map(track => track.id), ['1', '2', '3', '4']);
  const searched = plan.tracks.filter(track => track.source_reason === '按描述搜索：下雨天的后摇');
  assert.deepEqual(searched.map(track => track.id), ['20', '21']);
  assert.equal(calls.filter(call => call.route === 'lyric').length, 6);
  assert.ok(plan.tracks.every(track => track.lyric_excerpt.includes('测试歌词主题')));
  assert.ok(plan.tracks.every(track => track.url === `https://music.163.com/#/song?id=${track.id}`));

  const stored = (await service.load()).days['2026-10-26'];
  assert.equal(stored.tracks.length, 6);
  assert.equal(stored.source, '按描述推荐');
});

test('plan reuses today\'s prepared tracks and skips extra network calls', async t => {
  const { service, calls } = await fixture(t);
  const prepared = await service.prepare();
  const plan = await service.plan('');

  assert.deepEqual(plan.tracks.map(track => track.id), prepared.tracks.map(track => track.id));
  assert.equal(calls.filter(call => call.route === 'recommend_songs').length, 1);
  assert.equal(calls.filter(call => call.route === 'cloudsearch').length, 0);
});

test('plan keeps a lyric_note instead of failing when lyrics are unavailable', async t => {
  const { service } = await fixture(t, {
    respond(route) { if (route === 'lyric') throw new Error('temporary lyric failure'); },
  });
  const plan = await service.plan('清晨通勤');

  assert.equal(plan.tracks.length, 6);
  for (const track of plan.tracks) {
    assert.equal(track.lyric_excerpt, '');
    assert.equal(track.lyric_note, '歌词暂不可用。');
  }
});

test('listen plays silently through the injected player and logs the attempt', async t => {
  const { service, player_calls, log_dir } = await fixture(t);
  const day = await service.prepare();
  const result = await service.listen(day.tracks[0].id);

  assert.equal(result.status, 'played');
  assert.equal(result.elapsed_seconds, 30);
  assert.equal(result.silent, true);
  assert.equal(result.id, '1');
  assert.equal(result.name, '歌曲 1');
  assert.deepEqual(result.artists, ['歌手 1']);
  assert.equal(result.album, '专辑 1');
  assert.equal(result.lyric_excerpt, '');
  assert.equal(result.player_path, '');
  assert.equal(result.attempted_at, fixed_now.toISOString());

  assert.equal(player_calls.length, 1);
  assert.equal(player_calls[0].url, 'https://music.example.invalid/1.mp3');
  assert.equal(player_calls[0].options.seconds, 30);
  assert.equal(player_calls[0].options.player_path, '');

  const playback = (await read_events(log_dir)).find(event => event.type === 'playback');
  assert.ok(playback, 'playback event should be logged');
  assert.equal(playback.track_id, '1');
  assert.equal(playback.status, 'played');
  assert.equal(playback.silent, true);
  assert.equal(playback.name, '歌曲 1');
  assert.equal(JSON.stringify(await service.load()).includes('music.example.invalid'), false,
    'temporary audio URLs must never be persisted');
});

test('listen reports unavailable media without starting the player', async t => {
  const { service, player_calls } = await fixture(t, {
    respond(route, args) {
      if (route === 'song_url_v1' && String(args.id) === '2') return { code: 200, data: [{ id: 2, url: null }] };
    },
  });
  await service.prepare();
  const result = await service.listen('2');

  assert.equal(result.status, 'unavailable');
  assert.equal(result.elapsed_seconds, 0);
  assert.match(result.reason, /版权或会员限制/);
  assert.equal(result.silent, true);
  assert.equal(player_calls.length, 0);
});

test('listen maps player failures to readable reasons and flags trial licences', async t => {
  const { service, player_calls } = await fixture(t, {
    playback: { status: 'unavailable', elapsed_seconds: 0, reason: 'player_not_found' },
    respond(route, args) {
      if (route === 'song_url_v1' && String(args.id) === '3') {
        return { code: 200, data: [{ id: 3, url: 'https://music.example.invalid/trial.mp3', freeTrialInfo: { start: 0, end: 30_000 } }] };
      }
    },
  });
  await service.prepare();

  const missing_player = await service.listen('1');
  assert.equal(missing_player.status, 'unavailable');
  assert.equal(missing_player.reason, silent_player_reasons.player_not_found);
  assert.match(missing_player.reason, /mpv/);

  const trial = await service.listen('3');
  assert.equal(trial.license_trial, true);
  assert.equal(trial.status, 'unavailable');
  assert.equal(player_calls.length, 2);
  assert.equal(player_calls[1].url, 'https://music.example.invalid/trial.mp3');
});

test('listen resolves metadata through song_detail when the track is not cached', async t => {
  const { service, calls } = await fixture(t);
  const result = await service.listen('99');

  assert.equal(result.id, '99');
  assert.equal(result.name, '歌曲 99');
  assert.equal(calls.filter(call => call.route === 'song_detail').length, 1);
  assert.equal(calls.find(call => call.route === 'song_detail').args.ids, '99');
});

test('evaluate persists the score to history and writes markdown + events.jsonl', async t => {
  const { service, log_dir } = await fixture(t);
  const day = await service.prepare();
  const text = '歌词写的是雨夜，适合通勤路上听；没有直接听到音频。';
  const result = await service.evaluate(day.tracks[0].id, 5, text);

  assert.equal(result.ok, true);
  assert.equal(result.id, '1');
  assert.equal(result.log_dir, log_dir);
  assert.equal(dirname(result.log_path), log_dir);
  assert.match(result.log_path, /\.md$/);

  const report = await readFile(result.log_path, 'utf8');
  assert.match(report, /## 听歌评价/);
  assert.match(report, /歌曲 1/);
  assert.match(report, /歌手 1/);
  assert.match(report, /（5\/5）/);
  assert.match(report, /静默播放/);
  assert.ok(report.includes(text));

  const evaluation = (await read_events(log_dir)).find(event => event.type === 'evaluation');
  assert.ok(evaluation, 'evaluation event should be logged');
  assert.equal(evaluation.track_id, '1');
  assert.equal(evaluation.score, 5);
  assert.equal(evaluation.chars, text.length);
  assert.equal(evaluation.log_path, result.log_path);

  const stored = (await service.load()).days[day.date].evaluations['1'];
  assert.equal(stored.score, 5);
  assert.equal(stored.evaluation, text);
  assert.equal(stored.silent_playback, true);
  assert.equal(stored.name, '歌曲 1');
  assert.deepEqual(stored.artists, ['歌手 1']);
  assert.equal(stored.at, fixed_now.toISOString());
});

test('evaluate validates the rating and the evaluation text', async t => {
  const { service } = await fixture(t);
  await service.prepare();

  for (const rating of [0, 6, -1, 'abc', Number.NaN]) {
    await assert.rejects(service.evaluate('1', rating, '评价内容'), /评分必须是 1 到 5/);
  }
  await assert.rejects(service.evaluate('1', 5, ''), /评价内容不能为空/);
  await assert.rejects(service.evaluate('1', 5, '   '), /评价内容不能为空/);
  await assert.rejects(service.evaluate('1', 5, '字'.repeat(1201)), /最多 1200 字/);
  await assert.rejects(service.evaluate('0', 5, '评价内容'), /歌曲 ID 必须是正整数/);

  const result = await service.evaluate('2', undefined, '只写文字不打分。');
  const report = await readFile(result.log_path, 'utf8');
  assert.match(report, /听歌评价 · 歌曲 2/);
  assert.equal(report.includes('/5'), false);
  const stored = (await service.load()).days['2026-10-26'].evaluations['2'];
  assert.equal(stored.score, null);
});

test('evaluate surfaces a log-directory failure after persisting the history entry', async t => {
  const { service, data_dir, settings } = await fixture(t, { authenticated: false });
  const blocker = join(data_dir, 'blocked');
  await writeFile(blocker, 'not a directory');
  settings.log_dir = join(blocker, 'logs');

  await assert.rejects(
    service.evaluate('1', 5, '写不进日志目录的评价'),
    error => error.code === 'LOG_WRITE_FAILED' && /写入日志目录失败/.test(error.message),
  );

  const stored = (await service.load()).days['2026-10-26'].evaluations['1'];
  assert.equal(stored.score, 5, 'history entry should still be saved before the log failure');
});

test('save_recommendations rejects invalid selections before creating a report', async t => {
  const { service, log_dir } = await fixture(t);
  const day = await service.prepare();
  const selected = recommendations_for(day.tracks);

  await assert.rejects(service.save_recommendations(selected.slice(0, 2)), /需要选出 3 首/);
  await assert.rejects(service.save_recommendations([{ ...selected[0], id: '999' }, ...selected.slice(1)]), /候选/);
  await assert.rejects(service.save_recommendations([selected[0], selected[0], selected[2]]), /重复/);
  await assert.rejects(service.save_recommendations([{ ...selected[0], reason: '   ' }, ...selected.slice(1)]), /理由/);

  assert.deepEqual(await list_md(log_dir), [], 'no report should be written for rejected selections');
  const stored = await service.load();
  assert.equal(stored.days[day.date].completed_at, undefined);

  const unprepared = await fixture(t);
  await assert.rejects(unprepared.service.save_recommendations([]), /请先准备今日候选/);
});

test('save_recommendations writes the daily report and is idempotent once completed', async t => {
  const { service, service_options, log_dir } = await fixture(t, { settings: { description: '雨天通勤' } });
  const day = await service.prepare();
  const selected = recommendations_for(day.tracks);

  const first = await service.save_recommendations(selected);
  assert.equal(first.cached, false);
  assert.equal(first.date, '2026-10-26');
  assert.equal(first.log_dir, log_dir);
  assert.equal(dirname(first.report_path), log_dir);
  assert.deepEqual(first.recommendations, selected);

  const report = await readFile(first.report_path, 'utf8');
  assert.match(report, /## 今日推荐/);
  assert.match(report, /推荐依据：雨天通勤/);
  assert.match(report, /\[歌曲 1\]\(https:\/\/music\.163\.com\/#\/song\?id=1\)/);
  for (const item of selected) assert.ok(report.includes(item.reason));

  const recommendation = (await read_events(log_dir)).find(event => event.type === 'recommendation');
  assert.ok(recommendation, 'recommendation event should be logged');
  assert.equal(recommendation.date, '2026-10-26');
  assert.deepEqual(recommendation.ids, selected.map(item => item.id));
  assert.equal(recommendation.log_path, first.report_path);

  const stored = (await service.load()).days[day.date];
  assert.equal(stored.completed_at, fixed_now.toISOString());
  assert.equal(stored.report_path, first.report_path);
  assert.deepEqual(stored.recommendations, selected);

  const second = await new MusicService(service_options).save_recommendations([]);
  assert.equal(second.cached, true);
  assert.equal(second.report_path, first.report_path);
  assert.deepEqual(second.recommendations, selected);
  assert.equal(await readFile(second.report_path, 'utf8'), report, 'cached calls must not rewrite the report');
});

test('cancellation leaves no partial daily selection or report', async t => {
  const controller = new AbortController();
  const { service, log_dir } = await fixture(t, {
    settings: { description: '雨夜' },
    respond(route) {
      if (route === 'cloudsearch') {
        controller.abort();
        throw controller.signal.reason;
      }
    },
  });

  await assert.rejects(service.plan(undefined, controller.signal), { name: 'AbortError' });
  assert.deepEqual((await service.load()).days, {});
  assert.deepEqual(await list_md(log_dir), [], 'cancelled planning must not leave a report');
  await assert.rejects(service.save_recommendations([], controller.signal), { name: 'AbortError' });
});

test('an already-aborted signal neither reuses cached data nor starts playback', async t => {
  const { service, calls, player_calls } = await fixture(t);
  const day = await service.prepare();
  await service.listen(day.tracks[0].id);

  const controller = new AbortController();
  controller.abort();
  const previous_calls = calls.length;

  await assert.rejects(service.status(controller.signal), { name: 'AbortError' });
  await assert.rejects(service.plan(undefined, controller.signal), { name: 'AbortError' });
  await assert.rejects(service.listen(day.tracks[0].id, controller.signal), { name: 'AbortError' });
  await assert.rejects(service.save_recommendations([], controller.signal), { name: 'AbortError' });

  assert.equal(calls.length, previous_calls, 'aborted calls must not hit the api');
  assert.equal(player_calls.length, 1, 'aborted calls must not replay audio');
});

test('prepare filters recent recommendations and disliked tracks', async t => {
  const { service, data_dir } = await fixture(t, { songs: make_songs(10) });
  await writeFile(join(data_dir, 'history.json'), JSON.stringify({
    version: 1,
    days: {
      '2026-10-20': { date: '2026-10-20', tracks: [], recommendations: [{ id: '2', reason: 'recent' }], evaluations: {} },
    },
    preferences: { '3': 'dislike' },
  }));

  const day = await service.prepare();
  assert.equal(day.date, '2026-10-26');
  assert.equal(day.source, '网易云每日推荐');
  assert.equal(day.recommendation_count, 3);
  assert.equal(day.cached, false);
  assert.equal(day.tracks.length, 5);
  assert.ok(!day.tracks.some(track => track.id === '2'), 'recent recommendation should be excluded');
  assert.ok(!day.tracks.some(track => track.id === '3'), 'disliked track should be excluded');
  assert.deepEqual(day.tracks.map(track => track.id), ['1', '4', '5', '6', '7']);
});

test('invalid local data is reported without silently replacing the original history', async t => {
  const { service, data_dir } = await fixture(t);
  const history_path = join(data_dir, 'history.json');
  await writeFile(history_path, '{broken-json');

  await assert.rejects(service.prepare(), /本地音乐数据无法读取/);
  assert.equal(await readFile(history_path, 'utf8'), '{broken-json');
});

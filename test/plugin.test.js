import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, daily_prompt } from '../index.js';

function harness({ schedule_available = true } = {}) {
  const definitions = new Map();
  const rows = new Map();
  const counts = { create: 0, update: 0, delete: 0 };
  const ctx = {
    tools: { register(definition) { definitions.set(definition.name, definition); } },
    schedule: {
      async list({ sessionId }) { return [...rows.values()].filter(row => row.session_id === sessionId).map(row => row.record); },
      async create(session_id, request) {
        counts.create++;
        const record = { id: `task-${counts.create}`, kind: 'daily', title: request.title, prompt: request.prompt,
          time: `${request.daily.time}.000`, timeZone: request.daily.time_zone, scheduledAt: '2099-01-01T13:00:00Z' };
        rows.set(record.id, { session_id, record });
        return record;
      },
      async update({ sessionId, id, expected, title, prompt, change }) {
        counts.update++;
        const row = rows.get(id);
        assert.equal(row.session_id, sessionId);
        assert.deepEqual(row.record, expected);
        row.record = { ...row.record, title, prompt, time: `${change.daily.time}.000`, timeZone: change.daily.time_zone };
        return { id, updated: true, record: row.record };
      },
      async delete({ sessionId, id }) {
        assert.equal(rows.get(id).session_id, sessionId);
        counts.delete++;
        rows.delete(id);
        return { id, deleted: true };
      },
    },
    inject(names, action) {
      assert.deepEqual(names, ['schedule']);
      if (schedule_available) action(ctx);
    },
  };
  apply(ctx);
  function call(name, args = {}, session_id = 'current-session') {
    return definitions.get(name).execute(args, { agent: { session: { id: session_id } }, signal: new AbortController().signal });
  }
  return { definitions, rows, counts, call };
}

test('registers raw JSON Schema tools and keeps music tools available without Schedule', () => {
  const available = harness();
  assert.equal(available.definitions.size, 9);
  for (const definition of available.definitions.values()) {
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.parameters.additionalProperties, false);
    assert.ok(Array.isArray(definition.parameters.required));
    assert.equal(definition.output.schema.type, 'object');
    assert.deepEqual(definition.output.render({}, { status: 'ready' }), [{ type: 'text', text: '{"status":"ready"}' }]);
  }
  const without_schedule = harness({ schedule_available: false });
  assert.equal(without_schedule.definitions.size, 7);
  assert.ok(without_schedule.definitions.has('netease_daily_prepare'));
  assert.ok(!without_schedule.definitions.has('netease_schedule_enable'));
});

test('enabling concurrently creates once and updating preserves task id', async () => {
  const { call, rows, counts } = harness();
  const [first, second] = await Promise.all([call('netease_schedule_enable'), call('netease_schedule_enable')]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.schedule.id, second.schedule.id);
  assert.equal(counts.create, 1);
  assert.equal(rows.size, 1);
  assert.equal(first.schedule.time, '21:00:00.000');
  assert.equal(first.schedule.timeZone, 'Asia/Shanghai');
  const updated = await call('netease_schedule_enable', { time: '20:30:00' });
  assert.equal(updated.schedule.id, first.schedule.id);
  assert.equal(updated.schedule.time, '20:30:00.000');
  assert.equal(counts.create, 1);
});

test('disable isolates own task and caller session; no session id can be passed in args', async () => {
  const { call, rows } = harness();
  const own = await call('netease_schedule_enable');
  const other = await call('netease_schedule_enable', {}, 'another-session');
  rows.set('unrelated', { session_id: 'current-session', record: { id: 'unrelated', prompt: '饮水提醒' } });
  const spoof = await call('netease_schedule_disable', { session_id: 'another-session' });
  assert.equal(spoof.code, 'invalid_arguments');
  const disabled = await call('netease_schedule_disable');
  assert.deepEqual(disabled.deleted_ids, [own.schedule.id]);
  assert.ok(rows.has(other.schedule.id));
  assert.ok(rows.has('unrelated'));
});

test('validates tool arguments before service calls and rejects invalid timing', async () => {
  const { call, counts, definitions } = harness();
  for (const [name, args] of [
    ['netease_preview', { track_id: '../song' }],
    ['netease_feedback', { track_id: '123', preference: 'anything' }],
    ['netease_daily_save', { recommendations: [{ id: '123', reason: 'x' }, { id: '123', reason: 'y' }] }],
    ['netease_daily_save', { recommendations: [{ id: '123', reason: '' }] }],
    ['netease_schedule_enable', { time: '25:00:00' }],
    ['netease_schedule_enable', { time_zone: 'invalid-time-zone' }],
  ]) {
    assert.equal((await call(name, args)).code, 'invalid_arguments');
  }
  assert.equal(counts.create, 0);
  assert.equal((await definitions.get('netease_schedule_enable').execute({}, {})).code, 'invalid_arguments');
  assert.match(daily_prompt(), /不声称自己听出了/);
  assert.match(daily_prompt(), /必须先调用 netease_daily_save/);
});

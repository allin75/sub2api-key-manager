import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateDailyUsage, cooldownState, dateRanges, hashKey, isWeeklyResetDue, weeklyResetState } from '../src/utils.js';

test('hashKey produces stable non-plaintext identifier', () => {
  const key = 'sk-example-1234567890';
  assert.equal(hashKey(key), hashKey(key));
  assert.notEqual(hashKey(key), key);
  assert.equal(hashKey(key).length, 64);
});

test('dateRanges returns calendar periods', () => {
  const ranges = dateRanges(new Date('2026-08-27T04:00:00Z'), 'Asia/Shanghai');
  assert.deepEqual(ranges.yesterday, ['2026-08-26', '2026-08-26']);
  assert.deepEqual(ranges.today, ['2026-08-27', '2026-08-27']);
  assert.deepEqual(ranges.week, ['2026-08-24', '2026-08-27']);
  assert.deepEqual(ranges.month, ['2026-08-01', '2026-08-27']);
  assert.deepEqual(ranges.lastMonth, ['2026-07-01', '2026-07-31']);
});

test('aggregateDailyUsage sums costs and requests', () => {
  const result = aggregateDailyUsage([
    { date: '2026-08-26', actual_cost: 1.5, requests: 2 },
    { date: '2026-08-27', cost: 2.25, requests: 3 }
  ], {
    yesterday: ['2026-08-26', '2026-08-26'],
    today: ['2026-08-27', '2026-08-27'],
    week: ['2026-08-24', '2026-08-27']
  });
  assert.deepEqual(result.yesterday, { cost: 1.5, requests: 2 });
  assert.deepEqual(result.today, { cost: 2.25, requests: 3 });
  assert.deepEqual(result.week, { cost: 3.75, requests: 5 });
});

test('cooldown lasts exactly seven days', () => {
  const now = Date.parse('2026-08-27T00:00:00Z');
  const active = cooldownState('2026-08-26T00:00:00Z', now);
  assert.equal(active.active, true);
  assert.equal(active.remainingMs, 6 * 24 * 60 * 60 * 1000);
  assert.equal(cooldownState('2026-08-20T00:00:00Z', now).active, false);
});

test('weekly reset targets Monday at 06:00 Shanghai time', () => {
  const state = weeklyResetState(new Date('2026-08-27T02:00:00Z'), 'Asia/Shanghai');
  assert.equal(state.nextResetAt, '2026-08-30T22:00:00.000Z');
});

test('weekly reset runs once on Monday after 06:00', () => {
  const monday = new Date('2026-08-30T22:05:00Z');
  assert.equal(isWeeklyResetDue(null, monday, 'Asia/Shanghai'), true);
  assert.equal(isWeeklyResetDue('2026-08-30T22:01:00Z', monday, 'Asia/Shanghai'), false);
  assert.equal(isWeeklyResetDue(null, new Date('2026-08-30T21:59:00Z'), 'Asia/Shanghai'), false);
});

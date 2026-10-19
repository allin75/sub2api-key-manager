import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { rateLimitNextCheck } from '../src/budget-policy.js';

let sequence = 0;
async function fixture(handler, operation) {
  const calls = [];
  const mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://localhost');
    calls.push({ url, method: req.method, body: JSON.parse(raw || '{}'), at: Date.now() });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v1/auth/login') return res.end(JSON.stringify({ access_token: 'mock-only', expires_in: 3600 }));
    await handler({ req, res, url, body: JSON.parse(raw || '{}') });
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const prior = { ...process.env };
  const names = ['SUB2API_BASE_URL', 'SUB2API_EMAIL', 'SUB2API_PASSWORD', 'UPSTREAM_MIN_INTERVAL_MS'];
  Object.assign(process.env, { SUB2API_BASE_URL: `http://127.0.0.1:${mock.address().port}`, SUB2API_EMAIL: 'mock@example.invalid', SUB2API_PASSWORD: 'mock', UPSTREAM_MIN_INTERVAL_MS: '0' });
  const load = () => import(`../src/sub2api.js?batch-test=${++sequence}`);
  try { await operation(await load(), calls, load); }
  finally {
    for (const name of names) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; }
    mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  }
}

test('rate limits skip to the next daytime whole hour and respect seconds or HTTP-date Retry-After', () => {
  const next = (date, header) => rateLimitNextCheck(new Date(date), header);
  assert.equal(next('2026-10-19T09:30:00+08:00'), '2026-10-19T02:00:00.000Z');
  assert.equal(next('2026-10-19T09:30:00+08:00', '7200'), '2026-10-19T04:00:00.000Z');
  assert.equal(next('2026-10-19T09:30:00+08:00', 'Mon, 19 Oct 2026 03:00:00 GMT'), '2026-10-19T03:00:00.000Z');
  assert.equal(next('2026-10-19T21:59:00+08:00', '120'), '2026-10-20T00:00:00.000Z');
  assert.equal(next('2026-12-31T21:00:00+08:00', 'invalid'), '2027-01-01T00:00:00.000Z');
});

test('one shared list serves concurrent scopes and successful writes patch the in-memory snapshot', async () => {
  const key = { id: 1, key: 'sk-mock-only-123456789', quota: 100, quota_used: 1, status: 'active' };
  await fixture(({ res, url, body }) => {
    if (url.pathname === '/api/v1/keys') return res.end(JSON.stringify({ data: { items: [key], pages: 1 } }));
    Object.assign(key, body); res.end(JSON.stringify({ data: key }));
  }, async (upstream, calls) => {
    const results = await Promise.all([upstream.listAllKeys(), upstream.listAllKeys(), upstream.listAllKeys()]);
    assert.equal(calls.filter(call => call.url.pathname === '/api/v1/keys').length, 1);
    results[0][0].quota = 999;
    assert.equal((await upstream.listAllKeys())[0].quota, 100);
    await upstream.withKeySnapshot(async () => {
      await upstream.updateKeyQuota(1, 200);
      await upstream.updateKeyStatus(1, 'inactive');
      assert.equal((await upstream.listAllKeys())[0].quota, 200);
      assert.equal((await upstream.listAllKeys())[0].status, 'inactive');
    });
    assert.equal(calls.filter(call => call.url.pathname === '/api/v1/keys').length, 1);
    await upstream.listAllKeys({ force: true });
    assert.equal(calls.filter(call => call.url.pathname === '/api/v1/keys').length, 2);
  });
});

test('429 including non-JSON responses persists a global cooldown and a fresh module cannot bypass it', async () => {
  let persisted;
  await fixture(({ res }) => { res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '7200' }); res.end('limited'); }, async (upstream, calls, load) => {
    const adapter = { read: () => persisted, write: async until => { persisted = until; } };
    upstream.configureSyncState(adapter);
    await assert.rejects(upstream.listAllKeys(), error => error.status === 429 && error.retryAt === persisted);
    assert.ok(Date.parse(persisted) >= Date.now() + 2 * 3600000 - 1000);
    const before = calls.length;
    await assert.rejects(upstream.getUsageForKey(1), error => error.status === 429);
    const restarted = await load(); restarted.configureSyncState(adapter);
    await assert.rejects(restarted.listAllKeys(), error => error.status === 429);
    await assert.rejects(restarted.updateKeyQuota(1, 10), error => error.status === 429);
    assert.equal(calls.length, before);
  });
});

test('incremental detail pages retain late new IDs and reread the complete boundary page', async () => {
  const record = (id, at = '2026-10-19T01:00:00Z') => ({ id, api_key_id: 7, created_at: at, actual_cost: 1 });
  const pages = [[record(9, '2026-09-01T00:00:00Z'), record(8), record(7)], [record(7), record(5), record(4)]];
  await fixture(({ res, url }) => {
    assert.equal(url.searchParams.get('sort_order'), 'desc');
    res.end(JSON.stringify({ data: { items: pages[Number(url.searchParams.get('page')) - 1], pages: 50 } }));
  }, async (upstream, calls) => {
    const records = await upstream.getUsageRecords(7, '2026-09-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z', { afterId: 5 });
    assert.deepEqual(records.map(row => row.id), ['9', '8', '7', '5', '4']);
    assert.equal(calls.filter(call => call.url.pathname === '/api/v1/usage').length, 2);
  });
});

test('incremental detail reads fail closed on unexpected sorting instead of skipping unseen pages', async () => {
  await fixture(({ res }) => res.end(JSON.stringify({ data: { items: [1, 2].map(id => ({ id, api_key_id: 7, created_at: '2026-10-19T00:00:00Z', actual_cost: 1 })), pages: 2 } })), async upstream => {
    await assert.rejects(upstream.getUsageRecords(7, '2026-09-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z', { afterId: 1 }), /排序/);
  });
});

test('an incomplete key list is rejected and never becomes a shared cache hit', async () => {
  await fixture(({ res }) => res.end(JSON.stringify({ data: { items: [], pages: 2 } })), async (upstream, calls) => {
    await assert.rejects(upstream.listAllKeys(), /分页/);
    await assert.rejects(upstream.listAllKeys(), /分页/);
    assert.equal(calls.filter(call => call.url.pathname === '/api/v1/keys').length, 2);
  });
});

test('all endpoint types share a paced queue and simultaneous reads share one login', async () => {
  await fixture(({ res, url }) => res.end(JSON.stringify({ data: { id: Number(url.pathname.split('/').at(-1)), key: 'sk-mock-only' } })), async (original, calls, load) => {
    process.env.UPSTREAM_MIN_INTERVAL_MS='35';
    const upstream=await load();
    await Promise.all([upstream.getKey(1),upstream.getKey(2),upstream.getKey(3)]);
    assert.equal(calls.filter(call=>call.url.pathname==='/api/v1/auth/login').length,1);
    for(let i=1;i<calls.length;i++)assert.ok(calls[i].at-calls[i-1].at>=28);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { noticeInput, validTargetedNotices } from '../src/announcement.js';

test('targeted notices validate bounded plain text and unique records without removing line breaks', () => {
  assert.deepEqual(noticeInput({ title: '  维护通知  ', body: ' 第一行\n<script>文本</script> ' }), { title: '维护通知', body: '第一行\n<script>文本</script>' });
  for (const body of [null, {}, { title: 1, body: 'text' }, { title: 'title', body: false }, { title: ' '.repeat(5), body: 'text' }, { title: 'x'.repeat(101), body: 'text' }, { title: 'title', body: 'x'.repeat(4001) }, { title: 'title\n', body: '\u0000' }, { title: 'bad\u0000', body: 'text' }]) assert.throws(() => noticeInput(body));
  const account = { id: 'first' };
  const notice = { id: 'notice', accessKeyId: account.id, title: 'title', body: 'body', publishedAt: '2026-09-30T00:00:00.000Z', acknowledgedAt: null };
  assert.equal(validTargetedNotices([notice], [account]), true);
  for (const invalid of [null, {}, [notice, notice], [{ ...notice, accessKeyId: 'other' }], [{ ...notice, acknowledgedAt: 'invalid' }], [{ ...notice, publishedAt: 'invalid' }], [{ ...notice, body: '' }]]) assert.equal(validTargetedNotices(invalid, [account]), false);
});

test('card notices enforce recipient isolation, superadmin writes, CSRF, persistence and manual deletion', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2api-targeted-notices-'));
  const mock = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ code: 0, data: request.url === '/api/v1/auth/login' ? { access_token: 'mock', expires_in: 3600 } : { items: [], pages: 1 } }));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  let child;
  let base;
  const start = async () => {
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, PORT: '0', DATA_DIR: directory, ADMIN_PASSWORD: 'notice-first', SUPERADMIN_PASSWORD: 'notice-root', COOKIE_SECURE: 'false', SUB2API_BASE_URL: `http://127.0.0.1:${mock.address().port}`, SUB2API_EMAIL: 'mock@example.invalid', SUB2API_PASSWORD: 'mock' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timeout')), 10000);
      child.stdout.on('data', chunk => {
        const match = chunk.toString().match(/listening on port (\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); });
    });
    base = `http://127.0.0.1:${port}`;
  };
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    child = null;
  };
  const login = async password => {
    const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password }) });
    assert.equal(response.status, 200);
    return { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  const request = (session, url, method = 'GET', body, csrf = true, origin = base) => fetch(base + url, {
    method, headers: { Cookie: session.cookie, Origin: origin, 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': session.csrfToken } : {}) }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const read = async session => (await (await request(session, '/api/notices')).json()).notices;
  try {
    await start();
    let root = await login('notice-root');
    let first = await login('notice-first');
    const created = await request(root, '/api/access-keys', 'POST', { secret: 'notice-second', limit: 10 });
    assert.equal(created.status, 201);
    let second = await login('notice-second');
    const firstRoute = `/api/access-keys/${first.accessKey.id}/notices`;
    const secondRoute = `/api/access-keys/${second.accessKey.id}/notices`;
    const input = { title: '维护通知', body: '第一行\n<script>只是文本</script>' };
    assert.equal((await fetch(base + firstRoute, { method: 'POST' })).status, 401);
    assert.equal((await request(first, firstRoute, 'POST', input)).status, 403);
    assert.equal((await request(second, firstRoute)).status, 403);
    assert.equal((await request(root, firstRoute, 'POST', input, false)).status, 403);
    assert.equal((await request(root, firstRoute, 'POST', input, true, 'https://other.example.invalid')).status, 403);
    assert.equal((await request(root, firstRoute, 'POST', null)).status, 400);
    assert.equal((await request(root, '/api/access-keys/missing/notices', 'POST', input)).status, 404);
    const published = await request(root, firstRoute, 'POST', { ...input, accessKeyId: second.accessKey.id });
    assert.equal(published.status, 201);
    const notice = (await published.json()).notice;
    assert.equal(notice.accessKeyId, first.accessKey.id);
    assert.equal(notice.acknowledged, false);
    assert.equal((await read(first))[0].body, input.body);
    assert.deepEqual(await read(second), []);
    assert.deepEqual(await read(root), []);
    assert.equal((await (await request(second, `/api/notices?accessKeyId=${first.accessKey.id}`)).json()).notices.length, 0);
    assert.equal((await request(second, `/api/notices/${notice.id}/acknowledge`, 'POST')).status, 404);
    assert.equal((await request(root, `/api/notices/${notice.id}/acknowledge`, 'POST')).status, 404);
    assert.equal((await request(first, `/api/notices/${notice.id}/acknowledge`, 'POST', {}, false)).status, 403);
    assert.equal((await request(first, `${firstRoute}/${notice.id}`, 'DELETE')).status, 403);
    assert.equal((await request(root, `${secondRoute}/${notice.id}`, 'DELETE')).status, 404);
    const confirmations = await Promise.all([request(first, `/api/notices/${notice.id}/acknowledge`, 'POST'), request(first, `/api/notices/${notice.id}/acknowledge`, 'POST')]);
    assert.ok(confirmations.every(response => response.status === 200));
    const timestamp = (await read(first))[0].acknowledgedAt;
    await request(first, `/api/notices/${notice.id}/acknowledge`, 'POST');
    assert.equal((await read(first))[0].acknowledgedAt, timestamp);
    assert.equal((await request(root, `/api/refresh-policy?accessKeyId=${first.accessKey.id}`, 'PUT', { weeklyResetEnabled: false })).status, 200);
    assert.equal((await read(first))[0].acknowledgedAt, timestamp);
    assert.equal((await request(first, '/api/login-secret', 'PUT', { secret: 'notice-renamed' })).status, 200);
    first = await login('notice-renamed');
    assert.equal(first.notices[0].id, notice.id);
    assert.equal(first.notices[0].acknowledged, true);
    const following = await request(root, firstRoute, 'POST', { title: '新的安排', body: '第二条公告' });
    const followingId = (await following.json()).notice.id;
    assert.deepEqual((await read(first)).map(item => item.id), [followingId, notice.id]);
    await stop(); await start();
    root = await login('notice-root'); first = await login('notice-renamed'); second = await login('notice-second');
    assert.equal(first.notices.length, 2);
    assert.equal(first.notices[1].acknowledgedAt, timestamp);
    assert.equal(second.notices.length, 0);
    assert.equal((await request(root, `${firstRoute}/${notice.id}`, 'DELETE', undefined, false)).status, 403);
    assert.equal((await request(root, `${firstRoute}/${notice.id}`, 'DELETE')).status, 200);
    assert.equal((await read(first)).length, 1);
    assert.equal((await request(first, `/api/notices/${notice.id}/acknowledge`, 'POST')).status, 404);
    assert.equal((await request(root, `${firstRoute}/${followingId}`, 'DELETE')).status, 200);
    assert.deepEqual(await read(first), []);
    const racing = await request(root, secondRoute, 'POST', { title: '并发删除', body: '确认不能重新创建已删除公告' });
    const racingId = (await racing.json()).notice.id;
    const raceResponses = await Promise.all([request(second, `/api/notices/${racingId}/acknowledge`, 'POST'), request(root, `${secondRoute}/${racingId}`, 'DELETE')]);
    assert.ok([200, 404].includes(raceResponses[0].status));
    assert.equal(raceResponses[1].status, 200);
    assert.deepEqual(await read(second), []);
    await stop(); await start();
    assert.deepEqual((await login('notice-renamed')).notices, []);
  } finally {
    await stop(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { announcement, announcementView } from '../src/announcement.js';

test('only the current announcement version counts as acknowledged', () => {
  assert.equal(announcementView().acknowledged, false);
  assert.equal(announcementView({ version: 'previous-version' }).acknowledged, false);
  assert.equal(announcementView({ version: announcement.version }).acknowledged, true);
  assert.equal(announcementView().items.length, 4);
});

test('announcement acknowledgement is authenticated, isolated, idempotent and survives rename and restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2api-announcement-'));
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
      env: { ...process.env, PORT: '0', DATA_DIR: directory, ADMIN_PASSWORD: 'first', SUPERADMIN_PASSWORD: 'root-test', COOKIE_SECURE: 'false', SUB2API_BASE_URL: `http://127.0.0.1:${mock.address().port}`, SUB2API_EMAIL: 'mock@example.invalid', SUB2API_PASSWORD: 'mock' },
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
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    child = null;
  };
  const login = async password => {
    const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password }) });
    assert.equal(response.status, 200);
    return { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  const request = (session, url, method = 'GET', body, csrf = true, origin = base) => fetch(base + url, {
    method,
    headers: { Cookie: session.cookie, Origin: origin, 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': session.csrfToken } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const readNotice = async session => (await (await request(session, '/api/session')).json()).announcement;
  try {
    await start();
    let first = await login('first');
    let root = await login('root-test');
    assert.equal(first.announcement.acknowledged, false);
    assert.equal(root.announcement.acknowledged, false);
    assert.equal((await fetch(`${base}/api/announcement/acknowledge`, { method: 'POST' })).status, 401);
    const body = { version: announcement.version };
    assert.equal((await request(first, '/api/announcement/acknowledge', 'POST', body, false)).status, 403);
    assert.equal((await request(first, '/api/announcement/acknowledge', 'POST', body, true, 'https://other.example.invalid')).status, 403);
    assert.equal((await request(first, '/api/announcement/acknowledge', 'POST', { version: 'old' })).status, 409);
    assert.equal((await request(first, '/api/announcement/acknowledge', 'POST', null)).status, 409);
    assert.equal((await request(root, '/api/access-keys', 'POST', { secret: 'second', limit: 10 })).status, 201);
    let second = await login('second');
    const confirmed = await request(first, '/api/announcement/acknowledge', 'POST', { ...body, accessKeyId: second.accessKey.id });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).announcement.acknowledged, true);
    assert.equal((await readNotice(second)).acknowledged, false);
    assert.equal((await readNotice(root)).acknowledged, false);
    assert.equal((await login('first')).announcement.acknowledged, true);
    const identity = `access:${first.accessKey.id}`;
    const readState = async () => JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
    const before = await readState();
    const responses = await Promise.all([
      request(first, '/api/announcement/acknowledge', 'POST', body),
      request(root, '/api/announcement/acknowledge', 'POST', body)
    ]);
    assert.ok(responses.every(response => response.status === 200));
    const after = await readState();
    assert.deepEqual(after.announcementAcknowledgements[identity], before.announcementAcknowledgements[identity]);
    assert.equal(after.announcementAcknowledgements.superadmin.version, announcement.version);
    assert.deepEqual(after.accessKeys, before.accessKeys);
    assert.equal((await request(first, '/api/login-secret', 'PUT', { secret: 'first-renamed' })).status, 200);
    first = await login('first-renamed');
    assert.equal(first.announcement.acknowledged, true);
    await stop();
    await start();
    first = await login('first-renamed');
    root = await login('root-test');
    second = await login('second');
    assert.equal(first.announcement.acknowledged, true);
    assert.equal(root.announcement.acknowledged, true);
    assert.equal(second.announcement.acknowledged, false);
    await stop();
    const previousVersion = await readState();
    previousVersion.announcementAcknowledgements[identity].version = 'previous-version';
    await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(previousVersion));
    await start();
    first = await login('first-renamed');
    assert.equal(first.announcement.acknowledged, false);
    assert.equal((await request(first, '/api/announcement/acknowledge', 'POST', body)).status, 200);
    assert.equal((await readNotice(first)).acknowledged, true);
  } finally {
    await stop();
    mock.closeAllConnections();
    await new Promise(resolve => mock.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

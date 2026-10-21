import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createPreviewServer } from '../docs/previews/today-tile-preview-server.mjs';
import { yesterdayEffectFrame, yesterdayEffectDuration } from '../docs/previews/yesterday-effect.mjs';

test('preview polling fields match cached budget exactly to avoid five-second tile rebuilds', async () => {
  const server = createPreviewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const view = await (await fetch(`${base}/api/keys`)).json();
    for (let i = 0; i < 3; i++) {
      const status = await (await fetch(`${base}/api/sync-status`)).json();
      for (const field of ['lastSuccessAt', 'error', 'rateLimitedUntil']) {
        assert.ok(Object.hasOwn(view.budget, field));
        assert.equal(status[field], view.budget[field]);
      }
    }
    assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST' })).status, 405);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('yesterday preview effect uses strict thresholds and a ten-second cycle', () => {
  assert.equal(yesterdayEffectDuration, 10000);
  for (const cost of [0, 10, NaN, Infinity]) assert.equal(yesterdayEffectFrame(cost, 1000, 1000), null);
  assert.deepEqual(yesterdayEffectFrame(10.001, 1000, 1000), { tone: 'warm', delayMs: 0 });
  assert.deepEqual(yesterdayEffectFrame(20, 1000, 2000), { tone: 'warm', delayMs: -1000 });
  assert.deepEqual(yesterdayEffectFrame(20.001, 1000, 5999), { tone: 'hot', delayMs: -4999 });
  assert.equal(yesterdayEffectFrame(25, 1000, 6000).delayMs, -5000);
  assert.equal(yesterdayEffectFrame(25, 1000, 9000).delayMs, -8000);
  assert.equal(yesterdayEffectFrame(25, 1000, 11000).delayMs, 0);
});

test('yesterday preview resumes active or quiet phases after replacement instead of restarting', () => {
  const start = 100;
  assert.equal(yesterdayEffectFrame(25, start, 100).delayMs, 0);
  assert.equal(yesterdayEffectFrame(25, start, 3100).delayMs, -3000);
  assert.equal(yesterdayEffectFrame(25, start, 5100).delayMs, -5000);
  assert.equal(yesterdayEffectFrame(25, start, 60100).delayMs, 0);
  assert.equal(yesterdayEffectFrame(25, start, 60500).delayMs, -400);
});

test('preview orbit clocks stay on the persistent grid and inherit into replacement tiles', async () => {
  const css = await fs.readFile(new URL('../docs/previews/today-tile-glow.css', import.meta.url), 'utf8');
  for (const tone of ['warm', 'hot']) {
    assert.match(css, new RegExp(`@property --usage-${tone}-angle\\s*\\{[^}]*inherits:true;`));
    assert.match(css, new RegExp(`@keyframes usage-today-${tone}-orbit\\s*\\{\\s*from \\{ --usage-${tone}-angle:0deg; \\}\\s*to \\{ --usage-${tone}-angle:360deg; \\}`));
  }
  assert.match(css, /\.key-grid\s*\{\s*animation:usage-today-warm-orbit 4\.8s linear infinite,usage-today-hot-orbit 3\.4s linear infinite;/);
  assert.match(css, /prefers-reduced-motion:reduce\)\s*\{\s*\.key-grid\s*\{ animation:none;/);
  assert.doesNotMatch(css, /animation:usage-today-tile-orbit/);
});

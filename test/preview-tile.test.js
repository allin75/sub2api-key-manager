import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createPreviewServer } from '../docs/previews/today-tile-preview-server.mjs';

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

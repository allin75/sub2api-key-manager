import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('store persists only a hash and masked key', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2api-manager-test-'));
  process.env.DATA_DIR = directory;
  const store = await import(`../src/store.js?test=${Date.now()}`);
  const customKey = 'sk-private-example-1234567890';
  try {
    await store.loadStore();
    await store.addConfiguredKey(customKey);
    const persisted = await fs.readFile(path.join(directory, 'state.json'), 'utf8');
    assert.equal(persisted.includes(customKey), false);
    assert.equal(JSON.parse(persisted).configuredKeys[0].keyHash.length, 64);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

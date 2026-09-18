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

test('v2 migration preserves keys/reset records and leaves budget disabled', async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sub2api-migrate-'));
  process.env.DATA_DIR=directory;
  const legacy={version:2,configuredKeys:[{id:'one',keyHash:'abc',maskedKey:'sk-***'}],lastResetAt:'2026-09-14T00:00:00Z',resetOperation:null};
  try {
    await fs.writeFile(path.join(directory,'state.json'),JSON.stringify(legacy));
    const store=await import(`../src/store.js?migration=${Date.now()}`);
    await store.loadStore();
    const state=store.getState();assert.equal(state.version,3);assert.equal(state.budget.limit,null);
    assert.deepEqual(state.configuredKeys,legacy.configuredKeys);assert.equal(state.lastResetAt,legacy.lastResetAt);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'state.json.v2-backup'),'utf8')),legacy);
    state.budget.limit=100;state.budget.ledger.abc=12500000;state.budget.paused.abc={id:'one',phase:'disabled'};
    await store.saveState(state);
    const reloaded=await import(`../src/store.js?reload=${Date.now()}`);await reloaded.loadStore();assert.deepEqual(reloaded.getState(),state);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

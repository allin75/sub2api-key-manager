import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('sync slots and isolated failure history survive reordering and a disk reload',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sync-store-'));
  const prior=process.env.DATA_DIR;process.env.DATA_DIR=directory;
  try{
    const store=await import(`../src/store.js?sync=${Date.now()}`);
    await store.loadStore();await store.initializeAccessKeys('demo-one');
    const snapshot=store.getState();
    snapshot.accessKeys.push({id:'second',secret:'demo-two',previousSecrets:[],ownedHashes:[],state:structuredClone(store.initialState)});
    await store.saveState(snapshot);await store.initializeSyncSlots();
    const before=store.getState();assert.deepEqual(before.accessKeys.map(entry=>entry.syncSlot),[0,1]);
    const scoped=store.scopedStore(before.accessKeys[0].id),state=scoped.getState();
    state.cache.syncEvents=[{kind:'failed',at:'2026-10-09T01:00:00Z',message:'上游连接或请求超时',code:'UND_ERR_CONNECT_TIMEOUT',stage:'usage-read',keyId:'demo'}];
    await scoped.saveState(state);
    const reordered=store.getState();reordered.accessKeys.reverse();await store.saveState(reordered);await store.initializeSyncSlots();
    const reloaded=await import(`../src/store.js?sync-reload=${Date.now()}`);await reloaded.loadStore();
    assert.deepEqual(reloaded.getState().accessKeys.map(entry=>entry.syncSlot),[1,0]);
    assert.equal(reloaded.scopedStore(before.accessKeys[0].id).getState().cache.syncEvents.length,1);
    assert.equal(reloaded.scopedStore('second').getState().cache.syncEvents,undefined);
    const invalid=reloaded.getState();invalid.accessKeys[0].state.cache.syncEvents=[{kind:'failed',at:'invalid',message:'bad'}];
    await assert.rejects(reloaded.saveState(invalid),/同步记录无效/);
  }finally{if(prior===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=prior;await fs.rm(directory,{recursive:true,force:true});}
});

test('announcement records validate, survive restart and stay intact during scoped budget writes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2api-announcement-store-'));
  const previousDirectory = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  try {
    const store = await import(`../src/store.js?announcement=${Date.now()}`);
    await store.loadStore();
    await store.initializeAccessKeys('store-test');
    const snapshot = store.getState();
    const identity = `access:${snapshot.accessKeys[0].id}`;
    const record = { version: 'current', acknowledgedAt: '2026-09-30T00:00:00.000Z' };
    for (const invalid of [null, [], { [identity]: null }, { [identity]: { ...record, version: '' } }, { [identity]: { ...record, acknowledgedAt: 'invalid' } }]) {
      await assert.rejects(store.saveState({ ...snapshot, announcementAcknowledgements: invalid }), /公告确认记录无效/);
    }
    snapshot.announcementAcknowledgements = { [identity]: record };
    const notice = { id: 'notice-test', accessKeyId: snapshot.accessKeys[0].id, title: '定向通知', body: '第一行\n第二行', publishedAt: '2026-09-30T00:00:00.000Z', acknowledgedAt: null };
    for (const invalid of [null, {}, [notice, notice], [{ ...notice, accessKeyId: 'missing' }], [{ ...notice, acknowledgedAt: 'invalid' }]]) await assert.rejects(store.saveState({ ...snapshot, targetedNotices: invalid }), /定向公告记录无效/);
    snapshot.targetedNotices = [notice];
    await store.saveState(snapshot);
    const scoped = store.scopedStore(snapshot.accessKeys[0].id);
    const budgetState = scoped.getState();
    budgetState.budget.limit = 25;
    await scoped.saveState(budgetState);
    const reloaded = await import(`../src/store.js?announcementReload=${Date.now()}`);
    await reloaded.loadStore();
    assert.deepEqual(reloaded.getState().announcementAcknowledgements, { [identity]: record });
    assert.deepEqual(reloaded.getState().targetedNotices, [notice]);
    assert.equal(reloaded.getState().accessKeys[0].state.budget.limit, 25);
  } finally {
    if (previousDirectory === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDirectory;
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

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

test('login key migration preserves budgets and rename survives restart without restoring the old password', async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sub2api-access-migrate-'));
  process.env.DATA_DIR=directory;
  try {
    const store=await import(`../src/store.js?access=${Date.now()}`);
    await store.loadStore();
    const before=store.getState();
    before.budget.limit=123;
    before.budget.month='2026-09';
    before.budget.ledger.old=10000000;
    before.budget.paused.old={id:'removed',keyHash:'old',phase:'disabled'};
    before.lastResetAt='2026-09-14T00:00:00Z';
    await store.saveState(before);
    await store.initializeAccessKeys('111');
    const next=store.getState(),entry=next.accessKeys[0];
    assert.deepEqual(entry.state,before);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'state.json.v3-backup'),'utf8')),before);
    entry.secret='mise111';entry.previousSecrets=['111'];
    await store.saveState(next);
    const reloaded=await import(`../src/store.js?accessReload=${Date.now()}`);
    await reloaded.loadStore();await reloaded.initializeAccessKeys('111');
    assert.equal(reloaded.getState().accessKeys[0].secret,'mise111');
    assert.deepEqual(reloaded.getState().accessKeys[0].state,before);
    assert.deepEqual(reloaded.getState().accessKeys[0].previousSecrets,['111']);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
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

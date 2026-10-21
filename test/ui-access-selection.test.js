import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const storageKey = 'sub2api-selected-access';

function harness({ selected = 'account-3', ids = ['account-1', 'account-2', 'account-3'], blocked = false } = {}) {
  const saved = new Map(selected ? [[storageKey, selected]] : []);
  const reads = [];
  const state = { role: 'superadmin', selectedAccessId: selected, keys: [], loadVersion: 0 };
  const context = vm.createContext({
    state, selectedAccessStorageKey: storageKey, manualRefreshPending: false,
    sessionStorage: {
      getItem: key => { if (blocked) throw new Error('Blocked'); return saved.get(key); },
      setItem: (key, value) => { if (blocked) throw new Error('Blocked'); saved.set(key, value); },
      removeItem: key => { if (blocked) throw new Error('Blocked'); saved.delete(key); }
    },
    elements: { keyGrid: {}, syncStatus: {} },
    api: async url => {
      reads.push([url, state.selectedAccessId]);
      return url === '/api/access-keys' ? { accessKeys: ids.map(id => ({ id })), orderVersion: 0 } : { keys: [], budget: {}, rewards: [], orderVersion: 0 };
    },
    currentAccess: () => null,
    renderAccessKeys() {}, renderCurrentAccess() {}, renderSummary() {}, renderKeys() {}, renderSchedule() {}, renderRewards() {}, readSyncStatus() {}, checkBudgetNotification() {}
  });
  vm.runInContext(source.slice(source.indexOf('function readAccessSelection('), source.indexOf('async function enterApp(')), context);
  vm.runInContext(source.slice(source.indexOf('async function loadKeys('), source.indexOf('function resetSyncUi(')), context);
  return { context, state, saved, reads };
}

test('superadmin selection is remembered by stable id and restored after page reload or sorting', async () => {
  const h = harness({ ids: ['account-2', 'account-3', 'account-1'] });
  h.context.rememberAccessSelection('account-3');
  h.state.selectedAccessId = h.context.readAccessSelection();
  await h.context.loadKeys();
  assert.equal(h.state.selectedAccessId, 'account-3');
  assert.deepEqual(h.reads.at(-1), ['/api/keys', 'account-3']);
  assert.equal(h.saved.get(storageKey), 'account-3');
});

test('a removed or stale saved administrator falls back before fetching scoped key data', async () => {
  const h = harness({ ids: ['account-1', 'account-2'] });
  await h.context.loadKeys();
  assert.equal(h.state.selectedAccessId, 'account-1');
  assert.deepEqual(h.reads.at(-1), ['/api/keys', 'account-1']);
  assert.equal(h.saved.get(storageKey), 'account-1');
  const empty = harness({ ids: [] });
  await empty.context.loadKeys();
  assert.equal(empty.state.selectedAccessId, '');
  assert.equal(empty.saved.has(storageKey), false);
});

test('unavailable session storage never prevents login or selection, and clearing removes the saved id', async () => {
  const h = harness({ blocked: true });
  assert.equal(h.context.readAccessSelection(), '');
  assert.doesNotThrow(() => h.context.rememberAccessSelection('account-3'));
  await h.context.loadKeys();
  assert.equal(h.state.selectedAccessId, 'account-3');
  const normal = harness();
  normal.context.rememberAccessSelection('');
  assert.equal(normal.saved.size, 0);
});

test('selection persistence is scoped to the tab, restores only for superadmin and clears on logout', () => {
  assert.match(source, /state.selectedAccessId=session.role==='superadmin'\?readAccessSelection\(\):session.accessKey\?\.id\|\|'';/);
  assert.match(source, /function showLogin\(\)\s*\{\s*rememberAccessSelection\(''\);/);
  assert.match(source, /if\(state.role==='superadmin'\)rememberAccessSelection\(id\);/);
  assert.doesNotMatch(source, /localStorage\.(getItem|setItem)\(selectedAccessStorageKey/);
});

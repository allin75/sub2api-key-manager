import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const css = await fs.readFile(new URL('../public/overrides.css', import.meta.url), 'utf8');

function harness(cost = 25) {
  let now = 100, account = 'account-a', tile;
  const makeTile = () => {
    const classes = new Set(), properties = new Map(), listeners = {};
    return { classes, properties, listeners,
      classList: { add: value => classes.add(value), remove: (...values) => values.forEach(value => classes.delete(value)) },
      style: { setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name) },
      addEventListener: (name, handler) => { listeners[name] = handler; }
    };
  };
  tile = makeTile();
  const state = { keys: [{ id: 'key-a', usage: { yesterday: { cost } } }] };
  const context = vm.createContext({
    yesterdayEffectStarts: new Map(), yesterdayEffectDuration: 10000, state,
    currentAccess: () => ({ id: account }), performance: { now: () => now },
    elements: { keyGrid: { querySelectorAll: () => [{ dataset: { sortId: 'key-a' }, querySelector: () => tile }] } }
  });
  vm.runInContext(source.slice(source.indexOf('function yesterdayEffectFrame('), source.indexOf('function renderUsagePeriods(')), context);
  return { context, state, decorate: () => context.decorateYesterdayEffects(), get tile() { return tile; },
    rebuild: () => { tile = makeTile(); }, setNow: value => { now = value; }, setAccount: value => { account = value; } };
}

test('production yesterday uses raw strict thresholds and a ten-second cycle', () => {
  for (const [cost, tone] of [[10, null], [10.001, 'warm'], [20, 'warm'], [20.001, 'hot'], [NaN, null], [Infinity, null]]) {
    const h = harness(cost);
    h.decorate();
    assert.deepEqual([...h.tile.classes], tone ? [`usage-yesterday-${tone}`] : []);
  }
  const { context } = harness();
  assert.equal(context.yesterdayEffectFrame(25, 100, 5100).delayMs, -5000);
  assert.equal(context.yesterdayEffectFrame(25, 100, 5099).delayMs, -4999);
  assert.equal(context.yesterdayEffectFrame(25, 100, 10100).delayMs, 0);
  assert.equal(context.yesterdayEffectFrame(25, 100, 10500).delayMs, -400);
  assert.equal(context.yesterdayEffectFrame(25, 100, NaN), null);
});

test('production yesterday resumes active and quiet phases without restarting the cycle', () => {
  const h = harness();
  h.decorate();
  assert.equal(h.tile.properties.get('--usage-yesterday-delay'), '0ms');
  h.setNow(2200); h.rebuild(); h.decorate();
  assert.equal(h.tile.properties.get('--usage-yesterday-delay'), '-2100ms');
  h.setNow(5100); h.rebuild(); h.decorate();
  assert.equal(h.tile.properties.get('--usage-yesterday-delay'), '-5000ms');
  h.setNow(9100); h.rebuild(); h.decorate();
  assert.equal(h.tile.properties.get('--usage-yesterday-delay'), '-9000ms');
  h.setNow(10500); h.rebuild(); h.decorate();
  assert.equal(h.tile.properties.get('--usage-yesterday-delay'), '-400ms');
  h.setNow(60500); h.rebuild(); h.decorate();
  assert.equal(h.tile.properties.get('--usage-yesterday-delay'), '-400ms');
  h.state.keys[0].usage.yesterday.cost = 10;
  h.rebuild(); h.decorate();
  assert.equal(h.tile.classes.size, 0);
  assert.equal(h.tile.properties.size, 0);
});

test('production yesterday start times are isolated per account and survive switching back', () => {
  const h = harness(); h.decorate();
  h.setNow(6100); h.setAccount('account-b'); h.rebuild(); h.decorate();
  assert.equal(h.tile.classes.size, 1);
  assert.equal(h.tile.properties.get('--usage-yesterday-delay'), '0ms');
  h.setAccount('account-a'); h.rebuild(); h.decorate();
  assert.equal(h.tile.properties.get('--usage-yesterday-delay'), '-6000ms');
  assert.match(source, /function showLogin\(\)\s*\{\s*rememberAccessSelection\(''\);\s*yesterdayEffectStarts.clear\(\);/);
});

test('production effects retain persistent orbit clocks, fading peaks and reduced motion', () => {
  assert.match(css, /\.key-grid\s*\{\s*animation:usage-today-warm-orbit 4\.8s linear infinite,usage-today-hot-orbit 3\.4s linear infinite;/);
  for (const [step, strength] of [[4, 1], [18, 0.62], [32, 0.3], ['50%,100', 0]]) {
    assert.ok(css.includes(`${step}% { --usage-yesterday-strength:${strength}; }`));
  }
  assert.match(css, /animation:usage-yesterday-fade 10s ease-in-out infinite both/);
  assert.match(css, /animation:none; --usage-yesterday-strength:0;/);
  assert.match(source, /mountSort\(elements.keyGrid[^\n]+\n\s*decorateYesterdayEffects\(\);/);
  assert.doesNotMatch(source, /replayYesterdayEffect|重播昨日特效/);
});

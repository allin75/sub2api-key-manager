import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const styles = await fs.readFile(new URL('../public/overrides.css', import.meta.url), 'utf8');
const usagePeriods = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'Week'], ['lastWeek', 'Last week'], ['month', 'Month'], ['lastMonth', 'Last month']];
const context = vm.createContext({ usagePeriods, money: value => `$${Number(value).toFixed(2)}` });
vm.runInContext(source.slice(source.indexOf('function renderUsagePeriods('), source.indexOf('function renderKeys(')), context);
const render = cost => context.renderUsagePeriods({ usage: { today: { cost } } });

test('today usage heat uses strict dollar thresholds, not rounded display values', () => {
  for (const cost of [0, 9.99, 10]) assert.doesNotMatch(render(cost), /usage-today-/);
  for (const cost of [10.001, 10.01, 19.99, 20]) {
    assert.match(render(cost), /class="usage-today-warm"/);
    assert.doesNotMatch(render(cost), /usage-today-hot/);
  }
  for (const cost of [20.001, 20.01, 10000]) {
    assert.match(render(cost), /class="usage-today-hot"/);
    assert.doesNotMatch(render(cost), /usage-today-warm/);
  }
  assert.match(render('15.50'), /class="usage-today-warm">\$15\.50/);
});

test('only the today amount is highlighted; other periods retain their markup', () => {
  const usage = Object.fromEntries(usagePeriods.map(([id]) => [id, { cost: 35 }]));
  const html = context.renderUsagePeriods({ usage });
  assert.equal((html.match(/usage-today-hot/g) || []).length, 1);
  for (const [, label] of usagePeriods.slice(1)) {
    assert.ok(html.includes(`<span>${label}</span><strong>$35.00</strong>`));
  }
  assert.ok(source.includes('const periods=renderUsagePeriods(key);'));
});

test('missing and invalid usage has no heat and missing periods still show a dash', () => {
  for (const key of [{}, { usage: {} }, { usage: { today: null } }]) {
    const html = context.renderUsagePeriods(key);
    assert.doesNotMatch(html, /usage-today-/);
    assert.equal((html.match(/<strong>—<\/strong>/g) || []).length, 6);
  }
  for (const cost of [undefined, null, -1, NaN, Infinity, 'invalid']) {
    assert.doesNotMatch(render(cost), /usage-today-/);
  }
});

test('fresh rendering clears heat when today usage falls or becomes unavailable', () => {
  const key = { quota: 1, quotaUsed: 100, usage: { today: { cost: 25 } } };
  assert.match(context.renderUsagePeriods(key), /usage-today-hot/);
  key.usage.today.cost = 15;
  assert.match(context.renderUsagePeriods(key), /usage-today-warm/);
  key.usage.today.cost = 5;
  assert.doesNotMatch(context.renderUsagePeriods(key), /usage-today-/);
  delete key.usage.today;
  assert.doesNotMatch(context.renderUsagePeriods(key), /usage-today-/);
});

test('today heat is scoped to period amounts and reduced motion keeps a static glow', () => {
  assert.match(styles, /\.period strong\.usage-today-warm\s*\{[^}]*color:#f5ce73;[^}]*text-shadow:/);
  assert.match(styles, /\.period strong\.usage-today-hot\s*\{[^}]*animation:usage-today-ember/);
  assert.match(styles, /@media\s*\(prefers-reduced-motion:reduce\)\s*\{\s*\.period strong\.usage-today-hot\s*\{\s*animation:none;/);
  const animation = styles.match(/@keyframes usage-today-ember\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(animation);
  assert.doesNotMatch(animation, /transform|opacity|font-size|margin|padding/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const context = vm.createContext({
  state: { budget: { stale: true } },
  money: value => `$${Number(value).toFixed(2)}`,
  escapeHtml: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;')
});
vm.runInContext(source.slice(source.indexOf('function usageDayDetail('), source.indexOf('function openUsagePreview(')), context);

test('zero usage renders a finite baseline with all seven dates and stale indication', () => {
  const daily = Array.from({ length: 7 }, (_, i) => ({ date: `2026-01-0${i + 1}`, cost: 0 }));
  const html = context.renderUsageChart({ name: '<script>example</script>', usage: { daily } });
  assert.doesNotMatch(html, /NaN|Infinity|<script>/);
  assert.match(html, /缓存数据 · 待同步/);
  assert.match(html, /\$0.00/);
  assert.equal((html.match(/data-day=/g) || []).length, 7);
  assert.doesNotMatch(html, /统计中/);
});

test('missing daily history is shown as unavailable rather than fabricated zero consumption', () => {
  const html = context.renderUsageChart({ name: 'Example', usage: {} });
  assert.match(html, /每日用量暂未同步/);
  assert.doesNotMatch(html, /<svg|\$0.00/);
});

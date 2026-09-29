import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const threeDays = 3 * 86400000;
const context = vm.createContext({ quotaRulesNoticeLifetime: threeDays });
vm.runInContext(source.slice(source.indexOf('function shouldShowQuotaRulesNotice('), source.indexOf('function persistQuotaRulesNotice(')), context);

test('quota rules stay visible until three days after the first view', () => {
  const seenAt = Date.UTC(2026, 8, 29);
  assert.equal(context.shouldShowQuotaRulesNotice({ seenAt: null, dismissed: false }, seenAt + threeDays), true);
  assert.equal(context.shouldShowQuotaRulesNotice({ seenAt, dismissed: false }, seenAt + threeDays - 1), true);
  assert.equal(context.shouldShowQuotaRulesNotice({ seenAt, dismissed: false }, seenAt + threeDays), false);
  assert.equal(context.shouldShowQuotaRulesNotice({ seenAt, dismissed: true }, seenAt + 1), false);
});

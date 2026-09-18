import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('quota warning uses a scoped class that cannot inherit global warning layout',async()=>{
  const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const start=source.indexOf('function renderQuota(');
  const end=source.indexOf('function renderSummary(',start);
  const context=vm.createContext({money:value=>`$${Number(value).toFixed(2)}`,escapeHtml:value=>String(value)});
  vm.runInContext(source.slice(start,end),context);
  const warning=context.renderQuota({id:'one',name:'Key',quota:100,quotaUsed:80});
  const exhausted=context.renderQuota({id:'one',name:'Key',quota:100,quotaUsed:100});
  assert.match(warning,/quota-panel quota-warning/);
  assert.doesNotMatch(warning,/quota-panel warning/);
  assert.match(exhausted,/quota-panel quota-exhausted/);
});

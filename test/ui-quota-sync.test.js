import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
function context(){
  const element=()=>({disabled:false,textContent:'',classList:{add(){},remove(){},toggle(){}},setAttribute(){},reset(){},focus(){}});
  const pending=[],messages=[],timers=new Map();let timer=0;
  const elements=Object.fromEntries(['quotaForm','quotaInput','quotaError','quotaOverlay','quotaDescription','quotaProgress','closeQuotaButton','cancelQuotaButton','saveQuotaButton','refreshButton','syncProgress'].map(id=>[id,element()]));
  const state={selectedAccessId:'first',keys:[],budget:null,sync:null};
  const c=vm.createContext({elements,state,viewVersion:1,manualRefreshPending:false,Date,
    api:url=>new Promise((resolve,reject)=>pending.push({url,resolve,reject})),
    setTimeout:fn=>{timers.set(++timer,fn);return timer},clearTimeout:id=>timers.delete(id),
    setBusy:(button,busy,text)=>{button.disabled=busy;button.textContent=text},formatSyncTime:value=>value,
    renderKeys(){},renderSummary(){},renderCurrentAccess(){},renderSchedule(){},renderRewards(){},readSyncStatus(){},toast:text=>messages.push(text)});
  vm.runInContext(source.slice(source.indexOf('function updateRefreshFeedback('),source.indexOf('function renderSyncHistory(')),c);
  vm.runInContext(source.slice(source.indexOf("let quotaKeyId='';"),source.indexOf('function setBusy(')),c);
  c.openQuota('one','Mock Key',100);
  return {c,pending,messages,elements,timers,state};
}
const submit={preventDefault(){}};

test('quota waiting feedback is immediate, blocks duplicate submits and keeps the dialog open',async()=>{
  const f=context();f.elements.quotaInput.value='200';
  const saved=f.c.updateQuota(submit);await f.c.updateQuota(submit);
  assert.equal(f.pending.length,1);assert.equal(f.elements.saveQuotaButton.disabled,true);
  assert.equal(f.elements.quotaInput.disabled,true);assert.equal(f.elements.cancelQuotaButton.disabled,true);
  assert.match(f.elements.quotaProgress.textContent,/正在保存/);
  f.c.closeQuota();assert.equal(vm.runInContext('quotaKeyId',f.c),'one');
  for(const fn of f.timers.values())fn();assert.match(f.elements.quotaProgress.textContent,/仍在处理/);
  f.pending[0].resolve({keys:[{id:'one',quota:200}],budget:{},rewards:[]});await saved;
  assert.equal(f.state.keys[0].quota,200);assert.deepEqual(f.messages,['配额已保存']);
  assert.equal(f.elements.saveQuotaButton.disabled,false);assert.equal(f.timers.size,0);
});

test('failed quota writes retain input and restore retry controls without reporting success',async()=>{
  const f=context();f.elements.quotaInput.value='200';const saved=f.c.updateQuota(submit);
  f.pending[0].reject(new Error('请求受限'));await saved;
  assert.equal(f.elements.quotaInput.value,'200');assert.equal(f.elements.quotaError.textContent,'请求受限');
  assert.equal(f.elements.saveQuotaButton.disabled,false);assert.equal(f.messages.length,0);
  const retry=f.c.updateQuota(submit);f.pending[1].resolve({keys:[],budget:{},pendingSync:true});await retry;
  assert.deepEqual(f.messages,['配额已保存，用量待下次刷新']);
});

test('closing a session or switching administrators discards late quota results and feedback',async()=>{
  const f=context();f.elements.quotaInput.value='200';const saved=f.c.updateQuota(submit);
  f.c.closeQuota(true);f.state.selectedAccessId='second';f.c.viewVersion++;
  f.c.openQuota('two','Second',50);
  f.pending[0].resolve({keys:[{id:'one',quota:200}],budget:{}});await saved;
  assert.equal(vm.runInContext('quotaKeyId',f.c),'two');assert.equal(f.elements.quotaInput.value,50);
  assert.equal(f.state.keys.length,0);assert.equal(f.messages.length,0);
});

test('cooldown disables refresh and quota submission and states the exact next attempt time',async()=>{
  const f=context();const until=new Date(Date.now()+3600000).toISOString();
  f.state.sync={rateLimitedUntil:until};f.c.updateRefreshFeedback();
  assert.equal(f.elements.refreshButton.disabled,true);
  assert.match(f.elements.syncProgress.textContent,/本轮刷新已跳过/);assert.ok(f.elements.syncProgress.textContent.includes(until));
  f.elements.quotaInput.value='200';await f.c.updateQuota(submit);assert.equal(f.pending.length,0);
  assert.ok(f.elements.quotaError.textContent.includes(until));
  f.state.sync=null;f.c.updateRefreshFeedback();assert.equal(f.elements.refreshButton.disabled,false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
function setup(){
  const element=()=>({value:'',disabled:false,textContent:'',classList:{add(){},remove(){},contains(){return false},toggle(){}},setAttribute(){},focus(){},querySelectorAll(){return []}});
  const elements=Object.fromEntries(['budgetForm','budgetOverlay','budgetType','budgetInput','budgetNextInput','budgetInputLabel','budgetNextSection','budgetNextEffective','budgetPolicyHint','budgetTypeValue','budgetTypeMenu','budgetTypeTrigger','budgetError','saveBudgetButton'].map(id=>[id,element()]));
  elements.budgetForm.querySelectorAll=()=>Object.values(elements);elements.budgetForm.reportValidity=()=>true;
  const state={budget:{limit:100,nextLimit:150,type:'monthly',month:'2026-10',monthlyResetEnabled:true,nextMonthAt:'2026-10-31T16:00:00Z'},selectedAccessId:'one'};
  const pending=[],messages=[];
  const c=vm.createContext({elements,state,viewVersion:1,structuredClone,Date,document:{getElementById:()=>element()},
    currentAccess:()=>({id:state.selectedAccessId}),setBusy:(el,busy,text)=>{el.disabled=busy;el.textContent=text},formatTime:v=>v,
    api:(url,options)=>new Promise((resolve,reject)=>pending.push({url,options,resolve,reject})),loadKeys:async()=>{},toast:message=>messages.push(message)});
  vm.runInContext('let budgetEditor=null;let budgetEditVersion=0;'+source.slice(source.indexOf('function closeBudgetMenu('),source.indexOf('function renderSchedule(')),c);
  c.openBudget();return {c,elements,state,pending,messages};
}
const submit={preventDefault(){}};

test('budget editor restores scheduled amount, otherwise fills current amount without an extra switch',()=>{
  const f=setup();assert.equal(f.elements.budgetNextInput.value,150);
  f.state.budget.nextLimit=null;f.c.openBudget();assert.equal(f.elements.budgetNextInput.value,100);
  f.elements.budgetType.value='trial';f.c.updateBudgetFields();assert.equal(f.elements.budgetNextInput.disabled,true);
  f.elements.budgetType.value='monthly';f.c.updateBudgetFields();assert.equal(f.elements.budgetNextInput.disabled,false);
  f.state.budget.monthlyResetEnabled=false;f.c.openBudget();assert.match(f.elements.budgetNextEffective.textContent,/月刷新已关闭/);
});
test('budget saves capture scope, month and both amounts, lock controls and reject duplicate submissions',async()=>{
  const f=setup();f.elements.budgetNextInput.value='200';const saving=f.c.saveBudget(submit);await f.c.saveBudget(submit);
  assert.equal(f.pending.length,1);assert.equal(f.pending[0].url,'/api/budget?accessKeyId=one');
  assert.equal(f.pending[0].options.body.expectedMonth,'2026-10');assert.equal(f.pending[0].options.body.nextLimit,200);
  assert.equal(f.elements.budgetInput.disabled,true);f.c.closeBudget();assert.equal(vm.runInContext('budgetEditor.busy',f.c),true);
  f.pending[0].resolve({budget:{stale:true}});await saving;assert.match(f.messages[0],/已保存.*待同步/);
});
test('failed budget saves retain input and re-enable retry; trial submissions omit next limit',async()=>{
  const f=setup();f.elements.budgetNextInput.value='222';const saving=f.c.saveBudget(submit);
  f.pending[0].reject(new Error('额度周期已变化'));await saving;
  assert.equal(f.elements.budgetNextInput.value,'222');assert.equal(f.elements.budgetInput.disabled,false);assert.match(f.elements.budgetError.textContent,/周期已变化/);
  f.elements.budgetType.value='trial';f.c.updateBudgetFields();const trial=f.c.saveBudget(submit);
  assert.equal('nextLimit' in f.pending[1].options.body,false);f.pending[1].resolve({budget:{}});await trial;
});
test('late budget results cannot close a new session dialog or show stale success feedback',async()=>{
  const f=setup();const saving=f.c.saveBudget(submit);f.c.closeBudget(true);f.c.viewVersion++;f.state.selectedAccessId='two';f.c.openBudget();
  f.pending[0].resolve({budget:{}});await saving;
  assert.equal(vm.runInContext('budgetEditor.accessId',f.c),'two');assert.equal(f.elements.budgetInput.disabled,false);assert.equal(f.messages.length,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyManager } from '../src/manager.js';
import { initialState } from '../src/store.js';
import { hashKey } from '../src/utils.js';
import { monthId, nextCheck, FIVE_MINUTES } from '../src/budget-policy.js';

function setup(iso='2026-09-18T10:00:00+08:00') {
  let now=new Date(iso),state=structuredClone(initialState),failRead=false,failWrite=null;
  const all=[{id:1,key:'sk-one-12345678901234',status:'active',quota:100,quota_used:3},
    {id:2,key:'sk-two-12345678901234',status:'active',quota:100,quota_used:4},
    {id:3,key:'sk-other-12345678901',status:'active',quota:100,quota_used:0}];
  state.configuredKeys=all.slice(0,2).map(k=>({id:String(k.id),keyHash:hashKey(k.key),maskedKey:'sk-***'}));
  const costs={1:30,2:20,3:90},calls=[];
  const store={getState:()=>structuredClone(state),saveState:async s=>{state=structuredClone(s)}};
  const upstream={listAllKeys:async()=>{calls.push(['list']);if(failRead)throw Error('offline');return structuredClone(all)},
    getUsageForKey:async id=>{calls.push(['usage',id]);if(failRead)throw Error('offline');return Object.fromEntries(['yesterday','today','week','month','lastMonth'].map(p=>[p,{cost:costs[id],requests:1}]))},
    updateKeyStatus:async(id,status)=>{calls.push(['status',id,status]);if(failWrite===id)throw Error('write failed');all.find(k=>k.id===id).status=status},
    updateKeyQuota:async(id,quota)=>{calls.push(['quota',id,quota]);all.find(k=>k.id===id).quota=quota},
    resetKey:async id=>{calls.push(['reset',id]);all.find(k=>k.id===id).quota_used=0}};
  let manager=new KeyManager({store,upstream,clock:()=>now});
  return {get m(){return manager},get state(){return state},all,costs,calls,
    at:iso=>{now=new Date(iso)},advance:ms=>{now=new Date(now.getTime()+ms)},
    failRead:v=>{failRead=v},failWrite:id=>{failWrite=id},
    restart:()=>{manager=new KeyManager({store,upstream,clock:()=>now})}};
}

test('calendar polling handles weekdays, weekends, 95%, night and boundaries',()=>{
  const next=(date,near=false)=>nextCheck(new Date(date),near);
  assert.equal(next('2026-09-18T08:00:00+08:00'),'2026-09-18T00:05:00.000Z');
  assert.equal(next('2026-09-18T18:29:00+08:00'),'2026-09-18T10:30:00.000Z');
  assert.equal(next('2026-09-18T18:30:00+08:00'),'2026-09-18T12:30:00.000Z');
  assert.equal(next('2026-09-19T09:00:00+08:00'),'2026-09-19T03:00:00.000Z');
  assert.equal(next('2026-09-19T09:00:00+08:00',true),'2026-09-19T01:05:00.000Z');
  assert.equal(next('2026-09-18T21:59:00+08:00',true),'2026-09-18T14:00:00.000Z');
  assert.equal(next('2026-09-18T22:00:00+08:00',true),'2026-09-19T00:00:00.000Z');
  assert.equal(next('2026-09-18T07:59:00+08:00'),'2026-09-18T00:00:00.000Z');
  assert.equal(monthId(new Date('2026-09-30T16:00:00Z')),'2026-10');
});
test('unset budget caches consumption but never changes upstream status',async()=>{
  const f=setup();await f.m.refresh();assert.equal(f.m.view().budget.status,'unset');assert.equal(f.m.view().budget.used,50);
  assert.equal(f.calls.filter(c=>c[0]==='status').length,0);
});
test('exact limit disables only managed active keys and raising restores ownership',async()=>{
  const f=setup();await f.m.setBudget(50);
  assert.equal(f.m.view().budget.balance,0);assert.equal(f.m.view().budget.status,'blocked');
  assert.deepEqual(f.all.map(k=>k.status),['inactive','inactive','active']);
  await f.m.setBudget(60);assert.deepEqual(f.all.map(k=>k.status),['active','active','active']);
  assert.equal(f.m.view().budget.used,50);assert.equal(f.m.view().budget.balance,10);
});
test('originally inactive keys are not re-enabled',async()=>{
  const f=setup();f.all[1].status='inactive';await f.m.setBudget(40);await f.m.setBudget(100);
  assert.equal(f.all[0].status,'active');assert.equal(f.all[1].status,'inactive');
});
test('95 percent changes low frequency to five minutes without disabling',async()=>{
  const f=setup('2026-09-19T10:00:00+08:00');await f.m.setBudget(100);assert.equal(f.m.view().budget.nextCheckAt,'2026-09-19T04:00:00.000Z');
  f.costs[1]=75;await f.m.setBudget(100);assert.equal(f.m.view().budget.nextCheckAt,'2026-09-19T02:05:00.000Z');assert.equal(f.all[0].status,'active');
});
test('failed consumption read keeps previous balance and never restores keys',async()=>{
  const f=setup();await f.m.setBudget(50);f.failRead(true);await f.m.setBudget(100);
  assert.equal(f.m.view().budget.used,50);assert.equal(f.m.view().budget.stale,true);assert.equal(f.all[0].status,'inactive');
});
test('partial disable survives restart, retry interval applies at night',async()=>{
  const f=setup('2026-09-18T23:00:00+08:00');f.failWrite(2);await f.m.setBudget(50);
  assert.equal(f.all[0].status,'inactive');assert.equal(f.all[1].status,'active');
  f.restart();f.failWrite(null);const before=f.calls.length;await f.m.tick();assert.equal(f.calls.length,before);
  f.advance(FIVE_MINUTES);await f.m.tick();assert.equal(f.all[1].status,'inactive');
  assert.equal(f.calls.filter(c=>c[0]==='status'&&c[1]===1).length,1);
});
test('month rollover at midnight restores only owned keys and retains limit',async()=>{
  const f=setup('2026-09-30T23:00:00+08:00');await f.m.setBudget(50);
  f.costs[1]=0;f.costs[2]=0;f.at('2026-10-01T00:00:00+08:00');await f.m.tick();
  assert.equal(f.m.view().budget.month,'2026-10');assert.equal(f.m.view().budget.balance,50);assert.equal(f.all[0].status,'active');
});
test('missed month rollover is caught on restart, failures keep retrying at night',async()=>{
  const f=setup('2026-09-30T10:00:00+08:00');await f.m.setBudget(40);f.restart();f.at('2026-10-02T01:00:00+08:00');f.failRead(true);
  await f.m.tick();assert.equal(f.all[0].status,'inactive');assert.equal(f.m.view().budget.balance,null);f.failRead(false);f.costs[1]=0;f.costs[2]=0;f.advance(FIVE_MINUTES);await f.m.tick();assert.equal(f.all[0].status,'active');
});
test('removed usage is retained, re-add is not double billed and ownership outlives removal',async()=>{
  const f=setup();await f.m.setBudget(50);await f.m.remove('1');assert.equal(f.m.view().budget.used,50);
  await f.m.setBudget(100);assert.equal(f.all[0].status,'active');
  await f.m.add(f.all[0].key);assert.equal(f.m.view().budget.used,50);
  await f.m.add(f.all[0].key);assert.equal(f.m.view().keys.length,2);
});
test('new key counts existing current month consumption immediately',async()=>{
  const f=setup();await f.m.setBudget(100);await f.m.add(f.all[2].key);
  assert.equal(f.m.view().budget.used,140);assert.equal(f.m.view().budget.overage,40);assert.ok(f.all.every(k=>k.status==='inactive'));
});
test('views and simultaneous refreshes share cache with global throttle',async()=>{
  const f=setup();await Promise.all([f.m.refresh(),f.m.refresh(),f.m.refresh()]);
  const n=f.calls.length;f.m.view();await f.m.refresh();assert.equal(f.calls.length,n);
  f.advance(FIVE_MINUTES);await f.m.refresh();assert.equal(f.calls.filter(c=>c[0]==='list').length,2);
});
test('night pauses consumption reads even when above 95 percent',async()=>{
  const f=setup('2026-09-18T21:59:00+08:00');f.costs[1]=75;await f.m.setBudget(100);const n=f.calls.length;
  f.at('2026-09-19T22:00:00+08:00');await f.m.tick();assert.equal(f.calls.length,n);
  f.at('2026-09-20T08:00:00+08:00');await f.m.tick();assert.ok(f.calls.length>n);
});
test('monthly block prevents weekly reset or quota edit reactivation',async()=>{
  const f=setup('2026-09-21T06:00:00+08:00');await f.m.setBudget(50);await f.m.tick();
  assert.equal(f.calls.filter(c=>c[0]==='reset').length,0);
  await assert.rejects(f.m.quota('1',200),e=>e.status===409);
});
test('weekly reset does not refund monthly usage and leaves inactive keys alone',async()=>{
  const f=setup('2026-09-21T06:00:00+08:00');f.all[1].status='inactive';await f.m.setBudget(100);await f.m.tick();
  assert.equal(f.m.view().budget.used,50);assert.equal(f.all[0].quota_used,0);assert.equal(f.all[1].status,'inactive');
  const n=f.calls.filter(c=>c[0]==='reset').length;await f.m.tick();assert.equal(f.calls.filter(c=>c[0]==='reset').length,n);
});
test('budget accepts only explicit positive numeric values',async()=>{
  const f=setup();for(const v of [null,0,-1,'100',NaN,Infinity,.001])await assert.rejects(f.m.setBudget(v));
});

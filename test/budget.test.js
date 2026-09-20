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
  const costs={1:30,2:20,3:90},calls=[],records=[];
  const store={getState:()=>structuredClone(state),saveState:async s=>{state=structuredClone(s)}};
  const upstream={listAllKeys:async()=>{calls.push(['list']);if(failRead)throw Error('offline');return structuredClone(all)},
    getUsageRecords:async(id,start,end)=>{if(failRead)throw Error('offline');return structuredClone(records.filter(r=>r.apiKeyId===id&&r.at>=start&&r.at<end))},
    getUsageForKey:async id=>{calls.push(['usage',id]);if(failRead)throw Error('offline');return Object.fromEntries(['yesterday','today','week','month','lastMonth'].map(p=>[p,{cost:costs[id],requests:1}]))},
    updateKeyStatus:async(id,status)=>{calls.push(['status',id,status]);if(failWrite===id)throw Error('write failed');all.find(k=>k.id===id).status=status},
    updateKeyQuota:async(id,quota)=>{calls.push(['quota',id,quota]);all.find(k=>k.id===id).quota=quota},
    resetKey:async id=>{calls.push(['reset',id]);all.find(k=>k.id===id).quota_used=0}};
  let manager=new KeyManager({store,upstream,clock:()=>now});
  return {get m(){return manager},get state(){return state},all,costs,calls,records,
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

test('reward pays the same key consumption first, preserving base 80/120',async()=>{
  const f=setup();f.costs[1]=80;f.costs[2]=0;await f.m.setBudget(120);
  await f.m.grantReward(40,'2026-09-21T02:00:00.000Z');
  f.records.push({id:'1',apiKeyId:1,at:'2026-09-18T02:01:00.000Z',cost:30});f.costs[1]=110;
  f.advance(FIVE_MINUTES);await f.m.refresh();
  assert.equal(f.m.view().budget.used,80);assert.equal(f.m.view().rewards[0].used,30);
  f.records.push({id:'2',apiKeyId:1,at:'2026-09-18T02:06:00.000Z',cost:15});f.costs[1]=125;
  f.advance(FIVE_MINUTES);await f.m.refresh();
  assert.equal(f.m.view().budget.used,85);assert.equal(f.m.view().rewards[0].used,40);
  f.restart();f.advance(FIVE_MINUTES);await f.m.refresh();assert.equal(f.m.view().budget.used,85);
});

test('granting rewards and later polling never restore exhausted or manually disabled keys',async()=>{
  const f=setup();f.all[1].status='inactive';await f.m.setBudget(30);
  await f.m.grantReward(40,'2026-09-21T02:00:00.000Z');
  f.advance(FIVE_MINUTES);await f.m.refresh();f.restart();f.advance(FIVE_MINUTES);await f.m.tick();
  assert.equal(f.all[0].status,'inactive');assert.equal(f.all[1].status,'inactive');
  assert.equal(f.calls.filter(c=>c[0]==='status'&&c[2]==='active').length,0);
});

test('trial usage survives month rollover, restart and never triggers weekly resets',async()=>{
  const f=setup('2026-09-30T10:00:00+08:00');await f.m.setBudget(20,'trial');
  assert.equal(f.m.view().budget.used,0);
  f.records.push({id:'1',apiKeyId:1,at:'2026-09-30T02:01:00.000Z',cost:12});
  f.advance(FIVE_MINUTES);await f.m.refresh();f.restart();f.at('2026-10-01T00:00:00+08:00');await f.m.tick();
  assert.equal(f.m.view().budget.used,12);assert.equal(f.m.view().budget.nextMonthAt,null);
  f.at('2026-10-05T06:00:00+08:00');await f.m.tick();assert.equal(f.calls.filter(c=>c[0]==='reset').length,0);
  f.records.push({id:'2',apiKeyId:1,at:'2026-10-04T22:01:00.000Z',cost:8});
  f.advance(FIVE_MINUTES);await f.m.refresh();assert.equal(f.all[0].status,'inactive');
});

test('expired rewards retain deductions and late records use event time',async()=>{
  const f=setup('2026-09-18T23:00:00+08:00');await f.m.setBudget(50);
  await f.m.grantReward(20,'2026-09-18T16:00:00.000Z');
  f.records.push({id:'2',apiKeyId:1,at:'2026-09-18T16:01:00.000Z',cost:5});
  f.at('2026-09-19T00:02:00+08:00');f.costs[1]=35;await f.m.tick();
  assert.equal(f.m.view().rewards[0].status,'expired');
  f.records.push({id:'1',apiKeyId:1,at:'2026-09-18T15:30:00.000Z',cost:12});f.costs[1]=47;
  f.advance(FIVE_MINUTES);await f.m.refresh();
  assert.equal(f.m.view().rewards[0].used,12);assert.equal(f.m.view().budget.used,55);
});

test('daily summary lag cannot make reward spending refund existing base usage',async()=>{
  const f=setup();f.costs[1]=80;f.costs[2]=0;await f.m.setBudget(120);
  await f.m.grantReward(40,'2026-09-21T02:00:00.000Z');
  f.records.push({id:'1',apiKeyId:1,at:'2026-09-18T02:01:00.000Z',cost:30});
  f.advance(FIVE_MINUTES);await f.m.refresh();
  assert.equal(f.m.view().budget.used,80);assert.equal(f.m.view().rewards[0].used,30);
  f.costs[1]=110;f.advance(FIVE_MINUTES);await f.m.refresh();
  assert.equal(f.m.view().budget.used,80);
});

test('trial edits preserve usage, rewards and duplicate records settle once across months',async()=>{
  const f=setup('2026-09-30T10:00:00+08:00');await f.m.setBudget(20,'trial');
  await f.m.grantReward(10,'2026-10-02T02:00:00.000Z');
  const record={id:'1',apiKeyId:1,at:'2026-09-30T02:01:00.000Z',cost:6};
  f.records.push(record,record);f.advance(FIVE_MINUTES);await f.m.refresh();
  assert.equal(f.m.view().budget.used,0);assert.equal(f.m.view().rewards[0].used,6);
  f.records.push({id:'2',apiKeyId:2,at:'2026-09-30T16:01:00.000Z',cost:9});
  f.at('2026-10-01T08:00:00+08:00');await f.m.tick();
  assert.equal(f.m.view().budget.used,5);assert.equal(f.m.view().rewards[0].used,10);
  await f.m.setBudget(30,'trial');assert.equal(f.m.view().budget.used,5);
  assert.equal(f.m.view().budget.trialStartedAt,'2026-09-30T02:00:00.000Z');
});

test('reward validates inputs and active overlap; read failure leaves no new reward',async()=>{
  const f=setup();
  for(const value of [null,'20',0,-1,NaN,Infinity,.001])await assert.rejects(f.m.grantReward(value,'2026-09-21T00:00:00Z'));
  await assert.rejects(f.m.grantReward(20,'2020-01-01T00:00:00Z'));
  f.failRead(true);await assert.rejects(f.m.grantReward(20,'2026-09-21T00:00:00Z'));
  assert.deepEqual(f.m.view().rewards,[]);
  f.failRead(false);await f.m.grantReward(20,'2026-09-21T00:00:00Z');
  await assert.rejects(f.m.grantReward(20,'2026-09-22T00:00:00Z'),e=>e.status===409);
});

test('reward failure and restart do not restore pending disabled keys',async()=>{
  const f=setup();f.failWrite(2);await f.m.setBudget(50);f.failWrite(null);
  await f.m.grantReward(20,'2026-09-21T00:00:00Z');
  f.failRead(true);f.advance(FIVE_MINUTES);await f.m.refresh();
  f.restart();f.failRead(false);f.advance(FIVE_MINUTES);await f.m.tick();
  assert.equal(f.calls.filter(c=>c[0]==='status'&&c[2]==='active').length,0);
  assert.ok(f.all.slice(0,2).every(k=>k.status==='inactive'));
});

test('key ordering validates complete permutations and rejects stale writes without upstream calls',async()=>{
  const f=setup();await f.m.refresh();const count=f.calls.length;
  await f.m.reorder(['2','1'],0);assert.deepEqual(f.m.view().keys.map(k=>k.id),['2','1']);
  assert.equal(f.calls.length,count);
  await assert.rejects(f.m.reorder(['1','2'],0),e=>e.status===409);
  await assert.rejects(f.m.reorder(['2','2'],1),e=>e.status===409);
  await assert.rejects(f.m.reorder(['2'],1),e=>e.status===409);
  f.restart();assert.deepEqual(f.m.view().keys.map(k=>k.id),['2','1']);
});

test('refresh switches default to enabled for monthly accounts and disabled for trials',async()=>{
  const f=setup();assert.equal(f.m.view().budget.weeklyResetEnabled,true);assert.equal(f.m.view().budget.monthlyResetEnabled,true);
  await f.m.setBudget(20,'trial');
  assert.equal(f.m.view().budget.weeklyResetEnabled,false);assert.equal(f.m.view().budget.monthlyResetEnabled,false);
  await assert.rejects(f.m.setRefreshPolicy({weeklyResetEnabled:true}));
});

test('weekly switch cancels resets, persists on restart and enabling waits until next Monday',async()=>{
  const f=setup('2026-09-21T07:00:00+08:00');await f.m.setBudget(100);
  await f.m.setRefreshPolicy({weeklyResetEnabled:false});f.restart();await f.m.tick();
  assert.equal(f.m.view().schedule,null);assert.equal(f.calls.filter(c=>c[0]==='reset').length,0);
  await f.m.setRefreshPolicy({weeklyResetEnabled:true});await f.m.tick();
  assert.equal(f.calls.filter(c=>c[0]==='reset').length,0);
  f.at('2026-09-28T05:59:00+08:00');await f.m.tick();assert.equal(f.calls.filter(c=>c[0]==='reset').length,0);
  f.at('2026-09-28T06:00:00+08:00');await f.m.tick();assert.equal(f.calls.filter(c=>c[0]==='reset').length,2);
  await f.m.tick();assert.equal(f.calls.filter(c=>c[0]==='reset').length,2);
});

test('monthly switch retains consumption and disabled keys across months, enabling waits for next first day',async()=>{
  const f=setup('2026-09-30T10:00:00+08:00');await f.m.setBudget(50);
  await f.m.setRefreshPolicy({monthlyResetEnabled:false});f.restart();
  f.costs[1]=0;f.costs[2]=0;f.at('2026-10-01T00:00:00+08:00');await f.m.tick();
  assert.equal(f.m.view().budget.used,50);assert.equal(f.m.view().budget.nextMonthAt,null);assert.equal(f.all[0].status,'inactive');
  f.records.push({id:'off-month',apiKeyId:1,at:'2026-10-01T00:01:00.000Z',cost:3});
  f.at('2026-10-01T09:00:00+08:00');await f.m.refresh();assert.equal(f.m.view().budget.used,53);
  await f.m.setRefreshPolicy({monthlyResetEnabled:true});assert.equal(f.m.view().budget.used,53);assert.equal(f.all[0].status,'inactive');
  f.at('2026-11-01T00:00:00+08:00');await f.m.tick();assert.equal(f.m.view().budget.used,0);assert.equal(f.all[0].status,'active');
});

test('retained monthly consumption excludes reward spending without refunding base across months',async()=>{
  const f=setup('2026-09-30T10:00:00+08:00');await f.m.setBudget(120);
  await f.m.setRefreshPolicy({monthlyResetEnabled:false,weeklyResetEnabled:false});
  await f.m.grantReward(20,'2026-10-02T02:00:00.000Z');
  f.records.push({id:'sept',apiKeyId:1,at:'2026-09-30T02:01:00.000Z',cost:10});
  f.advance(FIVE_MINUTES);await f.m.refresh();assert.equal(f.m.view().budget.used,50);
  f.costs[1]=15;f.costs[2]=0;f.records.push({id:'oct',apiKeyId:1,at:'2026-10-01T00:01:00.000Z',cost:15});
  f.at('2026-10-01T09:00:00+08:00');await f.m.tick();
  assert.equal(f.m.view().budget.used,55);assert.equal(f.m.view().rewards[0].used,20);
});

test('refresh policy rejects invalid values and sync failures without changing switches',async()=>{
  const f=setup();
  for(const patch of [{},{weeklyResetEnabled:'false'},{monthlyResetEnabled:0},{unknown:true},null])await assert.rejects(f.m.setRefreshPolicy(patch));
  f.failRead(true);await assert.rejects(f.m.setRefreshPolicy({monthlyResetEnabled:false}));
  assert.equal(f.m.view().budget.monthlyResetEnabled,true);
});

test('weekly switch cancels a pending partial reset without changing reward history',async()=>{
  const f=setup('2026-09-21T07:00:00+08:00');await f.m.setBudget(120);
  await f.m.grantReward(20,'2026-09-22T00:00:00Z');
  const rewards=f.m.view().rewards;
  f.state.resetOperation={startedAt:'2026-09-20T22:00:00.000Z',succeededHashes:[hashKey(f.all[0].key)]};
  await f.m.setRefreshPolicy({weeklyResetEnabled:false});f.restart();await f.m.tick();
  assert.equal(f.state.resetOperation,null);assert.equal(f.calls.filter(c=>c[0]==='reset').length,0);
  assert.deepEqual(f.m.view().rewards,rewards);
});

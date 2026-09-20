import crypto from 'node:crypto';
import { hashKey, maskKey, isWeeklyResetDue, weeklyResetState } from './utils.js';
import { FIVE_MINUTES, ZONE, monthId, nextMonthAt, nextCheck, isDaytime, micros, spent, isOver, isNear, rewardViews, hasReward, settleAccounting, reordered, closeAccountingWindow, refreshPolicy } from './budget-policy.js';

export class ManagerError extends Error {
  constructor(message,status=400){super(message);this.status=status;}
}

export class KeyManager {
  constructor({store,upstream,clock=()=>new Date()}) {
    this.store=store; this.upstream=upstream; this.clock=clock;
    this.queue=Promise.resolve(); this.refreshPromise=null; this.tickPending=false;
  }
  exclusive(fn){const operation=this.queue.then(fn);this.queue=operation.catch(()=>{});return operation;}
  async save(s){await this.store.saveState(s);}
  rollover(s) {
    const month=monthId(this.clock());
    if(s.budget.month===month)return false;
    const reset=refreshPolicy(s.budget).monthlyResetEnabled;
    s.budget.cycleMonth??=s.budget.month||month;
    s.budget.month=month;
    if(reset||s.budget.type==='trial'){
      s.budget.rawLedger={};s.budget.rawAnchors={};s.budget.cycleMonth=month;
    }
    if(reset){s.budget.ledger={};s.budget.rewardHold={};}
    // Keep blocked/ownership until a complete new-month read permits recovery.
    s.cache.error='新月份用量待同步'; s.cache.nextCheckAt=this.clock().toISOString();
    return true;
  }
  view() {
    const s=this.store.getState(), b=s.budget, now=this.clock();
    const ready=!!s.cache.lastSuccessAt && monthId(new Date(s.cache.lastSuccessAt))===b.month;
    const used=ready?spent(b)/1e6:null, expired=s.cache.nextCheckAt && now>=new Date(s.cache.nextCheckAt);
    return {keys:s.configuredKeys.map(c=>s.cache.keys.find(k=>k.id===c.id)||{id:c.id,maskedKey:c.maskedKey,matched:false,error:'等待首次同步'}),
      orderVersion:s.orderVersion||0,rewards:rewardViews(b,now),
      schedule:refreshPolicy(b).weeklyResetEnabled?weeklyResetState(now,ZONE):null, lastResetAt:s.lastResetAt,
      budget:{type:b.type||'monthly',...refreshPolicy(b),cycleMonth:b.cycleMonth||b.month,trialStartedAt:b.trialStartedAt||null,limit:b.limit,used,balance:b.limit===null||used===null?null:Math.max(0,b.limit-used),overage:b.limit===null||used===null?0:Math.max(0,used-b.limit),month:b.month,
        status:b.limit===null?'unset':b.blocked?'blocked':'active',pendingCount:Object.values(b.paused).filter(p=>p.phase!=='disabled').length,
        lastSuccessAt:s.cache.lastSuccessAt,nextCheckAt:!isDaytime(now)&&expired&&!s.actionRetry?nextCheck(now,isNear(b)):s.actionRetry?s.retryAt:s.cache.nextCheckAt,nextMonthAt:refreshPolicy(b).monthlyResetEnabled?nextMonthAt(now):null,
        stale:!!s.cache.error || !s.cache.lastSuccessAt || !!expired || b.month!==monthId(now),error:s.cache.error}};
  }
  refresh() {
    if(this.refreshPromise)return this.refreshPromise;
    this.refreshPromise=this.exclusive(async()=>{
      const s=this.store.getState(),changed=this.rollover(s);
      if(!changed && s.cache.lastAttemptAt && this.clock()-new Date(s.cache.lastAttemptAt)<FIVE_MINUTES) return {...this.view(),cached:true};
      await this.sync(s);return this.view();
    }).finally(()=>{this.refreshPromise=null;});
    return this.refreshPromise;
  }
  async sync(s,{allowRestore=true}={}) {
    this.rollover(s);
    const now=this.clock(), cycleMonth=monthId(now);
    s.cache.lastAttemptAt=now.toISOString();
    await this.save(s);
    try {
      const all=s.configuredKeys.length || Object.keys(s.budget.paused).length ? await this.upstream.listAllKeys() : [];
      const byHash=new Map(all.map(k=>[hashKey(String(k.key||'')),k]));
      const rows=[],ledger={...(s.budget.rawLedger||s.budget.ledger)};
      const accounting=structuredClone(s.budget);
      // Sequential reads cap upstream concurrency at one, including login and writes.
      for(const c of s.configuredKeys){
        const k=byHash.get(c.keyHash);
        if(!k)throw new Error('部分 Key 无法匹配，请超级管理员检查');
        const usage=await this.upstream.getUsageForKey(k.id,now);
        ledger[c.keyHash]=Math.max(ledger[c.keyHash]||0,micros(usage.month.cost));
        if(accounting.accountingFrom){
          accounting.tracking??={};
          const eligibleFrom=[accounting.accountingFrom,c.addedAt||accounting.accountingFrom].sort().at(-1);
          accounting.tracking[c.keyHash]??={apiKeyId:k.id,from:new Date(`${monthId(new Date(eligibleFrom))}-01T00:00:00+08:00`).toISOString(),windows:[{from:eligibleFrom}]};
        }
        rows.push({id:c.id,name:k.name||'未命名 Key',maskedKey:c.maskedKey,status:k.status,matched:true,
          quota:Number(k.quota||0),quotaUsed:Number(k.quota_used||0),lastUsedAt:k.last_used_at||null,usage});
      }
      if(accounting.accountingFrom){
        accounting.records??={};
        for(const [hash,track] of Object.entries(accounting.tracking||{})){
          const end=track.until&&track.until<now.toISOString()?track.until:now.toISOString();
          if(end<=track.from)continue;
          const records=await this.upstream.getUsageRecords(track.apiKeyId,track.from,end);
          for(const record of records) accounting.records[record.id]={id:record.id,keyHash:hash,at:record.at,cost:micros(record.cost),eligible:track.windows.some(w=>record.at>=w.from&&(!w.until||record.at<w.until))};
        }
        const detailTotals={};
        for(const record of Object.values(accounting.records))if(monthId(new Date(record.at))>=(accounting.cycleMonth||accounting.month))detailTotals[record.keyHash]=(detailTotals[record.keyHash]||0)+record.cost;
        accounting.rawAnchors??={};
        for(const hash of Object.keys(ledger)){
          const anchor=accounting.rawAnchors[hash];
          const sinceAnchor=anchor?Object.values(accounting.records).filter(r=>r.keyHash===hash&&r.at>=anchor.at).reduce((sum,r)=>sum+r.cost,0):0;
          ledger[hash]=Math.max(ledger[hash],detailTotals[hash]||0,(anchor?.cost||0)+sinceAnchor);
          accounting.rawAnchors[hash]??={at:now.toISOString(),cost:ledger[hash]};
        }
      }
      if(monthId(this.clock())!==cycleMonth)throw new Error('跨月查询，请等待下一次同步');
      accounting.rawLedger=ledger;settleAccounting(accounting);s.budget=accounting;
      s.cache.keys=rows;s.cache.lastSuccessAt=this.clock().toISOString();s.cache.error=null;
      s.budget.blocked=isOver(s.budget)&&!hasReward(s.budget,now);
      s.actionRetry=true;
      await this.save(s);
      await this.reconcile(s,byHash,allowRestore);
      s.actionRetry=false;
      s.retryAt=null;
    } catch(error) {
      s.cache.error=error instanceof ManagerError?error.message:'上游同步或额度状态变更失败，保留最近成功数据';
      s.retryAt=new Date(this.clock().getTime()+FIVE_MINUTES).toISOString();
    }
    s.cache.nextCheckAt=nextCheck(this.clock(),isNear(s.budget));
    for(const reward of rewardViews(s.budget,this.clock()))if(reward.status==='active'&&reward.expiresAt<s.cache.nextCheckAt)s.cache.nextCheckAt=reward.expiresAt;
    await this.save(s);
    return !s.cache.error;
  }
  async reconcile(s,byHash,allowRestore=true) {
    const failures=[];
    if(s.budget.blocked){
      // Persist ownership BEFORE sending the disable request to survive ambiguous timeouts.
      for(const c of s.configuredKeys){
        const k=byHash.get(c.keyHash);
        if(!k){failures.push(c.keyHash);continue;}
        if(!s.budget.paused[c.keyHash] && k.status!=='active')continue;
        s.budget.paused[c.keyHash]??={...c,phase:'disabling'};
      }
      await this.save(s);
      for(const [hash,p] of Object.entries(s.budget.paused)){
        const k=byHash.get(hash);
        if(!k){failures.push(hash);continue;}
        try{
          p.phase='disabling';await this.save(s);
          if(k.status!=='inactive')await this.upstream.updateKeyStatus(k.id,'inactive');
          p.phase='disabled';k.status='inactive';
          this.cacheStatus(s,p.id,'inactive');await this.save(s);
        }catch{failures.push(hash);}
      }
    } else {
      for(const [hash,p] of Object.entries(s.budget.paused)){
        const k=byHash.get(hash);
        if(!k){failures.push(hash);continue;}
        if(!allowRestore || (k.status==='inactive'&&(s.budget.rewardHold?.[hash]||isOver(s.budget))))continue;
        try{
          p.phase='restoring';await this.save(s);
          if(k.status==='inactive')await this.upstream.updateKeyStatus(k.id,'active');
          // Expired/quota-exhausted keys must not be forced into active status.
          this.cacheStatus(s,p.id,k.status==='inactive'?'active':k.status);
          delete s.budget.paused[hash];await this.save(s);
        }catch{failures.push(hash);}
      }
    }
    if(failures.length)throw new ManagerError(`${failures.length} 个 Key 状态同步失败，5 分钟后重试`,502);
  }
  cacheStatus(s,id,status){const row=s.cache.keys.find(k=>k.id===id);if(row)row.status=status;}
  setRefreshPolicy(patch){return this.exclusive(async()=>{
    const fields=['weeklyResetEnabled','monthlyResetEnabled'];
    if(!patch||typeof patch!=='object'||!Object.keys(patch).length||Object.entries(patch).some(([key,value])=>!fields.includes(key)||typeof value!=='boolean'))throw new ManagerError('刷新开关必须为布尔值');
    const s=this.store.getState(),before=refreshPolicy(s.budget);
    if(s.budget.type==='trial'&&Object.values(patch).some(Boolean))throw new ManagerError('体验额度不自动刷新，请先切换为月度额度');
    if(!await this.sync(s,{allowRestore:false}))throw new ManagerError('同步失败，刷新设置未修改',502);
    if(patch.monthlyResetEnabled===false&&before.monthlyResetEnabled){
      // Preserve the current balance; future months use the same accounting cycle.
      s.budget.accountingFrom??=this.clock().toISOString();
      s.budget.cycleMonth??=s.budget.month;
      s.budget.rawAnchors??={};
      for(const [hash,cost] of Object.entries(s.budget.rawLedger||{}))s.budget.rawAnchors[hash]??={at:this.clock().toISOString(),cost};
    }
    if(patch.weeklyResetEnabled===false)s.resetOperation=null;
    if(patch.weeklyResetEnabled===true&&!before.weeklyResetEnabled)s.budget.weeklyNotBefore=weeklyResetState(this.clock(),ZONE).nextResetAt;
    Object.assign(s.budget,patch);
    await this.save(s);await this.sync(s,{allowRestore:false});return this.view();
  });}
  setBudget(limit,type){return this.exclusive(async()=>{
    if(typeof limit!=='number'||!Number.isFinite(limit)||limit<=0||limit>1e8)throw new ManagerError('月度总额度必须为大于 0 且不超过 100,000,000 的金额');
    const s=this.store.getState();type??=s.budget.type||'monthly';
    if(!['monthly','trial'].includes(type))throw new ManagerError('额度类型无效');
    if(type!==(s.budget.type||'monthly')){
      if(!await this.sync(s,{allowRestore:false}))throw new ManagerError('同步失败，未切换额度类型',502);
      s.budget.weeklyResetEnabled=type==='monthly';s.budget.monthlyResetEnabled=type==='monthly';
      s.budget.rawLedger={};s.budget.rawAnchors={};s.budget.cycleMonth=s.budget.month;
      if(type==='monthly')s.budget.weeklyNotBefore=weeklyResetState(this.clock(),ZONE).nextResetAt;
      if(type==='trial'){
        s.budget.trialStartedAt=this.clock().toISOString();
        s.budget.accountingFrom??=s.budget.trialStartedAt;
        s.resetOperation=null;
      }
    }
    s.budget.type=type;s.budget.rewardHold={};s.budget.limit=Math.round(limit*100)/100;
    if(s.budget.limit<=0)throw new ManagerError('月度总额度最少为 $0.01');
    await this.save(s);await this.sync(s);return this.view();
  });}
  grantReward(limit,expiresAt){return this.exclusive(async()=>{
    if(typeof limit!=='number'||!Number.isFinite(limit)||limit<.01||limit>1e8)throw new ManagerError('奖励金额需为 $0.01–$100,000,000');
    const end=new Date(expiresAt);
    if(typeof expiresAt!=='string'||!Number.isFinite(end.getTime())||end<=this.clock())throw new ManagerError('请选择未来的奖励到期时间');
    const s=this.store.getState();
    if(!await this.sync(s,{allowRestore:false}))throw new ManagerError('同步失败，奖励未发放',502);
    if(hasReward(s.budget,this.clock()))throw new ManagerError('已有有效奖励，请用完或到期后再发放',409);
    const now=this.clock().toISOString();
    if(end<=this.clock())throw new ManagerError('奖励到期时间已过');
    s.budget.accountingFrom??=now;s.budget.rewards??=[];s.budget.rewardHold??={};
    for(const reward of s.budget.rewards)if(reward.expiresAt>now)reward.expiresAt=now;
    for(const hash of Object.keys(s.budget.paused))s.budget.rewardHold[hash]=true;
    s.budget.rewards.push({id:crypto.randomUUID(),limit:Math.round(limit*100)/100,used:0,startsAt:now,expiresAt:end.toISOString()});
    await this.save(s);await this.sync(s,{allowRestore:false});return this.view();
  });}
  reorder(ids,version){return this.exclusive(async()=>{
    const s=this.store.getState();
    try{s.configuredKeys=reordered(s.configuredKeys,ids,s.orderVersion||0,version);}catch(error){throw new ManagerError(error.message,409);}
    s.orderVersion=(s.orderVersion||0)+1;await this.save(s);return this.view();
  });}
  add(customKey){return this.exclusive(()=>this.addNow(customKey));}
  // Caller must hold the shared operation queue, including cross-scope ownership checks.
  async addNow(customKey){
    if(typeof customKey!=='string'||!/^[A-Za-z0-9_-]{16,256}$/.test(customKey.trim()))throw new ManagerError('Key 格式无效');
    const key=customKey.trim(),hash=hashKey(key),s=this.store.getState();
    if(s.configuredKeys.some(c=>c.keyHash===hash))return {created:false,...this.view()};
    const all=await this.upstream.listAllKeys();
    if(!all.some(k=>hashKey(String(k.key||''))===hash))throw new ManagerError('该 Key 不属于当前 Sub2API 账号',404);
    const tracked=s.budget.paused[hash];
    s.configuredKeys.push(tracked?{id:tracked.id,keyHash:hash,maskedKey:tracked.maskedKey,addedAt:tracked.addedAt}:{id:crypto.randomUUID(),keyHash:hash,maskedKey:maskKey(key),addedAt:this.clock().toISOString()});
    s.orderVersion=(s.orderVersion||0)+1;
    if(s.budget.tracking?.[hash]?.until){s.budget.tracking[hash].windows.push({from:this.clock().toISOString()});delete s.budget.tracking[hash].until;}
    await this.save(s);await this.sync(s);return {created:true,...this.view()};
  }
  remove(id){return this.exclusive(async()=>{
    const s=this.store.getState(),c=s.configuredKeys.find(k=>k.id===id);
    if(!c)throw new ManagerError('Key 不存在',404);
    if(!await this.sync(s))throw new ManagerError('移除前同步失败，请稍后重试，已保留 Key',502);
    s.configuredKeys=s.configuredKeys.filter(k=>k.id!==id);s.cache.keys=s.cache.keys.filter(k=>k.id!==id);
    s.orderVersion=(s.orderVersion||0)+1;
    closeAccountingWindow(s.budget,c.keyHash,this.clock().toISOString());
    // ledger and paused entries intentionally outlive list membership.
    await this.save(s);return this.view();
  });}
  quota(id,quota){return this.exclusive(async()=>{
    if(typeof quota!=='number'||!Number.isFinite(quota)||quota<0||quota>1e8)throw new ManagerError('配额必须为有效非负数');
    const s=this.store.getState(),c=s.configuredKeys.find(k=>k.id===id);
    if(!c)throw new ManagerError('Key 不存在',404);
    if(s.budget.blocked||Object.keys(s.budget.paused).length)throw new ManagerError('月度停用或恢复尚未完成，暂不可修改单 Key 配额',409);
    const all=await this.upstream.listAllKeys(),k=all.find(k=>hashKey(String(k.key||''))===c.keyHash);
    if(!k)throw new ManagerError('Key 无法匹配',409);
    await this.upstream.updateKeyQuota(k.id,quota);await this.sync(s);return this.view();
  });}
  tick(){
    if(this.tickPending)return this.queue;
    this.tickPending=true;
    return this.exclusive(async()=>{
      const s=this.store.getState(),now=this.clock(),changed=this.rollover(s);
      if(changed)await this.save(s);
      const retryReady=!s.retryAt||now>=new Date(s.retryAt);
      const pending=s.actionRetry || Object.values(s.budget.paused).some(p=>p.phase!=='disabled');
      const monthPending=s.budget.limit!==null && monthId(new Date(s.cache.lastSuccessAt||0))!==s.budget.month;
      const rewardExpired=(s.budget.rewards||[]).some(r=>new Date(r.expiresAt)<=now&&(!s.cache.lastSuccessAt||r.expiresAt>s.cache.lastSuccessAt));
      const due=changed || rewardExpired || (!s.cache.lastSuccessAt && isDaytime(now)) || (isDaytime(now)&&(!s.cache.nextCheckAt||now>=new Date(s.cache.nextCheckAt))) || ((pending||monthPending)&&retryReady);
      const weekly=refreshPolicy(s.budget).weeklyResetEnabled&&(!s.budget.weeklyNotBefore||now>=new Date(s.budget.weeklyNotBefore))&&(s.resetOperation || isWeeklyResetDue(s.lastResetAt,now,ZONE))&&s.configuredKeys.length>0 && !s.budget.blocked && !Object.keys(s.budget.paused).length;
      if((due||weekly)&&retryReady){
        if(await this.sync(s) && weekly && !s.budget.blocked && !Object.keys(s.budget.paused).length)await this.weekly(s);
      }
    }).finally(()=>{this.tickPending=false;});
  }
  async weekly(s){
    const now=this.clock();
    const completed=new Set(s.resetOperation?.succeededHashes||[]);
    s.resetOperation??={startedAt:now.toISOString(),succeededHashes:[]};
    await this.save(s);
    try{
      const all=await this.upstream.listAllKeys();
      for(const c of s.configuredKeys){
        if(completed.has(c.keyHash))continue;
        const k=all.find(k=>hashKey(String(k.key||''))===c.keyHash);
        if(!k)throw new Error('Key unavailable');
        if(k.status==='inactive'||k.status==='expired')continue;
        await this.upstream.resetKey(k.id);
        completed.add(c.keyHash);s.resetOperation.succeededHashes=[...completed];await this.save(s);
      }
      s.lastResetAt=now.toISOString();s.resetOperation=null;await this.save(s);
      await this.sync(s);
    }catch{
      s.cache.error='每周重置未完成，5 分钟后重试';s.retryAt=new Date(this.clock().getTime()+FIVE_MINUTES).toISOString();await this.save(s);
    }
  }
}

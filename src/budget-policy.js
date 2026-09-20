export const FIVE_MINUTES = 300000;
export const ZONE = 'Asia/Shanghai';

// Calendar arithmetic uses Shanghai wall time (UTC+8, no daylight saving).
export function wallDate(now) { return new Date(now.getTime() + 8 * 3600000); }
export function monthId(now) { return wallDate(now).toISOString().slice(0, 7); }
export function isDaytime(now) { const h=wallDate(now).getUTCHours(); return h>=8 && h<22; }
export function nextMonthAt(now) {
  const d=wallDate(now);
  return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)-8*3600000).toISOString();
}
export function nextCheck(now, nearLimit=false) {
  const d=wallDate(now), minute=d.getUTCHours()*60+d.getUTCMinutes();
  const day=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-8*3600000;
  const weekday=d.getUTCDay()>=1 && d.getUTCDay()<=5;
  if(minute<480) return new Date(day+480*60000).toISOString();
  if(minute>=1320) return new Date(day+86400000+480*60000).toISOString();
  const high=nearLimit || (weekday && minute<1110);
  const boundary=weekday && minute<1110 ? day+1110*60000 : day+1320*60000;
  return new Date(Math.min(now.getTime()+(high?FIVE_MINUTES:7200000),boundary)).toISOString();
}
export function micros(cost) {
  const value=Number(cost);
  if(cost===null || cost===undefined || !Number.isFinite(value) || value<0 || !Number.isSafeInteger(Math.round(value*1e6))) throw new Error('上游消费金额无效');
  return Math.round(value*1e6);
}
export function spent(budget) { return Object.values(budget.ledger).reduce((a,b)=>a+b,0); }
export function isOver(budget) { return budget.limit!==null && spent(budget)>=micros(budget.limit); }
export function isNear(budget) { return budget.limit!==null && spent(budget)>=micros(budget.limit)*.95; }

export function refreshPolicy(budget) {
  return {
    weeklyResetEnabled: budget.type !== 'trial' && budget.weeklyResetEnabled !== false,
    monthlyResetEnabled: budget.type !== 'trial' && budget.monthlyResetEnabled !== false
  };
}

export function rewardViews(budget, now) {
  return (budget.rewards || []).map(reward => ({
    id: reward.id, limit: reward.limit, used: (reward.used || 0) / 1e6,
    remaining: Math.max(0, micros(reward.limit) - (reward.used || 0)) / 1e6,
    startsAt: reward.startsAt, expiresAt: reward.expiresAt,
    status: reward.used >= micros(reward.limit) ? 'exhausted' : now >= new Date(reward.expiresAt) ? 'expired' : 'active'
  }));
}

export function hasReward(budget, now) {
  return rewardViews(budget, now).some(reward => reward.status === 'active' && reward.remaining > 0);
}

// Replaying the retained records in event order handles duplicate and late arrivals.
// All amounts in the accounting ledger are integer micro-dollars.
export function settleAccounting(budget) {
  const rewards = budget.rewards || [];
  for (const reward of rewards) reward.used = 0;
  const credits = {}, trial = {};
  const records = Object.values(budget.records || {}).sort((a,b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id, 'en', { numeric:true }));
  for (const record of records) {
    let remaining = record.cost;
    for (const reward of rewards) {
      if (record.eligible===false || record.at < reward.startsAt || record.at >= reward.expiresAt) continue;
      const paid = Math.min(remaining, Math.max(0, micros(reward.limit) - reward.used));
      reward.used += paid;
      remaining -= paid;
      const month = monthId(new Date(record.at));
      credits[month] ??= {};
      credits[month][record.keyHash] = (credits[month][record.keyHash] || 0) + paid;
    }
    if (budget.type === 'trial' && record.eligible!==false && record.at >= budget.trialStartedAt) trial[record.keyHash] = (trial[record.keyHash] || 0) + remaining;
  }
  budget.credits = credits;
  const cycleMonth = budget.cycleMonth || budget.month;
  const creditTotal = (months,hash) => Object.entries(months || {}).reduce((sum,[month,values]) => sum + (month >= cycleMonth && month <= budget.month ? values[hash] || 0 : 0),0);
  budget.ledger = budget.type === 'trial' ? trial : Object.fromEntries(Object.entries(budget.rawLedger || {}).map(([hash,raw]) => [hash, Math.max(0, raw - creditTotal(credits,hash) - creditTotal(budget.externalCredits,hash))]));
}

export function closeAccountingWindow(budget,hash,at){
  const track=budget.tracking?.[hash];
  if(track){track.until=at;const window=track.windows?.at(-1);if(window&&!window.until)window.until=at;}
}

export function reordered(items, ids, version, expected) {
  if (!Number.isSafeInteger(expected) || expected !== version) throw new Error('顺序已更新，请刷新后重试');
  if (!Array.isArray(ids) || ids.length !== items.length || new Set(ids).size !== ids.length || ids.some(id => !items.some(item => item.id === id))) throw new Error('排序列表必须完整且不能重复');
  const byId = new Map(items.map(item => [item.id,item]));
  return ids.map(id => byId.get(id));
}

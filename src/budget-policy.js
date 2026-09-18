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

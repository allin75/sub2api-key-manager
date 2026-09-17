import crypto from 'node:crypto';

export const RESET_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export function hashKey(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function maskKey(value) {
  if (!value) return '未知';
  return value.length > 12 ? `${value.slice(0, 7)}••••${value.slice(-4)}` : `••••${value.slice(-4)}`;
}

export function cooldownState(lastResetAt, now = Date.now()) {
  const resetTime = lastResetAt ? new Date(lastResetAt).getTime() : 0;
  const remainingMs = Math.max(0, RESET_COOLDOWN_MS - (now - resetTime));
  return {
    active: remainingMs > 0,
    remainingMs,
    availableAt: remainingMs > 0 ? new Date(now + remainingMs).toISOString() : null
  };
}

export function weeklyResetState(now = new Date(), timeZone = 'Asia/Shanghai') {
  const parts = zonedParts(now, timeZone);
  const localDay = Date.UTC(parts.year, parts.month - 1, parts.day);
  const daysUntilMonday = (8 - parts.weekday) % 7;
  const resetPassedToday = parts.weekday === 1 && (parts.hour > 6 || (parts.hour === 6 && parts.minute >= 0));
  const daysToReset = daysUntilMonday === 0 && resetPassedToday ? 7 : daysUntilMonday;
  const targetDay = new Date(localDay + daysToReset * 86400000);
  const nextResetAt = zonedWallTimeToUtc({
    year: targetDay.getUTCFullYear(),
    month: targetDay.getUTCMonth() + 1,
    day: targetDay.getUTCDate(),
    hour: 6,
    minute: 0
  }, timeZone);
  return { nextResetAt: nextResetAt.toISOString(), timeZone, label: '每周一 06:00' };
}

export function isWeeklyResetDue(lastResetAt, now = new Date(), timeZone = 'Asia/Shanghai') {
  const parts = zonedParts(now, timeZone);
  if (parts.weekday !== 1 || parts.hour < 6) return false;
  if (!lastResetAt) return true;
  const last = zonedParts(new Date(lastResetAt), timeZone);
  return last.year !== parts.year || last.month !== parts.month || last.day !== parts.day;
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hourCycle: 'h23', weekday: 'short'
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[values.weekday];
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second), weekday };
}

function zonedWallTimeToUtc(wall, timeZone) {
  const desired = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
  let candidate = desired;
  for (let index = 0; index < 3; index += 1) {
    const actual = zonedParts(new Date(candidate), timeZone);
    const actualWall = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate += desired - actualWall;
  }
  return new Date(candidate);
}

export function dateRanges(now = new Date(), timeZone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const today = new Date(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
  const addDays = (date, count) => new Date(date.getTime() + count * 86400000);
  const format = date => date.toISOString().slice(0, 10);
  const weekDay = (today.getUTCDay() + 6) % 7;
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const lastMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  return {
    yesterday: [format(addDays(today, -1)), format(addDays(today, -1))],
    today: [format(today), format(today)],
    week: [format(addDays(today, -weekDay)), format(today)],
    month: [format(monthStart), format(today)],
    lastMonth: [format(lastMonthStart), format(addDays(monthStart, -1))]
  };
}

export function aggregateDailyUsage(items, ranges) {
  const result = {};
  for (const [period, [start, end]] of Object.entries(ranges)) {
    result[period] = items.reduce((summary, item) => {
      if (!item.date || item.date < start || item.date > end) return summary;
      summary.cost += Number(item.actual_cost ?? item.cost ?? 0);
      summary.requests += Number(item.requests ?? 0);
      return summary;
    }, { cost: 0, requests: 0 });
  }
  return result;
}

export function safeEqual(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left)).digest();
  const rightHash = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

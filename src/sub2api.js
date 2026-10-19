import { aggregateDailyUsage, dateRanges, hashKey, recentDailyUsage } from './utils.js';
import { rateLimitNextCheck } from './budget-policy.js';

const baseUrl = (process.env.SUB2API_BASE_URL || 'https://sub2api.yfyf.fun').replace(/\/$/, '');
const email = process.env.SUB2API_EMAIL || '';
const password = process.env.SUB2API_PASSWORD || '';
const timeZone = 'Asia/Shanghai';
const requestTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);

let auth = { accessToken: '', expiresAt: 0 };
let authPromise;
let requestQueue = Promise.resolve();
let lastRequestAt = 0;
let localCooldown = null;
let syncState = { read: () => null, write: async () => {} };
let keyCache = null, keyCacheAt = 0, keyListPromise = null;
let roundDepth = 0, roundKeys = null;
const configuredInterval = Number(process.env.UPSTREAM_MIN_INTERVAL_MS ?? 1200);
const minIntervalMs = Number.isFinite(configuredInterval) && configuredInterval >= 0 ? configuredInterval : 1200;
const keyCacheMs = 5 * 60000;

export function configureSyncState(adapter) { syncState = adapter; }
export function rateLimitUntil() {
  const until = [localCooldown, syncState.read()].filter(value => Date.parse(value) > Date.now()).sort().at(-1);
  return until || null;
}
function checkCooldown() {
  const until = rateLimitUntil();
  if (until) {
    const error = new UpstreamError(`上游请求受限，下次尝试：${new Date(until).toLocaleString('zh-CN', { timeZone })}（北京时间）`, 429);
    error.retryAt = until;
    throw error;
  }
}
async function request(path, options) {
  const operation = requestQueue.catch(() => {}).then(async () => {
    checkCooldown();
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    checkCooldown();
    lastRequestAt = Date.now();
    const response = await fetch(`${baseUrl}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs) });
    if (response.status === 429) {
      localCooldown = rateLimitNextCheck(new Date(), response.headers.get('Retry-After'));
      keyCache = null; roundKeys = null;
      await response.body?.cancel();
      await syncState.write(localCooldown);
      checkCooldown();
    }
    if (response.status === 401 && path !== '/api/v1/auth/login') {
      await response.body?.cancel();
      return { response, payload: {} };
    }
    // Consume the body inside the queue so slow bodies cannot overlap requests.
    return { response, payload: await readJson(response) };
  });
  requestQueue = operation.catch(() => {});
  return operation;
}

export async function withKeySnapshot(operation) {
  roundDepth++;
  try { return await operation(); }
  finally { if (--roundDepth === 0) roundKeys = null; }
}

async function upstream(path, options = {}, retry = true) {
  checkCooldown();
  const token = await getAccessToken();
  const { response, payload } = await request(path, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  if (response.status === 401 && retry) {
    auth = { accessToken: '', expiresAt: 0 };
    return upstream(path, options, false);
  }
  if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
    throw new UpstreamError(payload.message || `Sub2API 请求失败 (${response.status})`, response.status);
  }
  return payload.data ?? payload;
}

async function getAccessToken() {
  if (auth.accessToken && Date.now() < auth.expiresAt - 60000) return auth.accessToken;
  if (!authPromise) authPromise = login().finally(() => { authPromise = null; });
  return authPromise;
}

async function login() {
  if (!email || !password) throw new UpstreamError('尚未配置 SUB2API_EMAIL 和 SUB2API_PASSWORD', 503);
  const { response, payload } = await request('/api/v1/auth/login', {
    method: 'POST',
    redirect: 'error',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = payload.data ?? payload;
  if (!response.ok || data.requires_2fa || !data.access_token) {
    const message = data.requires_2fa ? 'Sub2API 账号启用了二步验证，当前版本无法自动登录' : (payload.message || 'Sub2API 登录失败');
    throw new UpstreamError(message, response.status || 502);
  }
  auth = {
    accessToken: data.access_token,
    expiresAt: Date.now() + Math.max(300, Number(data.expires_in || 3600)) * 1000
  };
  return auth.accessToken;
}

async function readJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { throw new UpstreamError(`Sub2API 返回了非 JSON 响应 (${response.status})`, response.status); }
}

export async function listAllKeys({ force = false } = {}) {
  checkCooldown();
  if (!force && (roundKeys || (keyCache && Date.now() - keyCacheAt < keyCacheMs))) {
    if (roundDepth) roundKeys ||= keyCache;
    return structuredClone(roundKeys || keyCache);
  }
  if (!keyListPromise) keyListPromise = readAllKeys().then(keys => {
    keyCache = keys; keyCacheAt = Date.now();
    if (roundDepth) roundKeys = keys;
    return keys;
  }).finally(() => { keyListPromise = null; });
  return structuredClone(await keyListPromise);
}

async function readAllKeys() {
  const all = [];
  let page = 1;
  do {
    const data = await upstream(`/api/v1/keys?page=${page}&page_size=100&sort_by=created_at&sort_order=desc`);
    const items = Array.isArray(data) ? data : (data.items ?? data.data);
    if (!Array.isArray(items) || items.some(key => !Number.isSafeInteger(key.id) || key.id <= 0 || typeof key.key !== 'string' ||
      !Number.isFinite(Number(key.quota)) || Number(key.quota) < 0 || !Number.isFinite(Number(key.quota_used)) || Number(key.quota_used) < 0)) throw new UpstreamError('Sub2API Key 列表格式无效');
    all.push(...items);
    const pages = Array.isArray(data) ? 1 : data.pages;
    if (!Number.isSafeInteger(pages) || pages < 0 || pages > 100 || (page < pages && !items.length)) throw new UpstreamError('Sub2API Key 列表分页无效');
    if (page >= pages) break;
    page += 1;
  } while (page <= 100);
  if (page > 100) throw new UpstreamError('Key 列表超过分页上限，请缩小账号范围');
  return all;
}

export async function getManagedKeys(configuredKeys) {
  if (!configuredKeys.length) return [];
  const upstreamKeys = await listAllKeys();
  const byHash = new Map(upstreamKeys.map(item => [hashKey(String(item.key || '')), item]));
  return configuredKeys.map(configured => ({ configured, upstream: byHash.get(configured.keyHash) || null }));
}

export async function getKey(keyId) {
  if (!Number.isSafeInteger(keyId) || keyId <= 0) throw new Error('上游 Key ID 无效');
  const key = await upstream(`/api/v1/keys/${keyId}`);
  if (key?.id !== keyId || typeof key.key !== 'string') throw new Error('上游 Key 返回数据无效');
  return key;
}

export async function getUsageForKey(keyId, now = new Date()) {
  const data = await upstream(`/api/v1/user/api-keys/${keyId}/usage/daily?days=90&timezone=${encodeURIComponent(timeZone)}`);
  const items = Array.isArray(data) ? data : (data.items ?? data.data);
  if (!Array.isArray(items) || items.some(item => !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || item.actual_cost == null || !Number.isFinite(Number(item.actual_cost)) || Number(item.actual_cost)<0)) {
    throw new UpstreamError('Sub2API 实际消费统计格式无效');
  }
  return { ...aggregateDailyUsage(items, dateRanges(now, 'Asia/Shanghai')), daily: recentDailyUsage(items, now) };
}

export async function resetKey(keyId) {
  const result = await upstream(`/api/v1/keys/${keyId}`, {
    method: 'PUT',
    body: JSON.stringify({ reset_quota: true, reset_rate_limit_usage: true })
  });
  keyCache = null; roundKeys = null;
  return result;
}

export async function getUsageRecords(keyId, start, end, { afterId = 0 } = {}) {
  const startDate = new Date(Date.parse(start) + 8 * 3600000).toISOString().slice(0,10);
  const endDate = new Date(Date.parse(end) + 8 * 3600000).toISOString().slice(0,10);
  const records = new Map();
  let previousId = Infinity;
  // Bound each scan and fail closed rather than accept an incomplete ledger.
  for (let page = 1; page <= 1000; page++) {
    const query = new URLSearchParams({api_key_id:String(keyId), start_date:startDate, end_date:endDate, timezone:timeZone, page:String(page), page_size:'100', sort_by:'id', sort_order:afterId ? 'desc' : 'asc'});
    const data = await upstream(`/api/v1/usage?${query}`);
    if (!Array.isArray(data.items) || !Number.isSafeInteger(data.pages) || data.pages < 0 || data.pages > 1000) throw new UpstreamError('用量明细分页无效或超过安全处理上限');
    for (const item of data.items) {
      if (!Number.isSafeInteger(item.id) || item.id <= 0 || item.api_key_id !== keyId || !Number.isFinite(Date.parse(item.created_at)) || typeof item.actual_cost !== 'number' || !Number.isFinite(item.actual_cost) || item.actual_cost < 0) throw new UpstreamError('用量明细格式无效');
      if (afterId && item.id > previousId) throw new UpstreamError('用量明细增量排序无效');
      previousId = item.id;
      const at = new Date(item.created_at).toISOString();
      if (at >= start && at < end) records.set(String(item.id), {id:String(item.id),apiKeyId:keyId,at,cost:item.actual_cost});
    }
    // Re-read the entire boundary page, including retained rows, before stopping.
    if (afterId && data.items.some(item => item.id <= afterId)) return [...records.values()];
    if (page >= data.pages) return [...records.values()];
    if (!data.items.length) throw new UpstreamError('用量明细分页不完整');
  }
  throw new UpstreamError('用量明细超过单次安全处理上限');
}

export async function updateKeyQuota(keyId, quota) {
  const result = await upstream(`/api/v1/keys/${keyId}`, {
    method: 'PUT',
    body: JSON.stringify({ quota })
  });
  patchCachedKey(keyId, { quota });
  return result;
}

export async function updateKeyStatus(keyId, status) {
  if (!['active','inactive'].includes(status)) throw new Error('Invalid key status');
  const result = await upstream(`/api/v1/keys/${keyId}`, { method:'PUT', body:JSON.stringify({status}) });
  patchCachedKey(keyId, { status });
  return result;
}

function patchCachedKey(id, patch) {
  for (const keys of [keyCache, roundKeys]) {
    const key = keys?.find(item => item.id === id);
    if (key) Object.assign(key, patch);
  }
}

export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

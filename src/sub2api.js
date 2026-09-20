import { aggregateDailyUsage, dateRanges, hashKey } from './utils.js';

const baseUrl = (process.env.SUB2API_BASE_URL || 'https://sub2api.yfyf.fun').replace(/\/$/, '');
const email = process.env.SUB2API_EMAIL || '';
const password = process.env.SUB2API_PASSWORD || '';
const timeZone = 'Asia/Shanghai';
const requestTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);

let auth = { accessToken: '', expiresAt: 0 };

async function upstream(path, options = {}, retry = true) {
  const token = await getAccessToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      redirect: 'error',
      signal: controller.signal,
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
    const payload = await readJson(response);
    if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
      throw new UpstreamError(payload.message || `Sub2API 请求失败 (${response.status})`, response.status);
    }
    return payload.data ?? payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function getAccessToken() {
  if (auth.accessToken && Date.now() < auth.expiresAt - 60000) return auth.accessToken;
  if (!email || !password) throw new UpstreamError('尚未配置 SUB2API_EMAIL 和 SUB2API_PASSWORD', 503);
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const payload = await readJson(response);
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

export async function listAllKeys() {
  const all = [];
  let page = 1;
  do {
    const data = await upstream(`/api/v1/keys?page=${page}&page_size=100&sort_by=created_at&sort_order=desc`);
    const items = Array.isArray(data) ? data : (data.items ?? data.data);
    if (!Array.isArray(items)) throw new UpstreamError('Sub2API Key 列表格式无效');
    all.push(...items);
    const pages = Number(data.pages || 1);
    if (page >= pages || !items.length) break;
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

export async function getUsageForKey(keyId, now = new Date()) {
  const data = await upstream(`/api/v1/user/api-keys/${keyId}/usage/daily?days=90&timezone=${encodeURIComponent(timeZone)}`);
  const items = Array.isArray(data) ? data : (data.items ?? data.data);
  if (!Array.isArray(items) || items.some(item => !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || item.actual_cost == null || !Number.isFinite(Number(item.actual_cost)) || Number(item.actual_cost)<0)) {
    throw new UpstreamError('Sub2API 实际消费统计格式无效');
  }
  return aggregateDailyUsage(items, dateRanges(now, 'Asia/Shanghai'));
}

export async function resetKey(keyId) {
  return upstream(`/api/v1/keys/${keyId}`, {
    method: 'PUT',
    body: JSON.stringify({ reset_quota: true, reset_rate_limit_usage: true })
  });
}

export async function getUsageRecords(keyId, start, end) {
  const startDate = new Date(Date.parse(start) + 8 * 3600000).toISOString().slice(0,10);
  const endDate = new Date(Date.parse(end) + 8 * 3600000).toISOString().slice(0,10);
  const records = new Map();
  // Bound each scan and fail closed rather than accept an incomplete ledger.
  for (let page = 1; page <= 1000; page++) {
    const query = new URLSearchParams({api_key_id:String(keyId), start_date:startDate, end_date:endDate, timezone:timeZone, page:String(page), page_size:'100', sort_by:'id', sort_order:'asc'});
    const data = await upstream(`/api/v1/usage?${query}`);
    if (!Array.isArray(data.items) || !Number.isSafeInteger(data.pages) || data.pages < 0 || data.pages > 1000) throw new UpstreamError('用量明细分页无效或超过安全处理上限');
    for (const item of data.items) {
      if (!Number.isSafeInteger(item.id) || item.id <= 0 || item.api_key_id !== keyId || !Number.isFinite(Date.parse(item.created_at)) || typeof item.actual_cost !== 'number' || !Number.isFinite(item.actual_cost) || item.actual_cost < 0) throw new UpstreamError('用量明细格式无效');
      const at = new Date(item.created_at).toISOString();
      if (at >= start && at < end) records.set(String(item.id), {id:String(item.id),apiKeyId:keyId,at,cost:item.actual_cost});
    }
    if (page >= data.pages) return [...records.values()];
    if (!data.items.length) throw new UpstreamError('用量明细分页不完整');
  }
  throw new UpstreamError('用量明细超过单次安全处理上限');
}

export async function updateKeyQuota(keyId, quota) {
  return upstream(`/api/v1/keys/${keyId}`, {
    method: 'PUT',
    body: JSON.stringify({ quota })
  });
}

export async function updateKeyStatus(keyId, status) {
  if (!['active','inactive'].includes(status)) throw new Error('Invalid key status');
  return upstream(`/api/v1/keys/${keyId}`, { method:'PUT', body:JSON.stringify({status}) });
}

export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

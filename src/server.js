import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { addConfiguredKey, getState, loadStore, removeConfiguredKey, setLastResetAt, setResetOperation } from './store.js';
import { getManagedKeys, getUsageForKey, listAllKeys, resetKey, updateKeyQuota, UpstreamError } from './sub2api.js';
import { hashKey, isWeeklyResetDue, safeEqual, weeklyResetState } from './utils.js';

const port = Number(process.env.PORT || 3000);
const adminPassword = process.env.ADMIN_PASSWORD || '111';
const cookieSecure = process.env.COOKIE_SECURE === 'true';
const timeZone = process.env.TIMEZONE || 'Asia/Shanghai';
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const sessions = new Map();
const loginAttempts = new Map();
const sessionTtlMs = 12 * 60 * 60 * 1000;
let resetInProgress = false;

await loadStore();

if (adminPassword === '111') {
  console.warn('[security] ADMIN_PASSWORD 正在使用默认值 111，请在 Docker 环境变量中尽快修改。');
}

const server = http.createServer(async (request, response) => {
  setSecurityHeaders(response);
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    const status = error instanceof UpstreamError
      ? (error.status === 503 ? 503 : 502)
      : (error instanceof HttpError ? error.status : 500);
    if (status >= 500) console.error('[request]', error.message);
    sendJson(response, status, { error: status >= 500 && !(error instanceof UpstreamError) ? '服务器内部错误' : error.message });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Sub2API Key Manager listening on port ${port}`);
});
setTimeout(runScheduledReset, 5000);
setInterval(runScheduledReset, 60000);

async function handleApi(request, response, url) {
  const method = request.method || 'GET';
  if (method === 'POST' && url.pathname === '/api/login') return login(request, response);
  if (method === 'POST' && url.pathname === '/api/logout') {
    const session = requireSession(request);
    requireCsrf(request, session);
    sessions.delete(session.token);
    clearSessionCookie(response);
    return sendJson(response, 200, { ok: true });
  }

  const session = requireSession(request);
  if (method !== 'GET' && method !== 'HEAD') requireCsrf(request, session);

  if (method === 'GET' && url.pathname === '/api/session') {
    return sendJson(response, 200, { authenticated: true, csrfToken: session.csrfToken, defaultPassword: adminPassword === '111' });
  }
  if (method === 'GET' && url.pathname === '/api/keys') return listManagedKeys(response);
  if (method === 'POST' && url.pathname === '/api/keys') return addManagedKey(request, response);
  if (method === 'PUT' && url.pathname.startsWith('/api/keys/')) return updateManagedKeyQuota(request, response, url.pathname.split('/').pop());
  if (method === 'DELETE' && url.pathname.startsWith('/api/keys/')) return deleteManagedKey(response, url.pathname.split('/').pop());
  if (method === 'POST' && url.pathname === '/api/refresh') return listManagedKeys(response);
  throw new HttpError('接口不存在', 404);
}

async function login(request, response) {
  verifyOrigin(request);
  const address = clientAddress(request);
  const attempt = loginAttempts.get(address) || { count: 0, blockedUntil: 0 };
  if (Date.now() < attempt.blockedUntil) throw new HttpError('尝试次数过多，请稍后再试', 429);
  const body = await readBody(request);
  if (!safeEqual(body.password || '', adminPassword)) {
    attempt.count += 1;
    if (attempt.count >= 5) {
      attempt.blockedUntil = Date.now() + 5 * 60 * 1000;
      attempt.count = 0;
    }
    loginAttempts.set(address, attempt);
    throw new HttpError('密码错误', 401);
  }
  loginAttempts.delete(address);
  const token = crypto.randomBytes(32).toString('base64url');
  const session = { token, csrfToken: crypto.randomBytes(24).toString('base64url'), expiresAt: Date.now() + sessionTtlMs };
  sessions.set(token, session);
  response.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionTtlMs / 1000}${cookieSecure ? '; Secure' : ''}`);
  sendJson(response, 200, { authenticated: true, csrfToken: session.csrfToken, defaultPassword: adminPassword === '111' });
}

async function listManagedKeys(response) {
  const state = getState();
  const managed = await getManagedKeys(state.configuredKeys);
  const keys = await Promise.all(managed.map(async ({ configured, upstream }) => {
    if (!upstream) return { id: configured.id, maskedKey: configured.maskedKey, matched: false, error: '在 Sub2API 中未找到此 Key' };
    try {
      const usage = await getUsageForKey(upstream.id);
      return serializeKey(configured, upstream, usage);
    } catch (error) {
      return { ...serializeKey(configured, upstream, null), error: error.message };
    }
  }));
  sendJson(response, 200, { keys, schedule: weeklyResetState(new Date(), timeZone), lastResetAt: state.lastResetAt });
}

async function addManagedKey(request, response) {
  const body = await readBody(request);
  const customKey = String(body.customKey || '').trim();
  if (customKey.length < 16 || customKey.length > 256 || !/^[A-Za-z0-9_-]+$/.test(customKey)) {
    throw new HttpError('Key 格式无效', 400);
  }
  const upstreamKeys = await listAllKeys();
  const match = upstreamKeys.find(item => hashKey(String(item.key || '')) === hashKey(customKey));
  if (!match) throw new HttpError('该 Key 不属于当前配置的 Sub2API 账号', 404);
  const result = await addConfiguredKey(customKey);
  sendJson(response, result.created ? 201 : 200, { created: result.created, key: { id: result.item.id, name: match.name, maskedKey: result.item.maskedKey } });
}

async function deleteManagedKey(response, id) {
  const removed = await removeConfiguredKey(id);
  if (!removed) throw new HttpError('Key 不存在', 404);
  sendJson(response, 200, { ok: true });
}

async function updateManagedKeyQuota(request, response, id) {
  const body = await readBody(request);
  const quota = Number(body.quota);
  if (!Number.isFinite(quota) || quota < 0 || quota > 100000000) throw new HttpError('配额必须是 0 到 100,000,000 之间的数字', 400);
  const configured = getState().configuredKeys.find(item => item.id === id);
  if (!configured) throw new HttpError('Key 不存在', 404);
  const managed = await getManagedKeys([configured]);
  const upstream = managed[0]?.upstream;
  if (!upstream) throw new HttpError('该 Key 已无法在 Sub2API 中匹配', 409);
  await updateKeyQuota(upstream.id, quota);
  sendJson(response, 200, { ok: true, quota });
}

async function runScheduledReset() {
  if (resetInProgress) return;
  const state = getState();
  if (!state.configuredKeys.length || !isWeeklyResetDue(state.lastResetAt, new Date(), timeZone)) return;
  resetInProgress = true;
  try {
    const managed = await getManagedKeys(state.configuredKeys);
    const missing = managed.filter(item => !item.upstream);
    if (missing.length) throw new Error(`有 ${missing.length} 个自定义 Key 无法匹配`);
    const succeededHashes = new Set(state.resetOperation?.succeededHashes || []);
    const operationStartedAt = state.resetOperation?.startedAt || new Date().toISOString();
    const results = [];
    for (const { configured, upstream } of managed) {
      if (succeededHashes.has(configured.keyHash)) {
        results.push({ id: configured.id, name: upstream.name, success: true, resumed: true });
        continue;
      }
      try {
        await resetKey(upstream.id);
        succeededHashes.add(configured.keyHash);
        await setResetOperation({
          startedAt: operationStartedAt,
          succeededHashes: [...succeededHashes]
        });
        results.push({ id: configured.id, name: upstream.name, success: true });
      } catch (error) {
        results.push({ id: configured.id, name: upstream.name, success: false, error: error.message });
      }
    }
    const failed = results.filter(item => !item.success);
    if (failed.length) throw new Error(`${failed.length} 个 Key 自动重置失败，下次轮询只重试失败项`);
    const resetAt = new Date().toISOString();
    await setLastResetAt(resetAt);
    console.log(`[scheduler] 已自动重置 ${results.length} 个 Key 的额度`);
  } catch (error) {
    console.error('[scheduler]', error.message);
  } finally {
    resetInProgress = false;
  }
}

function serializeKey(configured, upstream, usage) {
  return {
    id: configured.id,
    upstreamId: upstream.id,
    name: upstream.name || '未命名 Key',
    maskedKey: configured.maskedKey,
    status: upstream.status,
    matched: true,
    quota: Number(upstream.quota || 0),
    quotaUsed: Number(upstream.quota_used || 0),
    lastUsedAt: upstream.last_used_at || null,
    usage,
    rateUsage: {
      fiveHours: Number(upstream.usage_5h || 0),
      oneDay: Number(upstream.usage_1d || 0),
      sevenDays: Number(upstream.usage_7d || 0)
    }
  };
}

function requireSession(request) {
  cleanupSessions();
  const cookies = Object.fromEntries((request.headers.cookie || '').split(';').map(item => item.trim().split('=').map(decodeURIComponent)).filter(parts => parts.length === 2));
  const session = sessions.get(cookies.session);
  if (!session || session.expiresAt <= Date.now()) throw new HttpError('请先登录', 401);
  return session;
}

function requireCsrf(request, session) {
  verifyOrigin(request);
  if (!safeEqual(request.headers['x-csrf-token'] || '', session.csrfToken)) throw new HttpError('请求验证失败，请刷新页面重试', 403);
}

function verifyOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  const originHost = new URL(origin).host;
  const expectedHost = request.headers['x-forwarded-host'] || request.headers.host;
  if (originHost !== expectedHost) throw new HttpError('请求来源无效', 403);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new HttpError('请求内容过大', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError('JSON 格式无效', 400); }
}

async function serveStatic(response, requestPath) {
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const filePath = path.resolve(publicDir, relative);
  if (!filePath.startsWith(`${publicDir}${path.sep}`) && filePath !== path.join(publicDir, 'index.html')) throw new HttpError('文件不存在', 404);
  try {
    const data = await fs.readFile(filePath);
    const extension = path.extname(filePath);
    response.writeHead(200, { 'Content-Type': mimeType(extension), 'Cache-Control': 'no-store' });
    response.end(data);
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError('文件不存在', 404);
    throw error;
  }
}

function setSecurityHeaders(response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function sendJson(response, status, payload) {
  if (response.headersSent) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body);
}

function clearSessionCookie(response) {
  response.setHeader('Set-Cookie', `session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cookieSecure ? '; Secure' : ''}`);
}

function cleanupSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
}

function clientAddress(request) {
  return String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function mimeType(extension) {
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' })[extension] || 'application/octet-stream';
}

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

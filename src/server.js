import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import * as upstream from './sub2api.js';
import { UpstreamError } from './sub2api.js';
import { KeyManager, ManagerError } from './manager.js';
import { safeEqual } from './utils.js';

const port = Number(process.env.PORT || 3000);
const adminPassword = process.env.ADMIN_PASSWORD || '111';
const cookieSecure = process.env.COOKIE_SECURE === 'true';
const superPassword = process.env.SUPERADMIN_PASSWORD || 'superadmin';
if (safeEqual(adminPassword, superPassword)) throw new Error('管理员与超级管理员密码不能相同');
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const sessions = new Map();
const loginAttempts = new Map();
const sessionTtlMs = 12 * 60 * 60 * 1000;
await store.loadStore();
const manager = new KeyManager({store,upstream});

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
      : (error instanceof HttpError || error instanceof ManagerError ? error.status : 500);
    if (status >= 500) console.error('[request]', error.message);
    sendJson(response, status, { error: status >= 500 && !(error instanceof UpstreamError) ? '服务器内部错误' : error.message });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Sub2API Key Manager listening on port ${server.address().port}`);
});
const runTick = () => manager.tick().catch(() => console.error('[scheduler] State operation failed'));
setTimeout(runTick, 1000);
setInterval(runTick, 30000);

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

  if (method === 'GET' && url.pathname === '/api/session') return sendJson(response,200,{authenticated:true,csrfToken:session.csrfToken,role:session.role});
  if (method === 'GET' && url.pathname === '/api/keys') return sendJson(response,200,manager.view());
  if (method === 'POST' && url.pathname === '/api/refresh') return sendJson(response,200,await manager.refresh());
  if ((method === 'POST' && url.pathname === '/api/keys') ||
      (method === 'DELETE' && url.pathname.startsWith('/api/keys/')) ||
      (method === 'PUT' && url.pathname === '/api/budget')) {
    if (session.role !== 'superadmin') throw new HttpError('仅超级管理员可执行此操作',403);
  }
  if (method === 'PUT' && url.pathname === '/api/budget') {
    const body=await readBody(request);
    return sendJson(response,200,await manager.setBudget(body.limit));
  }
  if (method === 'POST' && url.pathname === '/api/keys') {
    const body=await readBody(request);
    return sendJson(response,200,await manager.add(body.customKey));
  }
  const match=url.pathname.match(/^\/api\/keys\/([^/]+)$/);
  if (match && method === 'DELETE') return sendJson(response,200,await manager.remove(match[1]));
  if (match && method === 'PUT') {
    const body=await readBody(request);
    return sendJson(response,200,await manager.quota(match[1],body.quota));
  }
  throw new HttpError('接口不存在', 404);
}

async function login(request, response) {
  verifyOrigin(request);
  const address = clientAddress(request);
  const attempt = loginAttempts.get(address) || { count: 0, blockedUntil: 0 };
  if (Date.now() < attempt.blockedUntil) throw new HttpError('尝试次数过多，请稍后再试', 429);
  const body = await readBody(request);
  const role = safeEqual(body.password || '',superPassword) ? 'superadmin' : safeEqual(body.password || '',adminPassword) ? 'admin' : null;
  if (!role) {
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
  const session = { token, role, csrfToken: crypto.randomBytes(24).toString('base64url'), expiresAt: Date.now() + sessionTtlMs };
  sessions.set(token, session);
  response.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionTtlMs / 1000}${cookieSecure ? '; Secure' : ''}`);
  sendJson(response, 200, { authenticated: true, csrfToken: session.csrfToken, role });
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

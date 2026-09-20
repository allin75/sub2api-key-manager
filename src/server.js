import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import * as upstream from './sub2api.js';
import { UpstreamError } from './sub2api.js';
import { KeyManager, ManagerError } from './manager.js';
import { safeEqual, hashKey } from './utils.js';
import { reordered, closeAccountingWindow } from './budget-policy.js';

const port = Number(process.env.PORT || 3000);
const adminPassword = process.env.ADMIN_PASSWORD || '111';
const cookieSecure = process.env.COOKIE_SECURE === 'true';
const superPassword = process.env.SUPERADMIN_PASSWORD || 'superadmin';
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const sessions = new Map();
const loginAttempts = new Map();
const sessionTtlMs = 12 * 60 * 60 * 1000;
await store.loadStore();
if (!store.getState().accessKeys && safeEqual(adminPassword,superPassword)) throw new Error('首次登录密钥与超级管理员密码不能相同');
await store.initializeAccessKeys(adminPassword);
if (store.getState().accessKeys.some(item => safeEqual(item.secret, superPassword))) throw new Error('登录密钥与超级管理员密码不能相同');
const managers = new Map();
let operationQueue = Promise.resolve();
function exclusive(operation) {
  const result = operationQueue.then(operation);
  operationQueue = result.catch(() => {});
  return result;
}
function getManager(id) {
  if (!managers.has(id)) {
    const manager = new KeyManager({ store: store.scopedStore(id), upstream });
    // All scopes and credential changes share one queue to avoid lost updates.
    manager.exclusive = exclusive;
    managers.set(id, manager);
  }
  return managers.get(id);
}

if (store.getState().accessKeys.some(entry => entry.secret === '111')) {
  console.warn('[security] 存在默认登录密钥，请在页面中修改。');
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
let ticking = false;
const runTick = async () => {
  if (ticking) return;
  ticking = true;
  try {
    for (const entry of store.getState().accessKeys) await getManager(entry.id).tick();
  } catch { console.error('[scheduler] State operation failed'); }
  finally { ticking = false; }
};
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

  if (method === 'GET' && url.pathname === '/api/session') return sendJson(response,200,sessionView(session));
  if(method==='PUT'&&url.pathname==='/api/access-keys/order'){
    requireSuperadmin(session);const body=await readBody(request);
    await exclusive(async()=>{
      const next=store.getState();
      try{next.accessKeys=reordered(next.accessKeys,body.ids,next.accessOrderVersion||0,body.version);}catch(error){throw new HttpError(error.message,409);}
      next.accessOrderVersion=(next.accessOrderVersion||0)+1;await store.saveState(next);
    });
    return sendJson(response,200,accessKeyList());
  }
  if (url.pathname === '/api/access-keys') {
    requireSuperadmin(session);
    if (method === 'GET') return sendJson(response,200,accessKeyList());
    if (method === 'POST') {
      const body = await readBody(request);
      const entry = await exclusive(async () => {
        const next = store.getState();
        const secret = validateSecret(body.secret, next);
        const limit = validateLimit(body.limit);
        const entry = { id: crypto.randomUUID(), secret, previousSecrets: [], ownedHashes: [], state: structuredClone(store.initialState) };
        entry.state.budget.limit = limit;
        const type=body.type||'monthly';
        if(!['monthly','trial'].includes(type))throw new HttpError('额度类型无效',400);
        entry.state.budget.type=type;
        if(type==='trial'){entry.state.budget.trialStartedAt=new Date().toISOString();entry.state.budget.accountingFrom=entry.state.budget.trialStartedAt;}
        next.accessKeys.push(entry);
        next.accessOrderVersion=(next.accessOrderVersion||0)+1;
        await store.saveState(next);
        return entry;
      });
      await getManager(entry.id).refresh();
      return sendJson(response,201,{ accessKey: accessKeyView(entry) });
    }
  }
  const accessMatch = url.pathname.match(/^\/api\/access-keys\/([^/]+)$/);
  if (method === 'PUT' && (accessMatch || url.pathname === '/api/login-secret')) {
    if (accessMatch) requireSuperadmin(session);
    else if (!session.accessKeyId) throw new HttpError('请在登录密钥管理中选择要修改的密钥',400);
    const body = await readBody(request);
    const id = accessMatch ? accessMatch[1] : session.accessKeyId;
    const entry = await exclusive(async () => {
      const next = store.getState();
      const entry = next.accessKeys.find(item => item.id === id);
      if (!entry) throw new HttpError('登录密钥不存在',404);
      const secret = validateSecret(body.secret, next, id);
      if (entry.secret !== secret) {
        entry.previousSecrets = [...new Set([...entry.previousSecrets, entry.secret])];
        entry.secret = secret;
        await store.saveState(next);
        for (const [token, existing] of sessions) if (existing.accessKeyId === id) sessions.delete(token);
      }
      return entry;
    });
    return sendJson(response,200,{ accessKey: accessKeyView(entry) });
  }
  const entries = store.getState().accessKeys;
  const scopeId = url.searchParams.get('accessKeyId') || session.accessKeyId || store.getState().defaultAccessId;
  if (session.role !== 'superadmin' && scopeId !== session.accessKeyId) throw new HttpError('不能访问其他登录密钥的数据',403);
  if (!entries.some(item => item.id === scopeId)) throw new HttpError('登录密钥不存在',404);
  const manager = getManager(scopeId);
  if(method==='PUT'&&url.pathname==='/api/refresh-policy'){
    requireSuperadmin(session);
    return sendJson(response,200,await manager.setRefreshPolicy(await readBody(request)));
  }
  if(method==='PUT'&&url.pathname==='/api/keys/order'){
    const body=await readBody(request);return sendJson(response,200,await manager.reorder(body.ids,body.version));
  }
  if(method==='POST'&&url.pathname==='/api/rewards'){
    requireSuperadmin(session);const body=await readBody(request);
    return sendJson(response,201,await manager.grantReward(body.limit,body.expiresAt));
  }
  const transferMatch=url.pathname.match(/^\/api\/keys\/([^/]+)\/transfer$/);
  if (method === 'POST' && transferMatch) {
    requireSuperadmin(session);
    const body=await readBody(request);
    await exclusive(async () => {
      const destination=store.getState().accessKeys.find(entry=>entry.id===body.accessKeyId);
      if (!destination) throw new HttpError('目标登录密钥不存在',404);
      if (destination.id===scopeId) throw new HttpError('请选择另一条登录密钥',400);
      const targetManager=getManager(destination.id);
      const sourceState=manager.store.getState(),targetState=targetManager.store.getState();
      if (!sourceState.configuredKeys.some(key=>key.id===transferMatch[1])) throw new HttpError('API Key 不存在',404);
      if(sourceState.budget.type==='trial'||targetState.budget.type==='trial')throw new HttpError('体验额度与月度账本口径不同，体验模式下暂不支持转移 API Key 关联',409);
      if (!await manager.sync(sourceState) || !await targetManager.sync(targetState)) throw new HttpError('同步失败，未转移关联，请稍后重试',502);
      if([sourceState,targetState].some(s=>s.budget.cycleMonth&&s.budget.cycleMonth!==s.budget.month))throw new HttpError('存在未刷新的跨月累计用量，暂不可转移关联；请等待月刷新后操作',409);
      if (sourceState.budget.month !== targetState.budget.month) throw new HttpError('同步期间发生跨月，请重试转移关联',409);
      const next=store.getState(),source=next.accessKeys.find(entry=>entry.id===scopeId),target=next.accessKeys.find(entry=>entry.id===destination.id);
      const key=source.state.configuredKeys.find(key=>key.id===transferMatch[1]);
      const hash=key.keyHash;
      const transferredAt=new Date().toISOString();
      closeAccountingWindow(source.state.budget,hash,transferredAt);
      // The receiver must keep reading details when a former owner can still
      // allocate late records to its rewards, even without rewards of its own.
      if(source.state.budget.accountingFrom)target.state.budget.accountingFrom??=transferredAt;
      if(target.state.budget.accountingFrom){
        target.state.budget.tracking??={};
        const prior=target.state.budget.tracking[hash];
        if(prior){prior.windows.push({from:transferredAt});delete prior.until;}
        else {
          // A newly linked key cannot spend a destination reward retroactively.
          const sourceTrack=source.state.budget.tracking?.[hash];
          const upstreamKey=(await upstream.listAllKeys()).find(item=>hashKey(String(item.key||''))===hash);
          if(!upstreamKey)throw new HttpError('API Key 无法匹配，未转移',409);
          target.state.budget.tracking[hash]={apiKeyId:sourceTrack?.apiKeyId||upstreamKey.id,from:new Date(`${target.state.budget.month}-01T00:00:00+08:00`).toISOString(),windows:[{from:transferredAt}]};
        }
      }
      source.state.configuredKeys=source.state.configuredKeys.filter(item=>item.id!==key.id);
      source.state.cache.keys=source.state.cache.keys.filter(item=>item.id!==key.id);
      source.ownedHashes=source.ownedHashes.filter(value=>value!==hash);
      target.state.configuredKeys.push(key);
      target.ownedHashes=[...new Set([...target.ownedHashes,hash])];
      target.state.budget.ledger[hash]=source.state.budget.ledger[hash]||0;
      delete source.state.budget.ledger[hash];
      target.state.budget.rawLedger??={...target.state.budget.ledger};
      target.state.budget.rawLedger[hash]=source.state.budget.rawLedger?.[hash]||0;
      if(source.state.budget.rawLedger)delete source.state.budget.rawLedger[hash];
      if(source.state.budget.rawAnchors?.[hash]){
        target.state.budget.rawAnchors??={};target.state.budget.rawAnchors[hash]=source.state.budget.rawAnchors[hash];
        delete source.state.budget.rawAnchors[hash];
      }
      for(const entry of [source,target])entry.state.orderVersion=(entry.state.orderVersion||0)+1;
      if (source.state.budget.paused[hash]) {
        target.state.budget.paused[hash]=source.state.budget.paused[hash];
        delete source.state.budget.paused[hash];
      }
      if(source.state.budget.rewardHold?.[hash]){target.state.budget.rewardHold??={};target.state.budget.rewardHold[hash]=true;delete source.state.budget.rewardHold[hash];}
      // Ownership and its ledger move atomically; retries survive a crash or upstream failure.
      for (const entry of [source,target]) {
        entry.state.cache.error='关联已调整，等待额度同步';
        entry.state.actionRetry=true;entry.state.retryAt=new Date().toISOString();
        if(entry.state.resetOperation)entry.state.resetOperation.succeededHashes=entry.state.resetOperation.succeededHashes.filter(value=>value!==hash);
      }
      await store.saveState(next);
      await manager.sync(manager.store.getState());
      await targetManager.sync(targetManager.store.getState());
    });
    const accessKeys=accessKeyList().accessKeys;
    const pendingSync=accessKeys.some(entry=>[scopeId,body.accessKeyId].includes(entry.id)&&(entry.budget.error||entry.budget.pendingCount));
    return sendJson(response,200,{ ...manager.view(), accessKeys, pendingSync });
  }
  if (method === 'GET' && url.pathname === '/api/keys') return sendJson(response,200,manager.view());
  if (method === 'POST' && url.pathname === '/api/refresh') return sendJson(response,200,await manager.refresh());
  if ((method === 'POST' && url.pathname === '/api/keys') ||
      (method === 'DELETE' && url.pathname.startsWith('/api/keys/')) ||
      (method === 'PUT' && url.pathname === '/api/budget')) {
    if (session.role !== 'superadmin') throw new HttpError('仅超级管理员可执行此操作',403);
  }
  if (method === 'PUT' && url.pathname === '/api/budget') {
    const body=await readBody(request);
    return sendJson(response,200,await manager.setBudget(body.limit,body.type));
  }
  if (method === 'POST' && url.pathname === '/api/keys') {
    const body=await readBody(request);
    // Check ownership inside the same queue as the add operation.
    const result = await exclusive(async () => {
      const hash = typeof body.customKey === 'string' ? hashKey(body.customKey.trim()) : null;
      if (store.getState().accessKeys.some(item => item.id !== scopeId && (item.ownedHashes.includes(hash) || item.state.budget.ledger[hash] !== undefined || item.state.budget.paused[hash]))) throw new HttpError('该 API Key 已关联其他登录密钥',409);
      return manager.addNow(body.customKey);
    });
    return sendJson(response,200,result);
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
  const password = typeof body.password === 'string' ? body.password : '';
  const entry = store.getState().accessKeys.find(item => safeEqual(password,item.secret));
  const role = safeEqual(password,superPassword) ? 'superadmin' : entry ? 'admin' : null;
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
  const session = { token, role, accessKeyId: role === 'admin' ? entry.id : null, csrfToken: crypto.randomBytes(24).toString('base64url'), expiresAt: Date.now() + sessionTtlMs };
  sessions.set(token, session);
  response.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionTtlMs / 1000}${cookieSecure ? '; Secure' : ''}`);
  sendJson(response, 200, sessionView(session));
}

function requireSuperadmin(session) {
  if (session.role !== 'superadmin') throw new HttpError('仅超级管理员可执行此操作',403);
}

function accessKeyView(entry) {
  return { id: entry.id, secret: entry.secret, previousSecrets: entry.previousSecrets };
}

function sessionView(session) {
  const entry = store.getState().accessKeys.find(item => item.id === session.accessKeyId);
  return { authenticated: true, csrfToken: session.csrfToken, role: session.role, accessKey: entry ? accessKeyView(entry) : null };
}

function accessKeyList() {
  const accessKeys = store.getState().accessKeys.map(entry => {
    const view = getManager(entry.id).view();
    return { ...accessKeyView(entry), budget: view.budget, rewards:view.rewards, keyCount: view.keys.length };
  });
  return { accessKeys,orderVersion:store.getState().accessOrderVersion||0 };
}

function validateSecret(value, state, id) {
  if (typeof value !== 'string' || value !== value.trim() || !value.length || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError('登录密钥需为 1–128 个字符，首尾不能有空格',400);
  if (safeEqual(value,superPassword) || state.accessKeys.some(item => item.id !== id && safeEqual(item.secret,value))) throw new HttpError('该登录密钥已存在，请换一个',409);
  return value;
}

function validateLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.01 || value > 1e8) throw new HttpError('月度额度必须为 $0.01–$100,000,000',400);
  return Math.round(value * 100) / 100;
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

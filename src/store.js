import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashKey } from './utils.js';

const dataDir = process.env.DATA_DIR || '/data';
const dataFile = path.join(dataDir, 'state.json');
export const initialState = { version: 3, configuredKeys: [], lastResetAt: null, resetOperation: null,
  budget: { limit: null, month: null, ledger: {}, blocked: false, paused: {} },
  cache: { keys: [], lastSuccessAt: null, lastAttemptAt: null, nextCheckAt: null, error: null },
  retryAt: null };

let state = structuredClone(initialState);
let writeQueue = Promise.resolve();

export async function loadStore() {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(await fs.readFile(dataFile, 'utf8'));
    state = { ...structuredClone(initialState), ...parsed };
    validateState(state);
    if (parsed.version !== 3) {
      await fs.copyFile(dataFile, `${dataFile}.v2-backup`);
      state.version = 3;
      await persist();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await persist();
  }
}

export function getState() {
  return structuredClone(state);
}

// Run once at startup. The original password keeps all pre-upgrade data.
export async function initializeAccessKeys(secret) {
  if (state.accessKeys) {
    if (!state.defaultAccessId) await saveState({...getState(),defaultAccessId:state.accessKeys[0].id});
    return;
  }
  await fs.copyFile(dataFile, `${dataFile}.v3-backup`, fs.constants.COPYFILE_EXCL).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const original = getState();
  const next = structuredClone(initialState);
  next.accessKeys = [{ id: crypto.randomUUID(), secret, previousSecrets: [], ownedHashes: original.configuredKeys.map(key => key.keyHash), state: original }];
  next.defaultAccessId = next.accessKeys[0].id;
  await saveState(next);
}

export function scopedStore(id) {
  return {
    getState() {
      const entry = state.accessKeys.find(item => item.id === id);
      if (!entry) throw new Error('登录密钥不存在');
      const snapshot=structuredClone(entry.state);
      snapshot.budget.externalCredits={};
      for(const other of state.accessKeys){
        if(other.id===id)continue;
        for(const [month,credits] of Object.entries(other.state.budget.credits||{})){
          snapshot.budget.externalCredits[month]??={};
          for(const [hash,cost] of Object.entries(credits))snapshot.budget.externalCredits[month][hash]=(snapshot.budget.externalCredits[month][hash]||0)+cost;
        }
      }
      return snapshot;
    },
    async saveState(snapshot) {
      const next = getState();
      const entry = next.accessKeys.find(item => item.id === id);
      if (!entry) throw new Error('登录密钥不存在');
      entry.state = structuredClone(snapshot);
      delete entry.state.budget.externalCredits;
      entry.ownedHashes = [...new Set([...entry.ownedHashes, ...snapshot.configuredKeys.map(key => key.keyHash)])];
      await saveState(next);
    }
  };
}

export async function saveState(next) {
  validateState(next);
  const snapshot = structuredClone(next);
  const operation = writeQueue.catch(() => {}).then(async () => {
    const temporaryFile = `${dataFile}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await fs.rename(temporaryFile, dataFile);
    state = snapshot;
  });
  writeQueue = operation;
  return operation;
}

export async function addConfiguredKey(customKey) {
  const normalized = customKey.trim();
  const keyHash = hashKey(normalized);
  const existing = state.configuredKeys.find(item => item.keyHash === keyHash);
  if (existing) return { item: structuredClone(existing), created: false };
  const item = {
    id: crypto.randomUUID(),
    keyHash,
    maskedKey: normalized.length > 12 ? `${normalized.slice(0, 7)}••••${normalized.slice(-4)}` : `••••${normalized.slice(-4)}`,
    addedAt: new Date().toISOString()
  };
  state.configuredKeys.push(item);
  await persist();
  return { item: structuredClone(item), created: true };
}

export async function removeConfiguredKey(id) {
  const before = state.configuredKeys.length;
  state.configuredKeys = state.configuredKeys.filter(item => item.id !== id);
  if (state.configuredKeys.length === before) return false;
  await persist();
  return true;
}

export async function setLastResetAt(value) {
  state.lastResetAt = value;
  state.resetOperation = null;
  await persist();
}

export async function setResetOperation(operation) {
  state.resetOperation = operation;
  await persist();
}

async function persist() {
  writeQueue = writeQueue.then(async () => {
    const temporaryFile = `${dataFile}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(temporaryFile, dataFile);
  });
  return writeQueue;
}

function validateState(value) {
  if (value.accessKeys !== undefined) {
    if (!Array.isArray(value.accessKeys) || !value.accessKeys.length) throw new Error('登录密钥配置无效');
    if(value.defaultAccessId!==undefined&&!value.accessKeys.some(entry=>entry.id===value.defaultAccessId))throw new Error('默认登录范围无效');
    const ids = new Set(), secrets = new Set(), hashes = new Set();
    for (const entry of value.accessKeys) {
      if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || typeof entry.secret !== 'string' || !entry.secret || secrets.has(entry.secret) || !Array.isArray(entry.previousSecrets) || entry.previousSecrets.some(secret => typeof secret !== 'string') || !Array.isArray(entry.ownedHashes) || !entry.state || entry.state.accessKeys !== undefined) throw new Error('登录密钥配置无效');
      ids.add(entry.id); secrets.add(entry.secret);
      for (const hash of new Set([...entry.ownedHashes, ...entry.state.configuredKeys.map(key => key.keyHash), ...Object.keys(entry.state.budget.paused)])) {
        if (hashes.has(hash)) throw new Error('API Key 不可关联多个登录密钥');
        hashes.add(hash);
      }
      validateState(entry.state);
    }
  }
  if (!Array.isArray(value.configuredKeys)) throw new Error('state.json 中 configuredKeys 格式无效');
  if (value.lastResetAt && !Number.isFinite(new Date(value.lastResetAt).getTime())) throw new Error('state.json 中 lastResetAt 格式无效');
  if (value.resetOperation) {
    if (!Number.isFinite(new Date(value.resetOperation.startedAt).getTime()) || !Array.isArray(value.resetOperation.succeededHashes)) {
      throw new Error('state.json 中 resetOperation 格式无效');
    }
  }
  if (!value.budget || (value.budget.limit !== null && (!Number.isFinite(value.budget.limit) || value.budget.limit <= 0))) throw new Error('月度额度配置无效');
  if (!value.budget.ledger || !value.budget.paused || !value.cache) throw new Error('月度账本配置无效');
  if (Object.values(value.budget.ledger).some(cost => !Number.isSafeInteger(cost) || cost < 0)) throw new Error('月度费用快照无效');
  const b=value.budget;
  for(const field of ['weeklyResetEnabled','monthlyResetEnabled'])if(b[field]!==undefined&&typeof b[field]!=='boolean')throw new Error('刷新开关无效');
  if(b.weeklyNotBefore!==undefined&&!Number.isFinite(Date.parse(b.weeklyNotBefore)))throw new Error('周刷新起点无效');
  if(b.cycleMonth!==undefined&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(b.cycleMonth))throw new Error('额度周期无效');
  if(b.type!==undefined&&!['monthly','trial'].includes(b.type))throw new Error('额度类型无效');
  if(b.type==='trial'&&!Number.isFinite(Date.parse(b.trialStartedAt)))throw new Error('体验额度起点无效');
  if(b.rawLedger&&Object.values(b.rawLedger).some(cost=>!Number.isSafeInteger(cost)||cost<0))throw new Error('实际费用快照无效');
  if(b.rewards&&(!Array.isArray(b.rewards)||b.rewards.some(r=>typeof r.id!=='string'||!Number.isFinite(r.limit)||r.limit<=0||!Number.isSafeInteger(r.used)||r.used<0||!Number.isFinite(Date.parse(r.startsAt))||!Number.isFinite(Date.parse(r.expiresAt))||r.expiresAt<=r.startsAt)))throw new Error('奖励账本无效');
  if(b.records&&Object.entries(b.records).some(([id,r])=>id!==r.id||typeof r.keyHash!=='string'||!Number.isFinite(Date.parse(r.at))||!Number.isSafeInteger(r.cost)||r.cost<0))throw new Error('消费明细账本无效');
  if(b.tracking&&Object.values(b.tracking).some(t=>!Number.isSafeInteger(t.apiKeyId)||!Number.isFinite(Date.parse(t.from))||(t.until&&!Number.isFinite(Date.parse(t.until)))||!Array.isArray(t.windows)||t.windows.some(w=>!Number.isFinite(Date.parse(w.from))||(w.until&&(!Number.isFinite(Date.parse(w.until))||w.until<w.from)))))throw new Error('消费追踪窗口无效');
  if(b.rawAnchors&&Object.values(b.rawAnchors).some(a=>!Number.isFinite(Date.parse(a.at))||!Number.isSafeInteger(a.cost)||a.cost<0))throw new Error('实际消费基线无效');
  if(value.orderVersion!==undefined&&(!Number.isSafeInteger(value.orderVersion)||value.orderVersion<0))throw new Error('排序版本无效');
  if(value.accessOrderVersion!==undefined&&(!Number.isSafeInteger(value.accessOrderVersion)||value.accessOrderVersion<0))throw new Error('登录密钥排序版本无效');
}

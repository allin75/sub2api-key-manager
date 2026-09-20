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
  if (state.accessKeys) return;
  await fs.copyFile(dataFile, `${dataFile}.v3-backup`, fs.constants.COPYFILE_EXCL).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const original = getState();
  const next = structuredClone(initialState);
  next.accessKeys = [{ id: crypto.randomUUID(), secret, previousSecrets: [], ownedHashes: original.configuredKeys.map(key => key.keyHash), state: original }];
  await saveState(next);
}

export function scopedStore(id) {
  return {
    getState() {
      const entry = state.accessKeys.find(item => item.id === id);
      if (!entry) throw new Error('登录密钥不存在');
      return structuredClone(entry.state);
    },
    async saveState(snapshot) {
      const next = getState();
      const entry = next.accessKeys.find(item => item.id === id);
      if (!entry) throw new Error('登录密钥不存在');
      entry.state = structuredClone(snapshot);
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
}

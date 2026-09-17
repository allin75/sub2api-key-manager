import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashKey } from './utils.js';

const dataDir = process.env.DATA_DIR || '/data';
const dataFile = path.join(dataDir, 'state.json');
const initialState = { version: 2, configuredKeys: [], lastResetAt: null, resetOperation: null };

let state = structuredClone(initialState);
let writeQueue = Promise.resolve();

export async function loadStore() {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(await fs.readFile(dataFile, 'utf8'));
    state = { ...structuredClone(initialState), ...parsed };
    validateState(state);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await persist();
  }
}

export function getState() {
  return structuredClone(state);
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
  if (!Array.isArray(value.configuredKeys)) throw new Error('state.json 中 configuredKeys 格式无效');
  if (value.lastResetAt && !Number.isFinite(new Date(value.lastResetAt).getTime())) throw new Error('state.json 中 lastResetAt 格式无效');
  if (value.resetOperation) {
    if (!Number.isFinite(new Date(value.resetOperation.startedAt).getTime()) || !Array.isArray(value.resetOperation.succeededHashes)) {
      throw new Error('state.json 中 resetOperation 格式无效');
    }
  }
}

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const budget = {
  type: 'monthly', limit: 500, used: 96.27, balance: 403.73, status: 'active', stale: false,
  monthlyResetEnabled: true, weeklyResetEnabled: true, error: null, rateLimitedUntil: null,
  lastSuccessAt: '2026-10-21T07:00:00Z', nextCheckAt: '2026-10-21T08:00:00Z', nextMonthAt: '2026-10-31T16:00:00Z'
};
const account = { id: 'demo-admin', secret: 'demo-admin', previousSecrets: [], keyCount: 4, budget, rewards: [] };
const keys = ['Research', 'Coding', 'Writing', 'Automation'].map((name, i) => ({
  id: `demo-${i}`, name: `Demo ${name}`, matched: true, maskedKey: 'sk-demo-only', status: 'active',
  quota: 120, quotaUsed: 18.72 + i * 11, lastUsedAt: '2026-10-21T06:56:00Z',
  usage: {
    daily: [3, 6, 8, 12, 15, 4, 7].map((cost, j) => ({ date: `2026-10-${String(j + 15).padStart(2, '0')}`, cost })),
    ...Object.fromEntries(['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth'].map((id, j) => [id, {
      cost: j === 0 ? [16.94, 35.46, 8.50, 20][i] : [0, 35.46, 52.70, 140.38, 325.64, 586.14][j]
    }]))
  }
}));

export function createPreviewServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname.startsWith('/api/')) {
      response.setHeader('Content-Type', 'application/json');
      if (request.method !== 'GET') {
        response.writeHead(405);
        return response.end(JSON.stringify({ error: 'Preview is read-only' }));
      }
      if (url.pathname === '/api/session') return response.end(JSON.stringify({ role: 'admin', csrfToken: 'fake-only', accessKey: account, announcement: { version: 'demo', acknowledged: true }, notices: [] }));
      if (url.pathname === '/api/keys') return response.end(JSON.stringify({ keys, budget, rewards: [], orderVersion: 0, schedule: null }));
      if (url.pathname === '/api/sync-status') return response.end(JSON.stringify({ inProgress: false, lastSuccessAt: budget.lastSuccessAt, nextCheckAt: budget.nextCheckAt, error: budget.error, rateLimitedUntil: budget.rateLimitedUntil, events: [] }));
      return response.end(JSON.stringify({ notices: [] }));
    }
    try {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(root, 'public', name);
      if (!file.startsWith(path.resolve(root, 'public') + path.sep)) throw new Error('Invalid path');
      let body = await fs.readFile(file);
      if (name === 'overrides.css' && !url.searchParams.has('baseline')) {
        body = Buffer.concat([body, Buffer.from('\n'), await fs.readFile(new URL('today-tile-glow.css', import.meta.url))]);
      }
      response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createPreviewServer().listen(3115, '127.0.0.1', () => console.log('Fake-data preview http://127.0.0.1:3115/'));
}

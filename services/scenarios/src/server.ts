/**
 * Scenario service HTTP entry (prompt §12). Minimal Node http server exposing:
 *   POST /scenarios/:id   → run a scenario, return before/after + actions
 *   GET  /health
 * Uses an in-memory bus so the cross-twin emit is observable in the response
 * (`crossTwinEvent`); in the composed stack the gateway injects the Kafka bus.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { InMemoryEventBus } from '@jnpa/sim';
import type { BaselinesConfig } from '@jnpa/kpi';
import { ScenarioEngine } from './engine.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const terminalsConfig = JSON.parse(readFileSync(join(root, 'config', 'terminals.json'), 'utf8'));
const baselines = JSON.parse(readFileSync(join(root, 'config', 'baselines.json'), 'utf8')) as BaselinesConfig;

const bus = new InMemoryEventBus();
const engine = new ScenarioEngine({ terminalsConfig, baselines, bus });
const PORT = Number(process.env.SCENARIOS_PORT ?? 8090);

const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ ok: true, service: 'scenarios' }));
    return;
  }
  const m = req.url?.match(/^\/scenarios\/([A-Za-z0-9-]+)$/);
  if (req.method === 'POST' && m) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let params = {};
      try {
        params = body ? JSON.parse(body) : {};
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }
      const result = engine.run(m[1]!, params);
      res.end(JSON.stringify(result));
    });
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[scenarios] listening on :${PORT}`);
});

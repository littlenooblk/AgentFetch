import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockServer } from '../src/mocks/server.js';
import { priceManifest } from '../src/mocks/manifests.js';
import { CapabilityRegistry } from '../src/registry/index.js';
import { listCapabilities } from '../src/discovery/index.js';
import { startAgentFetchServer } from '../src/service/index.js';

let provider: http.Server;
let providerUrl = '';
let service: Awaited<ReturnType<typeof startAgentFetchServer>>;

beforeAll(async () => {
  provider = createMockServer();
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address() as { port: number };
  providerUrl = `http://127.0.0.1:${address.port}`;
  const registry = new CapabilityRegistry(join(mkdtempSync(join(tmpdir(), 'agent-fetch-service-')), 'capabilities.json'));
  const ref = listCapabilities(priceManifest, providerUrl)[0]!;
  registry.saveCapability(ref, 'test-provider', { status: 'active', user_confirmed: true });
  service = await startAgentFetchServer({ host: '127.0.0.1', port: 0, registry, deterministic: true, allowLoopback: true });
});

afterAll(async () => {
  await service.close();
  await new Promise<void>(resolve => provider.close(() => resolve()));
});

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${service.port}${path}`, init);
}

describe('AgentFetch public service', () => {
  it('exposes health and OpenAI-compatible tools', async () => {
    expect((await request('/health')).status).toBe(200);
    const response = await request('/v1/tools');
    const body = await response.json() as { data: Array<{ function: { name: string } }> };
    expect(body.data.some(tool => tool.function.name === 'agentfetch_product_price_read')).toBe(true);
  });

  it('executes a declared function tool', async () => {
    const response = await request('/v1/tools/agentfetch_product_price_read/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ arguments: { id: 'iphone16' } }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { answer: { amount: number } } };
    expect(body.result.answer.amount).toBe(5999);
  });

  it('accepts OpenAI-style chat requests and public provider publication', async () => {
    const chat = await request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'agent-fetch', base_url: providerUrl, messages: [{ role: 'user', content: '查询 iPhone 16 当前价格' }] }) });
    expect(chat.status).toBe(200);
    expect((await chat.json() as { object: string }).object).toBe('chat.completion');
    const manifest = { ...priceManifest, servers: [{ url: providerUrl }] };
    const publication = await request('/v1/providers/published-provider/manifest', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol_version: 'agentfetch.v1', provider: { id: 'published-provider', name: 'Published Provider', version: '1.0.0' }, manifest }) });
    expect(publication.status).toBe(201);
    expect((await publication.json() as { capability_ids: string[] }).capability_ids).toContain('product.price.read');
    const query = await request('/v1/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ base_url: providerUrl, question: '查询 iPhone 16 当前价格' }) });
    expect(query.status).toBe(200);
    expect((await query.json() as { answer: { amount: number } }).answer.amount).toBe(5999);
  });
});

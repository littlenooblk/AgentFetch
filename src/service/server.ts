import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { runAgentFetch, runRegisteredQuestion } from '../cli/index.js';
import { CapabilityRegistry, type CapabilityCandidateInput, type CapabilityRegistryQuery } from '../registry/index.js';
import type { ModelJsonClient } from '../llm/types.js';
import { createConfiguredLlmClient } from '../llm/openai-compatible.js';
import type { CapabilityRef, OpenApiManifest, HttpMethod } from '../spec/index.js';
import { listCapabilities } from '../discovery/index.js';
import { HttpExecutor } from '../executor/http.js';
import { ResponseCache } from '../executor/cache.js';
import { normalize } from '../normalizer/normalizer.js';
import { capabilitiesToOpenAITools, createCapabilityPublishResponse, createToolListResponse, parseCapabilityPublishRequest, parseToolArguments, toolNameForCapability } from '../protocol/index.js';

/** Options for the OpenAI-compatible AgentFetch service. */
export interface AgentFetchServiceOptions {
  /** Address to bind when startAgentFetchServer is used. Defaults to AGENT_FETCH_SERVICE_HOST or 0.0.0.0. */
  host?: string;
  /** Port to bind. Use 0 in tests to let the operating system pick a port. */
  port?: number;
  /** Use an explicit registry (useful for tests and for a database adapter later). */
  registry?: CapabilityRegistry;
  /** Inject a model client. If omitted, AGENT_FETCH_LLM_* is used when configured. */
  llm?: ModelJsonClient;
  /** Skip the LLM and use the deterministic planner. */
  deterministic?: boolean;
  /** Extra domains accepted by direct execution. */
  allowDomains?: string[];
  /** Allow loopback URLs. Keep false in a public deployment. */
  allowLoopback?: boolean;
  /** Permit the interactive Playwright fallback. It is disabled by default for headless services. */
  browserFallback?: boolean;
  /** Optional bearer token. When set, all routes except health and discovery require it. */
  apiKey?: string;
  /** Maximum JSON request size. Defaults to 1 MiB. */
  maxBodyBytes?: number;
  /** Inject a runner for tests or a future remote execution backend. */
  run?: AgentFetchRunner;
}

export interface AgentFetchRunOptions {
  manifest?: string;
  allowDomain?: string[];
  allowLoopback?: boolean;
  noBrowser?: boolean;
  llm?: ModelJsonClient;
  deterministic?: boolean;
  registry?: CapabilityRegistry;
}

export type AgentFetchRunner = (baseUrl: string, question: string, options?: AgentFetchRunOptions) => Promise<unknown>;

export interface AgentFetchServiceHandle {
  server: http.Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

const SERVICE_MODEL = process.env.AGENT_FETCH_SERVICE_MODEL ?? 'agent-fetch';
const OPENAPI_MANIFEST = {
  openapi: '3.1.0',
  info: { title: 'AgentFetch Service', version: '0.1.0' },
  paths: {
    '/v1/chat/completions': { post: { operationId: 'chatCompletions', responses: { '200': { description: 'OpenAI-compatible completion' } } } },
    '/v1/query': { post: { operationId: 'query', responses: { '200': { description: 'Normalized AgentFetch result' } } } },
    '/v1/tools': { get: { operationId: 'listTools', responses: { '200': { description: 'OpenAI-compatible function tools' } } } },
    '/v1/tools/call': { post: { operationId: 'callTool', responses: { '200': { description: 'AgentFetch tool result' } } } },
    '/v1/providers/{provider_id}/manifest': { put: { operationId: 'publishProviderManifest', responses: { '201': { description: 'Published capabilities' } } } },
    '/v1/capabilities': { post: { operationId: 'writeCapability', responses: { '201': { description: 'Capability record' } } } },
    '/v1/registry/capabilities': { get: { operationId: 'listCapabilities', responses: { '200': { description: 'Capability records' } } }, post: { operationId: 'registerCapability', responses: { '201': { description: 'Capability record' } } } },
  },
  'x-agent-provider': { id: 'agentfetch.service', name: 'AgentFetch', version: '0.1.0' },
};

const TOOL = {
  type: 'function',
  function: {
    name: 'agent_fetch',
    description: 'Find and call a declared website capability through AgentFetch. The service may fall back to a user-controlled browser session when enabled.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string', description: 'Natural-language request, for example 查询 iPhone 16 当前价格' },
        base_url: { type: 'string', format: 'uri', description: 'Optional website/provider origin. Omit to search the shared capability registry.' },
        manifest: { type: 'string', format: 'uri', description: 'Optional OpenAPI 3.1 manifest URL.' },
      },
      required: ['question'],
    },
  },
} as const;

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function configuredOptions(options: AgentFetchServiceOptions): Required<Pick<AgentFetchServiceOptions, 'host' | 'port' | 'allowLoopback' | 'browserFallback' | 'maxBodyBytes'>> {
  const portValue = options.port ?? Number(process.env.AGENT_FETCH_SERVICE_PORT ?? 8788);
  return {
    host: options.host ?? process.env.AGENT_FETCH_SERVICE_HOST ?? '0.0.0.0',
    port: Number.isFinite(portValue) && portValue >= 0 ? portValue : 8788,
    allowLoopback: options.allowLoopback ?? envBool('AGENT_FETCH_SERVICE_ALLOW_LOOPBACK', false),
    browserFallback: options.browserFallback ?? envBool('AGENT_FETCH_SERVICE_BROWSER', false),
    maxBodyBytes: options.maxBodyBytes ?? Number(process.env.AGENT_FETCH_SERVICE_MAX_BODY_BYTES ?? 1024 * 1024),
  };
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function errorBody(code: string, message: string): { error: { message: string; type: string; code: string } } {
  return { error: { message, type: 'invalid_request_error', code } };
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, any>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > maxBytes) throw new Error('request_too_large');
    chunks.push(part);
  }
  if (!size) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request_json_object_required');
    return parsed as Record<string, any>;
  } catch (error) {
    if (error instanceof Error && error.message === 'request_json_object_required') throw error;
    throw new Error('request_invalid_json');
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(item => typeof item === 'string' ? item : (item && typeof item === 'object' && typeof (item as any).text === 'string' ? (item as any).text : '')).filter(Boolean).join('\n');
  if (content && typeof content === 'object' && typeof (content as any).text === 'string') return (content as any).text;
  return '';
}

function questionFromBody(body: Record<string, any>): string {
  if (typeof body.question === 'string' && body.question.trim()) return body.question.trim();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === 'user') {
      const content = textFromContent(message.content);
      if (content.trim()) return content.trim();
    }
  }
  return '';
}

function baseUrlFromBody(body: Record<string, any>, req: IncomingMessage): string | undefined {
  const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  const headers = req.headers;
  for (const value of [body.base_url, body.baseUrl, body.website, metadata.base_url, metadata.baseUrl, headers['x-agent-fetch-base-url']]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function completion(result: unknown, model: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-agentfetch-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: now,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(result) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function queryFromUrl(url: URL): CapabilityRegistryQuery {
  const allowed = ['id', 'capability_id', 'domain', 'method', 'source', 'version', 'status', 'user_confirmed', 'text'] as const;
  const query: CapabilityRegistryQuery = {};
  for (const key of allowed) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    if (key === 'user_confirmed') query.user_confirmed = /^(1|true|yes)$/i.test(value);
    else if (key === 'status') query.status = value.includes(',') ? value.split(',') as any : value as any;
    else (query as any)[key] = value;
  }
  return query;
}

function authenticated(req: IncomingMessage, expected: string | undefined): boolean {
  if (!expected) return true;
  const supplied = req.headers.authorization;
  return typeof supplied === 'string' && supplied.startsWith('Bearer ') && supplied.slice(7) === expected;
}

function registryRefs(registry: CapabilityRegistry, readOnlyOnly = false): CapabilityRef[] {
  const refs = registry.query({ status: 'active', user_confirmed: true }).flatMap(record => {
    if (!record.capability || !record.operation || !record.path) return [];
    if (readOnlyOnly && (!record.capability.read_only || record.capability.side_effects !== 'none')) return [];
    let baseUrl: string;
    try { baseUrl = new URL(record.url).origin; } catch { baseUrl = `https://${record.domain}`; }
    const method = record.method.toLowerCase() as HttpMethod;
    const manifest: OpenApiManifest = { openapi: '3.1.0', info: { title: 'AgentFetch registry', version: record.version ?? 'stored' }, paths: { [record.path]: { [method]: record.operation } } };
    return [{ manifest, path: record.path, method, operation: record.operation, capability: record.capability, baseUrl }];
  });
  const seen = new Set<string>();
  return refs.filter(ref => { const key = `${ref.capability.id}:${ref.method}:${ref.path}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

async function executeDeclaredTool(name: string, args: Record<string, unknown>, registry: CapabilityRegistry, allowDomains: string[], allowLoopback: boolean): Promise<unknown> {
  const ref = registryRefs(registry, true).find(item => toolNameForCapability(item.capability.id) === name);
  if (!ref) throw new Error('unknown_tool');
  const result = await new HttpExecutor({ allowedDomains: [...new Set([...allowDomains, new URL(ref.baseUrl).hostname])], allowLoopback, cache: new ResponseCache() }).execute(ref, args);
  return normalize(result.data, ref.capability, result.url, 'direct-http', false, result.cacheHit ? 'cached' : 'live', { cache_hit: result.cacheHit });
}

/** Create an OpenAI-compatible HTTP server. It is intentionally dependency-free so providers can deploy it anywhere Node 20 runs. */
export function createAgentFetchServer(options: AgentFetchServiceOptions = {}): http.Server {
  const config = configuredOptions(options);
  const registry = options.registry ?? new CapabilityRegistry();
  const llm = options.llm ?? (options.deterministic ? undefined : createConfiguredLlmClient());
  const run = options.run ?? runAgentFetch;
  const apiKey = options.apiKey ?? process.env.AGENT_FETCH_SERVICE_API_KEY;
  const allowDomains = [...(options.allowDomains ?? []), ...(process.env.AGENT_FETCH_ALLOWED_DOMAINS ?? '').split(',').map(item => item.trim()).filter(Boolean)];

  const execute = async (body: Record<string, any>, req: IncomingMessage): Promise<unknown> => {
    const question = questionFromBody(body);
    if (!question) throw new Error('question_required');
    const baseUrl = baseUrlFromBody(body, req);
    const manifest = typeof body.manifest === 'string' ? body.manifest : (body.metadata && typeof body.metadata.manifest === 'string' ? body.metadata.manifest : undefined);
    const shared = { manifest, allowDomain: allowDomains, allowLoopback: config.allowLoopback, noBrowser: !config.browserFallback, llm, deterministic: options.deterministic, registry };
    if (baseUrl) return run(baseUrl, question, shared);
    return runRegisteredQuestion(question, { registry, allowDomain: allowDomains, allowLoopback: config.allowLoopback, llm, deterministic: options.deterministic });
  };

  return http.createServer(async (req, res) => {
    // CORS keeps the public registry usable by browser-based developer tools.
    res.setHeader('access-control-allow-origin', process.env.AGENT_FETCH_SERVICE_CORS_ORIGIN ?? '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-agent-fetch-base-url');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (url.pathname === '/health' || url.pathname === '/healthz') { json(res, 200, { status: 'ok', service: 'agentfetch', model: SERVICE_MODEL }); return; }
      if (url.pathname === '/.well-known/agent-fetch/openapi.json') { json(res, 200, OPENAPI_MANIFEST, { 'cache-control': 'public, max-age=300' }); return; }
      if (!authenticated(req, apiKey)) { json(res, 401, errorBody('unauthorized', 'Bearer token required')); return; }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        json(res, 200, { object: 'list', data: [{ id: SERVICE_MODEL, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'agentfetch' }] }); return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/tools') {
        // Expose both the portable high-level tool and confirmed provider tools.
        // Candidate observations never become model-visible until explicitly confirmed.
        const tools = [TOOL, ...capabilitiesToOpenAITools(registryRefs(registry))];
        const listing = createToolListResponse(tools, [...new Set(registry.query({ status: 'active', user_confirmed: true }).map(record => record.domain))]);
        json(res, 200, { ...listing, tools }); return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/registry/capabilities') {
        const records = registry.query(queryFromUrl(url));
        json(res, 200, { object: 'list', data: records, capabilities: records }); return;
      }
      if (req.method === 'POST' && (url.pathname === '/v1/registry/capabilities' || url.pathname === '/v1/capabilities')) {
        const body = await readJson(req, config.maxBodyBytes);
        const candidate = (body.capability && typeof body.capability === 'object' && body.method === undefined) ? body.capability : body;
        const record = registry.saveCandidate(candidate as CapabilityCandidateInput);
        json(res, 201, record); return;
      }
      const providerManifestPath = url.pathname.match(/^\/v1\/providers\/([^/]+)\/manifest$/);
      if ((req.method === 'POST' || req.method === 'PUT') && (url.pathname === '/v1/registry/publish' || url.pathname === '/v1/registry/providers' || url.pathname === '/v1/capabilities/publish' || url.pathname === '/v1/providers/manifest' || Boolean(providerManifestPath))) {
        const body = await readJson(req, config.maxBodyBytes);
        const publication = parseCapabilityPublishRequest(body);
        if (providerManifestPath && decodeURIComponent(providerManifestPath[1]!) !== publication.provider.id) throw new Error('publication_provider_id_mismatch');
        const refs = listCapabilities(publication.manifest, publication.manifest.servers?.[0]?.url ?? `https://${publication.provider.id}`);
        const source = `provider:${publication.provider.id}`;
        if (publication.mode === 'replace') for (const old of registry.query({ source })) if (!refs.some(ref => ref.capability.id === old.capability_id)) registry.remove(old.id);
        // Public provider publication is intentionally open in this MVP. Every
        // manifest operation is immediately queryable and tool-visible; provider
        // authentication and moderation can be added without changing the wire format.
        for (const ref of refs) {
          registry.saveCapability(ref, source, {
            status: ref.capability.read_only && ref.capability.side_effects === 'none' ? 'active' : 'candidate',
            user_confirmed: ref.capability.read_only && ref.capability.side_effects === 'none',
            manifest_url: publication.provider.homepage,
            metadata: { provider: publication.provider, protocol_version: publication.protocol_version },
          });
        }
        const response = createCapabilityPublishResponse(publication, refs);
        json(res, 201, response); return;
      }
      const pathTool = url.pathname.match(/^\/v1\/tools\/([^/]+)\/call$/);
      if (req.method === 'POST' && (url.pathname === '/v1/tools/call' || url.pathname === '/v1/tools/agent_fetch' || url.pathname === '/v1/agent-fetch' || Boolean(pathTool))) {
        const body = await readJson(req, config.maxBodyBytes);
        const input = body.arguments && typeof body.arguments === 'object' ? body.arguments : (body.input && typeof body.input === 'object' ? body.input : body);
        const name = pathTool ? decodeURIComponent(pathTool[1]!) : (body.name ?? body.tool ?? 'agent_fetch');
        if (name === 'agent_fetch' || name === 'agent-fetch') {
          const result = await execute(input, req);
          json(res, 200, { tool_call_id: `call_${crypto.randomUUID()}`, name: 'agent_fetch', result, content: [{ type: 'text', text: JSON.stringify(result) }] }); return;
        }
        const args = parseToolArguments({ name: String(name), arguments: input });
        const result = await executeDeclaredTool(String(name), args, registry, allowDomains, config.allowLoopback);
        json(res, 200, { tool_call_id: `call_${crypto.randomUUID()}`, name, result, content: [{ type: 'text', text: JSON.stringify(result) }] }); return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJson(req, config.maxBodyBytes);
        const result = await execute(body, req);
        json(res, 200, completion(result, typeof body.model === 'string' ? body.model : SERVICE_MODEL)); return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/query') {
        const body = await readJson(req, config.maxBodyBytes);
        json(res, 200, await execute(body, req)); return;
      }
      json(res, 404, errorBody('not_found', 'Route not found'));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request_failed';
      const status = /required|invalid_json|json_object|too_large|unknown_tool|publication|invalid tool call/.test(message) ? 400 : 500;
      json(res, status, errorBody(status === 400 ? 'invalid_request' : 'internal_error', message));
    }
  });
}

/** Start a service and resolve once its listening socket is ready. */
export async function startAgentFetchServer(options: AgentFetchServiceOptions = {}): Promise<AgentFetchServiceHandle> {
  const config = configuredOptions(options);
  const server = createAgentFetchServer(options);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  return { server, host: config.host, port, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

// `npm run service` entrypoint. Imports from tests do not start a listener.
if (process.argv[1]?.endsWith('/service/server.ts') || process.argv[1]?.endsWith('/service/server.js') || process.argv[1]?.endsWith('/agent-fetch-service')) {
  startAgentFetchServer().then(handle => console.log(`AgentFetch service listening on http://${handle.host}:${handle.port}`)).catch(error => { console.error(error); process.exitCode = 1; });
}


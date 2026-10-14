import type { CapabilityRef, OpenApiManifest, OpenApiOperation, OpenApiParameter } from '../spec/index.js';
import { parseManifest } from '../spec/index.js';

/** JSON Schema accepted by OpenAI-compatible function tools. */
export type JsonSchema = Record<string, unknown>;

/** OpenAI Chat Completions function tool shape. */
export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: JsonSchema;
    strict?: boolean;
  };
}

/** A protocol-neutral provider identity used by the public registry API. */
export interface AgentFetchProvider {
  id: string;
  name: string;
  version: string;
  homepage?: string;
  contact?: string;
}

/**
 * Public provider publication payload. The manifest remains OpenAPI 3.1; the
 * protocol only adds a small envelope so providers can publish atomically.
 */
export interface CapabilityPublishRequest {
  protocol_version: 'agentfetch.v1';
  provider: AgentFetchProvider;
  manifest: OpenApiManifest;
  /** Upsert is the default. Replace removes older capabilities for this provider. */
  mode?: 'upsert' | 'replace';
}

export interface CapabilityPublishResponse {
  object: 'capability.publication';
  protocol_version: 'agentfetch.v1';
  provider: AgentFetchProvider;
  manifest_version: string;
  accepted_at: string;
  capability_ids: string[];
  tools: OpenAIToolDefinition[];
}

/** OpenAI-compatible tool listing response returned by AgentFetch. */
export interface OpenAIToolListResponse {
  object: 'list';
  protocol_version: 'agentfetch.v1';
  data: OpenAIToolDefinition[];
  provider_ids?: string[];
}

/** OpenAI function-call request. `arguments` may be JSON or an encoded JSON string. */
export interface ToolExecutionRequest {
  name: string;
  arguments: string | Record<string, unknown>;
}

export interface ToolExecutionResponse {
  object: 'tool.result';
  tool_name: string;
  capability_id: string;
  output: unknown;
  source: string;
  retrieved_at: string;
  freshness: 'live' | 'cached';
  method: 'direct-http' | 'browser-fallback';
  fallback_used: boolean;
  [key: string]: unknown;
}

export interface ProtocolErrorResponse {
  error: { type: string; code: string; message: string; param?: string };
}

const TOOL_NAME_MAX = 64;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Convert an AgentFetch capability id to the OpenAI function name convention.
 * The conversion is deterministic and keeps names within OpenAI's 64-char limit.
 */
export function toolNameForCapability(capabilityId: string): string {
  const normalized = capabilityId.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  const base = `agentfetch_${normalized || 'capability'}`;
  if (base.length <= TOOL_NAME_MAX) return base;
  // Preserve both the prefix and a stable suffix when truncating long ids.
  return `${base.slice(0, TOOL_NAME_MAX - 9)}_${stableShortHash(capabilityId)}`;
}

function stableShortHash(value: string): string {
  // FNV-1a is enough for a display name; the endpoint id remains authoritative.
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function schemaForParameter(parameter: OpenApiParameter): JsonSchema {
  return {
    ...(parameter.schema ?? { type: 'string' }),
    ...(parameter.description ? { description: parameter.description } : {}),
  };
}

/** Build the function arguments JSON Schema from path/query parameters. */
export function parametersSchema(operation: OpenApiOperation): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const parameter of operation.parameters ?? []) {
    // Credentials and transport headers are handled by AgentFetch policy/auth;
    // exposing them as model arguments would leak secrets and break portability.
    if (parameter.in === 'header' || parameter.in === 'cookie') continue;
    properties[parameter.name] = schemaForParameter(parameter);
    if (parameter.required) required.push(parameter.name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function toolDescription(ref: CapabilityRef): string {
  const examples = ref.capability.intent_examples.length ? ` Examples: ${ref.capability.intent_examples.join('；')}` : '';
  const method = ref.method.toUpperCase();
  return `${ref.capability.id} (${method} ${ref.path}).${examples}`.slice(0, 4096);
}

/** Convert a declared capability into an OpenAI function tool definition. */
export function capabilityToOpenAITool(ref: CapabilityRef): OpenAIToolDefinition {
  const parameters = parametersSchema(ref.operation);
  const properties = parameters.properties && typeof parameters.properties === 'object'
    ? Object.keys(parameters.properties as Record<string, unknown>)
    : [];
  const required = Array.isArray(parameters.required) ? parameters.required.length : 0;
  const tool: OpenAIToolDefinition = {
    type: 'function',
    function: {
      name: toolNameForCapability(ref.capability.id),
      description: toolDescription(ref),
      parameters,
      // OpenAI strict mode requires every property to be required. Keep it on
      // for fully required operations and omit it for operations with optional
      // arguments so providers remain valid under both strict and loose APIs.
      ...(required === properties.length ? { strict: true } : {}),
    },
  };
  if (!TOOL_NAME_RE.test(tool.function.name)) throw new Error(`invalid OpenAI tool name for capability ${ref.capability.id}`);
  return tool;
}

/** Convert all manifest operations to tools in stable path/method order. */
export function capabilitiesToOpenAITools(refs: CapabilityRef[]): OpenAIToolDefinition[] {
  const sorted = [...refs].sort((a, b) => `${a.capability.id}:${a.method}:${a.path}`.localeCompare(`${b.capability.id}:${b.method}:${b.path}`));
  const seen = new Set<string>();
  return sorted.map((ref) => {
    const tool = capabilityToOpenAITool(ref);
    if (seen.has(tool.function.name)) throw new Error(`duplicate OpenAI tool name: ${tool.function.name}`);
    seen.add(tool.function.name);
    return tool;
  });
}

/** Parse and validate an OpenAI-compatible provider publication body. */
export function parseCapabilityPublishRequest(value: unknown): CapabilityPublishRequest {
  if (!value || typeof value !== 'object') throw new Error('invalid publication: expected JSON object');
  const body = value as Record<string, unknown>;
  if (body.protocol_version !== 'agentfetch.v1') throw new Error('invalid publication: protocol_version must be agentfetch.v1');
  const provider = body.provider;
  if (!provider || typeof provider !== 'object') throw new Error('invalid publication: provider is required');
  const p = provider as Record<string, unknown>;
  for (const field of ['id', 'name', 'version']) if (typeof p[field] !== 'string' || !p[field].trim()) throw new Error(`invalid publication: provider.${field} is required`);
  for (const field of ['homepage', 'contact']) if (p[field] !== undefined && typeof p[field] !== 'string') throw new Error(`invalid publication: provider.${field} must be a string`);
  if (body.mode !== undefined && body.mode !== 'upsert' && body.mode !== 'replace') throw new Error('invalid publication: mode must be upsert or replace');
  try { parseManifest(body.manifest); } catch (error) { throw new Error(`invalid publication manifest: ${error instanceof Error ? error.message : String(error)}`); }
  return {
    protocol_version: 'agentfetch.v1',
    provider: {
      id: p.id as string,
      name: p.name as string,
      version: p.version as string,
      ...(typeof p.homepage === 'string' ? { homepage: p.homepage } : {}),
      ...(typeof p.contact === 'string' ? { contact: p.contact } : {}),
    },
    manifest: body.manifest as OpenApiManifest,
    ...(body.mode ? { mode: body.mode as 'upsert' | 'replace' } : {}),
  };
}

/** Build the public publication response used by a provider registry. */
export function createCapabilityPublishResponse(request: CapabilityPublishRequest, refs: CapabilityRef[], acceptedAt = new Date().toISOString()): CapabilityPublishResponse {
  return {
    object: 'capability.publication',
    protocol_version: 'agentfetch.v1',
    provider: request.provider,
    manifest_version: request.manifest.info.version,
    accepted_at: acceptedAt,
    capability_ids: refs.map(ref => ref.capability.id),
    tools: capabilitiesToOpenAITools(refs),
  };
}

export function createToolListResponse(tools: OpenAIToolDefinition[], providerIds?: string[]): OpenAIToolListResponse {
  return {
    object: 'list',
    protocol_version: 'agentfetch.v1',
    data: tools,
    ...(providerIds?.length ? { provider_ids: [...providerIds] } : {}),
  };
}

/** Decode a function-call argument payload without allowing arbitrary JSON values to escape. */
export function parseToolArguments(input: ToolExecutionRequest): Record<string, unknown> {
  if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('invalid tool call: name is required');
  const value = typeof input.arguments === 'string' ? (() => { try { return JSON.parse(input.arguments); } catch { throw new Error('invalid tool call: arguments must be valid JSON'); } })() : input.arguments;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid tool call: arguments must be a JSON object');
  return value as Record<string, unknown>;
}

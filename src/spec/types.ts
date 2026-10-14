export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';
export type SideEffects = 'none' | 'read' | 'write' | 'destructive';

export interface AgentOutputMapping { [key: string]: string }
export interface AgentCapability {
  id: string;
  intent_examples: string[];
  read_only: boolean;
  freshness: { max_age_seconds: number };
  output: AgentOutputMapping;
  side_effects: SideEffects;
  consent: 'none' | 'user' | 'always';
  auth?: { type: 'none' | 'bearer' | 'oauth2' | 'cookie' | 'browser-session'; scopes?: string[] };
  rate_limit?: { requests_per_minute?: number; burst?: number };
  source?: { name?: string; url?: string; version?: string };
  version?: string;
}

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  schema: Record<string, unknown>;
  description?: string;
}
export interface OpenApiOperation {
  operationId?: string;
  parameters?: OpenApiParameter[];
  responses: Record<string, { description?: string; content?: Record<string, { schema?: Record<string, unknown> }> }>;
  security?: Array<Record<string, string[]>>;
  'x-agent-capability': AgentCapability;
}
export interface OpenApiManifest {
  openapi: '3.1.0' | string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
  components?: { securitySchemes?: Record<string, Record<string, unknown>> };
  'x-agent-provider'?: { id: string; source?: string; version?: string };
}

export interface CapabilityRef {
  manifest: OpenApiManifest;
  path: string;
  method: HttpMethod;
  operation: OpenApiOperation;
  capability: AgentCapability;
  baseUrl: string;
}

export interface AgentResult {
  answer: Record<string, unknown>;
  source: string;
  retrieved_at: string;
  freshness: 'live' | 'cached';
  method: 'direct-http' | 'browser-fallback';
  fallback_used: boolean;
  capability_id?: string;
  cache_hit?: boolean;
  reason?: string;
}

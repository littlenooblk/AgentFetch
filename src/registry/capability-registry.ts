import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AgentCapability, CapabilityRef, HttpMethod, OpenApiOperation } from '../spec/index.js';

/** Lifecycle state for an interface learned from a manifest or browser traffic. */
export type CapabilityRegistryStatus = 'candidate' | 'active' | 'disabled' | 'expired' | 'rejected' | (string & {});

/** Where the interface description came from. Custom source names are allowed for providers. */
export type CapabilityRegistrySource = string;

export interface CapabilityRegistryRecord {
  /** Stable registry id. It is the capability id when one is declared, otherwise a hash of method + URL. */
  id: string;
  capability_id?: string;
  method: string;
  url: string;
  path?: string;
  domain: string;
  source: CapabilityRegistrySource;
  manifest_url?: string;
  version?: string;
  status: CapabilityRegistryStatus;
  user_confirmed: boolean;
  first_seen: string;
  last_seen: string;
  capability?: AgentCapability;
  operation?: OpenApiOperation;
  metadata?: Record<string, unknown>;
}

export interface CapabilityCandidateInput {
  id?: string;
  capability_id?: string;
  method: string;
  url: string;
  path?: string;
  domain?: string;
  source?: CapabilityRegistrySource;
  manifest_url?: string;
  version?: string;
  status?: CapabilityRegistryStatus;
  user_confirmed?: boolean;
  capability?: AgentCapability;
  operation?: OpenApiOperation;
  metadata?: Record<string, unknown>;
}

export interface CapabilityRegistryQuery {
  id?: string;
  capability_id?: string;
  domain?: string;
  method?: string;
  source?: CapabilityRegistrySource;
  version?: string;
  status?: CapabilityRegistryStatus | CapabilityRegistryStatus[];
  user_confirmed?: boolean;
  /** Case-insensitive search over id, URL, path, source, and declared intent examples. */
  text?: string;
}

export interface CapabilityRegistryOptions {
  filePath?: string;
}

interface RegistryDocument {
  schema_version: 1;
  updated_at: string;
  records: CapabilityRegistryRecord[];
}

export class CapabilityRegistryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CapabilityRegistryError';
  }
}

function defaultRegistryPath(): string {
  return process.env.AGENT_FETCH_CAPABILITY_REGISTRY ?? path.join(os.homedir(), '.agent-fetch', 'capabilities.json');
}

function now(): string { return new Date().toISOString(); }

function normaliseMethod(method: string): string { return method.toUpperCase(); }

/** Remove credentials and common secret query parameters before writing an endpoint to disk. */
function safeUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    const secret = /^(?:authorization|auth|api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|secret|password|passwd|cookie|session)$/i;
    for (const key of [...parsed.searchParams.keys()]) if (secret.test(key)) parsed.searchParams.delete(key);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    // Keep malformed observations queryable, but never let a candidate make the JSON file unreadable.
    return raw.replace(/([?&](?:token|key|secret|password|authorization)=[^&]*)/gi, '$1[redacted]');
  }
}

function endpointKey(method: string, url: string): string {
  return `${normaliseMethod(method)} ${safeUrl(url)}`;
}

function generatedId(method: string, url: string): string {
  const digest = crypto.createHash('sha256').update(endpointKey(method, url)).digest('hex').slice(0, 16);
  return `observed.${digest}`;
}

function sourceString(source: unknown): string {
  if (typeof source === 'string' && source.trim()) return source.trim();
  return 'unknown';
}

function clone<T>(value: T): T {
  // Registry entries are JSON data. A round-trip also prevents callers from mutating in-memory state.
  return JSON.parse(JSON.stringify(value)) as T;
}

const sensitiveMetadataKey = /^(?:authorization|cookie|set-cookie|token|access[-_]?token|refresh[-_]?token|api[-_]?key|secret|password|passwd|credential|credentials)$/i;
function safeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const walk = (item: unknown, key = ''): unknown => {
    if (sensitiveMetadataKey.test(key)) return '[redacted]';
    if (Array.isArray(item)) return item.map(entry => walk(entry, key));
    if (item && typeof item === 'object') {
      const output: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(item)) output[childKey] = walk(childValue, childKey);
      return output;
    }
    return item;
  };
  return walk(value) as Record<string, unknown>;
}

/**
 * Small JSON-backed capability registry. Writes are atomic and entries are upserted by declared id or
 * by method + endpoint. It deliberately stores no authorization headers, cookies, or credentials.
 */
export class CapabilityRegistry {
  readonly filePath: string;
  private document: RegistryDocument;

  constructor(filePathOrOptions: string | CapabilityRegistryOptions = {}) {
    const filePath = typeof filePathOrOptions === 'string' ? filePathOrOptions : (filePathOrOptions.filePath ?? defaultRegistryPath());
    this.filePath = path.resolve(filePath);
    this.document = this.read();
  }

  private read(): RegistryDocument {
    if (!fs.existsSync(this.filePath)) return { schema_version: 1, updated_at: now(), records: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<RegistryDocument>;
      if (raw.schema_version !== 1 || !Array.isArray(raw.records)) throw new Error('unsupported registry schema');
      return { schema_version: 1, updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : now(), records: raw.records.map(item => clone(item)) };
    } catch (error) {
      throw new CapabilityRegistryError(`invalid capability registry: ${this.filePath}`, { cause: error });
    }
  }

  private persist(): void {
    this.document.updated_at = now();
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(this.document, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
      try { fs.chmodSync(this.filePath, 0o600); } catch { /* best effort on platforms without chmod */ }
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* ignore cleanup errors */ }
      throw new CapabilityRegistryError(`failed to persist capability registry: ${this.filePath}`, { cause: error });
    }
  }

  private matchExisting(input: CapabilityCandidateInput): CapabilityRegistryRecord | undefined {
    const requestedId = input.id ?? input.capability_id ?? input.capability?.id;
    if (requestedId) {
      const byId = this.document.records.find(record => record.id === requestedId || record.capability_id === requestedId);
      if (byId) return byId;
    }
    const key = endpointKey(input.method, input.url);
    return this.document.records.find(record => endpointKey(record.method, record.url) === key);
  }

  /** Insert or update an observed/declared endpoint and return a copy of the stored record. */
  saveCandidate(input: CapabilityCandidateInput): CapabilityRegistryRecord {
    if (!input || typeof input.url !== 'string' || !input.url.trim()) throw new CapabilityRegistryError('candidate url is required');
    if (!input.method || typeof input.method !== 'string') throw new CapabilityRegistryError('candidate method is required');
    const timestamp = now();
    const existing = this.matchExisting(input);
    const endpoint = safeUrl(input.url);
    const parsed = (() => { try { return new URL(endpoint); } catch { return undefined; } })();
    const capabilityId = input.capability_id ?? input.capability?.id;
    const id = input.id ?? existing?.id ?? capabilityId ?? generatedId(input.method, endpoint);
    const record: CapabilityRegistryRecord = {
      id,
      ...(capabilityId ? { capability_id: capabilityId } : existing?.capability_id ? { capability_id: existing.capability_id } : {}),
      method: normaliseMethod(input.method),
      url: endpoint,
      ...(input.path ?? existing?.path ? { path: input.path ?? existing?.path } : {}),
      domain: (input.domain ?? existing?.domain ?? parsed?.hostname ?? '').toLowerCase(),
      source: sourceString(input.source ?? existing?.source ?? 'unknown'),
      ...(input.manifest_url ?? existing?.manifest_url ? { manifest_url: safeUrl(input.manifest_url ?? existing?.manifest_url!) } : {}),
      ...(input.version ?? existing?.version ? { version: input.version ?? existing?.version } : {}),
      status: input.status ?? existing?.status ?? 'candidate',
      user_confirmed: input.user_confirmed ?? existing?.user_confirmed ?? false,
      first_seen: existing?.first_seen ?? timestamp,
      last_seen: timestamp,
      ...(input.capability ?? existing?.capability ? { capability: input.capability ?? existing?.capability } : {}),
      ...(input.operation ?? existing?.operation ? { operation: input.operation ?? existing?.operation } : {}),
      ...(input.metadata ?? existing?.metadata ? { metadata: safeMetadata({ ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) }) } : {}),
    };
    if (existing) {
      const index = this.document.records.indexOf(existing);
      this.document.records[index] = clone(record);
    } else this.document.records.push(clone(record));
    this.persist();
    return clone(record);
  }

  /** Alias for callers that call registry insertion register/save/upsert. */
  register(input: CapabilityCandidateInput): CapabilityRegistryRecord { return this.saveCandidate(input); }
  save(input: CapabilityCandidateInput): CapabilityRegistryRecord { return this.saveCandidate(input); }
  upsert(input: CapabilityCandidateInput): CapabilityRegistryRecord { return this.saveCandidate(input); }

  /** Save a manifest operation in the same format used by the planner. */
  saveCapability(ref: CapabilityRef, source: CapabilityRegistrySource = 'manifest', options: Pick<CapabilityCandidateInput, 'status' | 'user_confirmed' | 'metadata' | 'manifest_url'> = {}): CapabilityRegistryRecord {
    // Keep OpenAPI path templates such as `{id}` readable; URL() percent-encodes them.
    const endpoint = `${ref.baseUrl.replace(/\/$/, '')}${ref.path.startsWith('/') ? '' : '/'}${ref.path}`;
    return this.saveCandidate({
      id: ref.capability.id,
      capability_id: ref.capability.id,
      method: ref.method,
      url: endpoint,
      path: ref.path,
      source,
      version: ref.capability.version ?? ref.capability.source?.version ?? ref.manifest.info.version,
      capability: ref.capability,
      operation: ref.operation,
      ...options,
    });
  }

  get(id: string): CapabilityRegistryRecord | undefined {
    const record = this.document.records.find(item => item.id === id || item.capability_id === id);
    return record ? clone(record) : undefined;
  }

  query(query: CapabilityRegistryQuery = {}): CapabilityRegistryRecord[] {
    const text = query.text?.toLowerCase();
    const statuses = query.status ? new Set(Array.isArray(query.status) ? query.status : [query.status]) : undefined;
    return this.document.records.filter(record => {
      if (query.id && record.id !== query.id) return false;
      if (query.capability_id && record.capability_id !== query.capability_id) return false;
      if (query.domain && record.domain !== query.domain.toLowerCase()) return false;
      if (query.method && record.method !== normaliseMethod(query.method)) return false;
      if (query.source && record.source !== query.source) return false;
      if (query.version && record.version !== query.version) return false;
      if (statuses && !statuses.has(record.status)) return false;
      if (query.user_confirmed !== undefined && record.user_confirmed !== query.user_confirmed) return false;
      if (text) {
        const haystack = [record.id, record.capability_id, record.url, record.path, record.domain, record.source, record.version, ...(record.capability?.intent_examples ?? [])].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    }).map(clone);
  }

  /** Alias used by callers that prefer the terms find/search/all. */
  find(query: CapabilityRegistryQuery = {}): CapabilityRegistryRecord[] { return this.query(query); }
  search(query: CapabilityRegistryQuery = {}): CapabilityRegistryRecord[] { return this.query(query); }
  list(): CapabilityRegistryRecord[] { return this.query(); }
  all(): CapabilityRegistryRecord[] { return this.query(); }

  setStatus(id: string, status: CapabilityRegistryStatus): CapabilityRegistryRecord { return this.updateStatus(id, status); }

  updateStatus(id: string, status: CapabilityRegistryStatus): CapabilityRegistryRecord {
    const record = this.require(id);
    record.status = status;
    record.last_seen = now();
    this.persist();
    return clone(record);
  }

  approve(id: string, userConfirmed = true): CapabilityRegistryRecord { return this.confirm(id, userConfirmed); }

  confirm(id: string, userConfirmed = true): CapabilityRegistryRecord {
    const record = this.require(id);
    record.user_confirmed = userConfirmed;
    if (userConfirmed && record.status === 'candidate') record.status = 'active';
    record.last_seen = now();
    this.persist();
    return clone(record);
  }

  remove(id: string): boolean {
    const index = this.document.records.findIndex(item => item.id === id || item.capability_id === id);
    if (index < 0) return false;
    this.document.records.splice(index, 1);
    this.persist();
    return true;
  }

  clear(): void { this.document.records = []; this.persist(); }

  private require(id: string): CapabilityRegistryRecord {
    const record = this.document.records.find(item => item.id === id || item.capability_id === id);
    if (!record) throw new CapabilityRegistryError(`capability not found: ${id}`);
    return record;
  }
}

export function defaultCapabilityRegistryPath(): string { return defaultRegistryPath(); }

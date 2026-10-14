import { parseManifest, type OpenApiManifest } from '../spec/index.js';
import { assertSafeUrl, PolicyError, type PolicyOptions } from '../policy/security.js';
import yaml from 'js-yaml';
import type { CapabilityRegistry } from '../registry/index.js';

interface CacheEntry { value: OpenApiManifest; expiresAt: number; }
export interface DiscoveryOptions extends PolicyOptions { fetchImpl?: typeof fetch; ttlMs?: number; registry?: Record<string,string>; capabilityRegistry?: CapabilityRegistry; }
export class DiscoveryError extends Error { constructor(message:string){super(message);this.name='DiscoveryError';} }
export class ManifestCache { private entries=new Map<string,CacheEntry>(); get(url:string){const e=this.entries.get(url); if(e && e.expiresAt>Date.now()) return e.value; if(e) this.entries.delete(url); return undefined;} set(url:string,value:OpenApiManifest,ttl:number){this.entries.set(url,{value,expiresAt:Date.now()+ttl});} clear(){this.entries.clear();} }
export class CapabilityDiscovery {
  constructor(private opts: DiscoveryOptions, private cache = new ManifestCache()) {}
  async discover(baseUrl: string, explicitManifest?: string): Promise<{manifest:OpenApiManifest; source:string}> {
    const fetchImpl=this.opts.fetchImpl??fetch; const base=new URL(baseUrl); const domain=base.hostname;
    const candidates:string[]=[];
    if (explicitManifest) candidates.push(new URL(explicitManifest,base).toString());
    if (this.opts.registry?.[domain]) candidates.push(new URL(this.opts.registry[domain]!,base).toString());
    candidates.push(new URL('/.well-known/agent-fetch/openapi.json',base).toString(), new URL('/manifest.json',base).toString());
    let policyBlocked=false;
    for (const candidate of candidates) {
      try {
        await assertSafeUrl(candidate,this.opts);
        const cached=this.cache.get(candidate); if(cached) return {manifest:cached,source:candidate};
        const response=await fetchImpl(candidate,{redirect:'manual'}); if(!response.ok) continue;
        const text=await response.text(); let value:unknown;
        try { value=JSON.parse(text); } catch { value=yaml.load(text); }
        const manifest=parseManifest(value); this.cache.set(candidate,manifest,this.opts.ttlMs??300_000);
        // Persist declared operations so later planner runs can query the local registry.
        if (this.opts.capabilityRegistry) {
          for (const ref of listCapabilities(manifest, baseUrl)) {
            this.opts.capabilityRegistry.saveCapability(ref, 'manifest', { manifest_url: candidate, status: ref.capability.read_only ? 'active' : 'candidate', user_confirmed: ref.capability.read_only });
          }
        }
        return {manifest,source:candidate};
      } catch (error) { if(error instanceof PolicyError) policyBlocked=true; /* invalid or unavailable candidate: continue to next discovery method */ }
    }
    throw new DiscoveryError(`${policyBlocked?'policy_blocked: ':''}No valid manifest found for ${baseUrl}`);
  }
}
export function listCapabilities(manifest: OpenApiManifest, baseUrl: string) {
  return Object.entries(manifest.paths).flatMap(([path,item])=>Object.entries(item).filter(([method])=>['get','post','put','patch','delete','head'].includes(method)).map(([method,operation])=>({manifest,path,method:method as any,operation:operation!,capability:operation!['x-agent-capability'],baseUrl})));
}

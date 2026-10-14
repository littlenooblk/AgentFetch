import type { AgentResult, AgentCapability } from '../spec/index.js';
import { jsonPath } from '../executor/http.js';
export function normalize(data:unknown, capability:AgentCapability, source:string, method:'direct-http'|'browser-fallback', fallback_used=false, freshness:'live'|'cached'='live', extra:Partial<AgentResult>={}):AgentResult {
  const answer:Record<string,unknown>={}; for(const [name,path] of Object.entries(capability.output)) answer[name]=jsonPath(data,path);
  return {answer,source,retrieved_at:new Date().toISOString(),freshness,method,fallback_used,capability_id:capability.id,...extra};
}

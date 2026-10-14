import * as AjvModule from 'ajv';
const Ajv = (AjvModule as any).default ?? AjvModule;
import { assertSafeUrl, assertWriteAllowed, PolicyError, type PolicyOptions } from '../policy/security.js';
import { RateLimiter } from '../policy/rate-limit.js';
import type { CapabilityRef } from '../spec/index.js';
import { ResponseCache } from './cache.js';

export interface ExecutorOptions extends PolicyOptions { fetchImpl?: typeof fetch; timeoutMs?:number; retries?:number; cache?:ResponseCache; rateLimiter?:RateLimiter; audit?: (event:Record<string,unknown>)=>void; }
export class HttpExecutionError extends Error { constructor(public reason:string,message?:string){super(message??reason);this.name='HttpExecutionError';} }
function jsonPath(root:unknown, path:string): unknown { const parts=path.replace(/^\$\.?/,'').split('.').filter(Boolean); let cur:any=root; for(const p of parts){if(cur==null)return undefined; const m=p.match(/^(\w+)\[(\d+)\]$/); cur=m?cur[m[1] as string]?.[Number(m[2])]:cur[p];} return cur; }
function interpolate(path:string,params:Record<string,unknown>):string { return path.replace(/\{([^}]+)\}/g,(_,k)=>encodeURIComponent(String(params[k]??''))); }
function key(method:string,url:string,params:Record<string,unknown>){return `${method}:${url}?${new URLSearchParams(Object.entries(params).filter(([k])=>!k.includes('password')&&typeof k[1]!=='object') as [string,string][]).toString()}`;}
function auditUrl(raw:string): string { try { const u=new URL(raw); for(const key of [...u.searchParams.keys()]) if(/token|password|secret|key|cookie|auth/i.test(key)) u.searchParams.set(key,'[REDACTED]'); return u.toString(); } catch { return '[INVALID_URL]'; } }
export class HttpExecutor {
  constructor(private opts:ExecutorOptions){ }
  async execute(ref:CapabilityRef, params:Record<string,unknown>, confirmedWrite=false):Promise<{data:unknown;url:string;cacheHit:boolean;status:number}> {
    const method=ref.method.toUpperCase(); assertWriteAllowed(method,ref.capability,confirmedWrite);
    for (const parameter of ref.operation.parameters ?? []) { if (parameter.required && parameter.in !== 'header' && params[parameter.name] === undefined) throw new HttpExecutionError('parameter_missing', `missing parameter: ${parameter.name}`); }
    const base=ref.baseUrl.endsWith('/')?ref.baseUrl.slice(0,-1):ref.baseUrl; let path=interpolate(ref.path,params); const query=new URLSearchParams();
    for(const p of ref.operation.parameters??[]) if(p.in==='query' && params[p.name]!==undefined) query.set(p.name,String(params[p.name]));
    const url=`${base}${path}${query.toString()?`?${query}`:''}`; await assertSafeUrl(url,this.opts);
    const cacheKey=key(method,url,params); const cached=this.opts.cache?.get<unknown>(cacheKey); if(cached!==undefined && method==='GET'){this.opts.audit?.({method,url:auditUrl(url),status:200,cache_hit:true}); return {data:cached,url,cacheHit:true,status:200};}
    await this.opts.rateLimiter?.wait(new URL(url).host,ref.capability.rate_limit?.requests_per_minute??60);
    const fetchImpl=this.opts.fetchImpl??fetch; const maxRetries=this.opts.retries??2; const timeout=this.opts.timeoutMs??10000; let lastError='request_failed'; const started=Date.now();
    for(let attempt=0;attempt<=maxRetries;attempt++) {
      const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),timeout);
      try {
        const res=await fetchImpl(url,{method,redirect:'manual',headers:{accept:'application/json'},signal:ctrl.signal});
        if(res.status>=300&&res.status<400){const location=res.headers.get('location'); if(!location) throw new HttpExecutionError('request_failed','redirect without location'); const target=new URL(location,url).toString(); await assertSafeUrl(target,this.opts); throw new HttpExecutionError('request_failed','redirect requires caller follow-up');}
        if(!res.ok){lastError=res.status===401||res.status===403?'authentication_required':`http_${res.status}`; if(res.status===429||res.status>=500){clearTimeout(timer); const retryAfter=Number(res.headers.get('retry-after')??'0'); await new Promise(r=>setTimeout(r,Math.min((retryAfter||2**attempt)*1000,5000))); continue;} throw new HttpExecutionError(lastError);}
        let data:unknown; try {data=await res.json();} catch {throw new HttpExecutionError('request_failed','response is not JSON');}
        const schema=(ref.operation.responses?.['200']??ref.operation.responses?.['2XX'])?.content?.['application/json']?.schema; if(schema){const ajv=new Ajv({strict:false}); if(!ajv.compile(schema)(data)) throw new HttpExecutionError('response_invalid','response schema validation failed');}
        clearTimeout(timer); this.opts.cache?.set(cacheKey,data,ref.capability.freshness.max_age_seconds); this.opts.audit?.({method,url:auditUrl(url),status:res.status,latency_ms:Date.now()-started,cache_hit:false}); return {data,url,cacheHit:false,status:res.status};
      } catch(e) { clearTimeout(timer); if(e instanceof PolicyError) throw new HttpExecutionError('policy_blocked',e.message); if(e instanceof HttpExecutionError) { if(['authentication_required','response_invalid','policy_blocked'].includes(e.reason)) throw e; lastError=e.reason; if(attempt===maxRetries) throw e; } else if(attempt===maxRetries) throw new HttpExecutionError('request_failed',e instanceof Error?e.message:String(e)); await new Promise(r=>setTimeout(r,Math.min(250*2**attempt,2000))); }
    }
    throw new HttpExecutionError(lastError);
  }
}
export { jsonPath };

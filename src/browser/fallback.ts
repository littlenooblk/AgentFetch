import type { AgentResult, CapabilityRef } from '../spec/index.js';
import { SessionManager, type BrowserSessionAdapter } from '../auth/session.js';
import { assertSafeUrl, type PolicyOptions } from '../policy/security.js';
import { sanitizeObservedRequests } from './observe.js';
import type { ObservedRequest } from '../auth/session.js';
export type FallbackReason='manifest_missing'|'manifest_expired'|'capability_not_found'|'authentication_required'|'request_failed'|'policy_blocked'|'browser_unavailable';
export interface BrowserFallbackOptions extends PolicyOptions { browser?: BrowserSessionAdapter; sessionManager?:SessionManager; interactive?:boolean; onObservedRequests?: (requests: ObservedRequest[]) => Promise<void>|void; }
export class BrowserFallback {
  constructor(private opts:BrowserFallbackOptions){}
  async run(baseUrl:string, reason:FallbackReason, ref?:CapabilityRef, params:Record<string,unknown>={}):Promise<AgentResult> {
    const source=ref?new URL(ref.path,baseUrl).toString():baseUrl;
    try { await assertSafeUrl(baseUrl,this.opts); } catch { return {answer:{},source:baseUrl,retrieved_at:new Date().toISOString(),freshness:'live',method:'browser-fallback',fallback_used:true,reason:'policy_blocked'}; }
    if(!this.opts.browser) return {answer:{},source,retrieved_at:new Date().toISOString(),freshness:'live',method:'browser-fallback',fallback_used:true,reason:'browser_unavailable'};
    const domain=new URL(baseUrl).hostname; let session; try { session=await (this.opts.sessionManager??new SessionManager()).get(domain); } catch { return {answer:{},source,retrieved_at:new Date().toISOString(),freshness:'live',method:'browser-fallback',fallback_used:true,reason:'authentication_required'}; } const context=await this.opts.browser.launch(session.profileDir);
    try {
      await context.goto(baseUrl);
      if(this.opts.interactive!==false) await context.waitForUser(`当前访问域名：${domain}。请在隔离浏览器中手动登录并完成 2FA/验证码，然后返回 CLI 继续。`);
      let response:Response;
      if(ref){ const path=ref.path.replace(/\{([^}]+)\}/g,(_,name)=>encodeURIComponent(String(params[name] ?? ''))); const url=new URL(path,baseUrl); for(const p of ref.operation.parameters??[]) if(p.in==='query'&&params[p.name]!==undefined) url.searchParams.set(p.name,String(params[p.name])); response=await context.request(url.toString(),{method:ref.method.toUpperCase(),headers:{accept:'application/json'}}); }
      else response=await context.request(baseUrl,{method:'GET',headers:{accept:'text/html'}});
      if(response.status===401||response.status===403) return {answer:{},source,retrieved_at:new Date().toISOString(),freshness:'live',method:'browser-fallback',fallback_used:true,reason:'authentication_required'};
      const data=await response.json().catch(()=>({}));
      return {answer:data as Record<string,unknown>,source:response.url||source,retrieved_at:new Date().toISOString(),freshness:'live',method:'browser-fallback',fallback_used:true,reason};
    } finally { const observed=sanitizeObservedRequests(context.getObservedRequests?.() ?? [], baseUrl); if (this.opts.onObservedRequests && observed.length) await this.opts.onObservedRequests(observed); await context.close(); }
  }
}
export async function createPlaywrightAdapter():Promise<BrowserSessionAdapter> {
  const mod=await import('playwright');
  return { launch: async(profileDir:string)=>{const context=await mod.chromium.launchPersistentContext(profileDir,{headless:false}); const page=context.pages()[0]??await context.newPage(); const observed: ObservedRequest[]=[]; page.on('request',(request:any)=>observed.push({url:request.url(),method:request.method(),resourceType:request.resourceType(),observedAt:new Date().toISOString()})); return {close:()=>context.close(),goto:(url:string)=>page.goto(url).then(()=>undefined),waitForUser:async(message:string)=>{console.error(message); await new Promise<void>(resolve=>{process.stdin.resume();process.stdin.once('data',()=>resolve());});},getObservedRequests:()=>observed.slice(),request:async (url:string,init?:RequestInit)=>{ const result=await (page as any).evaluate(async ({url,init}:{url:string;init?:RequestInit})=>{const r=await fetch(url,init as any); return {status:r.status,statusText:r.statusText,url:r.url,headers:Array.from(r.headers.entries()),body:Array.from(new Uint8Array(await r.arrayBuffer()))};},{url,init}); return new Response(new Uint8Array(result.body),{status:result.status,statusText:result.statusText,headers:result.headers}); }}; }};
}

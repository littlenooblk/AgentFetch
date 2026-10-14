import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { validateManifest } from '../src/spec/index.js';
import { priceManifest, inventoryManifest, weatherManifest } from '../src/mocks/manifests.js';
import { CapabilityDiscovery, listCapabilities } from '../src/discovery/index.js';
import { plan } from '../src/planner/planner.js';
import { HttpExecutor } from '../src/executor/http.js';
import { ResponseCache } from '../src/executor/cache.js';
import { normalize } from '../src/normalizer/normalizer.js';
import { assertSafeUrl, assertWriteAllowed, PolicyError, redactHeaders } from '../src/policy/security.js';
import { createMockServer } from '../src/mocks/server.js';
import http from 'node:http';

let server:http.Server; let base='';
beforeAll(async()=>{server=createMockServer(); await new Promise<void>(r=>server.listen(0,'127.0.0.1',r)); const a=server.address() as any; base=`http://127.0.0.1:${a.port}`;});
afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()));});

describe('OpenAPI agent extension',()=>{
  it('validates three provider manifests',()=>{expect(()=>validateManifest(priceManifest)).not.toThrow();expect(()=>validateManifest(inventoryManifest)).not.toThrow();expect(()=>validateManifest(weatherManifest)).not.toThrow();});
  it('rejects missing capability',()=>{expect(()=>validateManifest({...priceManifest,paths:{'/x':{get:{responses:{'200':{description:'x'}}} as any}}})).toThrow(/x-agent-capability/);});
});
describe('discovery, planning and direct execution',()=>{
  it('discovers manifest and maps price question',async()=>{const d=new CapabilityDiscovery({allowedDomains:['127.0.0.1'],allowLoopback:true,fetchImpl:fetch});const got=await d.discover(base);const refs=listCapabilities(got.manifest,base);const selected=plan('查询 iPhone 16 256GB 当前价格',refs);expect(selected.ref.capability.id).toBe('product.price.read');const out=await new HttpExecutor({allowedDomains:['127.0.0.1'],allowLoopback:true,cache:new ResponseCache()}).execute(selected.ref,selected.params);expect(out.data).toHaveProperty('price');const normalized=normalize(out.data,selected.ref.capability,out.url,'direct-http');expect(normalized.answer).toMatchObject({amount:5999,currency:'CNY'});expect(normalized.source).toContain('/api/products/');});
  it('maps inventory and weather',()=>{const refs=[{manifest:inventoryManifest,path:'/api/products/{id}/inventory',method:'get' as const,operation:inventoryManifest.paths['/api/products/{id}/inventory']!.get!,capability:inventoryManifest.paths['/api/products/{id}/inventory']!.get!['x-agent-capability'],baseUrl:base},{manifest:weatherManifest,path:'/api/weather/current',method:'get' as const,operation:weatherManifest.paths['/api/weather/current']!.get!,capability:weatherManifest.paths['/api/weather/current']!.get!['x-agent-capability'],baseUrl:base}];expect(plan('这个商品有货吗 sku out-of-stock',[refs[0]!]).params).toEqual({id:'out-of-stock'});expect(plan('查询北京天气',[refs[1]!]).params).toEqual({city:'北京'});});
  it('uses TTL cache',async()=>{const d=new CapabilityDiscovery({allowedDomains:['127.0.0.1'],allowLoopback:true});const refs=listCapabilities((await d.discover(base)).manifest,base);const ref=refs.find(r=>r.capability.id==='product.price.read')!;const cache=new ResponseCache();const exec=new HttpExecutor({allowedDomains:['127.0.0.1'],allowLoopback:true,cache});const a=await exec.execute(ref,{id:'iphone16'});const b=await exec.execute(ref,{id:'iphone16'});expect(a.cacheHit).toBe(false);expect(b.cacheHit).toBe(true);});
});
describe('security',()=>{
  it('blocks private addresses and unsafe schemes',async()=>{await expect(assertSafeUrl('file:///etc/passwd',{allowedDomains:['localhost']})).rejects.toThrow(PolicyError);await expect(assertSafeUrl('http://169.254.169.254/latest',{allowedDomains:['169.254.169.254']})).rejects.toThrow(/private/);});
  it('redacts credentials and requires write confirmation',()=>{expect(redactHeaders({Authorization:'Bearer secret',Cookie:'a=b',Accept:'json'})).toEqual({Authorization:'[REDACTED]',Cookie:'[REDACTED]',Accept:'json'});expect(()=>assertWriteAllowed('POST',{read_only:false,consent:'none',side_effects:'write'})).toThrow(/confirmation/);expect(()=>assertWriteAllowed('POST',{read_only:false,consent:'none',side_effects:'write'},true)).not.toThrow();});
  it('refuses malicious redirects',async()=>{const response=new Response(null,{status:302,headers:{location:'http://169.254.169.254/latest'}});const ref={manifest:priceManifest,path:'/redirect-malicious',method:'get' as const,operation:priceManifest.paths['/api/products/{id}/price']!.get!,capability:priceManifest.paths['/api/products/{id}/price']!.get!['x-agent-capability'],baseUrl:base};const exec=new HttpExecutor({allowedDomains:['127.0.0.1','169.254.169.254'],allowLoopback:true,fetchImpl:async()=>response,retries:0});await expect(exec.execute(ref,{id:'x'})).rejects.toThrow();});
});

describe('browser fallback and session isolation',()=>{
  it('pauses through a user-controlled browser adapter',async()=>{
    const calls:string[]=[]; const adapter={launch:async(profileDir:string)=>({close:async()=>{},goto:async(url:string)=>{calls.push(url);},waitForUser:async(message:string)=>{calls.push(message);},request:async(url:string)=>new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json'}})})};
    const { BrowserFallback }=await import('../src/browser/fallback.js'); const { SessionManager }=await import('../src/auth/session.js'); const session=new SessionManager(`/private/tmp/agent-fetch-test-profile-${Date.now()}`); const result=await new BrowserFallback({allowedDomains:['127.0.0.1'],allowLoopback:true,browser:adapter,sessionManager:session}).run(base,'authentication_required'); expect(result.method).toBe('browser-fallback'); expect(result.fallback_used).toBe(true); expect(calls.some(x=>x.includes('手动登录'))).toBe(true);
  });
  it('does not retry an expired session',async()=>{const { BrowserFallback }=await import('../src/browser/fallback.js'); const { SessionManager }=await import('../src/auth/session.js'); const session=new SessionManager(`/private/tmp/agent-fetch-expired-${Date.now()}`); const first=await session.get('127.0.0.1'); expect(first.profileDir).toContain('127.0.0.1'); session.expire('127.0.0.1'); const result=await new BrowserFallback({allowedDomains:['127.0.0.1'],allowLoopback:true,browser:{launch:async()=>{throw new Error('should not launch');}},sessionManager:session}).run(base,'authentication_required'); expect(result.reason).toBe('authentication_required');});
});

describe('model planning, browser observation and capability registry',()=>{
  it('uses a model only within the declared capability catalog',async()=>{
    const refs=listCapabilities(priceManifest,base);
    const { planWithModel }=await import('../src/llm/planner.js');
    const selected=await planWithModel('查询 iPhone16 价格',refs,{client:{completeJson:async <T>()=>({capability_id:'product.price.read',params:{id:'iphone16'},confidence:0.98} as T) as any}});
    expect(selected.ref.capability.id).toBe('product.price.read');
    await expect(planWithModel('查询价格',refs,{client:{completeJson:async <T>()=>({capability_id:'product.price.read',params:{url:'https://evil.test'}} as T) as any}})).rejects.toThrow(/parameter_not_declared/);
  });
  it('stores and confirms a learned capability without persisting query secrets',async()=>{
    const { mkdtempSync }=await import('node:fs'); const { tmpdir }=await import('node:os'); const { join }=await import('node:path');
    const { CapabilityRegistry }=await import('../src/registry/index.js'); const registry=new CapabilityRegistry(join(mkdtempSync(join(tmpdir(),'agent-fetch-reg-')),'capabilities.json'));
    const ref=listCapabilities(priceManifest,base)[0]!; const record=registry.saveCapability(ref,'manifest',{status:'candidate',user_confirmed:false,manifest_url:`${base}/manifest.json?token=secret`});
    expect(record.status).toBe('candidate'); expect(record.manifest_url).not.toContain('secret'); const active=registry.confirm(record.id); expect(active.status).toBe('active'); expect(active.user_confirmed).toBe(true);
  });
  it('filters cross-origin and sensitive observed browser requests',async()=>{
    const { sanitizeObservedRequests }=await import('../src/browser/observe.js'); const observed=sanitizeObservedRequests([{url:`${base}/api/price?id=1&token=secret`,method:'get',resourceType:'xhr'},{url:'https://evil.test/api',method:'GET',resourceType:'xhr'},{url:`${base}/logo.png`,method:'GET',resourceType:'image'}],base);
    expect(observed).toHaveLength(1); expect(observed[0]!.url).not.toContain('secret'); expect(observed[0]!.method).toBe('GET');
  });
  it('constrains model API discovery to observed request indexes',async()=>{
    const { analyzeObservedRequests }=await import('../src/llm/analyzer.js');
    const observed=[{url:`${base}/api/price?id=1`,method:'GET',resourceType:'xhr'},{url:`${base}/logo.png`,method:'GET',resourceType:'image'}];
    const analysis=await analyzeObservedRequests('查询商品价格',observed,{completeJson:async()=>({candidates:[{index:0,confidence:0.9},{index:99}]}) as any});
    expect(analysis.candidates).toEqual([{index:0,confidence:0.9}]);
  });
});

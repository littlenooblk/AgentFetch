#!/usr/bin/env node
import { Command } from 'commander';
import { CapabilityDiscovery, listCapabilities } from '../discovery/index.js';
import { plan } from '../planner/planner.js';
import { HttpExecutor } from '../executor/http.js';
import { normalize } from '../normalizer/normalizer.js';
import { BrowserFallback, createPlaywrightAdapter, type FallbackReason } from '../browser/fallback.js';
import { ResponseCache } from '../executor/cache.js';
import { redactHeaders } from '../policy/security.js';
import { createConfiguredLlmClient } from '../llm/openai-compatible.js';
import { planWithModel } from '../llm/planner.js';
import type { ModelJsonClient } from '../llm/types.js';
import type { CapabilityRef, OpenApiManifest, HttpMethod } from '../spec/index.js';
import { CapabilityRegistry, type CapabilityRegistryRecord } from '../registry/index.js';
import type { ObservedRequest } from '../auth/session.js';
import { analyzeObservedRequests } from '../llm/analyzer.js';

function registryRefs(baseUrl: string | undefined, records: CapabilityRegistryRecord[]): CapabilityRef[] {
  const refs: CapabilityRef[] = [];
  for (const record of records) {
    if (!record.capability || !record.operation || !record.path) continue;
    const method = record.method.toLowerCase() as HttpMethod;
    const origin = baseUrl ?? (() => { try { return new URL(record.url).origin; } catch { return `https://${record.domain}`; } })();
    const manifest: OpenApiManifest = { openapi: '3.1.0', info: { title: 'AgentFetch registry', version: record.version ?? 'stored' }, paths: { [record.path]: { [method]: record.operation } } };
    refs.push({ manifest, path: record.path, method, operation: record.operation, capability: record.capability, baseUrl: origin });
  }
  return refs;
}

/** Query only confirmed read-only capabilities across known domains. */
export async function runRegisteredQuestion(question: string, options: { registry?: CapabilityRegistry; allowDomain?: string[]; allowLoopback?: boolean; llm?: ModelJsonClient; deterministic?: boolean } = {}): Promise<unknown> {
  const registry = options.registry ?? new CapabilityRegistry();
  const records = registry.query({ status: 'active', user_confirmed: true }).filter(record => record.capability?.read_only && record.capability.side_effects === 'none');
  const refs = registryRefs(undefined, records);
  if (!refs.length) return { answer: {}, source: 'registry', retrieved_at: new Date().toISOString(), freshness: 'live', method: 'browser-fallback', fallback_used: true, reason: 'capability_not_found' };
  try {
    const model = options.deterministic ? undefined : (options.llm ?? createConfiguredLlmClient());
    const selected = model ? await planWithModel(question, refs, { client: model }).catch(() => plan(question, refs)) : plan(question, refs);
    const allowedDomains = [...new Set([...(options.allowDomain ?? []), ...records.map(record => record.domain)])];
    const result = await new HttpExecutor({ allowedDomains, allowLoopback: options.allowLoopback ?? false, cache: new ResponseCache() }).execute(selected.ref, selected.params);
    return normalize(result.data, selected.ref.capability, result.url, 'direct-http', false, result.cacheHit ? 'cached' : 'live', { cache_hit: result.cacheHit });
  } catch (error) {
    if (process.env.AGENT_FETCH_DEBUG) console.error(error);
    return { answer: {}, source: 'registry', retrieved_at: new Date().toISOString(), freshness: 'live', method: 'browser-fallback', fallback_used: true, reason: error instanceof Error && error.message.startsWith('parameter_missing') ? 'capability_not_found' : 'request_failed' };
  }
}

export async function runAgentFetch(baseUrl:string, question:string, options:{manifest?:string;allowDomain?:string[];allowLoopback?:boolean;noBrowser?:boolean;llm?:ModelJsonClient;deterministic?:boolean;registry?:CapabilityRegistry}={}):Promise<unknown>{
  const allowed=[...(options.allowDomain??[]),new URL(baseUrl).hostname]; const policy={allowedDomains:allowed,allowLoopback:options.allowLoopback??false};
  const registry=options.registry ?? new CapabilityRegistry();
  let selected: ReturnType<typeof plan> | undefined;
  try {
    const storedRefs=registryRefs(baseUrl,registry.query({domain:new URL(baseUrl).hostname,status:'active'}));
    let discoveredRefs: CapabilityRef[]=[];
    try {
      const discovered=await new CapabilityDiscovery({...policy,capabilityRegistry:registry}).discover(baseUrl,options.manifest);
      discoveredRefs=listCapabilities(discovered.manifest,baseUrl);
    } catch (discoveryError) {
      if (!storedRefs.length) throw discoveryError;
    }
    const refs=[...storedRefs,...discoveredRefs].filter((ref,index,all)=>all.findIndex(item=>item.capability.id===ref.capability.id&&item.path===ref.path)===index);
    const model=options.deterministic ? undefined : (options.llm ?? createConfiguredLlmClient()); selected=model ? await planWithModel(question,refs,{client:model}).catch(() => plan(question,refs)) : plan(question,refs); const exec=new HttpExecutor({...policy,cache:new ResponseCache(),audit:e=>console.error(JSON.stringify({...e,headers:redactHeaders({Authorization:'x'})}))}); const result=await exec.execute(selected.ref,selected.params); return normalize(result.data,selected.ref.capability,result.url,'direct-http',false,result.cacheHit?'cached':'live',{cache_hit:result.cacheHit});
  } catch(e) {
    const message=e instanceof Error?e.message:'request_failed'; const reason=(message.startsWith('parameter_missing')?'capability_not_found':message.includes('authentication')?'authentication_required':message.includes('manifest')?'manifest_missing':message.includes('domain')||message.includes('blocked')||message.includes('policy_blocked')?'policy_blocked':'request_failed') as FallbackReason;
    if(options.noBrowser || (options as any).browser === false) return {answer:{},source:baseUrl,retrieved_at:new Date().toISOString(),freshness:'live',method:'browser-fallback',fallback_used:true,reason};
    try { const browser=await createPlaywrightAdapter(); return await new BrowserFallback({...policy,browser,onObservedRequests: async (requests: ObservedRequest[]) => {
        const model=options.deterministic ? undefined : (options.llm ?? createConfiguredLlmClient());
        let analysis: Awaited<ReturnType<typeof analyzeObservedRequests>> | undefined;
        if (model) { try { analysis=await analyzeObservedRequests(question,requests,model); } catch { /* analysis is advisory; raw candidates remain pending */ } }
        const analysisByIndex=new Map((analysis?.candidates ?? []).map(candidate=>[candidate.index,candidate]));
        for (const [index,request] of requests.entries()) { try { registry.saveCandidate({method:request.method,url:request.url,domain:new URL(baseUrl).hostname,source:'browser-observation',status:'candidate',user_confirmed:false,metadata:{question,resource_type:request.resourceType,observed_at:request.observedAt,model_analysis:analysisByIndex.get(index) ?? {role:'unreviewed'}}}); } catch { /* untrusted observations must not break the user flow */ } }
      }}).run(baseUrl,reason,selected?.ref,selected?.params ?? {}); } catch { return {answer:{},source:baseUrl,retrieved_at:new Date().toISOString(),freshness:'live',method:'browser-fallback',fallback_used:true,reason:'browser_unavailable'}; }
  }
}
const cli=new Command().name('agent-fetch').description('面向 AI Agent 的安全网页数据访问层');
cli.command('ask <question>').description('从已确认的能力注册表中跨网站查询').option('--allow-loopback','允许本地回环地址（仅本地开发）').option('--deterministic','禁用大模型规划，使用本地规则').action(async(question:string)=>{const flags={allowLoopback:process.argv.includes('--allow-loopback'),deterministic:process.argv.includes('--deterministic')}; console.log(JSON.stringify(await runRegisteredQuestion(question,flags),null,2));});
cli.argument('<baseUrl>','网站或 provider 基地址').argument('<question>','自然语言问题').option('--manifest <url>','显式 manifest URL').option('--allow-domain <domain>','额外允许的域名', (v:string,p:string[])=>[...p,v],[]).option('--allow-loopback','允许本地回环地址（仅本地开发）').option('--no-browser','禁用浏览器回退').option('--deterministic','禁用大模型规划，使用本地规则').action(async(baseUrl:string,question:string,opts)=>{console.log(JSON.stringify(await runAgentFetch(baseUrl,question,opts),null,2));});
if(process.argv[1]?.endsWith('cli/index.ts')||process.argv[1]?.endsWith('agent-fetch')) cli.parseAsync().catch(e=>{console.error(JSON.stringify({error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});

import type { CapabilityRef, OpenApiParameter } from '../spec/index.js';

export class PlanningError extends Error { constructor(message:string){super(message);this.name='PlanningError';} }
const stop = new Set(['查询','当前','这个','商品','价格','库存','天气','多少','情况','有','吗','的','请','帮我','一下']);
function tokens(text:string): string[] { return text.toLowerCase().split(/[\s,，。？！?!/]+/).flatMap(x=>[x,...Array.from(x)]).filter(x=>x && !stop.has(x)); }
function score(question:string, ref:CapabilityRef): number {
  const q=tokens(question); const examples=ref.capability.intent_examples.flatMap(tokens); let s=examples.filter(x=>q.includes(x)).length;
  const id=ref.capability.id.toLowerCase(); if ((id.includes('price')||id.includes('amount')) && /价格|多少钱|price|cost|费用/.test(question)) s+=3;
  if ((id.includes('stock')||id.includes('inventory')) && /库存|有货|stock|inventory/.test(question)) s+=3;
  if (id.includes('weather') && /天气|温度|weather|temperature/.test(question)) s+=3;
  return s;
}
function firstMatch(text:string, patterns:RegExp[]): string|undefined { for(const p of patterns){const m=text.match(p); if(m?.[1]) return m[1];} }
export function extractParameters(question:string, params:OpenApiParameter[]=[]): Record<string,unknown> {
  const result:Record<string,unknown>={};
  for(const p of params) {
    const n=p.name.toLowerCase();
    if (n.includes('city') || n.includes('location')) result[p.name]=firstMatch(question,[/(?:城市|city|天气|在)\s*[:：]?\s*([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z\s-]{1,20})/i,/(北京|上海|深圳|广州|东京|Tokyo|Beijing|Shanghai)/i]);
    else if (n.includes('id') || n.includes('sku') || n.includes('product')) { const value=firstMatch(question,[/(?:sku|id|商品|产品)\s*[:：#]?\s*([A-Za-z0-9_-]{2,})/i,/(out-of-stock|iPhone\s*\d+(?:\s*\d+GB)?|Pixel\s*\d+)/i]); result[p.name]=value?.trim().replace(/\s+/g,'-').toLowerCase().replace(/^(iphone|pixel)-/, '$1'); }
  }
  for(const [k,v] of Object.entries(result)) if(v===undefined) delete result[k];
  return result;
}
export function plan(question:string, refs:CapabilityRef[]): {ref:CapabilityRef; params:Record<string,unknown>} {
  if(!refs.length) throw new PlanningError('capability_not_found');
  const ranked=refs.map(ref=>({ref,s:score(question,ref)})).sort((a,b)=>b.s-a.s); const best=ranked[0]!;
  if(best.s<=0) throw new PlanningError('capability_not_found');
  const params=extractParameters(question,best.ref.operation.parameters??[]);
  for(const p of best.ref.operation.parameters??[]) if(p.required && p.in !== 'header' && params[p.name]===undefined) throw new PlanningError(`parameter_missing:${p.name}`);
  return {ref:best.ref,params};
}

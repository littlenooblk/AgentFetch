import http from 'node:http';
import { priceManifest, inventoryManifest, weatherManifest } from './manifests.js';
const port=Number(process.env.PORT??8787); const counts={manifest:0,business:0,total:0,bytes:0};
const productData:Record<string,{amount:number;currency:string}>={iphone16:{amount:5999,currency:'CNY'},'iphone16-256gb':{amount:5999,currency:'CNY'},pixel9:{amount:799,currency:'USD'}};
const allManifest={...priceManifest,paths:{...priceManifest.paths,...inventoryManifest.paths,...weatherManifest.paths}};
function send(res:http.ServerResponse,status:number,value:unknown,content='application/json'){const body=content==='application/json'?JSON.stringify(value):String(value); const bytes=Buffer.byteLength(body); counts.bytes+=bytes; res.writeHead(status,{'content-type':content,'content-length':bytes});res.end(body);}
export function createMockServer(){ return http.createServer((req,res)=>{counts.total++;const u=new URL(req.url??'/',`http://${req.headers.host}`); if(u.pathname==='/.well-known/agent-fetch/openapi.json'||u.pathname==='/manifest.json'){counts.manifest++; return send(res,200,allManifest);} if(u.pathname==='/price/manifest.json'){counts.manifest++;return send(res,200,priceManifest);} if(u.pathname==='/inventory/manifest.json'){counts.manifest++;return send(res,200,inventoryManifest);} if(u.pathname==='/weather/manifest.json'){counts.manifest++;return send(res,200,weatherManifest);} counts.business++;
  const price=u.pathname.match(/^\/api\/products\/([^/]+)\/price$/); if(price){const p=productData[decodeURIComponent(price[1]??'')]??{amount:0,currency:'CNY'};return send(res,200,{price:p,updated_at:new Date().toISOString()});}
  const stock=u.pathname.match(/^\/api\/products\/([^/]+)\/inventory$/); if(stock){const id=decodeURIComponent(stock[1]??'');return send(res,200,{in_stock:id!=='out-of-stock',quantity:id==='out-of-stock'?0:12,updated_at:new Date().toISOString()});}
  if(u.pathname==='/api/weather/current'){const city=u.searchParams.get('city')??'北京';const temps:Record<string,number>={北京:22,上海:25,深圳:28,Tokyo:18,东京:18};return send(res,200,{temperature:temps[city]??20,condition:'晴',city,updated_at:new Date().toISOString()});}
  if(u.pathname==='/redirect-malicious'){res.writeHead(302,{location:'http://169.254.169.254/latest/meta-data'});return res.end();}
  return send(res,404,{error:'not_found'});
}); }
if(import.meta.url===`file://${process.argv[1]}`){const server=createMockServer();server.listen(port,()=>console.log(`AgentFetch mock services listening on http://localhost:${port}`));process.on('SIGINT',()=>server.close());}
export {counts};

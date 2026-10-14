import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface SessionRecord { domain:string; profileDir:string; lastUsed:string; expiresAt:string; }
export interface ObservedRequest { url:string; method:string; resourceType?:string; observedAt?:string; }
export class SessionManager {
  private records=new Map<string,SessionRecord>();
  constructor(private rootDir=path.join(os.homedir(),'.agent-fetch','profiles')) {}
  async get(domain:string):Promise<SessionRecord> { if(this.records.size===0){ try { const saved=JSON.parse(await fs.readFile(path.join(this.rootDir,'sessions.json'),'utf8')) as SessionRecord[]; for(const item of saved)this.records.set(item.domain,item); } catch {} } let r=this.records.get(domain); if(!r){const profileDir=path.join(this.rootDir,domain.replace(/[^a-z0-9.-]/gi,'_')); await fs.mkdir(profileDir,{recursive:true,mode:0o700}); r={domain,profileDir,lastUsed:new Date().toISOString(),expiresAt:new Date(Date.now()+24*3600_000).toISOString()}; this.records.set(domain,r); await this.persist();} if(new Date(r.expiresAt).getTime()<=Date.now()) throw new Error('session_expired'); r.lastUsed=new Date().toISOString(); await this.persist(); return r; }
  private async persist(){ await fs.mkdir(this.rootDir,{recursive:true,mode:0o700}); await fs.writeFile(path.join(this.rootDir,'sessions.json'),JSON.stringify([...this.records.values()]),{mode:0o600}); }
  expire(domain:string){const r=this.records.get(domain); if(r){r.expiresAt=new Date(0).toISOString(); void this.persist();}}
  list(){return [...this.records.values()].map(({domain,lastUsed,expiresAt})=>({domain,lastUsed,expiresAt}));}
}
export interface BrowserSessionAdapter { launch(profileDir:string):Promise<{close():Promise<void>; goto(url:string):Promise<void>; waitForUser(message:string):Promise<void>; request(url:string,init?:RequestInit):Promise<Response>; getObservedRequests?():ObservedRequest[]}> }

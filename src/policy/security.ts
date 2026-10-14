import dns from 'node:dns/promises';
import net from 'node:net';
import type { LookupAddress } from 'node:dns';

export interface PolicyOptions { allowedDomains: string[]; allowLoopback?: boolean; maxRedirects?: number; }
export class PolicyError extends Error { constructor(message: string) { super(message); this.name='PolicyError'; } }

const blockedNames = new Set(['localhost','metadata.google.internal','instance-data.ec2.internal']);
function isLoopbackIp(ip: string): boolean { return net.isIPv4(ip) ? ip.split('.')[0] === '127' : ip.toLowerCase() === '::1'; }
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a=0,b=0,c=0] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(ip)) {
    const n = ip.toLowerCase(); return n === '::1' || n.startsWith('fc') || n.startsWith('fd') || n.startsWith('fe80:') || n === '::';
  }
  return true;
}
function domainAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowed.some(d => { const x=d.toLowerCase().replace(/^https?:\/\//,'').replace(/\/$/,''); return h === x || h.endsWith(`.${x}`); });
}
export async function assertSafeUrl(raw: string, options: PolicyOptions): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new PolicyError('invalid URL'); }
  if (!['http:','https:'].includes(url.protocol)) throw new PolicyError(`blocked protocol: ${url.protocol}`);
  if (!domainAllowed(url.hostname, options.allowedDomains)) throw new PolicyError(`domain is not allowlisted: ${url.hostname}`);
  const hostname = url.hostname.toLowerCase();
  if (blockedNames.has(hostname) && !(options.allowLoopback && hostname === 'localhost')) throw new PolicyError(`blocked host: ${hostname}`);
  if (net.isIP(hostname) && isPrivateIp(hostname) && !(options.allowLoopback && isLoopbackIp(hostname))) throw new PolicyError(`private address blocked: ${hostname}`);
  if (!net.isIP(hostname)) {
    let records: LookupAddress[];
    try { records = await dns.lookup(hostname, {all:true}); } catch { throw new PolicyError(`DNS resolution failed: ${hostname}`); }
    if (records.some(r => isPrivateIp(r.address) && !(options.allowLoopback && isLoopbackIp(r.address)))) throw new PolicyError(`DNS resolves to private address: ${hostname}`);
  }
  return url;
}
export function redactHeaders(headers: Headers | Record<string,string>): Record<string,string> {
  const result: Record<string,string> = {};
  const sensitive = /authorization|cookie|set-cookie|token|password|secret|api[-_]?key/i;
  if (headers instanceof Headers) headers.forEach((v,k)=>{ result[k]=sensitive.test(k)?'[REDACTED]':v; });
  else for (const [k,v] of Object.entries(headers)) result[k]=sensitive.test(k)?'[REDACTED]':v;
  return result;
}
export function assertWriteAllowed(method: string, capability: { read_only: boolean; consent: string; side_effects: string }, confirmed = false): void {
  const write = !['GET','HEAD','OPTIONS'].includes(method.toUpperCase()) || !capability.read_only || ['write','destructive'].includes(capability.side_effects);
  if (write && !confirmed) throw new PolicyError('user confirmation required for write operation');
  if (write && capability.side_effects === 'destructive' && !confirmed) throw new PolicyError('destructive operation requires explicit confirmation');
}

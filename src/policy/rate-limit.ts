export class RateLimiter {
  private last = new Map<string, number[]>();
  async wait(key: string, requestsPerMinute = 60): Promise<void> {
    const now=Date.now(); const windowMs=60_000; const entries=(this.last.get(key)??[]).filter(t=>now-t<windowMs);
    if (entries.length >= requestsPerMinute) { const delay=windowMs-(now-(entries[0]??now))+5; await new Promise(r=>setTimeout(r, delay)); return this.wait(key, requestsPerMinute); }
    entries.push(Date.now()); this.last.set(key, entries);
  }
}

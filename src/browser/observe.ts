import type { ObservedRequest } from '../auth/session.js';

const sensitiveKey = /authorization|cookie|token|password|secret|key|signature|session/i;
const staticTypes = new Set(['image', 'stylesheet', 'font', 'media', 'manifest', 'script']);

/** Keep only same-origin requests that could describe a business API. */
export function sanitizeObservedRequests(requests: ObservedRequest[], baseUrl: string): ObservedRequest[] {
  const origin = new URL(baseUrl).origin;
  const seen = new Set<string>();
  const result: ObservedRequest[] = [];
  for (const request of requests) {
    try {
      const url = new URL(request.url);
      if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) continue;
      if (request.resourceType && staticTypes.has(request.resourceType)) continue;
      if (request.resourceType === 'document' && !/(\/api\/|graphql|ajax|\/v\d+(?:\/|$)|[?])/.test(url.pathname + url.search)) continue;
      for (const key of [...url.searchParams.keys()]) if (sensitiveKey.test(key)) url.searchParams.set(key, '[REDACTED]');
      const normalized = `${request.method.toUpperCase()} ${url.toString()}`;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      result.push({ ...request, method: request.method.toUpperCase(), url: url.toString(), observedAt: request.observedAt ?? new Date().toISOString() });
    } catch { /* untrusted browser data is skipped */ }
  }
  return result.slice(0, 200);
}

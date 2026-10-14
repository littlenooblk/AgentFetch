import { describe, expect, it } from 'vitest';
import { priceManifest } from '../src/mocks/manifests.js';
import { listCapabilities } from '../src/discovery/index.js';
import {
  capabilitiesToOpenAITools,
  capabilityToOpenAITool,
  createCapabilityPublishResponse,
  parseCapabilityPublishRequest,
  parseToolArguments,
  toolNameForCapability,
} from '../src/protocol/index.js';

describe('AgentFetch provider protocol', () => {
  const refs = listCapabilities(priceManifest, 'https://shop.example');

  it('maps OpenAPI parameters to OpenAI function tools', () => {
    const tool = capabilityToOpenAITool(refs[0]!);
    expect(tool.type).toBe('function');
    expect(tool.function.name).toBe('agentfetch_product_price_read');
    expect(tool.function.strict).toBe(true);
    expect(tool.function.parameters).toMatchObject({
      type: 'object',
      required: ['id'],
      additionalProperties: false,
    });
    expect(capabilitiesToOpenAITools(refs)).toHaveLength(1);
  });

  it('creates stable valid names for long capability ids', () => {
    const name = toolNameForCapability('provider.' + 'x'.repeat(200));
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(toolNameForCapability('provider.price.read')).toBe(toolNameForCapability('provider.price.read'));
  });

  it('validates publication envelope and manifest', () => {
    const request = parseCapabilityPublishRequest({
      protocol_version: 'agentfetch.v1',
      provider: { id: 'shop', name: 'Shop', version: '1.0.0' },
      manifest: priceManifest,
    });
    const response = createCapabilityPublishResponse(request, refs, '2026-01-01T00:00:00.000Z');
    expect(response.object).toBe('capability.publication');
    expect(response.capability_ids).toEqual(['product.price.read']);
    expect(response.tools[0]?.function.name).toBe('agentfetch_product_price_read');
    expect(() => parseCapabilityPublishRequest({ ...request, protocol_version: 'v0' })).toThrow(/protocol_version/);
    expect(() => parseCapabilityPublishRequest({ ...request, manifest: { ...priceManifest, paths: {} } })).toThrow(/manifest/);
  });

  it('accepts OpenAI encoded and object tool arguments only', () => {
    expect(parseToolArguments({ name: 'agentfetch_x', arguments: '{"id":"iphone16"}' })).toEqual({ id: 'iphone16' });
    expect(parseToolArguments({ name: 'agentfetch_x', arguments: { id: 'iphone16' } })).toEqual({ id: 'iphone16' });
    expect(() => parseToolArguments({ name: 'agentfetch_x', arguments: '[]' })).toThrow(/JSON object/);
    expect(() => parseToolArguments({ name: 'agentfetch_x', arguments: '{' })).toThrow(/valid JSON/);
  });
});

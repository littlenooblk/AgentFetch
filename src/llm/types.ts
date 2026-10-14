import type { CapabilityRef } from '../spec/index.js';

export interface ModelJsonClient {
  completeJson<T>(input: { system: string; user: string; schema?: Record<string, unknown> }): Promise<T>;
}

export interface ModelPlan {
  capability_id: string;
  params: Record<string, unknown>;
  confidence?: number;
  clarification?: string;
}

export interface LlmPlannerOptions { client: ModelJsonClient; maxCapabilities?: number; }

export interface CapabilitySelection {
  ref: CapabilityRef;
  params: Record<string, unknown>;
  confidence?: number;
}

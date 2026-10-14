import type { ModelJsonClient } from './types.js';

export interface OpenAICompatibleOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Minimal OpenAI-compatible JSON client. Credentials stay in this process and
 * are never included in prompts, audit events, or model-visible tool output.
 */
export class OpenAICompatibleClient implements ModelJsonClient {
  private readonly baseUrl: string;
  constructor(private readonly options: OpenAICompatibleOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }
  async completeJson<T>(input: { system: string; user: string; schema?: Record<string, unknown> }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.model,
          temperature: 0,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`llm_http_${response.status}`);
      const envelope = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = envelope.choices?.[0]?.message?.content;
      if (!content) throw new Error('llm_empty_response');
      try { return JSON.parse(content) as T; } catch { throw new Error('llm_invalid_json'); }
    } finally { clearTimeout(timer); }
  }
}

export function createConfiguredLlmClient(env: NodeJS.ProcessEnv = process.env): OpenAICompatibleClient | undefined {
  const apiKey = env.AGENT_FETCH_LLM_API_KEY;
  if (!apiKey) return undefined;
  return new OpenAICompatibleClient({
    apiKey,
    model: env.AGENT_FETCH_LLM_MODEL ?? 'gpt-4o-mini',
    baseUrl: env.AGENT_FETCH_LLM_BASE_URL,
  });
}

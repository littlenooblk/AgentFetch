# AgentFetch Provider Protocol (`agentfetch.v1`)

AgentFetch exposes a small provider protocol so an agent host can install one
remote tool and use capabilities maintained by providers. Provider operations
remain standard **OpenAPI 3.1** with AgentFetch's `x-agent-capability` extension.
The registry adds only an envelope and translates operations to the same
`tools[].type=function` shape used by OpenAI Chat Completions and Responses
clients.

The protocol is deliberately data-only. Providers publish an OpenAPI manifest;
AgentFetch remains responsible for selecting a capability, enforcing URL/SSRF
and read/write policy, calling the declared endpoint, and returning source and
freshness metadata. A provider never sends credentials to the model.

## Endpoints

The local service exposes these HTTP routes, and a hosted deployment can keep
the same wire format:

| Route | Method | Purpose |
| --- | --- | --- |
| `/v1/tools` | `GET` | List public capabilities as OpenAI-compatible function tools. |
| `/v1/providers/{provider_id}/manifest` | `PUT` or `POST` | Publish or update a provider manifest. |
| `/v1/tools/{tool_name}/call` | `POST` | Execute one declared tool call. |
| `/v1/query` | `POST` | Execute a natural-language AgentFetch query. |

All request and response bodies are JSON. A service can put the routes behind
an API gateway and use ordinary `Authorization: Bearer ...` for production.
For the initial public registry deployment, write access may be open; providers
should still set an explicit `provider.id` and version so entries can be
replaced or audited later. Never place a secret in a manifest, tool argument,
URL query, or an issue/commit.

## Listing tools

`GET /v1/tools` returns the OpenAI tool list shape:

```json
{
  "object": "list",
  "protocol_version": "agentfetch.v1",
  "data": [
    {
      "type": "function",
      "function": {
        "name": "agentfetch_product_price_read",
        "description": "product.price.read (GET /api/products/{id}/price). Examples: 查询商品当前价格；这个商品多少钱",
        "strict": true,
        "parameters": {
          "type": "object",
          "properties": {
            "id": { "type": "string", "description": "Product id" }
          },
          "required": ["id"],
          "additionalProperties": false
        }
      }
    }
  ]
}
```

The function name is a stable, sanitized form of the capability id prefixed
with `agentfetch_`, and is limited to 64 characters. Path and query parameters
become function arguments. Header and cookie parameters are omitted because
those are transport/auth concerns handled by AgentFetch. Tool arguments are
always checked against the original OpenAPI parameter schema before execution.

An external agent can pass `data` directly to an OpenAI-compatible model:

```json
{
  "model": "your-model",
  "messages": [{"role": "user", "content": "查询 iPhone 16 价格"}],
  "tools": [/* GET /v1/tools data */],
  "tool_choice": "auto"
}
```

The model's function call is sent to the AgentFetch tool route. The service
maps the sanitized name back to the declared capability id; a model cannot
invent a URL or operation.

## Publishing a provider

Providers publish the normal OpenAPI manifest inside an `agentfetch.v1`
envelope. `mode=upsert` is the default and updates entries with the same
provider/capability id. `replace` is useful when a provider wants the registry
to remove capabilities omitted from its latest release.

```http
PUT /v1/providers/acme-shop/manifest
Content-Type: application/json
```

```json
{
  "protocol_version": "agentfetch.v1",
  "provider": {
    "id": "acme-shop",
    "name": "Acme Shop",
    "version": "2026.10.14",
    "homepage": "https://shop.example"
  },
  "mode": "upsert",
  "manifest": {
    "openapi": "3.1.0",
    "info": {"title": "Acme Shop", "version": "2026.10.14"},
    "servers": [{"url": "https://shop.example"}],
    "paths": {
      "/api/products/{id}/price": {
        "get": {
          "operationId": "getProductPrice",
          "parameters": [{
            "name": "id", "in": "path", "required": true,
            "schema": {"type": "string"}
          }],
          "responses": {"200": {"description": "Current price"}},
          "x-agent-capability": {
            "id": "product.price.read",
            "intent_examples": ["查询商品当前价格", "这个商品多少钱"],
            "read_only": true,
            "freshness": {"max_age_seconds": 300},
            "output": {
              "amount": "$.price.amount",
              "currency": "$.price.currency",
              "as_of": "$.updated_at"
            },
            "side_effects": "none",
            "consent": "none",
            "auth": {"type": "none"}
          }
        }
      }
    }
  }
}
```

The publication response contains `object: capability.publication`, the
accepted timestamp, manifest version, capability ids, and the generated
OpenAI tools. A provider can validate this response in CI before publishing a
new version.

## Calling a tool

`POST /v1/tools/{tool_name}/call` accepts an OpenAI function-call payload.
`arguments` can be an object for a native integration or a JSON string exactly
as returned in `tool_calls[].function.arguments`:

```json
{
  "name": "agentfetch_product_price_read",
  "arguments": "{\"id\":\"iphone16\"}"
}
```

A successful result follows the AgentFetch result envelope and includes
`source`, `retrieved_at`, `freshness`, `method`, and `fallback_used`. Errors use
an OpenAI-style envelope:

```json
{"error":{"type":"invalid_request_error","code":"parameter_invalid","message":"id is required","param":"id"}}
```

Only capabilities declared in the published manifest are callable. GET/HEAD
read operations can be called automatically. Write or destructive operations
still require the service's explicit confirmation policy, even when a model
requests them.

## TypeScript adapter

The reusable protocol adapter is exported from the package root:

```ts
import {
  capabilitiesToOpenAITools,
  parseCapabilityPublishRequest,
  parseToolArguments,
} from 'agent-fetch';
```

`capabilityToOpenAITool` and `capabilitiesToOpenAITools` preserve the declared
OpenAPI parameter schema. `parseCapabilityPublishRequest` validates the
`agentfetch.v1` envelope and the OpenAPI manifest. `parseToolArguments` accepts
both object and encoded JSON arguments and rejects arrays or invalid JSON.

The protocol module contains no network or database dependency. A hosted
registry can later replace the local JSON registry with Postgres, SQLite,
DynamoDB, or another online store without changing provider manifests or agent
integrations.

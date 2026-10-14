# AgentFetch

AgentFetch 是一个面向 AI Agent 的网页数据访问层 MVP。它先读取网站公开的 OpenAPI 3.1 能力描述，选择最小的只读业务接口并直接请求；接口不可用时进入隔离 Playwright 会话，由用户亲自完成登录、2FA 或验证码，然后在同一个浏览器上下文继续请求。

这个仓库是从空目录初始化的 TypeScript/Node 20+ 项目，使用 Node 原生 `fetch`、Ajv、Commander、Playwright 和 Vitest。

## 安装和运行

```bash
npm install
npm run build
npm run mock-server
# 另一个终端：本地模拟 provider 需要显式允许回环地址
npm run dev -- http://127.0.0.1:8787 "查询 iPhone 16 256GB 当前价格" --allow-loopback --no-browser
```

CLI 输出包含 `answer`、`source`、`retrieved_at`、`freshness`、`method` 和 `fallback_used`。本地模拟服务同时提供价格、库存和天气三个 OpenAPI 能力；单项 manifest 位于 `/price/manifest.json`、`/inventory/manifest.json`、`/weather/manifest.json`，合并目录位于 `/.well-known/agent-fetch/openapi.json`。

```bash
npm test
npm run bench
```

如果需要浏览器回退，请先安装 Playwright 浏览器（`npx playwright install chromium`）。没有可用浏览器时 CLI 会返回 `method: "browser-fallback"` 和 `reason: "browser_unavailable"`，不会把密码、Cookie 或 Token 放入输出。

## Provider 扩展

Provider 使用标准 OpenAPI 3.1，在 operation 上增加 `x-agent-capability`：

```yaml
openapi: 3.1.0
info: {title: Example, version: 1.0.0}
paths:
  /api/products/{id}/price:
    get:
      parameters:
        - {name: id, in: path, required: true, schema: {type: string}}
      responses:
        '200':
          content:
            application/json: {schema: {type: object}}
      x-agent-capability:
        id: product.price.read
        intent_examples: [查询商品当前价格, 这个商品多少钱]
        read_only: true
        freshness: {max_age_seconds: 300}
        output: {amount: $.price.amount, currency: $.price.currency}
        side_effects: none
        consent: none
        auth: {type: none}
```

将 manifest 放在用户给定的 URL、`/.well-known/agent-fetch/openapi.json` 或 `/manifest.json`；也可以通过 `registry` 配置传入域名到 manifest URL 的映射。MVP 的 planner 是确定性的关键词和示例匹配器，只从 manifest 声明的参数中抽取商品 ID、SKU 和城市；缺少必填参数会触发回退。

## 浏览器、会话和回退

浏览器回退使用每个域名单独的持久化 profile（默认 `~/.agent-fetch/profiles`，目录权限 0700）。系统只展示当前访问域名，提示用户在浏览器中手动登录并完成 2FA/验证码，之后才继续。模型不会读取明文密码或完整 Cookie；动态签名请求在页面上下文执行。会话过期会停止重试并返回 `authentication_required`。

当前 MVP 提供 Playwright 接口和 fake adapter 测试面；无 manifest 时只打开页面并等待用户，尚未实现从任意网络轨迹自动生成 OpenAPI 适配器。

## 安全边界

- 所有 URL 都经过显式域名白名单、协议检查和 DNS/IP SSRF 检查；默认禁止 localhost、回环、RFC1918、链路本地、云元数据地址、`file:` 和其他协议。
- CLI 自动信任用户传入的目标域名，但不会因此放行私有 IP；`--allow-loopback` 仅供本地模拟测试。
- HTTP 请求使用手动重定向策略，每个 `Location` 都会重新校验，恶意或未授权跳转会停止。
- 只读 GET/HEAD 默认允许；任何写操作、`read_only: false` 或有写副作用的 capability 都必须传入用户确认，MVP 不自动执行付款、下单、转账等高风险动作。
- manifest、网页和接口返回值都视为不可信输入；日志只记录审计元数据，Authorization、Cookie、Token、密码和密钥会脱敏。
- 缓存只保存 GET 响应并带 capability TTL；429/5xx 只有限重试，认证失败、策略失败和响应校验失败不会无限重试。

## 测试和限制

测试覆盖 manifest 校验、三类能力发现、20 条规划样例、参数校验、响应缓存、SSRF、恶意重定向、日志脱敏、写确认和浏览器会话接口。基准脚本统计成功率、延迟、请求数和回退率；它不是生产容量测试。

MVP 暂不支持自动验证码识别/绕过、Cloudflare 或设备指纹绕过、猜测隐藏接口、任意真实网站适配、自动 OAuth 凭证代理、付款/下单/转账和多步写操作。`requestBody`、复杂 OAuth 流程以及从 HAR 自动生成适配器留待后续版本。

## 大模型规划和能力沉淀

配置 `AGENT_FETCH_LLM_API_KEY` 后，CLI 会自动使用 OpenAI-compatible Chat Completions 接口做能力选择和参数抽取；未配置时继续使用本地规则 planner。默认配置示例：

```bash
export AGENT_FETCH_LLM_API_KEY='在本地环境设置，不要写入仓库'
export AGENT_FETCH_LLM_MODEL='gpt-4o-mini'
# 兼容其他服务时可覆盖，例如 http://localhost:4000/v1
export AGENT_FETCH_LLM_BASE_URL='https://api.openai.com/v1'
npm run dev -- https://shop.example "查询 iPhone 16 当前价格"
```

模型只能从 manifest 或能力注册表给出的 capability ID、路径和参数中选择。它不能生成任意 URL；模型输出会再次做 capability ID、参数名和必填参数校验，失败后回退到本地 planner。使用 `--deterministic` 可强制禁用模型规划。

能力注册表默认保存到 `~/.agent-fetch/capabilities.json`，也可以用 `AGENT_FETCH_CAPABILITY_REGISTRY` 指定文件。成功读取的 manifest 会保存为已验证能力：只读接口状态为 `active`，写接口保持 `candidate`。后续 manifest 暂时不可用时，系统会优先查询同域名的 active 能力并尝试直连。

```bash
npm run registry -- list --domain shop.example
npm run registry -- confirm observed.0123456789abcdef
npm run registry -- disable observed.0123456789abcdef
```

如果只想让系统从已经确认的能力库中跨网站选择 provider，可以使用：

```bash
npm run dev -- ask "查询 iPhone 16 当前价格"
```

`ask` 只允许使用 `active + user_confirmed + read_only + side_effects:none` 的能力。第一次遇到新网站时仍需给出网站基地址，让系统完成 manifest 发现或浏览器回退。

当 manifest 缺失时，浏览器回退会在隔离页面中记录同源、非静态资源的网络请求。请求 URL 会移除凭证、Token 和敏感 query 参数，保存为 `candidate`，不会自动升级为可执行接口。人工检查候选接口后再执行 `confirm`；这一步防止页面内容、第三方脚本或动态请求被直接当成可信业务能力。

如果配置了 LLM，系统可以把脱敏后的同源请求 URL、HTTP 方法和当前问题发送到该 LLM 端点，让模型只返回观察列表中的请求索引和候选角色。模型不能看到 Cookie、Authorization、请求体或未脱敏的敏感 query，也不能发明 URL；候选仍保持 `candidate`，需要人工确认。

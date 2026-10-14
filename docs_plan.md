# 实现方案和阶段记录

## 阶段 0

仓库只有 `outputs/` 和 `work/`，没有既有语言、框架、依赖、测试或网络/浏览器模块。因此从零采用 TypeScript/Node 20+，以 OpenAPI 3.1 为唯一能力协议，并按 spec、discovery、planner、policy、executor、auth/browser、normalizer、cli、mocks 分层。

## 阶段 1

已实现 OpenAPI 3.1 `x-agent-capability` 校验器、价格/库存/天气三个本地 provider 及合并 catalog。

## 阶段 2

已实现 manifest 多级发现和 TTL、确定性自然语言规划、参数抽取、HTTP 超时/限流/有限重试、响应 schema 校验、GET TTL 缓存、结果规范化和审计回调。

## 阶段 3

已实现隔离 Playwright persistent context 接口、手动登录/2FA/验证码暂停点、会话过期检测和浏览器上下文请求。当前不自动观察任意网站网络轨迹生成适配器。

## 阶段 4

已实现 URL 白名单、SSRF/DNS 检查、手动重定向阻断、写确认、凭证日志脱敏和基准脚本；测试在依赖可用环境中运行 `npm test`，本地数据运行 `npm run bench`。

## 验证记录

- `npm run build`：通过。
- `npm test`：14 个核心测试全部通过，覆盖 manifest、发现、规划、直连、缓存、SSRF、重定向、脱敏、写确认和会话过期。
- `npm run bench`：20/20 任务直连成功，直连成功率 100%，平均延迟约 3.7 ms，P95 约 7 ms，平均业务请求 1 个/任务。
- Playwright 真实 Chromium 交互测试未在 CI 中强制运行；安装浏览器后可用 `npx playwright install chromium`，手动登录和验证码流程仍由用户完成。

## 大模型和能力沉淀阶段

已增加 OpenAI-compatible JSON planner、能力注册表和浏览器网络观察。模型仅接收受限 capability catalog，输出必须通过 capability ID、参数名和必填参数校验；API key 只用于进程内 HTTP 请求。manifest 能力按只读/写操作分别写入 active/candidate，浏览器观察请求一律写入 candidate；配置 LLM 后，它只能从脱敏观察列表中返回已存在的请求索引，经过人工 `agent-fetch-registry confirm` 后才允许复用。`ask` 子命令只执行已确认的只读能力。

## 公共服务阶段

已增加无依赖 Node HTTP service：`npm run service` 启动后提供 `/v1/query`、`/v1/chat/completions`、`/v1/tools`、`/v1/tools/{name}/call`、`/v1/providers/{provider_id}/manifest` 和公开 registry API。OpenAI function tool schema 从 OpenAPI 3.1 operation 自动生成；provider 发布后只读能力可直接进入 active，写能力保持 candidate。服务默认使用本地 JSON registry，未来替换在线数据库只需替换 registry 实现。

服务提供 Dockerfile，启动时只需注入模型环境变量和端口/认证配置；云数据库暂未绑定，JSON registry 仍是当前默认存储。

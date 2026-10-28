# Web2api 反代网关

把任意「网页版 AI 站点」包装成标准 OpenAI 接口：`POST /v1/chat/completions`，支持 `stream: true`。
零依赖，Node 24 直接跑（原生 TS + 内置 fetch），`npm install` 都不需要。

```bash
cp data/config.example.json data/config.json   # 首次
node src/cli.ts serve --port=8787
```

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' -H 'authorization: Bearer sk-w2a-change-me' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"你好"}]}'
```

任何 OpenAI SDK 都能直接指过来：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-w2a-change-me")
print(client.chat.completions.create(model="gpt-4o-mini", messages=[{"role":"user","content":"你好"}]).choices[0].message.content)
```

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | 主接口，`stream` 与非流式都支持；`?upstream=id` 或 body 里 `upstream` 可指定上游 |
| GET | `/v1/models` | 汇总所有上游模型 + 别名 |
| GET | `/v1/stats` | 请求数 / 成功失败 / 池子状态 / 限流快照 |
| GET | `/health` | 存活 + 上游清单 + 池子 |
| GET | `/admin/config` | 当前配置（密钥自动打码） |
| GET | `/admin/logs?limit=50` | 最近日志环形缓冲 |
| POST | `/admin/reload` | 热重载 `data/config.json`，不重启进程 |

响应头会带 `x-request-id`、`x-upstream`、`x-w2a-attempts`（形如 `mock-limited:429,echo:200`），追问题一眼就知道走了哪条链路。

## 三种上游形态

### 1. 声明式站点（推荐，不用写代码）

在 `data/config.json` 的 `upstreams[]` 里描述一个站点就能挂上：

```json
{
  "id": "uhelp-cookie",
  "label": "uhelp.ai /api/chat",
  "enabled": true,
  "models": ["claude-haiku-4-5-20251001", "gpt-5.5"],
  "base_url": "https://www.uhelp.ai",
  "chat_path": "/api/chat",
  "method": "POST",
  "headers": {
    "cookie": "__Secure-better-auth.session_token=你的会话",
    "origin": "https://www.uhelp.ai",
    "referer": "https://www.uhelp.ai/chat"
  },
  "body": { "model": "{{model}}", "messages": "{{messages}}" },
  "response_kind": "sse-openai"
}
```

支持的字段：

| 字段 | 说明 |
|---|---|
| `base_url` + `chat_path` | 目标站点与聊天路径 |
| `headers` / `query` | 任意自定义头（cookie、origin、referer、UA）与查询参数 |
| `auth` | 便捷 Bearer：`{ "header": "authorization", "prefix": "Bearer ", "token": "..." }` |
| `body` | 请求体模板，占位符 `{{model}} {{messages}} {{prompt}} {{system}} {{stream}} {{user}} {{max_tokens}} {{temperature}}`；`"{{messages}}"` 会被替换成真正的数组 |
| `response_kind` | `sse-openai`（OpenAI 风格 SSE）/ `sse-delta`（任意 `data:` 增量）/ `json` / `text` |
| `response_path` | `json` 模式下的取值路径，如 `choices.0.message.content` |
| `model_map` | 模型名映射，如 `{"gpt-4o": "claude-haiku-4-5-20251001"}` |
| `stream_by_default` / `timeout_ms` | 是否默认流式、单次超时 |
| `send_stream_options` | 流式时给上游塞 `stream_options.include_usage`，逼它回传用量 |

`response_kind` 之外不用管：网关会自动识别 `text/event-stream`，把 `choices[0].delta.content`、`delta.text`、`{text}`、`{response}` 等常见形状统一抽成文本增量。

### 2. 内置站点适配器

`builtin` 开关控制，用来处理行为比较特殊的站点（登录态 cookie、需要先换 token 等）：

```json
"builtin": { "uhelp": true, "aethyro_account": true, "aethyro_trial": false, "echo": true }
```

- `uhelp`：读 `data/accounts.json` 里的 better-auth 会话，直连 `/api/chat`，原生 SSE 透传，顺带回读 `/api/balance` 记额度
- `aethyro_account`：supabase edge function `/functions/v1/chat` + JWT
- `aethyro_trial`：匿名 `/functions/v1/trial-chat`（3 条/天/IP，默认关）
- `echo`：本地回声，用于压测与自检

### 3. 任意 OpenAI 兼容站点

```bash
export W2A_UPSTREAM_BASE=https://api.example.com/v1
export W2A_UPSTREAM_KEY=sk-xxx
export W2A_UPSTREAM_MODEL=gpt-4o-mini
```

启动时会作为一个上游进池子。

## 账号池：同站点多号自动轮换

同一个站点可以塞很多个账号，网关按「剩余额度 → 是否用过 → 胜率」自动挑，挂了自动换下一个。

```bash
node src/cli.ts hunt https://www.uhelp.ai/ --provider=imap   # 注册一个
node src/cli.ts verify https://www.uhelp.ai/ --email=...      # 验证一个
# 重复 N 次，账号都落在 data/accounts.json 里
```

- 状态落在 `data/state/accounts-pool.json`：`remaining` / `wins` / `losses` / `strikes` / `cooldown_until`
- `402` 或额度类 `429` → 该号冷却 6 小时，换下一个号
- `401/403` → 记 strike，连续两次判死
- 单次请求最多试 `limits.account_attempts` 个号（默认 3）
- 响应体带 `w2a_account`，`/v1/stats` 里按号统计调用次数

轮换逻辑自检：

```
就绪账号候选顺序:      a1,a2,a3            （needs_confirm 的 a4 被排除）
a2 报 402 之后:        候选 a1,a3          a2 → cooling, remaining=0, 冷却 6h
a3 连续两次 401 之后:  候选 a1            a3 → dead, strikes=2
按剩余额度重排:        a1(974) 优先
```

## usage：真实 token 用量回传

- 上游 SSE/JSON 里带 `usage` / `token_usage` / `usage_metadata` / Anthropic 风格 `input_tokens+output_tokens`，网关统一抽成 `{prompt_tokens, completion_tokens, total_tokens}`
- 非流式：直接写进响应的 `usage` 字段，同时累加到 `/v1/stats`
- 流式：客户端带 `stream_options: {"include_usage": true}` 时，在 `[DONE]` 前补一个 `choices: []` 的 usage chunk（OpenAI 规范行为）；不带就不发
- 上游一个字都不给的时候，按字符粗略估算（ASCII/4 + 宽字符/1.6）兜底，保证字段永远有值

```
非流式           usage: {"prompt_tokens":9,"completion_tokens":13,"total_tokens":22}
Anthropic 形状    输入 input_tokens/output_tokens 也能抽出来 → {"prompt_tokens":21,"completion_tokens":34,"total_tokens":55}
流式(含 option)   data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}
流式(无 option)   不发 usage chunk
/v1/stats        {"prompt_tokens":31,"completion_tokens":27,"total_tokens":58}
```

## 网关行为

- **上游池**：`data/state/pool.json` 持久化；429 → 冷却 6 小时，401/403 → 判死，按胜率 + 使用次数排序
- **链式回退**：一次请求最多试 `limits.upstream_attempts` 个上游，非可重试错误（400 之类）立即停
- **流式透传**：上游 SSE 增量直接转成 `chat.completion.chunk` 推给客户端；上游不支持流式的，收集完再分片；中途断流且已有输出时，用已收到的内容干净收尾
- **限流**：令牌桶，按 bearer key / IP 每分钟 `limits.rpm`，超限返回 429 + `retry-after`
- **并发闸门**：`limits.max_concurrency`，超出排队
- **鉴权**：配置了 `api_key` 就必须带 `Authorization: Bearer` 或 `x-api-key`；没配置时只允许本机回环访问
- **日志**：JSON 行，控制台 + `data/logs/gateway.log`，内存环形缓冲供 `/admin/logs` 查询
- **优雅关闭**：SIGINT/SIGTERM 落盘池子状态后退出

## 自检结果

mock 站点（`scripts/mock-site.mjs`，SSE + JSON + 纯文本 + 429 四种行为）跑通：

```
health         200  upstreams: mock-site, mock-plain, mock-limited, echo
/v1/models     200  mock-1, mock-1-mini, plain-1, limited-1, echo-1
chat 非流式     200  {"choices":[{"message":{"content":"mock answer for: \"你好\""}}]}   x-upstream: mock-site
模型别名        200  gpt-4o-mini → mock-1
纯文本上游      200  {"content":"plain text answer from mock"}
429 回退        200  x-w2a-attempts: mock-limited:429,echo:200
流式            200  data: {"choices":[{"delta":{"content":"Hello"}}]} … [DONE]   → 拼出 "Hello from mock-site."
错误密钥        401  {"error":{"message":"invalid api key"}}
非法请求体      400  {"error":{"message":"messages[] is required and must be non-empty"}}
/admin/config  200  api_key 显示为 ***tkey
```

默认配置（`data/config.json`）自检：

```
health   200  upstreams: uhelp, aethyro-account, echo
chat     200  上游无会话 → 自动回退 echo，客户端拿到正常 completion
stream   200  5 个 chunk + [DONE]
```

## 目录

```
src/gateway/
  server.ts     HTTP 服务、路由、鉴权、限流、SSE 写出、admin
  router.ts     上游选择链、重试回退、流式事件、池记账
  config.ts     配置加载/合并/env 覆盖/热重载/打码
  openai.ts     请求校验、模型别名、completion/chunk/error 构造
  limiter.ts    令牌桶 + 并发闸门
  logger.ts     JSON 日志 + 环形缓冲
src/web2api/
  types.ts      上游接口与消息工具
  stream.ts     SSE 解析、增量抽取、JSON 取路径
  upstreams.ts  内置适配器（uhelp / aethyro / OpenAI 兼容 / echo）
  declarative.ts 声明式站点适配器
src/pool/pool.ts 上游池（按上游维度）
src/pool/accounts.ts 账号池（按账号维度轮换）
scripts/mock-site.mjs 联调用的假站点
data/config.example.json 三站点示例配置
```

## 已知限制

- 声明式站点只覆盖「HTTP + 静态凭证」这一层；需要先登录换 token 的站点用 `builtin` 或自己在 `src/web2api/upstreams.ts` 加一个类
- `usage` 里的 token 数目前是 0 占位，站点不回传用量时无从计算（uhelp 的余额走 `/api/balance` 记在池子里）
- 账号池只认 `data/accounts.json` 里 `status: active` 的号；OAuth 登录类站点（例如只能浏览器 PKCE 的）目前拿不到 token
- usage 的单位取决于站点自己报什么，站点报的不是 token（比如按次、按字符）网关会原样透传，不做换算

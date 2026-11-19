# Venice Web Proxy · 外部接口调用协议文档

本文档描述本服务对外暴露的全部 HTTP 接口协议，包括 **OpenAI 兼容对话补全**、**文生图/图生图**、**角色（Characters）** 以及 **智能体（Minds）** 代理接口。

---

## 一、服务概览与接入规范

### 1.1 服务地址与线上资源链接

* **当前访问 Base URL**：`{{BASE_URL}}`
* **本地开发默认地址**：`http://127.0.0.1:3456`

| 页面 / 文档 | 访问路径 | 说明 |
| :--- | :--- | :--- |
| 在线 HTML 文档阅读页 | `{{BASE_URL}}/docs` | 排版后的接口协议文档阅读页 |
| 原始 Markdown 协议 | `{{BASE_URL}}/docs/api.md` | 浏览器直接预览纯文本 Markdown |
| 下载 Markdown 文件 | `{{BASE_URL}}/docs/api.md?download=1` | 下载为 `venice-api-protocol.md` |
| 角色浏览器页面 | `{{BASE_URL}}/characters.html` | 在线浏览社区角色卡与个人角色（支持 `?download=1` 下载） |
| Minds 浏览器页面 | `{{BASE_URL}}/minds.html` | 在线浏览 Minds 智能体与工具集（支持 `?download=1` 下载） |

### 1.2 鉴权说明

* **当前默认状态**：默认未配置访问密钥（`VENICE_API_KEY` 为空），所有接口可直接免密调用。
* **开启访问密钥（可选）**：如果在服务端环境变量中配置了 `VENICE_API_KEY`，则除 `/health`、`/`、`/docs`、`/docs/api.md`、`/characters.html`、`/minds.html` 和 `OPTIONS` 外的 API 接口均需通过以下任意一种方式鉴权：
  1. HTTP Header：`Authorization: Bearer <VENICE_API_KEY>`
  2. HTTP Header：`x-api-key: <VENICE_API_KEY>`
  3. Query 参数：`?api_key=<VENICE_API_KEY>`

### 1.3 CORS 与通用响应规范

* 所有接口（含 SSE 流式响应与静态页面）均启用 CORS：`Access-Control-Allow-Origin: *`，允许方法 `GET, POST, OPTIONS`，允许请求头 `Content-Type, Authorization, x-api-key`。
* 错误响应统一遵循 OpenAI 风格 JSON 结构：

```json
{
  "error": {
    "message": "错误描述信息",
    "type": "venice_web_error"
  }
}
```

| HTTP 状态码 | 说明 |
| :--- | :--- |
| `200` | 请求成功 |
| `204` | `OPTIONS` 跨域预检成功 |
| `400` | 请求参数非法（例如未知模型、参数越界、`invalid_request_error`） |
| `401` | 访问密钥缺失/无效（`authentication_error`），或上游 Venice 登录态已过期需刷新 Cookie |
| `404` | 未知接口路径（`not_found`） |
| `413` | 请求体超出大小限制（图片生成/编辑接口上限为 `64 MB`） |
| `500` / `502` | 本地代理异常或上游 Venice 推理服务异常 |

---

## 二、基础与健康检查接口

### 2.1 服务健康检查

* **接口**：`GET /health`（别名：`GET /`）
* **说明**：检测服务存活状态、当前绑定的 Venice 账号邮箱、已加载模型数量、当前网络传输模式（`curl` 或 `fetch`）及文档路径。

**响应示例 (`200 OK`)**：
```json
{
  "ok": true,
  "account": "example@gmail.com",
  "provider": "venice-web",
  "models": 19,
  "transport": "curl",
  "docs": "/docs",
  "apiDocMd": "/docs/api.md"
}
```

### 2.2 获取可用模型列表

* **接口**：`GET /v1/models`（别名：`GET /models`）
* **说明**：返回 OpenAI 格式的模型目录，仅包含网页端免积分（`usesCredits: false`）的文本模型，避免误消耗 API Credits。

**响应示例 (`200 OK`)**：
```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4-1-flash-uncensored",
      "object": "model",
      "owned_by": "venice-web",
      "name": "DeepSeek V4.1 Flash Uncensored (web)",
      "context_length": 524288
    }
  ]
}
```

### 2.3 重载会话缓存

* **接口**：`POST /reload`
* **说明**：清空内存中的 Clerk JWT、Client Attestation 与用户 ID 缓存并重新读取环境变量或会话文件。

---

## 三、OpenAI 兼容对话补全接口

### 3.1 接口定义

* **接口**：`POST /v1/chat/completions`（或任意以 `/chat/completions` 结尾的 `POST` 路径）
* **Content-Type**：`application/json`

### 3.2 支持的免费文本模型（共 19 个）

| Model ID | 名称 | 上下文上限 | 输出上限 | Reasoning | Vision |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `deepseek-v4-1-flash-uncensored` | DeepSeek V4.1 Flash Uncensored (web) | 524,288 | 131,072 | 支持 | 支持 |
| `qwen-3-8-27b` | Qwen 3.8 27B (web) | 262,144 | 65,536 | 支持 | 支持 |
| `qwen3-6-27b` | Qwen 3.6 27B (web) | 256,000 | 65,536 | 支持 | 支持 |
| `qwen3-5-35b-a3b` | Qwen 3.5 35B A3B (web) | 256,000 | 16,384 | 支持 | 支持 |
| `zai-org-glm-5.2` | GLM 5.2 (web) | 1,000,000 | 131,072 | 支持 | 支持 |
| `zai-org-glm-4.6` | GLM 4.6 (web) | 198,000 | 16,384 | 不支持 | 支持 |
| `venice-uncensored-1-2` | Venice Uncensored 1.2 (web) | 128,000 | 8,192 | 不支持 | 支持 |
| `google-gemma-4-31b-it` | Gemma 4 31B Instruct (web) | 256,000 | 8,192 | 支持 | 支持 |
| `google-gemma-4-26b-a4b-it` | Gemma 4 26B A4B Instruct (web) | 256,000 | 8,192 | 支持 | 支持 |
| `gemma4-uncensored` | Gemma 4 Uncensored (web) | 256,000 | 8,192 | 不支持 | 支持 |
| `aion-labs-aion-3-0` | Aion 3.0 (web) | 128,000 | 32,768 | 支持 | 支持 |
| `aion-labs-aion-3-0-mini` | Aion 3.0 Mini (web) | 128,000 | 32,768 | 支持 | 支持 |
| `deepseek-ai-DeepSeek-V3.2` | DeepSeek V3.2 (web) | 160,000 | 32,768 | 支持 | 支持 |
| `e2ee-qwen3-8-27b` | Qwen 3.8 27B TEE (web) | 262,144 | 8,192 | 支持 | 支持 |
| `e2ee-gpt-oss-120b-p` | GPT OSS 120B TEE (web) | 128,000 | 32,768 | 支持 | 支持 |
| `e2ee-qwen3-6-35b-a3b` | Qwen 3.6 35B A3B FP8 TEE (web) | 32,000 | 4,096 | 支持 | 支持 |
| `e2ee-gemma-4-26b-a4b-uncensored-p` | Gemma 4 26B A4B Uncensored TEE (web) | 64,000 | 4,096 | 不支持 | 支持 |
| `e2ee-qwen-2-5-7b-p` | Qwen 2.5 7B TEE (web) | 32,000 | 4,096 | 不支持 | 支持 |
| `e2ee-qwen3-vl-30b-a3b-p` | Qwen3 VL 30B A3B TEE (web) | 128,000 | 4,096 | 不支持 | 支持 |

> **别名兼容**：传入旧别名 `deepseek-v4-1-flash-free` 会自动解析为 `deepseek-v4-1-flash-uncensored`。

### 3.3 请求体参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `model` | string | 是 | 上表中的任意模型 ID（或兼容别名） |
| `messages` | array | 是 | 非空消息数组；支持 `system`、`developer`、`user`、`assistant`、`tool` 角色 |
| `stream` | boolean | 否 | 默认 `false`（返回完整 JSON）；传 `true` 返回标准 OpenAI SSE 流 |
| `tools` | array | 否 | OpenAI `type: "function"` 工具数组；代理层通过 JSON 信封协议自动模拟工具调用 |
| `tool_choice` | string / object | 否 | 支持 `"auto"`、`"none"`、`"required"` 或 `{ "type": "function", "function": { "name": "..." } }` |
| `reasoning_effort` | string | 否 | 亦兼容 `reasoningEffort` 或 `reasoning.effort`：<br>• `none` / `minimal` / `disabled` / `off`（或未传）➔ `disabled`<br>• `adaptive` / `auto` / `medium` ➔ `adaptive`<br>• 其余值（如 `high`、`enabled`）➔ `enabled` |

> **多模态图片输入规范**：在 `user` 消息的 `content` 数组中使用 `{ "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }`，支持 `PNG`、`JPEG`、`WebP`、`GIF` 格式的 Base64 Data URL，单轮最新用户消息最多携带 **10 张**图片；远程 `http(s)://` 图片链接不会被代理抓取，将保留为 `[image]` 文本占位符。  
> **上游特性提示**：Venice Web 推理接口不接受自定义采样参数，请求中的 `temperature`、`top_p`、`max_tokens` 会被上游忽略。

### 3.4 响应格式

#### 非流式响应 (`stream: false` 或未传)
```json
{
  "id": "chatcmpl-9c8f2b1a...",
  "object": "chat.completion",
  "created": 1795000000,
  "model": "deepseek-v4-1-flash-uncensored",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "pong"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 2,
    "total_tokens": 14
  }
}
```
* 若模型返回了推理过程，会在 `message.reasoning` 中附带；若触发工具调用，`finish_reason` 为 `"tool_calls"` 且 `message.tool_calls` 包含调用详情。

#### 流式响应 (`stream: true`)
`Content-Type: text/event-stream; charset=utf-8`，每条消息为 `data: <JSON>\n\n`，包含：
* `choices[0].delta.content`：正文增量
* `choices[0].delta.reasoning_content`：思考过程增量
* `choices[0].delta.tool_calls`：模拟工具调用结果
* 流末尾输出包含 `usage` 的结束块以及 `data: [DONE]\n\n`（长时间工具校验期间每 15 秒发送 `: keepalive\n\n` 心跳）。

### 3.5 调用示例

```sh
curl -sS "{{BASE_URL}}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-1-flash-uncensored",
    "stream": false,
    "messages": [
      { "role": "system", "content": "你是一个简洁的助手。" },
      { "role": "user", "content": "Reply with just: pong" }
    ]
  }'
```

**OpenAI SDK 接入（Python / Node.js 通用）**：
```python
from openai import OpenAI

client = OpenAI(
    base_url="{{BASE_URL}}/v1",
    api_key="unused", # 若未开启 VENICE_API_KEY，填任意非空字符串即可
)
resp = client.chat.completions.create(
    model="deepseek-v4-1-flash-uncensored",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

---

## 四、OpenAI 兼容图像生成与编辑接口

### 4.1 图像生成 (`POST /v1/images/generations`)

* **接口**：`POST /v1/images/generations`（最大请求体 `64 MB`）
* **支持模型**：
  * `z-image-turbo`（**默认**，名称：`Z-Image Turbo`）
  * `chroma`（名称：`Chroma`）
  * `wai-illu`（名称：`Anime (WAI)`）
  * *兼容回退*：传入 `dall-e-2`、`dall-e-3`、`gpt-image-1`、`gpt-image-1-mini`、`gpt-image-1.5` 或留空时，自动回退至默认免费模型 `z-image-turbo`。

| 请求字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `prompt` | string | 是 | 绘图提示词（非空字符串） |
| `model` | string | 否 | 图像模型 ID |
| `n` | number | 否 | 生成张数，整数 `1 ~ 4`，默认 `1`（多张时代理并发请求） |
| `size` | string | 否 | `"auto"`（默认）或 `WIDTHxHEIGHT`，宽高均须在 `256 ~ 2048` 之间 |
| `response_format` | string | 否 | `"b64_json"`（默认）或 `"url"`（返回 `data:image/...;base64,...` Data URL） |

**调用示例**：
```sh
curl -sS "{{BASE_URL}}/v1/images/generations" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "z-image-turbo",
    "prompt": "a serene mountain lake at sunrise, minimalist illustration",
    "n": 1,
    "size": "1024x1024",
    "response_format": "b64_json"
  }'
```

### 4.2 图像编辑 (`POST /v1/images/edits`)

* **接口**：`POST /v1/images/edits`（最大请求体 `64 MB`）
* **支持格式**：`multipart/form-data`（标准文件上传字段 `image` / `image[]`）或 `application/json`（字段 `image` / `images` 为 Base64 Data URL）。
* **支持模型**：
  * `firered-image-edit`（**默认**，名称：`FireRed`）
  * `qwen-edit-uncensored`（名称：`Qwen Edit Uncensored`）
* **限制**：每次最多附带 **10 张**参考图（仅支持 PNG / JPEG / WebP / GIF 文件或 Data URL，不支持传远程 URL 或 `mask` 参数）。

**JSON 调用示例**：
```sh
curl -sS "{{BASE_URL}}/v1/images/edits" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "firered-image-edit",
    "prompt": "change the sky to golden sunset",
    "image": "data:image/png;base64,..."
  }'
```

---

## 五、角色（Characters）接口

透传并封装 Venice 网页端 `/api/characters/*` 系列接口。

### 5.1 获取公开角色列表

* **接口**：`GET /v1/characters`（别名：`GET /characters`）
* **Query 参数**：

| 参数名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `page` | number | 页码，默认 `1` |
| `pageSize` | number | 每页条数，`1 ~ 100`，默认 `20` |
| `sortBy` | string | 排序方式：`featured`（官网默认精选）、`mostRecent`、`imports`、`highestRating`、`ratingCount`、`highlyRated`、`highlyRatedAndRecent` |
| `search` | string | 关键词搜索 |
| `categories` | string | 分类过滤（逗号分隔） |
| `tags` | string | 标签过滤（逗号分隔） |
| `isAdult` | boolean | `true` / `false`，是否包含成人向角色 |
| `isPro` | boolean | 是否仅限 Pro 角色 |
| `isWebEnabled` | boolean | 是否启用联网 |
| `modelId` | string | 按默认绑定模型 ID 筛选 |

**示例**：
```sh
curl -sS "{{BASE_URL}}/v1/characters?page=1&pageSize=10&sortBy=featured&isAdult=false"
```

### 5.2 获取我的角色列表

* **接口**：`GET /v1/characters/me`（别名：`GET /characters/me`）
* **说明**：获取当前已登录 Venice 账号自己创建的所有角色卡，直接返回角色数组 `[...]`。

### 5.3 获取单个角色详情（含人设与开场白）

* **接口**：`GET /v1/characters/:id`（别名：`GET /characters/:id`）
* **Query 参数**：
  * `includeJsonData`：默认 `true`（传 `false` 可省略 `jsonData`）。
* **核心返回字段**：
  * `id` / `slug` / `name` / `author` / `description` / `modelId` / `status` / `stats` / `tags`
  * `jsonData.intro`：角色开场白（第一句台词）
  * `jsonData.instructions`：角色核心系统提示词（System Prompt）
  * `jsonData.textSettings`：作者预设默认模型与高级参数
  * `jsonData.characterVoice`：角色 TTS 语音设置

### 5.4 获取角色头像

* **接口**：`GET /v1/characters/:id/photo`（别名：`GET /characters/:id/photo`）
* **说明**：返回角色头像二进制图片（含 `Cache-Control: public, max-age=3600`）。

### 5.5 实战：拉取角色后发起对话

拿到 `GET /v1/characters/:id` 返回的 `jsonData` 后，将 `jsonData.instructions` 放入 `system` 消息，将 `jsonData.intro` 作为首条 `assistant` 消息，即可直接调用 `POST /v1/chat/completions` 与任意免费网页模型（如 `deepseek-v4-1-flash-uncensored`）展开角色扮演对话，无需局限于角色自带的 `modelId`。

---

## 六、智能体（Minds）接口

透传并封装 Venice 网页端 `/api/v2/agents/*` 系列接口。

### 6.1 获取精选 Minds

* **接口**：`GET /v1/minds/featured`（别名：`GET /minds/featured`）
* **返回格式**：`{ "data": [ ... ] }`，包含官网精选智能体列表。

### 6.2 搜索 / 筛选 Minds

* **接口**：`GET /v1/minds/search`（别名：`GET /v1/minds`、`GET /minds/search`、`GET /minds`）
* **Query 参数**：

| 参数名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `q` | string | 搜索关键词 |
| `category` | string | 分类：`coding`、`writing`、`photo_video`、`research`、`productivity`、`crypto`、`entertainment`、`gaming`、`sports`、`travel`、`spirituality`、`shopping`、`uncategorized` |
| `sort` | string | 排序：`newest`（最新）或 `burned`（代币燃烧最多） |
| `limit` | number | 每页条数，`1 ~ 100`，默认 `20` |
| `cursor` | string | 游标分页 token（取自上一次响应的 `nextCursor`） |
| `creatorId` | string | 创作者 UUID |
| `maturityRatings` | string | 内容分级：`G`、`PG`、`R`、`X` |

**响应格式**：`{ "data": [...], "limit": 20, "nextCursor": "..." }`

### 6.3 获取我的 Minds

* **接口**：`GET /v1/minds/me`（别名：`GET /minds/me`）
* **说明**：代理层自动请求 `/api/user/session` 解析当前登录账号的 Venice UUID，再自动以 `creatorId` 查询并返回 `{ "data": [...], "limit": 20, "nextCursor": null }`。支持透传 `limit`、`cursor` 等参数。

### 6.4 获取我收藏的 Minds

* **接口**：`GET /v1/minds/favorites`（别名：`GET /minds/favorites`）
* **Query 参数**：支持 `q`、`category`、`limit`、`cursor`。

### 6.5 获取单个 Mind 详情

* **接口**：`GET /v1/minds/:slug`（别名：`GET /minds/:slug`）
* **核心返回字段**：
  * `slug` / `mindNumber` / `name` / `category` / `description` / `longDescription`
  * `openingInstruction`：开场引导指令
  * `model`：`{ "id", "name" }` 推荐核心模型
  * `reasoningMode` / `reasoningVisibility`
  * `tools`：装配的内置工具数组（如 `web_search`、`web_scrape`、`generate_image`、`edit_image`、`generate_video_v2` 等）
  * `subAgents`：协同子智能体团队列表
  * `avatarHash` / `coverHash` / `onchainAddress` / `totalBurnedCryptoBaseUnit`

### 6.6 获取 Mind 头像与封面图

* **头像**：`GET /v1/minds/:slug/avatar`（支持可选参数 `?h=:avatarHash`）
* **封面**：`GET /v1/minds/:slug/cover`（支持可选参数 `?h=:coverHash`）
* **说明**：返回 `image/webp` 二进制图片（含 `Cache-Control: public, max-age=3600`）。

---

## 七、线上部署与运维说明（Vercel）

### 7.1 环境变量配置

| 变量名 | 必填 | 说明 |
| :--- | :--- | :--- |
| `VENICE_SESSION_B64` | 推荐 | 本地 `session.json` 的 Base64 编码字符串（包含 `client` `__client` Cookie、`userAgent`、`uid`、`sessionId`、`email`） |
| `VENICE_SESSION_JSON` | 可选 | 若不使用 `VENICE_SESSION_B64`，可直接填入完整 JSON 字符串 |
| `VENICE_CLIENT_COOKIE` | 可选 | 仅传入 Clerk `__client` Cookie 值时的极简回退配置 |
| `VENICE_API_KEY` | 可选 | 设置后所有 API 路由自动启用 Bearer / `x-api-key` 鉴权；留空则免密公开 |
| `VENICE_WEB_TRANSPORT` | 可选 | `auto`（默认，优先系统 `curl` 以通过 Cloudflare）、`curl` 或 `fetch` |

### 7.2 凭证过期更新

当 `/health` 正常但业务请求返回 `401`（提示 refresh cookies 或 Clerk 会话失效）时，在本地重新登录并刷新 Vercel 环境变量即可：
```sh
node src/login.mjs
base64 < ~/.config/opencode/venice-web/session.json | tr -d '\n' | vercel env add VENICE_SESSION_B64 production --force
vercel --prod --yes
```

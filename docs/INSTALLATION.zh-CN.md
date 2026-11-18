# 本机安装与实测记录

日期：2026-11-17。版本：0.1.4。

## 安装结果

- 代码目录：`/Users/azaz/.local/share/opencode-venice-web`
- API Base URL：`http://127.0.0.1:3456/v1`
- 后台服务：macOS LaunchAgent `ai.opencode.venice-web`，当前已运行，配置了登录后启动和退出后自动重启。
- 服务配置：`/Users/azaz/Library/LaunchAgents/ai.opencode.venice-web.plist`
- OpenCode 配置：`/Users/azaz/.config/opencode/opencode.json`，已添加 `venice-web` provider，没有改变默认模型。
- 认证：使用用户手动保存的 `__client` 和 User-Agent 成功验证 Venice 会话。未通过浏览器 Cookie 数据库提取完成登录。
- 会话文件：`/Users/azaz/.config/opencode/venice-web/session.json`，权限 `0600`。
- 用户提供的临时文件 `/tmp/venice-login.txt` 权限已改为 `0600`；未将凭证写入仓库或本记录。

## 实际测试结果

以下为通过本地代理调用真实 Venice 上游的结果，不是模拟响应。

| 测试 | 模型或入口 | 结果 | 本次耗时 |
| --- | --- | --- | --- |
| 非流式聊天 | `qwen3-5-35b-a3b` | 17 + 25 正确返回 42 | 约 2.4 秒 |
| 流式聊天 | `qwen3-5-35b-a3b` | 返回 PONG，SSE 包含结束标志 | 约 1.5 秒 |
| 工具调用闭环 | `qwen3-5-35b-a3b` | 返回 add_numbers 调用，本地计算并回传后回答 42 | 两轮合计约 5.1 秒 |
| 图片生成 | `z-image-turbo` | 返回有效 PNG，103188 字节 | 约 4.0 秒 |
| 默认模型聊天 | `deepseek-v4-1-flash-free` | 6 × 7 正确返回 42 | 约 1.4 秒 |
| 安装自检 | `doctor.mjs` | 全部检查通过 | — |

图片测试输出：`/tmp/venice-web-live-generated.png`。

上述耗时仅代表本次小请求，不是性能承诺。未测试全部 19 个模型、图片编辑、长上下文、高并发、长期会话刷新，也未对比调用前后余额，不能据此保证零扣费或长期稳定。

## 调用示例

```sh
curl http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3-5-35b-a3b",
    "stream": false,
    "messages": [{"role": "user", "content": "你好，请用中文回答。"}]
  }'
```

支持自定义 OpenAI Base URL 的客户端可填写：

- Base URL：`http://127.0.0.1:3456/v1`
- API Key：`venice-web`，仅用于满足客户端的必填要求；当前本地代理不校验此字段。
- 模型：`qwen3-5-35b-a3b` 或 `deepseek-v4-1-flash-uncensored`。

无需将 Venice Cookie 填入客户端。Cookie 由本地代理维护。不要把当前无入口鉴权的代理绑定到公网。

## 常用维护命令

```sh
curl http://127.0.0.1:3456/health
node /Users/azaz/.local/share/opencode-venice-web/src/doctor.mjs
launchctl kickstart -k gui/$(id -u)/ai.opencode.venice-web
tail -f /Users/azaz/.config/opencode/venice-web/proxy.log
```

Cookie 失效或被撤销后需要重新提供手动登录信息。不要直接执行默认登录命令，否则它会再次尝试读取浏览器 Cookie。

平台条款和协议稳定性限制见 [调研报告](RESEARCH.zh-CN.md)。

## ai-growth-ops 接入

已通过后端业务服务新增配置，保留原有所有 Provider，不改变场景绑定：

- 名称：`Venice Web（本地订阅）`，ID：`17`，状态：启用。
- 类型与适配器：`openai_compatible`。内置 `venice_ai` 适配器强制连接官方域名，因此不用于本地网页代理。
- 完整端点：`http://host.docker.internal:3456/v1/chat/completions`。
- 自动拼接 `/v1`：关闭。
- API Key：`venice-web`，作为客户端配置占位值加密保存；不向项目复制网页 Cookie。
- 默认模型：`deepseek-v4-1-flash-uncensored`（已从官方旧别名迁移）。
- Provider 快照已同步到 PersonaCore：源版本与确认版本均为 `4`。

后端与 PersonaCore 均在 Docker 中运行，因此使用 `host.docker.internal` 访问宿主机回环代理。配置端点必须保留完整 `/v1/chat/completions` 路径。

本次修正了代理未指定 `stream` 时默认返回 SSE 的兼容问题：现在仅 `stream: true` 返回 SSE，其余情况返回 JSON。源码和已安装代理均已更新，并已重启后台服务。

验收：在 `ai-growth-ops-backend-api` 容器内使用项目实际 `AiChatClient`，不传 `stream`，询问 17 + 25，返回 `42`，约 2.4 秒；通过 Provider 业务服务查询模型目录，返回 19 个模型。原有 Provider 记录前后比对完全一致。项目现有通用适配器的管理端测试走 Responses 解析，本次真实推理验收直接使用业务 Chat 客户端，未将其标记为 Responses 支持。

## 正式模型 ID 校正与验收

同日读取已登录网页模型目录，确认 `deepseek-v4-1-flash-uncensored` 是正式 ID，`aliasIds` 包含旧 ID `deepseek-v4-1-flash-free`。这证明旧 ID 是官方别名；之前对实际命中模型的疑问已有目录证据补充，但不代表可以独立审计服务端模型权重。

- 代理默认值和模型列表使用正式 ID，仍保留共 19 个目录条目；旧 ID 作为兼容输入，在聊天和评判请求中统一转换为正式 ID。
- 输出上限按目录 `maxResponseTokens` 更新为 131072，上下文维持 524288；并未对这些最大长度做压力验证。
- OpenCode 已重新同步，迁移本 Provider 已选中的旧别名，不覆盖其他 Provider 的默认选择。
- ai-growth Provider `17` 已更新模型，其他字段、密钥、启用状态、业务场景绑定与其他 Provider 保持不变。PersonaCore 源版本与确认版本均为 `5`。
- 正式 ID 与旧别名的本地代理真实请求均返回 `42`；ai-growth 容器实际聊天客户端使用正式 ID 询问 6 × 7，返回 `42`，约 1.5 秒；模型目录包含正式 ID。

可复现检查：`node --test test/*.test.mjs`，本次 128 项通过；新增 `test/model-alias.test.mjs` 覆盖正式目录、旧别名解析、评判请求和配置迁移。实际客户端将模型设为 `deepseek-v4-1-flash-uncensored`，请求 `/v1/chat/completions`，不传 `stream`，预期收到 JSON 聊天结果。旧 ID 请求仍应成功，但不会作为第二个模型重复列出。

## OpenCode 正文流式显示（2026-11-18）

已在保留工具模拟的前提下启用最终正文增量输出，源码与本机已安装代理一致，后台服务已重启生效。OpenCode 不需要重新配置 Provider，后续 `stream:true` 请求直接使用新行为。

- 模型先声明最终状态与空工具列表，代理便解码正文字符串并逐段转发；中文、转义、Unicode 和表情可跨分片。
- 工具调用仍先完成参数校验再发给客户端，不提前泄漏工具参数。显式 `tool_choice:required` 或指定工具时保留完整缓冲与重试。
- 已流式显示的合法最终回答不再等待后台评判器替换；格式异常、字段顺序不符及工具修复请求仍可能缓冲回退，因此无法保证所有异常输出都即时显示。
- `stream:false` 和省略 `stream` 继续返回完整 JSON，兼容 ai-growth。

验收：139 项单元/集成回归测试通过；在 OpenCode 新建的独立会话中，使用 Venice Uncensored 正常完成 SSE 说明回答。真实 HTTP 请求始终携带工具，记录到 Venice Uncensored 正文 166 个片段，首段约 3.36 秒、末段约 5.26 秒；DeepSeek 正文 205 个片段，首段约 1.38 秒、末段约 3.82 秒，均为生成期间持续到达。两个模型的加法工具调用、结果回传与非流式 JSON 均通过。

可复现命令：

```sh
node --test test/*.test.mjs
node scripts/verify-stream.mjs
STREAM_TEST_MODEL=deepseek-v4-1-flash-uncensored node scripts/verify-stream.mjs
```

本次上线前代理代码备份保存在 `/tmp/venice-stream-backup.81TJwn`。测试使用目录标记免积分的网页模型，没有调用 Fable 或其他付费模型。

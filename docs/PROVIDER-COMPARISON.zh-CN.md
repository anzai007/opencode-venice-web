# ai-growth Provider #15 与 #17 模型目录对照

核对时间：2026-11-17 22:54:14，北京时间。只读查询，未修改 Provider、默认模型、模型目录或业务绑定。

## 结论

| 项目 | #15 | #17 |
| --- | --- | --- |
| 名称 | Venice AI - GLM 5.1 | Venice Web（本地订阅） |
| 来源 | Venice 官方 API | 本地网页订阅代理 |
| 模型目录 | https://api.venice.ai/api/v1/models | http://host.docker.internal:3456/v1/models |
| 文本模型数量 | 144 | 19 |
| 当前默认模型 | qwen-3-6-plus | deepseek-v4-1-flash-uncensored |
| 目录生成方式 | 实时读取官方 API | 代理内置静态清单 |

分别读取 ai-growth 业务服务 listModels 和同一配置端点的实际返回，ID 集合完全一致；没有走失败后的候选回退。官方 API 的 144 个条目均标记 offline=false。本次仅核对目录，不代表逐个推理测试成功。

按 ID 精确比较：共有 16 个相同 ID；仅 #15 有 128 个，只有 #17 有 3 个。后者是渠道命名差异，不应直接解读为 API 没有对应的同名模型。

## 同名模型的渠道 ID 差异

| 模型名称 | #15 官方 API ID | #17 网页 ID |
| --- | --- | --- |
| DeepSeek V3.2 | `deepseek-v3.2` | `deepseek-ai-DeepSeek-V3.2` |
| Gemma 4 Uncensored | `gemma-4-uncensored` | `gemma4-uncensored` |
| GLM 5.2 | `zai-org-glm-5-2` | `zai-org-glm-5.2` |

以上对照来自两边目录中的显示名称和 ID，不是对模型权重、运行配置或返回内容一致性的独立验证。

## #17 与当前网页目录的差距

已登录网页 /api/app/models 返回 130 个文本模型，其中 active=true 且 usesCredits=false 的有 30 个。#17 的 19 个 ID 全部存在于此集合，未发现失效 ID 或积分模型混入。

但仍有以下 11 个目录标记为活跃且免积分的文本模型未纳入代理。目录可见不等于已经验证代理的 ad-hoc 推理接口支持；本次没有直接补入或发起这些模型的推理请求。

| 网页显示名称 | 网页正式 ID |
| --- | --- |
| GLM 5.3 Flash | `z-ai-glm-5-3-flash` |
| GLM 5.1 | `zai-org-glm-5.1` |
| GLM 5 | `zai-org-glm-5` |
| GLM 4.7 Flash Heretic | `olafangensan-glm-4.7-flash-heretic` |
| GLM 4.7 | `zai-org-glm-4.7-app` |
| Venice Role Play Uncensored | `venice-uncensored-role-play` |
| Qwen3 VL 235B | `qwen3-vl-235b-a22b` |
| Qwen 3 Coder 480B Turbo | `qwen3-coder-480b-a35b-instruct-turbo` |
| DeepSeek V4.1 Flash (1017) | `deepseek-v4-1-flash` |
| NVIDIA Nemotron 3 Nano 30B | `nvidia-nemotron-3-nano-30b-a3b` |
| NVIDIA Nemotron 3 Ultra | `nvidia-nemotron-3-ultra-550b-a55b` |

注意：usesCredits=false 只说明网页目录的计费标记，仍受账号方案、使用限额与平台策略影响；不能据此推断官方 API 免费。

## 元数据检查

代理中 `google-gemma-4-31b-it` 的输出上限仍为 8192，当前网页目录 maxResponseTokens 为 16384；上下文均为 256000。其他 18 个现有模型的上下文与输出上限，与本次网页目录一致。

此外，ai-growth 的通用适配器未保留代理的显示名称、上下文等完整元数据，其费率和能力字段显示为未知属于当前归一化逻辑；本次未调整该逻辑。

## 全量 ID 集合对照

| 模型 ID | #15 | #17 |
| --- | --- | --- |
| `abliteration-abliterated-model-large-flash` | 有 | — |
| `abliteration-abliterated-model-large-v2` | 有 | — |
| `aion-labs-aion-3-0` | 有 | 有 |
| `aion-labs-aion-3-0-mini` | 有 | 有 |
| `aion-labs-aion-3-5` | 有 | — |
| `aion-labs-aion-3-5-mini` | 有 | — |
| `claude-fable-5` | 有 | — |
| `claude-fable-5-1` | 有 | — |
| `claude-fable-5-2` | 有 | — |
| `claude-haiku-5-5` | 有 | — |
| `claude-opus-4-5` | 有 | — |
| `claude-opus-4-6` | 有 | — |
| `claude-opus-4-7` | 有 | — |
| `claude-opus-4-8` | 有 | — |
| `claude-opus-5` | 有 | — |
| `claude-opus-5-5` | 有 | — |
| `claude-opus-5-5-fast` | 有 | — |
| `claude-opus-5-fast` | 有 | — |
| `claude-sonnet-4-6` | 有 | — |
| `claude-sonnet-5` | 有 | — |
| `claude-sonnet-5-5` | 有 | — |
| `deepseek-ai-DeepSeek-V3.2` | — | 有 |
| `deepseek-v3.2` | 有 | — |
| `deepseek-v4-1-flash` | 有 | — |
| `deepseek-v4-1-flash-1017` | 有 | — |
| `deepseek-v4-1-flash-1017-ultrafast` | 有 | — |
| `deepseek-v4-1-flash-1017-uncensored` | 有 | — |
| `deepseek-v4-1-flash-uncensored` | 有 | 有 |
| `deepseek-v4-flash` | 有 | — |
| `deepseek-v4-flash-0731` | 有 | — |
| `deepseek-v4-flash-0731-fast` | 有 | — |
| `deepseek-v4-pro` | 有 | — |
| `deepseek-v4-pro-0813` | 有 | — |
| `e2ee-deepseek-v4-1-flash-1017-abliterated` | 有 | — |
| `e2ee-deepseek-v4-flash` | 有 | — |
| `e2ee-gemma-4-26b-a4b-uncensored-p` | 有 | 有 |
| `e2ee-glm-5-2-p` | 有 | — |
| `e2ee-glm-5-3-flash` | 有 | — |
| `e2ee-glm-5-3-p` | 有 | — |
| `e2ee-gpt-oss-120b-p` | 有 | 有 |
| `e2ee-kimi-k2-6` | 有 | — |
| `e2ee-kimi-k3-1-pro-p` | 有 | — |
| `e2ee-kimi-k3-p` | 有 | — |
| `e2ee-qwen-2-5-7b-p` | 有 | 有 |
| `e2ee-qwen3-6-35b-a3b` | 有 | 有 |
| `e2ee-qwen3-8-27b` | 有 | 有 |
| `e2ee-qwen3-vl-30b-a3b-p` | 有 | 有 |
| `gemini-3-1-pro-preview` | 有 | — |
| `gemini-3-5-flash` | 有 | — |
| `gemini-3-5-flash-lite` | 有 | — |
| `gemini-3-6-flash` | 有 | — |
| `gemini-3-7-flash` | 有 | — |
| `gemini-3-8-flash` | 有 | — |
| `gemini-3-flash-preview` | 有 | — |
| `gemini-4-argon` | 有 | — |
| `gemini-4-carbon` | 有 | — |
| `gemini-4-hydrogen` | 有 | — |
| `gemma-4-uncensored` | 有 | — |
| `gemma4-uncensored` | — | 有 |
| `glm-5-3-flash-uncensored` | 有 | — |
| `google-gemma-3-27b-it` | 有 | — |
| `google-gemma-4-26b-a4b-it` | 有 | 有 |
| `google-gemma-4-31b-it` | 有 | 有 |
| `grok-4-20` | 有 | — |
| `grok-4-20-multi-agent` | 有 | — |
| `grok-4-3` | 有 | — |
| `grok-4-5` | 有 | — |
| `grok-4-6` | 有 | — |
| `grok-4-7` | 有 | — |
| `grok-build-0-1` | 有 | — |
| `hy4-preview` | 有 | — |
| `kimi-k2-5` | 有 | — |
| `kimi-k2-6` | 有 | — |
| `kimi-k2-7-code` | 有 | — |
| `kimi-k3` | 有 | — |
| `kimi-k3-1-pro` | 有 | — |
| `kimi-k3-1-pro-highspeed` | 有 | — |
| `kimi-k3-fast-api` | 有 | — |
| `llama-3.2-3b` | 有 | — |
| `llama-3.3-70b` | 有 | — |
| `minimax-m25` | 有 | — |
| `minimax-m27` | 有 | — |
| `minimax-m3-1-flash` | 有 | — |
| `minimax-m3-preview` | 有 | — |
| `mistral-small-3-2-24b-instruct` | 有 | — |
| `muse-spark-open` | 有 | — |
| `muse-wonder` | 有 | — |
| `nvidia-nemotron-3-5-super-vl-120b-a12b` | 有 | — |
| `nvidia-nemotron-3-nano-30b-a3b` | 有 | — |
| `nvidia-nemotron-3-ultra-550b-a55b` | 有 | — |
| `olafangensan-glm-4.7-flash-heretic` | 有 | — |
| `openai-gpt-4o-2024-11-20` | 有 | — |
| `openai-gpt-4o-mini-2024-07-18` | 有 | — |
| `openai-gpt-52` | 有 | — |
| `openai-gpt-53-codex` | 有 | — |
| `openai-gpt-54` | 有 | — |
| `openai-gpt-54-mini` | 有 | — |
| `openai-gpt-54-pro` | 有 | — |
| `openai-gpt-55` | 有 | — |
| `openai-gpt-55-pro` | 有 | — |
| `openai-gpt-56-luna` | 有 | — |
| `openai-gpt-56-luna-pro` | 有 | — |
| `openai-gpt-56-sol` | 有 | — |
| `openai-gpt-56-sol-pro` | 有 | — |
| `openai-gpt-56-terra` | 有 | — |
| `openai-gpt-56-terra-pro` | 有 | — |
| `openai-gpt-6-astra` | 有 | — |
| `openai-gpt-6-astra-pro` | 有 | — |
| `openai-gpt-6-luna` | 有 | — |
| `openai-gpt-6-sol` | 有 | — |
| `openai-gpt-61-sol` | 有 | — |
| `openai-gpt-61-sol-ultrafast` | 有 | — |
| `openai-gpt-61-terra` | 有 | — |
| `openai-gpt-oss-120b` | 有 | — |
| `pareto` | 有 | — |
| `qwen-3-6-plus` | 有 | — |
| `qwen-3-7-max` | 有 | — |
| `qwen-3-7-plus` | 有 | — |
| `qwen-3-8-2-4t-a95b` | 有 | — |
| `qwen-3-8-27b` | 有 | 有 |
| `qwen-3-8-flash` | 有 | — |
| `qwen-3-8-max` | 有 | — |
| `qwen-4-max` | 有 | — |
| `qwen3-235b-a22b-instruct-2507` | 有 | — |
| `qwen3-235b-a22b-thinking-2507` | 有 | — |
| `qwen3-5-35b-a3b` | 有 | 有 |
| `qwen3-5-397b-a17b` | 有 | — |
| `qwen3-6-27b` | 有 | 有 |
| `qwen3-6-35b-a3b` | 有 | — |
| `qwen3-coder-480b-a35b-instruct-turbo` | 有 | — |
| `qwen3-next-80b` | 有 | — |
| `qwen3-vl-235b-a22b` | 有 | — |
| `seed-2-1-turbo` | 有 | — |
| `venice-uncensored-1-2` | 有 | 有 |
| `venice-uncensored-role-play` | 有 | — |
| `xiaomi-mimo-v2-5` | 有 | — |
| `xiaomi-mimo-v2-6-flash` | 有 | — |
| `z-ai-glm-5-3` | 有 | — |
| `z-ai-glm-5-3-flash` | 有 | — |
| `z-ai-glm-5-turbo` | 有 | — |
| `z-ai-glm-5v-turbo` | 有 | — |
| `zai-org-glm-4.6` | 有 | 有 |
| `zai-org-glm-4.7` | 有 | — |
| `zai-org-glm-5` | 有 | — |
| `zai-org-glm-5-1` | 有 | — |
| `zai-org-glm-5-2` | 有 | — |
| `zai-org-glm-5.2` | — | 有 |

## 官方来源与复核方式

- [官方 List Models 文档](https://docs.venice.ai/api-reference/endpoint/models/list)：不传 type 默认返回文本模型，type=all 才返回全部类型。
- [官方模型端点](https://api.venice.ai/api/v1/models)：本次在 ai-growth 后端容器中使用 #15 已配置凭据读取。
- 网页端点 `https://outerface.venice.ai/api/app/models`：使用用户已授权的现有网页会话读取，仅提取模型元数据，未保存 Cookie 或 JWT。
- 复核时在 ai-growth Provider 管理中分别选择 #15、#17，读取模型列表；或在后端 Docker 容器调用 `AiProviderService::listModels(15)`、`AiProviderService::listModels(17)`。数量会随官方目录变化。

建议保持官方 API 与网页订阅两条目录分开管理；后续补齐 #17 时先验证新增模型的代理推理兼容性，再同步目录和元数据。

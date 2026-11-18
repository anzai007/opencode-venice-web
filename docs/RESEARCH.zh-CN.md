# Venice 网页转 API 可行性调研

调研日期：2026-11-17。审查版本：`0.1.4`，提交 `6928f8a231931f10bda63c31e6a24ad14fcbeb72`。

## 结论

技术上可以。该仓库已经实现网页会话到 OpenAI 兼容 HTTP 接口的转换，无需从零开发。但当前结论基于源码、本地测试和官方资料，尚未使用真实 Venice 账号验证上游可用性、扣费情况或持续运行稳定性。

该方案不等于官方 API，也不意味着订阅可以获得官方无限 API 额度。Venice 当前服务条款第 12(d) 条明确禁止通过非官方脚本、代理等自动化机制调用网页服务，并说明可能暂停或终止账号。因此不建议以它作为长期生产服务或对外商业 API 的基础。

## 实现路径与证据

```text
OpenAI 兼容客户端
    → 本地代理 http://127.0.0.1:3456/v1
    → Clerk 网页会话 JWT + 客户端证明令牌
    → outerface.venice.ai 网页推理接口
    → 转换为 OpenAI JSON / SSE 返回
```

- 登录入口：`src/login.mjs`。读取或接收用户自己的 Clerk `__client` Cookie，验证活跃会话，保存到权限为 `0600` 的会话文件。
- 会话维护：`src/lib/venice.mjs:146`。刷新短期 JWT、合并并发刷新请求、保存轮换 Cookie。
- 客户端证明：`src/lib/venice.mjs:188`。调用 `/api/app/user/client_attestation/mint`，缓存令牌。
- 聊天上游：`src/lib/venice.mjs:25`、`:220`。调用 `/api/inference/chat/agents/ad-hoc`，支持图片 multipart 输入，401 时刷新令牌重试一次。
- HTTP 适配：`src/lib/server.mjs:616`。已注册模型、聊天、图片和会话重载路由。
- 工具适配：`src/lib/emulate.mjs:432`。将工具定义写入提示词；发给上游的 `tools`、`clientTools` 均为空，再解析模型输出生成 `tool_calls`。

## 已实现范围

| 能力 | 实现状态与限制 |
| --- | --- |
| `GET /v1/models` | 已实现；静态配置了 19 个聊天模型，并非实时探测结果 |
| `POST /v1/chat/completions` | 已实现流式与非流式输出 |
| 多轮聊天、系统提示词 | 转换客户端传入历史与指令后发送上游 |
| 图片理解 | 支持请求内的图片数据；不下载远程图片 URL，只发送最新用户消息关联的图片 |
| 工具调用 | 通过提示词、JSON 解析、重试和评判模型模拟；不等于原生函数调用 |
| `POST /v1/images/generations` | 已实现；通过 Venice 自有代理工具生成图片 |
| `POST /v1/images/edits` | 已实现；支持图片上传，暂不支持 mask |
| `temperature`、`top_p`、`max_tokens` | 请求转换代码没有转发这些参数，无法保证生效 |
| `usage` | 本地估算 token 数量，不是上游精确计量 |
| Responses、embeddings、音频、视频 | 当前路由未实现 |

带工具请求会先缓冲正文，解析完成后再输出；推理内容仍可实时转发。因此不能把所有流式行为都理解为逐 token 透传。

## 部署和可靠性判断

- 运行需要 Node.js 22+ 和系统 curl，无 npm 运行时依赖。自动提取浏览器 Cookie 主要面向 macOS/Linux 的 Chromium 系浏览器。
- 默认绑定回环地址，适合本地调用。服务端没有入口 API Key 校验、账户隔离或配额管理；直接绑定公网会把账号调用能力暴露给能访问端口的人。
- 当前实现使用一个会话文件和进程内缓存，不是多账号服务架构。
- 网页接口、Clerk 版本参数和前端版本头存在版本依赖；Cloudflare 挑战、会话撤销、接口变更都可能使调用失效。使用 curl 不构成持续可用保证。
- 模型目录为人工维护的白名单。作者将其描述为网页免积分模型，但本次没有抓取已登录目录，也没有进行调用前后余额对比，不能独立保证模型路由或零扣费。
- Pro 网页不限次文字提示与 API 积分计费是不同权益；官方价格页同时列出了高级模型消耗积分。不能将“无限网页文字”理解为任意模型、任意并发均免费。

## 本次验证

1. 拉取仓库并审查认证、上游请求、协议转换、模型目录和 HTTP 路由实现；未修改业务代码、未运行安装器、未读取浏览器 Cookie。
2. 在 Node.js `v25.9.0` 运行 `npm test`：测试框架报告 127 项通过、0 失败。其中 `test/smoke.mjs` 因未启动已登录代理而自行跳过真实调用并成功退出，所以这个数字不代表真实上游验证通过。
3. 使用隔离配置目录和临时本地端口启动 HTTP handler：`/health` 返回 `ok:false`，未登录状态下 `/v1/models` 返回 19 个模型；入口无需 Authorization。
4. 尚未验证真实聊天、图片生成、工具调用成功率、长时间运行、并发上限以及账号余额变化。

## 建议

若目标是了解网页转 API 的实现，该仓库已经提供完整原型，核心工作是认证维护和协议转换。若目标是稳定接入应用，优先使用 Venice 官方 OpenAI 兼容 API：`https://api.venice.ai/api/v1`，以官方 API Key 鉴权并按账户额度计费。

若继续评估该原型，下一阶段需要在明确获得账号授权且确认平台允许的前提下，验证真实上游调用、会话生命周期、模型与扣费情况；目前不能据本报告宣称线上已经跑通。

## 外部来源

- [项目仓库](https://github.com/CanArslanDev/opencode-venice-web)
- [本次审查提交](https://github.com/CanArslanDev/opencode-venice-web/tree/6928f8a231931f10bda63c31e6a24ad14fcbeb72)
- [Venice 官方快速开始](https://docs.venice.ai/getting-started/quick-start)
- [Venice 官方价格与订阅权益](https://venice.ai/pricing)
- [Venice 服务条款，第 12(d) 条；页面标注更新于 2026-06-08](https://venice.ai/legal/tos)

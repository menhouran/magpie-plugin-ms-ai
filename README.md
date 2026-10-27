# magpie-plugin-ms-ai

魔搭国际站（modelscope.ai）API-Inference 的 magpie / OpenCode 供应商插件：注册 `modelscope-ai` 供应商，提供模型列表与推理，并处理每日魔粒签到与余额显示。

## 功能

- **供应商注册**：`modelscope-ai`，`@ai-sdk/openai-compatible`，`https://api-inference.modelscope.ai/v1`。用户已自定义的 provider 配置不会被覆盖。
- **模型**：登录后从 `GET /v1/models` 拉取账号可见的全部模型，不做筛选；未登录或拉取失败时使用实测可用的内置列表。
- **推理**：以账号令牌添加 `Authorization: Bearer` 转发。上游响应（400/401/402/403/429 等）原样返回，故障转移交给 magpie。
- **每日签到**：magpie 每账号每北京日调用一次 `GET /api/v1/users/login/info`，该请求本身触发当日魔粒发放（服务端幂等）。插件在签到前后读取魔粒账单（`/openapi/v1/magicubes/transactions`）校验结果：今日已有 `daily_active` / `aliyun_bindlogin` 记录返回 `done` 并上报到账魔粒数；新到账返回 `claimed`。
- **余额与积分窗口**：`GET /openapi/v1/magicubes/balance` 读取 `available_balance` / `total_balance`，以「已用 / 总量」积分窗口显示。余额耗尽时窗口报 100% 并给出次日发放时间，magpie 会将该账号停用到该时刻，签到发放后自动恢复。
- **账号显示名**：签到成功后把 `login/info` 的昵称写回账号（`client.auth.set`），多账号不再显示为 `API key …xxxx`。

## 内置模型

未登录或拉取失败时的兜底，均为国际站实测可调用：

| 模型 | 上下文 | 输出 |
| --- | --- | --- |
| deepseek-ai/DeepSeek-V4.1-Flash-1017 | 1,048,576 | 393,216 |
| zai-org/GLM-5.2 | 1,048,576 | 131,072 |
| nex-agi/Nex-N2.5-Pro | 262,144 | 235,929 |

`/v1/models` 列出的模型并非都可用：`Qwen-Ambassador/*` 返回 403（账号无权限），部分条目返回 400「has no provider supported」。使用前可用 `magpie provider test modelscope-ai <model>` 验证。

## 安装

在线（GitHub）：

```sh
magpie plugin add menhouran/magpie-plugin-ms-ai
magpie plugin login modelscope-ai
magpie quota
```

本地文件夹：`magpie plugin add ./magpie-ModelScope-ai`（路径按实际情况替换）。

## 登录

粘贴账号在 [modelscope.ai](https://www.modelscope.ai) 个人中心生成的 `ms-` 访问令牌。同一令牌用于两处：

- 推理请求：`Authorization: Bearer <token>`
- 网页接口（签到 / 账单 / 余额）：`Cookie: m_session_id=<token>`

令牌保存在 magpie 的 `plugin-auth.json`，插件不做服务端校验；401/403 会把账号标记为需要重新登录。

## 行为说明

- 余额读取按账号缓存 10 分钟；收到 429 时每分钟最多复读一次余额，用于区分限流与魔粒耗尽；402 立即失效缓存。
- 推理响应的登录判定显式上报：401 标记登录过期（令牌被拒）；402（余额）、403（模型无权限）、429（网关闭流）标记为 kept，不误伤账号。网关不提供 Retry-After，退避完全由 magpie 处理。
- 签到节奏由 magpie 调度：每账号每北京日一次，失败 30 分钟后自动重试；插件内不做额外节流。
- 魔粒每日发放后 24 小时滚动过期，不累积。
- 协议转换、故障转移、代理与限流退避均由 magpie 负责，插件不实现代理逻辑。

## 开发

```sh
bun test
```

测试通过本地 fake server 覆盖信封双大小写、签到结果（含账单校验）、余额窗口、模型拉取与回退，运行时不访问外部网络。入口、测试与 fake server 均为 TypeScript，Bun 直接加载，无需构建步骤。

## 范围

只做插件内动作：签到触发、账单与余额查询、推理转发。不包含注册自动化、账号密码登录流或社区互动自动化。

## License

MIT
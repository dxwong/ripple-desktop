# BUG-001: MiniMax M3 切换后 401(1004) 鉴权失败

> 排查日期：2026-06-04
> 影响范围：桌面端使用 `minimax` Provider
> 问题现象：聊天中切换到 MiniMax M3 模型后，每次请求均返回 `401 login fail: Please carry the API secret key in the 'Authorization' field of the request header (1004)`

---

## 一、问题描述

桌面端模型下拉框中选择 `MiniMax M3 · MiniMax` 后发送消息，后端持续返回 401 鉴权错误，伴随前端显示"大模型返回异常（几乎无内容），疑似 API 故障"。

## 二、根因（一句话）

**桌面端 `minimax` Provider 的 `defaultBaseUrl` 与后端 `@ripple/ai` 模型注册表中该模型的 `baseUrl` 不一致**，且后端 `resolveModel` 会用前端传错的 URL **覆盖**注册表中的正确 URL。

### 2.1 证据对比

| 位置 | 声明的协议 | baseUrl |
|------|-----------|---------|
| 桌面 UI `providers.ts:57` | `OpenAI 兼容` | `https://api.minimax.chat/v1` ❌ |
| 引擎注册表 `models.generated.ts:6026` | `anthropic-messages` | `https://api.minimax.io/anthropic` ✅ |

### 2.2 错误传递路径

```
① 用户下拉选 minimax::MiniMax-M3
    → MainApp.tsx:514 调 setActiveProvider("minimax", "MiniMax-M3")

② useSettings.ts:516 计算 activeConfig.endpoint
    → cfg?.baseUrl || KNOWN_PROVIDERS[minimax].defaultBaseUrl
    → 命中桌面错值: https://api.minimax.chat/v1   ← ❌

③ useStreamingChat.ts:672 发送到 /api/chat
    → body: { endpoint: "https://api.minimax.chat/v1", ... }

④ 后端 index.ts:298 resolveModel
    → 命中注册表 minimax/MiniMax-M3 (api: anthropic-messages)
    → return { ...aiModel, baseUrl: "https://api.minimax.chat/v1" }
    → 注册表 baseUrl 被覆盖 ❌

⑤ Anthropic SDK (anthropic.ts:864) 用错的 baseURL 发请求
    → POST https://api.minimax.chat/v1/v1/messages
    → 鉴权头: x-api-key: <key> (Anthropic 风格)
    → MiniMax 服务器期望: Authorization: Bearer <key>

⑥ MiniMax 返回 401(1004)
    → 后端 index.ts:2080 近空回复检测触发"大模型返回异常"提示
```

### 2.3 架构根因

**双真相源漂移**：
- `@ripple/ai`（引擎）持有模型真实定义（api、baseUrl），是权威方
- `ripple-shared/providers.ts`（桌面）手抄了一份 UI 元数据，内含 duplicate 的 `defaultBaseUrl` 和 `apiType`
- 两边各自演进无校验：引擎改 baseUrl → 桌面漏同步 → 401

---

## 三、涉及代码位置

| # | 文件 | 行 | 说明 | 类型 |
|---|------|----|------|------|
| 1 | `packages/ripple-shared/src/providers.ts` | 57 | `minimax` 的 `defaultBaseUrl` 是错的 `https://api.minimax.chat/v1` | 数据源（错） |
| 2 | `agent/packages/ai/src/models.generated.ts` | 6026-6042 | `minimax` 下 `MiniMax-M3` 的 `baseUrl` 是 `https://api.minimax.io/anthropic` | 数据源（对） |
| 3 | `agent/packages/server/src/index.ts` | 286-314 | `resolveModel` 命中注册表后会用用户 endpoint **覆盖** `baseUrl` | 行为（帮倒忙） |
| 4 | `apps/ripple-desktop/src/hooks/useSettings.ts` | 512-525 | `activeConfig.endpoint` 的 fallback 逻辑用了双源 | 集成点 |
| 5 | `agent/packages/server/src/index.ts` | 2913-2968 | `test-connection` 不识 `minimax`，走了 OpenAI 兼容分支 | 一致性 |
| 6 | `apps/ripple-desktop/src/components/MainApp.tsx` | 455-509 | `modelEntries` 构造依赖 `KNOWN_PROVIDER_MODELS` | 数据流 |

---

## 四、PM2 日志佐证

```log
[2026-06-04T10:25:06.194Z] [WARN] [CHAT] 模型返回异常 |
{"sessionId":"chat-mpzclvy2-ryf",
 "errorMessage":"401 login fail: Please carry the API secret key
                  in the 'Authorization' field of the request header (1004)"}
```

同会话共 4 次 401 错误（2 轮 × 2 次自动重试），均为此模式。

历史日志中还出现过另一种 401：
```log
[2026-06-03T21:29:05.245Z] [WARN] [CHAT] 模型返回异常 |
 "errorMessage":"401 ... login fail: Please carry the API secret key
                  in the 'X-Api-Key' field of the request header ..."
```

说明：MiniMax 国际版同时暴露两种端点（OpenAI 兼容和 anthropic 兼容），请求落到哪一个取决于前端传的 URL。桌面用错的 URL（`api.minimax.chat/v1`），但 `@ripple/ai` 注册表标记该模型走 anthropic 协议（发 `x-api-key` 头），所以总是有一个鉴权头对不上。

--- 

## 五、三层修复方案

### 第 1 层（服务端兜底）—— 立即修

**`agent/packages/server/src/index.ts:286-314` `resolveModel`**

命中注册表的内置模型时，`baseUrl` **以注册表为准**，不再用用户传的 `endpoint` 覆盖。用户 endpoint 仅打 WARN 日志。自定义 provider（非内置）不受影响。

### 第 2 层（客户端数据源）—— 防复发

- 扩展 `/api/models` 端点，返回每个模型的 `baseUrl`（目前漏了这个字段）
- 扩展 `/api/providers` 端点，返回各 provider 的 `defaultBaseUrl`（从注册表派生）
- 桌面新增 `useProvidersMetadata` hook：启动时拉取一次服务端元数据
- `activeConfig.endpoint` 改为三级 fallback：
  ```
  本地自定义 baseUrl > 服务端注册表默认 > 桌面本地 hardcode（最终兜底）
  ```
- 已知坏默认迁移表（`useSettings` init 流程）：
  ```ts
  const KNOWN_BAD_DEFAULTS = {
    minimax: 'https://api.minimax.chat/v1',
    // 后续发现的新漂移加在这里
  };
  ```

### 第 3 层（CI 卡口）—— 防回归

`agent/scripts/check-drift.ts` 扫描 `providers.ts` 中是否出现 `defaultBaseUrl:` 字段，有则 fail。挂到 `pnpm test`。

---

## 六、验证 checklist

- [ ] 切换 `minimax::MiniMax-M3` 发消息，PM2 日志不再出现 `401 (1004)`
- [ ] `GET /api/models` 返回的模型含 `baseUrl` 字段
- [ ] 桌面启动后 `modelEntries` 正常渲染 minimax 模型
- [ ] 旧用户 `localStorage` 中 `providerConfigs.minimax.baseUrl = "https://api.minimax.chat/v1"` 被自动清空
- [ ] test-connection 对 minimax 走 anthropic 协议分支
- [ ] deepseek / anthropic / openai 等其他 provider 不受影响
- [ ] `check-drift.ts` 能检测到 `defaultBaseUrl:` 字段并 fail
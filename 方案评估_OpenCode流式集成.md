# OpenCode 流式集成 — 问题与修正方案

## 当前做法

项目对话中使用 OpenCode Agent 时，通过 Python 桥接调用 `opencode run --model xxx "用户消息"`，将 CLI 的 stdout 输出转发到前端 UI。

## 问题

`opencode run` 不是逐 token 流式输出。实际行为：

```
用户发送消息
  → 0-3 秒: 输出 "> build · xxx"（构建横幅）
  → 3-25 秒: 完全静默，无任何输出
  → 25-30 秒: 一次性输出完整 AI 回答
```

前端体验：发送后转圈 20 多秒无反应，然后内容突然全部出现。用户无法区分是"正在处理"还是"卡死了"。

## 根因

经验证：**`opencode run` 命令本身不支持逐 token 流式输出。**

无论是直接在终端跑、通过管道跑、还是加 `--format json` 参数，行为都一样——构建后静默处理，然后一次性输出。

而 `opencode` 默认的交互模式（直接 `opencode` 回车进入 TUI）是真正流式的，但那是交互式终端 UI，不适合程序化调用。

## 修正方案

放弃 `opencode run`，改用 **`opencode serve`** 启动 headless HTTP 服务，通过 SSE（Server-Sent Events）获取实时流式回复。

### 架构变化

```
改前:
  用户输入 → IPC → Rust → Python桥接
    → subprocess opencode run --model xxx "消息"
    → 等进程结束 → 一次性拿全部 stdout → 转发到前端

改后:
  用户输入 → IPC → Rust → Python桥接
    → HTTP POST http://127.0.0.1:4096 （opencode serve）
    → SSE 逐 token 返回 → 逐行转发到前端
```

### 需要做的事

1. **桥接启动时自动拉起 `opencode serve --port 4096`**（后台常驻进程）
2. **发消息改为 HTTP 请求 + SSE 流式读取**
3. **管理 serve 进程生命周期**：启动、健康检查、异常重启、退出清理
4. **处理并发**：多个请求时的队列或会话管理

### 风险

- `opencode serve` 是否支持 SSE 流式需先验证（命令存在，但实际行为未测）
- 如果 serve 模式也不支持流式，则需要其他方案（如直接调 AI API）

### 验证步骤

步骤 1：先手动测试 `opencode serve` 的流式能力

```bash
# 终端 1：启动服务
opencode serve --port 4096

# 终端 2：发请求看返回格式
curl -X POST http://127.0.0.1:4096/... -d '{"message":"hi"}'
```

步骤 2：如果确认 SSE 可用，再修改桥接代码对接。

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

`opencode run` 命令本身不支持逐 token 流式。无论是直接在终端跑、通过管道跑、还是加 `--format json` 参数，行为都一样——构建后静默处理，一次性输出。

## 修正方案

改用 **`opencode serve`** 启动 headless HTTP 服务，通过 SSE（Server-Sent Events）获取实时流式回复。

### 架构变化

```
改前:
  用户输入 → IPC → Rust → Python桥接
    → subprocess opencode run --model xxx "消息"
    → 等进程结束 → 一次性拿全部 stdout → 转发到前端

改后:
  用户输入 → IPC → Rust → Python桥接
    → 桥接启动时: opencode serve --port 4096（后台常驻）
    → POST /session 创建会话
    → POST /session/{id}/message 发消息
    → 响应体是 text/event-stream（SSE 逐 token 流）
    → 解析 SSE 事件 → 逐 token 转发到前端
```

### API 接口（已验证）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/global/health` | GET | 健康检查，返回 `{"healthy": true}` |
| `/session` | POST | 创建会话，返回 `{"id": "ses_xxx"}` |
| `/session/{id}/message` | POST | 发送消息，返回 `Content-Type: text/event-stream`（SSE 流） |
| `/event` | GET | SSE 事件订阅 |

SSE 事件格式：
```
event: message.part.delta
data: {"id":"...","part":{"content":"逐token内容"}}
```

### 桥接改造要点

1. **服务生命周期管理**：桥接启动时自动 `opencode serve --port 4096`，退出时关闭
2. **会话管理**：创建会话、复用或轮换
3. **SSE 解析**：从 HTTP 响应 body 中逐行读取 SSE 事件，提取 `part.content`
4. **依赖**：Python 桥接需加 `aiohttp`，或用 Rust 的 `opencode-sdk` crate

### Python 核心代码示意

```python
class OpenCodeBridge:
    async def start_server(self):
        """启动 opencode serve 后台进程"""
        subprocess.Popen(["opencode", "serve", "--port", "4096"])
        # 等待 /global/health 返回 healthy

    async def create_session(self) -> str:
        """POST /session → 返回 sessionId"""
        async with session.post(f"{base_url}/session") as resp:
            data = await resp.json()
            return data["id"]

    async def send_message_stream(self, session_id: str, text: str):
        """POST /session/{id}/message → 逐 token yield"""
        async with session.post(
            f"{base_url}/session/{session_id}/message",
            json={"parts": [{"type": "text", "text": text}]}
        ) as resp:
            async for chunk in resp.content:
                # 解析 SSE data: 行
                token = extract_part_content(chunk)
                if token:
                    yield token
```

### 风险

- 需要验证多轮对话的 session 复用行为
- 需要处理 serve 进程的异常退出和重启

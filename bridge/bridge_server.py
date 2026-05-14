#!/usr/bin/env python3
"""
Ripple Desktop Bridge Server
Python WebSocket 桥接服务，通过 WebSocket 接收 Tauri 后端的请求，
调用 OpenCode CLI 执行代码开发任务，并返回结果。

协议格式（JSON）：
- 请求:  {"id": "msg_id", "type": "request_type", "data": {...}}
- 响应:  {"id": "msg_id", "type": "response", "status": "ok|error", "data": {...}}
"""

import asyncio
import json
import logging
import os
import re
import subprocess
import sys
import time
from pathlib import Path

try:
    import websockets
except ImportError:
    print("请先安装依赖: pip install -r requirements.txt")
    sys.exit(1)

try:
    import aiohttp
except ImportError:
    print("请先安装依赖: pip install -r requirements.txt")
    sys.exit(1)

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format="[Bridge] %(asctime)s %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

HOST = "127.0.0.1"
PORT = 9876
OPENCODE_CMD = "opencode"  # OpenCode CLI 命令


# ==================== OpenCode 配置读取 ====================

def find_opencode_config() -> dict:
    """
    查找 OpenCode CLI 的配置文件，返回解析后的 JSON 内容。
    搜索路径（按优先级）：
    1. Windows: %APPDATA%/opencode/config.json
    2. Linux/Mac: ~/.config/opencode/config.json
    3. ~/.opencode/config.json
    """
    search_paths = []

    # Windows
    if os.name == "nt":
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            search_paths.append(Path(appdata) / "opencode" / "config.json")
        userprofile = os.environ.get("USERPROFILE", "")
        if userprofile:
            search_paths.append(Path(userprofile) / ".config" / "opencode" / "config.json")
    else:
        # Linux/Mac
        home = Path.home()
        search_paths.append(home / ".config" / "opencode" / "config.json")
        search_paths.append(home / ".opencode" / "config.json")

    for config_path in search_paths:
        if config_path.exists():
            try:
                content = config_path.read_text(encoding="utf-8")
                return json.loads(content)
            except Exception as e:
                logger.warning(f"读取配置文件失败 {config_path}: {e}")

    return {}


def get_opencode_models(config: dict = None) -> list[dict]:
    """
    从 OpenCode 配置中提取可用的模型列表。
    返回: [{"name": "gpt-4o", "provider": "openai", ...}, ...]
    """
    if config is None:
        config = find_opencode_config()

    models = []

    # OpenCode 配置结构通常为:
    # { "providers": { "openai": { "models": { "gpt-4o": { ... } } } } }
    # 或 { "models": [ { "name": "...", "provider": "..." } ] }

    providers = config.get("providers", {})
    for provider_name, provider_cfg in providers.items():
        provider_models = provider_cfg.get("models", {})
        if isinstance(provider_models, dict):
            for model_name, model_cfg in provider_models.items():
                models.append({
                    "name": model_name,
                    "provider": provider_name,
                    **({k: v for k, v in model_cfg.items() if isinstance(v, (str, int, float, bool))}
                       if isinstance(model_cfg, dict) else {}),
                })
        elif isinstance(provider_models, list):
            for m in provider_models:
                if isinstance(m, dict) and "name" in m:
                    models.append({**m, "provider": provider_name})

    # 另一种格式: 直接在顶层有 models 列表
    top_models = config.get("models", [])
    if isinstance(top_models, list):
        for m in top_models:
            if isinstance(m, dict) and "name" in m:
                if not any(existing["name"] == m["name"] for existing in models):
                    models.append(m)

    return models


# ==================== OpenCode Serve 管理 ====================

class OpenCodeBridge:
    """管理 opencode serve 进程 + SSE 流式通信"""

    def __init__(self, port: int = 4096, host: str = "127.0.0.1"):
        self.port = port
        self.host = host
        self.base_url = f"http://{host}:{port}"
        self._server_process: subprocess.Popen | None = None
        self._session_id: str | None = None

    # ---------- 服务生命周期 ----------

    async def ensure_server(self) -> bool:
        """确保 serve 服务运行，未运行则启动"""
        if await self._health_check():
            return True

        logger.info(f"启动 opencode serve :{self.port}...")
        self._server_process = subprocess.Popen(
            ["opencode", "serve", "--port", str(self.port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        for _ in range(20):
            await asyncio.sleep(0.5)
            if await self._health_check():
                logger.info("opencode serve 就绪")
                return True

        logger.error("opencode serve 启动失败")
        return False

    async def _health_check(self) -> bool:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{self.base_url}/global/health", timeout=2) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        return data.get("healthy", False)
        except Exception:
            return False

    async def shutdown(self):
        """关闭 serve 进程"""
        if self._server_process:
            logger.info("关闭 opencode serve...")
            self._server_process.terminate()
            try:
                self._server_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._server_process.kill()
            self._server_process = None

    # ---------- 会话管理 ----------

    async def get_or_create_session(self) -> str:
        if self._session_id:
            return self._session_id
        return await self.create_session()

    async def create_session(self) -> str:
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{self.base_url}/session") as resp:
                if resp.status != 200:
                    raise Exception(f"创建会话失败: {await resp.text()}")
                data = await resp.json()
                self._session_id = data["id"]
                logger.info(f"Session: {self._session_id}")
                return self._session_id

    async def clear_session(self):
        self._session_id = None

    # ---------- 核心：SSE 流式消息 ----------

    async def send_message_stream(self, message: str, msg_id: str, websocket):
        """
        发送消息并通过 WebSocket 逐 token 转发 SSE 流。
        使用行缓冲 + \n\n 事件分隔符解析，处理跨 chunk 边界。
        """
        if not await self.ensure_server():
            await send_response(websocket, msg_id, "error", {"error": "opencode serve 服务不可用"})
            return

        session_id = await self.get_or_create_session()
        logger.info(f"发送消息: {message[:60]}...")

        async with aiohttp.ClientSession() as session:
            payload = {"parts": [{"type": "text", "text": message}]}

            async with session.post(
                f"{self.base_url}/session/{session_id}/message",
                json=payload,
                timeout=aiohttp.ClientTimeout(total=300),
            ) as resp:
                if resp.status != 200:
                    error = await resp.text()
                    await send_response(websocket, msg_id, "error", {"error": f"发送消息失败: {error}"})
                    return

                # SSE 流式解析：行缓冲 + \n\n 事件分隔
                logger.info("SSE 连接建立，开始读取流...")
                buffer = ""
                token_count = 0
                chunk_count = 0

                async for chunk, end_of_content in resp.content.iter_chunks():
                    chunk_count += 1
                    if not chunk:
                        if end_of_content:
                            logger.info(f"SSE 流结束（共 {chunk_count} 个 chunk, {token_count} 个 token）")
                        continue

                    text = chunk.decode("utf-8", errors="replace")
                    buffer += text

                    while "\n\n" in buffer:
                        event_block, buffer = buffer.split("\n\n", 1)
                        event_type, content = self._parse_sse_event(event_block)
                        if event_type == "message.part.delta" and content:
                            token_count += 1
                            await send_response(websocket, msg_id, "stream", {"chunk": content})

                # 处理剩余 buffer
                if buffer.strip():
                    event_type, content = self._parse_sse_event(buffer)
                    if event_type == "message.part.delta" and content:
                        token_count += 1
                        await send_response(websocket, msg_id, "stream", {"chunk": content})

                logger.info(f"SSE 流读取完毕，共 {chunk_count} 个 chunk, {token_count} 个 token")

    def _parse_sse_event(self, event_block: str) -> tuple[str | None, str | None]:
        """解析单个 SSE 事件块，返回 (event_type, content_text)"""
        lines = event_block.strip().split("\n")
        event_type = None
        data = None

        for line in lines:
            if line.startswith("event:"):
                event_type = line[6:].strip()
            elif line.startswith("data:"):
                try:
                    data = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    pass

        if event_type == "message.part.delta" and data:
            part = data.get("part", {})
            content = part.get("content") if isinstance(part, dict) else None
            if content:
                return (event_type, content)

        return (event_type, None)


# 全局桥接实例
opencode_bridge = OpenCodeBridge()


# ==================== CLI 执行 ====================

async def execute_opencode(command: str, model: str = None, timeout: int = 300) -> dict:
    """
    执行 OpenCode CLI 命令（非流式，等待完成后返回）

    Args:
        command: 要执行的命令字符串
        model: 指定使用的模型名称（对应 --model 参数）
        timeout: 超时时间（秒）

    Returns:
        {"stdout": "...", "stderr": "...", "returncode": 0}
    """
    try:
        # 构建命令: opencode run [--model <name>] "<command>"
        # 命令内容需要用引号包围，防止被解析为路径
        cmd_parts = [OPENCODE_CMD, "run"]
        if model:
            cmd_parts.extend(["--model", model])
        # 用双引号包围命令内容，处理空格和特殊字符
        cmd_parts.append(f'"{command}"')
        cmd_str = " ".join(cmd_parts)

        logger.info(f"执行: {cmd_str}")

        proc = await asyncio.create_subprocess_shell(
            cmd_str,
            stdin=subprocess.DEVNULL,  # 关闭 stdin，防止 CLI 进入交互模式等待输入
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
            return {
                "stdout": stdout.decode("utf-8", errors="replace"),
                "stderr": stderr.decode("utf-8", errors="replace"),
                "returncode": proc.returncode or 0,
            }
        except asyncio.TimeoutError:
            proc.kill()
            return {
                "stdout": "",
                "stderr": f"命令执行超时（{timeout}秒）",
                "returncode": -1,
            }
    except FileNotFoundError:
        return {
            "stdout": "",
            "stderr": f"未找到 OpenCode CLI，请确保 '{OPENCODE_CMD}' 已安装且在 PATH 中",
            "returncode": -1,
        }
    except Exception as e:
        return {
            "stdout": "",
            "stderr": f"执行命令异常: {str(e)}",
            "returncode": -1,
        }


def _strip_ansi(text: str) -> str:
    """去除 ANSI 转义码"""
    return re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', text)


def _is_shell_line(line: str) -> bool:
    """判断是否是 shell 命令提示行（如 $ echo xxx）"""
    stripped = line.strip()
    if stripped.startswith("$ "):
        return True
    if stripped.startswith(">"):
        return True
    # PowerShell 错误行
    if ("CategoryInfo" in stripped or "FullyQualifiedErrorId" in stripped
        or "+" in stripped and "~" in stripped):
        return True
    return False


async def execute_opencode_streaming(websocket, msg_id: str, command: str, model: str = None, timeout: int = 300):
    """
    通过 opencode serve HTTP API + SSE 流式执行 OpenCode 命令。
    逐 token 转发到前端，实现实时流式显示。
    
    Args:
        websocket: WebSocket 连接对象
        msg_id: 消息 ID
        command: 要执行的命令字符串
        model: 指定使用的模型名称（用于 serve 的模型选择，暂不生效）
        timeout: 超时时间（秒）
    """
    try:
        await opencode_bridge.send_message_stream(command, msg_id, websocket)
        # 流结束，发送 ok
        await send_response(websocket, msg_id, "ok", {"stdout": "", "returncode": 0})

    except asyncio.TimeoutError:
        logger.warning(f"SSE 流超时 ({timeout}s)")
        await send_response(websocket, msg_id, "error", {"error": f"SSE 流超时（{timeout}秒）"})
    except FileNotFoundError:
        logger.error("未找到 OpenCode CLI")
        await send_response(websocket, msg_id, "error", {"error": f"未找到 OpenCode CLI，请确保 '{OPENCODE_CMD}' 已安装在 PATH 中"})
    except Exception as e:
        logger.error(f"SSE 流异常: {e}")
        await send_response(websocket, msg_id, "error", {"error": f"SSE 流异常: {str(e)}"})


async def execute_shell(command: str, timeout: int = 60) -> dict:
    """执行普通 shell 命令"""
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
            return {
                "stdout": stdout.decode("utf-8", errors="replace"),
                "stderr": stderr.decode("utf-8", errors="replace"),
                "returncode": proc.returncode or 0,
            }
        except asyncio.TimeoutError:
            proc.kill()
            return {
                "stdout": "",
                "stderr": f"命令执行超时（{timeout}秒）",
                "returncode": -1,
            }
    except Exception as e:
        return {"stdout": "", "stderr": f"执行异常: {str(e)}", "returncode": -1}


# ==================== 消息处理 ====================

async def handle_message(websocket, message: dict) -> None:
    """处理收到的消息"""
    msg_id = message.get("id", "unknown")
    msg_type = message.get("type", "")
    data = message.get("data", {})

    logger.info(f"收到消息 [{msg_id}]: type={msg_type}")

    if msg_type == "ping":
        await send_response(websocket, msg_id, "ok", {"pong": time.time()})

    elif msg_type == "execute_opencode":
        command = data.get("command", "")
        if not command:
            await send_response(websocket, msg_id, "error", {"error": "缺少 command 参数"})
            return
        model = data.get("model", None)  # 可选: 指定模型
        logger.info(f"执行 OpenCode: {command}" + (f" (model={model})" if model else ""))
        result = await execute_opencode(command, model=model)
        await send_response(websocket, msg_id, "ok", result)

    elif msg_type == "execute_opencode_streaming":
        command = data.get("command", "")
        if not command:
            await send_response(websocket, msg_id, "error", {"error": "缺少 command 参数"})
            return
        model = data.get("model", None)  # 可选: 指定模型
        logger.info(f"执行 OpenCode（流式）: {command}" + (f" (model={model})" if model else ""))
        # 流式执行不需要 await，直接启动协程
        asyncio.create_task(execute_opencode_streaming(websocket, msg_id, command, model=model))

    elif msg_type == "get_opencode_config":
        """获取 OpenCode 配置（含可用模型列表）"""
        config = find_opencode_config()
        models = get_opencode_models(config)
        await send_response(websocket, msg_id, "ok", {
            "models": models,
            "config": config,
        })

    elif msg_type == "execute_shell":
        command = data.get("command", "")
        if not command:
            await send_response(websocket, msg_id, "error", {"error": "缺少 command 参数"})
            return
        logger.info(f"执行 Shell: {command}")
        result = await execute_shell(command)
        await send_response(websocket, msg_id, "ok", result)

    elif msg_type == "read_file":
        path = data.get("path", "")
        try:
            content = Path(path).read_text(encoding="utf-8")
            await send_response(websocket, msg_id, "ok", {"path": path, "content": content})
        except Exception as e:
            await send_response(websocket, msg_id, "error", {"error": str(e)})

    elif msg_type == "write_file":
        path = data.get("path", "")
        content = data.get("content", "")
        try:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_text(content, encoding="utf-8")
            await send_response(websocket, msg_id, "ok", {"path": path, "written": True})
        except Exception as e:
            await send_response(websocket, msg_id, "error", {"error": str(e)})

    elif msg_type == "list_dir":
        path = data.get("path", ".")
        try:
            p = Path(path)
            entries = []
            for entry in p.iterdir():
                entries.append({
                    "name": entry.name,
                    "is_dir": entry.is_dir(),
                    "size": entry.stat().st_size if entry.is_file() else 0,
                })
            await send_response(websocket, msg_id, "ok", {"path": str(p), "entries": entries})
        except Exception as e:
            await send_response(websocket, msg_id, "error", {"error": str(e)})

    else:
        await send_response(websocket, msg_id, "error", {"error": f"未知的消息类型: {msg_type}"})


async def send_response(websocket, msg_id: str, status: str, data: dict) -> None:
    """发送响应消息"""
    response = {
        "id": msg_id,
        "type": "response",
        "status": status,
        "data": data,
    }
    await websocket.send(json.dumps(response, ensure_ascii=False))


async def handler(websocket):
    """WebSocket 连接处理器"""
    logger.info(f"新客户端连接")
    try:
        async for raw_message in websocket:
            try:
                message = json.loads(raw_message)
                await handle_message(websocket, message)
            except json.JSONDecodeError:
                logger.warning(f"收到无效 JSON: {raw_message[:100]}")
                await send_response(websocket, "error", "error", {"error": "无效的 JSON 格式"})
    except websockets.exceptions.ConnectionClosed:
        logger.info("客户端连接已断开")
    except Exception as e:
        logger.error(f"连接异常: {e}")


async def main():
    """启动 WebSocket 服务器"""
    logger.info(f"启动桥接服务: ws://{HOST}:{PORT}")
    logger.info("等待 Tauri 后端连接...")

    async with websockets.serve(handler, HOST, PORT):
        await asyncio.Future()


if __name__ == "__main__":
    print(f"""
╔══════════════════════════════════════════╗
║     Ripple Desktop Bridge Server         ║
║     ws://{HOST}:{PORT}                       ║
╚══════════════════════════════════════════╝
    """)
    asyncio.run(main())

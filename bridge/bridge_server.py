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

# 配置日志（输出到 stdout，避免 Rust 侧误标为 ERR）
_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(logging.Formatter("[Bridge] %(asctime)s %(levelname)s: %(message)s", datefmt="%H:%M:%S"))
logging.basicConfig(level=logging.INFO, handlers=[_handler])
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

        # 清理残留的 opencode serve 进程（防止端口冲突）
        logger.info(f"清理残留 opencode 进程...")
        if os.name == "nt":
            subprocess.run(
                "taskkill /f /im node.exe 2>nul | findstr opencode >nul",
                shell=True, capture_output=True,
            )
        else:
            subprocess.run("pkill -f 'opencode serve' 2>/dev/null", shell=True)
        await asyncio.sleep(1)

        logger.info(f"启动 opencode serve :{self.port}...")
        self._server_process = subprocess.Popen(
            f"{OPENCODE_CMD} serve --port {self.port}",
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=True,
        )

        for _ in range(30):
            await asyncio.sleep(0.5)
            if await self._health_check():
                logger.info("opencode serve 就绪")
                return True

            # 检查进程是否已退出
            if self._server_process.poll() is not None:
                logger.error(f"opencode serve 进程异常退出, code={self._server_process.returncode}")
                break

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

    async def create_session(self, model: str = None) -> str:
        """创建新 session（model 在消息级别设置，不在 session 级别）"""
        async with aiohttp.ClientSession() as session:
            resp = await session.post(f"{self.base_url}/session")
            if resp.status != 200:
                raise Exception(f"创建会话失败: {await resp.text()}")
            data = await resp.json()
            sid = data["id"]
            logger.info(f"Session: {sid}")
            return sid

    # ---------- 核心：SSE 流式消息 ----------

    async def send_message_stream(self, message: str, msg_id: str, websocket, model: str = None):
        if not await self.ensure_server():
            await send_response(websocket, msg_id, "error", {"error": "opencode serve 服务不可用"})
            return

        session_id = await self.create_session(model=model)
        logger.info(f"发送: {message[:50]}...  session={session_id}")

        # 后台监听 /event（独立 ClientSession，不阻塞 POST）
        listener = asyncio.create_task(self._listen_events(session_id, msg_id, websocket))

        try:
            async with aiohttp.ClientSession() as s:
                payload = {"parts": [{"type": "text", "text": message}]}
                if model and "/" in model:
                    parts = model.split("/", 1)
                    payload["model"] = {"providerID": parts[0], "modelID": parts[1]}
                async with s.post(
                    f"{self.base_url}/session/{session_id}/message",
                    json=payload,
                ) as resp:
                    if resp.status != 200:
                        err = await resp.text()
                        logger.error(f"POST 失败: {err}")
                        listener.cancel()
                        await send_response(websocket, msg_id, "error", {"error": f"发消息失败: {err}"})
                        return

            await listener  # 等 /event 流结束
            logger.info("回答完毕")

        except asyncio.CancelledError:
            listener.cancel()
            raise
        except Exception as e:
            logger.error(f"异常: {e}")
            listener.cancel()
            raise

    async def _listen_events(self, session_id: str, msg_id: str, websocket):
        """
        监听 /event SSE，逐 token 转发。
        delta 是累积内容，用 (messageID, field) 去重，只发增量。
        """
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{self.base_url}/event", timeout=aiohttp.ClientTimeout(total=300)) as resp:
                buf = ""
                last_for_key: dict[str, str] = {}  # "msgID:field" → 上次已发内容

                while True:
                    try:
                        chunk = await asyncio.wait_for(resp.content.read(4096), timeout=8.0)
                    except asyncio.TimeoutError:
                        continue
                    if not chunk:
                        break
                    buf += chunk.decode("utf-8", errors="replace")
                    while "\n\n" in buf:
                        block, buf = buf.split("\n\n", 1)
                        etype, text, msg_id_field = self._parse_sse_event_detailed(block)
                        if not text:
                            # 检查 session idle
                            if etype == "session.status":
                                props = self._get_event_properties(block) or {}
                                status = props.get("status", {})
                                if isinstance(status, dict) and status.get("type") == "idle":
                                    return
                            continue

                        # 去重：delta 是累积的，只发新增部分
                        key = msg_id_field or f"default_{etype}"
                        prev = last_for_key.get(key, "")
                        if text.startswith(prev):
                            new_text = text[len(prev):]
                        else:
                            new_text = text  # 不匹配就全发（兜底）
                        last_for_key[key] = text
                        if new_text:
                            await send_response(websocket, msg_id, "stream", {"chunk": new_text})

    def _parse_sse_event_detailed(self, event_block: str) -> tuple[str | None, str | None, str | None]:
        """
        解析 SSE 事件，返回 (event_type, delta_text, dedup_key)。
        dedup_key = "messageID:field" 或 "partID" 或 None。
        """
        for line in event_block.strip().split("\n"):
            if not line.startswith("data:"):
                continue
            try:
                data = json.loads(line[5:].strip())
                etype = data.get("type")
                props = data.get("properties", {})
                if not isinstance(props, dict):
                    return (etype, None, None)
                delta = props.get("delta") or props.get("text") or props.get("content")
                mid = props.get("messageID") or ""
                fld = props.get("field") or ""
                pid = props.get("partID") or ""
                # 优先用 messageID:field，其次用 partID
                dedup_key = f"{mid}:{fld}" if mid else (pid or None)
                return (etype, delta, dedup_key)
            except json.JSONDecodeError:
                pass
        return (None, None, None)

    def _get_event_session(self, event_block: str) -> str | None:
        """从 SSE 事件块中提取 sessionID"""
        for line in event_block.strip().split("\n"):
            if line.startswith("data:"):
                try:
                    data = json.loads(line[5:].strip())
                    props = data.get("properties", {})
                    if isinstance(props, dict):
                        return props.get("sessionID")
                except json.JSONDecodeError:
                    pass
        return None

    def _get_event_properties(self, event_block: str) -> dict | None:
        """从 SSE 事件块中提取 properties 字段"""
        for line in event_block.strip().split("\n"):
            if line.startswith("data:"):
                try:
                    data = json.loads(line[5:].strip())
                    return data.get("properties")
                except json.JSONDecodeError:
                    pass
        return None

    def _parse_sse_event(self, event_block: str) -> tuple[str | None, str | None]:
        """
        解析 SSE 事件块，返回 (event_type, content_text)。
        
        实际 SSE 格式（无 event: 行，类型在 JSON data 中）：
          data: {"type":"message.part.delta","properties":{"delta":"token"}}
        """
        lines = event_block.strip().split("\n")
        event_type = None
        raw_data = None

        for line in lines:
            if line.startswith("data:"):
                try:
                    raw_data = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    pass

        if not raw_data:
            return (None, None)

        # 事件类型在 data.type 中（区别于 SSE 的 event: 行）
        event_type = raw_data.get("type") or raw_data.get("event")

        # 内容在 data.properties.delta 中
        props = raw_data.get("properties", {})
        if isinstance(props, dict):
            delta = props.get("delta") or props.get("text") or props.get("content")
            if delta:
                return (event_type, delta)

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
        await opencode_bridge.send_message_stream(command, msg_id, websocket, model=model)
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


async def ensure_port_free(port: int):
    """确保端口空闲：检测占用进程并杀掉"""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        s.close()
        return True  # 端口空闲
    except OSError:
        s.close()
        logger.warning(f"端口 {port} 被占用，尝试清理...")
        if os.name == "nt":
            # PowerShell 检测并杀死占用进程
            ps_cmd = (
                f"Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue "
                f"| Select-Object -ExpandProperty OwningProcess "
                f"| ForEach-Object {{ Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }}"
            )
            subprocess.run(["powershell", "-Command", ps_cmd], capture_output=True)
        else:
            subprocess.run(["fuser", "-k", f"{port}/tcp"], capture_output=True)
        await asyncio.sleep(1)
        return False


async def main():
    """启动 WebSocket 服务器（端口冲突时自动清理）"""
    await ensure_port_free(PORT)
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

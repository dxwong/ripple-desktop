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
import subprocess
import sys
import time
from pathlib import Path

try:
    import websockets
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


# ==================== CLI 执行 ====================

async def execute_opencode(command: str, model: str = None, timeout: int = 120) -> dict:
    """
    执行 OpenCode CLI 命令

    Args:
        command: 要执行的命令字符串
        model: 指定使用的模型名称（对应 --model 参数）
        timeout: 超时时间（秒）

    Returns:
        {"stdout": "...", "stderr": "...", "returncode": 0}
    """
    try:
        # 构建命令: opencode [--model <name>] <command>
        cmd_parts = [OPENCODE_CMD]
        if model:
            cmd_parts.extend(["--model", model])
        cmd_parts.append(command)
        cmd_str = " ".join(cmd_parts)

        logger.info(f"执行: {cmd_str}")

        proc = await asyncio.create_subprocess_shell(
            cmd_str,
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


async def execute_shell(command: str, timeout: int = 60) -> dict:
    """执行普通 shell 命令"""
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
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

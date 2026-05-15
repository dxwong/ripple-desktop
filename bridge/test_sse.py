#!/usr/bin/env python3
"""
OpenCode serve SSE 集成测试
验证：session 创建、消息发送、SSE 流式接收
"""

import asyncio
import json
import sys

try:
    import aiohttp
except ImportError:
    print("请先安装依赖: pip install aiohttp")
    sys.exit(1)

BASE_URL = "http://127.0.0.1:4096"


async def test_health():
    print("\n[1] 健康检查")
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{BASE_URL}/global/health", timeout=5) as resp:
            data = await resp.json()
            print(f"    健康状态: {data}")
            assert data.get("healthy"), "服务不健康"
    print("    OK")


async def test_create_session(model: str = None) -> str:
    tag = f"model={model}" if model else "default"
    print(f"\n[2] 创建 Session ({tag})")
    async with aiohttp.ClientSession() as session:
        if model and "/" in model:
            parts = model.split("/", 1)
            body = {"model": {"providerID": parts[0], "modelID": parts[1]}}
            resp = await session.post(f"{BASE_URL}/session", json=body)
        else:
            resp = await session.post(f"{BASE_URL}/session")

        assert resp.status == 200, f"创建失败: {await resp.text()}"
        data = await resp.json()
        sid = data["id"]
        print(f"    Session: {sid}")
    print("    OK")
    return sid


async def test_stream(session_id: str, message: str) -> bool:
    print(f"\n[3] 发送消息: {message}")
    tokens = []

    async def listen_events():
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{BASE_URL}/event", timeout=aiohttp.ClientTimeout(total=60)) as resp:
                buf = ""
                while True:
                    try:
                        chunk = await asyncio.wait_for(resp.content.read(4096), timeout=15.0)
                    except asyncio.TimeoutError:
                        if tokens:
                            print(f"    超时无 token，结束 (共 {len(tokens)} tokens)")
                        break
                    if not chunk:
                        break

                    buf += chunk.decode("utf-8", errors="replace")
                    while "\n\n" in buf:
                        block, buf = buf.split("\n\n", 1)
                        for line in block.strip().split("\n"):
                            if not line.startswith("data:"):
                                continue
                            try:
                                data = json.loads(line[5:].strip())
                                etype = data.get("type")
                                props = data.get("properties", {})
                                if isinstance(props, dict) and props.get("delta"):
                                    tokens.append(props["delta"])
                                if etype == "session.status":
                                    status = props.get("status", {})
                                    if isinstance(status, dict) and status.get("type") == "idle":
                                        print(f"    session idle ({len(tokens)} tokens)")
                                        return
                            except json.JSONDecodeError:
                                pass

    listener = asyncio.create_task(listen_events())
    await asyncio.sleep(0.3)

    async with aiohttp.ClientSession() as s:
        payload = {"parts": [{"type": "text", "text": message}]}
        async with s.post(
            f"{BASE_URL}/session/{session_id}/message",
            json=payload,
            timeout=aiohttp.ClientTimeout(total=30),
        ) as resp:
            body = await resp.text()
            print(f"    POST: {resp.status} {body[:120]}")
            if resp.status != 200:
                listener.cancel()
                return False

    await asyncio.wait_for(listener, timeout=45)

    if tokens:
        text = "".join(tokens)
        print(f"    回复 ({len(text)} 字符): {text[:200]}")
        print(f"    OK (收到 {len(tokens)} tokens)")
        return True
    else:
        print(f"    未收到任何 token")
        return False


async def test_model(model: str):
    print(f"\n{'='*50}")
    print(f"模型: {model}")
    sid = await test_create_session(model)
    ok = await test_stream(sid, "用一句话介绍你自己")
    return ok


async def main():
    print("=" * 50)
    print("OpenCode Serve SSE 测试")
    print("=" * 50)
    print("请确保 opencode serve 已在运行: opencode serve --port 4096\n")

    try:
        await test_health()

        # 测试默认模型
        sid = await test_create_session(None)
        await test_stream(sid, "hi")

        # 测试指定模型
        for model in ["opencode/nemotron-3-super-free", "opencode/ring-2.6-1t-free"]:
            ok = await test_model(model)
            if not ok:
                print(f"  模型 {model} 失败")

        print(f"\n{'='*50}")
        print("测试完成")
    except Exception as e:
        print(f"\n测试失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

import { useState, useCallback, useEffect, useRef } from "react";
import { isTauri } from "./useTauri";

/** 桥接服务连接状态 */
export type BridgeStatus = "disconnected" | "connecting" | "connected" | "error";

/** 桥接消息类型 */
export interface BridgeMessage {
  id: string;
  type: string;
  status: string;
  data: any;
}

/**
 * 桥接服务 Hook
 * - Tauri 环境：通过 IPC 调用 Rust 后端的 WebSocket 客户端
 * - 浏览器环境：返回离线状态，所有操作静默失败
 */
export function useBridge() {
  const [status, setStatus] = useState<BridgeStatus>("disconnected");
  const [error, setError] = useState<string>("");
  const unlistenRef = useRef<(() => void)[]>([]);
  const inTauri = isTauri();
  const messageCallbackRef = useRef<((message: BridgeMessage) => void) | null>(null);

  // 设置消息回调
  const setMessageCallback = useCallback((callback: ((message: BridgeMessage) => void) | null) => {
    messageCallbackRef.current = callback;
  }, []);

  // 监听桥接服务状态事件（仅 Tauri 环境）
  // 
  // ⚠️ setupListeners 是 async 的，但 useEffect cleanup 是同步的。
  // React StrictMode 下会触发 挂载→清理→挂载 的 double-invoke。
  // 如果第一个 setupListeners 的 await 还没完成，cleanup 就已经执行了，
  // 那么第一个的 listener 会"泄漏"下来，和第二个的 listener 叠加 → 双重监听。
  // 用 cancelled 标志防止此竞态。
  useEffect(() => {
    if (!inTauri) {
      setStatus("disconnected");
      return;
    }

    let cancelled = false;

    const setupListeners = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;

        // 监听连接状态
        const unlistenStatus = await listen<{ status: string; error?: string }>(
          "bridge-status",
          (event) => {
            const { status: s, error: err } = event.payload;
            switch (s) {
              case "connected":
                setStatus("connected");
                setError("");
                break;
              case "disconnected":
                setStatus("disconnected");
                break;
              case "error":
                setStatus("error");
                setError(err || "桥接服务连接出错");
                break;
            }
          }
        );
        if (cancelled) { unlistenStatus(); return; }
        unlistenRef.current.push(unlistenStatus);

        // 监听桥接消息（用于流式响应）
        console.log("[useBridge] 注册 bridge-message 监听器");
        const unlistenMessage = await listen<BridgeMessage>(
          "bridge-message",
          (event) => {
            if (messageCallbackRef.current) {
              messageCallbackRef.current(event.payload);
            }
          }
        );
        if (cancelled) { unlistenMessage(); return; }
        unlistenRef.current.push(unlistenMessage);
        console.log("[useBridge] bridge-message 监听器已注册, 总数:", unlistenRef.current.length);
      } catch (e) {
        if (!cancelled) console.warn("桥接事件监听初始化失败:", e);
      }
    };

    setupListeners();

    return () => {
      cancelled = true;
      unlistenRef.current.forEach((fn) => fn());
      unlistenRef.current = [];
    };
  }, [inTauri]);

  /** 连接到 Python 桥接服务 */
  const connect = useCallback(async () => {
    if (!inTauri) {
      // 浏览器中直接返回离线状态
      setStatus("disconnected");
      return;
    }
    setStatus("connecting");
    setError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<string>("connect_bridge");
      if (result === "connected" || result === "already_connected") {
        setStatus("connected");
      }
    } catch (e: any) {
      setStatus("error");
      setError(typeof e === "string" ? e : e.message || "连接失败");
    }
  }, [inTauri]);

  /** 断开连接 */
  const disconnect = useCallback(async () => {
    if (!inTauri) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<string>("disconnect_bridge");
      setStatus("disconnected");
      setError("");
    } catch (e: any) {
      console.error("断开连接失败:", e);
    }
  }, [inTauri]);

  /** 发送消息到桥接服务并等待响应 */
  const sendMessage = useCallback(
    async (type: string, data: Record<string, unknown>): Promise<any> => {
      if (!inTauri) {
        throw new Error("浏览器模式不支持桥接服务");
      }
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        // 使用 Promise.race 实现超时，因为 Tauri 2.x invoke 不支持 timeout 选项
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("请求超时 (180秒)")), 180000);
        });
        const result = await Promise.race([
          invoke<{ status: string; data: any }>("send_to_bridge", { msgType: type, data }),
          timeoutPromise
        ]) as { status: string; data: any };
        if (result.status === "ok") {
          return result.data;
        } else {
          throw new Error(result.data?.error || "请求失败");
        }
      } catch (e: any) {
        throw new Error(typeof e === "string" ? e : e.message || "请求失败");
      }
    },
    [inTauri]
  );

  /** 获取连接状态 */
  const getStatus = useCallback(async (): Promise<BridgeStatus> => {
    if (!inTauri) return "disconnected";
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const s = await invoke<string>("get_bridge_status");
      return s as BridgeStatus;
    } catch {
      return "disconnected";
    }
  }, [inTauri]);

  /** 发送流式消息（不等待响应，响应通过事件回调接收） */
  const sendStreamingMessage = useCallback(
    async (type: string, data: Record<string, unknown>): Promise<void> => {
      if (!inTauri) {
        throw new Error("浏览器模式不支持桥接服务");
      }
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        // 使用不等待响应的命令，避免超时断开
        await invoke("send_to_bridge_no_wait", { msgType: type, data });
      } catch (e: any) {
        throw new Error(typeof e === "string" ? e : e.message || "请求失败");
      }
    },
    [inTauri]
  );

  return {
    status,
    error,
    connect,
    disconnect,
    sendMessage,
    sendStreamingMessage,
    setMessageCallback,
    getStatus,
    isConnected: status === "connected",
  };
}

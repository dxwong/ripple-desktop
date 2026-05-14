import { useState, useCallback, useEffect, useRef } from "react";
import { isTauri } from "./useTauri";

/** 桥接服务连接状态 */
export type BridgeStatus = "disconnected" | "connecting" | "connected" | "error";

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

  // 监听桥接服务状态事件（仅 Tauri 环境）
  useEffect(() => {
    if (!inTauri) {
      setStatus("disconnected");
      return;
    }

    const setupListeners = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
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
        unlistenRef.current.push(unlistenStatus);
      } catch (e) {
        console.warn("桥接事件监听初始化失败:", e);
      }
    };

    setupListeners();

    return () => {
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
        const result = await invoke<{ status: string; data: any }>(
          "send_to_bridge",
          { msgType: type, data }
        );
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

  return {
    status,
    error,
    connect,
    disconnect,
    sendMessage,
    getStatus,
    isConnected: status === "connected",
  };
}

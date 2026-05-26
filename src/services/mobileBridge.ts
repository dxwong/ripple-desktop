import { isTauri } from "../hooks/useTauri";
import { flog } from "./frontendLogger";

export interface MobileBridgeState {
  running: boolean;
  port: number;
}

export interface MobileChatRequest {
  message: string;
  sessionId: string;
  modelId: string;
  model?: string;
  endpoint?: string;
  apiKey?: string;
  cwd?: string;
  title?: string;
  regenerate?: boolean;
}

export type MobileBridgeEventType =
  | "text"
  | "thinking"
  | "tool-start"
  | "tool-end"
  | "tool-request"
  | "tool-update"
  | "agent-start"
  | "turn-start"
  | "turn-end"
  | "message-start"
  | "message-end"
  | "usage"
  | "done"
  | "error";

export interface MobileBridgeEvent {
  type: MobileBridgeEventType;
  sessionId: string;
  data?: Record<string, unknown>;
}

let bridgeState: MobileBridgeState = { running: false, port: 0 };
let chatRequestHandler: ((req: MobileChatRequest) => void) | null = null;
let unlistenChatRequest: (() => void) | null = null;
let unlistenStatus: (() => void) | null = null;

export function getBridgeState(): MobileBridgeState {
  return { ...bridgeState };
}

export async function startBridge(port: number = 9876): Promise<MobileBridgeState> {
  if (!isTauri()) {
    flog.info("MOBILE_BRIDGE", "非 Tauri 环境，跳过启动");
    return bridgeState;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const actualPort = await invoke<number>("start_mobile_bridge", { port });
    bridgeState = { running: true, port: actualPort };
    flog.info("MOBILE_BRIDGE", `启动成功`, { port: actualPort });
    return bridgeState;
  } catch (err) {
    flog.error("MOBILE_BRIDGE", `启动失败`, {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function stopBridge(): Promise<boolean> {
  if (!isTauri()) return false;

  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const wasRunning = await invoke<boolean>("stop_mobile_bridge");
    bridgeState = { running: false, port: 0 };
    flog.info("MOBILE_BRIDGE", wasRunning ? "已停止" : "未在运行");
    return wasRunning;
  } catch (err) {
    flog.error("MOBILE_BRIDGE", `停止失败`, {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function broadcastToMobile(
  eventType: MobileBridgeEventType,
  sessionId: string,
  data?: Record<string, unknown>
): Promise<number> {
  if (!isTauri() || !bridgeState.running) return 0;

  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const event: MobileBridgeEvent = { type: eventType, sessionId };
    if (data) {
      event.data = data;
    }
    const sent = await invoke<number>("broadcast_mobile_event", {
      eventJson: JSON.stringify(event),
    });
    if (sent > 0) {
      flog.debug("MOBILE_BRIDGE", `广播事件`, { type: eventType, sent, sessionId });
    }
    return sent;
  } catch (err) {
    flog.warn("MOBILE_BRIDGE", `广播失败`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

export async function setupMobileChatListener(
  onChatRequest: (req: MobileChatRequest) => void
): Promise<void> {
  if (!isTauri()) return;

  chatRequestHandler = onChatRequest;

  const { listen } = await import("@tauri-apps/api/event");
  unlistenChatRequest = await listen<MobileChatRequest>(
    "mobile-chat-request",
    (event) => {
      flog.info("MOBILE_BRIDGE", "收到手机端消息", {
        sessionId: event.payload.sessionId,
        messagePreview: event.payload.message.slice(0, 50),
        cwd: event.payload.cwd || "(none)",
      });
      onChatRequest(event.payload);
    }
  );

  unlistenStatus = await listen<{ status: string; port?: number }>(
    "mobile-bridge-status",
    (event) => {
      flog.info("MOBILE_BRIDGE", `状态变更: ${event.payload.status}`, {
        port: event.payload.port,
      });
      if (event.payload.status === "started" && event.payload.port) {
        bridgeState = { running: true, port: event.payload.port };
      } else if (event.payload.status === "stopped") {
        bridgeState = { running: false, port: 0 };
      }
    }
  );

  flog.info("MOBILE_BRIDGE", "已注册手机端消息监听");
}

export function teardownMobileChatListener(): void {
  if (unlistenChatRequest) {
    unlistenChatRequest();
    unlistenChatRequest = null;
  }
  if (unlistenStatus) {
    unlistenStatus();
    unlistenStatus = null;
  }
  chatRequestHandler = null;
  flog.info("MOBILE_BRIDGE", "已注销手机端消息监听");
}
/**
 * SSE (Server-Sent Events) 流式客户端
 *
 * 用于与 Ripple-Agent 后端的 /api/chat 端点通信，
 * 实时接收 AI 回复的文本、思考过程和工具调用事件。
 */

import type { SSEEvent, ToolRequestData } from "../types";

/** SSE 连接配置 */
interface SSEClientOptions {
  /** 后端基础 URL */
  baseUrl?: string;
  /** 连接超时（毫秒） */
  timeout?: number;
}

/** SSE 事件回调 */
interface SSECallbacks {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (name: string) => void;
  onToolEnd?: (name: string, isError?: boolean) => void;
  onToolRequest?: (data: ToolRequestData) => void;
  onDone?: () => void;
  onError?: (error: string) => void;
}

/** SSE 连接状态 */
export type SSEStatus = "idle" | "connecting" | "streaming" | "done" | "error";

/**
 * SSE 客户端类
 *
 * 用法：
 * ```ts
 * const client = new SSEClient();
 * client.connect(
 *   { message: "Hello", sessionId: "abc", modelId: "deepseek-v4-flash" },
 *   {
 *     onText: (text) => appendToConversation(text),
 *     onDone: () => console.log("完成"),
 *   }
 * );
 * // 取消：
 * client.abort();
 * ```
 */
export class SSEClient {
  private abortController: AbortController | null = null;
  private baseUrl: string;
  private timeout: number;
  private _status: SSEStatus = "idle";

  constructor(options: SSEClientOptions = {}) {
    this.baseUrl = options.baseUrl || "http://localhost:3002";
    this.timeout = options.timeout || 120_000; // 默认 2 分钟
  }

  /** 当前连接状态 */
  get status(): SSEStatus {
    return this._status;
  }

  /**
   * 发起 SSE 流式聊天请求
   *
   * @param params - 请求参数
   * @param callbacks - 事件回调
   * @returns Promise，流完成或出错时 resolve
   */
  async connect(
    params: {
      message: string;
      sessionId?: string;
      modelId?: string;
      systemPrompt?: string;
      /** API 端点（如 https://api.openai.com/v1） */
      endpoint?: string;
      /** API 密钥 */
      apiKey?: string;
      /** 实际模型名（如 gpt-4o、deepseek-chat） */
      model?: string;
      /** 项目工作目录（限制文件操作范围） */
      cwd?: string;
    },
    callbacks: SSECallbacks
  ): Promise<void> {
    // 如果已有连接，先取消
    this.abort();

    this.abortController = new AbortController();
    this._status = "connecting";

    const { signal } = this.abortController;
    const timeoutId = setTimeout(() => {
      this.abort();
      callbacks.onError?.("请求超时");
    }, this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          message: params.message,
          sessionId: params.sessionId || "default",
          modelId: params.modelId || "deepseek-v4-flash",
          model: params.model || params.modelId || "deepseek-v4-flash",
          endpoint: params.endpoint,
          apiKey: params.apiKey,
          systemPrompt: params.systemPrompt,
          cwd: params.cwd,
        }),
        signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        this._status = "error";
        callbacks.onError?.(body.error || `HTTP ${response.status}`);
        return;
      }

      this._status = "streaming";

      const reader = response.body?.getReader();
      if (!reader) {
        this._status = "error";
        callbacks.onError?.("响应体不可读");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // 按行解析 SSE 数据
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // 保留未完成的行

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          try {
            const jsonStr = trimmed.slice(6); // 去掉 "data: " 前缀
            const event: SSEEvent = JSON.parse(jsonStr);

            switch (event.type) {
              case "text":
                if (event.text) callbacks.onText?.(event.text);
                break;
              case "thinking":
                if (event.text) callbacks.onThinking?.(event.text);
                break;
              case "tool-start":
                if (event.name) callbacks.onToolStart?.(event.name);
                break;
              case "tool-end":
                if (event.name) callbacks.onToolEnd?.(event.name, event.isError);
                break;
              case "tool-request":
                if (event.toolCallId && event.toolName) {
                  callbacks.onToolRequest?.({
                    toolCallId: event.toolCallId as string,
                    toolName: event.toolName as string,
                    args: (event.args as Record<string, unknown>) || {},
                    description: (event.description as string) || "",
                    riskLevel: (event.riskLevel as "low" | "medium" | "high") || "medium",
                  });
                }
                break;
              case "done":
                this._status = "done";
                callbacks.onDone?.();
                break;
              case "error":
                this._status = "error";
                callbacks.onError?.(event.error || "未知错误");
                break;
            }
          } catch {
            // 忽略解析错误行
          }
        }
      }

      // 流正常结束
      if (this._status === "streaming") {
        this._status = "done";
        callbacks.onDone?.();
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") {
        // 主动取消，不触发 onError
        this._status = "idle";
        return;
      }
      this._status = "error";
      callbacks.onError?.(err.message || "连接失败");
    }
  }

  /**
   * 取消当前 SSE 连接
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this._status = "idle";
  }
}
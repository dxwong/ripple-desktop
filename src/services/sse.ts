/**
 * SSE (Server-Sent Events) 流式客户端
 *
 * 用于与 Ripple-Agent 后端的 /api/chat 端点通信，
 * 实时接收 AI 回复的文本、思考过程和工具调用事件。
 */

import type { SSEEvent, ToolRequestData } from "../types";
import { flog } from "./frontendLogger";

/** SSE 连接配置 */
interface SSEClientOptions {
  /** 后端基础 URL */
  baseUrl?: string;
  /** 连接超时（毫秒） */
  timeout?: number;
  /** 流式空闲超时（毫秒），默认 30 秒无数据视为超时 */
  idleTimeout?: number;
}

/** SSE 事件回调 */
interface SSECallbacks {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  /** 工具开始执行（已批准后触发） */
  onToolStart?: (toolCallId: string, toolName: string) => void;
  /** 工具执行结束（包含结果） */
  onToolEnd?: (toolCallId: string, toolName: string, result: { output?: string; error?: string }) => void;
  onToolRequest?: (data: ToolRequestData) => void;
  /** 工具部分执行结果更新 */
  onToolUpdate?: (toolCallId: string, toolName: string) => void;
  /** Agent/轮次/消息生命周期事件 */
  onAgentStart?: () => void;
  onTurnStart?: () => void;
  onTurnEnd?: (data: { hasToolResults: boolean; hasError: boolean; errorMessage?: string }) => void;
  onMessageStart?: (role: string) => void;
  onMessageEnd?: (role: string) => void;
  onDone?: () => void;
  onError?: (error: string, errorDetails?: any) => void;
  /** usage 事件回调：每次 AI 回复的 token 用量和费用 */
  onUsage?: (data: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number }) => void;
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
  private idleTimeout: number;
  private _status: SSEStatus = "idle";
  private currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  constructor(options: SSEClientOptions = {}) {
    this.baseUrl = options.baseUrl || "http://localhost:3002";
    this.timeout = options.timeout || 120_000; // 总超时时间
    this.idleTimeout = options.idleTimeout || 30_000; // 流式空闲超时
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
      /** 会话标题（用于 .jsonl header） */
      title?: string;
      /** 请求追踪 ID，用于端到端日志关联 */
      requestId?: string;
    },
    callbacks: SSECallbacks
  ): Promise<void> {
    // 如果已有连接，先取消
    this.abort();

    this.abortController = new AbortController();
    this._status = "connecting";

    const { signal } = this.abortController;
    // 总超时（120秒）
    const totalTimeoutId = setTimeout(() => {
      this.abort();
      callbacks.onError?.("请求超时");
    }, this.timeout);
    // 快速连接超时（15秒）- 用于快速发现后端挂掉
    const connectTimeoutId = setTimeout(() => {
      if (this._status === "connecting") {
        this.abort();
        callbacks.onError?.("连接超时，请检查后端服务是否正常启动");
      }
    }, 15_000);

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      flog.debug('SSE', `发起 SSE 连接请求`, { url: `${this.baseUrl}/api/chat` });
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
          title: params.title,
          requestId: params.requestId,
        }),
        signal,
      });

      flog.debug('SSE', `收到 SSE 响应`, { ok: response.ok, status: response.status, statusText: response.statusText });

      clearTimeout(totalTimeoutId);
      clearTimeout(connectTimeoutId);

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        this._status = "error";
        const statusCode = response.status;
        let errorHint = "";
        if (statusCode === 401) errorHint = "（API 密钥无效或已过期）";
        else if (statusCode === 403) errorHint = "（权限不足）";
        else if (statusCode === 429) errorHint = "（请求过于频繁，请稍后重试）";
        else if (statusCode >= 500) errorHint = "（服务端错误）";
        const errorMsg = body.error || `HTTP ${statusCode}${errorHint}`;
        flog.error('SSE', `请求失败`, { statusCode, errorMsg, body });
        callbacks.onError?.(errorMsg);
        return;
      }

      this._status = "streaming";

      this.currentReader = response.body?.getReader() ?? null;
      if (!this.currentReader) {
        this._status = "error";
        callbacks.onError?.("响应体不可读");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";


      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (this.idleTimeout > 0) {
          idleTimer = setTimeout(() => {
            this.abort();
            callbacks.onError?.(`响应空闲超时（${this.idleTimeout / 1000}秒无数据）`);
          }, this.idleTimeout);
        }
      };

      resetIdleTimer();

      while (true) {
        // 防止 idle timeout abort() 置 null 后 while 循环报错
        if (!this.currentReader) break;
        const { done, value } = await this.currentReader.read();
        if (done) {
          this.currentReader.releaseLock();
          this.currentReader = null;
          break;
        }

        resetIdleTimer();

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
            flog.debug('SSE', `收到 SSE 事件`, { type: event.type, data: event });

            switch (event.type) {
              case "text":
                if (event.text) callbacks.onText?.(event.text);
                break;
              case "thinking":
                if (event.text) callbacks.onThinking?.(event.text);
                break;
              case "tool-start":
                // tool-start 事件携带 toolCallId 和 name
                if (event.toolCallId && event.name) {
                  callbacks.onToolStart?.(event.toolCallId as string, event.name as string);
                }
                break;
              case "tool-end":
                // tool-end 事件携带 toolCallId、name、output、error
                if (event.toolCallId && event.name) {
                  callbacks.onToolEnd?.(
                    event.toolCallId as string,
                    event.name as string,
                    { output: event.output as string | undefined, error: event.error as string | undefined }
                  );
                }
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
              case "tool-update":
                if (event.toolCallId && event.name) {
                  callbacks.onToolUpdate?.(event.toolCallId as string, event.name as string);
                }
                break;
              case "agent-start":
                callbacks.onAgentStart?.();
                break;
              case "turn-start":
                callbacks.onTurnStart?.();
                break;
              case "turn-end":
                callbacks.onTurnEnd?.({
                  hasToolResults: event.hasToolResults === true,
                  hasError: event.hasError === true,
                  errorMessage: event.errorMessage,
                });
                break;
              case "message-start":
                if (event.role) callbacks.onMessageStart?.(event.role as string);
                break;
              case "message-end":
                if (event.role) callbacks.onMessageEnd?.(event.role as string);
                break;
              case "done":
                this._status = "done";
                callbacks.onDone?.();
                break;
              case 'error':
                this._status = "error";
                const errMsg = event.error || "未知错误";
                flog.error('SSE', `收到 error 事件`, { error: errMsg });
                callbacks.onError?.(errMsg);
                break;
              case "usage":
                // usage 事件携带 token 用量和费用数据
                // 注意：即使 totalTokens 为 0，也需要处理（可能是工具调用后的空用量）
                callbacks.onUsage?.({
                  input: Number(event.input ?? 0),
                  output: Number(event.output ?? 0),
                  cacheRead: Number(event.cacheRead ?? 0),
                  cacheWrite: Number(event.cacheWrite ?? 0),
                  totalTokens: Number(event.totalTokens ?? 0),
                  cost: Number(event.cost ?? 0),
                });
                break;
            }
          } catch {
            // 忽略解析错误行
          }
        }
      }

      // 流正常结束
      if (idleTimer) clearTimeout(idleTimer);
      if (this._status === "streaming") {
        this._status = "done";
        callbacks.onDone?.();
      }
    } catch (err: any) {
      clearTimeout(totalTimeoutId);
      clearTimeout(connectTimeoutId);
      if (idleTimer) clearTimeout(idleTimer);
      if (err.name === "AbortError") {
        // 主动取消，不触发 onError
        flog.debug('SSE', `连接被主动取消`);
        this._status = "idle";
        return;
      }
      flog.error('SSE', `连接异常`, { error: err.message, stack: err.stack });
      this._status = "error";
      callbacks.onError?.(err.message || "连接失败");
    }
  }

  /**
   * 取消当前 SSE 连接
   */
  abort(): void {
    if (this.currentReader) {
      this.currentReader.releaseLock();
      this.currentReader = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this._status = "idle";
  }
}
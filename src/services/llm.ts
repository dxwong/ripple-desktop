/**
 * 客户端 LLM API 直连服务
 *
 * 直接从浏览器调用 OpenAI 兼容的 Chat Completions API，
 * 不依赖 Ripple-Agent 后端。支持流式和非流式两种模式。
 */

import type { ModelConfig } from "../types";

// ============================================
// 类型定义
// ============================================

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: {
    index: number;
    message: { role: string; content: string };
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** 流式回调 */
interface StreamCallbacks {
  onText: (text: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

// ============================================
// 测试连接
// ============================================

export interface TestResult {
  success: boolean;
  message: string;
  latency?: number;
}

/**
 * 测试 API 连接是否可用
 *
 * 发送一个简单的非流式请求，验证 endpoint、apiKey 和 model 是否有效。
 */
export async function testApiConnection(config: {
  endpoint: string;
  apiKey: string;
  model: string;
}): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // 确保 endpoint 以 /v1 结尾
    const baseUrl = config.endpoint.replace(/\/+$/, "");
    const url = baseUrl.includes("/chat/completions")
      ? baseUrl
      : `${baseUrl}/chat/completions`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
        stream: false,
      } satisfies ChatCompletionRequest),
      signal: AbortSignal.timeout(15000),
    });

    const latency = Date.now() - startTime;

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const errorMsg =
        body.error?.message ||
        body.error ||
        `HTTP ${response.status}: ${response.statusText}`;
      return { success: false, message: errorMsg, latency };
    }

    const data: ChatCompletionResponse = await response.json();
    const modelUsed = data.model || config.model;
    return {
      success: true,
      message: `连接成功 · 模型: ${modelUsed} · ${latency}ms`,
      latency,
    };
  } catch (err: any) {
    const latency = Date.now() - startTime;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { success: false, message: "请求超时（15秒）", latency };
    }
    return {
      success: false,
      message: err.message || "连接失败",
      latency,
    };
  }
}

// ============================================
// 流式聊天
// ============================================

/**
 * 发起流式聊天请求，直接调用 OpenAI 兼容 API
 *
 * @param config - 模型配置
 * @param messages - 消息历史
 * @param callbacks - 流式回调
 * @param signal - 取消信号
 */
export async function streamChat(
  config: ModelConfig,
  messages: { role: string; content: string }[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const baseUrl = config.endpoint.replace(/\/+$/, "");
  const url = baseUrl.includes("/chat/completions")
    ? baseUrl
    : `${baseUrl}/chat/completions`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: config.model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        stream: true,
        temperature: 0.7,
      } satisfies ChatCompletionRequest),
      signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const errorMsg =
        body.error?.message || body.error || `HTTP ${response.status}`;
      callbacks.onError(errorMsg);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      callbacks.onError("响应体不可读");
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          callbacks.onDone();
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            callbacks.onText(delta.content);
          }
          // 检查 finish_reason
          if (parsed.choices?.[0]?.finish_reason === "stop") {
            // 继续读取，等待 [DONE]
          }
        } catch {
          // 忽略解析错误
        }
      }
    }

    // 流正常结束
    callbacks.onDone();
  } catch (err: any) {
    if (err.name === "AbortError") {
      return; // 主动取消，不触发 onError
    }
    callbacks.onError(err.message || "请求失败");
  }
}
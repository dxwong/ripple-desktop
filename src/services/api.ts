/**
 * Ripple-Agent 后端 HTTP API 客户端
 *
 * 封装所有 REST API 调用，统一处理请求/响应格式和错误。
 */

import type { BackendModel, BackendSession } from "../types";

/** 后端服务器基础 URL */
const BASE_URL = "http://localhost:3002";

/** API 响应包装 */
interface ApiResponse<T> {
  data?: T;
  error?: string;
}

/**
 * 通用请求封装
 */
async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  try {
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...options,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: body.error || `HTTP ${res.status}: ${res.statusText}` };
    }

    const data = await res.json();
    return { data };
  } catch (err: any) {
    return { error: err.message || "网络请求失败" };
  }
}

// ============================================
// 健康检查
// ============================================

/**
 * 检查后端服务是否可用
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ============================================
// 模型 API
// ============================================

/**
 * 获取可用模型列表
 */
export async function fetchModels(): Promise<ApiResponse<BackendModel[]>> {
  const result = await request<{ models: BackendModel[] }>("/api/models");
  if (result.error) return { error: result.error };
  return { data: result.data!.models };
}

// ============================================
// 会话 API
// ============================================

/**
 * 获取所有会话列表
 */
export async function fetchSessions(): Promise<ApiResponse<BackendSession[]>> {
  const result = await request<{ sessions: BackendSession[] }>("/api/sessions");
  if (result.error) return { error: result.error };
  return { data: result.data!.sessions };
}

/**
 * 获取单个会话详情
 */
export async function fetchSession(
  id: string
): Promise<ApiResponse<BackendSession>> {
  return request<BackendSession>(`/api/sessions/${id}`);
}

/**
 * 创建或更新会话
 */
export async function saveSession(
  id: string,
  data: { title?: string; model?: string; messages?: unknown[] }
): Promise<ApiResponse<{ success: boolean }>> {
  return request(`/api/sessions/${id}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/**
 * 删除会话
 */
export async function deleteSession(
  id: string
): Promise<ApiResponse<{ success: boolean }>> {
  return request(`/api/sessions/${id}`, { method: "DELETE" });
}

/**
 * 重置会话（清除 Agent 上下文）
 */
export async function resetSession(
  sessionId: string
): Promise<ApiResponse<{ success: boolean }>> {
  return request("/api/reset", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

// ============================================
// API 连接测试
// ============================================

export interface TestConnectionResult {
  success: boolean;
  message?: string;
  error?: string;
  latency?: number;
  model?: string;
}

/**
 * 通过后端测试 API 连接
 */
export async function testConnection(config: {
  endpoint: string;
  apiKey: string;
  model: string;
}): Promise<ApiResponse<TestConnectionResult>> {
  return request<TestConnectionResult>("/api/test-connection", {
    method: "POST",
    body: JSON.stringify(config),
  });
}
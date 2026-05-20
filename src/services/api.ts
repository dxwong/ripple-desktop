/**
 * Ripple-Agent 后端 HTTP API 客户端
 *
 * 封装所有 REST API 调用，统一处理请求/响应格式和错误。
 */

import type { BackendModel, BackendSession, UsageStats, AccountBalance } from "../types";

/** 后端服务器基础 URL */
export const BASE_URL = "http://localhost:3002";

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
    const timeoutSignal = AbortSignal.timeout(10000);
    const combinedSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...options,
      signal: combinedSignal,
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
  data: { title?: string; model?: string; messages?: unknown[]; cwd?: string }
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

// ============================================
// 工具执行确认 API
// ============================================

export interface ConfirmToolCallResult {
  success: boolean;
  message?: string;
}

/**
 * 确认或拒绝工具执行
 * @param sessionId 会话 ID
 * @param toolCallId 工具调用 ID
 * @param approved 是否批准
 * @param reason 拒绝原因（可选）
 * @param modelId 模型 ID（可选，默认 deepseek-v4-flash）
 */
export async function confirmToolCall(
  sessionId: string,
  toolCallId: string,
  approved: boolean,
  reason?: string,
  modelId: string = "deepseek-v4-flash"
): Promise<ApiResponse<ConfirmToolCallResult>> {
  return request<ConfirmToolCallResult>(`/api/chat/${sessionId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ toolCallId, approved, reason, modelId }),
  });
}

// ============================================
// 文件操作 API
// ============================================

/**
 * 读取文件内容
 * @param path 文件绝对路径
 */
export async function readFile(path: string): Promise<ApiResponse<{ path: string; content: string }>> {
  return request<{ path: string; content: string }>(
    `/api/files/read?path=${encodeURIComponent(path)}`
  );
}

// ============================================
// Checkpoint 快照 API
// ============================================

/** 快照摘要（列表用） */
export interface CheckpointSummary {
  id: string;
  name: string;
  createdAt: number;
  source: string;
  bytes: number;
}

/** 快照完整信息 */
export interface CheckpointDetail {
  id: string;
  name: string;
  rootDir: string;
  createdAt: number;
  source: string;
  files: Array<{ path: string; content: string | null; hash?: string }>;
  bytes: number;
  description?: string;
}

/** 差异条目 */
export interface DiffEntry {
  path: string;
  type: "modified" | "added" | "deleted";
  oldContent?: string;
  newContent?: string;
}

/** 恢复结果 */
export interface RestoreResult {
  success: boolean;
  restoredFiles: string[];
  skippedFiles: string[];
  backupId?: string;
  errors: string[];
  warnings: string[];
}

/**
 * 获取快照列表
 * @param cwd 工作目录
 */
export async function getCheckpoints(
  cwd: string
): Promise<ApiResponse<CheckpointSummary[]>> {
  const result = await request<{ checkpoints: CheckpointSummary[] }>(
    `/api/checkpoints?cwd=${encodeURIComponent(cwd)}`
  );
  if (result.error) return { error: result.error };
  return { data: result.data!.checkpoints };
}

/**
 * 创建快照
 * @param cwd 工作目录
 * @param name 快照名称（可选，自动生成）
 * @param description 描述（可选）
 */
export async function createCheckpoint(
  cwd: string,
  name?: string,
  description?: string
): Promise<ApiResponse<{ success: boolean; checkpoint: CheckpointSummary }>> {
  return request(`/api/checkpoints`, {
    method: "POST",
    body: JSON.stringify({ cwd, name, description, source: "manual" }),
  });
}

/**
 * 获取快照详情
 * @param id 快照 ID
 * @param cwd 工作目录
 */
export async function getCheckpoint(
  id: string,
  cwd: string
): Promise<ApiResponse<{ checkpoint: CheckpointDetail }>> {
  return request<{ checkpoint: CheckpointDetail }>(
    `/api/checkpoints/${id}?cwd=${encodeURIComponent(cwd)}`
  );
}

/**
 * 获取快照与当前文件的差异
 * @param id 快照 ID
 * @param cwd 工作目录
 */
export async function getCheckpointDiff(
  id: string,
  cwd: string
): Promise<ApiResponse<{ diff: DiffEntry[] }>> {
  return request<{ diff: DiffEntry[] }>(
    `/api/checkpoints/${id}/diff?cwd=${encodeURIComponent(cwd)}`
  );
}

/**
 * 恢复快照
 * @param id 快照 ID
 * @param cwd 工作目录
 * @param createBackup 是否创建备份（默认 true）
 * @param force 是否强制覆盖（默认 false）
 */
export async function restoreCheckpoint(
  id: string,
  cwd: string,
  createBackup = true,
  force = false
): Promise<ApiResponse<RestoreResult>> {
  return request<RestoreResult>(`/api/checkpoints/${id}/restore`, {
    method: "POST",
    body: JSON.stringify({ cwd, createBackup, force }),
  });
}

/**
 * 删除快照
 * @param id 快照 ID
 * @param cwd 工作目录
 */
export async function deleteCheckpoint(
  id: string,
  cwd: string
): Promise<ApiResponse<{ success: boolean }>> {
  return request(`/api/checkpoints/${id}?cwd=${encodeURIComponent(cwd)}`, {
    method: "DELETE",
  });
}

// ============================================
// EditBlock API（编辑块解析、预览、应用）
// ============================================

/** EditBlock 编辑块结构 */
export interface EditBlock {
  /** 要搜索的原始代码 */
  search: string;
  /** 替换后的代码 */
  replace: string;
  /** 文件路径（可选） */
  filePath?: string;
}

/** EditBlock 应用结果 */
export interface EditBlockResult {
  success: boolean;
  content?: string;
  error?: string;
  matchType: "exact" | "fuzzy";
  similarity: number;
  method?: "ngram" | "diff-alignment";
  suggestedSearch?: string;
}

/** 批量应用结果 */
export interface ApplyBlocksResult {
  success: boolean;
  applied: number;
  failed: number;
  content: string;
  results: Array<EditBlockResult & { block: EditBlock }>;
  checkpointId?: string;
  rollback?: () => Promise<boolean>;
}

/**
 * 解析 LLM 输出的 EditBlock 格式
 * @param text 包含 EditBlock 的文本
 * @param defaultFilePath 默认文件路径（可选）
 */
export async function parseEditBlocks(
  text: string,
  defaultFilePath?: string
): Promise<ApiResponse<{ blocks: EditBlock[]; count: number }>> {
  return request(`/api/edit/parse`, {
    method: "POST",
    body: JSON.stringify({ 
      text, 
      options: defaultFilePath ? { defaultFilePath } : undefined 
    }),
  });
}

/**
 * 预览 EditBlock 的修改效果（不实际修改文件）
 * @param content 文件当前内容
 * @param block EditBlock
 * @param minSimilarity 最小相似度阈值（默认 0.8）
 */
export async function previewEditBlock(
  content: string,
  block: EditBlock,
  minSimilarity = 0.8
): Promise<ApiResponse<{ success: boolean; diff?: string; similarity: number; error?: string }>> {
  return request(`/api/edit/preview`, {
    method: "POST",
    body: JSON.stringify({ content, block, minSimilarity }),
  });
}

/**
 * 应用 EditBlock（自动创建快照支持回滚）
 * @param filePath 文件路径
 * @param blocks EditBlock 数组
 * @param useFuzzy 是否使用模糊匹配（默认 true）
 * @param minSimilarity 最小相似度阈值（默认 0.8）
 * @param createCheckpoint 是否创建快照（默认 true）
 */
export async function applyEditBlocks(
  filePath: string,
  blocks: EditBlock[],
  useFuzzy = true,
  minSimilarity = 0.8,
  createCheckpoint = true
): Promise<ApiResponse<ApplyBlocksResult>> {
  return request(`/api/edit/apply`, {
    method: "POST",
    body: JSON.stringify({ 
      filePath, 
      blocks, 
      useFuzzy, 
      minSimilarity, 
      createCheckpoint 
    }),
  });
}

// ============================================
// 统计 API
// ============================================

/**
 * 获取使用统计摘要（缓存命中率、累计成本、上下文 token 等）
 */
export async function fetchStatsSummary(): Promise<ApiResponse<UsageStats>> {
  return request<UsageStats>("/api/stats/summary");
}

// ============================================
// 账户余额 API
// ============================================

/**
 * 查询 AI 提供商账户余额
 * @param apiKey API 密钥（可选，默认使用后端环境变量）
 * @param endpoint API 端点（用于判断 Provider 类型）
 */
export async function fetchAccountBalance(apiKey?: string, endpoint?: string): Promise<ApiResponse<AccountBalance>> {
  return request<AccountBalance>("/api/account/balance", {
    method: "POST",
    body: JSON.stringify({ apiKey, endpoint }),
  });
}
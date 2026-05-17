/** 消息角色 */
export type MessageRole = "user" | "assistant";

/** API 提供商类型 */
export type ApiProvider = "openai" | "custom";

/** 聊天模式 */
export type ChatMode = "chat" | "code";

/** 项目类型 */
export interface Project {
  id: string;
  name: string;
  directory: string;
  createdAt: number;
  updatedAt: number;
}

/** 单条消息 */
export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  /** 模型的思考/推理过程（如有），在前端可折叠展示 */
  thinking: string;
  timestamp: number;
}

/** 会话 */
export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  /** 关联的项目 ID（编程模式下使用） */
  projectId?: string;
  /** 聊天模式 */
  mode: ChatMode;
}

/**
 * 大模型配置（可保存多个，以 JSON 持久化到本地）
 * 这是「Agent 桌面端」的核心配置单元
 */
export interface ModelConfig {
  id: string;
  /** 用户命名的友好名称，如 "我的 OpenAI" */
  name: string;
  provider: ApiProvider;
  endpoint: string;
  apiKey: string;
  /** 实际模型名，如 gpt-4o / deepseek-chat */
  model: string;
  createdAt: number;
}

/** 应用整体设置 */
export interface AppSettings {
  /** 当前激活的模型配置 ID */
  activeModelId: string;
  /** 已保存的所有模型配置列表 */
  modelConfigs: ModelConfig[];
  darkMode: boolean;
  // 以下为兼容字段（当前激活配置的快捷引用）
  apiProvider: ApiProvider;
  apiEndpoint: string;
  apiKey: string;
  modelName: string;
}

/** 模型配置的表单数据（编辑/新建时使用） */
export interface ModelConfigFormData {
  name: string;
  provider: ApiProvider;
  endpoint: string;
  apiKey: string;
  model: string;
}

// ============================================
// 后端 API 类型
// ============================================

/** 后端返回的模型信息 */
export interface BackendModel {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
}

/** 后端返回的会话信息 */
export interface BackendSession {
  id: string;
  title: string;
  model: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

/** SSE 事件类型 */
export type SSEEventType = 'text' | 'thinking' | 'tool-start' | 'tool-end' | 'tool-request' | 'done' | 'error';

/** 工具执行确认请求 */
export interface ToolRequestData {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string;
  riskLevel: 'low' | 'medium' | 'high';
}

/** SSE 事件数据 */
export interface SSEEvent {
  type: SSEEventType;
  text?: string;
  name?: string;
  error?: string;
  toolRequest?: ToolRequestData;
}

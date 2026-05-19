/** 消息角色 */
export type MessageRole = "user" | "assistant";

/** API 提供商类型 */
export type ApiProvider = "openai" | "custom";

/** 聊天模式 */
export type ChatMode = "chat" | "code";

/** 权限模式 */
export type PermissionMode = "auto" | "confirm" | "read-only";

/** 权限模式选项 */
export const PERMISSION_MODES: { value: PermissionMode; label: string; description: string }[] = [
  { value: "auto", label: "默认允许", description: "信任模式：所有工具自动执行，无需确认" },
  { value: "confirm", label: "每次确认", description: "安全模式：高风险操作需要用户确认" },
  { value: "read-only", label: "只读模式", description: "仅允许读取文件，禁止写操作" },
];

/** 项目类型 */
export interface Project {
  id: string;
  name: string;
  directory: string;
  createdAt: number;
  updatedAt: number;
}

/** 工具执行结果 */
export interface ToolCallResult {
  toolName: string;
  toolCallId: string;
  /** 工具调用的输入参数 */
  args: Record<string, unknown>;
  /** 执行结果状态 */
  status: 'pending' | 'approved' | 'denied' | 'success' | 'error';
  /** 成功时的输出内容 */
  output?: string;
  /** 错误时的错误信息 */
  error?: string;
}

/** 单条消息 */
export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  /** 模型的思考/推理过程（如有），在前端可折叠展示 */
  thinking: string;
  timestamp: number;
  /** 本条消息关联的工具调用结果 */
  toolCalls?: ToolCallResult[];
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
  /** 工作目录（后端 Agent 的 cwd，用于项目对话） */
  cwd?: string;
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
  /** 权限模式：auto（自动执行）、confirm（每次确认）、read-only（只读） */
  permissionMode: PermissionMode;
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
  /** 完整消息列表（从 /api/sessions/:id 获取时包含） */
  messages?: Message[];
  mode?: ChatMode;
  projectId?: string;
  /** 后端 JSONL 中的工作目录，前端用它匹配本地项目 */
  cwd?: string;
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
  isError?: boolean;
  toolRequest?: ToolRequestData;
  // tool-request / tool-start / tool-end 事件的扁平字段
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  description?: string;
  riskLevel?: 'low' | 'medium' | 'high';
  /** tool-end 事件的输出结果 */
  output?: string;
}

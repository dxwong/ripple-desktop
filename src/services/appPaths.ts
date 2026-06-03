/**
 * 文件系统操作封装（记忆模块专用）
 *
 * - Tauri 模式：调用 Rust 命令（get_app_root / read_text_file / write_text_file / path_exists / ensure_memory_dir）
 * - 浏览器模式：所有方法抛错，调用方需走 localStorage 降级
 *
 * 设计原则：
 *   1. 不静默吞错，让上层知道 fs 不可用
 *   2. invoke 动态 import 避免 vite 在 dev 模式打包时找不到 @tauri-apps/api/core
 *   3. 路径使用原生字符串（不转 slash/反斜杠），Windows 上后端会自动处理
 */

import { isTauri } from '../hooks/useTauri';

/**
 * 获取应用根目录
 * - dev 模式：源码根（含 tauri.conf.json 的目录）
 * - prod 模式：.exe 所在目录
 */
export async function getAppRoot(): Promise<string> {
  if (!isTauri()) {
    throw new Error('getAppRoot 仅在 Tauri 环境下可用');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('get_app_root');
}

/**
 * 确保 <app_root>/memory/ 目录存在
 * 桌面端启动时调用一次即可
 */
export async function ensureMemoryDir(appRoot: string): Promise<void> {
  if (!isTauri()) {
    throw new Error('ensureMemoryDir 仅在 Tauri 环境下可用');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('ensure_memory_dir', { appRoot });
}

/**
 * 读取文本文件结果（带 mtime）
 */
export interface FileReadResult {
  /** 文件内容 */
  content: string;
  /** 最后修改时间（Unix 毫秒时间戳） */
  mtime_ms: number;
}

/**
 * 读取文本文件
 * @throws 文件不存在或读取失败时抛错
 */
export async function readTextFile(path: string): Promise<FileReadResult> {
  if (!isTauri()) {
    throw new Error('readTextFile 仅在 Tauri 环境下可用');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<FileReadResult>('read_text_file', { path });
}

/**
 * 写入文本文件（自动创建父目录）
 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  if (!isTauri()) {
    throw new Error('writeTextFile 仅在 Tauri 环境下可用');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('write_text_file', { path, content });
}

/**
 * 判断路径是否存在（文件或目录）
 */
export async function pathExists(path: string): Promise<boolean> {
  if (!isTauri()) {
    throw new Error('pathExists 仅在 Tauri 环境下可用');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<boolean>('path_exists', { path });
}

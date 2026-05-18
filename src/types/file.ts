/** 文件类型 */
export type FileType = 'file' | 'directory';

/** 文件系统项 */
export interface FileItem {
  id: string;
  name: string;
  path: string;
  type: FileType;
  children?: FileItem[];
  size?: number;
  lastModified?: number;
  extension?: string;
}

/** 文件树面板状态 */
export interface FileTreeState {
  isExpanded: boolean;
  selectedPath: string | null;
  loading: boolean;
  error: string | null;
}
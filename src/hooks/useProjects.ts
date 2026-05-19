import { useState, useCallback, useEffect, useRef } from "react";
import { useStore } from "./useStore";
import type { Project } from "../types";
import { flog } from "../services/frontendLogger";

const genId = () => Math.random().toString(36).substring(2, 10);

const STORAGE_KEY = "projects";

const DEFAULT_PROJECTS: Project[] = [
  {
    id: "default",
    name: "默认项目",
    directory: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

/**
 * 项目管理 Hook
 * - 项目列表持久化到本地 JSON（通过 useStore）
 * - 支持新建（需指定目录）/编辑/删除/切换
 */
export function useProjects() {
  const [projects, setProjects] = useState<Project[]>(DEFAULT_PROJECTS);
  const [activeProjectId, setActiveProjectId] = useState<string>("default");
  const [loaded, setLoaded] = useState(false);
  const initialized = useRef(false);
  const { saveItem, loadItem } = useStore();

  // ========== 初始化加载（只执行一次） ==========
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const init = async () => {
      const saved = await loadItem<Project[] | null>(STORAGE_KEY, null);
      if (saved && saved.length > 0) {
        saved.sort((a, b) => b.updatedAt - a.updatedAt);
        setProjects(saved);
        const valid = saved.find((p) => p.id === activeProjectId);
        if (!valid) {
          setActiveProjectId(saved[0].id);
        }
        flog.info('PROJECTS', `加载项目列表`, { count: saved.length, activeId: activeProjectId });
      } else {
        flog.info('PROJECTS', `无已保存的项目，使用默认项目`);
      }
      setLoaded(true);
    };
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ========== 自动持久化 ==========
  useEffect(() => {
    if (loaded) {
      saveItem(STORAGE_KEY, projects);
    }
  }, [projects, loaded, saveItem]);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0];

  // ========== 新建项目 ==========
  const addProject = useCallback((name: string, directory: string): Project | null => {
    const existingProjects = projects.filter((p) => p.directory === directory);
    const hasDuplicate = existingProjects.some((p) => p.name === name);
    
    if (hasDuplicate) {
      flog.warn('PROJECTS', `添加失败：文件夹 "${directory}" 已存在同名项目 "${name}"`);
      alert(`无法添加项目：\n\n文件夹 "${directory}"\n已存在同名项目 "${name}"\n\n请使用不同的别名来区分同一文件夹的多个会话。`);
      return null;
    }

    const newProject: Project = {
      id: genId(),
      name,
      directory,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    flog.info('PROJECTS', `新建项目成功`, {
      id: newProject.id,
      name: newProject.name,
      directory: newProject.directory,
      existingCount: existingProjects.length,
    });
    
    setProjects((prev) => [newProject, ...prev]);
    setActiveProjectId(newProject.id);
    return newProject;
  }, [projects]);

  // ========== 更新项目 ==========
  const updateProject = useCallback((id: string, updates: Partial<Project>) => {
    flog.info('PROJECTS', `更新项目`, { id, updates });
    setProjects((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p
      )
    );
  }, []);

  // ========== 删除项目 ==========
  const deleteProject = useCallback((id: string) => {
    const target = projects.find(p => p.id === id);
    flog.info('PROJECTS', `删除项目`, { id, name: target?.name, directory: target?.directory });
    setProjects((prev) => {
      const filtered = prev.filter((p) => p.id !== id);
      if (filtered.length === 0) {
        setActiveProjectId(DEFAULT_PROJECTS[0].id);
        return DEFAULT_PROJECTS;
      }
      if (activeProjectId === id) {
        setActiveProjectId(filtered[0].id);
      }
      return filtered;
    });
  }, [activeProjectId, projects]);

  // ========== 切换当前项目 ==========
  const setActiveProject = useCallback((id: string) => {
    const target = projects.find(p => p.id === id);
    flog.info('PROJECTS', `切换活跃项目`, { id, name: target?.name, directory: target?.directory, prevActiveId: activeProjectId });
    setActiveProjectId(id);
  }, [projects, activeProjectId]);

  return {
    projects,
    activeProject,
    activeProjectId,
    loaded,
    addProject,
    updateProject,
    deleteProject,
    setActiveProject,
  };
}
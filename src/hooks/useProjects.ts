import { useState, useCallback, useEffect, useRef } from "react";
import { useStore } from "./useStore";
import type { Project } from "../types";

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
        setProjects(saved);
        // 检查当前 activeId 是否有效，无效则用第一个
        const valid = saved.find((p) => p.id === activeProjectId);
        if (!valid) {
          setActiveProjectId(saved[0].id);
        }
      }
      setLoaded(true);
    };
    init();
    // 仅执行一次
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
  const addProject = useCallback((name: string, directory: string): Project => {
    const newProject: Project = {
      id: genId(),
      name,
      directory,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setProjects((prev) => [...prev, newProject]);
    setActiveProjectId(newProject.id);
    return newProject;
  }, []);

  // ========== 更新项目 ==========
  const updateProject = useCallback((id: string, updates: Partial<Project>) => {
    setProjects((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p
      )
    );
  }, []);

  // ========== 删除项目 ==========
  const deleteProject = useCallback((id: string) => {
    setProjects((prev) => {
      const filtered = prev.filter((p) => p.id !== id);
      if (filtered.length === 0) {
        // 全部删除后恢复默认
        setActiveProjectId(DEFAULT_PROJECTS[0].id);
        return DEFAULT_PROJECTS;
      }
      if (activeProjectId === id) {
        setActiveProjectId(filtered[0].id);
      }
      return filtered;
    });
  }, [activeProjectId]);

  // ========== 切换当前项目 ==========
  const setActiveProject = useCallback((id: string) => {
    setActiveProjectId(id);
  }, []);

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

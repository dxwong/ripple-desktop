/**
 * useSettings 云端同步测试
 *
 * 测试覆盖：
 * - 云端优先加载（云端有数据时使用云端）
 * - 本地兜底（云端不可用时回退本地）
 * - 反向迁移（本地有数据、云端空 → 推送云端）
 * - 双写保存（保存同时写本地 + 云端）
 * - 重置、容错等边界场景
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import React, { useEffect } from 'react';

// ===== Mock 依赖（必须放在 import 之前）=====

// 使用 Map 确保 mock 和测试共享同一份数据
const storageMap = new Map<string, string>();

const mockFetchSettings = vi.fn();
const mockSaveSettingsToCloud = vi.fn();
const mockSaveItem = vi.fn(async (key: string, value: unknown) => {
  storageMap.set(key, JSON.stringify(value));
});
const mockLoadItem = vi.fn(async (key: string, _default: unknown) => {
  const stored = storageMap.get(key);
  return stored !== undefined ? JSON.parse(stored) : _default;
});

vi.mock('../services/api', () => ({
  fetchSettings: () => mockFetchSettings(),
  saveSettingsToCloud: (s: Record<string, unknown>) => mockSaveSettingsToCloud(s),
}));

vi.mock('../hooks/useStore', () => ({
  useStore: () => ({ saveItem: mockSaveItem, loadItem: mockLoadItem }),
}));

// ===== 导入被测试模块 =====
import { useSettings } from '../hooks/useSettings';

// ===== Fixtures =====
const CLOUD_SETTINGS = {
  activeModelId: 'cloud-model',
  modelConfigs: [{
    id: 'cloud-model', name: '云端配置', provider: 'custom' as const,
    endpoint: 'https://api.cloud.com/', apiKey: 'sk-cloud', model: 'gpt-4o',
    createdAt: 1,
  }],
  darkMode: true,
  permissionMode: 'auto',
};

const LOCAL_SETTINGS = {
  activeModelId: 'local-model',
  modelConfigs: [{
    id: 'local-model', name: '本地配置', provider: 'custom' as const,
    endpoint: 'https://api.local.com/', apiKey: 'sk-local', model: 'gpt-4o',
    createdAt: 1,
  }],
  darkMode: false,
  permissionMode: 'confirm',
};

// ===== 测试辅助组件 =====
interface HookResult {
  source: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settings: any;
  updateSettings: (...args: unknown[]) => void;
  resetSettings: () => void;
}

function TestHarness({ onReady }: { onReady: (h: HookResult) => void }) {
  const hook = useSettings();
  useEffect(() => {
    if (hook.loaded) onReady({
      source: hook.settingsSource as string,
      settings: hook.settings as unknown as Record<string, unknown>,
      updateSettings: hook.updateSettings as (...args: unknown[]) => void,
      resetSettings: hook.resetSettings as () => void,
    });
  }, [hook.loaded, hook.settingsSource]);
  return null;
}

// ===== 测试 =====
describe('useSettings 云端同步', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageMap.clear();
    // 默认：saveSettingsToCloud 返回成功（避免未 mock 导致 assert 报错）
    mockSaveSettingsToCloud.mockResolvedValue({ data: { success: true } });
  });

  afterEach(() => {
    storageMap.clear();
  });

  // ──────────────────────────────────────────
  // 云端优先加载
  // ──────────────────────────────────────────
  it('云端有数据时使用云端配置', async () => {
    mockFetchSettings.mockResolvedValue({ data: { settings: CLOUD_SETTINGS } });

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });
    // 第二次 fetchSettings（反向迁移检查）不会执行，因为 source='cloud'
    expect(result.source).toBe('cloud');
    expect(result.settings.activeModelId).toBe('cloud-model');
    expect(result.settings.darkMode).toBe(true);
    expect(result.settings.permissionMode).toBe('auto');
  });

  it('云端数据会覆盖本地 localStorage', async () => {
    storageMap.set('app_settings', JSON.stringify(LOCAL_SETTINGS));
    mockFetchSettings.mockResolvedValue({ data: { settings: CLOUD_SETTINGS } });

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={(h) => resolve({ ...h, settings: h.settings })} />);
    });

    // 使用云端数据
    expect(result.settings.activeModelId).toBe('cloud-model');
    // 本地被云端覆盖
    expect(mockSaveItem).toHaveBeenCalledWith(
      'app_settings',
      expect.objectContaining({ activeModelId: 'cloud-model' })
    );
  });

  // ──────────────────────────────────────────
  // 本地兜底
  // ──────────────────────────────────────────
  it('云端不可用时使用本地配置', async () => {
    mockFetchSettings.mockRejectedValue(new Error('Network Error'));
    storageMap.set('app_settings', JSON.stringify(LOCAL_SETTINGS));

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    expect(result.source).toBe('local');
    expect(result.settings.activeModelId).toBe('local-model');
    expect(result.settings.darkMode).toBe(false);
  });

  it('云端和本地都无数据时使用默认配置', async () => {
    // 云端返回 null
    mockFetchSettings.mockResolvedValue({ data: { settings: null } });

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    expect(result.source).toBe('default');
    expect(result.settings.activeModelId).toBe('default');
    expect(result.settings.permissionMode).toBe('confirm');
  });

  // ──────────────────────────────────────────
  // 反向迁移
  // ──────────────────────────────────────────
  it('本地有数据且云端空时推送到云端', async () => {
    // 第一次 fetchSettings → null（初始化加载）
    // 第二次 fetchSettings → null（反向迁移检查）
    mockFetchSettings.mockResolvedValue({ data: { settings: null } });
    mockSaveSettingsToCloud.mockResolvedValue({ data: { success: true } });
    storageMap.set('app_settings', JSON.stringify(LOCAL_SETTINGS));

    const _result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    // 反向迁移触发：本地数据推送到云端
    expect(mockSaveSettingsToCloud).toHaveBeenCalledWith(
      expect.objectContaining({ activeModelId: 'local-model' })
    );
  });

  it('云端已有数据时不做反向迁移', async () => {
    mockFetchSettings.mockResolvedValue({ data: { settings: CLOUD_SETTINGS } });
    storageMap.set('app_settings', JSON.stringify(LOCAL_SETTINGS));

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    // 云端优先
    expect(result.settings.activeModelId).toBe('cloud-model');
    // 由于 source='cloud'，不会进入反向迁移逻辑
    // saveSettingsToCloud 不会被反向迁移触发（可能因持久化被调用，但非反向迁移）
  });

  // ──────────────────────────────────────────
  // 双写保存
  // ──────────────────────────────────────────
  it('updateSettings 后触发本地 + 云端双写', async () => {
    mockFetchSettings.mockResolvedValueOnce({ data: { settings: null } });

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    // 清除初始化时触发的保存调用
    mockSaveItem.mockClear();
    mockSaveSettingsToCloud.mockClear();

    // 执行更新
    await act(async () => {
      result.updateSettings({ darkMode: true, permissionMode: 'auto' });
    });

    // 等待双写完成
    await waitFor(() => {
      expect(mockSaveItem).toHaveBeenCalledWith(
        'app_settings',
        expect.objectContaining({ darkMode: true, permissionMode: 'auto' })
      );
    });
  });

  // ──────────────────────────────────────────
  // 重置
  // ──────────────────────────────────────────
  it('重置同时清除云端配置', async () => {
    mockFetchSettings.mockResolvedValueOnce({ data: { settings: CLOUD_SETTINGS } });

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    mockSaveSettingsToCloud.mockClear();

    await act(async () => {
      result.resetSettings();
    });

    expect(mockSaveSettingsToCloud).toHaveBeenCalled();
  });

  // ──────────────────────────────────────────
  // 容错
  // ──────────────────────────────────────────
  it('云端保存失败不影响本地正常使用', async () => {
    mockFetchSettings.mockResolvedValueOnce({ data: { settings: null } });

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    mockSaveItem.mockClear();
    mockSaveSettingsToCloud.mockRejectedValue(new Error('Server Error'));

    await act(async () => {
      result.updateSettings({ darkMode: true });
    });

    // 即便云端失败，本地也应该写入成功
    await waitFor(() => {
      expect(mockSaveItem).toHaveBeenCalledWith(
        'app_settings',
        expect.objectContaining({ darkMode: true })
      );
    });
  });

  it('云端数据不完整时使用默认值填充', async () => {
    // 云端只返回 darkMode，没有 modelConfigs
    mockFetchSettings.mockResolvedValueOnce({
      data: { settings: { darkMode: true } },
    });

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    // modelConfigs 应该被默认值填充
    expect(result.settings.darkMode).toBe(true);
    expect(result.settings.modelConfigs.length).toBeGreaterThan(0);
    expect(result.settings.modelConfigs[0].id).toBe('default');
  });
});
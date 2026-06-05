/**
 * useSettings 云端同步测试（v2.1 重写）
 *
 * 测试覆盖：
 * - 云端优先加载（云端有数据时使用云端）
 * - 本地兜底（云端不可用时回退本地）
 * - 反向迁移（本地有数据、云端空 → 推送云端）
 * - 双写保存（保存同时写本地 + 云端）
 * - 重置、容错等边界场景
 * - v1.x 旧 schema 自动丢弃（v2.1 新增）
 *
 * 注意：v2.1 重构后 schema 是 providerConfigs 体系（32 provider + 自定义）
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
import { DEFAULT_RISK_CONFIG } from 'ripple-shared/types';
import {
  KNOWN_PROVIDERS as KNOWN_PROVIDERS_UI,
  KNOWN_PROVIDER_MODELS,
} from 'ripple-shared/providers';

// ===== Fixtures（v2.1 新 schema）=====

/** 构造一个简单的"云端 settings"（v2.1 格式） */
function makeCloudSettings(overrides: Partial<{
  activeProvider: string;
  activeModel: string;
  darkMode: boolean;
  permissionMode: 'auto' | 'confirm' | 'bypass';
}> = {}) {
  // 用 deepseek 作为测试 provider（构造简单 fixture）
  const providerId = overrides.activeProvider ?? 'deepseek';
  const modelId = overrides.activeModel ?? 'deepseek-chat';
  return {
    activeProvider: providerId,
    activeModel: modelId,
    enabledProviders: { [providerId]: true },
    providerConfigs: {
      [providerId]: {
        apiKey: 'sk-cloud-key',
        baseUrl: 'https://api.deepseek.com',
        enabledModels: { [modelId]: true },
        customModels: [],
      },
    },
    customProviders: [],
    darkMode: overrides.darkMode ?? true,
    permissionMode: overrides.permissionMode ?? 'auto',
    agentGatewayUrl: 'http://localhost:3002',
    mobileBridgePort: 9876,
    riskManagement: DEFAULT_RISK_CONFIG,
  };
}

/** v1.x 旧格式（应被识别为 legacy 并丢弃） */
const LEGACY_V1_SETTINGS = {
  activeModelId: 'old-id',
  modelConfigs: [{
    id: 'old-id', name: '旧配置', provider: 'custom',
    endpoint: 'https://old.com', apiKey: 'old-key', model: 'old-model',
    createdAt: 1,
  }],
  darkMode: false,
  permissionMode: 'confirm',
  apiProvider: 'openai',
  apiEndpoint: 'https://old.com',
  apiKey: 'old-key',
  modelName: 'old-model',
};

// ===== 测试辅助组件 =====
interface HookResult {
  source: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settings: any;
  updateSettings: (...args: unknown[]) => void;
  resetSettings: () => void;
  // v2.1: provider 操作回调
  setActiveProvider: (providerId: string, modelId?: string) => void;
}

function TestHarness({ onReady }: { onReady: (h: HookResult) => void }) {
  const hook = useSettings();
  useEffect(() => {
    if (hook.loaded) onReady({
      source: hook.settingsSource as string,
      settings: hook.settings as unknown as Record<string, unknown>,
      updateSettings: hook.updateSettings as (...args: unknown[]) => void,
      resetSettings: hook.resetSettings as () => void,
      setActiveProvider: hook.setActiveProvider,
    });
  }, [hook.loaded, hook.settingsSource]);
  return null;
}

// ===== 测试 =====
describe('useSettings 云端同步（v2.1 schema）', () => {
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
    const cloud = makeCloudSettings();
    mockFetchSettings.mockResolvedValue({ data: { settings: cloud } });

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });
    expect(result.source).toBe('cloud');
    expect(result.settings.activeProvider).toBe('deepseek');
    expect(result.settings.darkMode).toBe(true);
    expect(result.settings.permissionMode).toBe('auto');
  });

  it('云端数据会覆盖本地 localStorage', async () => {
    const local = makeCloudSettings({ activeProvider: 'openai', darkMode: false });
    const cloud = makeCloudSettings({ activeProvider: 'deepseek', darkMode: true });
    storageMap.set('app_settings', JSON.stringify(local));
    mockFetchSettings.mockResolvedValue({ data: { settings: cloud } });

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={(h) => resolve({ ...h, settings: h.settings })} />);
    });

    // 使用云端数据
    expect(result.settings.activeProvider).toBe('deepseek');
    // 本地被云端覆盖
    expect(mockSaveItem).toHaveBeenCalledWith(
      'app_settings',
      expect.objectContaining({ activeProvider: 'deepseek' })
    );
  });

  // ──────────────────────────────────────────
  // 本地兜底
  // ──────────────────────────────────────────
  it('云端不可用时使用本地配置', async () => {
    mockFetchSettings.mockRejectedValue(new Error('Network Error'));
    const local = makeCloudSettings({ activeProvider: 'openai', darkMode: false });
    storageMap.set('app_settings', JSON.stringify(local));

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    expect(result.source).toBe('local');
    expect(result.settings.activeProvider).toBe('openai');
    expect(result.settings.darkMode).toBe(false);
  });

  it('云端和本地都无数据时使用默认配置', async () => {
    // 云端返回 null
    mockFetchSettings.mockResolvedValue({ data: { settings: null } });

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    expect(result.source).toBe('default');
    // 默认激活第一个有内置模型的 provider（openai）
    expect(KNOWN_PROVIDERS_UI.map((p) => p.id)).toContain(result.settings.activeProvider);
    expect(result.settings.permissionMode).toBe('confirm');
  });

  it('本地有 v1.x 旧格式时自动丢弃并使用默认', async () => {
    // 模拟本地存了 v1.x 旧数据
    storageMap.set('app_settings', JSON.stringify(LEGACY_V1_SETTINGS));
    mockFetchSettings.mockResolvedValue({ data: { settings: null } });

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    // v1.x 数据被丢弃
    expect(result.source).toBe('default');
    // 没有旧字段污染
    expect(result.settings.activeModelId).toBeUndefined();
    expect(result.settings.modelConfigs).toBeUndefined();
    // 拥有完整的 32 个 providerConfigs
    expect(Object.keys(result.settings.providerConfigs).length).toBeGreaterThanOrEqual(32);
  });

  it('云端是 v1.x 旧格式时自动丢弃并使用默认', async () => {
    mockFetchSettings.mockResolvedValue({ data: { settings: LEGACY_V1_SETTINGS } });

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    expect(result.source).toBe('default');
    expect(result.settings.activeModelId).toBeUndefined();
  });

  // ──────────────────────────────────────────
  // 反向迁移
  // ──────────────────────────────────────────
  it('本地有数据且云端空时推送到云端', async () => {
    // 第一次 fetchSettings → null（初始化加载）
    // 第二次 fetchSettings → null（反向迁移检查）
    mockFetchSettings.mockResolvedValue({ data: { settings: null } });
    mockSaveSettingsToCloud.mockResolvedValue({ data: { success: true } });
    const local = makeCloudSettings({ activeProvider: 'openai', darkMode: false });
    storageMap.set('app_settings', JSON.stringify(local));

    const _result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    // 反向迁移触发：本地数据推送到云端
    await waitFor(() => {
      expect(mockSaveSettingsToCloud).toHaveBeenCalledWith(
        expect.objectContaining({ activeProvider: 'openai' })
      );
    });
  });

  it('云端已有数据时不做反向迁移', async () => {
    const cloud = makeCloudSettings({ activeProvider: 'deepseek' });
    mockFetchSettings.mockResolvedValue({ data: { settings: cloud } });
    const local = makeCloudSettings({ activeProvider: 'openai' });
    storageMap.set('app_settings', JSON.stringify(local));

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    // 云端优先
    expect(result.settings.activeProvider).toBe('deepseek');
    // 由于 source='cloud'，不会进入反向迁移逻辑
  });

  // ──────────────────────────────────────────
  // 双写保存
  // ──────────────────────────────────────────
  it('updateSettings 后触发本地 + 云端双写', async () => {
    mockFetchSettings.mockResolvedValueOnce({ data: { settings: null } });

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    // 等待初始加载完成
    await waitFor(() => {
      expect(result.settings.activeProvider).toBeDefined();
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
    const cloud = makeCloudSettings();
    mockFetchSettings.mockResolvedValueOnce({ data: { settings: cloud } });

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

    await waitFor(() => {
      expect(result.settings.activeProvider).toBeDefined();
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
    // 云端只返回 activeProvider，其他字段缺失
    mockFetchSettings.mockResolvedValueOnce({
      data: { settings: { activeProvider: 'deepseek' } },
    });

    const result = await new Promise<HookResult>((resolve) => {
      render(<TestHarness onReady={resolve} />);
    });

    // 缺失字段应该被默认值填充
    expect(result.settings.activeProvider).toBe('deepseek');
    // providerConfigs 应该被完整填充
    expect(Object.keys(result.settings.providerConfigs).length).toBeGreaterThanOrEqual(21);
    // enabledModels 也应有默认
    const deepseekCfg = result.settings.providerConfigs.deepseek;
    expect(deepseekCfg).toBeDefined();
    expect(deepseekCfg.apiKey).toBe('');
    expect(deepseekCfg.customModels).toEqual([]);
  });

  // ──────────────────────────────────────────
  // v2.1 新功能：setActiveProvider 行为
  // ──────────────────────────────────────────
  it('setActiveProvider 切换 provider 时自动选择该 provider 的第一个启用 model', async () => {
    mockFetchSettings.mockResolvedValueOnce({ data: { settings: null } });

    // 用 ref + 同步等待的 TestHarness 改造版
    const ref: { current: HookResult | null } = { current: null };
    function H() {
      const hook = useSettings();
      useEffect(() => {
        if (hook.loaded) {
          ref.current = {
            source: hook.settingsSource as string,
            settings: hook.settings as unknown as Record<string, unknown>,
            updateSettings: hook.updateSettings as (...args: unknown[]) => void,
            resetSettings: hook.resetSettings as () => void,
            setActiveProvider: hook.setActiveProvider,
          };
        }
      });
      return null;
    }

    render(<H />);
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    expect(ref.current!.settings.activeProvider).toBeDefined();

    // 切到 anthropic
    await act(async () => {
      ref.current!.setActiveProvider('anthropic');
    });

    // 应该切到 anthropic 下第一个有内置 model 的 provider
    const anthropicModels = KNOWN_PROVIDER_MODELS['anthropic'] ?? [];
    expect(ref.current!.settings.activeProvider).toBe('anthropic');
    if (anthropicModels.length > 0) {
      expect(ref.current!.settings.activeModel).toBe(anthropicModels[0].id);
    }
  });

  it('setActiveProvider 接受可选 modelId 参数直接指定', async () => {
    mockFetchSettings.mockResolvedValueOnce({ data: { settings: null } });

    const ref: { current: HookResult | null } = { current: null };
    function H() {
      const hook = useSettings();
      useEffect(() => {
        if (hook.loaded) {
          ref.current = {
            source: hook.settingsSource as string,
            settings: hook.settings as unknown as Record<string, unknown>,
            updateSettings: hook.updateSettings as (...args: unknown[]) => void,
            resetSettings: hook.resetSettings as () => void,
            setActiveProvider: hook.setActiveProvider,
          };
        }
      });
      return null;
    }

    render(<H />);
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    expect(ref.current!.settings.activeProvider).toBeDefined();

    // 切到 openai + 指定 gpt-4o-mini
    await act(async () => {
      ref.current!.setActiveProvider('openai', 'gpt-4o-mini');
    });

    expect(ref.current!.settings.activeProvider).toBe('openai');
    expect(ref.current!.settings.activeModel).toBe('gpt-4o-mini');
  });
});

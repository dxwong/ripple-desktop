/**
 * OrchestrationResultCard 组件测试
 *
 * 测试覆盖：
 * - 基础渲染（标题、副标题）
 * - JSON 结构化渲染（专家列表、汇总）
 * - 原始文本回退（非 JSON）
 * - 错误渲染
 * - 各状态显示（running/success/error）
 * - 默认折叠/展开交互
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OrchestrationResultCard } from '../components/ChatMessage';
import type { ToolCallResult } from '../types';

function makeTc(overrides: Partial<ToolCallResult> = {}): ToolCallResult {
  return {
    toolName: 'orchestrate',
    toolCallId: 'orch-test-1',
    args: {},
    status: 'success',
    ...overrides,
  };
}

/** 构造一个标准的编排返回 JSON */
function makeOrchestrateJSON(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    success: true,
    allSuccess: true,
    expertCount: 3,
    modelCallCount: 5,
    totalUsage: { cost: 0.03, input: 1000, output: 500, total: 1500, cacheRead: 0, cacheWrite: 0 },
    results: [
      { expertName: 'architect', success: true, durationMs: 3200, output: '架构评估通过' },
      { expertName: 'code-writer', success: true, durationMs: 5100, output: '代码重构完成' },
      { expertName: 'reviewer', success: true, durationMs: 2000, output: '评审通过' },
    ],
    summary: '项目整体架构合理。可直接合并。',
    ...overrides,
  });
}

describe('OrchestrationResultCard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1700000000000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('基础渲染', () => {
    it('显示"总管家编排结果"标题', () => {
      render(<OrchestrationResultCard toolCall={makeTc()} />);
      expect(screen.getByText('总管家编排结果')).toBeInTheDocument();
    });

    it('副标题显示"3 位专家参与"（当 output 可解析且含 results 时）', () => {
      const tc = makeTc({ output: makeOrchestrateJSON() });
      render(<OrchestrationResultCard toolCall={tc} />);
      expect(screen.getByText('3 位专家参与')).toBeInTheDocument();
    });

    it('output 为空时副标题显示默认描述', () => {
      render(<OrchestrationResultCard toolCall={makeTc()} />);
      expect(screen.getByText('总管家调度多个专家完成任务')).toBeInTheDocument();
    });

    it('output 为无效 JSON 时副标题也显示默认描述', () => {
      const tc = makeTc({ output: '这不是 JSON 文本' });
      render(<OrchestrationResultCard toolCall={tc} />);
      expect(screen.getByText('总管家调度多个专家完成任务')).toBeInTheDocument();
    });
  });

  describe('状态展示', () => {
    it('running 状态显示蓝色计时', () => {
      const tc = makeTc({ status: 'approved', startTime: 1700000000000 - 3200 });
      render(<OrchestrationResultCard toolCall={tc} />);
      expect(screen.getByText('3.2s')).toBeInTheDocument();
    });

    it('success 状态显示绿色 ✓ 和总耗时', () => {
      const tc = makeTc({
        status: 'success',
        startTime: 1700000000000 - 5700,
        endTime: 1700000000000,
        output: makeOrchestrateJSON(),
      });
      render(<OrchestrationResultCard toolCall={tc} />);
      expect(screen.getByText('5.7s')).toBeInTheDocument();
    });

    it('error 状态显示 "失败 · 耗时"', () => {
      const tc = makeTc({
        status: 'error',
        startTime: 1700000000000 - 2300,
        endTime: 1700000000000,
        error: 'something went wrong',
      });
      render(<OrchestrationResultCard toolCall={tc} />);
      expect(screen.getByText(/失败 · 2\.3s/)).toBeInTheDocument();
    });
  });

  describe('内容展示：JSON 结构化', () => {
    it('展开后显示各专家结果（JSON 结构化）', () => {
      const tc = makeTc({ output: makeOrchestrateJSON() });
      render(<OrchestrationResultCard toolCall={tc} />);

      // 默认折叠，点击展开
      const header = screen.getByText('总管家编排结果').closest('div');
      fireEvent.click(header!);

      // 显示专家名
      expect(screen.getByText('architect')).toBeInTheDocument();
      expect(screen.getByText('code-writer')).toBeInTheDocument();
      expect(screen.getByText('reviewer')).toBeInTheDocument();
    });

    it('展开后显示总管家汇总', () => {
      const tc = makeTc({ output: makeOrchestrateJSON() });
      render(<OrchestrationResultCard toolCall={tc} />);

      const header = screen.getByText('总管家编排结果').closest('div');
      fireEvent.click(header!);

      expect(screen.getByText(/项目整体架构合理/)).toBeInTheDocument();
    });
  });

  describe('内容展示：原始文本回退', () => {
    it('非 JSON 的 output 以 <pre> 形式显示', () => {
      const tc = makeTc({ output: '这是普通文本输出' });
      render(<OrchestrationResultCard toolCall={tc} />);

      const header = screen.getByText('总管家编排结果').closest('div');
      fireEvent.click(header!);

      expect(screen.getByText('这是普通文本输出')).toBeInTheDocument();
    });
  });

  describe('错误展示', () => {
    it('error 展开时显示错误信息', () => {
      const tc = makeTc({
        status: 'error',
        startTime: 1700000000000 - 1000,
        endTime: 1700000000000,
        error: '编排执行失败：API 超时',
      });
      render(<OrchestrationResultCard toolCall={tc} />);

      const header = screen.getByText('总管家编排结果').closest('div');
      fireEvent.click(header!);

      expect(screen.getByText('编排执行失败：API 超时')).toBeInTheDocument();
    });
  });

  describe('默认折叠/展开行为', () => {
    it('默认折叠（不显示内容）', () => {
      const tc = makeTc({ output: makeOrchestrateJSON() });
      render(<OrchestrationResultCard toolCall={tc} />);

      // 专家名不可见
      expect(screen.queryByText('architect')).not.toBeInTheDocument();
    });

    it('点击展开后显示内容，再点击折叠', () => {
      const tc = makeTc({ output: makeOrchestrateJSON() });
      render(<OrchestrationResultCard toolCall={tc} />);

      const header = screen.getByText('总管家编排结果').closest('div');

      // 点击展开
      fireEvent.click(header!);
      expect(screen.getByText('architect')).toBeInTheDocument();

      // 点击折叠
      fireEvent.click(header!);
      expect(screen.queryByText('architect')).not.toBeInTheDocument();
    });
  });
});

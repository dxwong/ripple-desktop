/**
 * ChatMessage dispatch 逻辑测试
 *
 * 验证 ChatMessage 中 toolCalls.map 的 dispatch 逻辑：
 * - invoke_expert → InvokeExpertCard
 * - orchestrate → OrchestrationResultCard
 * - 其他工具 → ToolCallCard
 *
 * 由于 ChatMessage 组件渲染逻辑嵌套较深，我们通过导出组件来验证 dispatch。
 * 这里测试的是 dispatch 的条件逻辑本身（各工具名对应的组件是否正确渲染）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatMessage from '../components/ChatMessage';
import type { Message } from '../types';

// 创建一个最小化的 Message 用于测试
function makeMessage(
  toolName: string,
  status: 'pending' | 'approved' | 'denied' | 'success' | 'error' = 'success',
  args: Record<string, unknown> = {},
): Message {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    thinking: '',
    timestamp: Date.now(),
    toolCalls: [
      {
        toolName,
        toolCallId: 'tc-1',
        args,
        status,
        startTime: Date.now() - 1000,
        endTime: Date.now(),
        output: 'test output',
      },
    ],
  };
}

describe('ChatMessage dispatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1700000000000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('invoke_expert 工具调用渲染 InvokeExpertCard（显示调用专家文本）', () => {
    const message = makeMessage('invoke_expert', 'success', {
      expertName: 'test-expert',
      task: 'test task',
    });
    render(<ChatMessage message={message} />);
    // InvokeExpertCard 会显示 "调用专家：test-expert"
    expect(screen.getByText(/调用专家：/)).toBeInTheDocument();
    expect(screen.getByText(/test-expert/)).toBeInTheDocument();
  });

  it('orchestrate 工具调用渲染 OrchestrationResultCard（显示总管家编排结果）', () => {
    const message = makeMessage('orchestrate', 'success');
    render(<ChatMessage message={message} />);
    // OrchestrationResultCard 会显示 "总管家编排结果"
    expect(screen.getByText('总管家编排结果')).toBeInTheDocument();
  });

  it('普通工具调用（如 write_file）不渲染专家卡片', () => {
    const message = makeMessage('write_file', 'success', { path: '/test/file.ts' });
    render(<ChatMessage message={message} />);
    // 不应显示专家相关文本
    expect(screen.queryByText(/调用专家：/)).not.toBeInTheDocument();
    expect(screen.queryByText('总管家编排结果')).not.toBeInTheDocument();
    // 默认的 ToolCallCard 渲染 - 检查"已完成"文本
    expect(screen.getByText('已完成')).toBeInTheDocument();
  });

  it('shell 工具调用不渲染专家卡片', () => {
    const message = makeMessage('shell', 'success', { command: 'ls -la' });
    render(<ChatMessage message={message} />);
    expect(screen.queryByText(/调用专家：/)).not.toBeInTheDocument();
    expect(screen.queryByText('总管家编排结果')).not.toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
  });

  it('多条工具调用混合时正确分派', () => {
    const message: Message = {
      id: 'msg-multi',
      role: 'assistant',
      content: '',
      thinking: '',
      timestamp: Date.now(),
      toolCalls: [
        {
          toolName: 'write_file',
          toolCallId: 'tc-write',
          args: { path: '/test/file.ts' },
          status: 'success',
          startTime: Date.now() - 1000,
          endTime: Date.now(),
          output: 'file written',
        },
        {
          toolName: 'invoke_expert',
          toolCallId: 'tc-expert',
          args: { expertName: 'architect', task: '分析架构' },
          status: 'success',
          startTime: Date.now() - 2000,
          endTime: Date.now(),
          output: '专家结果',
        },
      ],
    };
    render(<ChatMessage message={message} />);
    // invoke_expert 显示卡片
    expect(screen.getByText(/architect/)).toBeInTheDocument();
    // write_file 的"已完成"标签也应存在
    expect(screen.getByText('已完成')).toBeInTheDocument();
  });
});
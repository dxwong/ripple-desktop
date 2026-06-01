/**
 * formatDuration 单元测试
 *
 * 测试覆盖：
 * - 边界值（undefined、0）
 * - 毫秒/秒/分钟的不同格式
 * - start 和 end 各种组合
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatDuration } from '../components/ChatMessage';

describe('formatDuration', () => {
  beforeEach(() => {
    // 固定当前时间为 1700000000000 (2023-11-14T22:13:20Z)
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1700000000000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('边界值', () => {
    it('start 为 undefined 时返回空字符串', () => {
      expect(formatDuration(undefined)).toBe('');
      expect(formatDuration(undefined, 1000)).toBe('');
    });

    it('start 为 0 时返回空字符串', () => {
      // start=0 是 falsy，函数会返回 ''（与 undefined 一致）
      expect(formatDuration(0)).toBe('');
    });
  });

  describe('毫秒级耗时 (< 1s)', () => {
    it('500ms 显示为 "500ms"', () => {
      const start = 1700000000000;
      const end = start + 500;
      expect(formatDuration(start, end)).toBe('500ms');
    });

    it('1ms 显示为 "1ms"', () => {
      const start = 1700000000000;
      const end = start + 1;
      expect(formatDuration(start, end)).toBe('1ms');
    });

    it('999ms 显示为 "999ms"', () => {
      const start = 1700000000000;
      const end = start + 999;
      expect(formatDuration(start, end)).toBe('999ms');
    });
  });

  describe('秒级耗时 (1s ~ 60s)', () => {
    it('1s 显示为 "1.0s"', () => {
      const start = 1700000000000;
      const end = start + 1000;
      expect(formatDuration(start, end)).toBe('1.0s');
    });

    it('3.2s 显示为 "3.2s"', () => {
      const start = 1700000000000;
      const end = start + 3200;
      expect(formatDuration(start, end)).toBe('3.2s');
    });

    it('12.345s 显示为 "12.3s"（保留 1 位小数）', () => {
      const start = 1700000000000;
      const end = start + 12345;
      expect(formatDuration(start, end)).toBe('12.3s');
    });

    it('59.9s 显示为 "59.9s"', () => {
      const start = 1700000000000;
      const end = start + 59900;
      expect(formatDuration(start, end)).toBe('59.9s');
    });
  });

  describe('分钟级耗时 (>= 60s)', () => {
    it('60s 显示为 "1m 0s"', () => {
      const start = 1700000000000;
      const end = start + 60000;
      expect(formatDuration(start, end)).toBe('1m 0s');
    });

    it('125s 显示为 "2m 5s"', () => {
      const start = 1700000000000;
      const end = start + 125000;
      expect(formatDuration(start, end)).toBe('2m 5s');
    });

    it('90.5s 显示为 "1m 31s"（秒数四舍五入）', () => {
      const start = 1700000000000;
      const end = start + 90500;
      // 90500ms = 1m 30.5s, toFixed(0) 向上取整为 31s
      expect(formatDuration(start, end)).toBe('1m 31s');
    });
  });

  describe('end 缺省时使用 Date.now()', () => {
    it('start 为 1 秒前，返回约 "1.0s"', () => {
      const start = 1700000000000 - 1000;
      // 当前时间固定为 1700000000000
      const result = formatDuration(start);
      expect(result).toBe('1.0s');
    });

    it('start 为 100ms 前，返回 "100ms"', () => {
      const start = 1700000000000 - 100;
      const result = formatDuration(start);
      expect(result).toBe('100ms');
    });
  });
});

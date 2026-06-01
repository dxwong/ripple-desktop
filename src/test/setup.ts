/**
 * Vitest 测试环境初始化
 *
 * - 引入 @testing-library/jest-dom 扩展 expect 断言
 * - 引入 @testing-library/react 清理钩子
 * - mock 掉 marked 和 lucide-react 无关紧要的依赖
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// 每次测试后清理 DOM
afterEach(() => {
  cleanup();
});

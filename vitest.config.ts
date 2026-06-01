import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // 仅跑 Phase 1 相关测试
    include: ['src/**/*.test.{ts,tsx}'],
    // CSS 报错不影响测试
    css: false,
  },
});

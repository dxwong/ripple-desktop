/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // 现代优雅配色方案
      // 暗色色系与 mobile 端保持一致（slate-900 / slate-800 / slate-700）
      // mobile src/index.css: --bg-color: #0f172a; --bg-secondary: #1e293b
      colors: {
        surface: {
          DEFAULT: "#F7F7F5",       // 主背景
          dark: "#0F172A",          // 深色主背景（与 mobile 端 --bg-color 一致）
          secondary: "#FAFAFA",     // 侧栏背景（接近主背景的浅灰）
          "secondary-dark": "#1E293B", // 深色侧栏背景（与 mobile 端 --sidebar-bg 一致）
          elevated: "#FFFFFF",      // 浮层背景
          "elevated-dark": "#1E293B", // 深色浮层（与 mobile 端 --message-ai 一致）
        },
        accent: {
          DEFAULT: "#D97757",       // 主色调（暖橙）
          hover: "#E0886A",         // 悬停
          muted: "#F5E6E0",         // 浅色底色
          "muted-dark": "#2D1F1A",  // 深色底色
        },
        content: {
          DEFAULT: "#1A1A1A",       // 主文字
          dark: "#F1F5F9",          // 深色主文字（与 mobile 端 --text-color 一致）
          secondary: "#8A8A8A",     // 次要文字
          "secondary-dark": "#94A3B8", // 深色次要文字（与 mobile 端 --text-secondary 一致）
          tertiary: "#B0B0B0",      // 辅助文字
          "tertiary-dark": "#64748B",
        },
        border: {
          DEFAULT: "#E8E8E5",       // 边框
          dark: "#334155",          // 深色边框（与 mobile 端 --border-color 一致）
          light: "#F0F0ED",         // 浅色边框
          "light-dark": "#334155",  // 深色浅边框
        },
        message: {
          user: "#FFFFFF",
          "user-dark": "#3B82F6",   // 暗色用户气泡（与 mobile 端 --message-user 一致）
          ai: "#F0F0EB",
          "ai-dark": "#1E293B",     // 暗色 AI 气泡（与 mobile 端 --message-ai 一致）
          code: "#E8E8E5",
          "code-dark": "#1E293B",   // 暗色代码块
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif'],
        mono: ['"Cascadia Code"', '"JetBrains Mono"', '"Fira Code"', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }], // 11px
      },
      borderRadius: {
        'xl': '0.75rem',
        '2xl': '1rem',
        '3xl': '1.25rem',
        '4xl': '1.5rem',
      },
      boxShadow: {
        'soft': '0 1px 3px 0 rgba(0, 0, 0, 0.04), 0 1px 2px -1px rgba(0, 0, 0, 0.06)',
        'card': '0 1px 4px 0 rgba(0, 0, 0, 0.06), 0 1px 2px -1px rgba(0, 0, 0, 0.04)',
        'elevated': '0 4px 16px 0 rgba(0, 0, 0, 0.08), 0 2px 4px -2px rgba(0, 0, 0, 0.06)',
        'msg': '0 1px 3px 0 rgba(0, 0, 0, 0.04)',
      },
      animation: {
        'pulse-dot': 'pulse-dot 1.4s ease-in-out infinite',
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up-fast': 'slide-up 0.2s ease-out',
      },
      keyframes: {
        'pulse-dot': {
          '0%, 80%, 100%': { transform: 'scale(0.6)', opacity: '0.4' },
          '40%': { transform: 'scale(1)', opacity: '1' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(24px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};

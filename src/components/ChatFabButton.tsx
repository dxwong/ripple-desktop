import { MessageSquare } from "lucide-react";

/**
 * Chat FAB · "返回聊天" 浮动按钮
 *
 * 直接移植自 `plans/desktop/styles.css:1693-1740`（已审核过的方案）。
 *
 * 行为：点击后调用 onBackToChat()，由父组件负责切换 currentView 回到 chat。
 * 视觉：圆形黑底按钮 + MessageCircle 图标 + "继续聊天" 文字。
 * 移动端（<768px）：缩成 44x44 圆形，隐藏文字。
 */

interface ChatFabButtonProps {
  onClick: () => void;
  /** 暗色模式下颜色由 theme token 自适应（无需 prop） */
}

export default function ChatFabButton({ onClick }: ChatFabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="返回聊天"
      aria-label="返回聊天"
      // ─── 移植 demo `.chat-fab` 全部样式（v2.3 修复）───
      // 修复 1：原用 `text-bg` 但 Tailwind 配置中没有 `bg` 色名 → 失效 → 图标看不见
      //         改用 `text-surface`（始终与 content 反色）→ 黑底白字始终对比清晰
      // 修复 2：原未禁用 focus outline → 浏览器默认点击时显示方块边框
      //         加 `focus:outline-none focus-visible:outline-none`
      //         + `focus-visible:ring-2` 给键盘用户保留无障碍提示
      // position: fixed; right: 28px; bottom: 28px; z-index: 50
      // display: inline-flex; align-items: center; gap: 8px
      // height: 48px; padding: 0 18px 0 16px
      // border-radius: 999px
      // background: var(--text)   →  desktop: bg-content (黑)
      // color: var(--bg)          →  desktop: text-surface (白)
      // font-size: 13.5px; font-weight: 500
      // box-shadow: 0 6px 20px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08)
      // transition: 160ms ease
      // hover: translateY(-1px) + shadow 加深 + background 变蓝
      // @media (max-width: 768px): 44x44 圆形，隐藏 label
      className={[
        "fixed right-7 bottom-7 z-50",
        "inline-flex items-center gap-2 h-12 px-4 rounded-full",
        // ✅ 修复 1：黑底 + 白色图标/文字（dark mode 自动反转）
        "bg-content text-surface",
        "text-[13.5px] font-medium tracking-[-0.005em]",
        "shadow-[0_6px_20px_rgba(0,0,0,0.18),0_2px_6px_rgba(0,0,0,0.08)]",
        "hover:bg-blue-500 hover:text-white",
        "hover:shadow-[0_10px_26px_rgba(0,0,0,0.22),0_3px_8px_rgba(0,0,0,0.10)]",
        "hover:-translate-y-px active:translate-y-0",
        "transition-all duration-[160ms]",
        // ✅ 修复 2：消除浏览器默认方块 focus 边框
        "focus:outline-none focus-visible:outline-none",
        // 保留键盘用户的无障碍 focus ring（蓝色 2px 环，不突兀）
        "focus-visible:ring-2 focus-visible:ring-blue-500/30 focus-visible:ring-offset-2",
        // 移动端 <768px
        "max-md:!h-11 max-md:!w-11 max-md:!p-0 max-md:!justify-center",
      ].join(" ")}
    >
      <MessageSquare
        className="w-[18px] h-[18px] shrink-0"
        strokeWidth={1.75}
      />
      <span className="chat-fab-label max-md:hidden">继续聊天</span>
    </button>
  );
}

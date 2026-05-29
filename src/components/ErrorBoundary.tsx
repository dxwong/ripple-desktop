import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[ErrorBoundary] ChatMessage render error:", error.message, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="p-3 my-2 rounded-lg bg-red-900/20 border border-red-800/40 text-red-300 text-sm">
          ⚠️ 消息渲染异常，已自动恢复
        </div>
      );
    }
    return this.props.children;
  }
}
export default ErrorBoundary;

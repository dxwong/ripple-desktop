import React, { Component, ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

/**
 * 全局错误边界
 * 捕获子组件渲染错误，防止白屏
 */
class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("应用渲染错误:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-screen bg-surface dark:bg-surface-dark">
          <div className="text-center max-w-md px-8">
            <div className="w-14 h-14 rounded-2xl bg-red-50 dark:bg-red-900/20 flex items-center justify-center mx-auto mb-4">
              <AlertTriangle size={28} className="text-red-500" />
            </div>
            <h2 className="text-base font-semibold mb-2 text-content dark:text-content-dark">
              渲染出错了
            </h2>
            <p className="text-sm text-content-secondary dark:text-content-secondary-dark mb-4 leading-relaxed">
              {this.state.error?.message || "发生了未知错误"}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: undefined });
                window.location.reload();
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl
                         bg-accent text-white text-sm font-medium
                         hover:bg-accent-hover active:scale-[0.98]
                         transition-all duration-150 shadow-sm"
            >
              <RefreshCw size={15} />
              重新加载
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

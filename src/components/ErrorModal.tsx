import { AlertCircle, X, RefreshCw } from "lucide-react";

interface ErrorModalProps {
  title: string;
  message: string;
  onRetry?: () => void;
  onClose?: () => void;
}

export function ErrorModal({ title, message, onRetry, onClose }: ErrorModalProps) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-50">
      <div className="bg-surface dark:bg-surface-dark rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border dark:border-border-dark">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-red-500" />
            <h3 className="font-semibold text-content dark:text-content-dark">{title}</h3>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark rounded-md transition-colors"
            >
              <X className="w-4 h-4 text-content-tertiary dark:text-content-tertiary-dark" />
            </button>
          )}
        </div>
        
        {/* Body */}
        <div className="p-4">
          <p className="text-content-secondary dark:text-content-secondary-dark leading-relaxed">
            {message}
          </p>
        </div>
        
        {/* Footer */}
        <div className="flex justify-end gap-3 p-4 border-t border-border dark:border-border-dark">
          {onRetry && (
            <button
              onClick={onRetry}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              重试
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="px-4 py-2 text-content-secondary dark:text-content-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark rounded-lg transition-colors"
            >
              关闭
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

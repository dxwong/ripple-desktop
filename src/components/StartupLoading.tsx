import { Loader2 } from "lucide-react";

interface StartupLoadingProps {
  message: string;
  progress?: number;
}

export function StartupLoading({ message, progress }: StartupLoadingProps) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-surface dark:bg-surface-dark z-50">
      <div className="flex flex-col items-center gap-6">
        {/* Logo */}
        <div className="w-16 h-16 rounded-xl bg-primary flex items-center justify-center">
          <span className="text-white text-2xl font-bold">R</span>
        </div>
        
        {/* Loader */}
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 text-primary animate-spin" />
          <span className="text-content-secondary dark:text-content-secondary-dark">
            {message}
          </span>
        </div>
        
        {/* Progress bar */}
        {progress !== undefined && (
          <div className="w-64 h-1.5 bg-surface-secondary dark:bg-surface-secondary-dark rounded-full overflow-hidden">
            <div 
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
        
        {/* Version info */}
        <div className="text-xs text-content-tertiary dark:text-content-tertiary-dark mt-4">
          Ripple Desktop v2.0
        </div>
      </div>
    </div>
  );
}

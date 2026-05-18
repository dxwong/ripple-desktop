import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./styles/globals.css";

// 调试标记 - 确认脚本执行
const APP_VERSION = "2.0-20260514-refs+log";
console.log(`[Ripple] v${APP_VERSION} 应用启动中...`);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

console.log("[Ripple] React 已挂载");

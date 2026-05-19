import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./styles/globals.css";
import { flog } from "./services/frontendLogger";

const APP_VERSION = "2.0-20260514-refs+log";
flog.info('APP', `应用启动 v${APP_VERSION}`, { version: APP_VERSION });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

flog.info('APP', 'React 已挂载');
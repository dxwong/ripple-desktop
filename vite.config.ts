import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST || "0.0.0.0";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,  // 确保是 1420，不是 9020
    strictPort: false,
    host,
    hmr: host ? {
      protocol: "ws",
      host,
      port: 1421,
    } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
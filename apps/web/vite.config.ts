import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(/** 开发代理目标可随 Remote 调试端口调整，浏览器代码仍保持同源。 */
() => {
  const remote = process.env.VITE_REMOTE_DEV_TARGET ?? "http://127.0.0.1:7331";
  const resource = process.env.VITE_RESOURCE_DEV_TARGET ?? "http://127.0.0.1:7342";
  return {
    envDir: "../..",
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/api": { target: remote, changeOrigin: true },
        "/acp": { target: remote, ws: true },
        "/skills": { target: resource, changeOrigin: true },
      },
    },
  };
});

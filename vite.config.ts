import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    optimizeDeps: { include: ["recharts"] },
    server: {
      host: "127.0.0.1",
      port: Number(env.VITE_PORT || 5173),
      strictPort: true,
      proxy: { "/api": `http://127.0.0.1:${env.PORT || 3001}` },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            charts: ["recharts"],
            react: ["react", "react-dom", "react-router-dom"],
          },
        },
      },
    },
  };
});

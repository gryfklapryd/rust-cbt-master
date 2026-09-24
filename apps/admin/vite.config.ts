import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Pakai sumber TypeScript paket workspace langsung (tanpa build terpisah).
  resolve: { conditions: ["source"] },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.API_URL ?? "http://localhost:3000", changeOrigin: true },
      "/docs": { target: process.env.API_URL ?? "http://localhost:3000", changeOrigin: true },
    },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 1500 },
});

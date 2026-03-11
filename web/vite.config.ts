import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": import.meta.dirname + "/src",
    },
  },
  // Pre-bundle monaco-editor so it doesn't re-resolve 200+ ESM modules on dev startup
  optimizeDeps: {
    include: ["monaco-editor"],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "monaco-editor": ["monaco-editor"],
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-wagmi": ["wagmi", "viem", "@rainbow-me/rainbowkit"],
          "vendor-query": ["@tanstack/react-query"],
          "vendor-graph": ["react-force-graph-2d"],
        },
      },
    },
  },
  server: {
    proxy: {
      "/v1": {
        target: "http://localhost:4022",
        changeOrigin: true,
      },
    },
  },
});

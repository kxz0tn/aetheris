import { defineConfig } from "vite";

// Relative base: GitHub Pages (project or user) must resolve assets without an absolute root.
export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 600,
  },
});

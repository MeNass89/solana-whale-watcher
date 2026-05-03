import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  root: "src/frontend",
  plugins: [preact()],
  build: {
    outDir: "../../dist/frontend",
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000"
    }
  },
  test: {
    root: ".",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"]
  }
});

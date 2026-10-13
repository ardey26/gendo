import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  build: { target: "es2022", manifest: true },
  server: {
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    proxy: { "/chain": "http://localhost:8787", "/public": "http://localhost:8787" },
  },
});

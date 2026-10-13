import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), wasm()],
  build: { target: "es2022", manifest: true },
  server: {
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    proxy: Object.fromEntries(["/chain", "/public", "/auth", "/me", "/vaults", "/pending"].map((p) => [p, "http://localhost:8787"])),
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
export default defineConfig(({ command }) => ({
  plugins: [react(), ...(command === "build" ? [cloudflare()] : [])],
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:8787" } },
}));

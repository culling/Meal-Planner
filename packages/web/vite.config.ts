import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the UI runs on :5173 and talks to the API server on :3456.
const api = `http://localhost:${process.env.PORT ?? 3456}`;

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": api, "/images": api } },
  build: { outDir: "dist", sourcemap: false },
});

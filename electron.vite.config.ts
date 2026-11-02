import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const shared = { "@shared": resolve(__dirname, "src/shared") };

export default defineConfig({
  main: {
    resolve: { alias: shared },
  },
  preload: {
    resolve: { alias: shared },
    build: {
      // Los preload con sandbox deben ser CommonJS.
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    resolve: {
      alias: { ...shared, "@": resolve(__dirname, "src/renderer/src") },
    },
    plugins: [react(), tailwindcss()],
  },
});

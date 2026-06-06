import { defineConfig } from "vite";

// Конфиг под Tauri: фиксированный порт, не трогаем src-tauri, лёгкий бандл.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    // встраиваем мелкие ассеты, чтобы итог был самодостаточным
    assetsInlineLimit: 4096,
  },
});

import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 构建产物输出到插件实际加载的 ../renderer 目录。
 * PI-Desktop 面板以 file:// 协议加载 HTML，而 Chromium 对 file:// 下的
 * ES Module（type="module"）与 crossorigin 资源有 CORS 限制，会导致面板空白。
 * 因此：
 *  - 产物打包为 IIFE 单文件（inlineDynamicImports）
 *  - index.html 中的 <script type="module" crossorigin> 改写为普通 <script src>
 *  - <link rel="stylesheet" crossorigin> 去掉 crossorigin
 */
function fileProtocolCompat(): Plugin {
  return {
    name: "file-protocol-compat",
    transformIndexHtml(html) {
      return html
        .replace(
          /<script type="module" crossorigin src="([^"]+)"><\/script>/g,
          '<script src="$1" defer></script>'
        )
        .replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/g, '<link rel="stylesheet" href="$1">');
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), fileProtocolCompat()],
  build: {
    outDir: "../renderer",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "assets/index.js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
  server: {
    port: 5174,
  },
});

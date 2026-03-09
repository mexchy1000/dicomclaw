import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteCommonjs } from "@originjs/vite-plugin-commonjs";

function inlineCssPlugin(): Plugin {
  return {
    name: "inline-css",
    enforce: "post",
    generateBundle(_options, bundle) {
      const cssChunks: string[] = [];
      const cssFileNames: string[] = [];
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (fileName.endsWith(".css") && chunk.type === "asset") {
          cssChunks.push(chunk.source as string);
          cssFileNames.push(fileName);
        }
      }
      if (cssChunks.length === 0) return;

      for (const [_fileName, chunk] of Object.entries(bundle)) {
        if (_fileName.endsWith(".html") && chunk.type === "asset") {
          let html = chunk.source as string;
          html = html.replace(/<link[^>]+rel="stylesheet"[^>]*>/g, "");
          const inlineStyle = `<style>${cssChunks.join("\n")}</style>`;
          html = html.replace("</head>", `${inlineStyle}\n</head>`);
          chunk.source = html;
        }
      }
      for (const name of cssFileNames) {
        delete bundle[name];
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), viteCommonjs(), inlineCssPlugin()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8411",
        changeOrigin: true,
      },
      "/socket.io": {
        target: "http://localhost:8411",
        ws: true,
      },
    },
  },
  assetsInclude: ["**/*.wasm"],
  optimizeDeps: {
    exclude: ["@cornerstonejs/dicom-image-loader"],
    include: ["dicom-parser"],
  },
  worker: {
    format: "es",
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});

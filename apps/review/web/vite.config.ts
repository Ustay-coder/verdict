import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5173, proxy: { "/api": "http://localhost:8790" } },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      // index.html = 운영 화면. prototype.html = 개발용 UI 시안(예시 데이터, 타이머 진행). 운영 화면은 시안 코드를 import하지 않는다.
      // 배포 이미지는 REVIEW_NO_PROTOTYPE=1로 시안을 빼고 만든다.
      input: {
        app: fileURLToPath(new URL("./index.html", import.meta.url)),
        ...(process.env.REVIEW_NO_PROTOTYPE === "1" ? {} : { prototype: fileURLToPath(new URL("./prototype.html", import.meta.url)) }),
      },
    },
  },
});

// 운영 화면 진입점: 실제 서버 API만 쓴다. 개발용 시안(src/dev)은 import하지 않는다.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { httpApi } from "./lib/api";

createRoot(document.getElementById("root")!).render(<StrictMode><App api={httpApi} /></StrictMode>);
